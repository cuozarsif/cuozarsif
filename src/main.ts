import { inject as injectAnalytics } from '@vercel/analytics';
import { initIbexResonance } from './ibex-resonance';
import { initClosingWave } from './closing-wave';
import { initPaintForm } from './paint-form';
import { initMainFraming } from './framing';
import { initScrollCue } from './scroll-cue';
import { initScrubSeek } from './scrub-seek';

/*
  Pass 2 scope: the Opening Loop -> Main Video handoff and scroll scrubbing.

  Opening Loop behavior (unchanged from Pass 1):
  - Respect prefers-reduced-motion by freezing the loop on its first frame.
  - Guard the autoplay call so a blocked-autoplay policy never throws an
    unhandled rejection in the console.

  Main Video (new): mounted via the vendored scroll-craft engine
  (src/engine/scrollcraft.js, loaded as a classic script in index.html before
  this module runs). The engine reads the data-sc-* attributes already
  present on the real markup in index.html; nothing here builds DOM for it.
  See the comment above the <section class="main-video"> in index.html for
  why data-sc-clip-map="travel" and no data-sc-dwell were chosen.

  No custom "handoff" logic was written. The Opening Loop is 100dvh of normal
  document flow; the Main Video's pinned stage sits immediately after it and
  sticks at the same point it would naturally become visible. Scrolling from
  the top simply reveals one section and then the other, so the "no fade, no
  crossfade, no black flash" requirement falls out of ordinary scroll
  behavior rather than a bespoke transition.
*/

/*
  A refresh restarts the experience. Browsers restore the previous scroll
  position on reload, which would drop the reader into the middle of the
  scrubbed sequence with the Opening Loop already gone. For a reload only
  (back/forward keeps the browser's normal restoration), scroll restoration
  is switched to manual and the page is put back at 0 before scroll-craft
  mounts, so every scroll-driven system reads its initial state. 'instant'
  because scrollcraft.css sets scroll-behavior:smooth.

  Setting the mode alone is not enough in Chrome: the page is only a few
  viewports tall until the engine lays the act out, and Chrome was observed
  applying the saved position the moment the document grew to hold it,
  even with the mode already manual, right up to the load event. So 0 is
  held until load has passed: any scroll before then is put back, then the
  guard is removed and the reader owns the scroll.
*/
const navigation = performance.getEntriesByType('navigation')[0] as
  | PerformanceNavigationTiming
  | undefined;
if (navigation?.type === 'reload' && 'scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
  const toTop = (): void => window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  const hold = (): void => { if (window.scrollY !== 0) toTop(); };
  toTop();
  window.addEventListener('scroll', hold, { passive: true });
  window.addEventListener('load', () => {
    toTop();
    requestAnimationFrame(() => {
      toTop();
      window.removeEventListener('scroll', hold);
    });
  }, { once: true });
}

const openingVideo = document.querySelector<HTMLVideoElement>(
  '.opening-loop__video',
);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function applyMotionPreference(matches: boolean): void {
  if (!openingVideo) return;

  if (matches) {
    openingVideo.autoplay = false;
    openingVideo.pause();
    openingVideo.currentTime = 0;
  } else {
    openingVideo.autoplay = true;
    void openingVideo.play().catch(() => {
      // Autoplay was blocked by the browser; the frame simply holds still
      // until a user gesture allows playback. Not a functional error.
    });
  }
}

applyMotionPreference(reducedMotion.matches);
reducedMotion.addEventListener('change', (event) => {
  applyMotionPreference(event.matches);
});

// Installed on the Main Video before the engine takes it: the engine's
// currentTime writes go through the frame-aware setter from the first seek.
initScrubSeek();
window.ScrollCraft?.mount();
// Before the effect modules: they read the video's object-position on each
// draw, and this is what sets it on phones.
initMainFraming();
initIbexResonance();
initClosingWave();
initPaintForm();
initScrollCue();

// Vercel Web Analytics (page views only, no cookies). inject() adds the
// /_vercel/insights script that Vercel serves for this project; in a dev
// session it logs instead of reporting, so local work never counts.
injectAnalytics({ mode: import.meta.env.DEV ? 'development' : 'production' });
