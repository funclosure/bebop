// Tools: web apps that open beside a topic (Board, the whiteboard, is the first) and post into it.
//
// A tool ships a `bebop-tool.json` manifest at its root. The operator lists the tools to load in
// data/tools.json (or HUB_TOOLS_FILE); the hub never installs or adds one by itself. Each tool runs
// on its own origin (never a path under the hub: a same-origin frame could call the hub's /api as
// the user), and talks to the app over postMessage (protocol `bebop-tool` v1, see SPEC.md).
//
// A tool's source is a local folder (used in place) or a git URL that `bun run tools add` cloned
// into <tools dir>/tools/<id>/ and pinned in tools.lock.json. The operator runs its server, or with
// `run: true` the hub does (superviseTools, below).
import { spawn, spawnSync } from 'child_process'
import { createConnection } from 'net'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { z } from 'zod'

/** Ids a tool can't take: they'd clash with the channel's own meta keys (`<id>_…`) or words the hub uses. */
export const RESERVED_TOOL_IDS = new Set(['chat', 'message', 'user', 'kind', 'thread', 'image', 'file', 'voice', 'raw', 'dictated', 'answer', 'reply', 'tool'])
/** The hub's own instance ids: the thread id made readable for a URL. A manifest's pattern must accept them. */
export const INSTANCE_ID = /^[A-Za-z0-9_-]{6,64}$/
/** Frame permissions a tool may have without the operator granting more in tools.json. */
export const DEFAULT_ALLOW = ['clipboard-write', 'fullscreen']
/** Agent instructions per tool, after {cli} is filled in. */
export const INSTRUCTIONS_MAX = 800

const argv = z.array(z.string().min(1).max(500)).min(1).max(40)
const relPath = z.string().min(1).max(300).refine(p => !isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'a path inside the tool')
// A frame template is a path on the tool's own origin (checked again when it's filled in).
const frameTemplate = z.string().min(1).max(300).refine(s => s.startsWith('/') && !s.startsWith('//'), 'a path starting with /')

export const ToolManifest = z.object({
  bebop: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9]{1,15}$/, 'lowercase letters and digits, 2–16, starting with a letter')
    .refine(id => !RESERVED_TOOL_IDS.has(id), 'reserved id'),
  name: z.string().min(1).max(40),
  version: z.string().max(40).optional(),
  description: z.string().max(300).optional(),
  icon: relPath.refine(p => /\.(svg|png|webp)$/i.test(p), 'an .svg, .png or .webp file').optional(),
  // topic (default): one instance per topic. project: one per project (topics with none share "desk"),
  // opened at a page: the topic's thread id, or "overview" from the project's header.
  scope: z.enum(['topic', 'project']).optional(),
  frame: z.object({
    url: frameTemplate.refine(s => s.includes('{instance}'), 'must contain {instance}'),
    link: frameTemplate.optional(),
    allow: z.array(z.string().regex(/^[a-z-]{1,40}$/)).max(10).optional(),
  }),
  instance: z.object({ pattern: z.string().min(1).max(200) }).optional(),
  // The only keys a post's `ref` may carry ("id" is taken: <tool>_id is the instance). A project tool's
  // posts also carry "page" (added if the manifest leaves it out).
  ref: z.array(z.string().regex(/^[a-z]{1,16}$/).refine(k => k !== 'id', '"id" is taken')).max(6).optional(),
  install: z.array(argv).max(10).optional(),
  serve: z.object({ command: argv, port: z.number().int().min(1).max(65535).optional(), health: z.string().max(200).optional() }).optional(),
  // Names of variables the tool may take from the hub's environment (when set there); nothing else of it passes.
  secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).refine(k => !k.startsWith('HUB_'), 'HUB_* stays with the hub')).max(20).optional(),
  // claudeLogin: the tool runs Claude on the operator's login (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY pass through).
  requires: z.object({ claudeLogin: z.boolean().optional() }).optional(),
  agent: z.object({ cli: relPath.optional(), instructions: z.string().max(2000).optional() }).optional(),
})
export type ToolManifest = z.infer<typeof ToolManifest>

/** One entry of data/tools.json. */
export const ToolEntry = z.object({
  source: z.string().min(1).max(1000),
  origin: z.string().min(1).max(300),
  port: z.number().int().min(1).max(65535).optional(),
  run: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  allow: z.array(z.string().regex(/^[a-z-]{1,40}$/)).max(10).optional(),
})
export type ToolEntry = z.infer<typeof ToolEntry>

/** A tool the hub has loaded: its manifest, where it lives and what it may do. */
export type Tool = {
  id: string
  name: string
  version?: string
  origin: string
  /** The tool's folder (unset for the built-in Board shim). */
  dir?: string
  manifest: ToolManifest
  /** One instance per topic, or per project (see ToolManifest.scope). */
  scope: 'topic' | 'project'
  pattern: RegExp
  ref: string[]
  /** Frame permissions: the manifest's, filtered to DEFAULT_ALLOW plus what tools.json grants. */
  allow: string[]
  /** Absolute path of the icon file, if any. */
  icon?: string
  /** Its tools.json entry (unset for the built-in Board shim). */
  entry?: ToolEntry
  /** For a git source: the pinned commit. */
  commit?: string
}

// ---------- git sources ----------

/** `git+<url>#<ref>`: the form tools.json keeps. Any other source is a local folder. */
export function isGitSource(source: string): boolean {
  return source.startsWith('git+')
}
/** The URL and ref of a `git+<url>#<ref>` source (ref defaults to HEAD, the remote's default branch). */
export function parseGitSource(source: string): { url: string; ref: string } | null {
  if (!isGitSource(source)) return null
  const rest = source.slice(4)
  const i = rest.lastIndexOf('#')
  const url = i < 0 ? rest : rest.slice(0, i)
  const ref = (i < 0 ? '' : rest.slice(i + 1)) || 'HEAD'
  if (!url || !/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) || ref.startsWith('-') || url.startsWith('-')) return null
  return { url, ref }
}

/** One pinned git tool in tools.lock.json, keyed by tool id. */
export type LockEntry = {
  id: string
  source: string
  url: string
  ref: string
  /** The commit checked out in tools/<id>/. */
  commit: string
  /** The commit `bun run tools install` last ran the install steps for (null: not yet). */
  installed: string | null
  added: string
  updated?: string
}
export const lockFileFor = (toolsFile: string) => join(dirname(toolsFile), 'tools.lock.json')
/** Where git tools are cloned: tools/<id>/ beside the tools file. */
export const toolsHomeFor = (toolsFile: string) => join(dirname(toolsFile), 'tools')

export function readLock(file: string): Record<string, LockEntry> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}

/** The commit a clone has checked out (detached HEAD), without running git. */
export function checkedOutCommit(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40,64}$/.test(head)) return head
    const m = /^ref: (refs\/[^\s]+)$/.exec(head)
    if (m) return readFileSync(join(dir, '.git', m[1]), 'utf8').trim()
  } catch {}
  return null
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A tool origin: https, or http on this machine; just the origin (no path). Null if not acceptable. */
export function toolOriginOf(s: string | undefined, hubOrigins: string[] = []): string | null {
  if (!s) return null
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return null
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null
  if (hubOrigins.includes(u.origin)) return null
  return u.origin
}

/** A topic's instance id for a tool: the thread id made readable for a URL ([A-Za-z0-9_-]{6,64}). */
export function instanceIdFor(thread: string, n = 1, pad = 'tool'): string {
  const suffix = n > 1 ? `-${n}` : ''
  let base = thread.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (base.length < 6) base = base ? `${base}-${pad}` : pad
  if (base.length < 6) base = base.padEnd(6, '-')
  return base.slice(0, 64 - suffix.length) + suffix
}

/** A project tool's page opened from the project's header (a topic's page is its thread id). */
export const OVERVIEW_PAGE = 'overview'
/** The instance key of a project tool for topics with no project. */
export const DESK = 'desk'

/** The tool's frame and link URLs for an instance (and page), on its own origin (null if a template leaves it). */
export function toolUrls(tool: Tool, instance: string, page = ''): { frame: string; link: string } | null {
  const fill = (t: string) => {
    try {
      const u = new URL(t.replaceAll('{instance}', encodeURIComponent(instance)).replaceAll('{page}', encodeURIComponent(page)), tool.origin)
      return u.origin === tool.origin ? u.href : null
    } catch { return null }
  }
  const frame = fill(tool.manifest.frame.url)
  const link = fill(tool.manifest.frame.link ?? tool.manifest.frame.url.replace(/[?#].*$/, ''))
  return frame && link ? { frame, link } : null
}

/** The agent's instructions for a tool: {cli} filled in with its absolute path, capped. */
export function toolInstructions(tool: Tool): string | null {
  const a = tool.manifest.agent
  if (!a?.instructions) return null
  const cli = a.cli && tool.dir ? join(tool.dir, a.cli) : a.cli ?? ''
  const text = a.instructions.replaceAll('{cli}', cli).replace(/\s+/g, ' ').trim()
  return text.length > INSTRUCTIONS_MAX ? text.slice(0, INSTRUCTIONS_MAX - 1) + '…' : text
}

function compile(pattern: string | undefined): RegExp | null {
  if (!pattern) return INSTANCE_ID
  try {
    const re = new RegExp(pattern)
    // The hub makes the ids, so the tool has to take them.
    return ['abcdef', 'my-topic-2', 'x'.repeat(64), 'A_b-9z'].every(s => re.test(s)) ? re : null
  } catch { return null }
}

/** Builds a Tool from a manifest; throws with a readable reason. */
export function makeTool(manifest: unknown, entry: { origin: string; allow?: string[] }, dir?: string, hubOrigins: string[] = []): Tool {
  const parsed = ToolManifest.safeParse(manifest)
  if (!parsed.success) throw new Error(`bebop-tool.json: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  const m = parsed.data
  const origin = toolOriginOf(entry.origin, hubOrigins)
  if (!origin) throw new Error(`origin ${entry.origin} must be https (or http on localhost), only an origin, and not the hub's own`)
  const pattern = compile(m.instance?.pattern)
  if (!pattern) throw new Error(`instance.pattern must be a valid regex that accepts the hub's ids ([A-Za-z0-9_-]{6,64})`)
  const granted = new Set([...DEFAULT_ALLOW, ...(entry.allow ?? [])])
  let icon: string | undefined
  if (m.icon && dir) {
    const p = resolve(dir, m.icon)
    if (!relative(dir, p).startsWith('..') && existsSync(p) && statSync(p).isFile()) icon = p
  }
  const scope = m.scope ?? 'topic'
  const ref = m.ref ?? []
  const tool: Tool = {
    id: m.id, name: m.name, version: m.version, origin, dir, manifest: m, scope, pattern,
    ref: scope === 'project' && !ref.includes('page') ? [...ref, 'page'] : ref, allow: (m.frame.allow ?? []).filter(a => granted.has(a)), icon,
  }
  if (!toolUrls(tool, 'abcdef', 'some/page?x#y')) throw new Error('frame.url / frame.link must stay on the tool\'s origin')
  return tool
}

/**
 * Reads the tools file (a JSON array of entries, or {tools: [...]}) and each tool's manifest.
 * A tool that can't be loaded is logged and skipped; the rest still load.
 */
export function loadTools(file: string, opts: { hubOrigins?: string[]; log?: (m: string) => void } = {}): Tool[] {
  const log = opts.log ?? (() => {})
  if (!existsSync(file)) return []
  let raw: any
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { log(`hub: tools: ${file} is not JSON (${(e as Error).message}); no tools`); return [] }
  const list = Array.isArray(raw) ? raw : raw?.tools
  if (!Array.isArray(list)) { log(`hub: tools: ${file} should be a list of tools; no tools`); return [] }
  const out: Tool[] = []
  let lock: Record<string, LockEntry> | undefined
  for (const [i, x] of list.entries()) {
    const e = ToolEntry.safeParse(x)
    if (!e.success) { log(`hub: tools: entry ${i}: ${e.error.issues.map(j => `${j.path.join('.')}: ${j.message}`).join('; ')}`); continue }
    const entry = e.data
    let dir: string, pin: LockEntry | undefined
    if (isGitSource(entry.source) || /^(https?|ssh|file):\/\/|^git@/.test(entry.source)) {
      // A git tool loads only as `bun run tools add` left it: cloned, at the pinned commit, installed.
      pin = Object.values(lock ??= readLock(lockFileFor(file))).find(l => l?.source === entry.source)
      if (!pin || !/^[a-z][a-z0-9]{1,15}$/.test(pin.id)) { log(`hub: tools: entry ${i}: ${entry.source} isn't pinned in tools.lock.json; add it with \`bun run tools add\``); continue }
      dir = join(toolsHomeFor(file), pin.id)
      const head = checkedOutCommit(dir)
      if (!head) { log(`hub: tools: ${pin.id}: no clone in ${dir}; run \`bun run tools add\` again`); continue }
      if (head !== pin.commit) { log(`hub: tools: ${pin.id}: ${dir} is at ${head.slice(0, 12)}, the lock pins ${pin.commit.slice(0, 12)}; skipped`); continue }
    } else dir = resolve(dirname(file), entry.source)
    const mf = join(dir, 'bebop-tool.json')
    if (!existsSync(mf)) { log(`hub: tools: entry ${i}: no bebop-tool.json in ${dir}`); continue }
    try {
      const tool = makeTool(JSON.parse(readFileSync(mf, 'utf8')), entry, dir, opts.hubOrigins)
      if (pin && tool.id !== pin.id) { log(`hub: tools: entry ${i}: the manifest's id "${tool.id}" isn't the pinned "${pin.id}"; skipped`); continue }
      if (pin && tool.manifest.install?.length && pin.installed !== pin.commit) { log(`hub: tools: ${tool.id}: not installed at ${pin.commit.slice(0, 12)}; run \`bun run tools install ${tool.id}\``); continue }
      if (out.some(t => t.id === tool.id)) { log(`hub: tools: entry ${i}: a tool "${tool.id}" is already loaded; skipped`); continue }
      if (entry.run && !tool.manifest.serve?.command) { log(`hub: tools: ${tool.id}: run:true, but the manifest has no serve.command; start it yourself`) }
      if (entry.run && !(entry.port ?? tool.manifest.serve?.port)) { log(`hub: tools: ${tool.id}: run:true needs a port (tools.json "port" or the manifest's serve.port); start it yourself`) }
      tool.entry = entry
      if (pin) tool.commit = pin.commit
      out.push(tool)
      log(`hub: tools: ${tool.id} ${tool.version ?? ''} at ${tool.origin} (${dir}${pin ? ` @ ${pin.commit.slice(0, 12)}` : ''})`.replace(/ {2,}/g, ' '))
    } catch (err) { log(`hub: tools: entry ${i} (${dir}): ${(err as Error).message}`) }
  }
  return out
}

/**
 * Compat: HUB_BOARD_ORIGIN, from before tools, becomes a built-in Board entry that speaks Board's
 * own `board-host` v1 bridge (?host=1). Remove once Board ships bebop-tool.json and is listed in tools.json.
 */
export function boardShim(origin: string, hubOrigins: string[] = []): Tool {
  return makeTool({
    bebop: 1, id: 'board', name: 'Board',
    frame: { url: '/b/{instance}?host=1', link: '/b/{instance}', allow: ['clipboard-write'] },
    instance: { pattern: '^[A-Za-z0-9_-]{6,64}$' },
    ref: ['thread', 'number'],
    agent: { instructions: 'A message with tool="board" was posted from a comment on that topic\'s whiteboard: board_id is the board, board_thread the comment thread, the image is a snapshot of the commented area, and board-context.json (in file_paths) holds the whole thread, the anchor and the shapes near it. Answer with `board reply {board_id} {board_thread} "…"`; ask for a drawing with `board draw {board_id} {board_thread} "brief" [--area x,y,w,h]`.' },
  }, { origin }, undefined, hubOrigins)
}

// ---------- run: true: the hub starts the tool's server and keeps it up ----------

export type SuperviseOptions = {
  /** Where <id>.log (and <id>.pid, to find a server a crashed hub left behind) go. */
  logsDir: string
  /** The hub's origins, given to the tool as BEBOP_HUB_ORIGIN (space-separated) so it lets the hub frame it. */
  hubOrigins: string[]
  log?: (m: string) => void
  /** The environment to filter for a tool (default: the hub's); see toolBaseEnv. */
  baseEnv?: Record<string, string | undefined>
  minBackoffMs?: number
  maxBackoffMs?: number
  /** Healthy this long → the next restart waits minBackoffMs again. */
  resetAfterMs?: number
  /** Health checks: this often until the first answer, then every healthEveryMs. */
  healthStartMs?: number
  healthEveryMs?: number
  /** SIGTERM, then SIGKILL after this long. */
  killAfterMs?: number
}

export type Supervisor = {
  /** true: answering its health check; false: down or starting; null: not supervised. */
  up(id: string): boolean | null
  /** SIGTERM every server (its whole process group), SIGKILL after killAfterMs; resolves when all exited. */
  stop(): Promise<void>
}

/** A tool's log is set aside (as <id>.log.1) when it passes this size at a start. */
const LOG_MAX = 10 * 1024 * 1024

/** What every tool gets from the hub's environment: enough to find its runtime and a home. */
export const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'TZ']
const BASE_ENV_PREFIXES = ['LC_', 'MISE_']
/** Passed only when the manifest says requires.claudeLogin. */
export const CLAUDE_LOGIN_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']

/** The hub's environment for a tool: an allowlist, the manifest's secrets, and the Claude login if it asks. */
export function toolBaseEnv(m: ToolManifest, from: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const keys = new Set([...BASE_ENV_KEYS, ...(m.secrets ?? []), ...(m.requires?.claudeLogin ? CLAUDE_LOGIN_KEYS : [])])
  return Object.fromEntries(Object.entries(from).filter(([k, v]) =>
    v !== undefined && !k.startsWith('HUB_') && (keys.has(k) || BASE_ENV_PREFIXES.some(p => k.startsWith(p)))))
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const killGroup = (pid: number, sig: NodeJS.Signals) => { try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch {} } }
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true } catch { return false } }
/** Something already accepts connections on 127.0.0.1:<port>. */
const portBusy = (port: number) => new Promise<boolean>(done => {
  const s = createConnection({ host: '127.0.0.1', port })
  const end = (busy: boolean) => { s.destroy(); done(busy) }
  s.once('connect', () => end(true)).once('error', () => end(false)).setTimeout(1000, () => end(false))
})

/**
 * Starts serve.command for each tool with `run: true` (argv, no shell) in its folder, in its own
 * process group so stopping it also stops what it started. Restarts it when it exits, waiting
 * 1 s, 2 s, 4 s… up to 60 s, back to 1 s once it has been healthy for a minute. `up` follows
 * GET http://127.0.0.1:<port><serve.health or />. Exposing the port (tailscale serve) stays the
 * operator's job.
 */
export function superviseTools(tools: Tool[], o: SuperviseOptions): Supervisor {
  const log = o.log ?? (() => {})
  const min = o.minBackoffMs ?? 1000, max = o.maxBackoffMs ?? 60_000, resetAfter = o.resetAfterMs ?? 60_000
  const healthStart = o.healthStartMs ?? 1000, healthEvery = o.healthEveryMs ?? 5000, killAfter = o.killAfterMs ?? 5000
  type Run = { tool: Tool; port: number; cmd: string[]; health: string; child: ReturnType<typeof spawn> | null; exited: Promise<void> | null
    backoff: number; up: boolean; healthySince: number | null; timer: ReturnType<typeof setTimeout> | null; checking: boolean }
  const runs = new Map<string, Run>()
  let stopping = false
  mkdirSync(o.logsDir, { recursive: true, mode: 0o700 })

  const logFile = (id: string) => join(o.logsDir, `${id}.log`)
  const pidFile = (id: string) => join(o.logsDir, `${id}.pid`)
  const note = (id: string, m: string) => {
    log(`hub: tools: ${id}: ${m}`)
    try { const fd = openSync(logFile(id), 'a', 0o600); writeSync(fd, `[hub ${new Date().toISOString()}] ${m}\n`); closeSync(fd) } catch {}
  }

  // A server a crashed hub left running still holds the port: stop it first, if the pid is still that command.
  async function reapStale(r: Run) {
    let pid = 0
    try { pid = JSON.parse(readFileSync(pidFile(r.tool.id), 'utf8')).pid } catch { return }
    try { unlinkSync(pidFile(r.tool.id)) } catch {}
    if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return
    const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
    if (!cmd.includes(basename(r.cmd[0]))) return
    note(r.tool.id, `stopping pid ${pid}, left over from an earlier hub`)
    killGroup(pid, 'SIGTERM')
    for (let t = 0; t < killAfter && alive(pid); t += 100) await Bun.sleep(100)
    if (alive(pid)) killGroup(pid, 'SIGKILL')
  }

  async function start(r: Run) {
    r.timer = null
    if (stopping) return
    const id = r.tool.id
    // Another server on the port would answer the health checks in its place.
    if (await portBusy(r.port)) {
      if (stopping) return
      note(id, `port ${r.port} is already in use by another process; not starting (retrying in ${r.backoff / 1000} s)`)
      r.timer = setTimeout(() => start(r), r.backoff)
      r.backoff = Math.min(r.backoff * 2, max)
      return
    }
    if (stopping) return
    try { if (statSync(logFile(id)).size > LOG_MAX) renameSync(logFile(id), logFile(id) + '.1') } catch {}
    const env: Record<string, string | undefined> = {
      ...toolBaseEnv(r.tool.manifest, o.baseEnv ?? process.env),
      BEBOP_HUB_ORIGIN: o.hubOrigins.join(' '),
      ...(r.tool.entry?.env ?? {}),
      PORT: String(r.port),
      BEBOP_TOOL_ID: id,
    }
    note(id, `starting ${JSON.stringify(r.cmd)} in ${r.tool.dir} (PORT=${r.port})`)
    let fd: number | null = null
    try {
      fd = openSync(logFile(id), 'a', 0o600)
      const child = spawn(r.cmd[0], r.cmd.slice(1), { cwd: r.tool.dir, env, stdio: ['ignore', fd, fd], detached: true })
      r.child = child
      r.exited = new Promise(done => {
        let gone = false
        const exit = (why: string) => {
          if (gone) return
          gone = true
          // Whatever it started dies with it, so a restart finds the port free.
          if (child.pid && !stopping && groupAlive(child.pid)) killGroup(child.pid, 'SIGTERM')
          r.child = null; r.up = false; r.healthySince = null
          try { unlinkSync(pidFile(id)) } catch {}
          if (stopping) { note(id, `stopped (${why})`); return done() }
          note(id, `exited (${why}); restarting in ${r.backoff / 1000} s`)
          r.timer = setTimeout(() => start(r), r.backoff)
          r.backoff = Math.min(r.backoff * 2, max)
          done()
        }
        child.once('error', e => exit((e as Error).message))
        child.once('exit', (code, sig) => exit(sig ? `signal ${sig}` : `code ${code}`))
      })
      if (child.pid) writeFileSync(pidFile(id), JSON.stringify({ pid: child.pid, cmd: r.cmd }) + '\n', { mode: 0o600 })
    } catch (e) {
      note(id, `can't start: ${(e as Error).message}; retrying in ${r.backoff / 1000} s`)
      r.timer = setTimeout(() => start(r), r.backoff)
      r.backoff = Math.min(r.backoff * 2, max)
    } finally { if (fd !== null) closeSync(fd) }
    check(r)
  }

  async function check(r: Run) {
    if (stopping || !r.child || r.checking) return
    const child = r.child
    r.checking = true
    let ok = false
    try { ok = (await fetch(`http://127.0.0.1:${r.port}${r.health}`, { signal: AbortSignal.timeout(2000), redirect: 'manual' })).status < 400 } catch {}
    r.checking = false
    if (stopping || r.child !== child) return
    const now = Date.now()
    if (ok && !r.up) { r.up = true; r.healthySince = now; note(r.tool.id, `up on port ${r.port}`) }
    else if (!ok && r.up) { r.up = false; r.healthySince = null; note(r.tool.id, `not answering ${r.health}`) }
    if (ok && r.healthySince !== null && now - r.healthySince >= resetAfter) r.backoff = min
    setTimeout(() => check(r), r.up || r.healthySince !== null ? healthEvery : healthStart)
  }

  for (const tool of tools) {
    const cmd = tool.manifest.serve?.command, port = tool.entry?.port ?? tool.manifest.serve?.port
    if (!tool.entry?.run || !cmd || !port || !tool.dir) continue
    const health = tool.manifest.serve?.health?.startsWith('/') ? tool.manifest.serve.health : '/'
    const r: Run = { tool, port, cmd, health, child: null, exited: null, backoff: min, up: false, healthySince: null, timer: null, checking: false }
    runs.set(tool.id, r)
    reapStale(r).then(() => start(r))
  }

  return {
    up: id => runs.has(id) ? runs.get(id)!.up : null,
    async stop() {
      stopping = true
      await Promise.all([...runs.values()].map(async r => {
        if (r.timer) clearTimeout(r.timer)
        const child = r.child
        const pid = child?.pid
        if (!pid) return
        killGroup(pid, 'SIGTERM')
        // The group (the server and what it started) has killAfter to exit, then SIGKILL.
        const deadline = Date.now() + killAfter
        while ((r.child === child || groupAlive(pid)) && Date.now() < deadline) await Bun.sleep(50)
        if (r.child === child || groupAlive(pid)) { note(r.tool.id, `still running ${killAfter / 1000} s after SIGTERM; SIGKILL`); killGroup(pid, 'SIGKILL') }
        await r.exited
      }))
    },
  }
}
