/*
  Cover-fit geometry shared by the effect modules and the paint form.

  Every fixed video layer is object-fit: cover, and until now everything that
  had to stay in register with a video (the Ibex origin, the shaders' sampling,
  the form's frame) assumed the browser's default object-position of 50% 50%.
  Narrow portrait screens now set a focus point in CSS so the ibex and the
  gold band stay on screen; the maths here read that computed object-position
  from the element itself, so CSS remains the single source of truth and a
  layer at the default keeps exactly the centred numbers it always had.

  Only percentage positions are honoured (the project uses nothing else);
  anything else falls back to the centre.
*/

export interface Focus {
  fx: number;
  fy: number;
}

export const CENTER: Focus = { fx: 0.5, fy: 0.5 };

export function readFocus(el: Element | null): Focus {
  if (!el) return CENTER;
  const raw = getComputedStyle(el).objectPosition;
  const m = raw.match(/^(-?[\d.]+)%\s+(-?[\d.]+)%$/);
  if (!m) return CENTER;
  return { fx: parseFloat(m[1]) / 100, fy: parseFloat(m[2]) / 100 };
}

export function coverRect(
  vw: number,
  vh: number,
  intrinsicW: number,
  intrinsicH: number,
  focus: Focus,
): { dispW: number; dispH: number; offX: number; offY: number } {
  const scale = Math.max(vw / intrinsicW, vh / intrinsicH);
  const dispW = intrinsicW * scale;
  const dispH = intrinsicH * scale;
  return {
    dispW,
    dispH,
    offX: (vw - dispW) * focus.fx,
    offY: (vh - dispH) * focus.fy,
  };
}
