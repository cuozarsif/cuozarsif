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
// OPEN_START sits just after the first clear filaments (R ~0.15), so the
// source can begin exhausting into a Main-Video-revealing opening while the
// outer beams are still building.
const OPEN_START = 0.18;
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
// so it reads as an organic opening, not a drawn circle. Everything the
// light does to the picture is done by moving WHERE the footage is
// sampled: a lens pull at the front, a push along fine filaments, a
// sideways slide in torn horizontal bands, and a six-tap spectral spread
// whose weights sum to white. Nothing is a painted tint; where no
// displacement occurs the taps coincide and the image is untouched.
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
uniform float uSeed;
uniform float uFil;
uniform float uFilLen;
uniform float uShear;
uniform float uRays;

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

/* Wavelength -> colour, t = 0 violet .. 1 red. Used only as per-tap weights
   for sampling the footage at dispersed positions; the sum of the weights is
   normalised back to white, so where the taps coincide the image is
   untouched, and where they spread the spectrum is the picture itself. */
vec3 spectral(float t) {
  return vec3(
    smoothstep(0.5, 0.82, t) + 0.30 * (1.0 - smoothstep(0.0, 0.22, t)),
    smoothstep(0.16, 0.42, t) * (1.0 - smoothstep(0.62, 0.94, t)),
    1.0 - smoothstep(0.34, 0.60, t)
  );
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 dv = px - uAnchorPx;
  float dist = length(dv);
  vec2 dir = dist > 0.5 ? dv / dist : vec2(0.0, 0.0);
  float d = dist / uReach;
  /* Anisotropic distance for the early phenomenon: the seed lies along the
     surface, wider than it is tall. */
  vec2 q = dv / uReach; q.x *= 0.5;
  float dq = length(q);

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

  /* --- the hollow: the source exhausts itself --------------------------
     Once the beams have left the Ibex, a second noise-broken radius grows
     behind the front (always inside it). Inside it the source terms are
     gone and the filaments start from its edge instead of the centre: the
     light has moved outward, so the centre empties into a clear optical
     opening, and the Main Video shows through it while the outer beams
     and refraction are still at full strength. Same noise as the front, so
     it is the same organic language, never a drawn circle. */
  float rh = max(uFront - 0.06, 0.0) * 0.72;
  /* Soft-edged and only weakly clearing while small, so the source dims
     into clarity instead of a dark hole being punched into bright light. */
  float wh = mix(0.13, 0.06, smoothstep(0.0, 0.3, rh));
  float hm = smoothstep(-wh, wh, rh - (d + n * 0.8)) * smoothstep(0.0, 0.16, rh);
  float src = 1.0 - hm;
  core *= src;
  refr = max(band, core);

  /* --- the seed: a small spectral disturbance embedded in the bronze ----
     Present from the first scroll movement. It is not a tint: it is a
     region where the dispersion below is strong relative to its size, so
     the surface itself smears into a spectrum, plus a little light. */
  float rs = mix(0.022, 0.10, smoothstep(0.02, 0.45, uR));
  float seed = exp(-(dq * dq) / (2.0 * rs * rs)) * uSeed * src;
  float halo = exp(-(dq * dq) / (2.0 * rs * rs * 5.0)) * uSeed * src;

  /* --- filaments: fine rays of light leaving the Ibex ------------------
     Angular noise sampled on the unit circle (so it is continuous all the
     way round), sharpened into thin beams with soft cores, fading along
     their length. They carry light AND displace the picture along their
     direction, so they read as refraction rather than as drawn lines. */
  vec2 ang = vec2(dir.x, dir.y);
  float aFine = vnoise(ang * 11.0 + vec2(uR * 0.6, 7.3));
  float aHair = vnoise(ang * 31.0 - vec2(uR * 0.9, 2.1));
  float rayN = max(aFine * 0.70 + aHair * 0.40 - 0.40, 0.0);
  float rays = pow(rayN * 2.4, 2.6);
  /* Beams are emitted from the hollow's edge (the centre itself while the
     hollow is still closed) and fade outward from there. */
  float dh = d + n * 0.8 - rh;
  float along = smoothstep(-0.02, 0.03, dh) * exp(-max(dh, 0.0) / max(uFilLen, 0.001));
  float sparkle = 0.55 + 0.45 * vnoise(px / (uReach * 0.018) + uR * 3.0);
  float fil = clamp(rays * along * sparkle, 0.0, 1.0) * uFil;

  /* --- god-rays: the same idea, broad and dim, for the strong stage ---- */
  float aWide = vnoise(ang * 3.2 + vec2(uR * 0.35, 11.0));
  float gr = smoothstep(0.45, 0.95, aWide) * exp(-d / 0.9) * smoothstep(0.0, 0.05, d) * uRays
             * (1.0 - hm * 0.85);

  /* --- fragments: refracted wavelets carried outward -------------------
     Two scales of cells on a polar lattice around the origin, each holding
     at most one soft, noise-broken oval whose long axis points along the
     beam, with its own size, offset, presence and slide. The lattice
     travels outward with scroll, so the pieces propagate with the light
     and retreat with it. Inside a piece the picture is displaced sideways-
     and-outward: the pieces ARE the image, refracted - never a shape drawn
     over it. */
  float theta = atan(dv.y, dv.x);
  float rrad = d - uR * 0.45;
  float fragAmt = 0.0;
  for (int sI = 0; sI < 3; sI++) {
    float na = sI == 0 ? 8.0 : (sI == 1 ? 14.0 : 28.0);   // cells around
    float cr = sI == 0 ? 0.20 : (sI == 1 ? 0.10 : 0.05);  // radial cell size, in reach
    float ca = mod(floor((theta / 6.2831853 + 0.5) * na), na);
    float cR = floor(rrad / cr);
    vec2 id = vec2(ca, cR) + float(sI) * 37.0;
    float h1 = hash(id + 0.13), h2 = hash(id + 0.29), h3 = hash(id + 0.47),
          h4 = hash(id + 0.61), h5 = hash(id + 0.83);
    float aC = (ca + 0.5 + (h2 - 0.5) * 0.7) / na * 6.2831853 - 3.14159265;
    float rC = (cR + 0.5 + (h3 - 0.5) * 0.6) * cr;
    float dth = theta - aC;
    dth -= 6.2831853 * floor(dth / 6.2831853 + 0.5);
    float du = rrad - rC;
    float dvv = max(rC + uR * 0.45, 0.02) * dth;
    float ru = cr * mix(0.45, 1.15, h4);   // half-length along the beam
    float rv = cr * mix(0.14, 0.42, h5);   // half-width across it
    float e = (du * du) / (ru * ru) + (dvv * dvv) / (rv * rv);
    e += (vnoise(px / (uReach * 0.02) + id) - 0.5) * 0.7;
    float m = smoothstep(1.0, 0.45, e) * step(0.30, h1);
    fragAmt += m * (h2 - 0.5) * 2.0;
  }
  /* A whisper of horizontal striation inside each piece, so the refracted
     texture keeps the character of the earlier bands. */
  float bandTex = 0.7 + 0.6 * (vnoise(vec2(floor(px.y / (uReach * 0.011)) * 3.1, uR * 5.0 + 9.0)) - 0.5);
  float rf = mix(0.10, 1.3, uShear);
  float field = exp(-(dq * dq) / (2.0 * rf * rf));
  vec2 shearDir = normalize(mix(dir, vec2(sign(dir.x + 1e-3), 0.0), 0.45) + vec2(1e-4, 0.0));
  vec2 shearV = shearDir * clamp(fragAmt, -1.2, 1.2) * bandTex * field * uShear * uReach * 0.062
                * (1.0 - hm * 0.85);
  float shearMag = length(shearV);

  /* --- displacement ----------------------------------------------------
     Lens pull toward the Ibex at the front and the gathering core, push
     outward along the filaments, sideways slide in the shear bands. */
  float amp = 0.022 * uReach;
  vec2 pull = -dirF * refr * amp;
  vec2 filDisp = dir * fil * 0.9 * amp;
  vec2 base = px + pull + filDisp + shearV;

  /* Dispersion strength: where light passes, the picture spreads into a
     spectrum along a flowing, mostly-horizontal axis. */
  float disp = 0.22 * refr + seed * 0.6 + fil * 0.5 + shearMag / (uReach * 0.02) * 0.12;
  float chroma = amp * disp;
  vec2 dirD = normalize(dirF * 0.6 + vec2(1.0, 0.15));

  /* The Main Video is drawn through the opening translated so its Ibex
     lands on the Opening Loop's Ibex while the aperture is small, easing to
     no translation as it opens: the world re-composes gently through the
     portal instead of a second, offset Ibex appearing inside it. Across the
     front the two pictures bend toward each other - the Opening side takes
     on half the translation as the Main side sheds half - so the seam is a
     continuous refraction, never a step. */
  vec2 shA = uShiftB * (k * 0.5);
  vec2 shB = uShiftB * (1.0 - (1.0 - k) * 0.5);

  /* Ten spectral taps along the dispersion axis, weights normalised to
     white: no spread = the exact image, spread = the image as a continuous
     rainbow rather than a handful of coloured copies. */
  vec3 accA = vec3(0.0), accB = vec3(0.0), wsum = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float t = (float(i) + 0.5) / 10.0;
    vec3 wgt = spectral(t);
    vec2 tap = base + dirD * ((t - 0.5) * 2.0 * chroma);
    accA += wgt * texture2D(uTexA, coverUV(tap + shA, uIntrinsicA)).rgb;
    accB += wgt * texture2D(uTexB, coverUV(tap + shB, uIntrinsicB)).rgb;
    wsum += wgt;
  }
  vec3 colA = accA / wsum;
  vec3 colB = accB / wsum;
  float kk = k * uBReady;
  vec3 col = mix(colA, colB, kk);

  /* Light. The filaments and seed carry a warm white that leans faintly
     iridescent with the flow field; the front keeps its antique-gold crest.
     All additive, all low: the spectrum comes from the taps above, not here. */
  vec3 gold = vec3(0.86, 0.66, 0.36);
  vec3 warm = vec3(1.0, 0.93, 0.78);
  vec3 iri = mix(warm, vec3(0.75, 0.92, 1.0), clamp(flow.x * 4.0 + 0.5, 0.0, 1.0));
  col += gold * band * 0.06;
  col += gold * core * 0.05;
  col += iri * (fil * 0.38 + seed * 0.20 + halo * 0.07);
  col += warm * gr * 0.10;

  /* Paint only where something changed; everywhere else the DOM shows. */
  float touched = clamp(seed * 1.4 + fil * 3.0 + halo * 0.6 + gr * 2.0
                        + shearMag / 1.5, 0.0, 1.0);
  float alpha = max(max(kk, refr), touched);
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
  const uSeed = gl.getUniformLocation(program, 'uSeed');
  const uFil = gl.getUniformLocation(program, 'uFil');
  const uFilLen = gl.getUniformLocation(program, 'uFilLen');
  const uShear = gl.getUniformLocation(program, 'uShear');
  const uRays = gl.getUniformLocation(program, 'uRays');

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
    // The phenomenon's stages, each a pure curve of R. The dead zone is
    // gone: the seed answers the first scroll movement (R 0.02). Every
    // stage returns to exactly zero before OPEN_END so the last shader frame
    // still equals the raw Main Video and the swap stays invisible.
    //   seed   - small spectral disturbance in the bronze, from the start
    //   gather - the lens core at the Ibex, now earlier and shorter
    //   fil    - fine luminous filaments, lengthening with scroll
    //   shear  - the picture torn into sideways bands, peaking mid-open
    //   rays   - broad dim god-rays for the strong stage only
    const seed = smoothstep(0.015, 0.10, R) * (1 - smoothstep(0.55, 0.85, R));
    const gather = smoothstep(0.04, 0.25, R) * (1 - smoothstep(0.30, 0.55, R));
    // Filaments appear as hairs first; their brightness and length grow
    // separately from their presence, so the early stage stays tiny.
    const fil = smoothstep(0.05, 0.30, R) * (1 - smoothstep(0.60, 0.86, R))
      * lerp(0.25, 1.0, smoothstep(0.12, 0.45, R));
    const filLen = lerp(0.03, 0.42, smoothstep(0.05, 0.55, R));
    const shear = smoothstep(0.16, 0.45, R) * (1 - smoothstep(0.62, 0.86, R))
      * lerp(0.25, 1.0, smoothstep(0.3, 0.55, R));
    const rays = smoothstep(0.32, 0.58, R) * (1 - smoothstep(0.66, 0.86, R));

    const openAnchor = coverPoint(
      w, h, OPENING_INTRINSIC.w, OPENING_INTRINSIC.h,
      OPENING_ANCHOR_FRAC.x, OPENING_ANCHOR_FRAC.y,
    );
    const mainAnchor = coverPoint(
      w, h, MAIN_INTRINSIC.w, MAIN_INTRINSIC.h,
      MAIN_ANCHOR_FRAC.x, MAIN_ANCHOR_FRAC.y,
    );
    // The effect's origin is the Opening Loop's Ibex contact point and it
    // never moves: every sub-effect (distance field, filaments, hollow,
    // shear field, dispersion) is measured from here for the whole handoff.
    // The Main Video's framing still evolves underneath - its translation
    // (below) eases from "its Ibex on this point" to none - but the portal
    // itself stays put on screen.
    const ax = openAnchor.x;
    const ay = openAnchor.y;
    // Eased quadratically so most of the re-composition happens while the
    // aperture is still local to the Ibex, and far landmarks (the moon ring,
    // the horizon) are already in place by the time it reaches them.
    const te = 1 - (1 - t) * (1 - t);
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
    // Sampling offset that puts the Main Video's Ibex on the fixed origin
    // while the aperture is small (full framing difference), easing to zero
    // as the portal opens so the fully-open output equals the raw video
    // exactly. This is what lets the framing evolve without the origin moving.
    gl!.uniform2f(
      uShiftB,
      (mainAnchor.x - openAnchor.x) * (1 - te) * dpr,
      (mainAnchor.y - openAnchor.y) * (1 - te) * dpr,
    );
    gl!.uniform1f(uSeed, seed);
    gl!.uniform1f(uFil, fil);
    gl!.uniform1f(uFilLen, filLen);
    gl!.uniform1f(uShear, shear);
    gl!.uniform1f(uRays, rays);

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
