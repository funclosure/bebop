import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { startHub, readSSE } from './helpers'
import { instanceIdFor, INSTANCE_ID, ToolManifest, loadTools, makeTool, toolUrls, toolInstructions, toolOriginOf } from '../hub/tools'
import { openDb } from '../hub/db'
import { buildMeta, formatToolNotes } from '../channel/server'

const upload = async (url: string, name: string, type: string, data: string | Uint8Array) => {
  const fd = new FormData()
  fd.append('file', new File([data], name, { type }))
  const r = await fetch(url + '/api/upload', { method: 'POST', body: fd })
  return (await r.json())[0]
}
const ACT = { 'x-hub-action': '1' }

const manifest = (over: Record<string, unknown> = {}) => ({
  bebop: 1, id: 'hello', name: 'Hello', version: '0.1.0', icon: 'icon.svg',
  frame: { url: '/t/{instance}?host=bebop', link: '/t/{instance}', allow: ['clipboard-write', 'camera'] },
  ref: ['note', 'n'],
  agent: { cli: 'bin/hello', instructions: 'Answer with `{cli} reply {hello_id} "…"`.' },
  ...over,
})

/** A tools.json in a temp folder, with each tool's folder beside it. */
function toolsDir(tools: { dir: string; manifest?: unknown; origin: string; allow?: string[]; source?: string }[]) {
  const root = mkdtempSync(join(tmpdir(), 'hub-tools-'))
  for (const t of tools) {
    mkdirSync(join(root, t.dir), { recursive: true })
    if (t.manifest) writeFileSync(join(root, t.dir, 'bebop-tool.json'), JSON.stringify(t.manifest))
    writeFileSync(join(root, t.dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  }
  const file = join(root, 'tools.json')
  writeFileSync(file, JSON.stringify(tools.map(t => ({ source: t.source ?? `./${t.dir}`, origin: t.origin, ...(t.allow ? { allow: t.allow } : {}) }))))
  return { root, file }
}

test('instanceIdFor: readable, valid, padded with the tool id when short (Board ids unchanged)', () => {
  expect(instanceIdFor('sketch-pad', 1, 'board')).toBe('sketch-pad')
  expect(instanceIdFor('project-my-app~mw0onowd', 1, 'board')).toBe('project-my-app-mw0onowd')
  expect(instanceIdFor('a b', 1, 'board')).toBe('a-b-board')
  expect(instanceIdFor('~~', 1, 'board')).toBe('board-')
  expect(instanceIdFor('~~', 1, 'hello')).toBe('hello-')
  expect(instanceIdFor('x'.repeat(200))).toHaveLength(64)
  expect(instanceIdFor('x'.repeat(200), 2)).toEndWith('-2')
  for (const t of ['sketch-pad', 'a', '日本語', 'x'.repeat(200), 'a.b/c?d']) expect(instanceIdFor(t, 1, 'ab')).toMatch(INSTANCE_ID)
})

test('manifest: validated; reserved ids, bad ref keys, shell strings and off-origin frames refused', () => {
  expect(ToolManifest.safeParse(manifest()).success).toBe(true)
  for (const bad of [
    { id: 'tool' }, { id: 'file' }, { id: 'Hello' }, { id: 'h' }, { bebop: 2 },
    { ref: ['id'] }, { ref: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, { ref: ['Thread'] },
    { install: 'pnpm install' }, { serve: { command: 'pnpm dev' } },
    { frame: { url: '/t/x' } }, { frame: { url: 'https://evil.example/{instance}' } }, { frame: { url: '//evil.example/{instance}' } },
    { icon: '../secret.svg' }, { agent: { cli: '/bin/sh' } },
  ]) expect(ToolManifest.safeParse(manifest(bad)).success).toBe(false)
  // A pattern that refuses the hub's ids can't be used.
  expect(() => makeTool(manifest({ instance: { pattern: '^[0-9]+$' } }), { origin: 'https://t.example' })).toThrow(/pattern/)
  expect(() => makeTool(manifest({ instance: { pattern: '(' } }), { origin: 'https://t.example' })).toThrow(/pattern/)
})

test('origins: https or http on localhost, only an origin, never the hub', () => {
  expect(toolOriginOf('https://box.example.ts.net:8443/')).toBe('https://box.example.ts.net:8443')
  expect(toolOriginOf('http://localhost:5180')).toBe('http://localhost:5180')
  expect(toolOriginOf('http://box.example.ts.net:5180')).toBeNull()
  expect(toolOriginOf('https://t.example/sub')).toBeNull()
  expect(toolOriginOf('javascript:alert(1)')).toBeNull()
  expect(toolOriginOf('http://127.0.0.1:8787', ['http://127.0.0.1:8787'])).toBeNull()
})

test('urls and instructions: filled per instance, on the tool origin; {cli} → absolute path, capped', () => {
  const t = makeTool(manifest(), { origin: 'https://t.example' }, '/opt/tools/hello')
  expect(toolUrls(t, 'my-topic')).toEqual({ frame: 'https://t.example/t/my-topic?host=bebop', link: 'https://t.example/t/my-topic' })
  expect(t.allow).toEqual(['clipboard-write']) // camera isn't granted
  expect(makeTool(manifest(), { origin: 'https://t.example', allow: ['camera'] }).allow).toEqual(['clipboard-write', 'camera'])
  expect(toolInstructions(t)).toBe('Answer with `/opt/tools/hello/bin/hello reply {hello_id} "…"`.')
  expect(toolInstructions(makeTool(manifest({ agent: { instructions: 'x'.repeat(1500) } }), { origin: 'https://t.example' }))!.length).toBe(800)
})

test('loadTools: local folders load; bad entries, unpinned git sources, duplicates and the hub origin are skipped with a log', () => {
  const { file } = toolsDir([
    { dir: 'hello', manifest: manifest(), origin: 'http://localhost:5180' },
    { dir: 'dup', manifest: manifest(), origin: 'http://localhost:5181' },
    { dir: 'nomanifest', origin: 'http://localhost:5182' },
    { dir: 'bad', manifest: manifest({ id: 'chat' }), origin: 'http://localhost:5183' },
    { dir: 'self', manifest: manifest({ id: 'self' }), origin: 'http://127.0.0.1:8787' },
    { dir: 'git', origin: 'https://t.example', source: 'git+https://github.com/x/y#v1' },
  ])
  const logs: string[] = []
  const tools = loadTools(file, { hubOrigins: ['http://127.0.0.1:8787'], log: m => logs.push(m) })
  expect(tools.map(t => t.id)).toEqual(['hello'])
  expect(tools[0].icon).toEndWith('/hello/icon.svg')
  expect(logs.join('\n')).toMatch(/already loaded/)
  expect(logs.join('\n')).toMatch(/no bebop-tool.json/)
  expect(logs.join('\n')).toMatch(/reserved id/)
  expect(logs.join('\n')).toMatch(/not the hub's own/)
  expect(logs.join('\n')).toMatch(/isn't pinned in tools.lock.json/)
  expect(loadTools(join(file, '..', 'missing.json'))).toEqual([])
})

test('db: boards from before tools become Board instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-db-'))
  const old = new Database(join(dir, 'hub.sqlite'), { create: true })
  old.exec('CREATE TABLE boards (thread TEXT PRIMARY KEY, board TEXT NOT NULL UNIQUE, created INTEGER NOT NULL)')
  old.exec(`INSERT INTO boards VALUES ('my.topic', 'my-topic', 1), ('other', 'other-board', 2)`)
  old.close()
  const db = openDb(join(dir, 'hub.sqlite'))
  expect(db.query('SELECT tool, scope, scope_key, instance, created FROM tool_instances ORDER BY created').all()).toEqual([
    { tool: 'board', scope: 'topic', scope_key: 'my.topic', instance: 'my-topic', created: 1 },
    { tool: 'board', scope: 'topic', scope_key: 'other', instance: 'other-board', created: 2 },
  ])
  db.close()
  openDb(join(dir, 'hub.sqlite')).close() // again: idempotent
})

test('tools: none configured → empty list, 404s', async () => {
  const h = startHub()
  try {
    const c = await (await h.user('/api/config')).json()
    expect(c.tools).toEqual([])
    expect(c.board).toBeNull()
    expect(c.agent_id).toBe('bebop')
    expect((await h.user('/api/threads/t1/tools/board', { method: 'POST', headers: ACT })).status).toBe(404)
    expect((await h.user('/api/threads/t1/board', { method: 'POST', headers: ACT })).status).toBe(404)
    expect(await (await h.agent('/agent/tools')).json()).toEqual([])
  } finally { h.hub.stop() }
})

test('tools: config, instance route, icon, CSP and agent instructions for a local tool', async () => {
  const { file, root } = toolsDir([{ dir: 'hello', manifest: manifest(), origin: 'http://localhost:5180' }])
  const h = startHub({ toolsFile: file, agentName: 'Ada' })
  try {
    const c = await (await h.user('/api/config')).json()
    expect(c.agent_id).toBe('ada')
    expect(c.tools).toEqual([{ id: 'hello', name: 'Hello', version: '0.1.0', icon: 'api/tools/hello/icon', origin: 'http://localhost:5180', scope: 'topic',
      frame: '/t/{instance}?host=bebop', link: '/t/{instance}', allow: ['clipboard-write'], up: null }])
    // Needs the action header (no cross-site form can send it).
    expect((await h.user('/api/threads/t1/tools/hello', { method: 'POST' })).status).toBe(403)
    const r = await (await h.user('/api/threads/my.topic/tools/hello', { method: 'POST', headers: ACT })).json()
    expect(r).toEqual({ tool: 'hello', instance: 'my-topic', origin: 'http://localhost:5180', frame: 'http://localhost:5180/t/my-topic?host=bebop', link: 'http://localhost:5180/t/my-topic', scope: 'topic', page: 'my.topic' })
    expect((await h.user('/api/threads/other/tools/nope', { method: 'POST', headers: ACT })).status).toBe(404)
    const icon = await h.user('/api/tools/hello/icon')
    expect(icon.headers.get('content-type')).toBe('image/svg+xml')
    expect(icon.headers.get('content-security-policy')).toStartWith('sandbox')
    const page = await h.user('/')
    expect(page.headers.get('content-security-policy')).toBe("frame-src 'self' http://localhost:5180; frame-ancestors 'none'")
    const at = await (await h.agent('/agent/tools')).json()
    expect(at).toEqual([{ id: 'hello', name: 'Hello', origin: 'http://localhost:5180', scope: 'topic', ref: ['note', 'n'], cli: join(root, 'hello', 'bin/hello'),
      instructions: `Answer with \`${join(root, 'hello', 'bin/hello')} reply {hello_id} "…"\`.` }])
    expect((await h.user('/agent/tools')).status).toBe(401)
    expect(formatToolNotes(at)).toContain('- Hello (tool="hello"): Answer with')
    expect(formatToolNotes([])).toBe('')
  } finally { h.hub.stop() }
})

test('tools: a post carries tool=, <id>_id and only the listed ref keys, and only into its own topic', async () => {
  const { file } = toolsDir([{ dir: 'hello', manifest: manifest(), origin: 'http://localhost:5180' }])
  const h = startHub({ toolsFile: file })
  try {
    const { instance } = await (await h.user('/api/threads/topic-1/tools/hello', { method: 'POST', headers: ACT })).json()
    const post = (body: any) => h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: '📌 Hello: hi', ...body }) }).then(r => r.json())
    const m = await post({ thread: 'topic-1', tool: { id: 'hello', instance, ref: { note: 'n-1', n: 3, junk: 'x' }, link: 'http://localhost:5180/t/topic-1', extra: 1 } })
    expect(m.body.tool).toEqual({ id: 'hello', instance, ref: { note: 'n-1', n: 3 }, link: 'http://localhost:5180/t/topic-1' })
    const ev = await readSSE(await h.agent('/agent/stream'), e => e.some(x => x.data.id === m.id), 2000)
    const meta = buildMeta(ev.find(x => x.data.id === m.id)!.data)
    expect(meta.tool).toBe('hello')
    expect(meta.hello_id).toBe('topic-1')
    expect(meta.hello_note).toBe('n-1')
    expect(meta.hello_n).toBe('3')
    expect(meta.hello_junk).toBeUndefined()

    // Another topic, an unknown tool, or a link off the tool's origin: the ref (or link) is dropped, the message still goes.
    expect((await post({ thread: 'topic-2', tool: { id: 'hello', instance } })).body.tool).toBeUndefined()
    expect((await post({ thread: 'topic-1', tool: { id: 'nope', instance } })).body.tool).toBeUndefined()
    expect((await post({ thread: 'topic-1', tool: { id: 'hello', instance, link: 'https://evil.example/' } })).body.tool.link).toBeUndefined()
  } finally { h.hub.stop() }
})

test('board (HUB_BOARD_ORIGIN shim): one stable id per topic, kept across a threads rewrite; collisions get a suffix', async () => {
  const h = startHub({ boardOrigin: 'http://localhost:5173/' })
  try {
    const c = await (await h.user('/api/config')).json()
    expect(c.board).toBe('http://localhost:5173')
    expect(c.tools.map((t: any) => [t.id, t.frame])).toEqual([['board', '/b/{instance}?host=1']])
    const first = await (await h.user(`/api/threads/${encodeURIComponent('my.topic')}/board`, { method: 'POST', headers: ACT })).json()
    expect(first).toMatchObject({ board: 'my-topic', origin: 'http://localhost:5173', frame: 'http://localhost:5173/b/my-topic?host=1' })
    // The agent replacing the thread list doesn't lose it.
    await h.agent('/agent/threads', { method: 'POST', body: JSON.stringify([{ id: 'my.topic', title: 'T' }]) })
    expect((await (await h.user('/api/threads/my.topic/tools/board', { method: 'POST', headers: ACT })).json()).instance).toBe('my-topic')
    // Another thread that reads the same gets its own board.
    expect((await (await h.user('/api/threads/my-topic/board', { method: 'POST', headers: ACT })).json()).board).toBe('my-topic-2')
    const at = await (await h.agent('/agent/tools')).json()
    expect(at[0].instructions).toContain('board reply {board_id} {board_thread}')
  } finally { h.hub.stop() }
})

test('board: a comment posted into the topic still yields board_id and board_thread (new and legacy body)', async () => {
  const h = startHub({ boardOrigin: 'http://localhost:5173' })
  try {
    await h.user('/api/threads/topic-1/tools/board', { method: 'POST', headers: ACT })
    const png = await upload(h.hub.url, 'board-snapshot.png', 'image/png', new Uint8Array([137, 80, 78, 71]))
    const ctx = await upload(h.hub.url, 'board-context.json', 'application/json', JSON.stringify({ boardId: 'topic-1', threadId: 'comment-thread:abc' }))
    const link = 'http://localhost:5173/b/topic-1'
    const m = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({
      kind: 'text', thread: 'topic-1', text: `📌 Board #2: make it bigger\n\n${link}`, files: [png.id, ctx.id],
      tool: { id: 'board', instance: 'topic-1', ref: { thread: 'comment-thread:abc', number: 2 }, link },
    }) })).json()
    expect(m.body.tool).toEqual({ id: 'board', instance: 'topic-1', ref: { thread: 'comment-thread:abc', number: 2 }, link })
    // An app from before tools still posts `board: {…}`.
    const legacy = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({
      kind: 'text', thread: 'topic-1', text: 'old app', board: { id: 'topic-1', thread: 'comment-thread:def', number: 3, link, junk: 'x' },
    }) })).json()
    expect(legacy.body.tool).toEqual({ id: 'board', instance: 'topic-1', ref: { thread: 'comment-thread:def', number: 3 }, link })
    const ev = await readSSE(await h.agent('/agent/stream'), e => e.some(x => x.data.id === legacy.id), 2000)
    const meta = buildMeta(ev.find(x => x.data.id === m.id)!.data)
    expect(meta.tool).toBe('board')
    expect(meta.board_id).toBe('topic-1')
    expect(meta.board_thread).toBe('comment-thread:abc')
    expect(meta.board_number).toBe('2')
    expect(meta.image_path).toEndWith('.png')
    expect(meta.file_names).toBe('board-snapshot.png;board-context.json')
    expect(buildMeta(ev.find(x => x.data.id === legacy.id)!.data).board_thread).toBe('comment-thread:def')
    // A message stored before tools (body.board) still gives the agent board_id.
    expect(buildMeta({ id: 1, ts: 0, kind: 'text', body: { text: 'x', board: { id: 'b-old-1', thread: 't' } } })).toMatchObject({ board_id: 'b-old-1', board_thread: 't' })

    // A malformed ref is dropped, the message still goes.
    const bad = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', thread: 'topic-1', text: 'x', board: { id: 'no' } }) })).json()
    expect(bad.body.tool).toBeUndefined()
  } finally { h.hub.stop() }
})

test('tools.json wins over HUB_BOARD_ORIGIN for "board"', async () => {
  const { file } = toolsDir([{ dir: 'board', manifest: manifest({ id: 'board', name: 'Board', ref: ['thread', 'number'] }), origin: 'https://board.example' }])
  const logs: string[] = []
  const h = startHub({ toolsFile: file, boardOrigin: 'http://localhost:5173', log: m => logs.push(m) })
  try {
    expect((await (await h.user('/api/config')).json()).board).toBe('https://board.example')
    expect(logs.join('\n')).toMatch(/HUB_BOARD_ORIGIN ignored/)
  } finally { h.hub.stop() }
})
