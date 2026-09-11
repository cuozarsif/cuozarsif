/*
  Ambient type for the vendored scroll-craft engine (src/engine/scrollcraft.js),
  loaded as a classic script and attached to `window.ScrollCraft`. The engine
  itself is plain JS and is never edited per-project, so its shape is declared
  here rather than adding types inside the vendored file.
*/
export {};

interface ScrollCraftAct {
  top: number;
  height: number;
}

interface ScrollCraftInstance {
  acts: ScrollCraftAct[];
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
