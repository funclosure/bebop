// Bebop hub: one HTTP server, two sides.
//   user side  (/, /api/*, /files/*)  authenticated by tailscale serve's login header
//   agent side (/agent/*)             authenticated by a bearer token in data/agent.token
import type { Server } from 'bun'
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, statSync, chmodSync, rmSync, realpathSync, renameSync } from 'fs'
import { open } from 'fs/promises'
import { join, extname, basename, normalize, isAbsolute, relative, sep } from 'path'
import { randomBytes, timingSafeEqual, createHash } from 'crypto'
import { openDb, INBOUND, type MessageRow, type FileRow, type Sender } from './db'
import { videoSize, type Size } from './media'
import { parseAt, parseRepeat, nextDue, localIso, type TimerRow } from './clock'
import { markParams, markShapes, markSvg, hash } from '../web/mark.js'
import { rasterize, encodePng } from './raster'
import { boundaryOf, streamMultipart } from './multipart'
import { loadVapid, sendPushToAll, type PushPayload } from './push'
import { iconResolver, type IconSource } from './icons'
import { homedir, tmpdir } from 'os'
import { findTranscript, readTranscript } from './transcript'
import { createShells, loadShellsConfig, riskOf, ShellError, type Shells, type ShellBackend } from './shells'
import { herdrProvider, rexProvider, rexShellBackend, herdrShellBackend, combinedProvider, createPaneWatcher, PaneError, stripAnsi, PANE_KEYS, PANE_MAX_KEYS, PANE_PROMPT_MAX, PANE_TEXT_BAD, type PaneProvider, type Pane } from './panes'
import { runTranscriber } from './transcribe'
import { createLock, type LockOptions } from './lock'
import { updateChecker, roleFromSoul, modelLabel, tilde, companionFiles, readCompanionFile, validFolder, type CompanionInfo } from './companion'
import { loadTools, boardShim, instanceIdFor, toolUrls, OVERVIEW_PAGE, DESK, toolInstructions, superviseTools, type Tool, type SuperviseOptions } from './tools'

/** A peer's name: letters and digits in any script, _ . and -; as web/term.js validPeer. */
const PEER_NAME = /^[\p{L}\p{M}\p{N}_.-]{1,64}$/u

export type HubOptions = {
  dataDir: string
  port?: number
  hostname?: string
  allowedLogins?: string[]
  agentName?: string
  maxUploadMB?: number
  vapidSubject?: string
  webDir?: string
  /** Shell template with {in} and {out}; unset = voice notes are delivered without a transcript. */
  transcribeCmd?: string
  transcribeTimeoutMs?: number
  /** Shell template with {in} (a transcript) and {out} (a prompt): turns dictation's refine step on. */
  refineCmd?: string
  refineTimeoutMs?: number
  /** A non-idle presence falls back to idle after this long without an update (default 10 min). */
  presenceTtlMs?: number
  /** How long a message handed to a watcher waits for a sign of life before it's offered again (default 2 min). */
  redeliverMs?: number
  /** Path to the herdr binary: turns panes on (v0.6). Unset = /api/panes* are 404. */
  herdrBin?: string
  /** Passed to herdr as HERDR_SOCKET_PATH. */
  herdrSocket?: string
  /** Path to the Rex CLI: its agent sessions join herdr's (or stand alone). */
  rexBin?: string
  /** The tools file (see tools.ts; default <dataDir>/tools.json). */
  toolsFile?: string
  /** The origins the app is reached at from outside (HUB_PUBLIC_ORIGIN, e.g. the tailscale serve URL). Given to tools as BEBOP_HUB_ORIGIN; no tool may use one. */
  publicOrigins?: string[]
  /** Tests: the run:true supervisor's timing (see superviseTools). */
  toolRun?: Partial<Pick<SuperviseOptions, 'minBackoffMs' | 'maxBackoffMs' | 'resetAfterMs' | 'healthStartMs' | 'healthEveryMs' | 'killAfterMs' | 'baseEnv'>>
  /** Compat (HUB_BOARD_ORIGIN): a Board server that speaks board-host v1, loaded as a built-in "board" tool. */
  boardOrigin?: string
  /** The agent's id, given to tools (Board's answerer; default the agent name in lowercase). */
  agentId?: string
  /** The user's name, for places that show it to others (a tool's posts, a board's comments). */
  userName?: string
  /** Tests: the Bebop checkout Settings checks for updates (default the hub's own) and how often. */
  checkout?: { dir?: string; everyMs?: number }
  /** Folders a peer's `path` may be inside for its icon to be read (default the home folder; HUB_ICON_ROOTS). Terminals open only inside them too. */
  iconRoots?: string[]
  /** Tests: replaces the default icon sources. */
  iconSources?: IconSource[]
  /** Tests: a pane provider in place of herdr, and the watcher's timing. */
  paneProvider?: PaneProvider
  paneTiming?: { fastMs?: number; slowMs?: number; pushGapMs?: number; now?: () => number }
  /** HUB_SHELLS: plain shells on demand in any project's folder, and terminals shared from the app
   *  (hub/shells.ts). `on` opens new ones in Rex if there is one, else herdr; `rex` / `herdr` picks. */
  shells?: 'on' | 'rex' | 'herdr' | false
  /** Optional, default <dataDir>/shells.json: `{ "projects": { "<key>": "<folder>" }, "deny": ["<key>"] }`. */
  shellsFile?: string
  /** Tests: the multiplexers' side of shells (the first opens new ones), and the lock checks they use. */
  shellBackends?: ShellBackend[]
  shellAuth?: { lockOn(): boolean; steppedUp(req: Request): boolean }
  /** Claude Code's config folder, for a session's transcript (default $CLAUDE_CONFIG_DIR or ~/.claude). */
  claudeDir?: string
  /** Passkey lock timing and relying party (see lock.ts). */
  lock?: LockOptions
  /** Tests: replaces Web Push delivery. */
  sendPush?: (payload: PushPayload) => void
  log?: (msg: string) => void
}

const REACTION_EMOJI_MAX = 16
const USER_KINDS = new Set(['text', 'voice', 'answer', 'reaction'])
const AGENT_KINDS = new Set(['text', 'progress', 'question', 'approval'])
// Search filters by attachment: a condition on the file's mime (fl.mime), fixed SQL only.
const SEARCH_TYPES: Record<string, string> = {
  photo: `fl.mime LIKE 'image/%'`, video: `fl.mime LIKE 'video/%'`, audio: `fl.mime LIKE 'audio/%'`,
  file: `fl.mime NOT LIKE 'image/%' AND fl.mime NOT LIKE 'video/%' AND fl.mime NOT LIKE 'audio/%'`,
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const err = (status: number, message: string) => json({ error: message }, status)

type SSEClient = { send(event: string, data: unknown, id?: number): void; close(): void }

function sseStream(server: Server<unknown>, req: Request, onOpen: (c: SSEClient) => void, onClose: (c: SSEClient) => void): Response {
  server.timeout(req, 0)
  const enc = new TextEncoder()
  let client: SSEClient
  let ping: ReturnType<typeof setInterval>
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      client = {
        send(event, data, id) {
          if (closed) return
          try {
            controller.enqueue(enc.encode(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch { closed = true }
        },
        close() { closed = true; try { controller.close() } catch {} },
      }
      controller.enqueue(enc.encode('retry: 2000\n: hello\n\n'))
      ping = setInterval(() => { try { controller.enqueue(enc.encode(': ping\n\n')) } catch { clearInterval(ping) } }, 20000)
      onOpen(client)
    },
    cancel() { clearInterval(ping); onClose(client) },
  })
  req.signal.addEventListener('abort', () => { clearInterval(ping); onClose(client) })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' },
  })
}

const safeExt = (name: string) => {
  const e = extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '')
  return e.length > 1 && e.length <= 10 ? e : ''
}
const newId = () => randomBytes(12).toString('base64url')

const TOOL_REF_TEXT_MAX = 200

// A note telling the agent the user moved or cancelled a timer: delivered, never shown in the app.
const HIDDEN_TIMER_NOTE = `NOT (kind = 'timer' AND json_extract(body_json, '$.change') IS NOT NULL)`

const snippet = (s: unknown, n: number) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim().slice(0, n)

export function createHub(opts: HubOptions) {
  const log = opts.log ?? ((m: string) => console.log(m))
  const dataDir = opts.dataDir
  const filesDir = join(dataDir, 'files')
  mkdirSync(filesDir, { recursive: true, mode: 0o700 })
  const db = openDb(join(dataDir, 'hub.sqlite'), log)
  const vapid = loadVapid(join(dataDir, 'vapid.json'))
  const vapidSubject = opts.vapidSubject ?? 'mailto:bebop@example.com'
  const agentName = opts.agentName ?? 'Bebop'
  const allowed = (opts.allowedLogins ?? []).filter(Boolean)
  const maxUpload = (opts.maxUploadMB ?? 2048) * 1024 * 1024
  const webDir = opts.webDir ?? join(import.meta.dir, '..', 'web')
  // The code this hub runs: its checkout's commit when it started, so a tool can tell whether
  // the running hub is older than the checkout (and needs a restart).
  const codeVersion = (() => {
    try {
      const r = Bun.spawnSync(['git', '-C', join(import.meta.dir, '..'), 'rev-parse', '--short', 'HEAD'], { stderr: 'ignore' })
      return r.exitCode === 0 ? r.stdout.toString().trim() || null : null
    } catch { return null }
  })()
  const agentId = (opts.agentId ?? agentName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent'

  // ---------- tools (see tools.ts): loaded once at start; the hub never installs one ----------
  const port = opts.port ?? 8787
  const publicOrigins = (opts.publicOrigins ?? []).map(o => { try { return new URL(o).origin } catch { return null } }).filter((o): o is string => !!o && o !== 'null')
  const hubOrigins = [...publicOrigins, ...(port ? [`http://127.0.0.1:${port}`, `http://localhost:${port}`] : [])]
  const tools = new Map<string, Tool>()
  for (const t of loadTools(opts.toolsFile ?? join(dataDir, 'tools.json'), { hubOrigins, log })) tools.set(t.id, t)
  if (opts.boardOrigin) {
    if (tools.has('board')) log('hub: HUB_BOARD_ORIGIN ignored: tools.json lists a "board" tool')
    else {
      try {
        tools.set('board', boardShim(opts.boardOrigin, hubOrigins))
        log('hub: HUB_BOARD_ORIGIN is deprecated: list Board in tools.json instead (see README, Tools)')
      } catch (e) { log(`hub: HUB_BOARD_ORIGIN ${opts.boardOrigin}: ${(e as Error).message}; boards are off`) }
    }
  }

  // run: true → the hub starts and watches the tool's server (started once the hub listens).
  let supervisor: ReturnType<typeof superviseTools> | null = null

  const tokenFile = join(dataDir, 'agent.token')
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  try { chmodSync(tokenFile, 0o600) } catch {}
  const agentToken = readFileSync(tokenFile, 'utf8').trim()
  const lock = createLock(db, { rpName: opts.agentName ?? 'Bebop', ...opts.lock })

  if (allowed.length === 0) log('hub: HUB_ALLOWED_LOGINS is not set: dev mode, allowing direct localhost requests without a Tailscale login header')

  const userClients = new Set<SSEClient>()
  const agentClients = new Map<SSEClient, Set<number>>()

  // ---------- queries ----------
  const q = {
    insert: db.query(`INSERT INTO messages (ts, sender, source, thread, kind, body_json, reply_to, login, client_id, source_project)
      VALUES ($ts, $sender, $source, $thread, $kind, $body, $reply_to, $login, $client_id, $source_project) RETURNING *`),
    get: db.query('SELECT * FROM messages WHERE id = ?'),
    byClientId: db.query('SELECT * FROM messages WHERE client_id = ?'),
    setBody: db.query('UPDATE messages SET body_json = ?, edited_at = ? WHERE id = ?'),
    // A voice note waiting for its transcript is held back from the agent.
    undelivered: db.query(`SELECT * FROM messages WHERE ${INBOUND} AND delivered_at IS NULL
      AND NOT (kind = 'voice' AND json_extract(body_json, '$.transcript_status') = 'pending') ORDER BY id`),
    file: db.query('SELECT * FROM files WHERE id = ?'),
    insertFile: db.query('INSERT INTO files (id, name, mime, size, path, ts) VALUES (?, ?, ?, ?, ?, ?)'),
    unindex: db.query('DELETE FROM messages_fts WHERE rowid = ?'),
    index: db.query('INSERT INTO messages_fts (rowid, body) VALUES (?, ?)'),
    meta: db.query('SELECT * FROM thread_meta WHERE id = ?'),
    putMeta: db.query('INSERT INTO thread_meta (id, title, state, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, state = excluded.state, updated = excluded.updated'),
    putTopic: db.query('INSERT INTO thread_meta (id, title, lane, detail, history, project, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, lane = excluded.lane, detail = excluded.detail, history = excluded.history, project = excluded.project, closed = NULL, updated = MAX(COALESCE(updated, 0), COALESCE(excluded.updated, 0))'),
    unarchive: db.query(`UPDATE thread_meta SET state = NULL WHERE id = ? AND state = 'archived'`),
  }
  const getMsg = (id: number) => q.get.get(id) as MessageRow | null
  const getFile = (id: string) => q.file.get(id) as FileRow | null
  const bodyOf = (r: MessageRow) => JSON.parse(r.body_json)

  function reactionsFor(ids: number[]): Map<number, { emoji: string; sender: string }[]> {
    const out = new Map<number, { emoji: string; sender: string }[]>()
    if (!ids.length) return out
    const rows = db.query(`SELECT sender, json_extract(body_json, '$.to') AS target, json_extract(body_json, '$.emoji') AS emoji
      FROM messages WHERE kind = 'reaction' AND json_extract(body_json, '$.to') IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ids) as { sender: string; target: number; emoji: string }[]
    // One reaction per sender per message; the latest wins, '' clears it.
    const latest = new Map<string, { target: number; sender: string; emoji: string }>()
    for (const r of rows) latest.set(`${r.target}:${r.sender}`, r)
    for (const r of latest.values()) {
      if (!r.emoji) continue
      if (!out.has(r.target)) out.set(r.target, [])
      out.get(r.target)!.push({ emoji: r.emoji, sender: r.sender })
    }
    return out
  }

  // A video's size (w, h) from its file, read once per file and kept for the hub's life: the app
  // gives the video its shape before it loads, so the list doesn't move when it does.
  const videoSizes = new Map<string, Size | null>()
  const sizeOf = (f: FileRow) => {
    if (!f.mime.startsWith('video/')) return null
    if (!videoSizes.has(f.id)) videoSizes.set(f.id, videoSize(f.path, f.mime))
    return videoSizes.get(f.id)!
  }
  const fileMeta = (f: FileRow) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, ...sizeOf(f) })

  /** The public (user-side) shape of a message. */
  function present(rows: MessageRow[]) {
    const reactions = reactionsFor(rows.map(r => r.id))
    const projectOfSource = rows.some(r => r.sender === 'agent' && r.source && !r.source_project) ? sourceProjects() : null
    return rows.map(r => {
      const body = bodyOf(r)
      const files = Array.isArray(body.files) ? body.files.map(getFile).filter(Boolean).map(fileMeta) : []
      let reply_preview = null
      if (r.reply_to) {
        const t = getMsg(r.reply_to)
        if (t) {
          const tb = bodyOf(t)
          reply_preview = { id: t.id, sender: t.sender, kind: t.kind, text: snippet(tb.text ?? tb.prompt ?? tb.transcript ?? tb.questions?.[0]?.prompt ?? (tb.files?.length ? 'Attachment' : ''), 160) }
        }
      }
      return {
        id: r.id, ts: r.ts, sender: r.sender, source: r.source, thread: r.thread, kind: r.kind, body,
        reply_to: r.reply_to, reply_preview, edited_at: r.edited_at, files,
        reactions: reactions.get(r.id) ?? [],
        // The sender line: the project of the session the agent passed this on from, if the hub can tell.
        ...(r.sender === 'agent' && r.source ? { from_project: r.source_project ?? projectOfSource?.(r.source) ?? null } : {}),
        ...(r.client_id ? { client_id: r.client_id } : {}),
      }
    })
  }

  /**
   * The project of a session the agent names as a message's source, for the sender line. In order:
   * the session in the agent's peers list (its own project, so "Rōnin" finds notes-app); else the
   * name without Claude Code's two-character suffix ("notes-app-6e" → notes-app), the name itself,
   * or the part before a bracket ("Notes App (sim)" → Notes App), if a peer, a topic or the projects table
   * knows that project. Case and accents don't count ("Ronin" is "Rōnin"). Else null: the app then shows
   * the name as given, never the topic's project, which could name the wrong sender.
   */
  function sourceProjects(): (source: string) => string | null {
    const norm = (x: string) => x.replace(/^@/, '').trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    const peers = new Map<string, string>()
    for (const p of db.query('SELECT name, project FROM peers WHERE project IS NOT NULL').all() as { name: string; project: string }[]) peers.set(norm(p.name), p.project)
    const known = new Map<string, string>()
    const names = db.query(`SELECT project AS name FROM peers WHERE project IS NOT NULL UNION ALL SELECT project FROM thread_meta WHERE project IS NOT NULL
      UNION ALL SELECT name FROM projects`).all() as { name: string }[]
    for (const { name } of names) if (name && !known.has(norm(name))) known.set(norm(name), name)
    return source => {
      const s = norm(source)
      if (!s) return null
      const peer = peers.get(s)
      if (peer) return peer
      const base = s.replace(/-[0-9a-f]{2}$/, ''), head = s.replace(/\s*\(.*$/, '')
      return (base !== s ? known.get(base) : null) ?? known.get(s) ?? (head && head !== s ? peers.get(head) ?? known.get(head) : null) ?? null
    }
  }

  /** What the agent receives for a user message. Includes local file paths. */
  function forAgent(r: MessageRow) {
    const body = bodyOf(r)
    const files = Array.isArray(body.files)
      ? body.files.map(getFile).filter(Boolean).map((f: FileRow) => ({ ...fileMeta(f), path: f.path }))
      : []
    const out: Record<string, unknown> = {
      id: r.id, ts: r.ts, sender: r.sender, kind: r.kind, thread: r.thread, reply_to: r.reply_to, body, files,
    }
    // Only the user's own messages carry a user. A peer's note says which project's token sent it.
    if (r.sender === 'user') out.user = r.login ?? 'user'
    if (r.sender === 'peer') out.from = { project: r.source }
    if (redelivered.has(r.id)) out.redelivered = true
    if (r.reply_to) {
      const t = getMsg(r.reply_to)
      if (t) { const tb = bodyOf(t); out.reply_to_text = snippet(tb.text ?? tb.prompt ?? tb.transcript ?? '', 300) }
    }
    if ((r.kind === 'answer' || r.kind === 'reaction') && typeof body.to === 'number') {
      const t = getMsg(body.to)
      if (t) out.target = { id: t.id, kind: t.kind, sender: t.sender, thread: t.thread, body: bodyOf(t) }
    }
    return out
  }

  const broadcastUser = (event: string, data: unknown) => { for (const c of userClients) c.send(event, data) }

  // Received means read. A watcher (channel/watch.ts) only hands messages over: it prints them
  // and exits, and the session reads its output later, if it's still alive. So /agent/handed
  // just notes the hand-off; the agent's next sign of life (a hook's presence, a reply, any
  // other agent POST; never a stream connecting) marks them delivered. One not confirmed within
  // redeliverMs is offered again, flagged redelivered. In memory: after a hub restart they're
  // simply offered again. A channel running inside the session acks directly (/agent/ack).
  const redeliverMs = opts.redeliverMs ?? 2 * 60_000
  const handed = new Map<number, number>()      // message id → when a watcher got it
  const redelivered = new Set<number>()
  function confirmHanded() {
    if (!handed.size) return
    const ids = [...handed.keys()]
    handed.clear()
    for (const id of ids) redelivered.delete(id)
    db.query(`UPDATE messages SET delivered_at = ? WHERE ${INBOUND} AND delivered_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(Date.now(), ...ids)
  }
  const redeliverTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, at] of handed) {
      if (now - at < redeliverMs) continue
      handed.delete(id)
      const r = getMsg(id)
      if (!r || r.delivered_at != null) continue
      redelivered.add(id)
      log(`hub: message ${id} wasn't confirmed within ${Math.round(redeliverMs / 1000)} s of its hand-off; offering it again`)
      // Streams open now (one started after the hand-off skipped it) get it.
      for (const sent of agentClients.values()) sent.delete(id)
      deliverToAgents(r)
    }
  }, Math.max(50, Math.min(15_000, redeliverMs / 4)))

  function deliverToAgents(r: MessageRow) {
    const payload = forAgent(r)
    for (const [c, sent] of agentClients) {
      if (sent.has(r.id)) continue
      sent.add(r.id)
      c.send('message', payload, r.id)
    }
  }

  function insert(m: { sender: Sender; kind: string; body: unknown; thread?: string | null; source?: string | null; reply_to?: number | null; login?: string | null; client_id?: string | null }): MessageRow {
    const source = m.source ?? null
    const row = q.insert.get({
      ts: Date.now(), sender: m.sender, source, thread: m.thread ?? null, kind: m.kind,
      body: JSON.stringify(m.body), reply_to: m.reply_to ?? null, login: m.login ?? null, client_id: m.client_id ?? null,
      source_project: m.sender === 'agent' && source ? sourceProjects()(source) : null,
    }) as MessageRow
    if (row.kind !== 'reaction') {
      indexMsg(row)
      // A new message in an archived thread brings it back. A reaction is not a new message, and
      // a peer's note or a timer is not one for the user: they stay quiet.
      if (row.thread && (row.sender === 'user' || row.sender === 'agent') && q.unarchive.run(row.thread).changes) broadcastUser('threads', threads())
      if (row.sender === 'agent') setFocus(row.thread)
    }
    return row
  }

  /** Every body change goes through here, so the search index follows edits and answers. */
  function saveBody(id: number, body: unknown, edited: number | null) {
    q.setBody.run(JSON.stringify(body), edited, id)
    indexMsg(getMsg(id)!)
  }

  // ---------- search index ----------
  // Markdown is flattened ([label](url) → "label url", no emphasis marks) so a snippet reads
  // as text (underscores stay: they are often part of a name). Answers and reactions are not indexed: they point at messages that are.
  const flat = (s: unknown) => (typeof s === 'string' ? s : '')
    .replace(/!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, '$1 $2').replace(/\*{1,3}|`+|~~/g, '').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
  function searchText(r: MessageRow): string {
    if (r.kind === 'answer' || r.kind === 'reaction') return ''
    const b = bodyOf(r)
    if (r.kind === 'timer' && b.change) return '' // a note to the agent that the user moved or cancelled a timer
    const parts: unknown[] = [b.text, b.transcript, b.prompt, b.detail]
    for (const qq of Array.isArray(b.questions) ? b.questions : []) {
      parts.push(qq.header, qq.prompt)
      for (const o of Array.isArray(qq.options) ? qq.options : []) parts.push(o.label, o.description)
    }
    for (const f of Array.isArray(b.files) ? b.files : []) parts.push(getFile(f)?.name)
    return parts.map(flat).filter(Boolean).join('\n')
  }
  function indexMsg(r: MessageRow) {
    q.unindex.run(r.id)
    if (r.kind !== 'reaction') q.index.run(r.id, searchText(r))
  }
  // Rows from before the index existed (or written by an older hub): index them once.
  {
    const missing = db.query(`SELECT * FROM messages WHERE kind != 'reaction' AND id NOT IN (SELECT rowid FROM messages_fts)`).all() as MessageRow[]
    if (missing.length) {
      db.transaction(() => { for (const r of missing) indexMsg(r) })()
      log(`hub: search index: added ${missing.length} message(s)`)
    }
  }

  function sendPush(payload: PushPayload) {
    if (opts.sendPush) return opts.sendPush(payload)
    void sendPushToAll(db, vapid, vapidSubject, payload).then(res => {
      if (res.removed) log(`push: removed ${res.removed} expired subscription(s)`)
    })
  }
  const pushFor = (r: MessageRow, text: string) =>
    sendPush({ title: r.source ?? agentName, body: snippet(text, 120) || 'New message', thread: r.thread, id: r.id })

  const pushText = (kind: string, body: any) =>
    kind === 'question' ? (body.questions?.map((x: any) => x.prompt).join(' · ') ?? 'Question')
    : kind === 'approval' ? body.prompt
    : kind === 'progress' ? `Done: ${body.text ?? ''}`
    : body.text || (body.files?.length ? `${body.files.length} attachment(s)` : '')

  function copyLocalFile(p: unknown): string {
    if (typeof p !== 'string' || !isAbsolute(p)) throw new Error(`file must be an absolute path: ${p}`)
    const st = statSync(p)
    if (!st.isFile()) throw new Error(`not a file: ${p}`)
    const id = newId()
    const name = basename(p)
    const dest = join(filesDir, id + safeExt(name))
    copyFileSync(p, dest)
    const mime = Bun.file(p).type.split(';')[0] || 'application/octet-stream'
    q.insertFile.run(id, name, mime, st.size, dest, Date.now())
    return id
  }

  // ---------- auth ----------
  function userAuth(req: Request, server: Server<unknown>): string | Response {
    const login = req.headers.get('tailscale-user-login')
    if (allowed.length) {
      if (login && allowed.includes(login)) return login
      return err(403, 'forbidden')
    }
    const ip = server.requestIP(req)?.address ?? ''
    const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
    if (!login && local) return 'local'
    return err(403, 'forbidden')
  }

  function agentAuth(req: Request): boolean {
    // Requests that came through tailscale serve carry a login header: those are users, never the agent.
    if (req.headers.has('tailscale-user-login')) return false
    const h = req.headers.get('authorization') ?? ''
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7).trim() : '')
    const want = Buffer.from(agentToken)
    return given.length === want.length && timingSafeEqual(given, want)
  }

  // ---------- user handlers ----------
  async function postUserMessage(req: Request, login: string): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    if (!b || !USER_KINDS.has(b.kind)) return err(400, 'kind must be text, answer or reaction')
    const client_id = typeof b.client_id === 'string' ? b.client_id.slice(0, 64) : null
    if (client_id) {
      const dup = q.byClientId.get(client_id) as MessageRow | null
      if (dup) return json(present([dup])[0])
    }
    let thread: string | null = typeof b.thread === 'string' && b.thread ? b.thread.slice(0, 200) : null
    const reply_to = Number.isInteger(b.reply_to) ? b.reply_to : null
    if (reply_to && !getMsg(reply_to)) return err(400, 'reply_to not found')
    if (!thread && reply_to) thread = getMsg(reply_to)!.thread

    if (b.kind === 'text') {
      const text = typeof b.text === 'string' ? b.text : ''
      const files = Array.isArray(b.files) ? b.files.filter((f: unknown) => typeof f === 'string') : []
      if (!text.trim() && !files.length) return err(400, 'empty message')
      for (const f of files) if (!getFile(f)) return err(400, `unknown file ${f}`)
      const body: any = files.length ? { text, files } : { text }
      // Dictated: the text came from a voice note (one of the files) and may be refined.
      if (b.dictation && typeof b.dictation.file === 'string' && files.includes(b.dictation.file))
        body.dictation = { file: b.dictation.file, refined: !!b.dictation.refined }
      // Posted from a tool beside the topic: which tool and instance, and the tool's own refs, so the agent can answer there.
      // A project tool's post goes into the topic its page belongs to.
      const placed = toolRef(b.tool, thread) ?? legacyBoardRef(b.board, thread)
      if (placed && 'error' in placed) return err(400, placed.error)
      if (placed) { body.tool = placed.ref; thread = placed.thread }
      const row = insert({ sender: 'user', kind: 'text', body, thread, reply_to, login, client_id })
      broadcastUser('message', present([row])[0])
      deliverToAgents(row)
      return json(present([row])[0], 201)
    }

    if (b.kind === 'voice') {
      const file = typeof b.files?.[0] === 'string' ? getFile(b.files[0]) : null
      if (!file) return err(400, 'voice needs files:[audio file id]')
      const duration = Number.isFinite(b.duration) && b.duration >= 0 ? Math.round(b.duration * 10) / 10 : null
      const body = { files: [file.id], duration, transcript: null, transcript_status: transcribeCmd ? 'pending' : 'off' }
      const row = insert({ sender: 'user', kind: 'voice', body, thread, reply_to, login, client_id })
      broadcastUser('message', present([row])[0])
      if (transcribeCmd) void transcribe(row.id)
      else deliverToAgents(row)
      return json(present([row])[0], 201)
    }

    const target = Number.isInteger(b.to) ? getMsg(b.to) : null
    if (!target) return err(400, 'target message not found')

    if (b.kind === 'reaction') {
      const emoji = typeof b.emoji === 'string' ? b.emoji.slice(0, REACTION_EMOJI_MAX) : ''
      const row = insert({ sender: 'user', kind: 'reaction', body: { to: target.id, emoji }, thread: target.thread, login, client_id })
      broadcastUser('reaction', { to: target.id, reactions: reactionsFor([target.id]).get(target.id) ?? [] })
      deliverToAgents(row)
      return json({ id: row.id }, 201)
    }

    // answer
    if (target.sender !== 'agent' || (target.kind !== 'question' && target.kind !== 'approval')) return err(400, 'can only answer a question or approval')
    const tb = bodyOf(target)
    // A card takes one outcome: the first answer, dismissal or resolve to land wins.
    if (tb.answered != null) return err(409, 'already answered')
    if (tb.resolved) return err(409, 'already closed')
    // Dismissed: the user closed the card without answering. Approves nothing, so no Face ID.
    if (b.dismiss === true) {
      tb.resolved = { by: 'user', at: Date.now() }
      saveBody(target.id, tb, target.edited_at)
      const row = insert({ sender: 'user', kind: 'answer', body: { to: target.id, dismissed: true }, thread: target.thread, reply_to: null, login, client_id })
      broadcastUser('update', present([getMsg(target.id)!])[0])
      broadcastUser('message', present([row])[0])
      deliverToAgents(row)
      return json(present([row])[0], 201)
    }
    // An approval gates a risky action: it needs a fresh Face ID even while unlocked.
    if (target.kind === 'approval' && !lock.steppedUp(req)) return err(403, 'stepup required')
    const answers = b.answers
    if (!answers || typeof answers !== 'object') return err(400, 'answers required')
    if (target.kind === 'question') {
      for (const qq of tb.questions ?? []) {
        const a = answers[qq.id]
        const ok = (Array.isArray(a) && a.length && a.every((x: unknown) => typeof x === 'string')) || (a && typeof a.other === 'string' && a.other.trim())
        if (!ok) return err(400, `missing answer for ${qq.id}`)
      }
      tb.answered = answers
    } else {
      const a = answers.approval
      if (Array.isArray(a) && typeof a[0] === 'string') tb.answered = a[0]
      else if (a && typeof a.other === 'string') { tb.answered = 'Other'; tb.answered_note = a.other }
      else return err(400, 'answers.approval required')
    }
    saveBody(target.id, tb, target.edited_at)
    const row = insert({ sender: 'user', kind: 'answer', body: { to: target.id, answers }, thread: target.thread, reply_to: null, login, client_id })
    broadcastUser('update', present([getMsg(target.id)!])[0])
    broadcastUser('message', present([row])[0])
    deliverToAgents(row)
    return json(present([row])[0], 201)
  }

  // A tool's ref on a message: a loaded tool, the instance this topic (or project) has for it, and
  // only the keys its manifest lists (strings or numbers). For a topic tool anything else is dropped
  // and the message still goes. A project tool's post must name a page of its project ({error} if
  // not): it goes into that page's topic.
  type ToolRef = { id: string; instance: string; ref: Record<string, string | number>; link?: string }
  type Placed = { ref: ToolRef; thread: string | null } | { error: string }
  function toolRef(x: any, thread: string | null): Placed | null {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || typeof x.instance !== 'string') return null
    const tool = tools.get(x.id)
    if (!tool || !tool.pattern.test(x.instance)) return null
    const given = x.ref && typeof x.ref === 'object' && !Array.isArray(x.ref) ? x.ref : {}
    if (tool.scope === 'project') {
      const inst = db.query(`SELECT scope_key FROM tool_instances WHERE tool = ? AND scope = 'project' AND instance = ?`).get(tool.id, x.instance) as { scope_key: string } | null
      if (!inst) return { error: `not an instance of ${tool.id}` }
      // A post without a page (an older tool) counts as from the topic it was sent in.
      const page = typeof given.page === 'string' && given.page ? given.page.slice(0, 200) : thread
      if (!page) return { error: 'page required' }
      const to = pageThread(tool, inst.scope_key, page)
      if (!to) return { error: 'page not in this project' }
      thread = to
      given.page = page
    } else {
      if (!thread) return null
      // A tool posts only into its own topic.
      const cur = db.query(`SELECT instance FROM tool_instances WHERE tool = ? AND scope = 'topic' AND scope_key = ?`).get(tool.id, thread) as { instance: string } | null
      if (cur?.instance !== x.instance) return null
    }
    const ref: Record<string, string | number> = {}
    for (const k of tool.ref) {
      const v = given[k]
      if (typeof v === 'string' && v) ref[k] = v.slice(0, TOOL_REF_TEXT_MAX)
      else if (typeof v === 'number' && Number.isFinite(v)) ref[k] = v
    }
    const out: ToolRef = { id: tool.id, instance: x.instance, ref }
    if (typeof x.link === 'string' && x.link.length <= 500) {
      try { if (new URL(x.link).origin === tool.origin) out.link = x.link } catch {}
    }
    return { ref: out, thread }
  }
  // Compat: an app from before tools posts `board: {id, thread, number, link}`.
  function legacyBoardRef(x: any, thread: string | null): Placed | null {
    if (!x || typeof x !== 'object') return null
    return toolRef({ id: 'board', instance: x.id, ref: { thread: x.thread, number: x.number }, link: x.link }, thread)
  }

  // ---------- tool instances and pages ----------
  // A topic tool has an instance per topic; a project tool one per project key (the project name in
  // lowercase, as the app's projectKey; topics with no project share "desk"), opened at a page.
  /** A topic's project key: its project, a project conversation's id, or the project whose overview topic it is. */
  function projectOf(thread: string): string | null {
    const m = q.meta.get(thread) as { project: string | null } | null
    if (m?.project) return m.project.toLowerCase()
    if (thread.startsWith(PROJECT_THREAD)) return thread.slice(PROJECT_THREAD.length).split('~')[0].toLowerCase() || null
    const o = db.query(`SELECT scope_key FROM tool_pages WHERE page = ? AND thread = ? AND scope_key != ? LIMIT 1`).get(OVERVIEW_PAGE, thread, DESK) as { scope_key: string } | null
    return o?.scope_key ?? null
  }
  const threadExists = (id: string) => !!(q.meta.get(id) || db.query('SELECT 1 FROM messages WHERE thread = ? LIMIT 1').get(id))

  function newInstance(tool: Tool, scope: 'topic' | 'project', key: string): string | null {
    const taken = db.query('SELECT 1 FROM tool_instances WHERE tool = ? AND instance = ?')
    let n = 1, id = instanceIdFor(key, 1, tool.id)
    while (taken.get(tool.id, id)) id = instanceIdFor(key, ++n, tool.id)
    if (!tool.pattern.test(id)) { log(`hub: tools: ${tool.id}: its instance.pattern refuses ${id}`); return null }
    db.query('INSERT INTO tool_instances (tool, scope, scope_key, instance, created) VALUES (?, ?, ?, ?, ?)').run(tool.id, scope, key, id, Date.now())
    return id
  }
  // A topic's instance of a tool: made the first time it's asked for, then kept, so the link stays the same.
  function topicInstance(tool: Tool, thread: string): string | null {
    const cur = db.query(`SELECT instance FROM tool_instances WHERE tool = ? AND scope = 'topic' AND scope_key = ?`).get(tool.id, thread) as { instance: string } | null
    return cur ? cur.instance : newInstance(tool, 'topic', thread)
  }
  // A project's instance of a tool. A tool that was per topic before keeps its content: the first
  // time the project asks, a topic instance of one of its topics (the asking one first, else the
  // oldest) becomes the project's, and its topic becomes the project's overview topic.
  function projectInstance(tool: Tool, key: string, from?: string): string | null {
    const cur = db.query(`SELECT instance FROM tool_instances WHERE tool = ? AND scope = 'project' AND scope_key = ?`).get(tool.id, key) as { instance: string } | null
    if (cur) return cur.instance
    const old = db.query(`SELECT scope_key AS thread, instance FROM tool_instances WHERE tool = ? AND scope = 'topic' ORDER BY scope_key = ? DESC, created`).all(tool.id, from ?? null) as { thread: string; instance: string }[]
    const adopt = old.find(r => (projectOf(r.thread) ?? DESK) === key)
    if (adopt) {
      db.transaction(() => {
        db.query(`UPDATE tool_instances SET scope = 'project', scope_key = ? WHERE tool = ? AND instance = ?`).run(key, tool.id, adopt.instance)
        db.query('INSERT OR REPLACE INTO tool_pages (tool, scope_key, page, thread, title, created) VALUES (?, ?, ?, ?, NULL, ?)').run(tool.id, key, OVERVIEW_PAGE, adopt.thread, Date.now())
      })()
      log(`hub: tools: ${tool.id}: ${adopt.thread}'s instance ${adopt.instance} is now project ${key}'s; that topic is its overview`)
      return adopt.instance
    }
    return newInstance(tool, 'project', key)
  }
  /** Where a tool opens from a topic: its instance, and for a project tool the page. */
  function openFromTopic(tool: Tool, thread: string): { instance: string; page: string } | null {
    if (tool.scope === 'topic') { const instance = topicInstance(tool, thread); return instance ? { instance, page: thread } : null }
    // A topic whose project the agent no longer lists keeps the board its page is on.
    const was = db.query(`SELECT scope_key FROM tool_pages WHERE tool = ? AND thread = ? ORDER BY created LIMIT 1`).get(tool.id, thread) as { scope_key: string } | null
    const key = projectOf(thread) ?? was?.scope_key ?? DESK
    const instance = projectInstance(tool, key, thread)
    if (!instance) return null
    // The overview's topic shows the overview; any other topic its own page, named once and kept.
    const had = db.query('SELECT page FROM tool_pages WHERE tool = ? AND scope_key = ? AND thread = ? ORDER BY page = ? DESC LIMIT 1').get(tool.id, key, thread, OVERVIEW_PAGE) as { page: string } | null
    if (had) return { instance, page: had.page }
    const page = pageIdFor(tool, key, thread)
    db.query('INSERT INTO tool_pages (tool, scope_key, page, thread, title, created) VALUES (?, ?, ?, ?, NULL, ?)').run(tool.id, key, page, thread, Date.now())
    return { instance, page }
  }
  /** A topic's page name: its thread id if that is [A-Za-z0-9_-]{1,64} (as Board takes), else made so; unique on the instance. */
  function pageIdFor(tool: Tool, key: string, thread: string): string {
    const base = thread.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'topic'
    const taken = db.query('SELECT 1 FROM tool_pages WHERE tool = ? AND scope_key = ? AND page = ?')
    let page = base === OVERVIEW_PAGE ? `${base}-2` : base, n = base === OVERVIEW_PAGE ? 2 : 1
    while (taken.get(tool.id, key, page)) page = `${base.slice(0, 60)}-${++n}`
    return page
  }
  /** A project's name for a title: as the agent wrote it, kebab-case made into words. */
  function projectTitle(key: string): string {
    if (key === DESK) return 'Desk'
    const r = db.query('SELECT project FROM thread_meta WHERE lower(project) = ? LIMIT 1').get(key) as { project: string } | null
    const name = r?.project ?? key
    return /[A-Z]/.test(name) ? name : name.split(/[-_ ]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
  }
  /**
   * The topic a project tool's page posts into, or null if the page isn't the project's: a topic
   * of the project (now, or when it was opened there), or "overview": one topic per project and tool,
   * "<Project> · <Tool>", made on the first post and then reused.
   */
  function pageThread(tool: Tool, key: string, page: string): string | null {
    if (page === OVERVIEW_PAGE) {
      const row = db.query('SELECT thread, title FROM tool_pages WHERE tool = ? AND scope_key = ? AND page = ?').get(tool.id, key, OVERVIEW_PAGE) as { thread: string | null; title: string | null } | null
      if (row?.thread) return row.thread
      const base = `${key}~${tool.id}`.slice(0, 200)
      let id = base, n = 1
      while (threadExists(id)) id = `${base}-${++n}`
      const title = row?.title ?? `${projectTitle(key)} · ${tool.name}`
      db.transaction(() => {
        db.query('INSERT INTO tool_pages (tool, scope_key, page, thread, title, created) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET thread = excluded.thread, title = excluded.title')
          .run(tool.id, key, OVERVIEW_PAGE, id, title, Date.now())
        q.putTopic.run(id, title, null, null, null, key === DESK ? null : key, Date.now())
      })()
      log(`hub: tools: ${tool.id}: ${key}'s overview posts into ${id}`)
      broadcastUser('threads', threads())
      return id
    }
    const known = db.query('SELECT thread FROM tool_pages WHERE tool = ? AND scope_key = ? AND page = ? AND thread IS NOT NULL').get(tool.id, key, page) as { thread: string } | null
    if (known) return known.thread
    // A topic's id itself, if that topic is the project's (a page not opened through the hub yet).
    return threadExists(page) && (projectOf(page) ?? DESK) === key ? page : null
  }

  const toolInfo = (t: Tool) => ({
    id: t.id, name: t.name, version: t.version ?? null, icon: t.icon ? `api/tools/${t.id}/icon` : null, origin: t.origin, scope: t.scope,
    frame: t.manifest.frame.url, link: t.manifest.frame.link ?? null, allow: t.allow, up: supervisor?.up(t.id) ?? null,
  })

  function openTool(req: Request, toolId: string, thread: string, legacy = false): Response {
    // Cross-site forms can't set this header, and the hub answers no CORS preflight.
    if (req.headers.get('x-hub-action') !== '1') return err(403, 'X-Hub-Action header required')
    const tool = tools.get(toolId)
    if (!tool) return err(404, legacy ? 'boards are off' : 'no such tool')
    const at = openFromTopic(tool, thread)
    const urls = at && toolUrls(tool, at.instance, at.page)
    if (!at || !urls) return err(500, 'tool instance unavailable')
    const out = { tool: tool.id, instance: at.instance, origin: tool.origin, frame: urls.frame, link: urls.link, scope: tool.scope, page: at.page }
    return json(legacy ? { board: at.instance, ...out } : out)
  }
  // A project tool from the project's header: its overview page. `name` is the project's name as
  // the app shows it, for the overview topic's title.
  async function openProjectTool(req: Request, toolId: string, key: string): Promise<Response> {
    if (req.headers.get('x-hub-action') !== '1') return err(403, 'X-Hub-Action header required')
    const tool = tools.get(toolId)
    if (!tool) return err(404, 'no such tool')
    if (tool.scope !== 'project') return err(400, 'not a project tool')
    const b = await req.json().catch(() => null) as { name?: unknown } | null
    key = key.toLowerCase()
    const instance = projectInstance(tool, key)
    const urls = instance && toolUrls(tool, instance, OVERVIEW_PAGE)
    if (!instance || !urls) return err(500, 'tool instance unavailable')
    const name = typeof b?.name === 'string' ? b.name.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
    db.query('INSERT INTO tool_pages (tool, scope_key, page, thread, title, created) VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT DO UPDATE SET title = COALESCE(title, excluded.title)')
      .run(tool.id, key, OVERVIEW_PAGE, name ? `${name} · ${tool.name}` : null, Date.now())
    return json({ tool: tool.id, instance, origin: tool.origin, frame: urls.frame, link: urls.link, scope: tool.scope, page: OVERVIEW_PAGE, project: key })
  }

  function toolIcon(id: string): Response {
    const t = tools.get(id)
    if (!t?.icon) return err(404, 'not found')
    const type = t.icon.endsWith('.svg') ? 'image/svg+xml' : t.icon.endsWith('.png') ? 'image/png' : 'image/webp'
    return new Response(Bun.file(t.icon), { headers: {
      'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      // An SVG can carry script: never as this origin.
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    } })
  }

  // ---------- voice transcription (optional, async) ----------
  const transcribeCmd = opts.transcribeCmd?.trim() || null
  const transcribeTimeout = opts.transcribeTimeoutMs ?? 120_000
  async function transcribe(id: number) {
    const row = getMsg(id)
    if (!row) return
    const body = bodyOf(row)
    const file = getFile(body.files?.[0])
    const res = file
      ? await runTranscriber(transcribeCmd!, file.path, `${file.path}.transcript.txt`, transcribeTimeout)
      : { status: 'failed' as const, error: 'audio file missing' }
    const fresh = bodyOf(getMsg(id)!)
    if (res.status === 'done') Object.assign(fresh, { transcript: res.text, transcript_cues: res.cues, transcript_status: 'done' })
    else { Object.assign(fresh, { transcript_status: res.status }); log(`hub: transcript for ${id}: ${res.status}: ${res.error}`) }
    saveBody(id, fresh, row.edited_at)
    const done = getMsg(id)!
    broadcastUser('update', present([done])[0])
    deliverToAgents(done) // released either way: with a transcript, or after a failure/timeout without one
  }
  // Voice notes still pending from before a restart: transcribe them again, or release them.
  for (const r of db.query(`SELECT id FROM messages WHERE kind = 'voice' AND json_extract(body_json, '$.transcript_status') = 'pending'`).all() as { id: number }[]) {
    if (transcribeCmd) void transcribe(r.id)
    else {
      const m = getMsg(r.id)!, b = bodyOf(m)
      b.transcript_status = 'off'
      saveBody(m.id, b, m.edited_at)
    }
  }

  // ---------- dictation: voice note → transcript → refined prompt, back to the composer ----------
  const refineCmd = opts.refineCmd?.trim() || null
  const refineTimeout = opts.refineTimeoutMs ?? 90_000
  async function dictate(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const file = typeof b?.file === 'string' ? getFile(b.file) : null
    if (!file) return err(400, 'unknown file')
    if (!transcribeCmd) return err(501, 'no transcriber configured')
    server.timeout(req, 0) // whisper + refine can outlast the 120 s idle timeout
    const rawPath = `${file.path}.transcript.txt`
    const t = await runTranscriber(transcribeCmd, file.path, rawPath, transcribeTimeout)
    if (t.status !== 'done') { log(`hub: dictation ${file.id}: ${t.status}: ${t.error}`); return err(502, `transcript ${t.status}`) }
    if (!refineCmd || b.refine === false) return json({ raw: t.text, refined: null, refine_status: refineCmd ? 'skipped' : 'off' })
    const r = await runTranscriber(refineCmd, rawPath, `${file.path}.refined.txt`, refineTimeout)
    if (r.status !== 'done') log(`hub: refine ${file.id}: ${r.status}: ${r.error}`)
    return json({ raw: t.text, refined: r.status === 'done' ? r.raw : null, refine_status: r.status })
  }

  async function upload(req: Request): Promise<Response> {
    const boundary = boundaryOf(req.headers.get('content-type'))
    if (!boundary || !req.body) return err(400, 'multipart/form-data expected')
    const saved: FileRow[] = []
    const pending: string[] = []
    try {
      await streamMultipart(req.body, boundary, async h => {
        if (h.name !== 'file' || h.filename == null) return null
        const id = newId()
        const name = (h.filename || 'file').replace(/[\/\\\0]/g, '_').slice(0, 200)
        const path = join(filesDir, id + safeExt(name))
        const fh = await open(path, 'w', 0o600)
        pending.push(path)
        let size = 0
        return {
          async write(chunk) { size += chunk.length; await fh.write(chunk) },
          async end() {
            await fh.close()
            const mime = h.contentType && h.contentType !== 'application/octet-stream' ? h.contentType : (Bun.file(path).type.split(';')[0] || 'application/octet-stream')
            const row = { id, name, mime, size, path, ts: Date.now() }
            q.insertFile.run(id, name, mime, size, path, row.ts)
            saved.push(row)
          },
        }
      }, maxUpload)
    } catch (e) {
      return err(400, String((e as Error).message ?? e))
    }
    if (!saved.length) return err(400, 'no file field')
    return json(saved.map(fileMeta), 201)
  }

  function serveFile(req: Request, id: string, download: boolean): Response {
    const f = getFile(id)
    if (!f || !existsSync(f.path)) return err(404, 'not found')
    const file = Bun.file(f.path)
    const size = file.size
    const headers: Record<string, string> = {
      'content-type': f.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'x-content-type-options': 'nosniff',
    }
    // Uploaded HTML or SVG must not run as this origin.
    if (/html|svg|xml|javascript/.test(f.mime)) headers['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
    const range = req.headers.get('range')
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m && (m[1] || m[2])) {
      let start: number, end: number
      if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 }
      else { start = Math.max(0, size - Number(m[2])); end = size - 1 }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
      })
    }
    return new Response(file, { headers: { ...headers, 'content-length': String(size) } })
  }

  // Pages are always newest first. `before` pages back from an id; `after` alone pages
  // forward (the next `limit` messages after it, not the newest ones, so a reader in the
  // middle of the history can scroll down without a gap); `around` (or `date`) opens a
  // window in the middle: some older messages, the anchor, and more newer ones.
  function listMessages(url: URL): Response {
    const thread = url.searchParams.get('thread')
    const before = Number(url.searchParams.get('before')) || 0
    const after = Number(url.searchParams.get('after')) || 0
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
    const where = [`kind != 'reaction'`, HIDDEN_TIMER_NOTE]
    const args: (string | number)[] = []
    if (thread) { where.push('thread = ?'); args.push(thread) }
    const page = (extra: string, arg: number, order: 'ASC' | 'DESC', n: number) =>
      db.query(`SELECT * FROM messages WHERE ${[...where, extra].join(' AND ')} ORDER BY id ${order} LIMIT ${n}`).all(...args, arg) as MessageRow[]

    let around = Number(url.searchParams.get('around')) || 0
    const date = url.searchParams.get('date')
    if (!around && date) {
      const start = dayStart(date, Number(url.searchParams.get('tz')) || 0)
      if (start == null) return err(400, 'date must be YYYY-MM-DD')
      // The first message that day or later; past the end, the newest one.
      const hit = (page('ts >= ?', start, 'ASC', 1)[0] ?? page('id > ?', 0, 'DESC', 1)[0])
      if (!hit) return json([])
      around = hit.id
    }
    if (around) {
      const older = Math.floor(limit * 0.4)
      return json(present([...page('id >= ?', around, 'ASC', limit - older).reverse(), ...page('id < ?', around, 'DESC', older)]))
    }
    if (before) { where.push('id < ?'); args.push(before) }
    if (after) { where.push('id > ?'); args.push(after) }
    const rows = db.query(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id ${after && !before ? 'ASC' : 'DESC'} LIMIT ${limit}`).all(...args) as MessageRow[]
    return json(present(after && !before ? rows.reverse() : rows))
  }

  /** Midnight of a YYYY-MM-DD day, in ms; tz is the client's getTimezoneOffset() (minutes, UTC − local). */
  function dayStart(date: string, tz: number): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!m) return null
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return Number.isFinite(t) ? t + Math.max(-1440, Math.min(1440, tz)) * 60_000 : null
  }

  // Search over the index: every word must appear (case-insensitive substring), newest first.
  // `before` pages further back. Each hit is a normal message plus a `snippet` around the
  // first match.
  function search(url: URL): Response {
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
    const thread = url.searchParams.get('thread')
    const before = Number(url.searchParams.get('before')) || 0
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100)
    const terms = [...new Set(query.split(/\s+/).filter(Boolean))].slice(0, 8)
    // ?type=photo|video|audio|file: only messages with such an attachment; without words, the latest of them.
    const mime = SEARCH_TYPES[url.searchParams.get('type') ?? '']
    if (!terms.length && !mime) return json([])
    const where = terms.map(() => `f.body LIKE ? ESCAPE '\\'`)
    const args: (string | number)[] = terms.map(t => `%${t.replace(/[\\%_]/g, c => '\\' + c)}%`)
    if (mime) where.push(`EXISTS (SELECT 1 FROM json_each(m.body_json, '$.files') j JOIN files fl ON fl.id = j.value WHERE ${mime})`)
    if (thread) { where.push('m.thread = ?'); args.push(thread) }
    if (before) { where.push('m.id < ?'); args.push(before) }
    const rows = db.query(`SELECT m.*, f.body AS search_body FROM messages_fts f JOIN messages m ON m.id = f.rowid
      WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ${limit}`).all(...args) as (MessageRow & { search_body: string })[]
    return json(present(rows).map((m, i) => ({ ...m, snippet: snippetAround(rows[i].search_body, terms) })))
  }
  function snippetAround(text: string, terms: string[], n = 140): string {
    const flatText = text.replace(/\s+/g, ' ').trim()
    const lower = flatText.toLowerCase()
    const at = Math.min(...terms.map(t => lower.indexOf(t.toLowerCase())).filter(i => i >= 0))
    if (!Number.isFinite(at) || flatText.length <= n) return flatText.slice(0, n)
    const start = Math.max(0, Math.min(at - 40, flatText.length - n))
    return `${start > 0 ? '…' : ''}${flatText.slice(start, start + n).trim()}${start + n < flatText.length ? '…' : ''}`
  }

  function lastRead(thread: string): number {
    const r = db.query('SELECT last_id FROM reads WHERE thread = ?').get(thread) as { last_id: number } | null
    return r?.last_id ?? 0
  }

  const PROJECT_THREAD = 'project-'
  /** An untitled project conversation is named by its first line, without the relay's @peer. */
  function firstLine(thread: string): string | null {
    const r = db.query(`SELECT body_json FROM messages WHERE thread = ? AND sender = 'user' AND kind = 'text' ORDER BY id LIMIT 1`).get(thread) as { body_json: string } | null
    const text = r ? String(JSON.parse(r.body_json).text ?? '') : ''
    const line = text.replace(/^@[\p{L}\p{M}\p{N}_.-]+ /u, '').split('\n').map(l => l.trim()).find(Boolean)
    return line ? (line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line) : null
  }
  function threads() {
    const metas = db.query('SELECT * FROM thread_meta').all() as { id: string; title: string | null; state: string | null; updated: number | null; lane: string | null; detail: string | null; history: string | null; project: string | null; closed: number | null }[]
    const stats = db.query(`SELECT thread, MAX(ts) AS updated FROM messages WHERE thread IS NOT NULL AND kind != 'reaction' AND ${HIDDEN_TIMER_NOTE} GROUP BY thread`).all() as { thread: string; updated: number }[]
    const all = lastRead('*')
    const map = new Map<string, { id: string; title: string; state: string | null; lane: string | null; detail: string | null; history: string[]; project: string | null; closed?: true; updated: number; last: number | null; unread: number }>()
    // closed: the topic left the agent's list (its task closed) but keeps its project; the app files it under Other.
    for (const m of metas) map.set(m.id, { id: m.id, title: m.title ?? m.id, state: m.state, lane: m.lane, detail: m.detail, history: m.history ? m.history.split('\n') : [], project: m.project, ...(m.closed && m.project ? { closed: true as const } : {}), updated: m.updated ?? 0, last: null, unread: 0 })
    for (const s of stats) {
      const t = map.get(s.thread) ?? { id: s.thread, title: s.thread, state: null, lane: null, detail: null, history: [], project: null, updated: 0, last: null, unread: 0 }
      t.updated = Math.max(t.updated, s.updated)
      t.last = s.updated
      map.set(s.thread, t)
    }
    const unreadQ = db.query(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'agent' AND kind != 'reaction' AND thread IS ? AND id > ?`)
    // A project conversation is its own topic: its id says which project, so no task has to.
    for (const t of map.values()) if (t.id.startsWith(PROJECT_THREAD)) {
      delete t.closed
      t.project ||= t.id.slice(PROJECT_THREAD.length).split('~')[0]
      if (t.title === t.id) t.title = firstLine(t.id) ?? t.title
    }
    // A project tool's overview topic: its project and title outlive the agent's thread lists.
    for (const o of db.query('SELECT scope_key, thread, title FROM tool_pages WHERE page = ? AND thread IS NOT NULL').all(OVERVIEW_PAGE) as { scope_key: string; thread: string; title: string | null }[]) {
      const t = map.get(o.thread)
      if (!t) continue
      if (o.scope_key !== DESK) { t.project ||= o.scope_key; delete t.closed }
      if (t.title === t.id && o.title) t.title = o.title
    }
    for (const t of map.values()) t.unread = (unreadQ.get(t.id, Math.max(all, lastRead(t.id))) as { n: number }).n
    const general = (unreadQ.get(null, Math.max(all, lastRead(''))) as { n: number }).n
    return { threads: [...map.values()].sort((a, b) => b.updated - a.updated), general_unread: general, projects: projectIcons(), project_links: projectLinks() }
  }

  // ---------- peers' notes (/peer/tell) ----------
  // A project session leaves a note for the agent. It goes down the agent's stream as kind "peer",
  // under the same hand-off rule as the user's messages, and shows quietly in that project's
  // conversation: no push, no unread count, no typing. The token names the project, never the
  // request, and opens nothing but /peer/tell. Every session runs as the same user, so this says
  // which project sent a note; it doesn't keep one session out of another's token file.
  const PEER_TEXT_MAX = 16_000
  const PEER_FILES_MAX = 10
  const PEER_RATE = { n: 20, ms: 10 * 60_000 }
  const peerDir = join(dataDir, 'peer-tokens')
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
  const realOr = (p: string) => { try { return realpathSync(p) } catch { return null } }
  const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

  function peerAuth(req: Request): string | null {
    if (req.headers.has('tailscale-user-login')) return null
    const h = req.headers.get('authorization') ?? ''
    const given = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
    if (!given || given.length > 200) return null
    const row = db.query('SELECT project FROM peer_tokens WHERE hash = ?').get(sha256(given)) as { project: string } | null
    return row?.project ?? null
  }
  const peerFolders = (project: string) =>
    (db.query('SELECT folder FROM peer_folders WHERE project = ? ORDER BY folder').all(project) as { folder: string }[]).map(r => r.folder)

  /** A note's file: a real file inside the project's folders, the icon roots (HUB_ICON_ROOTS) or the temp
   *  folders. Never a hidden file or folder, a *.token, or anything in the hub's own data folder. */
  function peerFile(p: unknown, project: string): string {
    if (typeof p !== 'string' || !isAbsolute(p)) throw new Error(`a file must be an absolute path: ${String(p).slice(0, 200)}`)
    const real = realOr(p)
    if (!real) throw new Error(`no such file: ${p}`)
    const data = realOr(dataDir)
    if (data && within(real, data)) throw new Error(`not allowed: ${p} is in the hub's data folder`)
    if (/\.token$/i.test(real)) throw new Error(`not allowed: ${p} is a token file`)
    const roots = [...peerFolders(project), ...(opts.iconRoots ?? [join(homedir(), 'Workspace')]), '/tmp', tmpdir()]
      .map(realOr).filter((r): r is string => !!r)
    const root = roots.filter(r => within(real, r)).sort((a, b) => b.length - a.length)[0]
    if (!root) throw new Error(`not allowed: ${p} is outside the project's folders, the icon roots and the temp folders`)
    if (relative(root, real).split(sep).some(s => s.startsWith('.'))) throw new Error(`not allowed: ${p} is hidden (a name starting with ".")`)
    const st = statSync(real)
    if (!st.isFile()) throw new Error(`not a file: ${p}`)
    if (st.size > maxUpload) throw new Error(`too big: ${p}`)
    return real
  }

  async function peerTell(req: Request, project: string): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return err(400, 'object expected')
    const text = typeof b.text === 'string' ? b.text : ''
    if (text.length > PEER_TEXT_MAX) return err(413, `the note is too long (${text.length} characters, at most ${PEER_TEXT_MAX}): put the detail in a file and attach it`)
    const paths: unknown[] = Array.isArray(b.files) ? b.files : []
    if (paths.length > PEER_FILES_MAX) return err(400, `at most ${PEER_FILES_MAX} files`)
    if (!text.trim() && !paths.length) return err(400, 'text or files required')
    const recent = (db.query(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'peer' AND source = ? AND ts > ?`).get(project, Date.now() - PEER_RATE.ms) as { n: number }).n
    if (recent >= PEER_RATE.n) return err(429, `too many notes from ${project}: ${PEER_RATE.n} in the last 10 minutes. Wait a few minutes, or put everything in one note.`)
    let thread = PROJECT_THREAD + project
    if (typeof b.thread === 'string' && b.thread) {
      const t = b.thread.slice(0, 200)
      if (projectOf(t) !== project) return err(400, `${t} isn't one of ${project}'s conversations or topics`)
      thread = t
    }
    // The caller's session name, as bebop tell found it: a claim, shown as one.
    const session = typeof b.session === 'string' && PEER_NAME.test(b.session.normalize('NFC')) ? b.session.normalize('NFC') : null
    let real: string[]
    try { real = paths.map(p => peerFile(p, project)) } catch (e) { return err(400, (e as Error).message) }
    const files = real.map(copyLocalFile)
    const row = insert({ sender: 'peer', kind: 'peer', thread, source: project, body: { text, ...(files.length ? { files } : {}), ...(session ? { session } : {}) } })
    db.query('UPDATE peer_tokens SET last_used = ? WHERE project = ?').run(row.ts, project)
    broadcastUser('message', present([row])[0])
    deliverToAgents(row)
    return json({ id: row.id, thread }, 201)
  }

  // The agent makes a project's token (once, or again with rotate) and names the folders its
  // sessions run in. The hub keeps the token's hash and writes the token for bebop tell to
  // data/peer-tokens/<project>.token, and the folders (no secrets) to data/peer-tokens/folders.json.
  function writeFolderMap() {
    mkdirSync(peerDir, { recursive: true, mode: 0o700 })
    const rows = db.query('SELECT folder, project FROM peer_folders ORDER BY folder').all() as { folder: string; project: string }[]
    const tmp = join(peerDir, `folders.json.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(rows.map(r => [r.folder, r.project])), null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, join(peerDir, 'folders.json'))
  }
  const tokenFileOf = (project: string) => join(peerDir, `${project}.token`)
  function peerTokenList() {
    const rows = db.query('SELECT project, created, last_used FROM peer_tokens ORDER BY project').all() as { project: string; created: number; last_used: number | null }[]
    return rows.map(r => ({ ...r, folders: peerFolders(r.project), token_file: tokenFileOf(r.project) }))
  }
  async function agentPeerToken(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const project = typeof b?.project === 'string' ? b.project.normalize('NFC').trim().toLowerCase() : ''
    if (!PEER_NAME.test(project)) return err(400, 'project: its name as in the app (letters, digits, _ . -)')
    const given: unknown[] | null = Array.isArray(b.folders) ? b.folders : b.folder != null ? [b.folder] : null
    let folders: string[] | null = null
    if (given) {
      folders = []
      for (const f of given) {
        const real = typeof f === 'string' && isAbsolute(f) ? realOr(f) : null
        if (!real || !statSync(real).isDirectory()) return err(400, `not a folder (an absolute path is needed): ${String(f).slice(0, 200)}`)
        if (real === '/' || real === realOr(homedir())) return err(400, `too wide for one project: ${real}`)
        const other = db.query('SELECT project FROM peer_folders WHERE folder = ? AND project != ?').get(real, project) as { project: string } | null
        if (other) return err(409, `${real} is already ${other.project}'s folder`)
        if (!folders.includes(real)) folders.push(real)
      }
      if (!folders.length) return err(400, 'at least one folder')
    }
    const had = !!db.query('SELECT 1 FROM peer_tokens WHERE project = ?').get(project)
    if (!had && !folders) return err(400, 'folders required: where this project\'s sessions run')
    const token = !had || b.rotate === true ? randomBytes(32).toString('hex') : null
    const tmp = join(peerDir, `${project}.token.${process.pid}.tmp`)
    if (token) {
      mkdirSync(peerDir, { recursive: true, mode: 0o700 })
      writeFileSync(tmp, token + '\n', { mode: 0o600 })
    }
    db.transaction(() => {
      if (token) db.query(`INSERT INTO peer_tokens (project, hash, created) VALUES (?, ?, ?)
        ON CONFLICT(project) DO UPDATE SET hash = excluded.hash, created = excluded.created, last_used = NULL`).run(project, sha256(token), Date.now())
      if (folders) {
        db.query('DELETE FROM peer_folders WHERE project = ?').run(project)
        for (const f of folders) db.query('INSERT INTO peer_folders (folder, project) VALUES (?, ?)').run(f, project)
      }
    })()
    if (token) renameSync(tmp, tokenFileOf(project))
    writeFolderMap()
    return json({ ok: true, project, made: !had, rotated: had && !!token, folders: peerFolders(project), token_file: tokenFileOf(project) }, had ? 200 : 201)
  }
  async function agentPeerRevoke(req: Request): Promise<Response> {
    const b = await req.json().catch(() => null) as { project?: unknown } | null
    const project = typeof b?.project === 'string' ? b.project.normalize('NFC').trim().toLowerCase() : ''
    if (!project) return err(400, 'project required')
    const n = db.transaction(() => {
      db.query('DELETE FROM peer_folders WHERE project = ?').run(project)
      return db.query('DELETE FROM peer_tokens WHERE project = ?').run(project).changes
    })()
    rmSync(tokenFileOf(project), { force: true })
    writeFolderMap()
    return json({ ok: true, project, revoked: n > 0 })
  }

  // ---------- the clock ----------
  // Timers live in SQLite. When one is due the hub puts a kind "timer" note in the agent's inbox
  // (same stream, same hand-off rule) in one transaction with moving the timer on, so a firing
  // happens once, and one missed while the hub was down happens at its next start (late).
  // The agent sets, lists and cancels them; the user sees them in the app and can move or cancel
  // one, which tells the agent with a note of its own (never shown in a conversation).
  const TIMER_TEXT_MAX = 2000
  const TIMER_LATE_MS = 60_000
  const TIMER_AHEAD_MS = 5 * 366 * 86_400_000
  const AT_HELP = 'at: ms since the epoch, or a date and time ("2026-11-18T09:00", local time unless it ends in Z or an offset)'
  let clockTimer: ReturnType<typeof setTimeout> | undefined
  let clockStopped = false
  const getTimer = (id: number) => db.query('SELECT * FROM timers WHERE id = ?').get(id) as TimerRow | null
  const timerOut = (t: TimerRow) => ({ ...t, due_local: localIso(t.due) })
  function timerList(all = false): TimerRow[] {
    return (all
      ? db.query(`SELECT * FROM timers WHERE state = 'scheduled' OR COALESCE(changed, fired, created) > ? ORDER BY state = 'scheduled' DESC, due, id`).all(Date.now() - 30 * 86_400_000)
      : db.query(`SELECT * FROM timers WHERE state = 'scheduled' ORDER BY due, id`).all()) as TimerRow[]
  }
  function timersChanged() {
    broadcastUser('timers', { timers: timerList().map(timerOut) })
    armClock()
  }
  function armClock() {
    clearTimeout(clockTimer)
    if (clockStopped) return
    const next = (db.query(`SELECT MIN(due) AS due FROM timers WHERE state = 'scheduled'`).get() as { due: number | null }).due
    if (next == null) return
    // Look again at least every minute: a sleeping Mac or a clock change can make a long wait wrong.
    clockTimer = setTimeout(fireDue, Math.max(0, Math.min(next - Date.now(), 60_000)))
  }
  function fireDue() {
    const now = Date.now()
    const due = db.query(`SELECT * FROM timers WHERE state = 'scheduled' AND due <= ? ORDER BY due, id`).all(now) as TimerRow[]
    for (const t of due) {
      const row = db.transaction(() => {
        const fresh = getTimer(t.id)
        if (!fresh || fresh.state !== 'scheduled' || fresh.due > now) return null // moved or cancelled meanwhile
        const late = now - fresh.due > TIMER_LATE_MS
        const body = { text: fresh.text, timer: fresh.id, due: fresh.due, fires: fresh.fires + 1, ...(fresh.repeat ? { repeat: fresh.repeat } : {}), ...(fresh.key ? { key: fresh.key } : {}), ...(late ? { late: true } : {}) }
        const r = insert({ sender: 'clock', kind: 'timer', body, thread: fresh.thread })
        const next = fresh.repeat ? nextDue(fresh.due, fresh.repeat, now) : null
        db.query(`UPDATE timers SET fired = ?, fires = fires + 1, due = ?, state = ? WHERE id = ?`).run(now, next ?? fresh.due, next ? 'scheduled' : 'done', fresh.id)
        return r
      })()
      if (!row) continue
      if (now - t.due > TIMER_LATE_MS) log(`hub: timer ${t.id} was due ${localIso(t.due)}; fired late`)
      broadcastUser('message', present([row])[0])
      deliverToAgents(row)
    }
    if (due.length) timersChanged()
    else armClock()
  }
  function timerInput(b: any): { text: string; due: number; repeat: string | null; thread: string | null; key: string | null } | string {
    const text = typeof b?.text === 'string' ? b.text.trim() : ''
    if (!text) return 'text required'
    if (text.length > TIMER_TEXT_MAX) return `text: at most ${TIMER_TEXT_MAX} characters`
    const due = parseAt(b.at)
    if (due == null) return AT_HELP
    const now = Date.now()
    if (due < now - 60_000) return `at is in the past (${localIso(due)})`
    if (due > now + TIMER_AHEAD_MS) return 'at is more than five years away'
    let repeat: string | null
    try { repeat = parseRepeat(b.repeat) } catch (e) { return (e as Error).message }
    const thread = typeof b.thread === 'string' && b.thread ? b.thread.slice(0, 200) : null
    const key = typeof b.key === 'string' && b.key.trim() ? b.key.trim().slice(0, 100) : null
    return { text, due, repeat, thread, key }
  }
  // POST /agent/timers {text, at, repeat?, thread?, key?, id?}: sets a timer. With the id of a
  // scheduled one, or a key a scheduled one has, it replaces that one (moves it, rewords it).
  async function agentTimer(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const v = timerInput(b)
    if (typeof v === 'string') return err(400, v)
    let existing: TimerRow | null = null
    if (b.id != null) {
      existing = Number.isInteger(b.id) ? getTimer(b.id) : null
      if (!existing || existing.state !== 'scheduled') return err(404, 'no scheduled timer with that id')
    } else if (v.key) {
      existing = db.query(`SELECT * FROM timers WHERE key = ? AND state = 'scheduled'`).get(v.key) as TimerRow | null
    }
    const now = Date.now()
    let id: number
    if (existing) {
      if (v.key && v.key !== existing.key && db.query(`SELECT 1 FROM timers WHERE key = ? AND state = 'scheduled' AND id != ?`).get(v.key, existing.id)) return err(409, `another timer has the key ${v.key}`)
      db.query(`UPDATE timers SET text = ?, due = ?, repeat = ?, thread = ?, key = COALESCE(?, key), changed_by = 'agent', changed = ? WHERE id = ?`)
        .run(v.text, v.due, v.repeat, v.thread, v.key, now, existing.id)
      id = existing.id
    } else {
      id = (db.query(`INSERT INTO timers (text, due, repeat, thread, key, state, created) VALUES (?, ?, ?, ?, ?, 'scheduled', ?) RETURNING id`)
        .get(v.text, v.due, v.repeat, v.thread, v.key, now) as { id: number }).id
    }
    timersChanged()
    return json({ ok: true, replaced: !!existing, ...timerOut(getTimer(id)!) }, existing ? 200 : 201)
  }
  // POST /agent/timers/cancel {id | key}: 200 either way, saying how many it cancelled.
  async function agentTimerCancel(req: Request): Promise<Response> {
    const b = await req.json().catch(() => null) as { id?: unknown; key?: unknown } | null
    const byId = Number.isInteger(b?.id)
    const key = typeof b?.key === 'string' && b.key.trim() ? b.key.trim() : null
    if (!byId && !key) return err(400, 'id or key required')
    const rows = (byId
      ? db.query(`SELECT * FROM timers WHERE id = ? AND state = 'scheduled'`).all(b!.id as number)
      : db.query(`SELECT * FROM timers WHERE key = ? AND state = 'scheduled'`).all(key)) as TimerRow[]
    const now = Date.now()
    for (const t of rows) db.query(`UPDATE timers SET state = 'cancelled', changed_by = 'agent', changed = ? WHERE id = ?`).run(now, t.id)
    if (rows.length) timersChanged()
    return json({ ok: true, cancelled: rows.length, ids: rows.map(t => t.id) })
  }
  // The user moves (POST /api/timers/:id {at}) or cancels (POST /api/timers/:id/cancel) a timer.
  // The agent hears of it: a kind "timer" note with change "moved" or "cancelled", by that login.
  async function userTimer(req: Request, id: number, cancel: boolean, login: string): Promise<Response> {
    const t = getTimer(id)
    if (!t || t.state !== 'scheduled') return err(404, 'no scheduled timer with that id')
    const now = Date.now()
    let due = t.due
    if (!cancel) {
      const b = await req.json().catch(() => null) as { at?: unknown } | null
      const at = parseAt(b?.at)
      if (at == null) return err(400, AT_HELP)
      if (at < now - 60_000) return err(400, 'that time has passed')
      if (at > now + TIMER_AHEAD_MS) return err(400, 'more than five years away')
      due = at
    }
    const row = db.transaction(() => {
      db.query(`UPDATE timers SET state = ?, due = ?, changed_by = 'user', changed = ? WHERE id = ?`).run(cancel ? 'cancelled' : 'scheduled', due, now, id)
      const body = { timer: id, text: t.text, change: cancel ? 'cancelled' : 'moved', due, ...(cancel ? {} : { was: t.due }), ...(t.repeat ? { repeat: t.repeat } : {}), ...(t.key ? { key: t.key } : {}), by: login }
      return insert({ sender: 'clock', kind: 'timer', body, thread: t.thread, login })
    })()
    deliverToAgents(row)
    timersChanged()
    return json({ ok: true, ...timerOut(getTimer(id)!) })
  }

  // ---------- agent handlers ----------
  async function agentSend(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    if (!b || !AGENT_KINDS.has(b.kind)) return err(400, 'kind must be text, progress, question or approval')
    const reply_to = Number.isInteger(b.reply_to) ? b.reply_to : null
    if (reply_to && !getMsg(reply_to)) return err(400, 'reply_to not found')
    let thread: string | null = typeof b.thread === 'string' && b.thread ? b.thread : null
    if (!thread && reply_to) thread = getMsg(reply_to)!.thread
    const source = typeof b.source === 'string' && b.source ? b.source.slice(0, 100) : null
    let body: any
    try {
      switch (b.kind) {
        case 'text': {
          // Entries are ids from /agent/upload, or absolute paths the hub copies itself.
          const files = Array.isArray(b.files) ? b.files.map((f: unknown) => typeof f === 'string' && getFile(f) ? f : copyLocalFile(f)) : []
          if (!(typeof b.text === 'string' && b.text.trim()) && !files.length) return err(400, 'text or files required')
          body = { text: b.text ?? '', ...(files.length ? { files } : {}) }
          break
        }
        case 'progress':
          body = { text: String(b.text ?? ''), done: !!b.done }
          break
        case 'question': {
          if (!Array.isArray(b.questions) || !b.questions.length) return err(400, 'questions required')
          const seen = new Set<string>()
          body = {
            questions: b.questions.map((x: any, i: number) => {
              const id = String(x.id ?? `q${i + 1}`)
              if (seen.has(id)) throw new Error(`duplicate question id ${id}`)
              seen.add(id)
              if (!x.prompt) throw new Error(`question ${id} needs a prompt`)
              return {
                id, prompt: String(x.prompt), ...(x.header ? { header: String(x.header) } : {}), multi: !!x.multi,
                options: (Array.isArray(x.options) ? x.options : []).map((o: any) => ({
                  label: String(o.label ?? o),
                  ...(o.description ? { description: String(o.description) } : {}),
                  ...(o.recommended ? { recommended: true } : {}),
                  ...(o.image ? { image: getFile(o.image) ? o.image : copyLocalFile(o.image) } : {}),
                })),
              }
            }),
          }
          break
        }
        case 'approval':
          if (!b.prompt) return err(400, 'prompt required')
          body = {
            prompt: String(b.prompt), ...(b.detail ? { detail: String(b.detail) } : {}),
            options: Array.isArray(b.options) && b.options.length ? b.options.map(String) : ['Approve', 'Not yet', 'Change'],
          }
          break
      }
    } catch (e) {
      return err(400, String((e as Error).message ?? e))
    }
    const row = insert({ sender: 'agent', kind: b.kind, body, thread, source, reply_to })
    broadcastUser('message', present([row])[0])
    if (b.notify !== false && (b.kind !== 'progress' || body.done)) pushFor(row, pushText(b.kind, body))
    return json({ id: row.id }, 201)
  }

  async function agentUpdate(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const row = Number.isInteger(b?.id) ? getMsg(b.id) : null
    if (!row || row.sender !== 'agent') return err(404, 'agent message not found')
    const body = bodyOf(row)
    const wasDone = !!body.done
    let edited = row.edited_at
    if (row.kind === 'progress') {
      if (typeof b.text === 'string') body.text = b.text
      if (typeof b.done === 'boolean') body.done = b.done
      edited = Date.now() // lets the client tell a live task from a stalled one
    } else if (row.kind === 'text') {
      if (typeof b.text === 'string' && b.text !== body.text) { body.text = b.text; edited = Date.now() }
    } else if (row.kind === 'approval' || row.kind === 'question') {
      if (typeof b.prompt === 'string' && row.kind === 'approval') { body.prompt = b.prompt; edited = Date.now() }
      if (typeof b.detail === 'string' && row.kind === 'approval') { body.detail = b.detail; edited = Date.now() }
    } else {
      return err(400, 'cannot update this kind')
    }
    saveBody(row.id, body, edited)
    const fresh = getMsg(row.id)!
    broadcastUser('update', present([fresh])[0])
    if (row.kind === 'progress' && !wasDone && body.done && b.notify !== false) pushFor(fresh, pushText('progress', body))
    return json({ id: row.id })
  }

  // The agent closes a question or approval it sent that no longer needs an answer: the card greys
  // out with the reason (and a link to the card that replaces it) and can't be answered. Always 200
  // for a card, saying how it ended, since an answer can land first: closed true, or false with
  // state "answered" (and the answer) or "dismissed" (the user closed it).
  async function agentResolve(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const target = Number.isInteger(b?.id) ? getMsg(b.id) : null
    if (!target || target.sender !== 'agent' || (target.kind !== 'question' && target.kind !== 'approval')) return err(404, 'question or approval not found')
    const tb = bodyOf(target)
    if (tb.answered != null) return json({ ok: true, id: target.id, closed: false, state: 'answered', answered: tb.answered, ...(tb.answered_note ? { answered_note: tb.answered_note } : {}) })
    if (tb.resolved) return json({ ok: true, id: target.id, closed: tb.resolved.by === 'agent', already: true, state: tb.resolved.by === 'agent' ? 'resolved' : 'dismissed', resolved: tb.resolved })
    let superseded_by: number | null = null
    if (b.superseded_by != null) {
      const s = Number.isInteger(Number(b.superseded_by)) ? getMsg(Number(b.superseded_by)) : null
      if (!s || s.id === target.id) return err(400, 'superseded_by: message not found')
      superseded_by = s.id
    }
    const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 200) : null
    tb.resolved = { by: 'agent', at: Date.now(), ...(reason ? { reason } : {}), ...(superseded_by ? { superseded_by } : {}) }
    saveBody(target.id, tb, target.edited_at)
    broadcastUser('update', present([getMsg(target.id)!])[0])
    return json({ ok: true, id: target.id, closed: true, state: 'resolved', resolved: tb.resolved })
  }

  async function agentReact(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const target = Number.isInteger(b?.to) ? getMsg(b.to) : null
    if (!target) return err(404, 'message not found')
    const emoji = typeof b.emoji === 'string' ? b.emoji.slice(0, REACTION_EMOJI_MAX) : ''
    const row = insert({ sender: 'agent', kind: 'reaction', body: { to: target.id, emoji }, thread: target.thread })
    broadcastUser('reaction', { to: target.id, reactions: reactionsFor([target.id]).get(target.id) ?? [] })
    return json({ id: row.id }, 201)
  }

  // Replacing the list keeps what was archived: a thread left out stays archived, and one
  // listed without a state keeps 'archived'. An explicit state in the list wins.
  async function agentThreads(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const list = Array.isArray(b) ? b : b?.threads
    if (!Array.isArray(list)) return err(400, 'array of threads expected')
    db.transaction(() => {
      const archived = new Set((db.query(`SELECT id FROM thread_meta WHERE state = 'archived'`).all() as { id: string }[]).map(r => r.id))
      db.exec(`DELETE FROM thread_meta WHERE state IS NOT 'archived'`)
      for (const t of list) {
        if (!t?.id) continue
        const id = String(t.id)
        const upd = typeof t.updated === 'number' ? t.updated : t.updated ? Date.parse(t.updated) || null : null
        q.putMeta.run(id, t.title ? String(t.title) : null, t.state ? String(t.state) : archived.has(id) ? 'archived' : null, upd)
      }
    })()
    broadcastUser('threads', threads())
    return json({ ok: true, count: list.length })
  }

  // The agent's open topics, each with a lane (who's next) and a one-line detail. Threads left
  // out lose their lane and detail but keep their title, and no one's state changes: archiving
  // stays the user's and the task ledger's, separately.
  const TOPIC_HISTORY = 8
  async function agentTopics(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const list = Array.isArray(b) ? b : b?.topics
    if (!Array.isArray(list)) return err(400, 'array of topics expected')
    // A topic that leaves the list (its task closed) loses its lane, detail and history, but keeps its
    // project: it still belongs there. `closed` notes when it left; listing it again clears that.
    db.transaction(() => {
      db.query('UPDATE thread_meta SET lane = NULL, detail = NULL, history = NULL, closed = COALESCE(closed, ?)').run(Date.now())
      for (const t of list) {
        if (!t?.id) continue
        const upd = typeof t.updated === 'number' ? t.updated : t.updated ? Date.parse(t.updated) || null : null
        q.putTopic.run(String(t.id), t.title ? String(t.title) : null, t.lane ? String(t.lane) : null, t.detail ? String(t.detail) : null, Array.isArray(t.history) ? t.history.slice(-TOPIC_HISTORY).map(String).join('\n') : null, t.project ? String(t.project).slice(0, 100) : null, upd)
      }
    })()
    broadcastUser('threads', threads())
    noteProjects(list.flatMap((t: any) => t?.project ? [{ project: String(t.project).slice(0, 100), path: typeof t.path === 'string' ? t.path : null }] : [])).catch(() => {})
    return json({ ok: true, count: list.length })
  }

  // POST /agent/topics/project {"<topic id>": "<project>" | null, …}: set the project of topics that are
  // not in the list any more (closed tasks). A topic in the list gets its project from the next
  // /agent/topics instead. A topic the hub has never seen is not made: it's returned in `unknown`.
  async function agentTopicProjects(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const map = b && typeof b === 'object' && !Array.isArray(b) ? (b.topics && typeof b.topics === 'object' && !Array.isArray(b.topics) ? b.topics : b) : null
    if (!map) return err(400, 'an object {"<topic id>": "<project>" | null} expected')
    const entries = Object.entries(map)
    if (entries.length > 1000) return err(413, 'at most 1000 topics at a time')
    for (const [id, p] of entries) {
      if (!id || id.length > 200) return err(400, `topic id: 1 to 200 characters (${id.slice(0, 40)}…)`)
      if (p !== null && (typeof p !== 'string' || !p.trim() || p.length > 100)) return err(400, `${id}: the project is a name up to 100 characters, or null to clear it`)
    }
    // Such a topic is closed (no lane); marked so in case no /agent/topics has run since this build.
    const set = db.query(`INSERT INTO thread_meta (id, project, closed) VALUES ($id, $project, $now)
      ON CONFLICT(id) DO UPDATE SET project = excluded.project, closed = CASE WHEN lane IS NULL THEN COALESCE(closed, $now) ELSE closed END`)
    const unknown: string[] = []
    let n = 0
    db.transaction(() => {
      for (const [id, p] of entries) {
        if (!threadExists(id)) { unknown.push(id); continue }
        set.run({ id, project: p === null ? null : (p as string).trim(), now: Date.now() }); n++
      }
    })()
    if (n) broadcastUser('threads', threads())
    noteProjects(entries.flatMap(([, p]) => typeof p === 'string' ? [{ project: p.trim() }] : [])).catch(() => {})
    return json({ ok: true, count: n, unknown })
  }

  // Projects: a folder and an icon per project name, for one with topics but no peer in the
  // peers table. The folder comes from the topic's `path`, else from looking the name up under
  // the icon roots. Runs after the reply (bin/task posts with a short timeout, and a folder walk
  // can be slow) and announces the icons when they change.
  const PROJECT_RECHECK = 10 * 60 * 1000
  /** Each project's "Open app" link: {key: {url, label}}. */
  function projectLinks() {
    const rows = db.query('SELECT key, url, label FROM project_links').all() as { key: string; url: string; label: string | null }[]
    return Object.fromEntries(rows.map(r => [r.key, { url: r.url, label: r.label }]))
  }
  // POST /agent/projects/:name/link and /api/projects/:key/link {url, label?}: set the project's "Open app"
  // link; url null or "" removes it. Only https, or http on this machine.
  async function projectLinkApi(req: Request, name: string): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return err(400, 'object expected')
    const key = name.trim().toLowerCase()
    if (!key || key.length > 100) return err(400, 'project name expected')
    if (b.url == null || b.url === '') {
      db.query('DELETE FROM project_links WHERE key = ?').run(key)
      broadcastUser('threads', threads())
      return json({ ok: true, project: key, link: null })
    }
    let u: URL
    try { u = new URL(String(b.url)) } catch { return err(400, 'url must be a full https:// link') }
    const local = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.href.length > 500) return err(400, 'url must be https (or http on this machine), at most 500 characters')
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 24) : null
    db.query('INSERT OR REPLACE INTO project_links (key, url, label, updated) VALUES (?, ?, ?, ?)').run(key, u.href, label, Date.now())
    broadcastUser('threads', threads())
    return json({ ok: true, project: key, link: { url: u.href, label } })
  }
  function projectIcons() {
    const rows = db.query('SELECT name, icon FROM projects WHERE icon IS NOT NULL').all() as { name: string; icon: string }[]
    return Object.fromEntries(rows.map(r => [r.name.toLowerCase(), `api/icons/${r.icon}`]))
  }
  async function noteProjects(list: { project: string | null; path?: string | null }[]) {
    const get = db.query('SELECT path, icon, checked FROM projects WHERE name = ?')
    const put = db.query('INSERT OR REPLACE INTO projects (name, path, icon, checked) VALUES (?, ?, ?, ?)')
    let changed = false
    const seen = new Set<string>()
    for (const { project, path } of list) {
      if (!project || seen.has(project)) continue
      seen.add(project)
      const cur = get.get(project) as { path: string | null; icon: string | null; checked: number } | null
      if (cur && Date.now() - cur.checked < PROJECT_RECHECK && (!path || path === cur.path)) continue
      const dir = path ?? cur?.path ?? icons.folder(project)
      const icon = await icons.resolve(dir)
      put.run(project, dir, icon, Date.now())
      if (icon !== (cur?.icon ?? null)) changed = true
    }
    if (changed) broadcastUser('threads', threads())
  }

  type ThreadMeta = { id: string; title: string | null; state: string | null; updated: number | null }
  /** Change one thread's title or state without touching the others. 'open' or null clears the state. */
  function setThread(id: string, patch: { title?: string | null; state?: string | null }) {
    const cur = q.meta.get(id) as ThreadMeta | null
    const state = patch.state === undefined ? cur?.state ?? null : patch.state === 'open' ? null : patch.state
    const title = patch.title === undefined ? cur?.title ?? null : patch.title
    q.putMeta.run(id, title, state, cur?.updated ?? null)
    broadcastUser('threads', threads())
    return { id, title: title ?? id, state }
  }

  async function agentThread(req: Request, id: string): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return err(400, 'object expected')
    const patch: { title?: string | null; state?: string | null } = {}
    if ('title' in b) patch.title = str(b.title, 200)
    if ('state' in b) patch.state = str(b.state, 40)
    return json({ ok: true, thread: setThread(id, patch) })
  }

  // A message that turned out to start its own topic: move it there, keeping ids and times.
  // What moves was already seen where it was, so it doesn't come back as unread.
  async function agentMoveMessages(req: Request, id: string): Promise<Response> {
    const b = await req.json().catch(() => null) as { ids?: unknown } | null
    const ids = Array.isArray(b?.ids) ? b!.ids.filter(Number.isInteger) as number[] : []
    if (!ids.length) return err(400, 'ids expected')
    const marks = ids.map(() => '?').join(',')
    const moved = db.transaction(() => {
      const n = db.query(`UPDATE messages SET thread = ? WHERE kind != 'reaction' AND id IN (${marks})`).run(id, ...ids).changes
      if (n) {
        db.query('INSERT INTO reads (thread, last_id) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)').run(id, Math.max(...ids))
        q.unarchive.run(id)
      }
      return n
    })()
    if (moved) {
      broadcastUser('threads', threads())
      broadcastUser('moved', { ids, thread: id })
    }
    return json({ ok: true, moved })
  }

  // ---------- presence: is the agent thinking or working right now ----------
  // Only the latest value is kept, in memory; after a restart the agent is idle.
  const PRESENCE_STATES = new Set(['idle', 'thinking', 'working'])
  // Whether the agent is listening: an open agent stream (its watcher or channel). The app shows
  // a banner when nothing has listened for a while (it decides how long; it has the clock).
  const hubStarted = Date.now()
  let lastListened: number | null = null
  const listening = () => ({ listening: agentClients.size > 0, last: lastListened, started: hubStarted })
  function listeningChanged() {
    lastListened = Date.now()
    broadcastUser('listening', listening())
  }

  const presenceTtl = opts.presenceTtlMs ?? 10 * 60 * 1000
  let presence: { state: string; detail: string | null; thread: string | null; updated: number } = { state: 'idle', detail: null, thread: null, updated: Date.now() }
  let presenceTimer: ReturnType<typeof setTimeout> | undefined
  // The thread being worked on. Hooks report presence without knowing the thread, so the hub
  // infers it: from the messages the agent takes in and the ones it sends. An explicit thread
  // wins. It's kept while idle (an ack comes before the hook that says working) until the TTL.
  // presence.thread is this while not idle; null there means the main chat.
  let focus: string | null = null
  function setPresence(state: string, detail: string | null, thread?: string | null) {
    if (thread) focus = thread
    if (state === 'idle') focus = null
    presence = { state, detail: state === 'idle' ? null : detail, thread: focus, updated: Date.now() }
    clearTimeout(presenceTimer)
    if (state !== 'idle') presenceTimer = setTimeout(() => setPresence('idle', null), presenceTtl)
    broadcastUser('presence', presence)
  }
  /** Moves the focus without touching `updated`: the app hides the bubble under a reply until the next real update. */
  function setFocus(thread: string | null) {
    focus = thread
    if (presence.state === 'idle') {
      clearTimeout(presenceTimer)
      presenceTimer = setTimeout(() => setPresence('idle', null), presenceTtl)
      return
    }
    if (presence.thread === thread) return
    presence = { ...presence, thread }
    broadcastUser('presence', presence)
  }
  async function agentPresence(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    if (!PRESENCE_STATES.has(b?.state)) return err(400, 'state must be idle, thinking or working')
    setPresence(b.state, str(b.detail, 120), str(b.thread, 200)) // no thread keeps the focus
    return json(presence)
  }

  // ---------- agent-published lists: slash commands and peer sessions ----------
  const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
  const listUpdated = (name: string) => (db.query('SELECT updated FROM lists_meta WHERE name = ?').get(name) as { updated: number } | null)?.updated ?? null

  function commands() {
    const rows = db.query('SELECT name, description, args FROM commands ORDER BY pos').all() as { name: string; description: string | null; args: string | null }[]
    return { commands: rows.map(r => ({ name: r.name, ...(r.description ? { description: r.description } : {}), ...(r.args ? { args: r.args } : {}) })), updated: listUpdated('commands') }
  }
  function peers() {
    const rows = db.query('SELECT name, kind, state, detail, project, icon FROM peers ORDER BY pos').all() as Record<string, string | null>[]
    return {
      peers: rows.map(({ icon, ...r }) => ({
        ...Object.fromEntries(Object.entries(r).filter(([, v]) => v != null)),
        // The name in the url changes with the image, so the browser may cache it for good.
        ...(icon ? { icon: `api/icons/${icon}` } : {}),
      })),
      updated: listUpdated('peers'),
    }
  }
  const icons = iconResolver({ cacheDir: join(dataDir, 'icons'), roots: opts.iconRoots ?? [homedir()], sources: opts.iconSources })

  async function iconFile(name: string): Promise<Response> {
    const p = icons.path(name)
    const file = p && Bun.file(p)
    if (!file || !(await file.exists())) return err(404, 'not found')
    return new Response(file, { headers: {
      'content-type': name.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
      'cache-control': 'private, max-age=31536000, immutable',
      // An SVG opened directly must not run as a page of this origin.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    } })
  }

  async function agentCommands(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const list = Array.isArray(b) ? b : b?.commands
    if (!Array.isArray(list)) return err(400, 'array of commands expected')
    const ins = db.query('INSERT OR REPLACE INTO commands (name, description, args, pos) VALUES (?, ?, ?, ?)')
    let n = 0
    db.transaction(() => {
      db.exec('DELETE FROM commands')
      list.forEach((c: any, i: number) => {
        const name = typeof c?.name === 'string' ? c.name.replace(/^\//, '').trim() : ''
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return
        ins.run(name, str(c.description, 200), str(c.args, 80), i); n++
      })
      db.query('INSERT OR REPLACE INTO lists_meta (name, updated) VALUES (?, ?)').run('commands', Date.now())
    })()
    broadcastUser('commands', commands())
    return json({ ok: true, count: n })
  }

  async function agentPeers(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const list = Array.isArray(b) ? b : b?.peers
    if (!Array.isArray(list)) return err(400, 'array of peers expected')
    const updated = typeof b?.updated === 'number' ? b.updated : typeof b?.updated === 'string' ? Date.parse(b.updated) || Date.now() : Date.now()
    const iconOf = await Promise.all(list.map((p: any) => icons.resolve(str(p?.path, 500))))
    const ins = db.query('INSERT OR REPLACE INTO peers (name, kind, state, detail, project, path, icon, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    let n = 0
    // A name the app can't address is refused, and said so: `rejected` lists each with why.
    const rejected: { name: string; reason: string }[] = []
    const seen = new Set<string>()
    db.transaction(() => {
      db.exec('DELETE FROM peers')
      list.forEach((p: any, i: number) => {
        const raw = typeof p?.name === 'string' ? p.name : ''
        const name = raw.replace(/^@/, '').trim().normalize('NFC')
        const why = !name ? 'no name' : name.length > 64 ? 'longer than 64 characters'
          : !PEER_NAME.test(name) ? 'only letters, digits, _ . and - (no spaces)' : seen.has(name) ? 'listed twice' : null
        if (why) { rejected.push({ name: raw.slice(0, 80), reason: why }); return }
        seen.add(name)
        ins.run(name, str(p.kind, 40), str(p.state, 40), str(p.detail, 300), str(p.project, 100), str(p.path, 500), iconOf[i], i); n++
      })
      db.query('INSERT OR REPLACE INTO lists_meta (name, updated) VALUES (?, ?)').run('peers', updated)
    })()
    broadcastUser('peers', peers())
    if (rejected.length) log(`hub: set_peers refused ${rejected.map(r => `"${r.name}" (${r.reason})`).join(', ')}`)
    return json({ ok: true, count: n, rejected })
  }

  // Background tasks the agent has running (helpers, builds, waiting on a peer).
  const TASK_STATES = new Set(['running', 'waiting', 'done'])
  function tasks() {
    const rows = db.query('SELECT id, title, state, detail, started, thread FROM tasks ORDER BY pos').all() as { id: string; title: string; state: string; detail: string | null; started: number | null; thread: string | null }[]
    return {
      tasks: rows.map(r => ({ id: r.id, title: r.title, state: r.state, ...(r.detail ? { detail: r.detail } : {}), ...(r.started != null ? { started: new Date(r.started).toISOString() } : {}), ...(r.thread ? { thread: r.thread } : {}) })),
      updated: listUpdated('tasks'),
    }
  }

  async function agentTasks(req: Request): Promise<Response> {
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const list = Array.isArray(b) ? b : b?.tasks
    if (!Array.isArray(list)) return err(400, 'array of tasks expected')
    const ins = db.query('INSERT OR REPLACE INTO tasks (id, title, state, detail, started, pos, thread) VALUES (?, ?, ?, ?, ?, ?, ?)')
    let n = 0
    db.transaction(() => {
      db.exec('DELETE FROM tasks')
      list.forEach((t: any, i: number) => {
        const id = str(typeof t?.id === 'number' ? String(t.id) : t?.id, 64)
        const title = str(t?.title, 80)
        if (!id || !title) return
        const st = String(t.state ?? 'running').toLowerCase()
        const started = typeof t.started === 'number' ? t.started : typeof t.started === 'string' ? Date.parse(t.started) || null : null
        ins.run(id, title, TASK_STATES.has(st) ? st : 'running', str(t.detail, 200), started, i, str(t.thread, 200)); n++
      })
      db.query('INSERT OR REPLACE INTO lists_meta (name, updated) VALUES (?, ?)').run('tasks', Date.now())
    })()
    broadcastUser('tasks', tasks())
    return json({ ok: true, count: n })
  }

  // ---------- panes: agent sessions in a terminal multiplexer (off unless configured) ----------
  // Reads are cheap; every write re-reads the list first, so only a pane that is an agent
  // right now can be a target, and it is recorded in pane_actions.
  let shells: Shells | null = null
  /** Every pane id seen running an agent since the hub started (never offered as a terminal to share). */
  const agentPanes = new Set<string>()
  const paneProviders = [
    ...(opts.herdrBin ? [herdrProvider({ bin: opts.herdrBin, socket: opts.herdrSocket, shells: () => shells?.ids() ?? new Set() })] : []),
    ...(opts.rexBin ? [rexProvider({ bin: opts.rexBin, shells: () => shells?.ids() ?? new Set() })] : []),
  ]
  const paneProvider = opts.paneProvider ?? (paneProviders.length ? combinedProvider(paneProviders) : null)
  const panes = paneProvider && createPaneWatcher({
    provider: paneProvider,
    watched: () => userClients.size > 0,
    onChange: (list, updated) => {
      for (const p of list) if (p.agent !== 'shell') agentPanes.add(p.id)
      broadcastUser('panes', { panes: withShellModes(list), updated: new Date(updated).toISOString() })
      noteProjects(list.map(p => ({ project: p.project, path: p.cwd }))).catch(() => {})
    },
    onBlocked: p => sendPush({ title: (p.project ?? '').toLowerCase() === agentName.toLowerCase() ? agentName : p.title, body: 'Waiting for you', thread: null, id: null, tag: `pane:${p.id}`, pane: p.id, url: `/?pane=${encodeURIComponent(p.id)}` }),
    ...opts.paneTiming,
    log,
  })
  panes?.start()
  const paneNow = opts.paneTiming?.now ?? Date.now
  // Shells (off unless HUB_SHELLS is set and there is a multiplexer to open them in).
  const shellAuth = opts.shellAuth ?? { lockOn: () => lock.enabled(), steppedUp: (r: Request) => lock.steppedUp(r) }
  let shellTimer: ReturnType<typeof setInterval> | undefined
  if (opts.shells && panes) {
    const roots = opts.iconRoots ?? [homedir()]
    const cfg = loadShellsConfig(opts.shellsFile ?? join(dataDir, 'shells.json'), roots)
    for (const e of cfg.errors) log(`hub: ${e}`)
    const rex = opts.rexBin ? rexShellBackend({ bin: opts.rexBin }) : null
    const herdr = opts.herdrBin ? herdrShellBackend({ bin: opts.herdrBin, socket: opts.herdrSocket }) : null
    const backends = opts.shellBackends ?? (opts.shells === 'herdr' ? [herdr, rex] : [rex, herdr]).filter((b): b is ShellBackend => !!b)
    if (!backends.length || (opts.shells === 'rex' && !rex) || (opts.shells === 'herdr' && !herdr)) log(`hub: HUB_SHELLS=${opts.shells}, but there is no multiplexer to open shells in`)
    else {
      const projectPath = db.query('SELECT path FROM projects WHERE lower(name) = ? AND path IS NOT NULL')
      // A project's folder: shells.json first, else what the hub learnt from topics, sessions and icons.
      const folderOf = (key: string) => cfg.deny.has(key) ? null
        : cfg.folders.get(key) ?? (projectPath.get(key) as { path: string } | null)?.path ?? icons.folder(key)
      // Never offered for sharing: a pane the hub has seen running an agent, or named after one.
      const sh = createShells({ db, backends, folderOf, roots, log, now: opts.paneTiming?.now, share: cfg.share, denied: k => cfg.deny.has(k),
        neverShare: s => agentPanes.has(s.id) || /\b(claude|codex|gemini|opencode|aider)\b/i.test(s.title) })
      shells = sh
      sh.onChange(() => { panes.refresh().catch(() => {}) })
      sh.closeAll('hub restart').catch(() => {})
      shellTimer = setInterval(() => sh.sweep().catch(() => {}), 60_000)
      log(`hub: shells on (new ones in ${backends[0].name}; sharing ${cfg.share ? `on, from ${backends.map(b => b.name).join(' and ')}` : 'off'})`)
    }
  }
  /** A shell pane says whether the hub opened it or the user shared it. */
  const withShellModes = (list: Pane[]) => shells ? list.map(p => p.agent === 'shell' ? { ...p, shell: shells!.get(p.id)?.mode ?? 'opened' } : p) : list
  const shellErr = (e: unknown) => e instanceof ShellError ? json({ error: e.message, code: e.code }, e.status) : paneErr(e)
  const paneAction = (pane: string, title: string, action: string, payload: unknown, login: string) =>
    db.query('INSERT INTO pane_actions (ts, pane, title, action, payload, login) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), pane, title, action, JSON.stringify(payload), login)

  async function shellsApi(req: Request, path: string, login: string): Promise<Response> {
    if (req.method !== 'POST') return err(405, 'method not allowed')
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json') || req.headers.get('x-hub-action') !== '1') return err(403, 'X-Hub-Action header and a JSON body required')
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const sh = shells!
    try {
      const m = /^\/api\/shells\/([^/]{1,100})\/(close|disarm)$/.exec(path)
      if (!m && !shellAuth.lockOn()) throw new ShellError('lock_off', 403, 'turn the lock on first (Settings)')
      if (path === '/api/shells') {
        // From a session's screen: a shell in that session's folder.
        let at: string | null = null
        if (b?.pane != null) {
          const p = await paneById(String(b.pane))
          if (!p || p.agent === 'shell') throw new ShellError('no_folder', 404, 'no such session')
          at = p.cwd ?? ''
        }
        const r = await sh.open(String(b?.project ?? ''), login, shellAuth.steppedUp(req), at)
        if (!r.reused) paneAction(r.id, 'Shell', 'shell-open', b?.pane != null ? { pane: b.pane, cwd: at } : { project: b.project }, login)
        return json(r)
      }
      // The user's own terminals that could be shown (needs a fresh Face ID: it lists what's open).
      if (path === '/api/shells/shareable') {
        if (!shellAuth.steppedUp(req)) throw new ShellError('stepup', 403, 'stepup required')
        return json({ terminals: (await sh.shareable()).map(t => ({ id: t.id, title: t.title, cwd: t.cwd, project: t.project, backend: t.backend })) })
      }
      if (path === '/api/shells/share') {
        const id = String(b?.id ?? '')
        const r = await sh.share(id, login, shellAuth.steppedUp(req))
        if (!r.reused) paneAction(id, 'Shared terminal', 'shell-share', {}, login)
        return json(r)
      }
      if (!m) return err(404, 'not found')
      const id = decodeURIComponent(m[1]), r = sh.get(id)
      if (!r) return err(404, 'no such shell')
      if (m[2] === 'disarm') { sh.disarm(id); return json({ ok: true }) }
      await sh.close(id, r.mode === 'shared' ? 'stopped sharing in the app' : 'closed in the app')
      paneAction(id, `Shell · ${r.project}`, r.mode === 'shared' ? 'shell-unshare' : 'shell-close', {}, login)
      return json({ ok: true })
    } catch (e) { return shellErr(e) }
  }

  const claudeDir = opts.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

  function paneErr(e: unknown): Response {
    if (!(e instanceof PaneError)) return err(502, String((e as Error)?.message ?? e))
    const status = e.code === 'agent_blocked' ? 409 : e.code === 'agent_not_found' ? 404 : e.code === 'timeout' ? 504 : 502
    return json({ error: e.message, code: e.code }, status)
  }

  async function paneById(id: string) {
    const list = await panes!.refresh()
    return list.find(p => p.id === id) ?? null
  }

  async function panesApi(req: Request, url: URL, login: string): Promise<Response> {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/panes') {
      try { await panes!.refresh() } catch (e) { return paneErr(e) }
      const cur = panes!.current()
      return json({ panes: withShellModes(cur.panes), updated: new Date(cur.updated).toISOString() })
    }
    const m = /^\/api\/panes\/([^/]{1,100})\/(screen|history|keys|prompt|text)$/.exec(path)
    if (!m) return err(404, 'not found')
    const id = decodeURIComponent(m[1]), what = m[2]

    if (what === 'screen') {
      if (req.method !== 'GET') return err(405, 'method not allowed')
      const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 60, 1), 400)
      try {
        const p = await paneById(id)
        if (!p) return err(404, 'pane not found')
        // ?ansi=1: also the screen with its colors (SGR escapes only); `text` stays plain.
        if (url.searchParams.get('ansi') === '1') {
          const ansi = await paneProvider!.screen(id, lines, { ansi: true })
          return json({ id, text: stripAnsi(ansi), ansi, status: p.status, updated: new Date(paneNow()).toISOString() })
        }
        const text = await paneProvider!.screen(id, lines)
        return json({ id, text, status: p.status, updated: new Date(paneNow()).toISOString() })
      } catch (e) { return paneErr(e) }
    }

    // Earlier turns of a Claude Code session, from its transcript, a page at a time going back.
    // `before` is the `next` of the page after; it only counts for the same `session`.
    if (what === 'history') {
      if (req.method !== 'GET') return err(405, 'method not allowed')
      try {
        const p = await paneById(id)
        if (!p) return err(404, 'pane not found')
        const pid = p.agent === 'claude' && paneProvider!.agentPid ? await paneProvider!.agentPid(id).catch(() => null) : null
        const t = p.agent === 'claude' ? findTranscript({ claudeDir, pid, cwd: pid == null ? p.cwd : null }) : null
        if (!t) return json({ error: 'no transcript for this session', code: 'no_transcript' }, 404)
        const raw = url.searchParams.get('before')
        const before = raw != null && /^\d{1,15}$/.test(raw) && url.searchParams.get('session') === t.session ? Number(raw) : null
        const page = readTranscript(t.path, { before, limit: Number(url.searchParams.get('limit')) || 20 })
        return json({ id, session: t.session, ...page })
      } catch (e) { return paneErr(e) }
    }

    if (req.method !== 'POST') return err(405, 'method not allowed')
    // CSRF guard: a plain form or no-cors fetch can't set these, and the hub answers no CORS preflight.
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json') || req.headers.get('x-hub-action') !== '1') return err(403, 'X-Hub-Action header and a JSON body required')
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    let payload: string[] | string
    // One of the hub's shells: one line at a time, Ctrl-C as a key, a confirm for risky commands,
    // and a fresh Face ID after a pause (shells.checkWrite).
    const shell = shells?.get(id) ?? null
    if (what === 'keys') {
      const keys = b?.keys
      if (!Array.isArray(keys) || !keys.length || keys.length > PANE_MAX_KEYS) return err(400, `keys: 1 to ${PANE_MAX_KEYS} keys`)
      const bad = keys.find((k: unknown) => typeof k !== 'string' || !(PANE_KEYS.has(k) || (shell && k === 'ctrl+c')))
      if (bad !== undefined) return err(400, `key not allowed: ${String(bad).slice(0, 20)}`)
      payload = keys
    } else {
      const text = b?.text
      if (typeof text !== 'string' || !text.trim() || text.length > PANE_PROMPT_MAX) return err(400, `text: 1 to ${PANE_PROMPT_MAX} characters`)
      if (what === 'text' && PANE_TEXT_BAD.test(text)) return err(400, 'text: no control characters (send Enter as a key)')
      if (shell && what === 'text') return err(400, 'a shell takes one command at a time')
      if (shell && PANE_TEXT_BAD.test(text)) return err(400, 'one line: a shell takes one command at a time')
      payload = text
    }
    if (shell) {
      try {
        if (!shellAuth.lockOn()) throw new ShellError('lock_off', 403, 'turn the lock on first (Settings)')
        await shells!.checkWrite(id, shellAuth.steppedUp(req))
      } catch (e) { return shellErr(e) }
      const risk = what === 'prompt' ? riskOf(payload as string) : null
      if (risk && b?.confirm !== true) return json({ error: `this command ${risk}`, code: 'confirm', reason: risk }, 409)
    }
    try {
      const p = await paneById(id)
      if (!p) return err(404, 'pane not found')
      if (what === 'keys') await paneProvider!.keys(id, payload as string[])
      else if (what === 'text') await paneProvider!.text(id, payload as string)
      else await paneProvider!.prompt(id, payload as string)
      db.query('INSERT INTO pane_actions (ts, pane, title, action, payload, login) VALUES (?, ?, ?, ?, ?, ?)')
        .run(Date.now(), id, p.title, what, JSON.stringify(payload), login)
      log(`hub: pane ${id} ${p.title} ${what === 'keys' ? `keys [${(payload as string[]).join(' ')}]` : `${what} (${(payload as string).length} chars)`} by ${login}`)
      return json({ ok: true })
    } catch (e) {
      log(`hub: pane ${id} ${what} by ${login} failed: ${(e as Error).message ?? e}`)
      return paneErr(e)
    }
  }

  function agentHistory(url: URL): Response {
    const thread = url.searchParams.get('thread')
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 200)
    const rows = (thread
      ? db.query(`SELECT * FROM messages WHERE kind != 'reaction' AND thread = ? ORDER BY id DESC LIMIT ${limit}`).all(thread)
      : db.query(`SELECT * FROM messages WHERE kind != 'reaction' ORDER BY id DESC LIMIT ${limit}`).all()) as MessageRow[]
    const out = present(rows.reverse()).map(m => ({ ...m, files: m.files.map(f => ({ ...f, path: getFile(f.id)?.path })) }))
    return json(out)
  }

  // ---------- static ----------
  // The app frames only its tools' origins, and nothing may frame the app.
  const shellCsp = `frame-src 'self' ${[...new Set([...tools.values()].map(t => t.origin))].join(' ')}`.trim() + "; frame-ancestors 'none'"
  // ---------- the app's icon: the mark made from the agent's name and a seed (web/mark.js) ----------
  // SVGs are drawn on each request; PNGs are drawn once per seed and kept in data/app-icons/.
  // Changing the seed (Settings → Appearance) changes every icon; iOS keeps a Home Screen icon
  // until the app is added again.
  const ICON_FILES: Record<string, { kind: 'icon' | 'mark' | 'maskable'; size?: number }> = {
    '/icons/icon.svg': { kind: 'icon' }, '/icons/mark.svg': { kind: 'mark' }, '/icons/maskable.svg': { kind: 'maskable' },
    '/icons/icon-192.png': { kind: 'icon', size: 192 }, '/icons/icon-512.png': { kind: 'icon', size: 512 },
    '/icons/maskable-512.png': { kind: 'maskable', size: 512 }, '/icons/apple-touch-icon-180.png': { kind: 'maskable', size: 180 },
    '/icons/favicon-64.png': { kind: 'icon', size: 64 },
  }
  const iconSeed = () => Number((db.query("SELECT value FROM settings WHERE key = 'icon_seed'").get() as { value: string } | null)?.value ?? 0) || 0 // -1: the original mark
  const iconDir = join(dataDir, 'app-icons')
  try { rmSync(iconDir, { recursive: true, force: true }) } catch {} // drawn again on demand
  function appIcon(path: string): Response | null {
    const f = ICON_FILES[path]
    if (!f) return null
    const p = markParams(agentName, iconSeed())
    const headers = { 'cache-control': 'no-cache' }
    const svg = markSvg(p, f.kind)
    if (!f.size) return new Response(svg, { headers: { ...headers, 'content-type': 'image/svg+xml' } })
    // Keyed by the drawing itself, so a change to the mark's rules never serves an old PNG.
    const key = `${hash(svg).toString(36)}-${f.size}.png`
    const file = join(iconDir, key)
    if (!existsSync(file)) {
      mkdirSync(iconDir, { recursive: true })
      // An iOS Home Screen icon is square (iOS rounds it): the apple-touch one is full-bleed.
      writeFileSync(file, encodePng(rasterize(markShapes(p, f.kind), f.size), f.size, f.size))
    }
    return new Response(Bun.file(file), { headers: { ...headers, 'content-type': 'image/png' } })
  }
  // ---------- the companion (Settings → Companion; hub/companion.ts) ----------
  const updates = updateChecker(opts.checkout?.dir ?? join(import.meta.dir, '..'), { everyMs: opts.checkout?.everyMs })
  const companion = (): CompanionInfo => { try { return JSON.parse((db.query("SELECT value FROM settings WHERE key = 'companion'").get() as { value: string } | null)?.value ?? '{}') } catch { return {} } }
  async function agentCompanion(req: Request): Promise<Response> {
    if (req.method === 'GET') return json(companion())
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const cur = companion(), next: CompanionInfo = { ...cur }
    if (b?.folder !== undefined) {
      if (!validFolder(b.folder)) return err(400, 'folder: an absolute path to a folder')
      next.folder = b.folder
    }
    // The engine reports when its session starts: that's "running since".
    if (typeof b?.engine === 'string' && b.engine.trim()) { next.engine = b.engine.trim().slice(0, 60); next.since = Date.now() }
    const model = modelLabel(b?.model)
    if (model) next.model = model
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('companion', ?)").run(JSON.stringify(next))
    return json({ ok: true, ...next })
  }
  async function companionApi(): Promise<Response> {
    const c = companion(), soul = readCompanionFile(c.folder, 'SOUL.md')
    return json({
      name: agentName, role: soul ? roleFromSoul(soul) : null,
      engine: c.engine ?? null, model: c.model ?? null, since: c.since ?? null,
      folder: c.folder ? tilde(c.folder) : null, files: companionFiles(c.folder),
      bebop: { running: codeVersion, ...(await updates.status()) },
    })
  }
  function companionFile(name: string): Response {
    const text = readCompanionFile(companion().folder, name)
    return text == null ? err(404, 'no such file') : new Response(text, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } })
  }
  function setIconSeed(seed: number) {
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('icon_seed', ?)").run(String(seed))
    broadcastUser('icon', { seed })
  }
  async function iconApi(req: Request): Promise<Response> {
    if (req.method === 'GET') return json({ name: agentName, seed: iconSeed() })
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    const seed = b?.seed
    if (!Number.isInteger(seed) || seed < -1 || seed > 99999) return err(400, 'seed: a whole number from 0 to 99999, or -1 for the original mark')
    setIconSeed(seed)
    log(`hub: icon seed ${seed}`)
    return json({ ok: true, seed })
  }

  function serveStatic(path: string): Response | null {
    if (path === '/' || path === '/index.html') {
      const html = readFileSync(join(webDir, 'index.html'), 'utf8').replaceAll('{{NAME}}', escapeHtml(agentName))
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': shellCsp } })
    }
    const icon = appIcon(path)
    if (icon) return icon
    if (path === '/manifest.webmanifest') {
      return new Response(JSON.stringify({
        name: agentName, short_name: agentName, start_url: './', scope: './', display: 'standalone',
        background_color: '#f6f5f2', theme_color: '#f6f5f2',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      }), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' } })
    }
    const rel = normalize(decodeURIComponent(path)).replace(/^\/+/, '')
    if (rel.startsWith('..') || rel.includes('\0')) return null
    const full = join(webDir, rel)
    if (!full.startsWith(webDir) || !existsSync(full) || !statSync(full).isFile()) return null
    return new Response(Bun.file(full), { headers: { 'cache-control': 'no-cache' } })
  }

  // ---------- routing ----------
  const server = Bun.serve({
    port,
    hostname: opts.hostname ?? '127.0.0.1',
    maxRequestBodySize: maxUpload + 1024 * 1024,
    idleTimeout: 120,
    async fetch(req, server) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      // A project session's note for the agent: a peer token opens this one route and nothing else.
      if (path.startsWith('/peer/')) {
        const project = peerAuth(req)
        if (!project) return err(401, 'unauthorized')
        if (method === 'POST' && path === '/peer/tell') return peerTell(req, project)
        return err(404, 'not found')
      }

      if (path.startsWith('/agent/')) {
        if (!agentAuth(req)) return err(401, 'unauthorized')
        if (method === 'GET' && path === '/agent/stream') {
          return sseStream(server, req, c => {
            const sent = new Set<number>()
            agentClients.set(c, sent)
            listeningChanged()
            // Messages handed to a watcher and waiting for the agent to show it read them aren't
            // sent again yet: the agent restarts its watcher right after waking, before reading.
            for (const r of q.undelivered.all() as MessageRow[]) { sent.add(r.id); if (!handed.has(r.id)) c.send('message', forAgent(r), r.id) }
          }, c => { if (agentClients.delete(c)) listeningChanged() })
        }
        if (path === '/agent/icon' && (method === 'GET' || method === 'POST')) return iconApi(req)
        if (method === 'GET' && path === '/agent/version') return json({ commit: codeVersion, started: hubStarted })
        if (path === '/agent/companion' && (method === 'GET' || method === 'POST')) return agentCompanion(req)
        // A health check (channel/check.ts): a probe goes to every open agent stream and is
        // neither stored nor shown in the app. The watcher ignores it (it isn't a message).
        if (method === 'POST' && path === '/agent/probe') {
          const b = await req.json().catch(() => null) as { nonce?: unknown } | null
          const nonce = typeof b?.nonce === 'string' ? b.nonce.slice(0, 64) : ''
          if (!nonce) return err(400, 'nonce required')
          for (const c of agentClients.keys()) c.send('probe', { nonce })
          return json({ ok: true, listeners: agentClients.size })
        }
        // Any other agent POST is a sign of life: the session is running after the hand-off.
        // Except going idle: Stop and SessionEnd hooks report that, and SessionEnd also fires
        // when a session dies, which is exactly when a hand-off may have been lost.
        if (method === 'POST' && !['/agent/ack', '/agent/handed', '/agent/probe'].includes(path)) {
          const idle = path === '/agent/presence' && (await req.clone().json().catch(() => null))?.state === 'idle'
          if (!idle) confirmHanded()
        }
        if (method === 'POST' && path === '/agent/handed') {
          const b = await req.json().catch(() => null) as { ids?: unknown } | null
          const ids = Array.isArray(b?.ids) ? b!.ids.filter(Number.isInteger) as number[] : []
          const newest = ids.length ? db.query(`SELECT thread FROM messages WHERE sender = 'user' AND kind != 'reaction' AND delivered_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(...ids) as { thread: string | null } | null : null
          if (newest) setFocus(newest.thread)
          const live = ids.length ? (db.query(`SELECT id FROM messages WHERE ${INBOUND} AND delivered_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number }[]) : []
          const now = Date.now()
          for (const { id } of live) handed.set(id, now)
          return json({ ok: true, handed: live.length })
        }
        if (method === 'POST' && path === '/agent/ack') {
          const b = await req.json().catch(() => null) as { ids?: unknown } | null
          const ids = Array.isArray(b?.ids) ? b!.ids.filter(Number.isInteger) as number[] : []
          // The newest message it hadn't seen says what it's on now. A reaction isn't a turn.
          const newest = ids.length ? db.query(`SELECT thread FROM messages WHERE sender = 'user' AND kind != 'reaction' AND delivered_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(...ids) as { thread: string | null } | null : null
          if (newest) setFocus(newest.thread)
          if (ids.length) db.query(`UPDATE messages SET delivered_at = ? WHERE ${INBOUND} AND delivered_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(Date.now(), ...ids)
          for (const id of ids) { handed.delete(id); redelivered.delete(id) }
          return json({ ok: true, acked: ids.length })
        }
        if (method === 'POST' && path === '/agent/send') return agentSend(req)
        if (method === 'POST' && path === '/agent/upload') return upload(req)
        if (method === 'POST' && path === '/agent/update') return agentUpdate(req)
        if (method === 'POST' && path === '/agent/react') return agentReact(req)
        if (method === 'POST' && path === '/agent/resolve') return agentResolve(req)
        if (method === 'POST' && path === '/agent/threads') return agentThreads(req)
        if (method === 'POST' && path === '/agent/topics') return agentTopics(req)
        if (method === 'POST' && path === '/agent/topics/project') return agentTopicProjects(req)
        const pl = /^\/agent\/projects\/([^/]{1,300})\/link$/.exec(path)
        if (method === 'POST' && pl) return projectLinkApi(req, decodeURIComponent(pl[1]))
        const mm = /^\/agent\/threads\/([^/]{1,200})\/messages$/.exec(path)
        if (method === 'POST' && mm) return agentMoveMessages(req, decodeURIComponent(mm[1]))
        const tm = /^\/agent\/threads\/([^/]{1,200})$/.exec(path)
        if (method === 'POST' && tm) return agentThread(req, decodeURIComponent(tm[1]))
        if (method === 'POST' && path === '/agent/commands') return agentCommands(req)
        if (method === 'POST' && path === '/agent/peers') return agentPeers(req)
        if (method === 'POST' && path === '/agent/presence') return agentPresence(req)
        if (method === 'POST' && path === '/agent/tasks') return agentTasks(req)
        if (method === 'POST' && path === '/agent/peer-tokens') return agentPeerToken(req)
        if (method === 'GET' && path === '/agent/peer-tokens') return json(peerTokenList())
        if (method === 'POST' && path === '/agent/peer-tokens/revoke') return agentPeerRevoke(req)
        if (method === 'POST' && path === '/agent/timers') return agentTimer(req)
        if (method === 'GET' && path === '/agent/timers') return json({ timers: timerList(url.searchParams.get('all') === '1').map(timerOut) })
        if (method === 'POST' && path === '/agent/timers/cancel') return agentTimerCancel(req)
        if (method === 'GET' && path === '/agent/history') return agentHistory(url)
        // Each tool's instructions for the agent, from its manifest (operator-installed, capped).
        if (method === 'GET' && path === '/agent/tools') return json([...tools.values()].map(t => ({
          id: t.id, name: t.name, origin: t.origin, scope: t.scope, ref: t.ref,
          cli: t.manifest.agent?.cli && t.dir ? join(t.dir, t.manifest.agent.cli) : null,
          instructions: toolInstructions(t),
        })))
        const fm = /^\/agent\/file\/([\w-]+)$/.exec(path)
        if (method === 'GET' && fm) {
          const f = getFile(fm[1])
          return f ? json({ path: f.path, name: f.name, mime: f.mime, size: f.size }) : err(404, 'not found')
        }
        return err(404, 'not found')
      }

      const login = userAuth(req, server)
      if (login instanceof Response) return login

      if (path.startsWith('/api/auth/')) return lock.handle(req, path, login)
      if (path.startsWith('/api/') || path.startsWith('/files/')) {
        const locked = lock.check(req)
        if (locked) return locked
      }

      if (path.startsWith('/api/')) {
        if (method === 'GET' && path === '/api/messages') return listMessages(url)
        if (method === 'POST' && path === '/api/messages') return postUserMessage(req, login)
        if (method === 'POST' && path === '/api/upload') return upload(req)
        if (method === 'POST' && path === '/api/dictate') return dictate(req)
        if (method === 'GET' && path === '/api/threads') return json(threads())
        if (method === 'GET' && path === '/api/search') return search(url)
        const ta = /^\/api\/threads\/([^/]{1,200})\/(archive|unarchive)$/.exec(path)
        const tt = /^\/api\/threads\/([^/]{1,200})\/tools\/([a-z0-9]{1,16})$/.exec(path)
        if (method === 'POST' && tt) return openTool(req, tt[2], decodeURIComponent(tt[1]))
        const tp = /^\/api\/projects\/([^/]{1,100})\/tools\/([a-z0-9]{1,16})$/.exec(path)
        if (method === 'POST' && tp) return openProjectTool(req, tp[2], decodeURIComponent(tp[1]))
        // Compat, one release: the app from before tools asks for its board here.
        const tb = /^\/api\/threads\/([^/]{1,200})\/board$/.exec(path)
        if (method === 'POST' && tb) return openTool(req, 'board', decodeURIComponent(tb[1]), true)
        const ti = /^\/api\/tools\/([a-z0-9]{1,16})\/icon$/.exec(path)
        if (method === 'GET' && ti) return toolIcon(ti[1])
        if (method === 'POST' && ta) return json({ ok: true, thread: setThread(decodeURIComponent(ta[1]), { state: ta[2] === 'archive' ? 'archived' : null }) })
        if (method === 'GET' && path === '/api/commands') return json(commands())
        if (method === 'GET' && path === '/api/peers') return json(peers())
        const ic = /^\/api\/icons\/([^/]{1,64})$/.exec(path)
        if (method === 'GET' && ic) return iconFile(ic[1])
        if (method === 'GET' && path === '/api/presence') return json(presence)
        if (method === 'GET' && path === '/api/listening') return json(listening())
        if (path === '/api/icon') {
          if (method === 'POST' && req.headers.get('x-hub-action') !== '1') return err(403, 'X-Hub-Action header required')
          if (method === 'GET' || method === 'POST') return iconApi(req)
        }
        if (method === 'GET' && path === '/api/companion') return companionApi()
        const upl = /^\/api\/projects\/([^/]{1,300})\/link$/.exec(path)
        if (method === 'POST' && upl) {
          if (req.headers.get('x-hub-action') !== '1') return err(403, 'X-Hub-Action header required')
          return projectLinkApi(req, decodeURIComponent(upl[1]))
        }
        if (method === 'GET' && path === '/api/companion/file') return companionFile(url.searchParams.get('name') ?? '')
        if (method === 'GET' && path === '/api/tasks') return json(tasks())
        if (method === 'GET' && path === '/api/timers') return json({ timers: timerList().map(timerOut) })
        const tmr = /^\/api\/timers\/(\d{1,12})(\/cancel)?$/.exec(path)
        if (method === 'POST' && tmr) {
          if (req.headers.get('x-hub-action') !== '1') return err(403, 'X-Hub-Action header required')
          return userTimer(req, Number(tmr[1]), !!tmr[2], login)
        }
        if (method === 'POST' && path === '/api/read') {
          const b = await req.json().catch(() => null) as { thread?: string | null; last_id?: number } | null
          if (!b || !Number.isInteger(b.last_id)) return err(400, 'last_id required')
          const key = b.thread === undefined || b.thread === '*' ? '*' : (b.thread ?? '')
          db.query('INSERT INTO reads (thread, last_id) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)').run(key, b.last_id!)
          return json({ ok: true })
        }
        if (path === '/api/panes' || path.startsWith('/api/panes/')) return panes ? panesApi(req, url, login) : err(404, 'not found')
        if (path === '/api/shells' || path.startsWith('/api/shells/')) return shells ? shellsApi(req, path, login) : err(404, 'not found')
        if (method === 'GET' && path === '/api/config') return json({ name: agentName, login, panes: !!panes, dictation: !!transcribeCmd, refine: !!refineCmd, tools: [...tools.values()].map(toolInfo), agent_id: agentId, board: tools.get('board')?.origin ?? null, user_name: opts.userName ?? 'You', shells: !!shells, shell_share: !!shells?.shareOn })
        if (method === 'GET' && path === '/api/events') {
          return sseStream(server, req, c => {
            userClients.add(c)
            lock.streamOpened(req)
            if (userClients.size === 1) panes?.wake() // switch to the fast poll now, not after the slow one
          }, c => { if (userClients.delete(c)) lock.streamClosed(req) })
        }
        if (method === 'GET' && path === '/api/push/key') return json({ key: vapid.publicKey })
        if (method === 'POST' && path === '/api/push/subscribe') {
          const b = await req.json().catch(() => null) as any
          const sub = b?.subscription ?? b
          if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return err(400, 'subscription expected')
          db.query('INSERT INTO push_subs (endpoint, json, ts) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET json = excluded.json, ts = excluded.ts')
            .run(sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), Date.now())
          return json({ ok: true }, 201)
        }
        if (method === 'POST' && path === '/api/push/unsubscribe') {
          const b = await req.json().catch(() => null) as any
          if (b?.endpoint) db.query('DELETE FROM push_subs WHERE endpoint = ?').run(b.endpoint)
          return json({ ok: true })
        }
        return err(404, 'not found')
      }

      const fm = /^\/files\/([\w-]+)$/.exec(path)
      if (fm && (method === 'GET' || method === 'HEAD')) return serveFile(req, fm[1], url.searchParams.has('download'))

      if (method === 'GET') return serveStatic(path) ?? err(404, 'not found')
      return err(405, 'method not allowed')
    },
    error(e) {
      log(`hub: error: ${e?.stack ?? e}`)
      return err(500, 'internal error')
    },
  })

  armClock() // fires any timer that came due while the hub was down

  if ([...tools.values()].some(t => t.entry?.run)) {
    supervisor = superviseTools([...tools.values()], {
      ...opts.toolRun,
      logsDir: join(dataDir, 'logs', 'tools'), log,
      hubOrigins: [...new Set([...publicOrigins, `http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`])],
    })
  }

  return {
    server,
    url: `http://${server.hostname}:${server.port}`,
    token: agentToken,
    db,
    vapid,
    /** Stops serving at once; the promise resolves once run:true tools have exited too. */
    stop(): Promise<void> {
      clearTimeout(presenceTimer)
      clearInterval(shellTimer) // open shells are closed at the next start
      panes?.stop()
      for (const c of userClients) c.close()
      clearInterval(redeliverTimer)
      clockStopped = true
      clearTimeout(clockTimer)
      for (const c of agentClients.keys()) c.close()
      server.stop(true)
      db.close()
      return supervisor?.stop() ?? Promise.resolve()
    },
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
