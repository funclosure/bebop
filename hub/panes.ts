// Panes: agent sessions running in a terminal multiplexer, seen and answered from the PWA.
// The provider is the only part that knows the multiplexer (herdr: https://herdr.dev);
// the watcher and the HTTP side only see the generic Pane shape below.
import { basename } from 'path'
import type { ShellBackend, ShellProbe, Shareable } from './shells'

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
  /** The agent's process id, when the multiplexer knows it (finds its transcript). */
  agentPid?(id: string): Promise<number | null>
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

export function herdrProvider(o: { bin: string; socket?: string; timeoutMs?: number; run?: Runner; shells?: () => Set<string> }): PaneProvider {
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

  const isShell = (id: string) => !!o.shells?.().has(id)
  return {
    async list() {
      const agents = parseHerdrList(await call(['agent', 'list']))
      const shells = o.shells?.() ?? new Set<string>()
      if (!shells.size) return agents
      // The hub's own shells (opened or shared, hub/shells.ts): plain panes, so not in the agent list.
      const have = new Set(agents.map(a => a.id))
      const panes = ((await call(['pane', 'list']).catch(() => null))?.result?.panes ?? []).filter((p: any) => shells.has(p?.pane_id) && !have.has(p.pane_id))
      const extra = await Promise.all(panes.map(async (p: any): Promise<Pane> => {
        const pi = (await call(['pane', 'process-info', '--pane', p.pane_id]).catch(() => null))?.result?.process_info
        const fg = pi?.foreground_processes?.[0]?.pid
        const cwd = p.foreground_cwd || p.cwd || null
        return { id: p.pane_id, title: cwd ? basename(cwd) : p.pane_id, agent: 'shell', status: pi ? (fg == null || fg === pi.shell_pid ? 'idle' : 'working') : 'unknown', cwd, project: cwd ? basename(cwd) : null, focused: !!p.focused }
      }))
      return [...agents, ...extra]
    },
    // `recent` = the visible screen plus the scrollback above it, so a tall phone screen fills up.
    async screen(id, lines, opts) {
      const ansi = !!opts?.ansi
      const read = (source: string) => call([isShell(id) ? 'pane' : 'agent', 'read', id, '--source', source, '--lines', String(lines), '--format', ansi ? 'ansi' : 'text'], false)
      // While a dialog is up in an alternate-screen session (newer Claude Code), herdr can't
      // scroll for the history and refuses; the visible screen still holds the dialog.
      const out = await read('recent').catch(e => { if (e instanceof PaneError && e.code === 'agent_not_idle') return read('visible'); throw e })
      return tidyScreen(out, lines, ansi)
    },
    // `pane send-*` print nothing on success (the agent commands print JSON).
    async keys(id, keys) { await (isShell(id) ? call(['pane', 'send-keys', id, ...keys], false) : call(['agent', 'send-keys', id, ...keys])) },
    // The text is the first positional after the target, so a leading '-' is not read as an option.
    // A shell has no agent to prompt: the line is typed, then Enter.
    async prompt(id, text) {
      if (isShell(id)) { await call(['pane', 'send-text', id, text], false); await call(['pane', 'send-keys', id, 'enter'], false); return }
      await call(['agent', 'prompt', id, text])
    },
    // `pane send-text` types it as is (no Enter, no blocked check); a leading '-' is text here too.
    async text(id, text) { await call(['pane', 'send-text', id, text], false) },
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

/** A Rex pane that is one of the hub's own shells (hub/shells.ts): idle at its prompt, working while a command runs. */
function rexShellPane(id: string, session: { label?: string }, proc: any): Pane {
  const cwd = typeof proc?.foreground?.cwd === 'string' && proc.foreground.cwd ? proc.foreground.cwd : null
  const childPid = proc?.child?.pid, fgPid = proc?.foreground?.pid
  return {
    id,
    title: (cwd ? basename(cwd) : '') || String(session.label ?? '').replace(/^bebop-shell-/, '') || 'terminal',
    agent: 'shell',
    status: childPid != null && fgPid === childPid ? 'idle' : proc?.foreground ? 'working' : 'unknown',
    cwd,
    project: cwd ? basename(cwd) : null,
    focused: false,
  }
}

export function rexProvider(o: { bin: string; timeoutMs?: number; run?: Runner; shells?: () => Set<string> }): PaneProvider {
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
    if (!agent) {
      // A plain shell shows only if the hub opened it; every other one stays hidden.
      const id = rexPaneId(session.session_id, block.block_id)
      return o.shells?.().has(id) ? rexShellPane(id, session, proc) : null
    }
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
    async agentPid(id) {
      const pid = (await call(['block', 'call', '-b', target(id).block, 'process']))?.foreground?.pid
      return Number.isInteger(pid) && pid > 0 ? pid : null
    },
  }
}

/** Shells in Rex (hub/shells.ts): a new one is a Rex session running a login zsh started
 *  directly (no Rex shell around it) through `env -i`, so only the given environment reaches it. */
export function rexShellBackend(o: { bin: string; timeoutMs?: number; run?: Runner }): ShellBackend {
  const run = o.run ?? spawnRunner
  const timeout = o.timeoutMs ?? 10000
  async function call(args: string[]): Promise<string> {
    const r = await run([o.bin, ...args], {}, timeout)
    if (r.code !== 0) throw new PaneError(/not.?found|no such|unknown block/i.test(r.stderr) ? 'agent_not_found' : 'failed', (r.stderr || r.stdout).trim().replace(/^Error:\s*/, '').split('\n')[0].slice(0, 300) || `exit ${r.code}`)
    return r.stdout
  }
  const processOf = async (id: string) => {
    const t = parseRexPaneId(id)
    if (!t) throw new PaneError('agent_not_found', `not a Rex pane: ${id}`)
    return JSON.parse(await call(['block', 'call', '-s', t.session, '-b', t.block, 'process']))
  }
  return {
    name: 'rex',
    owns: id => REX_ID.test(id),
    async open({ label, cwd, env }) {
      const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`)
      const out = JSON.parse(await call(['new', label, '--cwd', cwd, '--json', '--shell', 'none', '--', '/usr/bin/env', '-i', ...vars, '/bin/zsh', '-l']))
      const block = out?.initial_windows?.[0]?.block_ids?.[0]
      if (typeof out?.session_id !== 'string' || typeof block !== 'string') throw new PaneError('bad_output', 'rex new did not name its session')
      const id = rexPaneId(out.session_id, block)
      let pid: unknown = null
      for (let i = 0; i < 20 && !Number.isInteger(pid); i++) {
        pid = (await processOf(id).catch(() => null))?.child?.pid
        if (!Number.isInteger(pid)) await Bun.sleep(100)
      }
      if (!Number.isInteger(pid)) { await call(['kill', out.session_id]).catch(() => {}); throw new PaneError('failed', 'the shell did not start') }
      return { id, pid: pid as number }
    },
    async probe(id) {
      const p = await processOf(id).catch(e => { if (e instanceof PaneError && e.code === 'agent_not_found') return null; throw e })
      return Number.isInteger(p?.child?.pid) ? { pid: p.child.pid, agent: rexAgent(p) != null } : null
    },
    async close(id) {
      const t = parseRexPaneId(id)
      if (t) await call(['kill', t.session])
    },
    async shareable() {
      const sessions = JSON.parse(await call(['api', 'call', 'session.list']))?.sessions ?? []
      const out: Shareable[] = []
      for (const sess of sessions) {
        const blocks = JSON.parse(await call(['api', 'call', 'session.list_blocks', JSON.stringify({ session_id: sess.session_id })]).catch(() => '{}'))?.blocks ?? []
        for (const b of blocks) {
          if (b?.creator_name !== 'com.superlogical.terminal') continue
          const id = rexPaneId(sess.session_id, b.block_id)
          const p = await processOf(id).catch(() => null)
          if (!p || rexAgent(p) || !Number.isInteger(p.child?.pid)) continue
          out.push({ id, cwd: p.foreground?.cwd ?? p.child?.cwd ?? null, title: String(sess.label ?? 'shell'), pid: p.child.pid })
        }
      }
      return out
    },
  }
}

const AGENT_NAMES = /^(claude|codex|gemini|opencode|pi|aider|amp|cursor-agent)$/
/** A herdr pane's process info → its shell pid, and whether an agent runs in front of it. */
export function herdrProbe(info: any): ShellProbe | null {
  const pi = info?.result?.process_info
  if (!Number.isInteger(pi?.shell_pid)) return null
  const fg = Array.isArray(pi.foreground_processes) ? pi.foreground_processes : []
  const agent = fg.some((f: any) => [f?.argv0, f?.name, Array.isArray(f?.argv) ? basename(String(f.argv[0] ?? '')) : ''].some(n => AGENT_NAMES.test(String(n ?? ''))))
  return { pid: pi.shell_pid, agent }
}

/** A word typed into a shell, quoted so it stays one word. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Shells in herdr: a new one is a tab (no focus) whose shell then execs a login zsh through
 *  `env -i`; the pid stays the same, so it is recorded before. */
export function herdrShellBackend(o: { bin: string; socket?: string; timeoutMs?: number; run?: Runner }): ShellBackend {
  const run = o.run ?? spawnRunner
  const env: Record<string, string> = o.socket ? { HERDR_SOCKET_PATH: o.socket } : {}
  const timeout = o.timeoutMs ?? 10000
  async function call(args: string[]): Promise<any> {
    const r = await run([o.bin, ...args], env, timeout)
    let parsed: any = null
    try { parsed = JSON.parse(r.stdout) } catch {}
    if (parsed?.error) throw new PaneError(/not_found/.test(String(parsed.error.code)) ? 'agent_not_found' : String(parsed.error.code ?? 'error'), String(parsed.error.message ?? 'herdr error'))
    if (r.code !== 0) throw new PaneError('failed', (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`)
    return parsed
  }
  const probe = async (id: string) => {
    try { return herdrProbe(await call(['pane', 'process-info', '--pane', id])) } catch (e) {
      if (e instanceof PaneError && e.code === 'agent_not_found') return null
      throw e
    }
  }
  return {
    name: 'herdr',
    owns: id => /^w[\w-]*:p[\w-]+$/.test(id),
    async open({ label, cwd, env: vars }) {
      const out = await call(['tab', 'create', '--cwd', cwd, '--label', label, '--no-focus'])
      const id = out?.result?.root_pane?.pane_id, tab = out?.result?.tab?.tab_id ?? out?.result?.root_pane?.tab_id
      if (typeof id !== 'string') throw new PaneError('bad_output', 'herdr tab create did not name its pane')
      let p: ShellProbe | null = null
      for (let i = 0; i < 20 && !p; i++) { p = await probe(id).catch(() => null); if (!p) await Bun.sleep(100) }
      if (!p) { if (tab) await call(['tab', 'close', tab]).catch(() => {}); throw new PaneError('failed', 'the shell did not start') }
      // exec keeps the pid: the same process becomes a login zsh with only these variables.
      const line = ['exec', '/usr/bin/env', '-i', ...Object.entries(vars).map(([k, v]) => shq(`${k}=${v}`)), '/bin/zsh', '-l'].join(' ')
      await call(['pane', 'run', id, line])
      return { id, pid: p.pid }
    },
    probe,
    async close(id) {
      const tab = (await call(['pane', 'get', id]).catch(() => null))?.result?.pane?.tab_id
      if (tab) await call(['tab', 'close', tab]); else await call(['pane', 'close', id])
    },
    async shareable() {
      const [panes, agents] = await Promise.all([call(['pane', 'list']), call(['agent', 'list']).catch(() => null)])
      const agentIds = new Set((agents?.result?.agents ?? []).map((a: any) => a?.pane_id))
      const out: Shareable[] = []
      for (const p of panes?.result?.panes ?? []) {
        if (typeof p?.pane_id !== 'string' || agentIds.has(p.pane_id)) continue
        const pr = await probe(p.pane_id).catch(() => null)
        if (!pr || pr.agent) continue
        out.push({ id: p.pane_id, cwd: p.foreground_cwd || p.cwd || null, title: String(p.terminal_title_stripped || p.pane_id), pid: pr.pid })
      }
      return out
    },
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
    async agentPid(id) { const p = await find(id); return p.agentPid ? p.agentPid(id) : null },
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
