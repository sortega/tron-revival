// Minimal PNG decoder, used to read level obstacles straight from the file.
//
// The obstacles must be exactly the pixels of the image. Reading them back from a canvas
// (drawImage + getImageData) is not reliable: browsers may colour-manage the image and
// Safari adds noise to canvas read-backs as a fingerprinting protection, which turned
// black pixels of a level into stray obstacles. See design/architecture.md (Levels).
//
// Supports what level images use and a bit more: non-interlaced, colour types 0, 2, 3, 4
// and 6, bit depths 1-16. Anything else throws, and the caller falls back to the canvas.

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row by row. Fully transparent pixels are all zero. */
  rgba: Uint8ClampedArray;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('PNG: no DecompressionStream');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedImage> {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('PNG: bad signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  let dataLength = 0;

  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset);
    const name = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (name === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = body[8]!;
      type = body[9]!;
      if (body[12] !== 0) throw new Error('PNG: interlaced images are not supported');
    } else if (name === 'PLTE') {
      palette = body;
    } else if (name === 'tRNS') {
      transparency = body;
    } else if (name === 'IDAT') {
      data.push(body);
      dataLength += body.length;
    } else if (name === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = CHANNELS[type];
  if (!channels || width === 0 || height === 0) throw new Error('PNG: unsupported header');
  if (type === 3 && !palette) throw new Error('PNG: palette missing');

  const packed = new Uint8Array(dataLength);
  let at = 0;
  for (const part of data) {
    packed.set(part, at);
    at += part.length;
  }
  const raw = await inflate(packed);

  const bitsPerPixel = channels * depth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * height) throw new Error('PNG: truncated data');

  // Undo the per-row filters, in place
  const lines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? lines[dst + x - bytesPerPixel]! : 0;
      const b = y > 0 ? lines[dst + x - stride]! : 0;
      const c = x >= bytesPerPixel && y > 0 ? lines[dst + x - stride - bytesPerPixel]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('PNG: bad filter');
      lines[dst + x] = (raw[src + x]! + predicted) & 255;
    }
  }

  // Sample `index` of row `y`: raw value for palettes, otherwise scaled to 0-255
  const maxValue = (1 << Math.min(depth, 8)) - 1;
  const sample = (y: number, index: number, scale: boolean): number => {
    const row = y * stride;
    let value: number;
    if (depth === 8) value = lines[row + index]!;
    else if (depth === 16) return lines[row + index * 2]!; // High byte
    else {
      const bit = index * depth;
      value = (lines[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & maxValue;
    }
    return scale && depth < 8 ? Math.round((value * 255) / maxValue) : value;
  };

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r: number;
      let g: number;
      let b: number;
      let alpha = 255;
      if (type === 3) {
        const index = sample(y, x, false);
        r = palette![index * 3] ?? 0;
        g = palette![index * 3 + 1] ?? 0;
        b = palette![index * 3 + 2] ?? 0;
        if (transparency && index < transparency.length) alpha = transparency[index]!;
      } else if (type === 0 || type === 4) {
        r = g = b = sample(y, x * channels, true);
        if (type === 4) alpha = sample(y, x * channels + 1, true);
      } else {
        r = sample(y, x * channels, true);
        g = sample(y, x * channels + 1, true);
        b = sample(y, x * channels + 2, true);
        if (type === 6) alpha = sample(y, x * channels + 3, true);
      }
      if (alpha === 0) continue; // As a canvas would report it
      const out = (y * width + x) * 4;
      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = alpha;
    }
  }
  return { width, height, rgba };
}
