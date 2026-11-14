// PROTOTYPE (benchmark only): the play area drawn with WebGL2 instead of Canvas 2D.
// The arena (level + trails) is a CPU-side pixel buffer mirrored in one texture (only
// the rows that changed are uploaded each frame); sprites, heads and tracers are batched
// quads. The sidebar and text overlays are out of scope: a real renderer
// would keep them on a small 2D canvas redrawn only when they change.
// See design/research/performance.md.

import type { SpriteAtlas } from '../../../src/sprites';
import type { TrailSegment, TronRoundState } from '../../../src/types/game';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../src/game/constants';

const VERTEX = `#version 300 es
in vec2 aPos;
in vec2 aUv;
in vec4 aColor;
uniform vec2 uResolution;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = aUv;
  vColor = aColor;
  vec2 clip = aPos / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uTexture;
out vec4 outColor;
void main() {
  outColor = texture(uTexture, vUv) * vColor;
}`;

const FLOATS_PER_VERTEX = 8;
const MAX_QUADS = 4096;
const GLOW_SIZE = 32;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class WebGLArena {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly arenaTexture: WebGLTexture;
  private atlasTexture: WebGLTexture | null = null;
  private readonly miscTexture: WebGLTexture;   // Left half: glow blob; right half: solid white
  private readonly buffer: WebGLBuffer;
  private readonly vertices = new Float32Array(MAX_QUADS * 6 * FLOATS_PER_VERTEX);
  private count = 0;   // Vertices queued
  private atlasWidth = 1;
  private atlasHeight = 1;
  // Arena pixels, RGBA (little-endian: 0xAABBGGRR), and the rows changed since the last upload
  private readonly arena = new Uint32Array(PLAY_WIDTH * PLAY_HEIGHT);
  private readonly arenaBytes = new Uint8Array(this.arena.buffer);
  private dirtyTop = PLAY_HEIGHT;
  private dirtyBottom = -1;

  constructor(container: HTMLElement, private readonly atlas: SpriteAtlas) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PLAY_WIDTH;
    this.canvas.height = PLAY_HEIGHT;
    this.canvas.style.imageRendering = 'pixelated';
    container.appendChild(this.canvas);
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
    gl.useProgram(program);
    gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), PLAY_WIDTH, PLAY_HEIGHT);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);

    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    const attrib = (name: string, size: number, offset: number): void => {
      const loc = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
    };
    attrib('aPos', 2, 0);
    attrib('aUv', 2, 2);
    attrib('aColor', 4, 4);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    this.arenaTexture = this.makeTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PLAY_WIDTH, PLAY_HEIGHT, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // Glow blob + white square, drawn once on a 2D canvas
    const misc = document.createElement('canvas');
    misc.width = GLOW_SIZE * 2;
    misc.height = GLOW_SIZE;
    const ctx = misc.getContext('2d')!;
    const gradient = ctx.createRadialGradient(GLOW_SIZE / 2, GLOW_SIZE / 2, 0, GLOW_SIZE / 2, GLOW_SIZE / 2, GLOW_SIZE / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
    ctx.fillStyle = '#fff';
    ctx.fillRect(GLOW_SIZE, 0, GLOW_SIZE, GLOW_SIZE);
    this.miscTexture = this.makeTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, misc);

    const image = atlas.getImage();
    if (image) {
      this.atlasTexture = this.makeTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      this.atlasWidth = image.naturalWidth;
      this.atlasHeight = image.naturalHeight;
    }
  }

  private makeTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** The level image becomes the initial content of the arena. */
  setLevel(image: ImageData): void {
    this.arena.set(new Uint32Array(image.data.buffer, image.data.byteOffset, PLAY_WIDTH * PLAY_HEIGHT));
    for (let i = 0; i < this.arena.length; i++) this.arena[i] = this.arena[i]! | 0xff000000;
    this.dirtyTop = 0;
    this.dirtyBottom = PLAY_HEIGHT - 1;
  }

  private touch(y: number): void {
    if (y < this.dirtyTop) this.dirtyTop = y;
    if (y > this.dirtyBottom) this.dirtyBottom = y;
  }

  addTrailSegments(color: string, segments: TrailSegment[]): void {
    const [r, g, b] = hexToRgb(color);
    const value = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    for (const seg of segments) {
      if (seg.x < 0 || seg.y < 0 || seg.x >= PLAY_WIDTH || seg.y >= PLAY_HEIGHT) continue;
      this.arena[seg.y * PLAY_WIDTH + seg.x] = value;
      this.touch(seg.y);
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(PLAY_WIDTH, x + w);
    const y1 = Math.min(PLAY_HEIGHT, y + h);
    if (x1 <= x0 || y1 <= y0) return;
    for (let row = y0; row < y1; row++) this.arena.fill(0xff000000, row * PLAY_WIDTH + x0, row * PLAY_WIDTH + x1);
    this.touch(y0);
    this.touch(y1 - 1);
  }

  clearPixel(x: number, y: number): void {
    this.arena[y * PLAY_WIDTH + x] = 0xff000000;
    this.touch(y);
  }

  // Upload the rows that changed since the last frame
  private uploadArena(): void {
    if (this.dirtyBottom < this.dirtyTop) return;
    const gl = this.gl;
    const rows = this.dirtyBottom - this.dirtyTop + 1;
    gl.bindTexture(gl.TEXTURE_2D, this.arenaTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, this.dirtyTop, PLAY_WIDTH, rows, gl.RGBA, gl.UNSIGNED_BYTE,
      this.arenaBytes, this.dirtyTop * PLAY_WIDTH * 4
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.dirtyTop = PLAY_HEIGHT;
    this.dirtyBottom = -1;
  }

  private quad(
    cx: number, cy: number, w: number, h: number, rotation: number,
    u0: number, v0: number, u1: number, v1: number,
    r: number, g: number, b: number, a: number
  ): void {
    if (this.count + 6 > MAX_QUADS * 6) return;
    const cos = rotation === 0 ? 1 : Math.cos(rotation);
    const sin = rotation === 0 ? 0 : Math.sin(rotation);
    const hw = w / 2;
    const hh = h / 2;
    const v = this.vertices;
    let o = this.count * FLOATS_PER_VERTEX;
    const put = (dx: number, dy: number, u: number, vv: number): void => {
      v[o++] = cx + dx * cos - dy * sin;
      v[o++] = cy + dx * sin + dy * cos;
      v[o++] = u;
      v[o++] = vv;
      v[o++] = r;
      v[o++] = g;
      v[o++] = b;
      v[o++] = a;
    };
    put(-hw, -hh, u0, v0);
    put(hw, -hh, u1, v0);
    put(hw, hh, u1, v1);
    put(-hw, -hh, u0, v0);
    put(hw, hh, u1, v1);
    put(-hw, hh, u0, v1);
    this.count += 6;
  }

  private sprite(name: string, x: number, y: number, rotation = 0, scale = 1): void {
    const frame = this.atlas.getFrame(name);
    if (!frame) return;
    this.quad(
      x, y, frame.width * scale, frame.height * scale, rotation,
      frame.x / this.atlasWidth, frame.y / this.atlasHeight,
      (frame.x + frame.width) / this.atlasWidth, (frame.y + frame.height) / this.atlasHeight,
      1, 1, 1, 1
    );
  }

  private flush(texture: WebGLTexture | null): void {
    const gl = this.gl;
    if (this.count === 0 || !texture) {
      this.count = 0;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices, 0, this.count * FLOATS_PER_VERTEX);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    this.count = 0;
  }

  render(round: TronRoundState): void {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Arena: level + trails
    this.uploadArena();
    this.quad(PLAY_WIDTH / 2, PLAY_HEIGHT / 2, PLAY_WIDTH, PLAY_HEIGHT, 0, 0, 0, 1, 1, 1, 1, 1, 1);
    this.flush(this.arenaTexture);

    // Sprites from the atlas
    for (const portal of round.portals) {
      const name = `portal_${String(portal.animFrame + 1).padStart(2, '0')}`;
      this.sprite(name, portal.x1, portal.y1);
      this.sprite(name, portal.x2, portal.y2);
    }
    for (const item of round.items) {
      if (item.active) this.sprite(item.mystery ? 'random_item' : item.sprite, item.x, item.y);
    }
    for (const proj of round.projectiles) {
      if (proj.type === 'tracer') continue;
      const x = Math.floor(proj.x / 1000);
      const y = Math.floor(proj.y / 1000);
      if (proj.type === 'bomb') {
        const snapped = Math.round((((proj.direction % 360) + 360) % 360) / 30) * 30;
        this.sprite(`bomb_${snapped % 120}`, x, y, (Math.floor(snapped / 120) * 120 * Math.PI) / 180);
      } else {
        this.sprite('bullet', x, y, (proj.direction * Math.PI) / 180);
      }
    }
    for (const exp of round.explosions) {
      this.sprite(`explosion_${String(exp.frame + 1).padStart(2, '0')}`, exp.x, exp.y, 0, exp.scale ?? 0.2);
    }
    for (const bg of round.bodyguards) this.sprite('bodyguard', Math.floor(bg.x / 1000), Math.floor(bg.y / 1000));
    this.flush(this.atlasTexture);

    // Tracers (white pixels) and heads (white pixel + coloured glow)
    for (const proj of round.projectiles) {
      if (proj.type !== 'tracer') continue;
      this.quad(Math.floor(proj.x / 1000) + 0.5, Math.floor(proj.y / 1000) + 0.5, 1, 1, 0, 0.75, 0.5, 0.75, 0.5, 1, 1, 1, 1);
    }
    for (const p of round.players) {
      if (!p.alive) continue;
      const x = Math.floor(p.x / 1000) + 0.5;
      const y = Math.floor(p.y / 1000) + 0.5;
      const [r, g, b] = hexToRgb(p.color);
      // Premultiplied colour with an alpha below one: partly additive, like a glow
      this.quad(x, y, 26, 26, 0, 0, 0, 0.5, 1, r / 255, g / 255, b / 255, 0.6);
      this.quad(x, y, 1, 1, 0, 0.75, 0.5, 0.75, 0.5, 1, 1, 1, 1);
    }
    this.flush(this.miscTexture);
  }
}
