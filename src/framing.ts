/*
  Main-video framing over time, phones only.

  On narrow portrait screens the Main video is focused at 67% (style.css,
  C2) so the Ibex handoff and the gold band sit on screen. The tattoo
  scene and the scenes that follow it are composed further to the right,
  so on a phone they read cramped against the right edge. Here the
  video's object-position eases a little to the left for that stretch of
  footage only - as a pure function of scroll, like everything else -
  and returns to the CSS value before the final scene, whose framing (and
  the Closing Loop's) is untouched. The effect modules and the paint form
  read the video's computed object-position on every draw, so they stay
  in register with whatever this sets.

  Off the portrait query the module never writes anything: desktop keeps
  its CSS framing exactly.
*/

const PORTRAIT = window.matchMedia('(orientation: portrait) and (max-width: 860px)');

// Video seconds. The tattoo scene starts at ~22.0 (a dissolve from the
// bowl at 21.6-22.2); the final scene's composition is in place by ~28.8.
const SHIFT_IN_FROM = 21.6;
const SHIFT_IN_TO = 22.4;
const SHIFT_OUT_FROM = 28.0;
const SHIFT_OUT_TO = 28.8;
// How far the framing moves left, in object-position percentage points,
// relative to the CSS focus (67% -> 56%: about 122px of a 390px screen).
const SHIFT_LEFT = 11;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smooth(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

// 0 outside the stretch, 1 inside, eased across the two dissolves.
function shiftAmount(t: number): number {
  if (t <= SHIFT_IN_FROM || t >= SHIFT_OUT_TO) return 0;
  if (t < SHIFT_IN_TO) return smooth((t - SHIFT_IN_FROM) / (SHIFT_IN_TO - SHIFT_IN_FROM));
  if (t > SHIFT_OUT_FROM) return 1 - smooth((t - SHIFT_OUT_FROM) / (SHIFT_OUT_TO - SHIFT_OUT_FROM));
  return 1;
}

export function initMainFraming(): void {
  const mainVideo = document.querySelector<HTMLVideoElement>('.main-video video[data-sc-scrub]');
  if (!mainVideo) return;

  function getAct() {
    const inst = window.ScrollCraft?.instances?.[0];
    return inst?.acts?.[0] ?? null;
  }

  // Same scroll -> clip-time mapping as the engine and the paint form.
  function videoTime(): number {
    const act = getAct();
    if (!act) return 0;
    const travel = Math.max(act.height - window.innerHeight, 1);
    const p = clamp01((window.scrollY - act.top) / travel);
    return p * (mainVideo!.duration || 32.633);
  }

  // The CSS focus (the 67% of the portrait rule), read with our own inline
  // value out of the way so it is never measured against itself.
  function cssFocusX(): number {
    const own = mainVideo!.style.objectPosition;
    mainVideo!.style.objectPosition = '';
    const m = getComputedStyle(mainVideo!).objectPosition.match(/^(-?[\d.]+)%/);
    mainVideo!.style.objectPosition = own;
    return m ? parseFloat(m[1]) : 50;
  }

  let base = cssFocusX();

  function apply(): void {
    if (!PORTRAIT.matches) {
      if (mainVideo!.style.objectPosition) mainVideo!.style.objectPosition = '';
      return;
    }
    const k = shiftAmount(videoTime());
    const next = k > 0 ? (base - SHIFT_LEFT * k).toFixed(2) + '% 50%' : '';
    if (mainVideo!.style.objectPosition !== next) mainVideo!.style.objectPosition = next;
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
  window.addEventListener('resize', () => { base = cssFocusX(); apply(); }, { passive: true });
  apply();
}
