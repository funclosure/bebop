import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findTranscript, readTranscript, linesBackward, itemsOf, toolLine, projectSlug, TEXT_MAX } from '../hub/transcript'
import { startHub } from './helpers'
import type { Pane, PaneProvider } from '../hub/panes'

const SID = '8c44e3c8-bcfd-4921-bb90-19fc7dc081f8'
const SID2 = '0a56ae4a-e6ce-4236-90fa-3e6f846aca39'

function claudeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-dir-'))
  mkdirSync(join(dir, 'sessions'))
  mkdirSync(join(dir, 'projects'))
  return dir
}
const line = (o: any) => JSON.stringify(o)
const user = (text: any, extra: any = {}) => line({ type: 'user', isSidechain: false, timestamp: '2026-11-04T10:00:00Z', message: { role: 'user', content: text }, ...extra })
const asst = (content: any[], extra: any = {}) => line({ type: 'assistant', isSidechain: false, timestamp: '2026-11-04T10:00:01Z', message: { role: 'assistant', content }, ...extra })

test('slug: every character but letters and digits becomes a dash', () => {
  expect(projectSlug('/Users/me/code/my-app-web')).toBe('-Users-me-code-my-app-web')
  expect(projectSlug('/a/b.c d')).toBe('-a-b-c-d')
})

test('findTranscript: by pid, by the one live session in a cwd, never a guess', () => {
  const dir = claudeDir()
  const cwd = '/work/proj'
  mkdirSync(join(dir, 'projects', projectSlug(cwd)))
  writeFileSync(join(dir, 'projects', projectSlug(cwd), `${SID}.jsonl`), '')
  writeFileSync(join(dir, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: SID, cwd }))
  const want = { session: SID, path: join(dir, 'projects', projectSlug(cwd), `${SID}.jsonl`) }
  expect(findTranscript({ claudeDir: dir, pid: 101 })).toEqual(want)
  expect(findTranscript({ claudeDir: dir, cwd, alive: p => p === 101 })).toEqual(want)
  expect(findTranscript({ claudeDir: dir, cwd, alive: () => false })).toBeNull() // dead process
  // Two live sessions in one folder: no way to tell which pane is which.
  writeFileSync(join(dir, 'sessions', '102.json'), JSON.stringify({ pid: 102, sessionId: SID2, cwd }))
  expect(findTranscript({ claudeDir: dir, cwd, alive: () => true })).toBeNull()
  // A transcript filed under another folder (the session moved) is still found.
  mkdirSync(join(dir, 'projects', '-elsewhere'))
  writeFileSync(join(dir, 'projects', '-elsewhere', `${SID2}.jsonl`), '')
  expect(findTranscript({ claudeDir: dir, pid: 102 })?.path).toBe(join(dir, 'projects', '-elsewhere', `${SID2}.jsonl`))
  // A session id that isn't a uuid is never turned into a path.
  writeFileSync(join(dir, 'sessions', '103.json'), JSON.stringify({ pid: 103, sessionId: '../../etc/passwd', cwd }))
  expect(findTranscript({ claudeDir: dir, pid: 103 })).toBeNull()
  expect(findTranscript({ claudeDir: dir, pid: 999 })).toBeNull()
})

test('linesBackward: newest first, with start offsets, across chunks; overlong lines come back null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lines-'))
  const p = join(dir, 'f')
  const content = 'aa\nbbbbbbbbbb\n\nccc\n' + 'x'.repeat(50) + '\ndd'
  writeFileSync(p, content)
  const fd = openSync(p, 'r')
  try {
    const got = [...linesBackward(fd, content.length, 4, 20)]
    expect(got.map(g => g.line)).toEqual(['dd', null, 'ccc', 'bbbbbbbbbb', 'aa'])
    for (const g of got) if (g.line) expect(content.slice(g.start, g.start + g.line.length)).toBe(g.line)
    const fromMid = [...linesBackward(fd, content.indexOf('ccc'), 3, 100)].map(g => g.line)
    expect(fromMid).toEqual(['bbbbbbbbbb', 'aa'])
    expect([...linesBackward(fd, 0)]).toEqual([])
  } finally { closeSync(fd) }
})

test('items: prompts, replies, tool calls in one line, peers, notes; meta and sidechains left out', () => {
  const errs = new Set<string>(['t2'])
  expect(itemsOf(JSON.parse(user('hello <system-reminder>secret</system-reminder>')), errs)).toEqual([{ kind: 'user', ts: '2026-11-04T10:00:00Z', text: 'hello' }])
  expect(itemsOf(JSON.parse(user('[Image: original 10x10]', { isMeta: true })), errs)).toEqual([])
  expect(itemsOf(JSON.parse(user('summary', { isCompactSummary: true })), errs)).toEqual([])
  expect(itemsOf(JSON.parse(user('side', { isSidechain: true })), errs)).toEqual([])
  expect(itemsOf(JSON.parse(user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>haiku</command-args>')), errs)[0].text).toBe('/model haiku')
  expect(itemsOf(JSON.parse(user('<local-command-stdout>Set model</local-command-stdout>')), errs)).toEqual([])
  expect(itemsOf(JSON.parse(user('<task-notification>\n<task-id>b1</task-id>\n<summary>Build finished</summary>\n</task-notification>')), errs)[0])
    .toMatchObject({ kind: 'note', text: 'Background task: Build finished' })
  expect(itemsOf(JSON.parse(user('Another Claude session sent a message:\n<cross-session-message from="uds:/x" from-name="helper-dc">\nPlease build it.\n</cross-session-message>\n\nThis came from another Claude session', { isMeta: true })), errs)[0])
    .toMatchObject({ kind: 'peer', name: 'helper-dc', text: 'Please build it.' })
  expect(itemsOf(JSON.parse(user('<channel source="hub" chat_id="hub">from the phone</channel>')), errs)[0].text).toBe('from the phone')
  expect(itemsOf(JSON.parse(user([{ type: 'text', text: 'look' }, { type: 'image', source: {} }])), errs)[0].text).toBe('look\n\n[image]')
  // A tool result is not shown, but an error marks its call (read later, so seen first).
  const r = new Set<string>()
  expect(itemsOf(JSON.parse(user([{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'boom' }])), r)).toEqual([])
  expect(r.has('t9')).toBe(true)
  const a = itemsOf(JSON.parse(asst([
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'Done.' },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls -la\nmore', description: 'List files' } },
    { type: 'tool_use', id: 't3', name: 'mcp__claude_ai_Slack__search_threads', input: { query: 'invoice' } },
  ])), errs)
  expect(a).toEqual([
    { kind: 'assistant', ts: '2026-11-04T10:00:01Z', text: 'Done.' },
    { kind: 'tool', ts: '2026-11-04T10:00:01Z', text: 'Bash: List files', error: true },
    { kind: 'tool', ts: '2026-11-04T10:00:01Z', text: 'search_threads (Slack): invoice' },
  ])
  expect(itemsOf(JSON.parse(line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' })), errs)[0]).toMatchObject({ kind: 'note', text: 'Conversation compacted' })
  expect(itemsOf({ type: 'api-request-blob' }, errs)).toEqual([])
  const long = itemsOf(JSON.parse(asst([{ type: 'text', text: 'y'.repeat(TEXT_MAX + 50) }])), errs)[0]
  expect(long.cut).toBe(true)
  expect(long.text.length).toBe(TEXT_MAX + 1)
  expect(toolLine('Read', { file_path: '/a/b.ts' })).toBe('Read: /a/b.ts')
  expect(toolLine('TodoWrite', { todos: [] })).toBe('TodoWrite')
})

test('readTranscript: pages go back from the end, oldest first, and meet without a gap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'))
  const p = join(dir, 't.jsonl')
  const rows: string[] = []
  for (let i = 1; i <= 7; i++) {
    rows.push(user(`q${i}`))
    rows.push(line({ type: 'api-request-blob', blob: 'z'.repeat(300) }))
    rows.push(asst([{ type: 'tool_use', id: `u${i}`, name: 'Bash', input: { description: `step ${i}` } }]))
    rows.push(user([{ type: 'tool_result', tool_use_id: `u${i}`, is_error: i === 6, content: 'x' }]))
    rows.push(asst([{ type: 'text', text: `a${i}` }]))
  }
  writeFileSync(p, rows.join('\n') + '\n{"type":"user","mess') // a line still being written
  const texts = (items: any[]) => items.map(i => i.text)
  const p1 = readTranscript(p, { limit: 4 })
  expect(texts(p1.items)).toEqual(['q6', 'Bash: step 6', 'a6', 'q7', 'Bash: step 7', 'a7'].slice(-6))
  expect(p1.items.find(i => i.text === 'Bash: step 6')?.error).toBe(true)
  expect(p1.next).toBeGreaterThan(0)
  const p2 = readTranscript(p, { before: p1.next, limit: 4 })
  expect(texts(p2.items)).toEqual(['q4', 'Bash: step 4', 'a4', 'q5', 'Bash: step 5', 'a5'])
  let all = [...p2.items, ...p1.items], next = p2.next
  while (next != null) { const pg = readTranscript(p, { before: next, limit: 4 }); all = [...pg.items, ...all]; next = pg.next }
  expect(all.filter(i => i.kind === 'user').map(i => i.text)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'])
  // A small byte budget still moves the cursor back, so paging can't stall.
  const tiny = readTranscript(p, { limit: 50, budget: 10 })
  expect(tiny.next).toBeGreaterThan(0)
  expect(readTranscript(p, { before: 0 })).toEqual({ items: [], next: null })
})

// ---------- the API ----------

const dir = claudeDir()
const cwd = '/work/hubproj'
mkdirSync(join(dir, 'projects', projectSlug(cwd)))
writeFileSync(join(dir, 'projects', projectSlug(cwd), `${SID}.jsonl`), [user('first'), asst([{ type: 'text', text: 'reply one' }]), user('second'), asst([{ type: 'text', text: 'reply two' }])].join('\n') + '\n')
writeFileSync(join(dir, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: SID, cwd }))
const panes: Pane[] = [
  { id: 'rex:a', title: 'Claude', agent: 'claude', status: 'idle', cwd, project: 'hubproj', focused: false },
  { id: 'w1:p2', title: 'other', agent: 'codex', status: 'idle', cwd, project: 'hubproj', focused: false },
]
const provider: PaneProvider = {
  async list() { return panes },
  async screen() { return '' },
  async keys() {}, async prompt() {}, async text() {},
  async agentPid(id) { return id === 'rex:a' ? 4242 : null },
}
const h = startHub({ paneProvider: provider, claudeDir: dir, paneTiming: { fastMs: 60_000, slowMs: 60_000 } })
afterAll(() => h.hub.stop())

test('GET /api/panes/:id/history pages a session transcript back; other agents and unknown panes get 404', async () => {
  const r = await h.user('/api/panes/rex%3Aa/history?limit=1')
  expect(r.status).toBe(200)
  const b = await r.json()
  expect(b.session).toBe(SID)
  expect(b.items.map((i: any) => i.text)).toEqual(['second', 'reply two'])
  expect(b.next).toBeGreaterThan(0)
  const b2 = await (await h.user(`/api/panes/rex%3Aa/history?limit=1&before=${b.next}&session=${SID}`)).json()
  expect(b2.items.map((i: any) => i.text)).toEqual(['first', 'reply one'])
  expect(b2.next).toBeNull()
  // A cursor from another session (a /clear in between) starts again from the end.
  const b3 = await (await h.user(`/api/panes/rex%3Aa/history?limit=1&before=${b.next}&session=${SID2}`)).json()
  expect(b3.items.map((i: any) => i.text)).toEqual(['second', 'reply two'])
  const no = await h.user('/api/panes/w1%3Ap2/history')
  expect(no.status).toBe(404)
  expect((await no.json()).code).toBe('no_transcript')
  expect((await h.user('/api/panes/nope/history')).status).toBe(404)
  expect((await h.user('/api/panes/rex%3Aa/history', { method: 'POST', body: '{}', headers: { 'x-hub-action': '1' } })).status).toBe(405)
})
