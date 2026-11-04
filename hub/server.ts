// Bebop hub: one HTTP server, two sides.
//   user side  (/, /api/*, /files/*)  authenticated by tailscale serve's login header
//   agent side (/agent/*)             authenticated by a bearer token in data/agent.token
import type { Server } from 'bun'
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, statSync, chmodSync } from 'fs'
import { open } from 'fs/promises'
import { join, extname, basename, normalize, isAbsolute } from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
import { openDb, type MessageRow, type FileRow } from './db'
import { boundaryOf, streamMultipart } from './multipart'
import { loadVapid, sendPushToAll, type PushPayload } from './push'
import { iconResolver, type IconSource } from './icons'
import { homedir } from 'os'
import { herdrProvider, rexProvider, combinedProvider, createPaneWatcher, PaneError, stripAnsi, PANE_KEYS, PANE_MAX_KEYS, PANE_PROMPT_MAX, PANE_TEXT_BAD, type PaneProvider } from './panes'
import { runTranscriber } from './transcribe'
import { createLock, type LockOptions } from './lock'

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
  /** Path to the herdr binary: turns panes on (v0.6). Unset = /api/panes* are 404. */
  herdrBin?: string
  /** Passed to herdr as HERDR_SOCKET_PATH. */
  herdrSocket?: string
  /** Path to the Rex CLI: its agent sessions join herdr's (or stand alone). */
  rexBin?: string
  /** Origin of a Board (tldraw whiteboard) server: turns on a board per topic (docs/host-bridge.md in Board). */
  boardOrigin?: string
  /** The user's name, for places that show it to others (a board's comments). */
  userName?: string
  /** Board's answerer id for the agent (default: the agent name, lowercased, e.g. "my companion" → "my-companion"). */
  boardAnswerer?: string
  /** Folders a peer's `path` may be inside for its icon to be read (default: the home folder). */
  iconRoots?: string[]
  /** Tests: replaces the default icon sources. */
  iconSources?: IconSource[]
  /** Tests: a pane provider in place of herdr, and the watcher's timing. */
  paneProvider?: PaneProvider
  paneTiming?: { fastMs?: number; slowMs?: number; pushGapMs?: number; now?: () => number }
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

// A topic's board id: the thread id made readable for a URL ([A-Za-z0-9_-]{6,64}, as Board wants).
export const BOARD_ID = /^[A-Za-z0-9_-]{6,64}$/
export function boardIdFor(thread: string, n = 1): string {
  const suffix = n > 1 ? `-${n}` : ''
  let base = thread.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (base.length < 6) base = base ? `${base}-board` : 'board'
  if (base.length < 6) base = base.padEnd(6, '-')
  return base.slice(0, 64 - suffix.length) + suffix
}
// Board's answerer id for the agent: its name made into an id ("My Companion" → "my-companion").
export const answererIdFor = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
const boardOriginOf = (s?: string) => { try { return s ? new URL(s).origin : null } catch { return null } }

const snippet = (s: unknown, n: number) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim().slice(0, n)

export function createHub(opts: HubOptions) {
  const log = opts.log ?? ((m: string) => console.log(m))
  const dataDir = opts.dataDir
  const filesDir = join(dataDir, 'files')
  mkdirSync(filesDir, { recursive: true, mode: 0o700 })
  const db = openDb(join(dataDir, 'hub.sqlite'))
  const vapid = loadVapid(join(dataDir, 'vapid.json'))
  const vapidSubject = opts.vapidSubject ?? 'mailto:bebop@example.com'
  const agentName = opts.agentName ?? 'Bebop'
  const allowed = (opts.allowedLogins ?? []).filter(Boolean)
  const maxUpload = (opts.maxUploadMB ?? 2048) * 1024 * 1024
  const webDir = opts.webDir ?? join(import.meta.dir, '..', 'web')
  const boardOrigin = boardOriginOf(opts.boardOrigin)
  const boardAnswerer = answererIdFor(opts.boardAnswerer || agentName)
  if (opts.boardOrigin && !boardOrigin) log(`hub: HUB_BOARD_ORIGIN is not a URL: ${opts.boardOrigin}; boards are off`)

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
    insert: db.query(`INSERT INTO messages (ts, sender, source, thread, kind, body_json, reply_to, login, client_id)
      VALUES ($ts, $sender, $source, $thread, $kind, $body, $reply_to, $login, $client_id) RETURNING *`),
    get: db.query('SELECT * FROM messages WHERE id = ?'),
    byClientId: db.query('SELECT * FROM messages WHERE client_id = ?'),
    setBody: db.query('UPDATE messages SET body_json = ?, edited_at = ? WHERE id = ?'),
    // A voice note waiting for its transcript is held back from the agent.
    undelivered: db.query(`SELECT * FROM messages WHERE sender = 'user' AND delivered_at IS NULL
      AND NOT (kind = 'voice' AND json_extract(body_json, '$.transcript_status') = 'pending') ORDER BY id`),
    file: db.query('SELECT * FROM files WHERE id = ?'),
    insertFile: db.query('INSERT INTO files (id, name, mime, size, path, ts) VALUES (?, ?, ?, ?, ?, ?)'),
    unindex: db.query('DELETE FROM messages_fts WHERE rowid = ?'),
    index: db.query('INSERT INTO messages_fts (rowid, body) VALUES (?, ?)'),
    meta: db.query('SELECT * FROM thread_meta WHERE id = ?'),
    putMeta: db.query('INSERT INTO thread_meta (id, title, state, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, state = excluded.state, updated = excluded.updated'),
    putTopic: db.query('INSERT INTO thread_meta (id, title, lane, detail, history, project, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, lane = excluded.lane, detail = excluded.detail, history = excluded.history, project = excluded.project, updated = MAX(COALESCE(updated, 0), COALESCE(excluded.updated, 0))'),
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

  const fileMeta = (f: FileRow) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })

  /** The public (user-side) shape of a message. */
  function present(rows: MessageRow[]) {
    const reactions = reactionsFor(rows.map(r => r.id))
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
        ...(r.client_id ? { client_id: r.client_id } : {}),
      }
    })
  }

  /** What the agent receives for a user message. Includes local file paths. */
  function forAgent(r: MessageRow) {
    const body = bodyOf(r)
    const files = Array.isArray(body.files)
      ? body.files.map(getFile).filter(Boolean).map((f: FileRow) => ({ ...fileMeta(f), path: f.path }))
      : []
    const out: Record<string, unknown> = {
      id: r.id, ts: r.ts, kind: r.kind, thread: r.thread, reply_to: r.reply_to, user: r.login ?? 'user', body, files,
    }
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
  function deliverToAgents(r: MessageRow) {
    const payload = forAgent(r)
    for (const [c, sent] of agentClients) {
      if (sent.has(r.id)) continue
      sent.add(r.id)
      c.send('message', payload, r.id)
    }
  }

  function insert(m: { sender: 'user' | 'agent'; kind: string; body: unknown; thread?: string | null; source?: string | null; reply_to?: number | null; login?: string | null; client_id?: string | null }): MessageRow {
    const row = q.insert.get({
      ts: Date.now(), sender: m.sender, source: m.source ?? null, thread: m.thread ?? null, kind: m.kind,
      body: JSON.stringify(m.body), reply_to: m.reply_to ?? null, login: m.login ?? null, client_id: m.client_id ?? null,
    }) as MessageRow
    if (row.kind !== 'reaction') {
      indexMsg(row)
      // A new message in an archived thread brings it back. A reaction is not a new message.
      if (row.thread && q.unarchive.run(row.thread).changes) broadcastUser('threads', threads())
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
      // A comment from the topic's board: which board and comment thread, so the agent can answer there.
      const board = boardRef(b.board)
      if (board) body.board = board
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
    // An approval gates a risky action: it needs a fresh Face ID even while unlocked.
    if (target.kind === 'approval' && !lock.steppedUp(req)) return err(403, 'stepup required')
    const tb = bodyOf(target)
    if (tb.answered != null) return err(409, 'already answered')
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

  function boardRef(x: any) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !BOARD_ID.test(x.id)) return null
    const out: { id: string; thread?: string; number?: number; link?: string } = { id: x.id }
    if (typeof x.thread === 'string' && x.thread) out.thread = x.thread.slice(0, 200)
    if (Number.isInteger(x.number) && x.number > 0) out.number = x.number
    if (typeof x.link === 'string' && /^https?:\/\//.test(x.link)) out.link = x.link.slice(0, 500)
    return out
  }

  // A topic's board: made the first time it's asked for, then kept, so the link stays the same.
  function boardFor(thread: string): string {
    const cur = db.query('SELECT board FROM boards WHERE thread = ?').get(thread) as { board: string } | null
    if (cur) return cur.board
    const taken = db.query('SELECT 1 FROM boards WHERE board = ?')
    let n = 1, id = boardIdFor(thread)
    while (taken.get(id)) id = boardIdFor(thread, ++n)
    db.query('INSERT INTO boards (thread, board, created) VALUES (?, ?, ?)').run(thread, id, Date.now())
    return id
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
    const where = [`kind != 'reaction'`]
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
    const line = text.replace(/^@[\w.-]+ /, '').split('\n').map(l => l.trim()).find(Boolean)
    return line ? (line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line) : null
  }
  function threads() {
    const metas = db.query('SELECT * FROM thread_meta').all() as { id: string; title: string | null; state: string | null; updated: number | null; lane: string | null; detail: string | null; history: string | null; project: string | null }[]
    const stats = db.query(`SELECT thread, MAX(ts) AS updated FROM messages WHERE thread IS NOT NULL AND kind != 'reaction' GROUP BY thread`).all() as { thread: string; updated: number }[]
    const all = lastRead('*')
    const map = new Map<string, { id: string; title: string; state: string | null; lane: string | null; detail: string | null; history: string[]; project: string | null; updated: number; last: number | null; unread: number }>()
    for (const m of metas) map.set(m.id, { id: m.id, title: m.title ?? m.id, state: m.state, lane: m.lane, detail: m.detail, history: m.history ? m.history.split('\n') : [], project: m.project, updated: m.updated ?? 0, last: null, unread: 0 })
    for (const s of stats) {
      const t = map.get(s.thread) ?? { id: s.thread, title: s.thread, state: null, lane: null, detail: null, history: [], project: null, updated: 0, last: null, unread: 0 }
      t.updated = Math.max(t.updated, s.updated)
      t.last = s.updated
      map.set(s.thread, t)
    }
    const unreadQ = db.query(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'agent' AND kind != 'reaction' AND thread IS ? AND id > ?`)
    // A project conversation is its own topic: its id says which project, so no task has to.
    for (const t of map.values()) if (t.id.startsWith(PROJECT_THREAD)) {
      t.project ||= t.id.slice(PROJECT_THREAD.length).split('~')[0]
      if (t.title === t.id) t.title = firstLine(t.id) ?? t.title
    }
    for (const t of map.values()) t.unread = (unreadQ.get(t.id, Math.max(all, lastRead(t.id))) as { n: number }).n
    const general = (unreadQ.get(null, Math.max(all, lastRead(''))) as { n: number }).n
    return { threads: [...map.values()].sort((a, b) => b.updated - a.updated), general_unread: general, projects: projectIcons() }
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
    db.transaction(() => {
      db.exec('UPDATE thread_meta SET lane = NULL, detail = NULL, history = NULL, project = NULL')
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

  // Projects: a folder and an icon per project name, for one with topics but no peer in the
  // peers table. The folder comes from the topic's `path`, else from looking the name up under
  // the icon roots. Runs after the reply (bin/task posts with a short timeout, and a folder walk
  // can be slow) and announces the icons when they change.
  const PROJECT_RECHECK = 10 * 60 * 1000
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
    db.transaction(() => {
      db.exec('DELETE FROM peers')
      list.forEach((p: any, i: number) => {
        const name = typeof p?.name === 'string' ? p.name.replace(/^@/, '').trim() : ''
        if (!/^[\w.-]{1,64}$/.test(name)) return
        ins.run(name, str(p.kind, 40), str(p.state, 40), str(p.detail, 300), str(p.project, 100), str(p.path, 500), iconOf[i], i); n++
      })
      db.query('INSERT OR REPLACE INTO lists_meta (name, updated) VALUES (?, ?)').run('peers', updated)
    })()
    broadcastUser('peers', peers())
    return json({ ok: true, count: n })
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
  const paneProviders = [
    ...(opts.herdrBin ? [herdrProvider({ bin: opts.herdrBin, socket: opts.herdrSocket })] : []),
    ...(opts.rexBin ? [rexProvider({ bin: opts.rexBin })] : []),
  ]
  const paneProvider = opts.paneProvider ?? (paneProviders.length ? combinedProvider(paneProviders) : null)
  const panes = paneProvider && createPaneWatcher({
    provider: paneProvider,
    watched: () => userClients.size > 0,
    onChange: (list, updated) => {
      broadcastUser('panes', { panes: list, updated: new Date(updated).toISOString() })
      noteProjects(list.map(p => ({ project: p.project, path: p.cwd }))).catch(() => {})
    },
    onBlocked: p => sendPush({ title: p.title, body: 'Waiting for you', thread: null, id: null, tag: `pane:${p.id}`, pane: p.id, url: `/?pane=${encodeURIComponent(p.id)}` }),
    ...opts.paneTiming,
    log,
  })
  panes?.start()
  const paneNow = opts.paneTiming?.now ?? Date.now

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
      return json({ panes: cur.panes, updated: new Date(cur.updated).toISOString() })
    }
    const m = /^\/api\/panes\/([^/]{1,100})\/(screen|keys|prompt|text)$/.exec(path)
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

    if (req.method !== 'POST') return err(405, 'method not allowed')
    // CSRF guard: a plain form or no-cors fetch can't set these, and the hub answers no CORS preflight.
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json') || req.headers.get('x-hub-action') !== '1') return err(403, 'X-Hub-Action header and a JSON body required')
    let b: any
    try { b = await req.json() } catch { return err(400, 'invalid json') }
    let payload: string[] | string
    if (what === 'keys') {
      const keys = b?.keys
      if (!Array.isArray(keys) || !keys.length || keys.length > PANE_MAX_KEYS) return err(400, `keys: 1 to ${PANE_MAX_KEYS} keys`)
      const bad = keys.find((k: unknown) => typeof k !== 'string' || !PANE_KEYS.has(k))
      if (bad !== undefined) return err(400, `key not allowed: ${String(bad).slice(0, 20)}`)
      payload = keys
    } else {
      const text = b?.text
      if (typeof text !== 'string' || !text.trim() || text.length > PANE_PROMPT_MAX) return err(400, `text: 1 to ${PANE_PROMPT_MAX} characters`)
      if (what === 'text' && PANE_TEXT_BAD.test(text)) return err(400, 'text: no control characters (send Enter as a key)')
      payload = text
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
  function serveStatic(path: string): Response | null {
    if (path === '/' || path === '/index.html') {
      const html = readFileSync(join(webDir, 'index.html'), 'utf8').replaceAll('{{NAME}}', escapeHtml(agentName))
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
    }
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
    port: opts.port ?? 8787,
    hostname: opts.hostname ?? '127.0.0.1',
    maxRequestBodySize: maxUpload + 1024 * 1024,
    idleTimeout: 120,
    async fetch(req, server) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      if (path.startsWith('/agent/')) {
        if (!agentAuth(req)) return err(401, 'unauthorized')
        if (method === 'GET' && path === '/agent/stream') {
          return sseStream(server, req, c => {
            const sent = new Set<number>()
            agentClients.set(c, sent)
            for (const r of q.undelivered.all() as MessageRow[]) { sent.add(r.id); c.send('message', forAgent(r), r.id) }
          }, c => { agentClients.delete(c) })
        }
        if (method === 'POST' && path === '/agent/ack') {
          const b = await req.json().catch(() => null) as { ids?: unknown } | null
          const ids = Array.isArray(b?.ids) ? b!.ids.filter(Number.isInteger) as number[] : []
          // The newest message it hadn't seen says what it's on now. A reaction isn't a turn.
          const newest = ids.length ? db.query(`SELECT thread FROM messages WHERE sender = 'user' AND kind != 'reaction' AND delivered_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(...ids) as { thread: string | null } | null : null
          if (newest) setFocus(newest.thread)
          if (ids.length) db.query(`UPDATE messages SET delivered_at = ? WHERE sender = 'user' AND delivered_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(Date.now(), ...ids)
          return json({ ok: true, acked: ids.length })
        }
        if (method === 'POST' && path === '/agent/send') return agentSend(req)
        if (method === 'POST' && path === '/agent/upload') return upload(req)
        if (method === 'POST' && path === '/agent/update') return agentUpdate(req)
        if (method === 'POST' && path === '/agent/react') return agentReact(req)
        if (method === 'POST' && path === '/agent/threads') return agentThreads(req)
        if (method === 'POST' && path === '/agent/topics') return agentTopics(req)
        const mm = /^\/agent\/threads\/([^/]{1,200})\/messages$/.exec(path)
        if (method === 'POST' && mm) return agentMoveMessages(req, decodeURIComponent(mm[1]))
        const tm = /^\/agent\/threads\/([^/]{1,200})$/.exec(path)
        if (method === 'POST' && tm) return agentThread(req, decodeURIComponent(tm[1]))
        if (method === 'POST' && path === '/agent/commands') return agentCommands(req)
        if (method === 'POST' && path === '/agent/peers') return agentPeers(req)
        if (method === 'POST' && path === '/agent/presence') return agentPresence(req)
        if (method === 'POST' && path === '/agent/tasks') return agentTasks(req)
        if (method === 'GET' && path === '/agent/history') return agentHistory(url)
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
        const tb = /^\/api\/threads\/([^/]{1,200})\/board$/.exec(path)
        if (method === 'POST' && tb) return boardOrigin ? json({ board: boardFor(decodeURIComponent(tb[1])), origin: boardOrigin }) : err(404, 'boards are off')
        if (method === 'POST' && ta) return json({ ok: true, thread: setThread(decodeURIComponent(ta[1]), { state: ta[2] === 'archive' ? 'archived' : null }) })
        if (method === 'GET' && path === '/api/commands') return json(commands())
        if (method === 'GET' && path === '/api/peers') return json(peers())
        const ic = /^\/api\/icons\/([^/]{1,64})$/.exec(path)
        if (method === 'GET' && ic) return iconFile(ic[1])
        if (method === 'GET' && path === '/api/presence') return json(presence)
        if (method === 'GET' && path === '/api/tasks') return json(tasks())
        if (method === 'POST' && path === '/api/read') {
          const b = await req.json().catch(() => null) as { thread?: string | null; last_id?: number } | null
          if (!b || !Number.isInteger(b.last_id)) return err(400, 'last_id required')
          const key = b.thread === undefined || b.thread === '*' ? '*' : (b.thread ?? '')
          db.query('INSERT INTO reads (thread, last_id) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)').run(key, b.last_id!)
          return json({ ok: true })
        }
        if (path === '/api/panes' || path.startsWith('/api/panes/')) return panes ? panesApi(req, url, login) : err(404, 'not found')
        if (method === 'GET' && path === '/api/config') return json({ name: agentName, login, panes: !!panes, dictation: !!transcribeCmd, refine: !!refineCmd, board: boardOrigin, board_answerer: boardOrigin ? boardAnswerer : null, user_name: opts.userName ?? 'You' })
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

  return {
    server,
    url: `http://${server.hostname}:${server.port}`,
    token: agentToken,
    db,
    vapid,
    stop() {
      clearTimeout(presenceTimer)
      panes?.stop()
      for (const c of userClients) c.close()
      for (const c of agentClients.keys()) c.close()
      server.stop(true)
      db.close()
    },
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
