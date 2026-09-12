/*
  Closing Wave — the Main Video -> Closing Loop handoff.

  The opposite temperament to the Ibex Resonance: quiet, organic, fluid.
  The Main Video's final frame and the Closing Loop's first frame are the
  same composition, so all this has to do is let a soft optical wave pass
  through the picture and leave the Closing Loop behind it. No light is
  added. No rays, no rings, no rainbow. A single noise-bent front sweeps
  across the frame; around it the picture is displaced a few pixels with a
  faint chromatic split, and behind it the Closing Loop is what the picture
  is made of. Ahead of the front nothing is painted and the DOM Main Video
  simply shows.

  Same architecture as the Opening -> Main transition: both layers are
  position:fixed in the same viewport rect and never move; the canvas is
  the compositor during the handoff; the DOM swaps once, silently, after
  the wave has fully passed and its displacement has already returned to
  zero, so the last shader frame equals the raw Closing Loop.

  Everything is a pure function of scroll progress C (0..1). While the
  wave is mid-way, the canvas keeps re-uploading the Closing Loop's live
  frames so the loop is seen playing THROUGH the wave (its own life, not
  ours) and there is no content jump at the swap; the wave itself does not
  move unless the scroll does.
*/

import { CENTER, readFocus, type Focus } from './cover';

const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Touch devices render the wave at no more than 1.5x (its displacement is
// a few px and the handoff is overlapped, so nothing is lost); desktop
// keeps 2x.
const COARSE = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const MAX_DPR = COARSE ? 1.5 : 2;
// Same split as index.html's inline script: on these devices the Closing
// Loop is not attached at parse time and is loaded from here instead.
const DEFER_CLOSING = window.matchMedia('(hover: none) and (pointer: coarse), (max-width: 860px)').matches;
// Scroll trigger for that load, as a fraction of the Main Video act: halfway
// through, i.e. ~6.65 viewport-heights (about 16.7s of footage) before the
// wave begins - several times what the loop needs on a typical mobile link.
const CLOSING_LOAD_AT = 0.5;

const MAIN_INTRINSIC = { w: 1920, h: 1080 };
const CLOSING_INTRINSIC = { w: 1280, h: 720 };

// The Main Video reaches its final frame one viewport before its act ends
// (act.height - vh of travel, then a held viewport). The wave begins a
// little inside that held viewport, so the final scene breathes clean
// first, and finishes a little after the act ends. ~0.86 vh of scroll.
const WAVE_START_VH = -0.35; // relative to the act's end
const WAVE_END_VH = 0.51;
// DOM swap once the front has cleared the frame and the displacement
// envelope has already returned to zero (see the shader's env term).
const SWAP_C = 0.92;

// The editorial layer over the settled Closing Loop. It begins only after
// the wave has completely finished (WAVE_END_VH) plus a breath of clean
// image, and is fully settled before the page's end (the closing spacer
// is 220dvh, i.e. the page scrolls to the act's end + 1.2 vh), so the
// final scroll position is a stable composition. Published to CSS as --e
// (0..1); the stagger and easing per element live in style.css.
const EDITORIAL_START_VH = 0.66;
const EDITORIAL_SPAN_VH = 0.4;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const VERT_SRC = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision highp float;
#define ORIGIN_X 0.46
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform vec2 uResolution;
uniform vec2 uIntrinsicA;
uniform vec2 uIntrinsicB;
uniform vec2 uFocusA;
uniform vec2 uFocusB;
uniform float uC;
uniform float uBReady;

/* object-fit: cover at the layer's own object-position (uFocus, 0.5 =
   centred), so the shader samples exactly what the DOM video shows. */
vec2 coverUV(vec2 screenPx, vec2 intrinsic, vec2 focus) {
  float scale = max(uResolution.x / intrinsic.x, uResolution.y / intrinsic.y);
  vec2 disp = intrinsic * scale;
  vec2 off = (uResolution - disp) * focus;
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
  vec2 uv = px / uResolution;
  float mn = min(uResolution.x, uResolution.y);

  /* One travelling front, bent by two octaves of noise so it is a wave
     through glass, never a line or a circle. It is born at the top edge
     slightly left of centre (ORIGIN_X) and sweeps down and outward from
     there: the x-term is measured from that origin, not from the corner. */
  float n1 = vnoise(px / (mn * 0.55) + 3.7) - 0.5;
  float n2 = vnoise(px / (mn * 0.18) - 1.3) - 0.5;
  float ox = uv.x - ORIGIN_X;
  float s = uv.y * 0.65 + abs(ox) * 0.35 + n1 * 0.30 + n2 * 0.08;
  float edge = uC * 1.7 - 0.25 - s;
  float w = 0.10;
  float k = smoothstep(-w, w, edge);

  /* Displacement lives in a soft band on the front, peaks mid-transition
     and is exactly zero before the swap. A faint second crest trails it. */
  float env = 4.0 * uC * (1.0 - uC) * (1.0 - smoothstep(0.80, 0.91, uC));
  float band = exp(-(edge * edge) / (2.0 * 0.12 * 0.12));
  float ripple = band * (1.0 + 0.35 * cos(edge * 18.0));

  vec2 fdir = normalize(vec2(0.35 * sign(ox + 1e-4) / uResolution.x, 0.65 / uResolution.y));
  vec2 fp = px / (mn * 0.22);
  vec2 e = vec2(0.08, 0.0);
  vec2 flow = vec2(
    vnoise(fp + e.xy) - vnoise(fp - e.xy),
    vnoise(fp + e.yx) - vnoise(fp - e.yx)
  );
  vec2 ddir = normalize(fdir + flow * 3.0 + vec2(1e-4, 0.0));

  float amp = 0.020 * mn * env;
  vec2 disp = ddir * ripple * amp;
  float chroma = 0.42 * amp * band;
  vec2 offR = disp + ddir * chroma;
  vec2 offG = disp;
  vec2 offB = disp - ddir * chroma;

  vec3 colA = vec3(
    texture2D(uTexA, coverUV(px + offR, uIntrinsicA, uFocusA)).r,
    texture2D(uTexA, coverUV(px + offG, uIntrinsicA, uFocusA)).g,
    texture2D(uTexA, coverUV(px + offB, uIntrinsicA, uFocusA)).b
  );
  vec3 colB = vec3(
    texture2D(uTexB, coverUV(px + offR, uIntrinsicB, uFocusB)).r,
    texture2D(uTexB, coverUV(px + offG, uIntrinsicB, uFocusB)).g,
    texture2D(uTexB, coverUV(px + offB, uIntrinsicB, uFocusB)).b
  );
  float kk = k * uBReady;
  vec3 col = mix(colA, colB, kk);

  /* The faintest luminance response at the crest: glass catching light,
     not a glow. */
  col *= 1.0 + 0.05 * band * env;

  float alpha = max(kk, clamp(ripple * env * 2.0, 0.0, 1.0));
  gl_FragColor = vec4(col, alpha);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[closing-wave] shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function initClosingWave(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#closing-wave');
  const closing = document.querySelector<HTMLElement>('.closing-loop');
  const closingVideo = document.querySelector<HTMLVideoElement>('.closing-loop__video');
  const mainVideo = document.querySelector<HTMLVideoElement>('.main-video video[data-sc-scrub]');
  if (!canvas || !closing || !closingVideo || !mainVideo) return;

  function getAct() {
    const inst = window.ScrollCraft?.instances?.[0];
    return inst?.acts?.[0] ?? null;
  }

  // ---- deferred Closing Loop (phones) ---------------------------------
  // index.html attaches the loop's source at parse time on desktop and
  // leaves it to us on phones. It is attached once the Main Video's blob
  // has landed (the bandwidth is free again) or once the reader is halfway
  // through the act, whichever comes first. Everything downstream already
  // copes with a loop that is not decoded yet (uBReady, readyState checks).
  const closingSrc = closingVideo.dataset.src ?? '';
  let closingAttached = !DEFER_CLOSING || !closingSrc || !!closingVideo.getAttribute('src');
  function attachClosing(): void {
    if (closingAttached) return;
    closingAttached = true;
    closingVideo!.src = closingSrc;
    if (!REDUCE) void closingVideo!.play().catch(() => { /* autoplay attribute retries when allowed */ });
  }
  function maybeAttachClosing(): void {
    if (closingAttached) return;
    const act = getAct();
    if (act && window.scrollY >= act.top + CLOSING_LOAD_AT * act.height) attachClosing();
  }
  if (!closingAttached) {
    if (mainVideo.readyState >= 1) attachClosing();
    else mainVideo.addEventListener('loadedmetadata', attachClosing, { once: true });
    window.addEventListener('scroll', maybeAttachClosing, { passive: true });
    maybeAttachClosing();
  }

  // The viewport height the act was laid out for (act.height / span, the
  // engine's own 100vh at layout) rather than the live innerHeight, so the
  // wave and editorial windows do not jump when a phone's URL bar changes
  // innerHeight mid-scroll. On desktop the two are the same number.
  function stableVh(act: { height: number; span: number }): number {
    return act.span > 0 ? act.height / act.span : window.innerHeight;
  }

  function currentC(): number {
    const act = getAct();
    if (!act) return 0;
    const vh = stableVh(act);
    const end = act.top + act.height;
    const start = end + WAVE_START_VH * vh;
    const stop = end + WAVE_END_VH * vh;
    return clamp01((window.scrollY - start) / Math.max(stop - start, 1));
  }

  const editorial = document.querySelector<HTMLElement>('.closing-editorial');
  function applyEditorial(instant: boolean): void {
    if (!editorial) return;
    const act = getAct();
    if (!act) return;
    const vh = stableVh(act);
    const start = act.top + act.height + EDITORIAL_START_VH * vh;
    const e = instant
      ? (window.scrollY >= start ? 1 : 0)
      : clamp01((window.scrollY - start) / (EDITORIAL_SPAN_VH * vh));
    editorial.style.setProperty('--e', e.toFixed(3));
  }

  // ---- reduced motion: no wave, no playback; an instant swap at the
  // act's end, the loop holds its first frame, the editorial layer simply
  // appears once its position is reached. ----
  if (REDUCE) {
    closingVideo.autoplay = false;
    closingVideo.pause();
    closingVideo.currentTime = 0;
    const swap = () => {
      const act = getAct();
      closing!.style.opacity = act && window.scrollY >= act.top + act.height ? '1' : '0';
      applyEditorial(true);
    };
    swap();
    window.addEventListener('scroll', swap, { passive: true });
    window.addEventListener('resize', swap, { passive: true });
    return;
  }

  // A single fullscreen triangle has no edge to antialias: MSAA is off.
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false });
  if (!gl) {
    // No WebGL: a plain, still scroll-driven crossfade rather than a stuck page.
    const fade = () => { closing!.style.opacity = String(currentC()); applyEditorial(false); };
    fade();
    window.addEventListener('scroll', fade, { passive: true });
    window.addEventListener('resize', fade, { passive: true });
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
    console.warn('[closing-wave] program link failed:', gl.getProgramInfoLog(program));
    return;
  }
  gl.useProgram(program);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
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
  const uC = gl.getUniformLocation(program, 'uC');
  const uBReady = gl.getUniformLocation(program, 'uBReady');
  const uFocusA = gl.getUniformLocation(program, 'uFocusA');
  const uFocusB = gl.getUniformLocation(program, 'uFocusB');
  // Each layer's object-position from its computed style; re-read on resize.
  let focusA: Focus = CENTER;
  let focusB: Focus = CENTER;
  function readFocusPoints(): void {
    focusA = readFocus(mainVideo);
    focusB = readFocus(closingVideo);
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  function uploadVideoFrame(tex: WebGLTexture, video: HTMLVideoElement): boolean {
    if (video.readyState < 2) return false;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    try {
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, video);
      return true;
    } catch {
      return false;
    }
  }

  function clear(): void {
    gl!.viewport(0, 0, canvas!.width, canvas!.height);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
  }

  function renderFrame(C: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    uploadVideoFrame(texA, mainVideo!);
    if (uploadVideoFrame(texB, closingVideo!)) texBHasFrame = true;
    clear();
    gl!.useProgram(program);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, texA);
    gl!.uniform1i(uTexA, 0);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, texB);
    gl!.uniform1i(uTexB, 1);
    gl!.uniform2f(uResolution, w * dpr, h * dpr);
    gl!.uniform2f(uIntrinsicA, MAIN_INTRINSIC.w, MAIN_INTRINSIC.h);
    gl!.uniform2f(uIntrinsicB, CLOSING_INTRINSIC.w, CLOSING_INTRINSIC.h);
    gl!.uniform2f(uFocusA, focusA.fx, focusA.fy);
    gl!.uniform2f(uFocusB, focusB.fx, focusB.fy);
    gl!.uniform1f(uC, C);
    gl!.uniform1f(uBReady, texBHasFrame ? 1 : 0);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  /* The handoff between compositor and DOM is never a single-frame flip,
     in either direction. Two fixed layers and a canvas are presented by
     the compositor, and a video element runs on its own presentation path
     (on Windows, its own swap chain), so "hide this layer and paint that
     one in the same task" is not guaranteed to reach the screen as one
     frame. The rule is therefore: whenever a DOM layer is shown or hidden,
     the canvas is ALREADY painting the identical picture on top, and keeps
     doing so for a couple of presented frames on the far side of the
     change. A misordered frame then shows the same picture either way.

     Forward: the DOM Closing layer is shown while the canvas paints the
     raw Closing frame on top; the canvas clears only after the DOM video
     has presented fresh frames while visible (requestVideoFrameCallback,
     HANDOFF_FRAMES of them, so a held frame cannot count), then keeps
     clearing for DRAIN_FRAMES more so no opaque frame lingers in the
     canvas's buffer pool.

     Reverse: the canvas first paints the raw Closing frame OVER the still-
     visible DOM layer for HANDOFF_FRAMES presented frames, hides the DOM
     layer while still painting that identical frame, and only then draws
     the wave. At C >= HOLD_C the shader output is the raw Closing frame
     (the front is off-frame, the displacement envelope is zero), so those
     frames draw at max(C, HOLD_C): a normal reverse scroll is inside that
     window anyway and nothing is held; a single large step that jumps past
     it holds the Closing picture for those three frames (~50ms) before the
     wave state appears. */
  let revealed = false; // the DOM Closing layer is visible
  let revealToken = 0;
  let domFramesSinceReveal = 0;
  let takeoverFrames = 0; // reverse: canvas frames painted over the visible DOM layer
  let drainLeft = 0;
  let lastPainted = false;
  const HANDOFF_FRAMES = 2;
  const DRAIN_FRAMES = 4;
  const HOLD_C = 0.88;

  function clearAndDrain(): void {
    if (lastPainted) drainLeft = DRAIN_FRAMES;
    else if (drainLeft > 0) drainLeft--;
    lastPainted = false;
    clear();
  }

  function paint(C: number): void {
    lastPainted = true;
    renderFrame(C);
  }

  function reveal(): void {
    revealed = true;
    domFramesSinceReveal = 0;
    takeoverFrames = 0;
    closing!.style.opacity = '1';
    const token = ++revealToken;
    if ('requestVideoFrameCallback' in closingVideo!) {
      const noteDomFrame = (): void => {
        // A callback from an earlier reveal, or one that lands after the
        // layer has been hidden again, must not count toward this handoff.
        if (token !== revealToken || !revealed) return;
        domFramesSinceReveal++;
        if (domFramesSinceReveal < HANDOFF_FRAMES) closingVideo!.requestVideoFrameCallback(noteDomFrame);
        ensureLive();
      };
      closingVideo!.requestVideoFrameCallback(noteDomFrame);
    } else {
      domFramesSinceReveal = HANDOFF_FRAMES; // no way to know; hand off next frame
    }
  }

  function draw(C: number): void {
    applyEditorial(false);

    if (C >= SWAP_C) {
      if (!revealed) reveal();
      takeoverFrames = 0;
      if (domFramesSinceReveal >= HANDOFF_FRAMES) clearAndDrain();
      else paint(SWAP_C); // at SWAP_C the shader output is the raw Closing frame
      return;
    }

    if (revealed) {
      // Reverse takeover: identical picture on top, then hide underneath it.
      takeoverFrames++;
      paint(Math.max(C, HOLD_C));
      if (takeoverFrames > HANDOFF_FRAMES) {
        revealed = false;
        closing!.style.opacity = '0';
      }
      return;
    }

    if (C <= 0) { clearAndDrain(); return; }
    paint(C);
  }

  // While the wave is mid-way the Closing Loop is playing underneath it,
  // so keep feeding its live frames through the compositor. The wave's
  // shape is still only a function of the scroll position read each frame.
  let liveRaf = 0;
  function live(): void {
    liveRaf = 0;
    const C = currentC();
    draw(C);
    const handingOff = C >= SWAP_C && domFramesSinceReveal < HANDOFF_FRAMES;
    const takingOver = C < SWAP_C && revealed;
    const busy = (C > 0 && C < SWAP_C) || handingOff || takingOver || drainLeft > 0;
    if (busy && !document.hidden) liveRaf = requestAnimationFrame(live);
  }
  function ensureLive(): void {
    if (!liveRaf) liveRaf = requestAnimationFrame(live);
  }

  function resize(): void {
    readFocusPoints();
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas!.width = Math.round(window.innerWidth * dpr);
    canvas!.height = Math.round(window.innerHeight * dpr);
    canvas!.style.width = window.innerWidth + 'px';
    canvas!.style.height = window.innerHeight + 'px';
    draw(currentC());
    ensureLive();
  }

  window.addEventListener('scroll', ensureLive, { passive: true });
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureLive(); });

  resize();
}
