/*
  Ambient type for the vendored scroll-craft engine (public/engine/scrollcraft.js),
  loaded as a classic script and attached to `window.ScrollCraft`. The engine
  itself is plain JS and is never edited per-project, so its shape is declared
  here rather than adding types inside the vendored file.
*/
export {};

interface ScrollCraftAct {
  top: number;
  height: number;
  // viewport-heights of scroll the act owns (data-sc-span). The engine sizes
  // a pinned act to span * 100vh at layout, so height / span is the viewport
  // height the act was laid out for - stable on phones while the URL bar
  // changes window.innerHeight.
  span: number;
}

// A scrub clip's playhead: `target` is the scroll position mapped into the
// clip (0..1), written on every scroll read; `cur` is the smoothed value the
// engine walks toward it.
interface ScrollCraftClip {
  target: number;
  cur: number;
  lerp: number;
}

interface ScrollCraftInstance {
  acts: ScrollCraftAct[];
  clips: ScrollCraftClip[];
}

declare global {
  interface Window {
    ScrollCraft?: {
      mount: (
        root?: string | Document | Element,
        opts?: Record<string, unknown>,
      ) => unknown;
      reduce: boolean;
      instances: ScrollCraftInstance[];
    };
  }
}
