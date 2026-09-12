/*
  Paint Form — the contact form on the painting scene of the Main Video.

  An HTML layer, fixed in the same viewport stack as the video stages,
  pressed into the band of gold the two brushes paint (Main Video
  ~13s-20s). It is wiped into existence along the stroke as the last brush
  finishes, holds while the camera holds, and then - because it is part of
  the painted surface - goes wherever the paint goes.

  The exit is driven by the footage, not by a curve of our own: the band's
  vertical displacement through the camera's downward tilt was measured
  frame by frame (BAND_RISE below, as fractions of the video frame), and
  the form follows it. It stays exactly attached for the first stretch of
  the move, then, as the tilt commits, it slips to ~70% of the paint's
  motion while dissolving - opacity, a breath of blur, a hair of scale -
  so it is lost with the composition rather than pushed off screen. It is
  gone before the bowl arrives.

  Published to CSS: --f (reveal 0..1), --ty (px), --o, --blur (px), --sc.
  All pure functions of scroll progress, mapped through the Main Video act
  exactly as the engine maps scroll to video time, so they stay in register
  with the footage at any viewport size and are fully reversible. The video
  is never touched.
*/

const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Video seconds. The form's region of the band is fully painted by ~15.0s
// (measured per column from the footage: the right half from ~13.0s, the
// left edge as the left brush passes at ~14.5-15.0s), while the left brush
// is still visibly working the far end until ~19.6s - so the interface
// emerges from gold that is wet and freshly laid, in the same stroke.
const REVEAL_FROM = 16.0;
const REVEAL_TO = 17.6;
const RELEASE_FROM = 19.95; // the tilt has committed: the form begins to let go
const RELEASE_TO = 20.5; // gone, before the bowl (band leaves frame at ~20.8)

// The band's rise through the camera tilt, measured from the footage:
// [video second, displacement as a fraction of the frame height].
const BAND_RISE: Array<[number, number]> = [
  [19.60, 0.000], [19.70, 0.011], [19.80, 0.033], [19.90, 0.055],
  [20.00, 0.100], [20.10, 0.144], [20.20, 0.211], [20.30, 0.266],
  [20.40, 0.322], [20.50, 0.389], [20.60, 0.433], [20.70, 0.500],
  [20.80, 0.560],
];

// The form is laid out in the video's own coordinates: the script publishes
// the video's displayed rect (object-fit:cover) as --vid-*, and style.css
// places the stroke's traced silhouette and the grooves as fractions of it.
const MAIN_INTRINSIC = { w: 1920, h: 1080 };

// The grooves' answer to the pointer. One target from the cursor's
// horizontal position; three eased channels with their own rates, so the
// name answers quickest, the email a beat behind, the message slowest and
// softest - three dips in one wet surface, not one plate. Reach and lean per
// groove live in style.css (--mx1..3). Fine pointers only.
const POINTER_EASE = [0.075, 0.06, 0.045];

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smooth(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

function bandRise(t: number): number {
  if (t <= BAND_RISE[0][0]) return 0;
  for (let i = 1; i < BAND_RISE.length; i++) {
    const [t1, d1] = BAND_RISE[i];
    if (t <= t1) {
      const [t0, d0] = BAND_RISE[i - 1];
      return d0 + (d1 - d0) * ((t - t0) / (t1 - t0));
    }
  }
  return BAND_RISE[BAND_RISE.length - 1][1];
}

function cover(vw: number, vh: number) {
  const scale = Math.max(vw / MAIN_INTRINSIC.w, vh / MAIN_INTRINSIC.h);
  const dispW = MAIN_INTRINSIC.w * scale;
  const dispH = MAIN_INTRINSIC.h * scale;
  return { dispW, dispH, offX: (vw - dispW) / 2, offY: (vh - dispH) / 2 };
}

export function initPaintForm(): void {
  const root = document.querySelector<HTMLElement>('.paint-form');
  const form = root?.querySelector<HTMLFormElement>('.paint-form__surface');
  const mainVideo = document.querySelector<HTMLVideoElement>('.main-video video[data-sc-scrub]');
  if (!root || !form || !mainVideo) return;

  function getAct() {
    const inst = window.ScrollCraft?.instances?.[0];
    return inst?.acts?.[0] ?? null;
  }

  function videoTime(): number {
    const act = getAct();
    if (!act) return 0;
    const travel = Math.max(act.height - window.innerHeight, 1);
    const p = clamp01((window.scrollY - act.top) / travel);
    // The engine reads the clip's real duration at runtime; so do we.
    return p * (mainVideo!.duration || 32.633);
  }

  function apply(): void {
    const t = videoTime();
    const c = cover(window.innerWidth, window.innerHeight);

    let f = clamp01((t - REVEAL_FROM) / (REVEAL_TO - REVEAL_FROM));
    let release = smooth((t - RELEASE_FROM) / (RELEASE_TO - RELEASE_FROM));
    // Attached to the paint: its own measured rise, slipping to 70% of it
    // as the form lets go.
    let ty = -bandRise(t) * c.dispH * (1 - 0.3 * release);
    let o = 1 - release;
    let blur = 3 * release;
    let sc = 1 - 0.02 * release;
    if (REDUCE) {
      // Present or not: no wipe, no ride, no dissolve.
      f = f > 0.5 ? 1 : 0;
      const gone = t >= RELEASE_FROM;
      ty = 0; o = gone ? 0 : 1; blur = 0; sc = 1;
    }

    root!.style.setProperty('--vid-x', c.offX.toFixed(1) + 'px');
    root!.style.setProperty('--vid-y', c.offY.toFixed(1) + 'px');
    root!.style.setProperty('--vid-w', c.dispW.toFixed(1) + 'px');
    root!.style.setProperty('--vid-h', c.dispH.toFixed(1) + 'px');
    root!.style.setProperty('--f', f.toFixed(3));
    root!.style.setProperty('--ty', ty.toFixed(1) + 'px');
    root!.style.setProperty('--o', o.toFixed(3));
    root!.style.setProperty('--blur', blur.toFixed(2) + 'px');
    root!.style.setProperty('--sc', sc.toFixed(4));

    // Usable only while fully present and the camera is still holding.
    const usable = f >= 0.999 && t < BAND_RISE[0][0];
    root!.style.pointerEvents = usable ? 'auto' : 'none';
    root!.setAttribute('aria-hidden', usable ? 'false' : 'true');
    // inert also takes the fields out of the tab order while the form is
    // not present, so keyboard focus can never land in an invisible groove.
    root!.toggleAttribute('inert', !usable);
  }

  // ---- submit ----------------------------------------------------------
  // Validation is ours, not the browser's bubble (novalidate on the form):
  // a field that fails is pressed deeper into the paint and takes focus;
  // it releases as soon as the visitor types. A valid form is posted as
  // JSON to /api/contact (a Vercel function that relays it through Resend,
  // see api/contact.ts); the page never reloads. While it is in flight the
  // button reads "Sending"; on success the fields settle to read-only and
  // it reads "Message sent"; on failure it says so and everything stays
  // editable so the visitor can simply try again.
  const fields = Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[required], textarea[required]'));
  const honeypot = form.querySelector<HTMLInputElement>('input[name="company"]');
  const send = form.querySelector<HTMLButtonElement>('.paint-form__send');
  const sendLabel = send ? send.innerHTML : '';
  let failed = false;
  const status = form.querySelector<HTMLElement>('.paint-form__status');
  const groove = (el: Element): HTMLElement | null => el.closest('.paint-form__field');

  function setInvalid(el: HTMLInputElement | HTMLTextAreaElement, invalid: boolean): void {
    groove(el)?.classList.toggle('is-invalid', invalid);
    if (invalid) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  }

  fields.forEach((el) => {
    el.addEventListener('input', () => { if (el.validity.valid) setInvalid(el, false); });
  });

  function setBusy(busy: boolean): void {
    fields.forEach((el) => { el.readOnly = busy; });
    if (send) { send.disabled = busy; if (busy) send.textContent = 'Sending'; }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const state = form.dataset.state;
    if (state === 'sent' || state === 'sending') return;
    let first: HTMLInputElement | HTMLTextAreaElement | null = null;
    fields.forEach((el) => {
      const valid = el.validity.valid && el.value.trim() !== '';
      setInvalid(el, !valid);
      if (!valid && !first) first = el;
    });
    if (first) {
      (first as HTMLInputElement | HTMLTextAreaElement).focus({ preventScroll: true });
      if (status) status.textContent = 'Please complete the highlighted fields.';
      return;
    }

    const payload: Record<string, string> = {};
    fields.forEach((el) => { payload[el.name] = el.value; });
    if (honeypot) payload.company = honeypot.value;

    form.dataset.state = 'sending';
    setBusy(true);
    if (status) status.textContent = 'Sending your message.';

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        form.dataset.state = 'sent';
        if (send) { send.disabled = true; send.textContent = 'Message sent'; }
        if (status) status.textContent = 'Your message has been sent.';
      })
      .catch(() => {
        delete form.dataset.state;
        setBusy(false);
        failed = true;
        if (send) send.textContent = 'Not sent. Try again';
        if (status) status.textContent = 'Your message could not be sent. Please try again.';
      });
  });

  // The button returns to its own label once the visitor edits after a
  // failed attempt, so the retry reads as a fresh send.
  fields.forEach((el) => {
    el.addEventListener('input', () => {
      if (failed && send) { failed = false; send.innerHTML = sendLabel; }
    });
  });

  // ---- the surface noticing the viewer --------------------------------
  // Each groove drifts a few pixels toward the pointer and settles back when
  // it leaves or nears the centre; the silhouette never moves. One target,
  // three channels eased at their own rates (--mx1 name, --mx2 email and
  // send, --mx3 message), so the grooves answer in a soft stagger instead of
  // moving as one plate. Gated exactly as scroll-craft gates its pointer
  // devices: fine pointers only, never under reduced motion. The loop runs
  // only while any channel still has distance left to ease.
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (finePointer && !REDUCE) {
    let target = 0;
    const current = [0, 0, 0];
    let raf = 0;
    const settle = (): void => {
      raf = 0;
      let moving = false;
      for (let i = 0; i < current.length; i++) {
        current[i] += (target - current[i]) * POINTER_EASE[i];
        if (Math.abs(target - current[i]) < 0.002) current[i] = target;
        root!.style.setProperty('--mx' + (i + 1), current[i].toFixed(3));
        if (current[i] !== target) moving = true;
      }
      if (moving) raf = requestAnimationFrame(settle);
    };
    const nudge = (): void => { if (!raf) raf = requestAnimationFrame(settle); };
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      // -1 at the left edge, +1 at the right, dead-zoned a little around centre.
      const nx = (e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
      target = Math.sign(nx) * Math.max(Math.abs(nx) - 0.08, 0) / 0.92;
      nudge();
    }, { passive: true });
    window.addEventListener('pointerleave', () => { target = 0; nudge(); });
    document.addEventListener('mouseleave', () => { target = 0; nudge(); });
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
