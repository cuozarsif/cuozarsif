/*
  Ibex Resonance — the Opening Loop -> Main Video handoff, as a portal.

  Both video layers are position:fixed in the exact same viewport rect
  (.opening-loop and .main-video [data-sc-stage] in style.css); neither ever
  moves. This module is the COMPOSITOR between them during the handoff: it
  does not fade one layer into the other. Instead, a soft, noise-broken
  aperture opens at the Ibex sculpture and grows until it clears the frame,
  and the Main Video is only ever visible INSIDE that aperture, sampled by a
  WebGL shader that also displaces where it samples from - refraction and
  chromatic splitting along the front - so the image itself bends open
  rather than a new image arriving. Outside the aperture the shader paints
  nothing, so the ordinary Opening Loop shows through untouched. Only once
  the front has fully cleared the viewport does the DOM swap (Main stage
  opacity 1, Opening 0), at which point the shader's output and the raw
  video are pixel-identical, so the swap is invisible.

  Why a portal and not a dissolve: the two shots are framed differently
  (the Ibex sits lower and larger in the Opening Loop than in the Main
  Video's first frame). A whole-frame crossfade exposes that difference
  everywhere at once, which the eye reads as the new picture moving up into
  place - a section transition. Revealing spatially from the Ibex means the
  framing difference only ever appears at the front, where it is absorbed as
  refraction, and the matching imagery does the rest of the work.

  Nothing here is time-based or random: every frame is a pure function of
  scroll progress R (0..1), so scrolling back up closes the portal exactly
  the way it opened. The noise that breaks the front drifts with R, not
  with the clock.

  Anchor: each video's Ibex is resolved independently in its own intrinsic
  pixel space via coverPoint(), replicating the browser's object-fit:cover,
  then blended by portal progress so the aperture stays on the sculpture as
  the framing changes underneath it.
*/

const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Measured by eye against captured frames: both fractions target the ibex's
// chest/shoulder, where the wiping woman's hand meets the bronze.
const OPENING_INTRINSIC = { w: 1280, h: 720 };
const OPENING_ANCHOR_FRAC = { x: 0.7, y: 0.42 };

const MAIN_INTRINSIC = { w: 1920, h: 1080 };
const MAIN_ANCHOR_FRAC = { x: 0.771, y: 0.352 };

// Reach of the handoff on each side of the exact scroll position where the
// Main Video act pins (act.top), in viewport-heights. R runs 0..1 across
// the whole span with R = 0.5 exactly at act.top.
const APPROACH_VH = 0.6;
const RESOLVE_VH = 0.5;

// The portal's timeline in R. Before OPEN_START light only gathers at the
// Ibex (a small lens, nothing revealed). From OPEN_START the front leaves
// the Ibex and reaches the farthest viewport corner by OPEN_END, after
// which the DOM swap happens. Everything is reversible by construction.
const OPEN_START = 0.3;
const OPEN_END = 0.9;
// The front is measured in units of "reach" (distance from the Ibex to the
// farthest corner). It overshoots 1 so the noise and the soft edge are
// fully clear of the frame by OPEN_END.
const FRONT_MAX = 1.22;

// Fallback-only (no WebGL): a plain opacity crossfade window in R.
const CROSSFADE_LO = 0.32;
const CROSSFADE_HI = 0.68;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function coverPoint(
  vw: number,
  vh: number,
  intrinsicW: number,
  intrinsicH: number,
  fracX: number,
  fracY: number,
): { x: number; y: number } {
  const scale = Math.max(vw / intrinsicW, vh / intrinsicH);
  const dispW = intrinsicW * scale;
  const dispH = intrinsicH * scale;
  const offX = (vw - dispW) / 2;
  const offY = (vh - dispH) / 2;
  return { x: offX + fracX * dispW, y: offY + fracY * dispH };
}

const VERT_SRC = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// Screen-space distance from the Ibex, normalised by the farthest corner so
// front = 1 always clears the frame at any viewport size. The front is
// broken by two octaves of value noise (drifting with scroll, never time)
// so it reads as an organic opening, not a drawn circle. Sampling is
// displaced toward the Ibex in a band hugging the front, and split per
// colour channel there: that is where the refraction and the spectral
// fringing come from - the footage itself, resampled, not a painted tint.
const FRAG_SRC = `
precision highp float;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform vec2 uResolution;
uniform vec2 uIntrinsicA;
uniform vec2 uIntrinsicB;
uniform vec2 uAnchorPx;
uniform float uReach;
uniform float uFront;
uniform float uGather;
uniform float uR;
uniform float uBReady;
uniform vec2 uShiftB;

vec2 coverUV(vec2 screenPx, vec2 intrinsic) {
  float scale = max(uResolution.x / intrinsic.x, uResolution.y / intrinsic.y);
  vec2 disp = intrinsic * scale;
  vec2 off = (uResolution - disp) * 0.5;
  return (screenPx - off) / disp;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 dv = px - uAnchorPx;
  float dist = length(dv);
  vec2 dir = dist > 0.5 ? dv / dist : vec2(0.0, 0.0);
  float d = dist / uReach;

  /* The front's raggedness scales with the aperture, so it is organically
     broken at every size rather than a clean circle that only frays once it
     is large. */
  float sc = max(uFront, 0.12);
  float wl = uReach * 0.55 * sc;
  float nBig  = vnoise(px / wl + uR * 1.5) - 0.5;
  float nFine = vnoise(px / (wl * 0.28) - uR * 2.5) - 0.5;
  float n = (nBig * 0.10 + nFine * 0.035) * sc;

  float w = 0.055;
  float edge = uFront - (d + n);
  float k = smoothstep(-w, w, edge);

  float open = min(uFront * 6.0, 1.0);
  float band = exp(-(edge * edge) / (2.0 * w * w * 2.25)) * open;
  float core = exp(-(d * d) / (2.0 * 0.13 * 0.13)) * uGather;
  float refr = max(band, core);

  /* Refraction direction: radial, bent by the gradient of a slow noise
     field so the dispersion flows rather than forming concentric rings. */
  vec2 fp = px / (uReach * 0.18) + uR * 0.9;
  vec2 e = vec2(0.08, 0.0);
  vec2 flow = vec2(
    vnoise(fp + e.xy) - vnoise(fp - e.xy),
    vnoise(fp + e.yx) - vnoise(fp - e.yx)
  );
  vec2 dirF = normalize(dir + flow * 9.0 + vec2(1e-4, 0.0));

  float amp = 0.022 * uReach;
  vec2 pull = -dirF * refr * amp;
  float chroma = 0.22 * amp * refr;
  vec2 offR = pull + dirF * chroma;
  vec2 offG = pull;
  vec2 offB = pull - dirF * chroma;

  /* The Main Video is drawn through the opening translated so its Ibex
     lands on the Opening Loop's Ibex while the aperture is small, easing to
     no translation as it opens: the world re-composes gently through the
     portal instead of a second, offset Ibex appearing inside it. Across the
     front the two pictures bend toward each other - the Opening side takes
     on half the translation as the Main side sheds half - so the seam is a
     continuous refraction, never a step. */
  vec2 shA = uShiftB * (k * 0.5);
  vec2 shB = uShiftB * (1.0 - (1.0 - k) * 0.5);
  vec3 colA = vec3(
    texture2D(uTexA, coverUV(px + offR + shA, uIntrinsicA)).r,
    texture2D(uTexA, coverUV(px + offG + shA, uIntrinsicA)).g,
    texture2D(uTexA, coverUV(px + offB + shA, uIntrinsicA)).b
  );
  vec3 colB = vec3(
    texture2D(uTexB, coverUV(px + offR + shB, uIntrinsicB)).r,
    texture2D(uTexB, coverUV(px + offG + shB, uIntrinsicB)).g,
    texture2D(uTexB, coverUV(px + offB + shB, uIntrinsicB)).b
  );
  float kk = k * uBReady;
  vec3 col = mix(colA, colB, kk);

  /* A faint luminous crest on the front and a little caught light at the
     lens: antique gold, low, never a hue wheel. */
  vec3 gold = vec3(0.86, 0.66, 0.36);
  col += gold * band * 0.06;
  col += gold * core * 0.05;

  float alpha = max(kk, refr);
  gl_FragColor = vec4(col, alpha);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[ibex-resonance] shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function initIbexResonance(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#ibex-resonance');
  const openingLoop = document.querySelector<HTMLElement>('.opening-loop');
  const mainStage = document.querySelector<HTMLElement>('.main-video [data-sc-stage]');
  if (!canvas || !openingLoop || !mainStage) return;

  function getAct() {
    const inst = window.ScrollCraft?.instances?.[0];
    return inst?.acts?.[0] ?? null;
  }

  function currentR(): number {
    const act = getAct();
    if (!act) return 0;
    const vh = window.innerHeight;
    const top = act.top;
    const approachStart = top - APPROACH_VH * vh;
    const resolveEnd = top + RESOLVE_VH * vh;
    const y = window.scrollY;
    if (y <= approachStart) return 0;
    if (y >= resolveEnd) return 1;
    if (y <= top) {
      return 0.5 * ((y - approachStart) / Math.max(top - approachStart, 1));
    }
    return 0.5 + 0.5 * ((y - top) / Math.max(resolveEnd - top, 1));
  }

  // The DOM only ever swaps, never fades: the shader carries the whole
  // reveal, and by OPEN_END its output already equals the raw Main Video.
  function applyReveal(R: number): void {
    const revealed = R >= OPEN_END;
    openingLoop!.style.opacity = revealed ? '0' : '1';
    mainStage!.style.opacity = revealed ? '1' : '0';
  }

  // Fallback-only: plain opacity crossfade when there is no WebGL.
  function applyCrossfade(R: number): void {
    const mix = smoothstep(CROSSFADE_LO, CROSSFADE_HI, R);
    openingLoop!.style.opacity = String(1 - mix);
    mainStage!.style.opacity = String(mix);
  }

  // ---- reduced motion: instant, unanimated layer swap, no WebGL, no
  // distortion at all - "fewer and gentler, not zero": the handoff still
  // happens at the right scroll position, it just doesn't animate. ----
  function applyInstantSwap(): void {
    const act = getAct();
    const revealed = !!act && window.scrollY >= act.top;
    openingLoop!.style.opacity = revealed ? '0' : '1';
    mainStage!.style.opacity = revealed ? '1' : '0';
  }

  if (REDUCE) {
    applyInstantSwap();
    window.addEventListener('scroll', applyInstantSwap, { passive: true });
    window.addEventListener('resize', applyInstantSwap, { passive: true });
    return;
  }

  const openingVideo = document.querySelector<HTMLVideoElement>('.opening-loop__video');
  const mainVideo = document.querySelector<HTMLVideoElement>('.main-video video[data-sc-scrub]');
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });

  if (!gl || !openingVideo || !mainVideo) {
    // No WebGL support, or the videos aren't there: still crossfade the two
    // layers (plainly, via CSS opacity) rather than leaving the page stuck
    // at R=0 with the Main Video permanently hidden.
    applyCrossfade(currentR());
    let t = false;
    const onScroll = () => {
      if (t) return;
      t = true;
      requestAnimationFrame(() => {
        applyCrossfade(currentR());
        t = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return;
  }

  const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const program = vs && fs ? gl.createProgram() : null;
  if (!program || !vs || !fs) return;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[ibex-resonance] program link failed:', gl.getProgramInfoLog(program));
    return;
  }
  gl.useProgram(program);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  // One oversized triangle covering the whole clip space - cheaper than a
  // quad (no diagonal seam, no second triangle) for a single fullscreen pass.
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  function makeTexture(): WebGLTexture {
    const tex = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    return tex;
  }
  const texA = makeTexture();
  const texB = makeTexture();
  let texBHasFrame = false;

  const uTexA = gl.getUniformLocation(program, 'uTexA');
  const uTexB = gl.getUniformLocation(program, 'uTexB');
  const uResolution = gl.getUniformLocation(program, 'uResolution');
  const uIntrinsicA = gl.getUniformLocation(program, 'uIntrinsicA');
  const uIntrinsicB = gl.getUniformLocation(program, 'uIntrinsicB');
  const uAnchorPx = gl.getUniformLocation(program, 'uAnchorPx');
  const uReach = gl.getUniformLocation(program, 'uReach');
  const uFront = gl.getUniformLocation(program, 'uFront');
  const uGather = gl.getUniformLocation(program, 'uGather');
  const uR = gl.getUniformLocation(program, 'uR');
  const uBReady = gl.getUniformLocation(program, 'uBReady');
  const uShiftB = gl.getUniformLocation(program, 'uShiftB');

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function uploadVideoFrame(tex: WebGLTexture, video: HTMLVideoElement): boolean {
    if (video.readyState < 2) return false; // no decoded frame yet; keep the last upload
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    try {
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, video);
      return true;
    } catch {
      // A frame mid-seek can throw on upload; skip it, the next scroll frame
      // retries with whatever the decoder has settled on by then.
      return false;
    }
  }

  function clear(): void {
    gl!.viewport(0, 0, canvas!.width, canvas!.height);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
  }

  function draw(R: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;

    applyReveal(R);

    // Outside the handoff the shader has nothing to add: the DOM layers are
    // the picture. (At R >= OPEN_END the swap has happened and the raw Main
    // Video is showing; drawing it again would only cost uploads.)
    if (R <= 0 || R >= OPEN_END) {
      clear();
      return;
    }

    // Portal progress 0..1 across [OPEN_START, OPEN_END]. The front grows
    // linearly with scroll: since the opening's area grows with the square
    // of its radius, a linear radius already reads as a steady, then
    // quickening, expansion, and it spends the whole window opening rather
    // than popping early and idling until the swap.
    const t = clamp01((R - OPEN_START) / (OPEN_END - OPEN_START));
    const front = FRONT_MAX * t;
    // Light gathers at the Ibex before the portal, then hands over to it.
    const gather = smoothstep(0, OPEN_START, R) * (1 - smoothstep(OPEN_START, OPEN_START + 0.25, R));

    const openAnchor = coverPoint(
      w, h, OPENING_INTRINSIC.w, OPENING_INTRINSIC.h,
      OPENING_ANCHOR_FRAC.x, OPENING_ANCHOR_FRAC.y,
    );
    const mainAnchor = coverPoint(
      w, h, MAIN_INTRINSIC.w, MAIN_INTRINSIC.h,
      MAIN_ANCHOR_FRAC.x, MAIN_ANCHOR_FRAC.y,
    );
    // The aperture follows the sculpture as the framing changes beneath it:
    // on the Opening Loop's Ibex while gathering, on the Main Video's once
    // open. Eased quadratically so most of the re-composition happens while
    // the aperture is still local to the Ibex, and far landmarks (the moon
    // ring, the horizon) are already in place by the time it reaches them.
    const te = 1 - (1 - t) * (1 - t);
    const ax = lerp(openAnchor.x, mainAnchor.x, te);
    const ay = lerp(openAnchor.y, mainAnchor.y, te);
    const reach = Math.max(
      Math.hypot(ax, ay), Math.hypot(w - ax, ay),
      Math.hypot(ax, h - ay), Math.hypot(w - ax, h - ay),
    );

    uploadVideoFrame(texA, openingVideo!);
    if (uploadVideoFrame(texB, mainVideo!)) texBHasFrame = true;

    clear();

    gl!.useProgram(program);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, texA);
    gl!.uniform1i(uTexA, 0);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, texB);
    gl!.uniform1i(uTexB, 1);

    gl!.uniform2f(uResolution, w * dpr, h * dpr);
    gl!.uniform2f(uIntrinsicA, OPENING_INTRINSIC.w, OPENING_INTRINSIC.h);
    gl!.uniform2f(uIntrinsicB, MAIN_INTRINSIC.w, MAIN_INTRINSIC.h);
    gl!.uniform2f(uAnchorPx, ax * dpr, ay * dpr);
    gl!.uniform1f(uReach, reach * dpr);
    gl!.uniform1f(uFront, front);
    gl!.uniform1f(uGather, gather);
    gl!.uniform1f(uR, R);
    gl!.uniform1f(uBReady, texBHasFrame ? 1 : 0);
    // Sampling offset that puts the Main Video's Ibex on the aperture centre
    // while it is small (full framing difference), easing to zero as the
    // portal opens so the fully-open output equals the raw video exactly.
    gl!.uniform2f(
      uShiftB,
      (mainAnchor.x - ax) * dpr,
      (mainAnchor.y - ay) * dpr,
    );

    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  function resize(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas!.width = Math.round(window.innerWidth * dpr);
    canvas!.height = Math.round(window.innerHeight * dpr);
    canvas!.style.width = window.innerWidth + 'px';
    canvas!.style.height = window.innerHeight + 'px';
    draw(currentR());
  }

  let ticking = false;
  function onScroll(): void {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      draw(currentR());
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', resize, { passive: true });

  resize();
}
