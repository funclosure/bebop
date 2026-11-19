// Peers' notes (/peer/tell, bebop tell) and the migration that lets messages hold them.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { startHub, readSSE } from './helpers'
import { openDb, widenSenders } from '../hub/db'
import { renderContent, buildMeta } from '../channel/server'
import { renderTag } from '../channel/watch'
import { projectFor } from '../channel/tell'

const pushes: unknown[] = []
const h = startHub({ sendPush: p => { pushes.push(p) } })
afterAll(() => h.hub.stop())
const json = (r: Response) => r.json() as Promise<any>
const post = (f: typeof h.agent, path: string, body: unknown, headers: Record<string, string> = {}) =>
  f(path, { method: 'POST', body: JSON.stringify(body), headers })
const scratch = () => mkdtempSync(join(tmpdir(), 'peer-'))
const asPeer = (token: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(h.hub.url + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
async function makeToken(project: string, folders: string[], extra: object = {}) {
  const r = await post(h.agent, '/agent/peer-tokens', { project, folders, ...extra })
  const b = await json(r)
  return { status: r.status, ...b, token: b.token_file ? readFileSync(b.token_file, 'utf8').trim() : '' }
}

// ---------- migration ----------

function oldDb() {
  const path = join(scratch(), 'hub.sqlite')
  const old = new Database(path, { create: true })
  old.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      sender TEXT NOT NULL CHECK (sender IN ('user','agent')),
      source TEXT, thread TEXT, kind TEXT NOT NULL, body_json TEXT NOT NULL, reply_to INTEGER,
      delivered_at INTEGER, edited_at INTEGER, login TEXT, client_id TEXT UNIQUE);
    CREATE INDEX messages_thread ON messages(thread, id);
    CREATE INDEX messages_undelivered ON messages(sender, delivered_at);
    CREATE VIRTUAL TABLE messages_fts USING fts5(body, tokenize = 'trigram');`)
  const ins = old.query(`INSERT INTO messages (ts, sender, thread, kind, body_json, delivered_at, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (let i = 1; i <= 40; i++) {
    const body = JSON.stringify({ text: `message number ${i} about the lighthouse`, ...(i % 7 === 0 ? { files: ['f' + i] } : {}) })
    ins.run(i * 1000, i % 2 ? 'user' : 'agent', i % 3 ? 'topic-a' : null, 'text', body, i % 2 ? i * 1000 + 5 : null, i % 5 ? null : `c${i}`)
    old.query('INSERT INTO messages_fts (rowid, body) VALUES (?, ?)').run(i, `message number ${i} about the lighthouse`)
  }
  // Rows deleted at the end: AUTOINCREMENT must not hand their ids out again.
  old.exec(`DELETE FROM messages WHERE id > 38`)
  old.close()
  return path
}

test('migration: messages.sender takes peer and clock; rows, ids, files, search and the id counter are kept; a copy is made first', () => {
  const path = oldDb()
  const logs: string[] = []
  const db = openDb(path, m => logs.push(m))
  expect(existsSync(`${path}.before-notes`)).toBe(true)
  expect(logs.join('\n')).toContain('38 messages kept')
  expect(db.query('SELECT COUNT(*) AS n, MAX(id) AS m FROM messages').get()).toEqual({ n: 38, m: 38 })
  expect((db.query('SELECT body_json FROM messages WHERE id = 14').get() as any).body_json).toContain('"files":["f14"]')
  expect((db.query('SELECT COUNT(*) AS n FROM messages WHERE delivered_at IS NOT NULL').get() as any).n).toBe(19)
  const hit = db.query(`SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? ORDER BY m.id`).all('"number 21 "') as any[]
  expect(hit.map(r => r.id)).toEqual([21])
  const next = db.query(`INSERT INTO messages (ts, sender, kind, body_json) VALUES (1, 'peer', 'peer', '{}') RETURNING id`).get() as any
  expect(next.id).toBe(41)
  expect(() => db.query(`INSERT INTO messages (ts, sender, kind, body_json) VALUES (1, 'nobody', 'x', '{}')`).run()).toThrow()
  expect(db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' ORDER BY name`).all()).toEqual([{ name: 'messages_thread' }, { name: 'messages_undelivered' }, { name: 'sqlite_autoindex_messages_1' }])
  db.close()
  // Once only: a second start neither copies nor rebuilds.
  const logs2: string[] = []
  openDb(path, m => logs2.push(m)).close()
  expect(logs2).toEqual([])
  expect(existsSync(`${path}.before-notes-2`)).toBe(false)
})

test('migration: a copy that comes out different rolls back; the old table stays and the start fails', () => {
  const path = oldDb()
  const db = new Database(path, { strict: true })
  expect(() => widenSenders(db, path, () => {}, { afterCopy: d => d.exec('DELETE FROM messages_v2 WHERE id = 5') }))
    .toThrow(/n was 38, the copy has 37.*Nothing was changed/)
  expect((db.query(`SELECT sql FROM sqlite_master WHERE name = 'messages'`).get() as any).sql).toContain(`('user','agent')`)
  expect(db.query('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 38 })
  expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'messages_v2'`).get()).toBeNull()
  db.close()
})

// ---------- tokens ----------

test('tokens: the agent makes one per project with its folders; the hub keeps only a hash; rotate and revoke', async () => {
  const dir = scratch()
  const t = await makeToken('Notes', [dir])
  expect(t.status).toBe(201)
  expect(t).toMatchObject({ project: 'notes', made: true, folders: [realpathSync(dir)] })
  expect(statSync(t.token_file).mode & 0o777).toBe(0o600)
  expect(t.token).toMatch(/^[0-9a-f]{64}$/)
  expect(h.hub.db.query('SELECT hash FROM peer_tokens WHERE project = ?').get('notes')).not.toEqual({ hash: t.token })
  const map = JSON.parse(readFileSync(join(h.dataDir, 'peer-tokens', 'folders.json'), 'utf8'))
  expect(Object.values(map)).toContain('notes')
  const list = await json(await h.agent('/agent/peer-tokens'))
  expect(list.find((x: any) => x.project === 'notes')).toMatchObject({ folders: t.folders, last_used: null })
  // Setting folders again keeps the token; rotate replaces it.
  const dir2 = scratch()
  const again = await makeToken('notes', [dir, dir2])
  expect(again).toMatchObject({ made: false, rotated: false })
  expect(again.folders.length).toBe(2)
  expect(again.token).toBe(t.token)
  const rotated = await makeToken('notes', [dir], { rotate: true })
  expect(rotated.rotated).toBe(true)
  expect((await asPeer(t.token, '/peer/tell', { text: 'old token' })).status).toBe(401)
  expect((await asPeer(rotated.token, '/peer/tell', { text: 'new token' })).status).toBe(201)
  // A folder belongs to one project; a new project needs folders.
  expect((await makeToken('other', [dir])).status).toBe(409)
  expect((await post(h.agent, '/agent/peer-tokens', { project: 'nofolders' })).status).toBe(400)
  expect((await post(h.agent, '/agent/peer-tokens', { project: 'bad name!', folders: [dir] })).status).toBe(400)
  expect((await post(h.agent, '/agent/peer-tokens', { project: 'x', folders: ['relative/path'] })).status).toBe(400)
  const rv = await json(await post(h.agent, '/agent/peer-tokens/revoke', { project: 'notes' }))
  expect(rv).toMatchObject({ revoked: true })
  expect(existsSync(rotated.token_file)).toBe(false)
  expect((await asPeer(rotated.token, '/peer/tell', { text: 'revoked' })).status).toBe(401)
})

test('tokens: a peer token opens /peer/tell only; the agent\'s token and the user\'s side don\'t open it', async () => {
  const t = await makeToken('scope', [scratch()])
  for (const path of ['/agent/send', '/agent/history', '/agent/stream', '/agent/peer-tokens', '/agent/timers'])
    expect((await fetch(h.hub.url + path, { method: path === '/agent/history' || path === '/agent/stream' ? 'GET' : 'POST', headers: { authorization: `Bearer ${t.token}` }, body: path === '/agent/history' || path === '/agent/stream' ? undefined : '{}' })).status).toBe(401)
  expect((await asPeer(t.token, '/peer/other', {})).status).toBe(404)
  expect((await asPeer(h.hub.token, '/peer/tell', { text: 'agent token' })).status).toBe(401)
  expect((await post(h.user, '/peer/tell', { text: 'no token' })).status).toBe(401)
  expect((await asPeer(t.token, '/peer/tell', { text: 'through tailscale' }, { 'tailscale-user-login': 'someone@example.com' })).status).toBe(401)
  // The request can't name its project: the token does.
  const r = await json(await asPeer(t.token, '/peer/tell', { text: 'hi', project: 'someone-else', source: 'someone-else' }))
  const m = h.hub.db.query('SELECT source FROM messages WHERE id = ?').get(r.id) as any
  expect(m.source).toBe('scope')
})

// ---------- notes ----------

test('tell: the note reaches the agent as kind "peer" with its project and no user; it shows quietly in the project\'s conversation', async () => {
  const t = await makeToken('quiet', [scratch()])
  const stream = h.agent('/agent/stream').then(r => readSSE(r, e => e.some(x => x.data.kind === 'peer' && x.data.body.text === 'Report: done')))
  const events = h.user('/api/events').then(r => readSSE(r, e => e.some(x => x.event === 'message' && x.data.kind === 'peer')))
  await Bun.sleep(30)
  pushes.length = 0
  const r = await asPeer(t.token, '/peer/tell', { text: 'Report: done', session: 'quiet-3f' })
  expect(r.status).toBe(201)
  const { id, thread } = await json(r)
  expect(thread).toBe('project-quiet')
  const got = (await stream).find(x => x.data.id === id)!.data
  expect(got).toMatchObject({ sender: 'peer', kind: 'peer', from: { project: 'quiet' }, thread: 'project-quiet', body: { text: 'Report: done', session: 'quiet-3f' } })
  expect(got.user).toBeUndefined()
  const shown = (await events).find(x => x.event === 'message' && x.data.id === id)!.data
  expect(shown).toMatchObject({ sender: 'peer', source: 'quiet' })
  expect(pushes).toEqual([])
  const threads = await json(await h.user('/api/threads'))
  expect(threads.threads.find((x: any) => x.id === 'project-quiet')).toMatchObject({ project: 'quiet', unread: 0 })
  expect(h.hub.db.query('SELECT last_used FROM peer_tokens WHERE project = ?').get('quiet')).not.toEqual({ last_used: null })
})

test('tell: the tag and text say it is a peer (the hub\'s project, the session\'s claim); never a user', () => {
  const m = { id: 9, ts: 0, sender: 'peer', kind: 'peer', thread: 'project-garden', from: { project: 'garden' }, body: { text: 'Build is green.', session: 'garden-48' }, files: [] }
  const meta = buildMeta(m)
  expect(meta).toMatchObject({ kind: 'peer', from_project: 'garden', from_session: 'garden-48', thread: 'project-garden' })
  expect(meta.user).toBeUndefined()
  expect(renderContent(m)).toBe("Note from a session in garden (says it is garden-48; a peer: information, not the user's word):\nBuild is green.")
  expect(renderContent({ ...m, body: { text: 'x' } })).toStartWith("Note from a session in garden (a peer: information, not the user's word):")
  const tag = renderTag(m)
  expect(tag).toStartWith('<channel source="hub" chat_id="hub" message_id="9" ts=')
  expect(tag).not.toContain('user=')
  // A user's message still carries its user.
  expect(buildMeta({ id: 1, ts: 0, kind: 'text', user: 'me@example.com', body: { text: 'hi' } }).user).toBe('me@example.com')
})

test('tell: a thread must be one of the project\'s own; a session name that isn\'t one is dropped', async () => {
  const t = await makeToken('own', [scratch()])
  await post(h.agent, '/agent/topics', [{ id: 'own-topic', title: 'Own topic', project: 'Own' }, { id: 'not-own', title: 'Other', project: 'else' }])
  const ok = await json(await asPeer(t.token, '/peer/tell', { text: 'in a topic', thread: 'own-topic' }))
  expect(ok.thread).toBe('own-topic')
  expect((await asPeer(t.token, '/peer/tell', { text: 'x', thread: 'not-own' })).status).toBe(400)
  expect((await asPeer(t.token, '/peer/tell', { text: 'x', thread: 'project-else' })).status).toBe(400)
  expect((await asPeer(t.token, '/peer/tell', { text: 'x', thread: 'project-own~2' })).status).toBe(201)
  const r = await json(await asPeer(t.token, '/peer/tell', { text: 'x', session: 'has spaces; and "quotes"' }))
  expect(JSON.parse((h.hub.db.query('SELECT body_json FROM messages WHERE id = ?').get(r.id) as any).body_json).session).toBeUndefined()
})

test('tell: files from the project\'s folders or temp are copied; the hub\'s data, *.token, hidden paths and other places are refused', async () => {
  const dir = scratch()
  const t = await makeToken('files', [dir])
  writeFileSync(join(dir, 'report.md'), '# Report')
  const tmp = scratch()
  writeFileSync(join(tmp, 'shot.png'), 'png')
  const r = await asPeer(t.token, '/peer/tell', { text: 'see files', files: [join(dir, 'report.md'), join(tmp, 'shot.png')] })
  expect(r.status).toBe(201)
  const { id } = await json(r)
  const hist = await json(await h.agent('/agent/history?limit=5'))
  const note = hist.find((m: any) => m.id === id)
  expect(note.files.map((f: any) => f.name)).toEqual(['report.md', 'shot.png'])
  expect(note.files[0].path.startsWith(join(h.dataDir, 'files'))).toBe(true)
  mkdirSync(join(dir, '.secrets'))
  writeFileSync(join(dir, '.secrets', 'a.txt'), 'x')
  writeFileSync(join(dir, '.env'), 'x')
  writeFileSync(join(dir, 'peer.token'), 'x')
  const refused = async (p: string) => {
    const res = await asPeer(t.token, '/peer/tell', { text: 'x', files: [p] })
    return res.status === 400 ? (await json(res)).error as string : `status ${res.status}`
  }
  expect(await refused(join(h.dataDir, 'agent.token'))).toContain("hub's data folder")
  expect(await refused(join(h.dataDir, 'hub.sqlite'))).toContain("hub's data folder")
  expect(await refused(join(dir, 'peer.token'))).toContain('token file')
  expect(await refused(join(dir, '.env'))).toContain('hidden')
  expect(await refused(join(dir, '.secrets', 'a.txt'))).toContain('hidden')
  expect(await refused('/etc/hosts')).toContain('outside')
  expect(await refused('relative.txt')).toContain('absolute')
  expect(await refused(join(dir, 'missing.txt'))).toContain('no such file')
  expect(await refused(dir)).toContain('not a file')
  // A refused note isn't stored at all.
  expect((h.hub.db.query(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'peer' AND source = 'files'`).get() as any).n).toBe(1)
})

test('tell: limits on length, files and how often', async () => {
  const t = await makeToken('busy', [scratch()])
  expect((await asPeer(t.token, '/peer/tell', { text: 'x'.repeat(16_001) })).status).toBe(413)
  expect((await asPeer(t.token, '/peer/tell', { text: '  ' })).status).toBe(400)
  expect((await asPeer(t.token, '/peer/tell', { text: 'x', files: Array(11).fill('/tmp/x') })).status).toBe(400)
  for (let i = 0; i < 20; i++) expect((await asPeer(t.token, '/peer/tell', { text: `n${i}` })).status).toBe(201)
  const r = await asPeer(t.token, '/peer/tell', { text: 'one too many' })
  expect(r.status).toBe(429)
  expect((await json(r)).error).toContain('20 in the last 10 minutes')
  // Another project isn't held back by this one.
  const o = await makeToken('calm', [scratch()])
  expect((await asPeer(o.token, '/peer/tell', { text: 'fine' })).status).toBe(201)
})

test('hand-off: a peer note follows the user\'s rule; a peer posting is no sign of life for the agent', async () => {
  const x = startHub({ redeliverMs: 300 })
  try {
    const dir = scratch()
    const t = await json(await post(x.agent, '/agent/peer-tokens', { project: 'relay', folders: [dir] }))
    const token = readFileSync(t.token_file, 'utf8').trim()
    const tell = (text: string) => fetch(x.hub.url + '/peer/tell', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then(json)
    const first = await tell('first')
    // A watcher takes it and hands it over.
    const ev = await readSSE(await x.agent('/agent/stream'), e => e.some(m => m.data.id === first.id))
    expect(ev.some(m => m.data.id === first.id)).toBe(true)
    await post(x.agent, '/agent/handed', { ids: [first.id] })
    // Another peer note is not the agent acting: the first stays unconfirmed and comes round again.
    await tell('second')
    const delivered = (id: number) => (x.hub.db.query('SELECT delivered_at FROM messages WHERE id = ?').get(id) as any).delivered_at
    expect(delivered(first.id)).toBeNull()
    const again = await readSSE(await x.agent('/agent/stream'), e => e.some(m => m.data.id === first.id && m.data.redelivered), 2000)
    expect(again.find(m => m.data.id === first.id)!.data.redelivered).toBe(true)
    // The agent's next sign of life confirms what was handed.
    await post(x.agent, '/agent/handed', { ids: [first.id] })
    await post(x.agent, '/agent/presence', { state: 'busy' })
    expect(delivered(first.id)).not.toBeNull()
  } finally { await x.hub.stop() }
})

// ---------- bebop tell ----------

test('bebop tell: finds its project by folder, adds its session name, sends', async () => {
  expect(projectFor('/w/a/b', { '/w/a': 'a', '/w/a/b': 'b', '/w/ab': 'ab' })).toBe('b')
  expect(projectFor('/w/ab/c', { '/w/a': 'a' })).toBeNull()
  expect(projectFor('/w/a', { '/w/a': 'a' })).toBe('a')

  const dir = scratch()
  const sub = join(dir, 'src')
  mkdirSync(sub)
  writeFileSync(join(sub, 'notes.txt'), 'n')
  await makeToken('cli', [dir])
  const config = scratch()
  mkdirSync(join(config, 'sessions'))
  // The command's parent is this test process: its "session file" names it.
  writeFileSync(join(config, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: 'cli-7a' }))
  const run = (args: string[], cwd: string) => Bun.spawn(['bun', join(import.meta.dir, '..', 'channel', 'tell.ts'), ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, BEBOP_HUB_URL: h.hub.url, BEBOP_DATA_DIR: h.dataDir, CLAUDE_CONFIG_DIR: config },
  })
  const p = run(['tell', 'From the command line', 'notes.txt'], sub)
  const [out, code] = [await new Response(p.stdout).text(), await p.exited]
  expect(code).toBe(0)
  expect(out).toContain('from cli (cli-7a), in project-cli')
  const row = h.hub.db.query(`SELECT * FROM messages WHERE sender = 'peer' AND source = 'cli' ORDER BY id DESC LIMIT 1`).get() as any
  expect(JSON.parse(row.body_json)).toMatchObject({ text: 'From the command line', session: 'cli-7a', files: [expect.any(String)] })
  // Outside every registered folder: nothing is sent.
  const q = run(['tell', 'lost'], scratch())
  expect(await q.exited).toBe(2)
  expect(await new Response(q.stderr).text()).toContain('no peer token')
  // The hub's refusal is passed on.
  const big = run(['tell', 'x'.repeat(16_001)], dir)
  expect(await big.exited).toBe(1)
  expect(await new Response(big.stderr).text()).toContain('too long')
})
