/*
  Frame-aware seeking for the Main Video (the page's only scrubbed clip).

  ScrollCraft walks a smoothed playhead toward the scroll target and writes
  video.currentTime whenever the walk has moved past its deadband (20ms on
  phones, 8ms on desktop). The footage is 30fps, 33.3ms per frame, so a
  fifth to two fifths of those writes land inside the frame that is already
  on screen. Each one still flushes the decoder and re-decodes from the
  previous keyframe, and because the engine waits for 'seeked' before its
  next write, the next useful frame is delayed by a whole seek. Measured
  with real finger drags, that is what turns a steady slow scrub into runs
  of 2, 2, 2, 7 display-frame holds.

  This installs an instance-level currentTime on the Main Video only; the
  engine is untouched. A request is quantised to the centre of its frame,
  and the native seek is issued only when that frame index differs from
  the last one issued. The scroll-to-time mapping is unchanged: the frame
  shown for any scroll position is the frame the raw request would have
  landed in, and the requested time never moves by more than half a frame
  (16.7ms) from what the engine asked for.
*/

// main-video-g8.mp4: 30fps, constant frame rate.
const MAIN_FPS = 30;

/*
  A sink takes the engine's writes instead of the element (src/mobile-scrub.ts
  hands them to the WebCodecs frame engine). While a sink is set the getter
  reports the sink's own playhead so ScrollCraft's deadband keeps meaning
  "the target left the frame on screen". Once the element has been unloaded
  (its bytes captured, its decoder released) ScrollCraft's targets arrive
  normalised 0..1 (duration is NaN, it multiplies by 1) and the getter must
  never fall inside the deadband, or the engine would stop writing: it
  returns -1, which no target can be within 20ms of.
*/
export interface ScrubSink {
  setTarget(seconds: number): void;
  shownSeconds(): number;
  durationSeconds: number;
}
let sink: ScrubSink | null = null;
let unloaded = false;

export function setScrubSink(next: ScrubSink | null, elementUnloaded = false): void {
  sink = next;
  unloaded = !!next && elementUnloaded;
}

export function initScrubSeek(): void {
  const video = document.querySelector<HTMLVideoElement>('.main-video video[data-sc-scrub]');
  if (!video) return;
  const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  if (!native || !native.get || !native.set) return;
  const nativeGet = native.get;
  const nativeSet = native.set;

  let lastFrame = -1;
  // A new source (the engine swaps in its blob URL) starts at time 0 whatever
  // frame was issued before it.
  video.addEventListener('emptied', () => { lastFrame = -1; });

  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    enumerable: true,
    get(): number {
      if (sink) return unloaded ? -1 : sink.shownSeconds();
      return nativeGet.call(video) as number;
    },
    set(t: number): void {
      if (sink) {
        if (!(t >= 0)) return;
        const duration = video.duration;
        const seconds = Number.isFinite(duration) && duration > 0 ? t : t * sink.durationSeconds;
        sink.setTarget(seconds);
        return;
      }
      // The only write the engine makes while a seek is in flight is its
      // stuck-seek nudge (currentTime + 0.001 after 700ms). It must reach
      // the element as-is or a stalled decoder would never be re-kicked.
      if (video.seeking || !(t >= 0)) {
        nativeSet.call(video, t);
        return;
      }
      let frame = Math.floor(t * MAIN_FPS + 1e-4);
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        frame = Math.min(frame, Math.round(duration * MAIN_FPS) - 1);
      }
      if (frame < 0) frame = 0;
      if (frame === lastFrame) return;
      lastFrame = frame;
      nativeSet.call(video, (frame + 0.5) / MAIN_FPS);
    },
  });
}
