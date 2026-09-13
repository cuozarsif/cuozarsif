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

  let released = false;
  const restore = (reason: string): void => {
    mirror.disconnect();
    setScrubSink(null);
    engine = null;
    fe.dispose();
    fe.surface().remove();
    video.style.opacity = '';
    if (released) video.src = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
    console.warn('[main-video] sequential decoding stopped, seek path restored:', reason);
  };
  fe.onError = restore;

  setScrubSink({ setTarget: (s) => fe.setTarget(s), shownSeconds: () => fe.shownSeconds(), durationSeconds: fe.durationSeconds });
  // Release the element's media resource and decoder: ScrollCraft keeps
  // driving the playhead (normalised, see scrub-seek.ts) and never reloads.
  video.removeAttribute('src');
  video.load();
  URL.revokeObjectURL(blobUrl);
  released = true;
  setScrubSink({ setTarget: (s) => fe.setTarget(s), shownSeconds: () => fe.shownSeconds(), durationSeconds: fe.durationSeconds }, true);
  fe.setTarget(seed);

  // Read-only diagnostics for verification tooling.
  (window as unknown as { __mainScrub?: unknown }).__mainScrub = { get active() { return engine === fe; }, get stats() { return fe.stats; }, get live() { return fe.liveFrames(); }, get frame() { return fe.shownFrame(); }, get canvas() { return fe.surface(); } };
  fe.onRender = (k) => fe.surface().dispatchEvent(new CustomEvent('mainframe', { detail: k }));
}
