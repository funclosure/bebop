// Project tools (manifest scope: "project"): one instance per project, a page per topic plus an overview.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { startHub, readSSE } from './helpers'
import { ToolManifest, makeTool, toolUrls } from '../hub/tools'
import { openDb } from '../hub/db'
import { buildMeta } from '../channel/server'

const ACT = { 'x-hub-action': '1' }
const manifest = (over: Record<string, unknown> = {}) => ({
  bebop: 1, id: 'hello', name: 'Hello', scope: 'project',
  frame: { url: '/t/{instance}?page={page}&host=bebop', link: '/t/{instance}?page={page}' },
  ref: ['note'],
  ...over,
})
function toolsFile(m: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-tools-'))
  mkdirSync(join(root, 'hello'))
  writeFileSync(join(root, 'hello', 'bebop-tool.json'), JSON.stringify(m))
  const file = join(root, 'tools.json')
  writeFileSync(file, JSON.stringify([{ source: './hello', origin: 'http://localhost:5180' }]))
  return file
}
type H = ReturnType<typeof startHub>
const topics = (h: H, list: { id: string; title?: string; project?: string }[]) => h.agent('/agent/topics', { method: 'POST', body: JSON.stringify(list) })
const openIn = async (h: H, thread: string) => (await h.user(`/api/threads/${encodeURIComponent(thread)}/tools/hello`, { method: 'POST', headers: ACT })).json()
const openProject = (h: H, key: string, body: unknown = {}) => h.user(`/api/projects/${encodeURIComponent(key)}/tools/hello`, { method: 'POST', headers: ACT, body: JSON.stringify(body) })
const post = (h: H, body: any) => h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: '📌 Hello: hi', ...body }) })
const threadList = async (h: H) => (await (await h.user('/api/threads')).json()).threads as { id: string; title: string; project: string | null }[]

test('manifest: scope topic (default) or project; {page} filled and encoded; a project tool\'s ref gains "page"', () => {
  expect(ToolManifest.safeParse(manifest()).success).toBe(true)
  expect(ToolManifest.safeParse(manifest({ scope: 'team' })).success).toBe(false)
  const p = makeTool(manifest(), { origin: 'https://t.example' })
  expect(p.scope).toBe('project')
  expect(p.ref).toEqual(['note', 'page'])
  expect(toolUrls(p, 'notebook', 'my topic/1')).toEqual({ frame: 'https://t.example/t/notebook?page=my%20topic%2F1&host=bebop', link: 'https://t.example/t/notebook?page=my%20topic%2F1' })
  const t = makeTool(manifest({ scope: undefined }), { origin: 'https://t.example' })
  expect(t.scope).toBe('topic')
  expect(t.ref).toEqual(['note'])
  expect(makeTool(manifest({ ref: ['note', 'page'] }), { origin: 'https://t.example' }).ref).toEqual(['note', 'page'])
})

test('db: tool_instances from before scopes become topic rows (idempotent)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-db-'))
  const old = new Database(join(dir, 'hub.sqlite'), { create: true })
  old.exec('CREATE TABLE tool_instances (tool TEXT NOT NULL, thread TEXT NOT NULL, instance TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (tool, thread), UNIQUE (tool, instance))')
  old.exec(`INSERT INTO tool_instances VALUES ('board', 'sketch-pad', 'sketch-pad', 1), ('hello', 'x.y', 'x-y-hello', 2)`)
  old.close()
  for (let i = 0; i < 2; i++) {
    const db = openDb(join(dir, 'hub.sqlite'))
    expect(db.query('SELECT tool, scope, scope_key, instance, created FROM tool_instances ORDER BY created').all()).toEqual([
      { tool: 'board', scope: 'topic', scope_key: 'sketch-pad', instance: 'sketch-pad', created: 1 },
      { tool: 'hello', scope: 'topic', scope_key: 'x.y', instance: 'x-y-hello', created: 2 },
    ])
    db.close()
  }
})

test('project tool: one instance per project, the topic\'s page; no project → desk; the header opens the overview', async () => {
  const h = startHub({ toolsFile: toolsFile(manifest()) })
  try {
    await topics(h, [{ id: 'kana-1', title: 'Notebook: quiz', project: 'Notebook' }, { id: 'kana-2', title: 'Notebook: lint', project: 'notebook' }, { id: 'loose', title: 'Loose' }, { id: 'kana.1', project: 'Notebook' }])
    const a = await openIn(h, 'kana-1')
    expect(a).toEqual({ tool: 'hello', instance: 'notebook', origin: 'http://localhost:5180', scope: 'project', page: 'kana-1',
      frame: 'http://localhost:5180/t/notebook?page=kana-1&host=bebop', link: 'http://localhost:5180/t/notebook?page=kana-1' })
    expect(await openIn(h, 'kana-2')).toMatchObject({ instance: 'notebook', page: 'kana-2' })
    // A project conversation belongs to its project by its id.
    // Its page name is the id made [A-Za-z0-9_-]{1,64} (Board's page names), unique on the board, and kept.
    expect(await openIn(h, 'project-notebook~abc')).toMatchObject({ instance: 'notebook', page: 'project-notebook-abc' })
    expect(await openIn(h, 'kana.1')).toMatchObject({ instance: 'notebook', page: 'kana-1-2' })
    expect(await openIn(h, 'project-notebook~abc')).toMatchObject({ page: 'project-notebook-abc' })
    const m = await (await post(h, { tool: { id: 'hello', instance: 'notebook', ref: { page: 'kana-1-2' } } })).json()
    expect(m.thread).toBe('kana.1')
    expect(m.body.tool.ref.page).toBe('kana-1-2')
    expect(await openIn(h, 'loose')).toMatchObject({ instance: 'desk-hello', page: 'loose' })

    // From the project's header: the overview page, by project key (case doesn't matter).
    expect((await openProject(h, 'notebook')).status).toBe(200)
    const o = await (await openProject(h, 'Notebook', { name: 'Notebook' })).json()
    expect(o).toEqual({ tool: 'hello', instance: 'notebook', origin: 'http://localhost:5180', scope: 'project', page: 'overview', project: 'notebook',
      frame: 'http://localhost:5180/t/notebook?page=overview&host=bebop', link: 'http://localhost:5180/t/notebook?page=overview' })
    expect((await h.user('/api/projects/notebook/tools/hello', { method: 'POST' })).status).toBe(403)
    expect((await h.user('/api/projects/notebook/tools/nope', { method: 'POST', headers: ACT })).status).toBe(404)
    // A new project gets its own.
    expect(await (await openProject(h, 'notes')).json()).toMatchObject({ instance: 'notes-hello', page: 'overview' })
  } finally { h.hub.stop() }
})

test('project tool: the header button refuses a topic tool', async () => {
  const h = startHub({ toolsFile: toolsFile(manifest({ scope: 'topic' })) })
  try {
    expect((await openProject(h, 'notebook')).status).toBe(400)
    expect(await openIn(h, 'kana-1')).toMatchObject({ instance: 'kana-1', scope: 'topic', page: 'kana-1' })
  } finally { h.hub.stop() }
})

test('project tool posts: into the page\'s topic, only pages of the instance\'s project; page arrives as <id>_page', async () => {
  const h = startHub({ toolsFile: toolsFile(manifest()) })
  try {
    await topics(h, [{ id: 'kana-1', project: 'Notebook' }, { id: 'kana-2', project: 'Notebook' }, { id: 'notes-1', project: 'Notes' }])
    const { instance } = await openIn(h, 'kana-1')
    // The page decides the topic, whatever thread the app sent.
    const m = await (await post(h, { thread: null, tool: { id: 'hello', instance, ref: { page: 'kana-2', note: 'n1' } } })).json()
    expect(m.thread).toBe('kana-2')
    expect(m.body.tool).toEqual({ id: 'hello', instance: 'notebook', ref: { note: 'n1', page: 'kana-2' } })
    const ev = await readSSE(await h.agent('/agent/stream'), e => e.some(x => x.data.id === m.id), 2000)
    expect(buildMeta(ev.find(x => x.data.id === m.id)!.data)).toMatchObject({ tool: 'hello', hello_id: 'notebook', hello_page: 'kana-2', hello_note: 'n1' })
    // No page: the topic it was sent in, if it's the project's.
    expect((await (await post(h, { thread: 'kana-1', tool: { id: 'hello', instance } })).json()).body.tool.ref).toEqual({ page: 'kana-1' })
    // Another project's topic, a topic that doesn't exist, an instance that isn't one: refused.
    expect((await post(h, { thread: 'kana-1', tool: { id: 'hello', instance, ref: { page: 'notes-1' } } })).status).toBe(400)
    expect((await post(h, { tool: { id: 'hello', instance, ref: { page: 'nowhere' } } })).status).toBe(400)
    expect((await post(h, { tool: { id: 'hello', instance: 'notes-hello', ref: { page: 'notes-1' } } })).status).toBe(400)
    expect((await post(h, { tool: { id: 'hello', instance } })).status).toBe(400)

    // A topic whose project the agent no longer lists keeps its page on the board it was opened on.
    await topics(h, [{ id: 'kana-2', project: 'Notebook' }])
    expect((await post(h, { tool: { id: 'hello', instance, ref: { page: 'kana-1' } } })).status).toBe(201)
    expect(await openIn(h, 'kana-1')).toMatchObject({ instance: 'notebook', page: 'kana-1' })
  } finally { h.hub.stop() }
})

test('project tool: the overview posts into one topic per project and tool, "<Project> · <Tool>", made on the first post', async () => {
  const h = startHub({ toolsFile: toolsFile(manifest()) })
  try {
    await topics(h, [{ id: 'kana-1', project: 'my-app-web' }])
    const { instance } = await (await openProject(h, 'my-app-web', { name: 'My App' })).json()
    expect((await threadList(h)).map(t => t.id)).not.toContain('my-app-web~hello')
    const sse = await h.user('/api/events')
    const a = await (await post(h, { tool: { id: 'hello', instance, ref: { page: 'overview' } } })).json()
    expect(a.thread).toBe('my-app-web~hello')
    expect(a.body.tool.ref).toEqual({ page: 'overview' })
    const ev = await readSSE(sse, e => e.some(x => x.event === 'threads' && x.data.threads.some((t: any) => t.id === a.thread)), 2000)
    expect(ev.some(x => x.event === 'threads')).toBe(true)
    const b = await (await post(h, { tool: { id: 'hello', instance, ref: { page: 'overview' } } })).json()
    expect(b.thread).toBe(a.thread)
    // Its title and project outlive the agent rewriting its lists.
    await h.agent('/agent/threads', { method: 'POST', body: JSON.stringify([{ id: 'kana-1', title: 'K' }]) })
    await topics(h, [])
    expect((await threadList(h)).find(t => t.id === a.thread)).toMatchObject({ title: 'My App · Hello', project: 'my-app-web' })
    // Opened from that topic, the tool shows the overview.
    expect(await openIn(h, a.thread)).toMatchObject({ instance, page: 'overview' })

    // Without a name from the app, the project's name is made readable; the desk has no project.
    await topics(h, [{ id: 'j-1', project: 'notes-app' }, { id: 'loose' }])
    const j = await (await openProject(h, 'notes-app')).json()
    const jp = await (await post(h, { tool: { id: 'hello', instance: j.instance, ref: { page: 'overview' } } })).json()
    expect((await threadList(h)).find(t => t.id === jp.thread)).toMatchObject({ title: 'Notes App · Hello', project: 'notes-app' })
    const d = await openIn(h, 'loose')
    const dp = await (await post(h, { tool: { id: 'hello', instance: d.instance, ref: { page: 'overview' } } })).json()
    expect(dp.thread).toBe('desk~hello')
    expect((await threadList(h)).find(t => t.id === dp.thread)).toMatchObject({ title: 'Desk · Hello', project: null })
  } finally { h.hub.stop() }
})

test('migration: a topic instance from before the tool was per project becomes the project\'s, its topic the overview', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-test-'))
  const before = startHub({ dataDir, toolsFile: toolsFile(manifest({ scope: 'topic' })) })
  try {
    await topics(before, [{ id: 'sketch-pad', title: 'Sketch Pad', project: 'sketch-pad' }, { id: 'sp-2', project: 'sketch-pad' }, { id: 'other', project: 'other' }])
    expect(await openIn(before, 'sketch-pad')).toMatchObject({ instance: 'sketch-pad', scope: 'topic' })
    expect(await openIn(before, 'other')).toMatchObject({ instance: 'other-hello' })
    await post(before, { thread: 'sketch-pad', text: 'old comment', tool: { id: 'hello', instance: 'sketch-pad' } })
  } finally { before.hub.stop() }

  const logs: string[] = []
  const h = startHub({ dataDir, toolsFile: toolsFile(manifest()), log: m => logs.push(m) })
  try {
    // Another topic of the project asks first: it still gets the old board, and the old topic is its overview.
    expect(await openIn(h, 'sp-2')).toMatchObject({ instance: 'sketch-pad', page: 'sp-2' })
    expect(logs.join('\n')).toMatch(/sketch-pad's instance sketch-pad is now project sketch-pad's/)
    expect(await openIn(h, 'sketch-pad')).toMatchObject({ instance: 'sketch-pad', page: 'overview' })
    const o = await (await post(h, { tool: { id: 'hello', instance: 'sketch-pad', ref: { page: 'overview' } } })).json()
    expect(o.thread).toBe('sketch-pad')
    expect((await (await openProject(h, 'sketch-pad')).json()).instance).toBe('sketch-pad')
    // From the header first, too.
    expect((await (await openProject(h, 'other')).json()).instance).toBe('other-hello')
    // A project without an old instance gets a new one.
    await topics(h, [{ id: 'new-1', project: 'fresh' }])
    expect(await openIn(h, 'new-1')).toMatchObject({ instance: 'fresh-hello', page: 'new-1' })
  } finally { h.hub.stop() }
})
