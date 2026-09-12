/*
  The scroll cue's visibility, as a pure function of scroll.

  --cue on the Opening Loop layer goes from 1 at the very top to 0 once
  the reader has moved CUE_FADE_VH of a viewport - about the first
  hundred pixels, long before the Ibex handoff window opens (0.6 vh
  before the act) - and comes back the same way if they return to the
  top. The CSS eases the change; nothing here is time-based.
*/

const CUE_FADE_VH = 0.12;

export function initScrollCue(): void {
  const opening = document.querySelector<HTMLElement>('.opening-loop');
  if (!opening || !opening.querySelector('.scroll-cue')) return;

  function apply(): void {
    const vh = Math.max(window.innerHeight, 1);
    const k = 1 - Math.min(Math.max(window.scrollY / (CUE_FADE_VH * vh), 0), 1);
    opening!.style.setProperty('--cue', k.toFixed(3));
  }

  let ticking = false;
  function onScroll(): void {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      apply();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', apply, { passive: true });
  apply();
}
