import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'

export type Sender = 'user' | 'agent' | 'peer' | 'clock'

/** Rows that go to the agent (the stream, hand-offs, acks): the user's messages, a peer's notes and
 *  the clock's timers. 'agent' rows are the agent's own. A fixed SQL condition, never user input. */
export const INBOUND = `sender IN ('user','peer','clock')`

export type MessageRow = {
  id: number
  ts: number
  sender: Sender
  source: string | null
  thread: string | null
  kind: string
  body_json: string
  reply_to: number | null
  delivered_at: number | null
  edited_at: number | null
  login: string | null
  client_id: string | null
  /** For an agent message passed on from a session (source): that session's project, as the hub knew it then. */
  source_project: string | null
}

export type FileRow = { id: string; name: string; mime: string; size: number; path: string; ts: number }

const MESSAGE_COLS = 'id, ts, sender, source, thread, kind, body_json, reply_to, delivered_at, edited_at, login, client_id'
const messagesTable = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      sender TEXT NOT NULL CHECK (sender IN ('user','agent','peer','clock')),
      source TEXT,
      thread TEXT,
      kind TEXT NOT NULL,
      body_json TEXT NOT NULL,
      reply_to INTEGER,
      delivered_at INTEGER,
      edited_at INTEGER,
      login TEXT,
      client_id TEXT UNIQUE,
      source_project TEXT
    );`
const MESSAGE_INDEXES = `CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, id);
    CREATE INDEX IF NOT EXISTS messages_undelivered ON messages(sender, delivered_at);`

/** The counts that must match before and after the messages table is rebuilt. */
function messageFacts(db: Database, table: string) {
  return db.query(`SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max_id, COALESCE(SUM(length(body_json)), 0) AS bytes,
    COUNT(delivered_at) AS delivered, COUNT(client_id) AS client_ids FROM ${table}`).get() as Record<string, number>
}

/**
 * Peers' notes and the clock's timers (sender 'peer' / 'clock') need a wider CHECK on messages.sender,
 * and SQLite can't change a CHECK in place: the table is rebuilt once, ids kept (so the search index,
 * reply_to and answers still point at the same rows) and the AUTOINCREMENT counter kept. First a copy
 * of the whole database goes next to it (<file>.before-notes). The rebuild runs in one transaction and
 * checks the counts before it commits: on any difference it rolls back, the old table stays, and the
 * hub refuses to start.
 */
export function widenSenders(db: Database, path: string, log: (m: string) => void = () => {}, test?: { afterCopy?(db: Database): void }) {
  const sql = (db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'`).get() as { sql: string } | null)?.sql ?? ''
  if (!sql || sql.includes(`'peer'`)) return
  if (path !== ':memory:') {
    let backup = `${path}.before-notes`
    for (let i = 2; existsSync(backup); i++) backup = `${path}.before-notes-${i}`
    db.query('VACUUM INTO ?').run(backup)
    log(`hub: copied the database to ${backup} before widening messages.sender`)
  }
  const before = messageFacts(db, 'messages')
  const seq = (db.query(`SELECT seq FROM sqlite_sequence WHERE name = 'messages'`).get() as { seq: number } | null)?.seq ?? 0
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS messages_v2')
      db.exec(messagesTable('messages_v2'))
      db.exec(`INSERT INTO messages_v2 (${MESSAGE_COLS}) SELECT ${MESSAGE_COLS} FROM messages ORDER BY id`)
      test?.afterCopy?.(db)
      const copied = messageFacts(db, 'messages_v2')
      for (const k of Object.keys(before)) if (copied[k] !== before[k]) throw new Error(`messages rebuild: ${k} was ${before[k]}, the copy has ${copied[k]}`)
      db.exec('DROP TABLE messages')
      db.exec('ALTER TABLE messages_v2 RENAME TO messages')
      db.exec(MESSAGE_INDEXES)
      db.query(`INSERT INTO sqlite_sequence (name, seq) SELECT 'messages', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'messages')`).run()
      db.query(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'messages'`).run(seq)
      const after = messageFacts(db, 'messages')
      for (const k of Object.keys(before)) if (after[k] !== before[k]) throw new Error(`messages rebuild: ${k} was ${before[k]}, now ${after[k]}`)
    })()
  } catch (e) {
    throw new Error(`${(e as Error).message}. Nothing was changed; the hub won't start until this is looked at.`)
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
  log(`hub: messages.sender now takes peer and clock (${before.n} messages kept, ids up to ${before.max_id})`)
}

function createToolInstances(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_instances (
    tool TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'topic', scope_key TEXT NOT NULL, instance TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY (tool, scope, scope_key), UNIQUE (tool, instance)
  )`)
}

export function openDb(path: string, log?: (m: string) => void): Database {
  const db = new Database(path, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    ${messagesTable('messages')}
    ${MESSAGE_INDEXES}
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, path TEXT NOT NULL, ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS thread_meta (id TEXT PRIMARY KEY, title TEXT, state TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS commands (name TEXT PRIMARY KEY, description TEXT, args TEXT, pos INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS peers (name TEXT PRIMARY KEY, kind TEXT, state TEXT, detail TEXT, project TEXT, pos INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, started INTEGER, pos INTEGER NOT NULL);
    -- A project's folder and icon, so one with topics but no live peer still has a face. See noteProjects in server.ts.
    CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, path TEXT, icon TEXT, checked INTEGER);
    -- A project's "Open app" link (a bookmark in its header), set by the agent. Its own table, since
    -- noteProjects rewrites projects rows. key = the project name in lowercase (the app's projectKey).
    CREATE TABLE IF NOT EXISTS project_links (key TEXT PRIMARY KEY, url TEXT NOT NULL, label TEXT, updated INTEGER NOT NULL);
    -- A topic's board (Board, the whiteboard): its own table, since POST /agent/threads rewrites thread_meta.
    -- Before tools, Board had its own table; kept (read-only) so an older hub still finds its boards.
    CREATE TABLE IF NOT EXISTS boards (thread TEXT PRIMARY KEY, board TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
    -- A project tool's pages (see tools.ts, scope): which topic each page posts into. A topic's page is
    -- its thread id; "overview" posts into one topic the hub makes per project and tool (thread is
    -- NULL until the first post). Kept here, since the agent's thread lists rewrite thread_meta.
    CREATE TABLE IF NOT EXISTS tool_pages (
      tool TEXT NOT NULL, scope_key TEXT NOT NULL, page TEXT NOT NULL, thread TEXT, title TEXT, created INTEGER NOT NULL,
      PRIMARY KEY (tool, scope_key, page)
    );
    CREATE TABLE IF NOT EXISTS lists_meta (name TEXT PRIMARY KEY, updated INTEGER);
    CREATE TABLE IF NOT EXISTS reads (thread TEXT PRIMARY KEY, last_id INTEGER NOT NULL);
    -- Small hub settings the user changes in the app (v0.6.7: icon_seed).
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Every key press or prompt the user sent to a pane (v0.6), kept as an audit trail.
    CREATE TABLE IF NOT EXISTS pane_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, pane TEXT NOT NULL, title TEXT,
      action TEXT NOT NULL, payload TEXT NOT NULL, login TEXT
    );
    -- Search index: rowid = messages.id, body = the message's searchable text (see searchText
    -- in server.ts). Trigram, so substrings match in any script, CJK included; kept in sync
    -- on every insert and body change, and backfilled for older rows at startup.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, tokenize = 'trigram');
  `)
  widenSenders(db, path, log)
  // The sender line: the project of the session an agent message was passed on from. A table made
  // or rebuilt above has it already; one widened by an earlier build gets it here (no rebuild).
  const msgCols = (db.query('PRAGMA table_info(messages)').all() as { name: string }[]).map(c => c.name)
  if (!msgCols.includes('source_project')) db.exec('ALTER TABLE messages ADD COLUMN source_project TEXT')
  db.exec(`
    -- A project's peer token (see /peer/tell): only its SHA-256 is kept; the token itself is in
    -- data/peer-tokens/<project>.token. project = the project key (its name in lowercase).
    CREATE TABLE IF NOT EXISTS peer_tokens (project TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, last_used INTEGER);
    -- The folders a project's sessions run in: bebop tell finds its project by them, and a note's files may come from them.
    CREATE TABLE IF NOT EXISTS peer_folders (folder TEXT PRIMARY KEY, project TEXT NOT NULL);
    -- The clock: a timer puts a note for the agent in its inbox when due (once, or on a repeat).
    -- state: scheduled, done (a one-off that fired) or cancelled. key: the agent's own name for it
    -- (a task id), so setting a timer with the same key moves it rather than adding one.
    CREATE TABLE IF NOT EXISTS timers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, due INTEGER NOT NULL, repeat TEXT, thread TEXT, key TEXT,
      state TEXT NOT NULL DEFAULT 'scheduled', created INTEGER NOT NULL, changed_by TEXT, changed INTEGER, fired INTEGER, fires INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS timers_key ON timers(key) WHERE state = 'scheduled' AND key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS timers_due ON timers(state, due);
  `)
  // v0.8: topics. A thread's lane (who's next) and one-line detail, separate from its state.
  const metaCols = (db.query('PRAGMA table_info(thread_meta)').all() as { name: string }[]).map(c => c.name)
  if (!metaCols.includes('lane')) db.exec('ALTER TABLE thread_meta ADD COLUMN lane TEXT')
  if (!metaCols.includes('detail')) db.exec('ALTER TABLE thread_meta ADD COLUMN detail TEXT')
  if (!metaCols.includes('history')) db.exec('ALTER TABLE thread_meta ADD COLUMN history TEXT')
  if (!metaCols.includes('project')) db.exec('ALTER TABLE thread_meta ADD COLUMN project TEXT')
  // When a topic left the agent's list (its task closed). It keeps its project; the app files it
  // under Other, as it did when closing cleared the project.
  if (!metaCols.includes('closed')) db.exec('ALTER TABLE thread_meta ADD COLUMN closed INTEGER')
  // Peers: the session's project folder and its icon in the cache (see icons.ts).
  const peerCols = (db.query('PRAGMA table_info(peers)').all() as { name: string }[]).map(c => c.name)
  if (!peerCols.includes('path')) db.exec('ALTER TABLE peers ADD COLUMN path TEXT')
  if (!peerCols.includes('icon')) db.exec('ALTER TABLE peers ADD COLUMN icon TEXT')
  // Tasks: the topic a background task belongs to, which keeps that topic live.
  const taskCols = (db.query('PRAGMA table_info(tasks)').all() as { name: string }[]).map(c => c.name)
  if (!taskCols.includes('thread')) db.exec('ALTER TABLE tasks ADD COLUMN thread TEXT')
  // Tools: a tool's instance per topic (scope 'topic', scope_key = the thread id) or per project
  // (scope 'project', scope_key = the project key, "desk" for none): made on first open, then kept,
  // so its link stays the same. Before scopes the table was (tool, thread, instance, created).
  const instCols = (db.query('PRAGMA table_info(tool_instances)').all() as { name: string }[]).map(c => c.name)
  if (instCols.length && !instCols.includes('scope_key')) db.transaction(() => {
    db.exec('ALTER TABLE tool_instances RENAME TO tool_instances_v1')
    createToolInstances(db)
    db.exec(`INSERT INTO tool_instances (tool, scope, scope_key, instance, created) SELECT tool, 'topic', thread, instance, created FROM tool_instances_v1`)
    db.exec('DROP TABLE tool_instances_v1')
  })()
  else createToolInstances(db)
  // Boards made before tools are Board's instances (idempotent, so safe on every start).
  db.exec(`INSERT OR IGNORE INTO tool_instances (tool, scope, scope_key, instance, created) SELECT 'board', 'topic', thread, board, created FROM boards`)
  return db
}
