// The Bebop mark, made from a name: one grammar, many variants. Shared by the hub (SVG and
// PNG icons, hub/raster.ts) and the app (project icons). No dependencies.
//
// Every variant keeps the mark: the cream tile, the black record, the groove, the label split
// white / accent, the two tails and the spindle. One angle θ, from a hash of the name, sets the
// whole composition: the split line runs through θ, the tails keep the original's offset to it
// (point-symmetric), the groove opens where the accent tail points, and the accent is θ's place
// on a colour wheel, so turn and colour move together. Rerolls step θ by the golden angle, so
// each "another one" lands far from the last. The hash's other bits pick only the label size,
// one or two grooves and which tails show. "Bebop" at seed 0 is the original mark.

/** FNV-1a 32-bit of the NFC, lowercased text, then murmur3's finalizer (FNV's low bits barely
 *  move between short, similar names). */
export function hash(s) {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(String(s).normalize('NFC').toLowerCase())) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0 }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16
  return h >>> 0
}

/** The accents around a colour wheel, from blue at θ = 0° in 45° steps: θ picks its colour. */
export const ACCENTS = [
  { name: 'blue', c: '#4f7cff' }, { name: 'violet', c: '#9b6bff' }, { name: 'pink', c: '#ff5fa2' },
  { name: 'coral', c: '#ff6b57' }, { name: 'amber', c: '#ffb020' }, { name: 'lime', c: '#a3d93b' },
  { name: 'green', c: '#2fbf71' }, { name: 'teal', c: '#22b8cf' },
]
/** Where the accent tail points, past the split line (the original mark's geometry). */
export const TAIL_OFFSET = 35.5
const STEP = 22.5, GOLDEN = 137.50776
export const LIGHT = '#f6f5f2', DARK = '#171716', GROOVE = '#3a3a38', DARK_DISC = '#2b2b29'
const ORIGINAL = { angle: 0, accent: ACCENTS[0], gap: null, grooves: 1, label: 96, tails: 'both' }

/** The parameters for a name and seed (0 = the name's own). */
/** Seed -1: the original Bebop mark, whatever the name. */
export const ORIGINAL_SEED = -1
export function markParams(name, seed = 0) {
  if (seed === ORIGINAL_SEED) return ORIGINAL
  const n = Number.isInteger(seed) && seed > 0 ? seed : 0
  const bebop = String(name).normalize('NFC').toLowerCase() === 'bebop'
  if (!n && bebop) return ORIGINAL
  // θ: the name's own turn (Bebop's is 0°), then the golden angle per reroll, on 16 turns.
  const base = bebop ? 0 : (hash(name) % 16) * STEP
  const angle = (Math.round((base + n * GOLDEN) / STEP) * STEP) % 360
  let h = hash(`${name}#${n}#rest`)
  const take = k => { const v = h % k; h = Math.floor(h / k); return v }
  return {
    angle,
    accent: ACCENTS[Math.floor(angle / 45) % ACCENTS.length],
    gap: (angle + TAIL_OFFSET + 360) % 360,   // the groove opens where the accent tail points
    grooves: 1 + take(2),
    label: [88, 96, 104][take(3)],
    tails: ['both', 'both', 'accent', 'light'][take(4)],
  }
}

const rot = (x, y, deg) => {
  const a = deg * Math.PI / 180, dx = x - 256, dy = y - 256
  return [256 + dx * Math.cos(a) - dy * Math.sin(a), 256 + dx * Math.sin(a) + dy * Math.cos(a)]
}
const GAP = 40 // degrees the groove ring is open

/**
 * The mark as primitives in a 512 × 512 box, back to front, for SVG and the rasteriser alike.
 * kind: 'icon' (rounded cream tile), 'maskable' (full-bleed tile, mark at 86 %), 'mark' (no tile).
 *   rrect {x,y,w,h,r} · circle {cx,cy,r} · arc {cx,cy,r,w,from,to} (degrees clockwise from 12
 *   o'clock, round caps) · ring {cx,cy,r,w} · tri {pts:[[x,y]×3]} · half {cx,cy,r,angle,side}
 *   (side 1: the half clockwise of the split line through `angle`).  Each has `fill` and an
 *   optional `cls` ('disc' turns dark grey in dark mode for the bare mark).
 */
export function markShapes(p, kind = 'icon') {
  const out = []
  if (kind === 'icon') out.push({ t: 'rrect', x: 0, y: 0, w: 512, h: 512, r: 112, fill: LIGHT })
  if (kind === 'maskable') out.push({ t: 'rrect', x: 0, y: 0, w: 512, h: 512, r: 0, fill: LIGHT })
  const k = kind === 'maskable' ? 0.86 : 1
  const S = (x, y) => [256 + (x - 256) * k, 256 + (y - 256) * k]
  const c = (cx, cy, r, extra) => { const [x, y] = S(cx, cy); return { cx: x, cy: y, r: r * k, ...extra } }
  out.push({ t: 'circle', ...c(256, 256, 196), fill: DARK, cls: 'disc' })
  if (p.gap == null) out.push({ t: 'ring', ...c(256, 256, 148), w: 10 * k, fill: GROOVE })
  // The gap is centred on p.gap; a second groove opens the opposite way (where the light tail points).
  else [148, 128].slice(0, p.grooves).forEach((r, i) => {
    const from = (p.gap + i * 180 + GAP / 2) % 360
    out.push({ t: 'arc', ...c(256, 256, r), w: 10 * k, from, to: from + 360 - GAP, fill: GROOVE })
  })
  // The tails move out with the label, so the part showing past it is the same at every label
  // size (the largest label would otherwise swallow them). Along each tail's own axis.
  const push = (pts) => {
    const [tx, ty] = pts[1], d = Math.hypot(tx - 256, ty - 256), o = p.label - 96
    return pts.map(([x, y]) => [x + (tx - 256) / d * o, y + (ty - 256) / d * o])
  }
  const tri = (pts, fill) => ({ t: 'tri', pts: push(pts).map(([x, y]) => S(...rot(x, y, p.angle))), fill })
  if (p.tails !== 'accent') out.push(tri([[200, 316], [176, 368], [240, 334]], LIGHT))
  if (p.tails !== 'light') out.push(tri([[312, 196], [336, 144], [272, 178]], p.accent.c))
  out.push({ t: 'half', ...c(256, 256, p.label), angle: p.angle, side: -1, fill: LIGHT })
  out.push({ t: 'half', ...c(256, 256, p.label), angle: p.angle, side: 1, fill: p.accent.c })
  out.push({ t: 'circle', ...c(256, 256, 14), fill: DARK, cls: 'disc' })
  return out
}

const f1 = n => +n.toFixed(2)
const polar = (cx, cy, r, deg) => { const a = (deg - 90) * Math.PI / 180; return [f1(cx + r * Math.cos(a)), f1(cy + r * Math.sin(a))] }

/** The mark as SVG. kind as markShapes; 'mark' crops to the record and darkens it in dark mode. */
export function markSvg(p, kind = 'icon') {
  const el = s => {
    const cls = s.cls && kind === 'mark' ? ` class="${s.cls}"` : ''
    if (s.t === 'rrect') return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${s.fill}"/>`
    if (s.t === 'circle') return `<circle${cls} cx="${f1(s.cx)}" cy="${f1(s.cy)}" r="${f1(s.r)}" fill="${s.fill}"/>`
    if (s.t === 'ring') return `<circle cx="${f1(s.cx)}" cy="${f1(s.cy)}" r="${f1(s.r)}" fill="none" stroke="${s.fill}" stroke-width="${f1(s.w)}"/>`
    if (s.t === 'arc') {
      const [x1, y1] = polar(s.cx, s.cy, s.r, s.from), [x2, y2] = polar(s.cx, s.cy, s.r, s.to)
      return `<path d="M${x1} ${y1}A${f1(s.r)} ${f1(s.r)} 0 1 1 ${x2} ${y2}" fill="none" stroke="${s.fill}" stroke-width="${f1(s.w)}" stroke-linecap="round"/>`
    }
    if (s.t === 'tri') return `<path d="M${s.pts.map(([x, y]) => `${f1(x)} ${f1(y)}`).join(' ')}Z" fill="${s.fill}"/>`
    if (s.t === 'half') {
      const [x1, y1] = polar(s.cx, s.cy, s.r, s.angle), [x2, y2] = polar(s.cx, s.cy, s.r, s.angle + 180)
      return `<path d="M${x1} ${y1}A${f1(s.r)} ${f1(s.r)} 0 0 ${s.side > 0 ? 1 : 0} ${x2} ${y2}Z" fill="${s.fill}"/>`
    }
    return ''
  }
  const box = kind === 'mark' ? '60 60 392 392' : '0 0 512 512'
  const style = kind === 'mark' ? `<style>@media (prefers-color-scheme: dark) { .disc { fill: ${DARK_DISC} } }</style>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${style}${markShapes(p, kind).map(el).join('')}</svg>`
}

/** A data: URL of the mark for a name, for an <img>. */
export const markDataUrl = (name, seed = 0, kind = 'icon') => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markSvg(markParams(name, seed), kind))
