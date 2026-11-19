// The sender line (which project an incoming message comes from) and topics keeping their project
// after their task closes.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { startHub } from './helpers'
import { openDb } from '../hub/db'

const h = startHub()
afterAll(() => h.hub.stop())
const json = (r: Response) => r.json() as Promise<any>
const post = (path: string, body: unknown) => h.agent(path, { method: 'POST', body: JSON.stringify(body) })
const topic = async (id: string) => (await json(await h.user('/api/threads'))).threads.find((t: any) => t.id === id)
const send = async (body: object) => (await json(await post('/agent/send', { kind: 'text', ...body }))).id as number
const shown = async (id: number) => (await json(await h.user(`/api/messages?around=${id}&limit=1`))).find((m: any) => m.id === id)

// ---------- a closed topic keeps its project ----------

test('a topic left out of the list keeps its project and is marked closed; listing it again reopens it', async () => {
  await post('/agent/topics', [
    { id: 'kp-open', title: 'Open', lane: 'you', project: 'Orchard' },
    { id: 'kp-done', title: 'Done', lane: 'mine', project: 'Orchard' },
  ])
  await send({ text: 'hello', thread: 'kp-done' })
  expect((await topic('kp-done')).closed).toBeUndefined()
  await post('/agent/topics', [{ id: 'kp-open', title: 'Open', lane: 'you', project: 'Orchard' }])
  const done = await topic('kp-done')
  expect([done.project, done.lane, done.detail, done.closed]).toEqual(['Orchard', null, null, true])
  // Another sync doesn't clear it either.
  await post('/agent/topics', [{ id: 'kp-open', title: 'Open', lane: 'you', project: 'Orchard' }])
  expect((await topic('kp-done')).project).toBe('Orchard')
  // Back in the list: open again, with what the list says.
  await post('/agent/topics', [{ id: 'kp-done', title: 'Done', lane: 'you', project: 'Grove' }])
  const back = await topic('kp-done')
  expect([back.project, back.lane, back.closed]).toEqual(['Grove', 'you', undefined])
})

test('a project conversation is never closed, whatever the list says', async () => {
  await send({ text: 'in the project conversation', thread: 'project-orchard' })
  await post('/agent/topics', [{ id: 'project-orchard', title: 'Orchard', lane: 'you', project: 'orchard' }])
  await post('/agent/topics', [])
  const t = await topic('project-orchard')
  expect(t.project).toBe('orchard')
  expect(t.closed).toBeUndefined()
})

test('POST /agent/topics/project sets closed topics\' projects, clears with null, and skips unknown ids', async () => {
  // As on the live hub before this build: the sync had already cleared these topics' projects.
  await send({ text: 'one', thread: 'bf-lost-a' })
  await send({ text: 'two', thread: 'bf-lost-b' })
  const r = await post('/agent/topics/project', { 'bf-lost-a': 'Orchard', 'bf-lost-b': 'Grove', 'bf-never-seen': 'Orchard' })
  expect(r.status).toBe(200)
  expect(await json(r)).toEqual({ ok: true, count: 2, unknown: ['bf-never-seen'] })
  const a = await topic('bf-lost-a')
  expect([a.project, a.closed]).toEqual(['Orchard', true])
  expect(await topic('bf-never-seen')).toBeUndefined()
  // The next sync leaves them as they are.
  await post('/agent/topics', [])
  expect((await topic('bf-lost-b')).project).toBe('Grove')
  // {topics: {...}} works too; null clears.
  expect((await json(await post('/agent/topics/project', { topics: { 'bf-lost-b': null } }))).count).toBe(1)
  expect((await topic('bf-lost-b')).project).toBeNull()
})

test('POST /agent/topics/project refuses what isn\'t a map of names', async () => {
  for (const bad of [[{ id: 'x' }], { 'bf-lost-a': '' }, { 'bf-lost-a': 3 }, { 'bf-lost-a': 'x'.repeat(101) }, 'nope']) {
    expect((await post('/agent/topics/project', bad)).status).toBe(400)
  }
  expect((await h.user('/agent/topics/project', { method: 'POST', body: '{}' })).status).toBe(401)
})

test('POST /agent/topics/project on an open topic keeps it open', async () => {
  await post('/agent/topics', [{ id: 'bf-open', title: 'Open', lane: 'you', project: 'Orchard' }])
  await post('/agent/topics/project', { 'bf-open': 'Grove' })
  const t = await topic('bf-open')
  expect([t.project, t.lane, t.closed]).toEqual(['Grove', 'you', undefined])
})

// ---------- the sender line ----------

test('a passed-on message carries its session\'s project, from the peers list, saved with the message', async () => {
  await post('/agent/peers', [
    { name: 'lumen', project: 'Orchard' },          // a session with a name of its own
    { name: 'grove-3f', project: 'Grove' },
  ])
  const a = await send({ text: 'from lumen', source: 'lumen' })
  const b = await send({ text: 'from grove', source: 'grove-3f' })
  const own = await send({ text: 'my own words' })
  expect((await shown(a)).from_project).toBe('Orchard')
  expect((await shown(b)).from_project).toBe('Grove')
  expect('from_project' in (await shown(own))).toBe(false)
  // Saved: the session leaving the peers list doesn't change it.
  await post('/agent/peers', [])
  expect((await shown(a)).from_project).toBe('Orchard')
})

test('without a peer, the session name finds its project: suffix, accents, case, a bracket', async () => {
  await post('/agent/peers', [{ name: 'Rōnin', project: 'Meadow' }])
  await post('/agent/topics', [{ id: 'sl-t', title: 'T', lane: 'you', project: 'Orchard' }])
  const cases: [string, string | null][] = [
    ['orchard-6e', 'Orchard'],       // Claude Code's two-character suffix
    ['ORCHARD', 'Orchard'],
    ['Ronin', 'Meadow'],             // the peer, without its accent
    ['Orchard (Sim)', 'Orchard'],
    ['orchard-6e7', null],           // not a two-character suffix
    ['nobody-ab', null],
  ]
  for (const [source, project] of cases) expect([source, (await shown(await send({ text: source, source }))).from_project]).toEqual([source, project])
})

test('a message saved before this build gets its project when shown, never the topic\'s', async () => {
  // A row as the live hub has it: a source, no saved project. The topic is another project's.
  const db = new Database(join(h.dataDir, 'hub.sqlite'))
  await post('/agent/topics', [{ id: 'sl-other', title: 'Other', lane: 'you', project: 'Grove' }])
  const row = db.query(`INSERT INTO messages (ts, sender, source, thread, kind, body_json) VALUES (?, 'agent', ?, 'sl-other', 'text', '{"text":"old"}') RETURNING id`)
  const known = (row.get(Date.now(), 'orchard-c2') as { id: number }).id
  const unknown = (row.get(Date.now(), 'Stranger') as { id: number }).id
  db.close()
  expect((await shown(known)).from_project).toBe('Orchard')
  expect((await shown(unknown)).from_project).toBeNull()
})

test('search results carry the sender\'s project too', async () => {
  await send({ text: 'a quince for the search', source: 'orchard-9a' })
  const r = await json(await h.user('/api/search?q=quince'))
  expect(r.results?.[0]?.from_project ?? r[0]?.from_project).toBe('Orchard')
})

// ---------- the column ----------

test('a database from the peer-inbox build gets the column without a rebuild; a new one has it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-db-'))
  const path = join(dir, 'hub.sqlite')
  const old = new Database(path, { create: true })
  old.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      sender TEXT NOT NULL CHECK (sender IN ('user','agent','peer','clock')),
      source TEXT, thread TEXT, kind TEXT NOT NULL, body_json TEXT NOT NULL, reply_to INTEGER,
      delivered_at INTEGER, edited_at INTEGER, login TEXT, client_id TEXT UNIQUE);
    INSERT INTO messages (ts, sender, source, kind, body_json) VALUES (1, 'agent', 'orchard-6e', 'text', '{"text":"kept"}');`)
  old.close()
  const db = openDb(path)
  const cols = (db.query('PRAGMA table_info(messages)').all() as { name: string }[]).map(c => c.name)
  expect(cols).toContain('source_project')
  expect(db.query('SELECT id, source, source_project FROM messages').all()).toEqual([{ id: 1, source: 'orchard-6e', source_project: null }])
  expect(require('fs').existsSync(`${path}.before-notes`)).toBe(false) // no rebuild, so no copy
  db.close()
  const fresh = openDb(join(dir, 'new.sqlite'))
  expect((fresh.query('PRAGMA table_info(messages)').all() as { name: string }[]).map(c => c.name)).toContain('source_project')
  expect((fresh.query('PRAGMA table_info(thread_meta)').all() as { name: string }[]).map(c => c.name)).toContain('closed')
  fresh.close()
})

// ---------- the app ----------

test('the app files closed topics under Other and draws the sender line from from_project', async () => {
  const app = await Bun.file(join(import.meta.dir, '..', 'web', 'app.js')).text()
  const body = (name: string, end: string) => app.slice(app.indexOf(name), app.indexOf(end, app.indexOf(name)))
  expect(body('function projectList()', '\n}\n')).toContain('filedProject(t)')
  expect(body('function looseRows(', '\n}\n')).toContain('!filedProject(t)')
  expect(body('const viewTopics =', '\n')).toContain('filedProject(t)')
  expect(body('function senderOf(', '\n}\n')).toContain('m.from_project')
  // Never the topic's project: the sender line reads only the message.
  expect(body('function senderOf(', '\n}\n')).not.toMatch(/thread|curTopic|threads/)
  expect(body('function buildNode(', '\n}\n')).toContain('senderLine(m)')
})
