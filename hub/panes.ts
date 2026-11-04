// Panes: agent sessions running in a terminal multiplexer, seen and answered from the PWA.
// The provider is the only part that knows the multiplexer (herdr: https://herdr.dev);
// the watcher and the HTTP side only see the generic Pane shape below.
import { basename } from 'path'

export type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export type Pane = { id: string; title: string; agent: string; status: PaneStatus; cwd: string | null; project: string | null; focused: boolean }

export interface PaneProvider {
  list(): Promise<Pane[]>
  /** The pane's screen and recent scrollback, at most `lines` lines (the last ones). Plain
   *  text, or with `ansi` its SGR escapes (colors, bold…) kept and every other escape removed. */
  screen(id: string, lines: number, opts?: { ansi?: boolean }): Promise<string>
  keys(id: string, keys: string[]): Promise<void>
  prompt(id: string, text: string): Promise<void>
  /** Literal text typed into the pane, no Enter; works while a dialog is up (its text field). */
  text(id: string, text: string): Promise<void>
}

/** A refusal or failure from the provider. `code` is passed to the client (e.g. agent_blocked). */
export class PaneError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

/** The only keys the PWA may send. Anything else is refused before the provider sees it. */
export const PANE_KEYS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n', 'enter', 'esc', 'tab', 'shift+tab', 'up', 'down', 'left', 'right', 'space', 'backspace'])
export const PANE_MAX_KEYS = 8
export const PANE_PROMPT_MAX = 4000
/** Typed text may not carry control characters: Enter, Esc and the rest go as keys. */
export const PANE_TEXT_BAD = /[\x00-\x1f\x7f-\x9f]/

const STATUSES = new Set<PaneStatus>(['idle', 'working', 'blocked', 'done', 'unknown'])
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+#][0-9A-Za-z]|\x1b[@-_]/g
const SGR = /^\x1b\[[0-9;:]*m$/
const TRAILING = /(?:\s|\x1b\[[0-9;:]*m)+$/

export const stripAnsi = (s: string) => s.replace(ANSI, '')
/** Removes every escape except SGR (`ESC [ … m`: colors and text attributes). */
export const keepSgr = (s: string) => s.replace(ANSI, m => (SGR.test(m) ? m : ''))

/**
 * No trailing whitespace on a line, no trailing blank lines, the last `lines` lines.
 * Plain text by default; with `ansi`, SGR escapes are kept (each line ends reset, so
 * a line can be styled on its own) and every other escape is removed.
 */
export function tidyScreen(raw: string, lines: number, ansi = false): string {
  const clean = (ansi ? keepSgr(raw) : stripAnsi(raw)).replace(/\r/g, '')
  const rows = clean.split('\n').map(l => {
    if (!ansi) return l.replace(/\s+$/, '')
    const t = l.replace(TRAILING, '')
    return t && /\x1b/.test(t) ? t + '\x1b[0m' : t
  })
  while (rows.length && !stripAnsi(rows[rows.length - 1])) rows.pop()
  return rows.slice(-lines).join('\n')
}

/** `herdr agent list` output → panes. Entries without an agent (plain shells) are dropped. */
export function parseHerdrList(out: unknown): Pane[] {
  const agents = (out as any)?.result?.agents
  if (!Array.isArray(agents)) throw new PaneError('bad_output', 'unexpected agent list output')
  return agents.filter(a => a && typeof a.pane_id === 'string' && a.agent).map(a => {
    const cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd : null
    return {
      id: a.pane_id,
      title: String(a.terminal_title_stripped || a.agent || a.pane_id),
      agent: String(a.agent),
      status: STATUSES.has(a.agent_status) ? a.agent_status : 'unknown',
      cwd,
      project: cwd ? basename(cwd) : null,
      focused: !!a.focused,
    }
  })
}

export type Runner = (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

/** Runs a command (argv array, never a shell string) and kills it after the timeout. */
export const spawnRunner: Runner = async (argv, env, timeoutMs) => {
  const p = Bun.spawn(argv, { env: { ...process.env, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const t = setTimeout(() => { timedOut = true; p.kill() }, timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    if (timedOut) throw new PaneError('timeout', `timed out after ${timeoutMs} ms`)
    return { code, stdout, stderr }
  } finally { clearTimeout(t) }
}

export function herdrProvider(o: { bin: string; socket?: string; timeoutMs?: number; run?: Runner }): PaneProvider {
  const run = o.run ?? spawnRunner
  const env: Record<string, string> = o.socket ? { HERDR_SOCKET_PATH: o.socket } : {}
  const timeout = o.timeoutMs ?? 5000

  // herdr prints JSON on stdout, errors included: {"error":{"code","message"}} with a non-zero exit.
  async function call(args: string[], expectJson = true): Promise<any> {
    const r = await run([o.bin, ...args], env, timeout)
    let parsed: any = null
    try { parsed = JSON.parse(r.stdout) } catch {}
    if (r.code !== 0 && !parsed?.error) try { parsed = JSON.parse(r.stderr) } catch {} // `agent read` prints its errors there
    if (parsed?.error) throw new PaneError(String(parsed.error.code ?? 'error'), String(parsed.error.message ?? 'herdr error'))
    if (r.code !== 0) throw new PaneError('failed', (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`)
    if (!expectJson) return r.stdout
    if (parsed == null) throw new PaneError('bad_output', 'herdr did not print JSON')
    return parsed
  }

  return {
    async list() { return parseHerdrList(await call(['agent', 'list'])) },
    // `recent` = the visible screen plus the scrollback above it, so a tall phone screen fills up.
    async screen(id, lines, opts) {
      const ansi = !!opts?.ansi
      const read = (source: string) => call(['agent', 'read', id, '--source', source, '--lines', String(lines), '--format', ansi ? 'ansi' : 'text'], false)
      // While a dialog is up in an alternate-screen session (newer Claude Code), herdr can't
      // scroll for the history and refuses; the visible screen still holds the dialog.
      const out = await read('recent').catch(e => { if (e instanceof PaneError && e.code === 'agent_not_idle') return read('visible'); throw e })
      return tidyScreen(out, lines, ansi)
    },
    async keys(id, keys) { await call(['agent', 'send-keys', id, ...keys]) },
    // The text is the first positional after the target, so a leading '-' is not read as an option.
    async prompt(id, text) { await call(['agent', 'prompt', id, text]) },
    // `pane send-text` types it as is (no Enter, no blocked check); a leading '-' is text here too.
    async text(id, text) { await call(['pane', 'send-text', id, text]) },
  }
}

// ---------- Rex (https://superlogical.com/rex) ----------
// A pane is a terminal block running an agent. Its id carries the session too, since a paste
// goes through the server API, which needs both: `rex:<session uuid>:<block uuid>`.

const REX_ID = /^rex:([0-9a-f-]{36}):([0-9a-f-]{36})$/
/** The hub's key names → Rex's key binding syntax. */
const REX_KEYS: Record<string, string> = { esc: 'escape' }
/** Claude Code's spinner or status glyph at the start of a terminal title. */
const TITLE_GLYPH = /^[^\p{L}\p{N}]+\s+/u

export const rexPaneId = (session: string, block: string) => `rex:${session.replace(/^session:/, '')}:${block.replace(/^block:/, '')}`
export function parseRexPaneId(id: string): { session: string; block: string } | null {
  const m = REX_ID.exec(id)
  return m ? { session: `session:${m[1]}`, block: `block:${m[2]}` } : null
}

/** The status a block's programs reported (OSC 7501), from the current foreground program only. */
export function rexStatus(status: any, process: any): PaneStatus {
  const pid = process?.foreground?.pid
  const recs = (Array.isArray(status?.records) ? status.records : [])
    .filter((r: any) => r && !r.id && (r.owner == null || pid == null || r.owner.pid === pid))
  const s = recs[0]?.state
  if (s === 'error') return 'idle'
  return STATUSES.has(s) ? s : 'unknown'
}

/** The agent running in the foreground, from the block's `process` result; null for a shell. */
export function rexAgent(process: any): string | null {
  const f = process?.foreground
  if (!f) return null
  const names = [f.argv0, f.invoked_path && basename(String(f.invoked_path))].filter(Boolean).map(String)
  return names.includes('claude') ? 'claude' : null
}

/** Rex's `--format vt` moves the cursor right (`ESC [ n C`) in place of runs of spaces. */
export const rexVtSpaces = (s: string) => s.replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(Number(n || 1), 1000)))

export function rexProvider(o: { bin: string; timeoutMs?: number; run?: Runner }): PaneProvider {
  const run = o.run ?? spawnRunner
  const timeout = o.timeoutMs ?? 5000

  async function call(args: string[], expectJson = true): Promise<any> {
    const r = await run([o.bin, ...args], {}, timeout)
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim().replace(/^Error:\s*/, '')
      const code = /not.?found|no such|unknown block/i.test(msg) ? 'agent_not_found' : 'failed'
      throw new PaneError(code, msg.split('\n')[0].slice(0, 300) || `exit ${r.code}`)
    }
    if (!expectJson) return r.stdout
    try { return JSON.parse(r.stdout) } catch { throw new PaneError('bad_output', 'rex did not print JSON') }
  }
  const target = (id: string) => {
    const t = parseRexPaneId(id)
    if (!t) throw new PaneError('agent_not_found', `not a Rex pane: ${id}`)
    return t
  }
  const keyName = (k: string) => REX_KEYS[k] ?? k

  async function blockPane(session: { session_id: string; label?: string }, block: any): Promise<Pane | null> {
    if (block?.creator_name !== 'com.superlogical.terminal' || typeof block.block_id !== 'string') return null
    const b = ['block', 'call', '-b', block.block_id]
    const proc = await call([...b, 'process'])
    const agent = rexAgent(proc)
    if (!agent) return null
    const [status, title] = await Promise.all([call([...b, 'program_status']), call([...b, 'title']).catch(() => null)])
    const cwd = typeof proc?.foreground?.cwd === 'string' && proc.foreground.cwd ? proc.foreground.cwd : null
    const t = String(title?.title ?? '').replace(TITLE_GLYPH, '').trim()
    return {
      id: rexPaneId(session.session_id, block.block_id),
      title: t && t !== 'Claude Code' ? t : (session.label || agent),
      agent,
      status: rexStatus(status, proc),
      cwd,
      project: cwd ? basename(cwd) : null,
      focused: false,
    }
  }

  // A paste event through the server API: the text goes in a JSON argument, never as an option.
  async function paste(id: string, text: string) {
    const t = target(id)
    await call(['api', 'call', 'block.event', JSON.stringify({ session_id: t.session, block_id: t.block, event: { type: 'paste', payload: { text } } })])
  }

  return {
    async list() {
      const sessions = (await call(['api', 'call', 'session.list']))?.sessions
      if (!Array.isArray(sessions)) throw new PaneError('bad_output', 'unexpected session list output')
      const per = await Promise.all(sessions.map(async (s: any) => {
        const blocks = (await call(['api', 'call', 'session.list_blocks', JSON.stringify({ session_id: s.session_id })]).catch(() => null))?.blocks
        if (!Array.isArray(blocks)) return []
        return Promise.all(blocks.map((b: any) => blockPane(s, b).catch(() => null)))
      }))
      return per.flat().filter((p): p is Pane => !!p)
    },
    async screen(id, lines, opts) {
      const ansi = !!opts?.ansi
      const out = await call(['capture', '-b', target(id).block, '--format', ansi ? 'vt' : 'text'], false)
      return tidyScreen(ansi ? rexVtSpaces(out) : out, lines, ansi)
    },
    async keys(id, keys) { await call(['send-key', '-b', target(id).block, ...keys.map(keyName)], false) },
    // Like herdr's `agent prompt`: refused while a dialog is up, else pasted and sent with Enter.
    async prompt(id, text) {
      const t = target(id)
      const status = rexStatus(await call(['block', 'call', '-b', t.block, 'program_status']), await call(['block', 'call', '-b', t.block, 'process']))
      if (status === 'blocked') throw new PaneError('agent_blocked', 'a dialog is waiting for an answer')
      await paste(id, text)
      await call(['send-key', '-b', t.block, 'enter'], false)
    },
    text: paste,
  }
}

/** Several multiplexers as one: the lists are joined, and each pane goes to the provider that listed it. */
export function combinedProvider(providers: PaneProvider[]): PaneProvider {
  if (providers.length === 1) return providers[0]
  const owner = new Map<string, PaneProvider>()
  async function find(id: string) {
    let p = owner.get(id)
    if (!p) { await combined.list(); p = owner.get(id) }
    if (!p) throw new PaneError('agent_not_found', `no such pane: ${id}`)
    return p
  }
  const combined: PaneProvider = {
    // One provider failing (Rex not running, say) leaves the other's panes in the list.
    async list() {
      const results = await Promise.allSettled(providers.map(p => p.list()))
      if (results.every(r => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason
      owner.clear()
      const all: Pane[] = []
      results.forEach((r, i) => {
        if (r.status === 'rejected') return
        for (const pane of r.value) { owner.set(pane.id, providers[i]); all.push(pane) }
      })
      return all
    },
    async screen(id, lines, opts) { return (await find(id)).screen(id, lines, opts) },
    async keys(id, keys) { return (await find(id)).keys(id, keys) },
    async prompt(id, text) { return (await find(id)).prompt(id, text) },
    async text(id, text) { return (await find(id)).text(id, text) },
  }
  return combined
}

/**
 * Polls the provider, tells the hub when the list changed, and when a pane went into
 * `blocked` (at most once per pane per `pushGapMs`). The first poll is a baseline: panes
 * already blocked when the hub starts don't ping.
 */
export function createPaneWatcher(o: {
  provider: PaneProvider
  /** True while any SSE client is connected: poll fast, else slow. */
  watched: () => boolean
  onChange: (panes: Pane[], updated: number) => void
  onBlocked: (pane: Pane) => void
  fastMs?: number
  slowMs?: number
  pushGapMs?: number
  now?: () => number
  log?: (m: string) => void
}) {
  const now = o.now ?? Date.now
  const fastMs = o.fastMs ?? 3000, slowMs = o.slowMs ?? 15000, gap = o.pushGapMs ?? 2 * 60 * 1000
  let panes: Pane[] = []
  let updated = 0
  let baseline = false
  let lastErr = ''
  const lastPush = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  /** Takes a fresh list (from a poll or a request) and works out what changed. */
  function observe(next: Pane[]) {
    const prev = new Map(panes.map(p => [p.id, p]))
    const changed = JSON.stringify(next) !== JSON.stringify(panes)
    panes = next
    updated = now()
    if (baseline) {
      for (const p of next) {
        if (p.status !== 'blocked' || prev.get(p.id)?.status === 'blocked') continue
        const t = lastPush.get(p.id)
        if (t != null && updated - t < gap) continue
        lastPush.set(p.id, updated)
        o.onBlocked(p)
      }
    }
    baseline = true
    if (changed) o.onChange(panes, updated)
  }

  async function refresh(): Promise<Pane[]> {
    const next = await o.provider.list()
    lastErr = ''
    observe(next)
    return panes
  }

  async function tick() {
    try { await refresh() } catch (e) {
      const m = String((e as Error).message ?? e)
      if (m !== lastErr) o.log?.(`hub: panes: ${m}`) // once per distinct error, not every poll
      lastErr = m
    }
  }

  // One timer at a time: a newer schedule() (from wake) makes an older loop stop after its tick.
  let gen = 0
  function schedule(ms: number) {
    clearTimeout(timer)
    const g = ++gen
    timer = setTimeout(async () => {
      await tick()
      if (g === gen && !stopped) schedule(o.watched() ? fastMs : slowMs)
    }, ms)
  }

  return {
    tick, refresh, observe,
    current: () => ({ panes, updated }),
    /** Poll now (the app just connected), so it does not wait out the slow interval. */
    wake() { if (!stopped) schedule(0) },
    start() { stopped = false; schedule(0) },
    stop() { stopped = true; clearTimeout(timer) },
  }
}
