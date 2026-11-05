// The companion behind this hub, for Settings → Companion: who it is (its folder's SOUL.md),
// what runs it (the engine and model it reports), its files to read, and whether Bebop has an
// update. The companion reports itself (channel/server.ts on start: folder and engine;
// bin/presence on SessionStart: the model); the hub reads only three named files in that folder.
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, sep } from 'path'

/** The companion's files Settings can open, in order, read-only. */
export const COMPANION_FILES = ['SOUL.md', 'USER.md', 'MEMORY.md'] as const

export type CompanionInfo = { folder?: string; engine?: string; model?: string; since?: number }

/** A short role line from SOUL.md: the first sentence of the first paragraph under the title. */
export function roleFromSoul(text: string): string | null {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (/^#\s/.test(lines[i] ?? '')) i++ // the title (the name)
  for (; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) continue
    if (/^(#|[-*+]\s|\d+\.\s|>|```|<!--|\|)/.test(l)) return null // no paragraph before the sections
    const plain = l.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    const m = /^(.+?[.!?])(\s|$)/.exec(plain)
    const s = (m ? m[1] : plain).trim()
    return s.length > 160 ? s.slice(0, 157).trimEnd() + '…' : s
  }
  return null
}

/** "claude-opus-5-5[1m]" → "Opus 5.5"; anything else as given. */
export function modelLabel(id: unknown): string | null {
  const raw = typeof id === 'string' ? id : typeof (id as any)?.display_name === 'string' ? (id as any).display_name : typeof (id as any)?.id === 'string' ? (id as any).id : null
  if (!raw) return null
  const s = raw.trim().replace(/\[[^\]]*\]$/, '').slice(0, 60)
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(s)
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return s || null
}

/** A path for the screen: the home folder as ~. */
export const tilde = (p: string) => { const h = homedir(); return p === h ? '~' : p.startsWith(h + sep) ? '~' + p.slice(h.length) : p }

export function companionFiles(folder: string | undefined) {
  if (!folder) return []
  return COMPANION_FILES.flatMap(name => {
    try { const st = statSync(join(folder, name)); return st.isFile() ? [{ name, size: st.size, modified: st.mtimeMs }] : [] } catch { return [] }
  })
}
export function readCompanionFile(folder: string | undefined, name: string): string | null {
  if (!folder || !(COMPANION_FILES as readonly string[]).includes(name)) return null
  try { return readFileSync(join(folder, name), 'utf8') } catch { return null }
}
export const validFolder = (f: unknown): f is string => typeof f === 'string' && f.length < 1024 && isAbsolute(f) && existsSync(f) && statSync(f).isDirectory()

// ---------- Bebop's version and updates (the hub's own checkout) ----------
export type UpdateState = {
  commit: string | null
  date: string | null          // the commit's day, YYYY-MM-DD
  state: 'current' | 'available' | 'unknown'
  behind?: number              // new commits upstream
  ahead?: number               // the checkout's own commits (a fork)
  source?: string              // e.g. upstream/main
  reason?: 'not_git' | 'no_remote' | 'fetch_failed'
  checked: number
}
type Git = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>
const spawnGit = (dir: string): Git => async (args, timeoutMs = 15_000) => {
  try {
    const p = Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' } })
    const t = setTimeout(() => p.kill(), timeoutMs)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(t)
    return { code, out: out.trim() }
  } catch { return { code: -1, out: '' } }
}

/**
 * Whether the checkout is behind Bebop, as /bebop:update decides it: the `upstream` remote when
 * there is one (a fork), else the branch's own remote. Fetches at most once per `everyMs`.
 */
export function updateChecker(dir: string, o: { everyMs?: number; now?: () => number; git?: Git } = {}) {
  const git = o.git ?? spawnGit(dir), now = o.now ?? Date.now, every = o.everyMs ?? 60 * 60 * 1000
  let last: UpdateState | null = null, running: Promise<UpdateState> | null = null
  async function check(): Promise<UpdateState> {
    const head = await git(['log', '-1', '--format=%h %cs'])
    if (head.code !== 0) return { commit: null, date: null, state: 'unknown', reason: 'not_git', checked: now() }
    const [commit, date] = head.out.split(' ')
    const base = { commit, date: date ?? null, checked: now() }
    const remotes = (await git(['remote'])).out.split('\n').filter(Boolean)
    let remote: string | null = null, ref: string | null = null
    if (remotes.includes('upstream')) {
      remote = 'upstream'
      if ((await git(['fetch', '--quiet', 'upstream'])).code !== 0) return { ...base, state: 'unknown', reason: 'fetch_failed' }
      for (const b of ['upstream/HEAD', 'upstream/main', 'upstream/master']) if ((await git(['rev-parse', '--verify', '--quiet', b])).code === 0) { ref = b; break }
    } else {
      const u = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      if (u.code !== 0 || !u.out) return { ...base, state: 'unknown', reason: 'no_remote' }
      ref = u.out; remote = ref.split('/')[0]
      if ((await git(['fetch', '--quiet', remote])).code !== 0) return { ...base, state: 'unknown', reason: 'fetch_failed' }
    }
    if (!ref) return { ...base, state: 'unknown', reason: 'no_remote' }
    const c = await git(['rev-list', '--left-right', '--count', `HEAD...${ref}`])
    const [ahead, behind] = c.out.split(/\s+/).map(Number)
    if (c.code !== 0 || !Number.isFinite(behind)) return { ...base, state: 'unknown', reason: 'fetch_failed' }
    return { ...base, state: behind > 0 ? 'available' : 'current', behind, ahead, source: ref.replace(/^upstream\/HEAD$/, 'upstream') }
  }
  return {
    async status(): Promise<UpdateState> {
      if (last && now() - last.checked < every) return last
      running ??= check().then(s => (last = s)).finally(() => { running = null })
      return running
    },
  }
}
