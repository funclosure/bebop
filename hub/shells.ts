// Shells: plain terminals on the phone, off unless HUB_SHELLS is set. Two kinds, in any
// multiplexer with a ShellBackend (Rex, herdr):
//  - opened: a shell the hub starts on demand in a project's folder (and ends);
//  - shared: a terminal the user already had open and shared from the app (never ended by
//    the hub: stopping only stops sharing).
// Only a pane in the `shells` table, still running the shell process it had when it was
// opened or shared, with no agent in front, is ever a target; every other plain shell stays
// hidden (panes.ts lists agents only). Opening or sharing needs a fresh Face ID, typing needs
// one again after SHELL_ARM_MS without a write, a risky command needs a confirm, and a shell
// ends after SHELL_IDLE_MS, when the app leaves it, and when the hub restarts.
import type { Database } from 'bun:sqlite'
import { readFileSync, realpathSync, statSync } from 'fs'
import { basename, sep } from 'path'

export const SHELL_IDLE_MS = 10 * 60_000
export const SHELL_ARM_MS = 5 * 60_000
export const SHELLS_MAX = 2

/** A terminal pane as a backend sees it: its shell process, and whether an agent runs in front. */
export type ShellProbe = { pid: number; agent: boolean }
export type Shareable = { id: string; cwd: string | null; title: string; pid: number }

/** One multiplexer's side of shells. */
export interface ShellBackend {
  name: string
  /** True for this multiplexer's pane ids. */
  owns(id: string): boolean
  open(o: { label: string; cwd: string; env: Record<string, string> }): Promise<{ id: string; pid: number }>
  /** null once the pane is gone. */
  probe(id: string): Promise<ShellProbe | null>
  /** Ends a shell the hub opened (never called for a shared one). */
  close(id: string): Promise<void>
  /** Plain terminals with no agent, which the user may share. */
  shareable(): Promise<Shareable[]>
}

export type ShellRow = { id: string; mode: 'opened' | 'shared'; backend: string; project: string; cwd: string; pid: number; title: string; login: string; opened: number; last_active: number; armed: number | null; closed: number | null; reason: string | null }

const real = (p: string) => { try { return realpathSync(p) } catch { return null } }
/** The folder's real path if it is a folder inside one of `roots`, else null. */
export function insideRoots(dir: string | null | undefined, roots: string[]): string | null {
  if (!dir) return null
  const d = real(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
  if (!d) return null
  try { if (!statSync(d).isDirectory()) return null } catch { return null }
  const rs = roots.map(real).filter((r): r is string => !!r)
  return rs.some(r => d === r || d.startsWith(r + sep)) ? d : null
}
export const projectKeyOf = (s: string) => s.toLowerCase()
const KEY = /^[a-z0-9][a-z0-9._ -]{0,63}$/

/**
 * Optional `shells.json`: `{ "projects": { "<key>": "<folder>" }, "deny": ["<key>"], "share": true }`.
 * Shells are on demand for every project the hub knows; `projects` sets or adds a folder,
 * `deny` takes a project out. A folder must lie inside `roots` (links resolved).
 */
export function loadShellsConfig(file: string, roots: string[]): { folders: Map<string, string>; deny: Set<string>; share: boolean; errors: string[] } {
  const folders = new Map<string, string>(), deny = new Set<string>(), errors: string[] = []
  let raw: any
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) {
    if (e?.code !== 'ENOENT') errors.push(`${file}: ${e?.message ?? e}`)
    return { folders, deny, share: false, errors }
  }
  for (const [key, dir] of Object.entries(raw?.projects ?? {})) {
    const k = projectKeyOf(key)
    if (!KEY.test(k)) { errors.push(`shells: bad project key ${key}`); continue }
    const d = typeof dir === 'string' ? insideRoots(dir, roots) : null
    if (!d) { errors.push(`shells: ${key}: ${dir} is not a folder inside ${roots.join(', ')}`); continue }
    folders.set(k, d)
  }
  for (const k of Array.isArray(raw?.deny) ? raw.deny : []) if (typeof k === 'string') deny.add(projectKeyOf(k))
  // Sharing terminals that are already open: off unless asked for.
  return { folders, deny, share: raw?.share === true, errors }
}

/** Commands that get a confirm card before they run. A speed bump, not a sandbox. */
const RISKY: [RegExp, string][] = [
  [/\brm\s|\brmdir\s|\bfind\b.*\s-delete\b/, 'deletes files'],
  [/\bsudo\b|\bsu\s|\bdoas\b/, 'runs as another user'],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|restore\b|branch\s+-D|rebase|filter-branch)/, 'changes git history or the remote'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'runs a script from the internet'],
  [/\blaunchctl\b|\bkillall\b|\bpkill\b|\bkill\s/, 'stops or changes running services'],
  [/\bchmod\s+-R|\bchown\b/, 'changes permissions'],
  [/\bdd\s|\bmkfs|\bdiskutil\b/, 'writes to a disk'],
  [/\bssh\b|\bscp\b|\brsync\b.*:/, 'connects to another machine'],
  [/\bsecurity\s|\.claude-token|agent\.token|hub\.sqlite/, 'touches secrets or the hub’s data'],
  [/(^|[^>0-9&])>\s*(?!\/dev\/null\b)[^\s&>|]/, 'overwrites a file'],
  [/\bmv\s|\btrash\b/, 'moves files'],
  [/\bshutdown\b|\breboot\b|\bhalt\b/, 'turns the machine off'],
]
export function riskOf(cmd: string): string | null {
  for (const [re, why] of RISKY) if (re.test(cmd)) return why
  return null
}

/** An opened shell's environment: a short list from the hub's, nothing else (no HUB_* settings, no tokens). */
export function shellEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ['HOME', 'USER', 'LOGNAME', 'LANG', 'TZ']) if (base[k]) env[k] = base[k]!
  env.PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  env.SHELL = '/bin/zsh'
  env.TERM = 'xterm-256color'
  env.BEBOP_SHELL = '1'
  return env
}

export class ShellError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message) }
}

export function createShells(o: {
  db: Database
  /** The multiplexers; new shells open in the first one. */
  backends: ShellBackend[]
  /** A project's folder (null: no shell for it). Must be checked against the roots by the caller or here. */
  folderOf: (key: string) => string | null
  /** Folders a shell may start in or be shared from. */
  roots: string[]
  /** Sharing open terminals (off by default), and terminals that may never be shared (an agent's, now or before). */
  share?: boolean
  neverShare?: (s: Shareable) => boolean
  /** Projects with no shells (shells.json deny). */
  denied?: (key: string) => boolean
  now?: () => number
  log?: (m: string) => void
}) {
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  if (!o.backends.length) throw new Error('shells need a multiplexer')
  o.db.run(`CREATE TABLE IF NOT EXISTS shells (id TEXT PRIMARY KEY, mode TEXT NOT NULL, backend TEXT NOT NULL, project TEXT NOT NULL, cwd TEXT NOT NULL,
    pid INTEGER NOT NULL, title TEXT NOT NULL, login TEXT NOT NULL, opened INTEGER NOT NULL, last_active INTEGER NOT NULL, armed INTEGER, closed INTEGER, reason TEXT)`)
  const q = {
    open: o.db.query('SELECT * FROM shells WHERE closed IS NULL ORDER BY opened'),
    get: o.db.query('SELECT * FROM shells WHERE id = ? AND closed IS NULL'),
    add: o.db.query('INSERT OR REPLACE INTO shells (id, mode, backend, project, cwd, pid, title, login, opened, last_active, armed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    touch: o.db.query('UPDATE shells SET last_active = ?, armed = ? WHERE id = ?'),
    disarm: o.db.query('UPDATE shells SET armed = NULL WHERE id = ?'),
    close: o.db.query('UPDATE shells SET closed = ?, reason = ? WHERE id = ? AND closed IS NULL'),
  }
  const openRows = () => q.open.all() as ShellRow[]
  const row = (id: string) => (q.get.get(id) as ShellRow | null) ?? null
  const backendOf = (id: string) => o.backends.find(b => b.owns(id)) ?? null
  let changed: () => void = () => {}

  /** Still the shell it was: same process, no agent in front. */
  async function alive(r: ShellRow) {
    const p = await backendOf(r.id)?.probe(r.id).catch(() => null)
    return !!p && p.pid === r.pid && !p.agent
  }

  async function close(id: string, reason: string) {
    const r = row(id)
    if (!r) return false
    q.close.run(now(), reason, id)
    log(`hub: shell ${id} (${r.project}, ${r.mode}) ${r.mode === 'shared' ? 'no longer shared' : 'closed'}: ${reason}`)
    // A shared terminal is the user's own: the hub stops showing it and leaves it running.
    if (r.mode === 'opened') try { await backendOf(id)?.close(id) } catch (e: any) { log(`hub: shell ${id}: close failed: ${e?.message ?? e}`) }
    changed()
    return true
  }
  function roomFor() {
    const rows = openRows()
    if (rows.length >= SHELLS_MAX) throw new ShellError('too_many', 409, `at most ${SHELLS_MAX} shells at a time`)
    return rows
  }

  return {
    shareOn: !!o.share,
    onChange(fn: () => void) { changed = fn },
    list: () => openRows().map(r => ({ id: r.id, mode: r.mode, project: r.project, opened: r.opened })),
    ids: () => new Set(openRows().map(r => r.id)),
    get: row,
    /**
     * A shell in a folder: `cwd` (a session's folder), else `project`'s. Its open one if there
     * is one, else a new one (needs `stepped`).
     */
    async open(project: string, login: string, stepped: boolean, at?: string | null) {
      const dir = at != null ? at : o.folderOf(projectKeyOf(project))
      const cwd = insideRoots(dir, o.roots)
      if (!cwd) throw new ShellError('no_folder', 404, 'no folder for a shell here')
      const key = projectKeyOf(at != null ? basename(cwd) : project)
      if (!KEY.test(key)) throw new ShellError('not_allowed', 400, 'bad project')
      if (at != null && o.denied?.(key)) throw new ShellError('no_folder', 404, 'no folder for a shell here')
      if (!stepped) throw new ShellError('stepup', 403, 'stepup required')
      const mine = openRows().find(r => r.cwd === cwd && r.mode === 'opened')
      if (mine) { q.touch.run(now(), now(), mine.id); return { id: mine.id, reused: true } }
      roomFor()
      const b = o.backends[0], t = now()
      const { id, pid } = await b.open({ label: `bebop-shell-${key.replace(/[^a-z0-9._-]/g, '-')}`, cwd, env: shellEnv() })
      q.add.run(id, 'opened', b.name, key, cwd, pid, `Terminal · ${key}`, login, t, t, t)
      log(`hub: shell ${id} (${key}) opened in ${cwd} (${b.name}) by ${login}`)
      changed()
      return { id, reused: false }
    },
    /** Terminals the user may share: no agent, a folder inside the roots, not shown already. */
    async shareable(): Promise<(Shareable & { project: string; backend: string })[]> {
      if (!o.share) throw new ShellError('share_off', 404, 'sharing terminals is off')
      const have = new Set(openRows().map(r => r.id))
      const all = await Promise.all(o.backends.map(async b => (await b.shareable().catch(() => [])).map(s => ({ ...s, backend: b.name }))))
      return all.flat().filter(s => !have.has(s.id) && !o.neverShare?.(s) && insideRoots(s.cwd, o.roots)).map(s => ({ ...s, project: projectKeyOf(basename(s.cwd!)) }))
    },
    /** Shows one of the user's own terminals (needs `stepped`). */
    async share(id: string, login: string, stepped: boolean) {
      if (!o.share) throw new ShellError('share_off', 404, 'sharing terminals is off')
      if (!stepped) throw new ShellError('stepup', 403, 'stepup required')
      if (row(id)) return { id, reused: true }
      const s = (await this.shareable()).find(x => x.id === id)
      if (!s) throw new ShellError('not_shareable', 404, 'that terminal can’t be shared (gone, running an agent, or outside the allowed folders)')
      roomFor()
      const t = now()
      q.add.run(id, 'shared', s.backend, s.project, insideRoots(s.cwd, o.roots)!, s.pid, s.title || `Terminal · ${s.project}`, login, t, t, t)
      log(`hub: shell ${id} (${s.project}) shared by ${login}`)
      changed()
      return { id, reused: false }
    },
    /**
     * Before every write: the shell is one of the table's, still runs its process with no
     * agent in front, and the user stepped up in the last SHELL_ARM_MS (or just now). A write re-arms it.
     */
    async checkWrite(id: string, stepped: boolean) {
      const r = row(id)
      if (!r) throw new ShellError('agent_not_found', 404, 'no such shell')
      if (!(await alive(r))) { await close(id, 'gone'); throw new ShellError('agent_not_found', 404, 'the shell has ended') }
      const t = now()
      if (!stepped && (r.armed == null || t - r.armed > SHELL_ARM_MS)) throw new ShellError('stepup', 403, 'stepup required')
      q.touch.run(t, t, id)
      return r
    },
    disarm(id: string) { q.disarm.run(id) },
    close,
    /** Ends idle shells and forgets ended ones. Runs every minute. */
    async sweep() {
      const t = now()
      for (const r of openRows()) {
        if (t - r.last_active > SHELL_IDLE_MS) await close(r.id, 'idle')
        else if (!(await alive(r))) await close(r.id, 'gone')
      }
    },
    /** At start: a shell from before the restart can't be vouched for, so it ends (a shared one is only unshared). */
    async closeAll(reason: string) { for (const r of openRows()) await close(r.id, reason) },
  }
}
export type Shells = ReturnType<typeof createShells>
