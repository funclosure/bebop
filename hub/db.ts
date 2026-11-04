import { Database } from 'bun:sqlite'

export type Sender = 'user' | 'agent'

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
}

export type FileRow = { id: string; name: string; mime: string; size: number; path: string; ts: number }

function createToolInstances(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_instances (
    tool TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'topic', scope_key TEXT NOT NULL, instance TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY (tool, scope, scope_key), UNIQUE (tool, instance)
  )`)
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      sender TEXT NOT NULL CHECK (sender IN ('user','agent')),
      source TEXT,
      thread TEXT,
      kind TEXT NOT NULL,
      body_json TEXT NOT NULL,
      reply_to INTEGER,
      delivered_at INTEGER,
      edited_at INTEGER,
      login TEXT,
      client_id TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, id);
    CREATE INDEX IF NOT EXISTS messages_undelivered ON messages(sender, delivered_at);
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
  // v0.8: topics. A thread's lane (who's next) and one-line detail, separate from its state.
  const metaCols = (db.query('PRAGMA table_info(thread_meta)').all() as { name: string }[]).map(c => c.name)
  if (!metaCols.includes('lane')) db.exec('ALTER TABLE thread_meta ADD COLUMN lane TEXT')
  if (!metaCols.includes('detail')) db.exec('ALTER TABLE thread_meta ADD COLUMN detail TEXT')
  if (!metaCols.includes('history')) db.exec('ALTER TABLE thread_meta ADD COLUMN history TEXT')
  if (!metaCols.includes('project')) db.exec('ALTER TABLE thread_meta ADD COLUMN project TEXT')
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
