import { initIbexResonance } from './ibex-resonance';
import { initClosingWave } from './closing-wave';
import { initPaintForm } from './paint-form';

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

window.ScrollCraft?.mount();
initIbexResonance();
initClosingWave();
initPaintForm();
