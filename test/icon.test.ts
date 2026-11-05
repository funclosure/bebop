// The app's icon: the mark made from a name and a seed (web/mark.js), drawn as SVG and PNG
// by the hub (hub/raster.ts), chosen in Settings or by scripts/icon.ts.
import { test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { existsSync, readdirSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { markParams, markShapes, markSvg, markDataUrl, hash, ACCENTS } from '../web/mark.js'
import { rasterize, encodePng } from '../hub/raster'
import { startHub } from './helpers'

const { hub, dataDir, agent, user } = startHub({ agentName: 'Faye' })
afterAll(() => hub.stop())

test('mark: stable per name and seed, Bebop is the original, NFC and case don\'t matter', () => {
  expect(markParams('Faye')).toEqual(markParams('faye'))
  expect(markParams('Zoë')).toEqual(markParams('Zoë'))
  expect(markParams('Faye', 1)).not.toEqual(markParams('Faye'))
  expect(markParams('Bebop')).toMatchObject({ angle: 0, accent: ACCENTS[0], gap: null, tails: 'both' })
  expect(markParams('Bebop', 2).gap).not.toBeNull()
  expect(hash('Rio')).not.toBe(hash('Faye'))
  // Similar short names don't collapse onto one look (FNV alone made two such names twins).
  const looks = new Set(['Rio', 'Faye', 'Sam', 'Ada', 'Kai', 'Mika', 'Otto', 'Juno'].map(n => { const p = markParams(n); return `${p.accent.name}/${p.angle}` }))
  expect(looks.size).toBeGreaterThanOrEqual(6) // 16 looks: colour follows the turn, so collisions happen (the grid is for that)
  // One angle sets it all: accent from the turn's place on the wheel, the gap where the accent tail points.
  for (const n of ['Faye', 'Sam', 'Zoë']) for (let seed = 0; seed < 20; seed++) {
    const p = markParams(n, seed)
    expect(p.angle % 22.5).toBe(0)
    expect(p.accent).toBe(ACCENTS[Math.floor(p.angle / 45)])
    expect(p.gap).toBeCloseTo((p.angle + 35.5) % 360, 5)
  }
  // Rerolls step by the golden angle: the next one is always far from the last.
  for (let seed = 0; seed < 30; seed++) {
    const d = Math.abs(markParams('Faye', seed + 1).angle - markParams('Faye', seed).angle) % 360
    expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(90)
  }
  const s = markSvg(markParams('Faye'), 'icon')
  expect(s.startsWith('<svg')).toBe(true)
  expect(s).toContain(markParams('Faye').accent.c)
  expect(markSvg(markParams('Faye'), 'mark')).toContain('prefers-color-scheme: dark')
  expect(markDataUrl('Faye')).toMatch(/^data:image\/svg\+xml/)
})

test('raster: the PNG is a real PNG; the original matches its known colours', () => {
  const px = rasterize(markShapes(markParams('Bebop'), 'icon'), 64)
  const at = (x: number, y: number) => Array.from(px.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4))
  expect(at(32, 10)).toEqual([0x17, 0x17, 0x16, 255])        // the record
  expect(at(32, 2)).toEqual([0xf6, 0xf5, 0xf2, 255])         // the cream tile above it
  expect(at(36, 26)).toEqual([0x4f, 0x7c, 0xff, 255])        // the accent half (right of the split)
  expect(at(27, 26)).toEqual([0xf6, 0xf5, 0xf2, 255])        // the light half
  expect(at(0, 0)[3]).toBe(0)                                // outside the rounded tile: transparent
  const png = encodePng(px, 64, 64)
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
})

test('hub: icons come from the name and the seed; the seed is set from Settings or the agent', async () => {
  const svg = await (await user('/icons/icon.svg')).text()
  expect(svg).toBe(markSvg(markParams('Faye', 0), 'icon'))
  const png = await user('/icons/icon-192.png')
  expect(png.headers.get('content-type')).toBe('image/png')
  expect(new Uint8Array(await png.arrayBuffer()).subarray(1, 4)).toEqual(new Uint8Array([80, 78, 71]))
  expect(await (await user('/api/icon')).json()).toEqual({ name: 'Faye', seed: 0 })

  expect((await user('/api/icon', { method: 'POST', body: '{"seed":3}' })).status).toBe(403) // CSRF guard
  expect((await user('/api/icon', { method: 'POST', body: '{"seed":-3}', headers: { 'x-hub-action': '1' } })).status).toBe(400)
  expect(await (await user('/api/icon', { method: 'POST', body: '{"seed":3}', headers: { 'x-hub-action': '1' } })).json()).toEqual({ ok: true, seed: 3 })
  expect(await (await user('/icons/mark.svg')).text()).toBe(markSvg(markParams('Faye', 3), 'mark'))
  await user('/icons/icon-192.png')
  await user('/icons/icon-192.png')
  // Drawn once, kept, named after the drawing itself (a change to the rules gets a new file).
  expect(readdirSync(join(dataDir, 'app-icons')).filter(f => f.startsWith(hash(markSvg(markParams('Faye', 3), 'icon')).toString(36) + '-192')).length).toBe(1)
  // -1: the original Bebop mark, whatever the name.
  expect(await (await agent('/agent/icon', { method: 'POST', body: '{"seed":-1}' })).json()).toEqual({ ok: true, seed: -1 })
  expect(await (await user('/icons/icon.svg')).text()).toBe(markSvg(markParams('Bebop'), 'icon'))
  expect((await agent('/agent/icon', { method: 'POST', body: '{"seed":-2}' })).status).toBe(400)
  expect(await (await agent('/agent/icon', { method: 'POST', body: '{"seed":0}' })).json()).toEqual({ ok: true, seed: 0 })
  expect(await (await agent('/agent/icon')).json()).toEqual({ name: 'Faye', seed: 0 })
})

test('scripts/icon.ts: a grid of nine and a single icon as PNGs; set and get go to the hub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'icon-'))
  const run = async (...a: string[]) => {
    const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'scripts', 'icon.ts'), ...a], { env: { ...process.env, HUB_URL: hub.url, HUB_TOKEN_FILE: join(dataDir, 'agent.token') }, stdout: 'pipe', stderr: 'pipe' })
    return { code: await p.exited, out: await new Response(p.stdout).text() }
  }
  const g = await run('grid', 'Faye', '--from', '9', '--out', join(dir, 'grid.png'))
  expect(g.code).toBe(0)
  expect(g.out).toContain('1 = 9, 9 = 17')
  expect(readFileSync(join(dir, 'grid.png')).subarray(1, 4).toString()).toBe('PNG')
  expect((await run('png', 'Faye', '--seed', '2', '--out', join(dir, 'one.png'))).code).toBe(0)
  expect(existsSync(join(dir, 'one.png'))).toBe(true)
  expect((await run('set', '12')).out).toContain('"seed":12')
  expect((await run('get')).out).toContain('"seed":12')
}, 30000)

test('every variant: tails show the same past the label at every size, stay on the record, each grows out of its own colour', async () => {
  const { inside } = await import('../hub/raster')
  // Points spread over a triangle (barycentric grid), to measure how much of it shows.
  const samples = (pts: number[][], n = 40) => {
    const out: number[][] = []
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const a = i / n, b = j / n, c = 1 - a - b
      out.push([a * pts[0][0] + b * pts[1][0] + c * pts[2][0], a * pts[0][1] + b * pts[1][1] + c * pts[2][1]])
    }
    return out
  }
  const showing: Record<string, number> = {}
  let checked = 0
  for (const angle of Array.from({ length: 16 }, (_, i) => i * 22.5)) for (const label of [88, 96, 104]) for (const tails of ['both', 'accent', 'light']) for (const accent of ACCENTS) {
    const p = { angle, accent, gap: 0, grooves: 2, label, tails }
    const shapes = markShapes(p, 'icon')
    const halves = shapes.filter(s => s.t === 'half'), spindle = shapes[shapes.length - 1]
    const tris = shapes.filter(s => s.t === 'tri')
    expect(tris.length).toBe(tails === 'both' ? 2 : 1)
    for (const t of tris) {
      const isAccent = t.fill === accent.c && accent.c !== '#f6f5f2'
      const pts = samples(t.pts)
      const shown = pts.filter(([x, y]) => !halves.some(h => inside(h, x, y)) && !inside(spindle, x, y)).length / pts.length
      // Visible past the label: a real tail, and the same at every label size.
      expect(shown).toBeGreaterThan(0.3)
      const key = `${angle}/${tails}/${isAccent}`
      showing[key + '/' + label] = shown
      // The tip stays on the black record, inside its edge.
      const tip = t.pts[1]
      expect(Math.hypot(tip[0] - 256, tip[1] - 256)).toBeLessThan(196 - 4)
      // The speech-bubble read: the tail's base sits in the half of its own colour.
      const base = [(t.pts[0][0] + t.pts[2][0]) / 2, (t.pts[0][1] + t.pts[2][1]) / 2]
      const own = halves.find(h => h.fill === t.fill)!
      expect(inside(own, base[0], base[1])).toBe(true)
      checked++
    }
    // The two tails never touch.
    if (tris.length === 2) expect(samples(tris[0].pts, 20).some(([x, y]) => inside(tris[1], x, y))).toBe(false)
  }
  for (const k of Object.keys(showing).filter(k => k.endsWith('/96'))) {
    const base = showing[k]
    for (const l of [88, 104]) expect(Math.abs(showing[k.replace(/\/96$/, '/' + l)] - base)).toBeLessThan(0.08)
  }
  expect(checked).toBe(16 * 3 * 8 * 4) // every turn × size × tails (both = 2) × accent
})

test('the app\'s version is the service worker\'s cache name (Settings shows it)', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'web', 'app.js'), 'utf8')
  const sw = readFileSync(join(import.meta.dir, '..', 'web', 'sw.js'), 'utf8')
  const v = /const APP_VERSION = '(v\d+)'/.exec(app)?.[1]
  expect(v).toBeTruthy()
  expect(sw).toContain(`const CACHE = 'shell-${v}'`)
})

test('projects without an icon show initials; only Bebop keeps the mark; sessions carry an agent badge', async () => {
  const { initials } = await import('../web/mark.js')
  expect(initials('Paper Boat')).toBe('PB')
  expect(initials('night-owl')).toBe('NO')
  expect(initials('LampPost')).toBe('LP')
  expect(initials('Locus')).toBe('L')
  expect(initials('Zoë Ünal')).toBe('ZÜ')
  expect(initials('')).toBe('?')
  const app = readFileSync(join(import.meta.dir, '..', 'web', 'app.js'), 'utf8')
  const fn = app.slice(app.indexOf('function projectIcon('), app.indexOf('const projectRow'))
  expect(fn).toContain('initials(p.name)')
  expect(fn).not.toContain('markDataUrl(p.name')
  expect(app).toMatch(/AGENT_BADGES = \{\s*claude:/)
  expect(app.match(/sessionIcon\(p\),/g)?.length).toBe(2) // the sidebar's Sessions and the phone's list
})
