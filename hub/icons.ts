// Project icons: what a peer session's folder looks like, shown next to its name.
// An IconSource knows one kind of project and nothing else. The resolver tries them in
// order and turns what it finds into a small file in the cache, so a new kind of project
// is one more source, and neither the hub's HTTP side nor the PWA has to change.
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { extname, isAbsolute, join, sep } from 'path'
import { spawnRunner, type Runner } from './panes'

export interface IconSource {
  /** Absolute path of this project's icon image, or null if the source doesn't apply. */
  find(dir: string): string | null
}

const SKIP = new Set(['node_modules', 'build', 'dist', 'DerivedData', 'Pods', 'website', 'vendor'])

function appIconSets(dir: string, depth = 5): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const found: string[] = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.name === 'AppIcon.appiconset') found.push(p)
    else if (depth > 0) found.push(...appIconSets(p, depth - 1))
  }
  return found
}

/** The default appearance's largest image in an asset catalog's icon set. */
function largestImage(set: string): string | null {
  let images: any[]
  try { images = JSON.parse(readFileSync(join(set, 'Contents.json'), 'utf8')).images } catch { return null }
  if (!Array.isArray(images)) return null
  const side = (i: any) => parseFloat(i.size ?? '1024') * parseFloat(i.scale ?? '1')
  const best = images.filter(i => i?.filename && !i.appearances?.length).sort((a, b) => side(b) - side(a))[0]
  const p = best && join(set, best.filename)
  return p && existsSync(p) ? p : null
}

/** An Xcode app: the AppIcon set of the main target, not a widget's or an extension's. */
export const xcodeIcon: IconSource = {
  find(dir) {
    const sets = appIconSets(dir)
    const main = sets.filter(s => !/widget|extension/i.test(s.slice(dir.length)))
    for (const s of [...main, ...sets]) { const p = largestImage(s); if (p) return p }
    return null
  },
}

const WEB_DIRS = ['public', 'app/public', 'web', 'web/icons', 'src/web', 'src/web/static', 'static', 'website/assets/img', 'assets/img']
const WEB_FILES = ['apple-touch-icon.png', 'icon-512.png', 'icon-192.png', 'favicon.svg', 'favicon.png', 'favicon.ico']

/** A web app: the home-screen icon if it has one, otherwise its favicon. */
export const webIcon: IconSource = {
  find(dir) {
    for (const file of WEB_FILES) for (const d of WEB_DIRS) {
      const p = join(dir, d, file)
      if (existsSync(p)) return p
    }
    return null
  },
}

export const ICON_SOURCES: IconSource[] = [xcodeIcon, webIcon]
const SIZE = 96 // twice the largest size the PWA draws, for retina screens

export function iconResolver(o: { cacheDir: string; roots: string[]; sources?: IconSource[]; run?: Runner }) {
  const sources = o.sources ?? ICON_SOURCES
  const run = o.run ?? spawnRunner
  const roots = o.roots.flatMap(r => { try { return [realpathSync(r)] } catch { return [] } })
  mkdirSync(o.cacheDir, { recursive: true })

  /** A project folder → the name of its icon in the cache, or null. Never throws. */
  async function resolve(dir: string | null): Promise<string | null> {
    if (!dir || !isAbsolute(dir)) return null
    try {
      const real = realpathSync(dir)
      if (!roots.some(r => real === r || real.startsWith(r + sep))) return null
      let source: string | null = null
      for (const s of sources) if ((source = s.find(real))) break
      if (!source) return null
      const svg = extname(source).toLowerCase() === '.svg'
      const name = createHash('sha256').update(`${source}:${statSync(source).mtimeMs}`).digest('hex').slice(0, 24) + (svg ? '.svg' : '.png')
      const out = join(o.cacheDir, name)
      if (existsSync(out)) return name
      if (svg) { copyFileSync(source, out); return name }
      const r = await run(['/usr/bin/sips', '-s', 'format', 'png', '-Z', String(SIZE), source, '--out', out], {}, 10_000)
      return r.code === 0 && existsSync(out) ? name : null
    } catch { return null }
  }

  /** A project's name → its folder: a direct child of a root, or one level down (Projects/x).
   *  Case doesn't matter; an exact match wins. */
  function folder(name: string | null): string | null {
    if (!name || !/^\w[\w.-]*$/.test(name)) return null
    const lower = name.toLowerCase()
    const dirs = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name) } catch { return [] } }
    const pick = (d: string) => { const all = dirs(d); const hit = all.includes(name) ? name : all.find(x => x.toLowerCase() === lower); return hit ? join(d, hit) : null }
    for (const r of roots) {
      const hit = pick(r) ?? dirs(r).map(c => pick(join(r, c))).find(Boolean)
      if (hit) return hit
    }
    return null
  }

  /** A cache name from the database → its path, for serving. */
  const path = (name: string) => (/^[0-9a-f]{24}\.(png|svg)$/.test(name) ? join(o.cacheDir, name) : null)
  return { resolve, path, folder }
}
