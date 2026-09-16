/*
  Hybrid Main Video scrubbing for phones.

  Desktop is untouched: ScrollCraft seeks the <video> (through the frame-
  aware setter in src/scrub-seek.ts) and the DOM video is the picture.

  On a coarse-pointer device that has WebCodecs, the same MP4 bytes the
  engine has already fetched are decoded sequentially by src/frame-engine.ts
  onto a canvas that sits in the stage exactly where the <video> is, with
  the same object-fit/object-position (the CSS rules name both, and the
  inline object-position src/framing.ts writes is mirrored). ScrollCraft's
  writes are diverted to the engine (setScrubSink); the <video> is then
  unloaded so the phone's hardware decoder is not held by a paused element,
  and the shaders that sampled the video sample the canvas instead
  (mainFrameSource).

  Everything is gated: WebCodecs present, the file demuxes as the mobile
  encode (one AVC track, constant frame rate, no B-frames, keyframe first),
  isConfigSupported for that exact configuration, and the seed frame decodes
  within a timeout. Any failure - then or later (decoder error, draw error)
  - falls back to the seek path with the element reloaded from the same
  bytes, so the reader never sees a broken stage.
*/

import { FrameEngine, parseMp4, type Mp4Track } from './frame-engine';
import { setScrubSink } from './scrub-seek';

const COARSE = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// The seed frame has to be on the canvas before the engine takes over.
const FIRST_FRAME_TIMEOUT_MS = 4000;
// The engine exists for the mobile encode; anything else is refused.
const EXPECTED = { width: 1920, height: 1080, fps: 30, frames: 979 };

let engine: FrameEngine | null = null;

/*
  Release easing. ScrollCraft walks its playhead toward the scroll target by
  a fixed fraction per frame, so when the finger stops the glide that is
  left covers most of its lag in the first frames and then creeps: the last
  frame boundary is crossed late and alone, and the stop reads as a tick.
  This sits between that glide and the engine, only for the moment the
  input ends: once the page target has held still for STILL_TICKS while the
  glide is still a frame or more behind it, the remaining distance is eased
  from where the picture is to the page target with velocity falling
  smoothly to zero over 80-180ms (longer for a longer remainder, i.e. a
  faster release), and the picture then holds on the page target while
  ScrollCraft's own glide catches up underneath. While the finger moves the
  input passes straight through, and any new movement of the page target
  (finger, or the browser's own scroll momentum) ends the ease at once: the
  picture keeps its lead over the glide and gives it back as the input
  moves, so it never steps against the scroll and never jumps. Touching the
  screen cancels the ease the same way. At every moment the picture is
  between the glide and the page position, so the scroll stays the
  authority and the two agree as soon as the glide arrives.
*/
const STILL_TICKS = 2;
const EASE_MIN_MS = 80;
const EASE_MAX_MS = 180;
const EASE_MS_PER_S = 500; // +0.5ms per ms of footage left to cover
const CATCH_UP = 0.5;      // lead given back per unit of input movement

class ReleaseEase {
  private lastIn = NaN;
  private lastPage = NaN;
  private still = 0;
  private easing = false;
  private p0 = 0;
  private p1 = 0;
  private t0 = 0;
  private dur = 0;
  private holding = false;
  private lead = 0;
  private out = NaN;
  private readonly fe: FrameEngine;
  private readonly page: () => number | null;

  constructor(fe: FrameEngine, page: () => number | null) { this.fe = fe; this.page = page; }

  touch(): void {
    if (this.easing && !Number.isNaN(this.lastIn)) { this.easing = false; this.lead = this.out - this.lastIn; }
  }

  input(s: number, now: number): void {
    const page = this.page();
    const pageMoved = page !== null && !Number.isNaN(this.lastPage) && Math.abs(page - this.lastPage) > 1e-6;
    this.still = pageMoved ? 0 : this.still + 1;
    if (page !== null) this.lastPage = page;
    const ds = Number.isNaN(this.lastIn) ? 0 : s - this.lastIn;
    this.lastIn = s;

    if (this.easing) {
      if (!pageMoved) {
        const u = Math.min(1, (now - this.t0) / this.dur);
        const v = this.p0 + (this.p1 - this.p0) * (1 - (1 - u) * (1 - u));
        this.emit(v);
        if (u >= 1) { this.easing = false; this.holding = true; }
        return;
      }
      this.easing = false;
      this.lead = this.out - s;
    }
    if (this.holding) {
      if (!pageMoved && page !== null) {
        if (Math.abs(page - s) < 1e-4) this.holding = false; // the glide has arrived
        else { this.emit(page); return; }
      } else { this.holding = false; this.lead = this.out - s; }
    }
    if (this.lead !== 0) {
      const mag = Math.abs(this.lead) - Math.abs(ds) * CATCH_UP;
      this.lead = mag <= 0 ? 0 : Math.sign(this.lead) * mag;
      let v = s + this.lead;
      if (page !== null) v = Math.min(Math.max(v, Math.min(s, page)), Math.max(s, page));
      this.emit(v);
      return;
    }
    // Following. Has the input just ended with the glide still behind?
    if (page !== null && this.still >= STILL_TICKS) {
      const left = page - s;
      if (Math.abs(left) >= 1 / 30) {
        this.easing = true;
        this.p0 = s;
        this.p1 = page;
        this.t0 = now;
        this.dur = Math.min(EASE_MAX_MS, EASE_MIN_MS + Math.abs(left) * EASE_MS_PER_S);
        this.emit(s);
        return;
      }
    }
    this.emit(s);
  }

  private emit(v: number): void { this.out = v; this.fe.setTarget(v); }
}

/* What the WebGL transitions should sample for the Main Video. */
export function mainFrameSource(video: HTMLVideoElement): HTMLVideoElement | HTMLCanvasElement {
  return engine ? engine.surface() : video;
}
export function mainFrameReady(): boolean {
  return !!engine && engine.hasFrame();
}

function validate(track: Mp4Track): string | null {
  if (!track.codec.startsWith('avc1.')) return 'codec ' + track.codec;
  if (track.hasBFrames) return 'B-frames';
  if (track.width !== EXPECTED.width || track.height !== EXPECTED.height) return 'size ' + track.width + 'x' + track.height;
  if (Math.abs(track.fps - EXPECTED.fps) > 0.01) return 'fps ' + track.fps;
  if (track.samples.length !== EXPECTED.frames) return 'frames ' + track.samples.length;
  if (!track.samples[0].key) return 'first sample not a keyframe';
  for (let i = 1; i < track.samples.length; i++) if (Math.abs(track.samples[i].pts - track.samples[i - 1].pts - track.frameDur) > 2) return 'variable frame duration';
  return null;
}

export function initMobileScrub(): void {
  const video = document.querySelector<HTMLVideoElement>('.main-video video[data-sc-scrub]');
  if (!video || !COARSE || REDUCE) return;
  if (!video.getAttribute('data-sc-src-mobile')) return;
  if (typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined' || typeof EncodedVideoChunk === 'undefined') return;

  // The engine attaches its blob URL after listeners, so either the metadata
  // is already in or the event is still to come. Then wait for the reveal
  // (sc-has-clip): the seek path has shown its first frame, and the swap is
  // frame-to-frame.
  let started = false;
  const tryStart = (): void => {
    if (started || !video.currentSrc.startsWith('blob:') || video.readyState < 1 || !video.classList.contains('sc-has-clip')) return;
    started = true;
    void activate(video).catch((e: unknown) => {
      console.warn('[main-video] sequential decoding not used:', (e as Error)?.message ?? e);
    });
  };
  tryStart();
  video.addEventListener('loadedmetadata', tryStart);
  const mo = new MutationObserver(() => { tryStart(); if (started) mo.disconnect(); });
  mo.observe(video, { attributes: true, attributeFilter: ['class'] });
}

async function activate(video: HTMLVideoElement): Promise<void> {
  const stage = video.parentElement;
  if (!stage) throw new Error('no stage');
  const blobUrl = video.currentSrc;
  // The engine fetched these bytes; reading them back from the blob URL is
  // an in-memory copy, freed again below when the element is unloaded.
  const buf = await (await fetch(blobUrl)).arrayBuffer();
  const track = parseMp4(buf);
  const why = validate(track);
  if (why) throw new Error('unsupported file: ' + why);

  const surface = document.createElement('canvas');
  surface.className = 'main-video__frames';
  surface.setAttribute('aria-hidden', 'true');
  const fe = new FrameEngine(buf, surface, track);
  if (!(await FrameEngine.supported(fe.config))) throw new Error('VideoDecoder config unsupported');

  // Seed on the frame the element is showing now, so the swap is invisible.
  const seed = Number.isFinite(video.currentTime) && video.currentTime >= 0 ? video.currentTime : 0;
  surface.style.objectPosition = video.style.objectPosition;
  surface.style.visibility = 'hidden'; // nothing drawn yet: not a black card over the video
  stage.appendChild(surface);
  let timer = 0;
  try {
    await Promise.race([
      fe.start(seed),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('first frame timed out')), FIRST_FRAME_TIMEOUT_MS); }),
    ]);
  } catch (e) {
    fe.dispose();
    surface.remove();
    throw e;
  } finally {
    window.clearTimeout(timer);
  }

  // ---- take over ----
  engine = fe;
  surface.style.visibility = '';
  video.style.opacity = '0';
  // src/framing.ts drives the video's inline object-position; the canvas
  // follows it in the same frame (mutation records are delivered before paint).
  const mirror = new MutationObserver(() => { const c = fe.surface(); if (c.style.objectPosition !== video.style.objectPosition) c.style.objectPosition = video.style.objectPosition; });
  mirror.observe(video, { attributes: true, attributeFilter: ['style'] });

  // The page position itself, in seconds of footage, straight from the
  // engine's scroll read (clamped like its own playhead).
  const pageSeconds = (): number | null => {
    const clip = window.ScrollCraft?.instances?.[0]?.clips?.[0];
    return clip && typeof clip.target === 'number' ? Math.min(Math.max(clip.target, 0), 0.999) * fe.durationSeconds : null;
  };
  const ease = new ReleaseEase(fe, pageSeconds);
  const onTouch = (): void => ease.touch();
  document.addEventListener('touchstart', onTouch, { passive: true });

  let released = false;
  const restore = (reason: string): void => {
    mirror.disconnect();
    document.removeEventListener('touchstart', onTouch);
    setScrubSink(null);
    engine = null;
    fe.dispose();
    fe.surface().remove();
    video.style.opacity = '';
    if (released) video.src = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
    console.warn('[main-video] sequential decoding stopped, seek path restored:', reason);
  };
  fe.onError = restore;

  const sink = { setTarget: (s: number) => ease.input(s, performance.now()), shownSeconds: () => fe.shownSeconds(), durationSeconds: fe.durationSeconds };
  setScrubSink(sink);
  // Release the element's media resource and decoder: ScrollCraft keeps
  // driving the playhead (normalised, see scrub-seek.ts) and never reloads.
  video.removeAttribute('src');
  video.load();
  URL.revokeObjectURL(blobUrl);
  released = true;
  setScrubSink(sink, true);
  fe.setTarget(seed);

  // Read-only diagnostics for verification tooling.
  (window as unknown as { __mainScrub?: unknown }).__mainScrub = { get active() { return engine === fe; }, get stats() { return fe.stats; }, get live() { return fe.liveFrames(); }, get frame() { return fe.shownFrame(); }, get canvas() { return fe.surface(); } };
  fe.onRender = (k) => fe.surface().dispatchEvent(new CustomEvent('mainframe', { detail: k }));
}
