/*
  Sequential frame engine for the Main Video on phones (WebCodecs).

  Seeking a <video> costs a decoder flush plus a decode from the previous
  keyframe for every frame shown, and on a phone's hardware decoder that is
  20-70ms per frame - the scrub is latency-bound however the seeks are
  scheduled. This engine decodes the same MP4 sequentially instead: a
  minimal demuxer reads the sample table, a VideoDecoder is fed frames in
  order (no flush while scrolling forward), a small window of decoded
  VideoFrames is kept around the playhead, and the frame for the scroll
  target is drawn onto a canvas that stands in for the <video>.

  Scope: the mobile encode only - one AVC track, constant frame duration,
  no B-frames (decode order == presentation order), keyframe every few
  frames. Anything else is refused by parseMp4/validate and the caller falls
  back to the seek path. Frame index = floor(seconds * fps), the same
  mapping src/scrub-seek.ts uses, so the picture at any scroll position is
  the frame the seek path would show.
*/

export interface Mp4Sample { offset: number; size: number; key: boolean; pts: number; dur: number }
export interface Mp4Track {
  codec: string;
  description: Uint8Array;
  width: number;
  height: number;
  samples: Mp4Sample[];
  frameDur: number; // microseconds
  fps: number;
  keyframes: number;
  hasBFrames: boolean;
}

interface Box { type: string; body: number; end: number }

function boxes(dv: DataView, u8: Uint8Array, off: number, end: number): Box[] {
  const out: Box[] = [];
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(off + 8)); hdr = 16; }
    if (size === 0) size = end - off;
    if (size < hdr) throw new Error('mp4: bad box size');
    out.push({ type, body: off + hdr, end: off + size });
    off += size;
  }
  return out;
}

const find = (list: Box[], type: string): Box | undefined => list.find((b) => b.type === type);
const need = (list: Box[], type: string): Box => { const b = find(list, type); if (!b) throw new Error('mp4: no ' + type); return b; };

/* Reads the first video track of a progressive (faststart) MP4. */
export function parseMp4(buf: ArrayBuffer): Mp4Track {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const moov = need(boxes(dv, u8, 0, buf.byteLength), 'moov');
  for (const trak of boxes(dv, u8, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = find(boxes(dv, u8, trak.body, trak.end), 'mdia');
    if (!mdia) continue;
    const mdiaKids = boxes(dv, u8, mdia.body, mdia.end);
    const hdlr = find(mdiaKids, 'hdlr');
    if (!hdlr || String.fromCharCode(...u8.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'vide') continue;
    const mdhd = need(mdiaKids, 'mdhd');
    const timescale = u8[mdhd.body] === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12);
    const minf = need(mdiaKids, 'minf');
    const stbl = need(boxes(dv, u8, minf.body, minf.end), 'stbl');
    const sk = boxes(dv, u8, stbl.body, stbl.end);

    const stsd = need(sk, 'stsd');
    const entry = boxes(dv, u8, stsd.body + 8, stsd.end)[0];
    if (!entry || (entry.type !== 'avc1' && entry.type !== 'avc3')) throw new Error('mp4: not avc1');
    const width = dv.getUint16(entry.body + 24);
    const height = dv.getUint16(entry.body + 26);
    const avcC = need(boxes(dv, u8, entry.body + 78, entry.end), 'avcC');
    const description = u8.slice(avcC.body, avcC.end);
    const hex = (n: number): string => n.toString(16).padStart(2, '0');
    const codec = 'avc1.' + hex(description[1]) + hex(description[2]) + hex(description[3]);

    const stts = need(sk, 'stts');
    const durs: number[] = [];
    for (let i = 0, n = dv.getUint32(stts.body + 4); i < n; i++) {
      const c = dv.getUint32(stts.body + 8 + 8 * i), d = dv.getUint32(stts.body + 12 + 8 * i);
      for (let j = 0; j < c; j++) durs.push(d);
    }
    const count = durs.length;
    if (count < 2) throw new Error('mp4: too few samples');
    const cto = new Int32Array(count);
    const ctts = find(sk, 'ctts');
    if (ctts) {
      let k = 0;
      for (let i = 0, m = dv.getUint32(ctts.body + 4); i < m; i++) {
        const c = dv.getUint32(ctts.body + 8 + 8 * i), o = dv.getInt32(ctts.body + 12 + 8 * i);
        for (let j = 0; j < c && k < count; j++) cto[k++] = o;
      }
    }
    const key = new Uint8Array(count);
    const stss = find(sk, 'stss');
    if (stss) { for (let i = 0, m = dv.getUint32(stss.body + 4); i < m; i++) key[dv.getUint32(stss.body + 8 + 4 * i) - 1] = 1; }
    else key.fill(1);
    const stsz = need(sk, 'stsz');
    const fixed = dv.getUint32(stsz.body + 4);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.body + 12 + 4 * i);
    const stsc = need(sk, 'stsc');
    const runs: { first: number; per: number }[] = [];
    for (let i = 0, m = dv.getUint32(stsc.body + 4); i < m; i++) runs.push({ first: dv.getUint32(stsc.body + 8 + 12 * i), per: dv.getUint32(stsc.body + 12 + 12 * i) });
    const stco = find(sk, 'stco'), co64 = find(sk, 'co64');
    const chunkBox = stco ?? co64;
    if (!chunkBox) throw new Error('mp4: no chunk offsets');
    const chunkCount = dv.getUint32(chunkBox.body + 4);
    const chunkOff = (i: number): number => stco ? dv.getUint32(stco.body + 8 + 4 * i) : Number(dv.getBigUint64(chunkBox.body + 8 + 8 * i));
    const offsets = new Float64Array(count);
    let s = 0;
    for (let ci = 0; ci < chunkCount && s < count; ci++) {
      let per = runs[0].per;
      for (const r of runs) if (ci + 1 >= r.first) per = r.per;
      let o = chunkOff(ci);
      for (let j = 0; j < per && s < count; j++) { offsets[s] = o; o += sizes[s]; s++; }
    }
    if (s !== count) throw new Error('mp4: sample/chunk mismatch');
    const samples: Mp4Sample[] = [];
    let dts = 0;
    for (let i = 0; i < count; i++) {
      samples.push({ offset: offsets[i], size: sizes[i], key: key[i] === 1, pts: Math.round((dts + cto[i]) * 1e6 / timescale), dur: Math.round(durs[i] * 1e6 / timescale) });
      dts += durs[i];
    }
    const last = samples[count - 1];
    if (last.offset + last.size > buf.byteLength) throw new Error('mp4: sample beyond file');
    samples.sort((a, b) => a.pts - b.pts);
    // Average over the track: per-sample timestamps are rounded to whole
    // microseconds (512/15360 s is 33333.33us), the mean is exact.
    const frameDur = (samples[count - 1].pts - samples[0].pts) / (count - 1);
    let hasBFrames = false;
    for (let i = 0; i < count; i++) if (cto[i] !== 0) { hasBFrames = true; break; }
    return { codec, description, width, height, samples, frameDur, fps: 1e6 / frameDur, keyframes: samples.filter((x) => x.key).length, hasBFrames };
  }
  throw new Error('mp4: no video track');
}

export interface FrameEngineOptions {
  keepBack: number;   // decoded frames kept behind the playhead
  keepAhead: number;  // ... and ahead of it
  prefetch: number;   // frames decoded ahead of the target while moving forward
  maxSeq: number;     // largest forward gap still decoded sequentially (beyond: restart at a keyframe)
  backPre: number;    // when moving backwards, restart this many frames before the target
  maxQueue: number;   // decoder queue depth before feeding pauses
}

export const DEFAULT_OPTIONS: FrameEngineOptions = { keepBack: 6, keepAhead: 4, prefetch: 3, maxSeq: 10, backPre: 4, maxQueue: 12 };

export interface FrameEngineStats {
  decoded: number; restarts: number; renders: number; misses: number; drawMaxMs: number; decodeLatMs: number; decodeLatMaxMs: number;
}

/* Puts a VideoFrame on the canvas. WebGL first - the same texImage2D upload
   the transition shaders already use for video, GPU-side end to end - and a
   2D context if WebGL is unavailable or refuses VideoFrame uploads. */
interface Presenter { draw(f: VideoFrame): boolean; dispose(): void }

function glPresenter(canvas: HTMLCanvasElement): Presenter | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, premultipliedAlpha: false });
  if (!gl) return null;
  const compile = (type: number, src: string): WebGLShader | null => { const sh = gl.createShader(type); if (!sh) return null; gl.shaderSource(sh, src); gl.compileShader(sh); return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null; };
  const vs = compile(gl.VERTEX_SHADER, 'attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*0.5+0.5,0.5-p.y*0.5);gl_Position=vec4(p,0.,1.);}');
  const fs = compile(gl.FRAGMENT_SHADER, 'precision mediump float;uniform sampler2D t;varying vec2 v;void main(){gl_FragColor=texture2D(t,v);}');
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(prog, 't'), 0);
  gl.viewport(0, 0, canvas.width, canvas.height);
  return {
    draw(f: VideoFrame): boolean {
      if (gl.isContextLost()) return false;
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f); } catch { return false; }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },
    dispose(): void { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}

function canvas2dPresenter(canvas: HTMLCanvasElement): Presenter | null {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  return { draw(f: VideoFrame): boolean { try { ctx.drawImage(f, 0, 0); return true; } catch { return false; } }, dispose(): void { /* nothing held */ } };
}

export class FrameEngine {
  readonly track: Mp4Track;
  readonly config: VideoDecoderConfig;
  readonly last: number;
  readonly durationSeconds: number;
  readonly stats: FrameEngineStats = { decoded: 0, restarts: 0, renders: 0, misses: 0, drawMaxMs: 0, decodeLatMs: 0, decodeLatMaxMs: 0 };
  onRender: ((frame: number) => void) | null = null;
  onError: ((reason: string) => void) | null = null;
  private readonly o: FrameEngineOptions;
  private presenter: Presenter | null = null;
  private canvas: HTMLCanvasElement;
  private dec: VideoDecoder | null = null;
  private frames = new Map<number, VideoFrame>();
  private fedAt = new Map<number, number>();
  private fed = -1;
  private want = 0;
  private shown = -1;
  private dir = 1;
  private raf = 0;
  private dead = false;

  private readonly buf: ArrayBuffer;

  constructor(buf: ArrayBuffer, canvas: HTMLCanvasElement, track: Mp4Track, opts: Partial<FrameEngineOptions> = {}) {
    this.buf = buf;
    this.track = track;
    this.o = { ...DEFAULT_OPTIONS, ...opts };
    this.last = track.samples.length - 1;
    this.durationSeconds = track.samples.length / track.fps;
    this.config = { codec: track.codec, codedWidth: track.width, codedHeight: track.height, description: track.description, optimizeForLatency: true };
    this.canvas = canvas;
    canvas.width = track.width;
    canvas.height = track.height;
  }

  static async supported(config: VideoDecoderConfig): Promise<boolean> {
    if (typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined' || typeof EncodedVideoChunk === 'undefined') return false;
    try { return (await VideoDecoder.isConfigSupported(config)).supported === true; } catch { return false; }
  }

  frameFor(seconds: number): number {
    const k = Math.floor(seconds * this.track.fps + 1e-4);
    return k < 0 ? 0 : k > this.last ? this.last : k;
  }

  /* Starts the decoder and resolves once the frame for `seedSeconds` is on the canvas. */
  start(seedSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.dec = new VideoDecoder({ output: (f) => this.onFrame(f), error: (e) => this.fail('decoder: ' + (e as Error).message) });
        this.dec.configure(this.config);
      } catch (e) { reject(e); return; }
      const first = this.onRender;
      this.onRender = (k) => { this.onRender = first; if (first) first(k); resolve(); };
      this.want = this.frameFor(seedSeconds);
      this.shown = -1;
      this.ensure(this.want);
      this.schedule();
    });
  }

  /* The scroll target, in seconds of footage. */
  setTarget(seconds: number): void {
    if (this.dead) return;
    const k = this.frameFor(seconds);
    if (k === this.want) return;
    this.dir = k > this.want ? 1 : -1;
    this.want = k;
    this.trim();
    this.ensure(k);
    // Moving backwards: decode the previous GOP before it is needed, while the decoder is idle.
    if (this.dir < 0 && k >= 2 && !this.frames.has(k - 2) && this.fedAt.size === 0) {
      const from = this.keyBefore(k - 2 - this.o.backPre);
      this.restart(from);
      this.feed(from, k - 1);
    }
    this.schedule();
  }

  /* The element frames are drawn on (it can change once, see render). */
  surface(): HTMLCanvasElement { return this.canvas; }
  onSurfaceChange: ((next: HTMLCanvasElement, prev: HTMLCanvasElement) => void) | null = null;

  // A canvas keeps its first context type for life, so the 2D fallback needs a
  // fresh element in the same place, with the same class and inline style.
  private replaceCanvas(): HTMLCanvasElement | null {
    const prev = this.canvas;
    const next = prev.cloneNode(false) as HTMLCanvasElement;
    next.width = prev.width; next.height = prev.height;
    prev.replaceWith(next);
    this.canvas = next;
    if (this.onSurfaceChange) this.onSurfaceChange(next, prev);
    return next;
  }

  shownSeconds(): number { return ((this.shown < 0 ? this.want : this.shown) + 0.5) / this.track.fps; }
  hasFrame(): boolean { return this.shown >= 0; }
  shownFrame(): number { return this.shown; }
  liveFrames(): number { return this.frames.size; }

  dispose(): void {
    this.dead = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const f of this.frames.values()) f.close();
    this.frames.clear();
    this.fedAt.clear();
    try { this.dec?.close(); } catch { /* already closed */ }
    this.dec = null;
    this.presenter?.dispose();
    this.presenter = null;
  }

  private fail(reason: string): void {
    if (this.dead) return;
    const cb = this.onError;
    this.dispose();
    if (cb) cb(reason);
  }

  private chunk(i: number): EncodedVideoChunk {
    const s = this.track.samples[i];
    return new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.pts, duration: s.dur, data: new Uint8Array(this.buf, s.offset, s.size) });
  }

  private keyBefore(i: number): number {
    i = i < 0 ? 0 : i > this.last ? this.last : i;
    while (i > 0 && !this.track.samples[i].key) i--;
    return i;
  }

  private feed(a: number, b: number): void {
    const dec = this.dec;
    if (!dec) return;
    b = Math.min(b, this.last);
    for (let i = a; i <= b; i++) {
      if (dec.decodeQueueSize > this.o.maxQueue) break;
      this.fedAt.set(i, performance.now());
      try { dec.decode(this.chunk(i)); } catch (e) { this.fail('decode: ' + (e as Error).message); return; }
      this.fed = i;
    }
  }

  // Reverse or a far jump: drop the pipeline and start again at a keyframe.
  private restart(from: number): void {
    const dec = this.dec;
    if (!dec) return;
    this.stats.restarts++;
    try { dec.reset(); dec.configure(this.config); } catch (e) { this.fail('reset: ' + (e as Error).message); return; }
    this.fed = from - 1;
    this.fedAt.clear();
  }

  private ensure(k: number): void {
    if (this.frames.has(k)) {
      if (this.dir > 0 && this.fed >= k && k + this.o.prefetch > this.fed && this.fed < this.last) this.feed(this.fed + 1, k + this.o.prefetch);
      return;
    }
    if (k > this.fed && k - this.fed <= this.o.maxSeq) { this.feed(this.fed + 1, k + this.o.prefetch); return; }
    if (this.fedAt.has(k)) return; // already in flight
    const from = this.keyBefore(this.dir < 0 ? k - this.o.backPre : k);
    this.restart(from);
    this.feed(from, this.dir < 0 ? k : k + this.o.prefetch);
  }

  private onFrame(f: VideoFrame): void {
    if (this.dead) { f.close(); return; }
    const i = Math.round(f.timestamp / this.track.frameDur);
    this.stats.decoded++;
    const t = this.fedAt.get(i);
    if (t !== undefined) {
      const lat = performance.now() - t;
      this.fedAt.delete(i);
      this.stats.decodeLatMs += (lat - this.stats.decodeLatMs) * 0.2;
      if (lat > this.stats.decodeLatMaxMs) this.stats.decodeLatMaxMs = lat;
    }
    if (i < this.want - this.o.keepBack || i > this.want + this.o.keepAhead) { f.close(); return; }
    this.frames.get(i)?.close();
    this.frames.set(i, f);
    this.trim();
    // a forward run held back by the queue limit continues as outputs drain
    if (this.dir > 0 && this.want + this.o.prefetch > this.fed && this.fed < this.last && this.dec && this.dec.decodeQueueSize <= this.o.maxQueue) this.feed(this.fed + 1, this.want + this.o.prefetch);
    this.schedule();
  }

  private trim(): void {
    const lo = this.want - this.o.keepBack, hi = this.want + this.o.keepAhead;
    for (const [i, f] of this.frames) if (i < lo || i > hi) { f.close(); this.frames.delete(i); }
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  /* The frame to show: the target if decoded, else the nearest decoded frame
     that lies between what is on screen and the target - the picture only ever
     moves toward the target, never past it and never against the scroll. */
  private best(): number {
    if (this.frames.has(this.want)) return this.want;
    if (this.shown < 0) { let b = -1, bd = Infinity; for (const i of this.frames.keys()) { const d = Math.abs(i - this.want); if (d < bd) { bd = d; b = i; } } return b; }
    let b = -1, bd = Infinity;
    const lo = Math.min(this.shown, this.want), hi = Math.max(this.shown, this.want);
    for (const i of this.frames.keys()) { if (i < lo || i > hi) continue; const d = Math.abs(i - this.want); if (d < bd) { bd = d; b = i; } }
    return b;
  }

  private render(): void {
    if (this.dead) return;
    const k = this.best();
    if (k < 0 || k === this.shown) return;
    const f = this.frames.get(k);
    if (!f) return;
    const t0 = performance.now();
    if (!this.presenter) this.presenter = glPresenter(this.canvas) ?? canvas2dPresenter(this.canvas);
    if (!this.presenter) { this.fail('no canvas context'); return; }
    if (!this.presenter.draw(f)) {
      // WebGL refused the VideoFrame (or lost its context): go to a 2D context on a fresh canvas.
      const next = this.replaceCanvas();
      this.presenter.dispose();
      this.presenter = next ? canvas2dPresenter(next) : null;
      if (!this.presenter || !this.presenter.draw(f)) { this.fail('draw failed'); return; }
    }
    const dt = performance.now() - t0;
    if (dt > this.stats.drawMaxMs) this.stats.drawMaxMs = dt;
    this.stats.renders++;
    if (k !== this.want) this.stats.misses++;
    this.shown = k;
    if (this.onRender) this.onRender(k);
  }
}
