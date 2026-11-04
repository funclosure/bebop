// A small rasteriser for the mark (web/mark.js): its shapes are only rounded rectangles,
// circles, rings and arcs, triangles and half-discs, so each pixel is an exact inside test,
// 4 × 4 samples per pixel for smooth edges. Then a PNG through Bun's own zlib. No dependency.
import { deflateSync } from 'zlib'

type Shape = { t: string; fill: string; [k: string]: any }

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
const norm = (deg: number) => ((deg % 360) + 360) % 360
/** Degrees clockwise from 12 o'clock, as web/mark.js measures. */
const bearing = (dx: number, dy: number) => norm(Math.atan2(dy, dx) * 180 / Math.PI + 90)

export function inside(s: Shape, x: number, y: number): boolean {
  switch (s.t) {
    case 'rrect': {
      if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) return false
      const r = s.r
      if (!r) return true
      const cx = Math.min(Math.max(x, s.x + r), s.x + s.w - r), cy = Math.min(Math.max(y, s.y + r), s.y + s.h - r)
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    }
    case 'circle': return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r
    case 'ring': { const d = Math.hypot(x - s.cx, y - s.cy); return Math.abs(d - s.r) <= s.w / 2 }
    case 'arc': {
      const d = Math.hypot(x - s.cx, y - s.cy)
      const b = bearing(x - s.cx, y - s.cy), span = s.to - s.from
      if (Math.abs(d - s.r) <= s.w / 2 && norm(b - s.from) <= span) return true
      // Round caps at both ends.
      for (const end of [s.from, s.to]) {
        const a = (end - 90) * Math.PI / 180
        if ((x - (s.cx + s.r * Math.cos(a))) ** 2 + (y - (s.cy + s.r * Math.sin(a))) ** 2 <= (s.w / 2) ** 2) return true
      }
      return false
    }
    case 'tri': {
      const [[ax, ay], [bx, by], [cx, cy]] = s.pts
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
      const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
      const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
    }
    case 'half': {
      if ((x - s.cx) ** 2 + (y - s.cy) ** 2 > s.r * s.r) return false
      const rel = norm(bearing(x - s.cx, y - s.cy) - s.angle)
      return s.side > 0 ? rel < 180 : rel >= 180
    }
  }
  return false
}

/** RGBA pixels of the shapes (in a 512 box) at size × size. Transparent where nothing is drawn. */
export function rasterize(shapes: Shape[], size: number, box = { x: 0, y: 0, w: 512 }): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const N = 4, scale = box.w / size, cols = shapes.map(s => hex(s.fill))
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sj = 0; sj < N; sj++) for (let si = 0; si < N; si++) {
      const x = box.x + (i + (si + 0.5) / N) * scale, y = box.y + (j + (sj + 0.5) / N) * scale
      for (let k = shapes.length - 1; k >= 0; k--) {
        if (inside(shapes[k], x, y)) { const c = cols[k]; r += c[0]; g += c[1]; b += c[2]; a++; break }
      }
    }
    const o = (j * size + i) * 4
    if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); px[o + 3] = Math.round(255 * a / (N * N)) }
  }
  return px
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(buf: Uint8Array) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer)
  v.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
/** An RGBA PNG. */
export function encodePng(px: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1) }
  const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer)
  v.setUint32(0, w); v.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
