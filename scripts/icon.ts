#!/usr/bin/env bun
/**
 * The companion's icon: the mark made from its name (web/mark.js) and a seed for a variant.
 *
 *   bun scripts/icon.ts grid NAME [--from N] --out FILE.png   nine variants, 3 × 3, seeds N…N+8
 *                                                             (read left to right, top to bottom)
 *   bun scripts/icon.ts png NAME [--seed N] --out FILE.png    one icon, 512 px
 *   bun scripts/icon.ts set SEED                              use it (HUB_URL, HUB_TOKEN_FILE)
 *   bun scripts/icon.ts get                                   the hub's current seed
 *
 * /bebop:setup uses grid and set; the app's Settings → Appearance does the same.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { markParams, markShapes } from '../web/mark.js'
import { rasterize, encodePng } from '../hub/raster'

const args = process.argv.slice(2)
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const die = (m: string): never => { process.stderr.write(`icon: ${m}\n`); process.exit(2) }
const cmd = args[0]

if (cmd === 'grid' || cmd === 'png') {
  const name = args[1] || die('a name is needed')
  const out = opt('--out') || die('--out FILE.png is needed')
  if (cmd === 'png') {
    const seed = Number(opt('--seed') ?? 0)
    writeFileSync(out, encodePng(rasterize(markShapes(markParams(name, seed), 'icon'), 512), 512, 512))
  } else {
    const from = Number(opt('--from') ?? 0), cell = 200, pad = 24, W = 3 * cell + 4 * pad
    const sheet = new Uint8Array(W * W * 4).fill(255)
    for (let k = 0; k < 9; k++) {
      const px = rasterize(markShapes(markParams(name, from + k), 'icon'), cell)
      const ox = pad + (k % 3) * (cell + pad), oy = pad + Math.floor(k / 3) * (cell + pad)
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const s = (y * cell + x) * 4, d = ((oy + y) * W + ox + x) * 4, a = px[s + 3] / 255
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(px[s + c] * a + 255 * (1 - a))
      }
    }
    writeFileSync(out, encodePng(sheet, W, W))
    console.log(`seeds ${from}…${from + 8}, left to right, top to bottom (1 = ${from}, 9 = ${from + 8})`)
  }
  process.exit(0)
}

if (cmd === 'set' || cmd === 'get') {
  const url = (process.env.HUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const tokenFile = process.env.HUB_TOKEN_FILE || join(import.meta.dir, '..', 'data', 'agent.token')
  let token = ''
  try { token = readFileSync(tokenFile, 'utf8').trim() } catch { die(`can't read the token file ${tokenFile}`) }
  const init: RequestInit = cmd === 'set'
    ? { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ seed: Number(args[1]) }) }
    : { headers: { authorization: `Bearer ${token}` } }
  const r = await fetch(`${url}/agent/icon`, init).catch(e => die(`no hub at ${url} (${e?.cause?.code ?? e})`))
  if (!r.ok) die(`the hub answered HTTP ${r.status}: ${await r.text()}`)
  console.log(JSON.stringify(await r.json()))
  process.exit(0)
}

die('usage: icon.ts grid NAME [--from N] --out FILE | png NAME [--seed N] --out FILE | set SEED | get')
