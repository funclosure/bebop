import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHub, readSSE } from './helpers'
import { parseHerdrList, tidyScreen, keepSgr, herdrProvider, spawnRunner, createPaneWatcher, PaneError, type Pane, type PaneProvider } from '../hub/panes'

const herdrList = {
  id: 'cli:agent:list',
  result: {
    agents: [
      { agent: 'claude', agent_status: 'blocked', cwd: '/work/proj-a', pane_id: 'w1:p1', terminal_title_stripped: 'alpha', focused: true },
      { agent: 'claude', agent_status: 'working', cwd: '/work/proj-b', pane_id: 'w1:p2', terminal_title_stripped: '', focused: false },
      { agent: 'codex', agent_status: 'strange', cwd: '', pane_id: 'w1:p3', terminal_title_stripped: 'gamma' },
      { agent: null, agent_status: 'unknown', cwd: '/work', pane_id: 'w1:p4' }, // a plain shell
    ],
  },
}

test('provider: herdr agent list is parsed; shells are dropped, odd statuses become unknown', () => {
  const panes = parseHerdrList(herdrList)
  expect(panes.map(p => p.id)).toEqual(['w1:p1', 'w1:p2', 'w1:p3'])
  expect(panes[0]).toEqual({ id: 'w1:p1', title: 'alpha', agent: 'claude', status: 'blocked', cwd: '/work/proj-a', project: 'proj-a', focused: true })
  expect(panes[1].title).toBe('claude') // no title: falls back to the agent
  expect(panes[2]).toMatchObject({ status: 'unknown', cwd: null, project: null, focused: false })
  expect(() => parseHerdrList({ error: 'x' })).toThrow(PaneError)
})

test('provider: screen text is ANSI-stripped, right-trimmed, trailing blanks dropped, last N lines', () => {
  const raw = '\x1b[1mone\x1b[0m  \r\ntwo\n\x1b]0;title\x07three\n\n  \n'
  expect(tidyScreen(raw, 60)).toBe('one\ntwo\nthree')
  expect(tidyScreen(raw, 2)).toBe('two\nthree')
})

test('provider: with ansi, SGR escapes are kept and every line that has one ends reset', () => {
  const raw = '\x1b[0m\x1b[38;2;153;153;153mgrey \x1b[0m  \r\n\x1b]0;title\x07\x1b[?25lplain\x1b[2K\n\x1b[1m\x1b[0m   \n'
  expect(tidyScreen(raw, 60, true)).toBe('\x1b[0m\x1b[38;2;153;153;153mgrey\x1b[0m\nplain')
  expect(keepSgr('\x1b[31mred\x1b[K\x1b[0m\x1b(B')).toBe('\x1b[31mred\x1b[0m')
})

test('provider: argv arrays, socket env, JSON errors become PaneError codes', async () => {
  const calls: { argv: string[]; env: Record<string, string> }[] = []
  let reply = { code: 0, stdout: JSON.stringify(herdrList), stderr: '' }
  const p = herdrProvider({ bin: '/opt/herdr', socket: '/s/h.sock', run: async (argv, env) => { calls.push({ argv, env }); return reply } })
  expect((await p.list()).length).toBe(3)
  expect(calls[0]).toEqual({ argv: ['/opt/herdr', 'agent', 'list'], env: { HERDR_SOCKET_PATH: '/s/h.sock' } })

  reply = { code: 0, stdout: 'screen\n\n', stderr: '' }
  expect(await p.screen('w1:p1', 10)).toBe('screen')
  expect(calls[1].argv).toEqual(['/opt/herdr', 'agent', 'read', 'w1:p1', '--source', 'recent', '--lines', '10', '--format', 'text'])
  reply = { code: 0, stdout: '\x1b[1mbold\x1b[0m\n', stderr: '' }
  expect(await p.screen('w1:p1', 10, { ansi: true })).toBe('\x1b[1mbold\x1b[0m')
  expect(calls[2].argv.at(-1)).toBe('ansi')
  calls.splice(1, 1)

  // A blocked alternate-screen pane can't give its history: the visible screen instead.
  const replies = [{ code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_idle","message":"cannot read 150 lines while w1:p1 is blocked"}}' },{ code: 0, stdout: 'dialog\n', stderr: '' }]
  const q = herdrProvider({ bin: '/opt/herdr', run: async argv => { calls.push({ argv, env: {} }); return replies.shift()! } })
  expect(await q.screen('w1:p1', 150)).toBe('dialog')
  expect(calls.slice(-2).map(c => c.argv[5])).toEqual(['recent', 'visible'])
  calls.splice(-2, 2)

  reply = { code: 0, stdout: '{"id":"x","result":{"type":"ok"}}', stderr: '' }
  await p.keys('w1:p1', ['shift+tab', 'enter'])
  await p.prompt('w1:p1', '--wait; rm -rf /')
  expect(calls[2].argv).toEqual(['/opt/herdr', 'agent', 'send-keys', 'w1:p1', 'shift+tab', 'enter'])
  expect(calls[3].argv).toEqual(['/opt/herdr', 'agent', 'prompt', 'w1:p1', '--wait; rm -rf /'])
  await p.text('w1:p1', '-x my answer')
  expect(calls[4].argv).toEqual(['/opt/herdr', 'pane', 'send-text', 'w1:p1', '-x my answer'])

  reply = { code: 1, stdout: '{"error":{"code":"agent_blocked","message":"agent is blocked"},"id":"x"}', stderr: '' }
  const e = await p.prompt('w1:p1', 'hi').catch(x => x)
  expect(e).toBeInstanceOf(PaneError)
  expect(e.code).toBe('agent_blocked')

  reply = { code: 2, stdout: '', stderr: 'boom' }
  expect((await p.list().catch(x => x)).code).toBe('failed')
})

test('provider: a hung CLI is killed after the timeout', async () => {
  const t0 = Date.now()
  const e = await spawnRunner(['sleep', '5'], {}, 200).catch(x => x)
  expect(e.code).toBe('timeout')
  expect(Date.now() - t0).toBeLessThan(2000)
})

test('watcher: a push on the transition into blocked, at most one per pane per gap; the first poll is a baseline', () => {
  let clock = 1_000_000
  const pushed: string[] = []
  const changes: number[] = []
  const w = createPaneWatcher({
    provider: null as unknown as PaneProvider, watched: () => false,
    onChange: (l, u) => changes.push(u), onBlocked: p => pushed.push(p.id),
    pushGapMs: 120_000, now: () => clock,
  })
  const pane = (id: string, status: Pane['status']): Pane => ({ id, title: id, agent: 'claude', status, cwd: null, project: null, focused: false })

  w.observe([pane('a', 'blocked'), pane('b', 'idle')]) // baseline: 'a' was already blocked
  expect(pushed).toEqual([])
  clock += 3000; w.observe([pane('a', 'blocked'), pane('b', 'blocked')])
  expect(pushed).toEqual(['b'])
  clock += 3000; w.observe([pane('a', 'blocked'), pane('b', 'blocked')]) // still blocked: no new push
  expect(pushed).toEqual(['b'])
  expect(changes.length).toBe(2) // unchanged list: no broadcast
  clock += 3000; w.observe([pane('a', 'idle'), pane('b', 'working')])
  clock += 3000; w.observe([pane('a', 'blocked'), pane('b', 'blocked')]) // 'b' again within 2 min: throttled
  expect(pushed).toEqual(['b', 'a'])
  clock += 120_000; w.observe([pane('a', 'idle'), pane('b', 'idle')])
  clock += 3000; w.observe([pane('a', 'idle'), pane('b', 'blocked')])
  expect(pushed).toEqual(['b', 'a', 'b'])
  clock += 3000; w.observe([pane('a', 'idle'), pane('b', 'blocked'), pane('c', 'blocked')]) // a new pane, already blocked
  expect(pushed).toEqual(['b', 'a', 'b', 'c'])
})

// ---------- the HTTP side, with a fake provider ----------
function fakeProvider() {
  const state = {
    panes: parseHerdrList(herdrList),
    calls: [] as { op: string; id: string; arg?: unknown }[],
    blocked: false,
  }
  const provider: PaneProvider = {
    async list() { return state.panes.map(p => ({ ...p })) },
    async screen(id, lines, opts) { state.calls.push({ op: 'screen', id, arg: lines }); return opts?.ansi ? `\x1b[1mscreen\x1b[0m of ${id}` : `screen of ${id}` },
    async keys(id, keys) { state.calls.push({ op: 'keys', id, arg: keys }) },
    async prompt(id, text) {
      if (state.blocked) throw new PaneError('agent_blocked', 'agent is blocked')
      state.calls.push({ op: 'prompt', id, arg: text })
    },
    async text(id, text) { state.calls.push({ op: 'text', id, arg: text }) },
  }
  return { state, provider }
}

const fake = fakeProvider()
const pushes: any[] = []
const { hub, user } = startHub({ paneProvider: fake.provider, sendPush: p => { pushes.push(p) }, paneTiming: { fastMs: 50, slowMs: 50 } })
afterAll(() => hub.stop())
const act = (path: string, body: unknown, headers: Record<string, string> = { 'x-hub-action': '1' }) =>
  user(path, { method: 'POST', body: JSON.stringify(body), headers })
const enc = encodeURIComponent

test('panes off: /api/panes* are 404 and config says so', async () => {
  const h = startHub()
  try {
    expect((await h.user('/api/panes')).status).toBe(404)
    expect((await h.user('/api/panes/w1:p1/screen')).status).toBe(404)
    expect((await (await h.user('/api/config')).json()).panes).toBe(false)
  } finally { h.hub.stop() }
  expect((await (await user('/api/config')).json()).panes).toBe(true)
})

test('panes: list and screen; an unknown pane is 404', async () => {
  const list = await (await user('/api/panes')).json()
  expect(list.panes.map((p: Pane) => p.id)).toEqual(['w1:p1', 'w1:p2', 'w1:p3'])
  expect(typeof list.updated).toBe('string')

  const s = await (await user(`/api/panes/${enc('w1:p1')}/screen?lines=999`)).json()
  expect(s).toMatchObject({ id: 'w1:p1', text: 'screen of w1:p1', status: 'blocked' })
  expect(fake.state.calls.at(-1)).toEqual({ op: 'screen', id: 'w1:p1', arg: 400 })
  expect(s.ansi).toBeUndefined()
  const a = await (await user(`/api/panes/${enc('w1:p1')}/screen?ansi=1`)).json()
  expect(a).toMatchObject({ text: 'screen of w1:p1', ansi: '\x1b[1mscreen\x1b[0m of w1:p1' })

  expect((await user('/api/panes/w9:p9/screen')).status).toBe(404)
  expect((await act('/api/panes/w9:p9/keys', { keys: ['enter'] })).status).toBe(404)
  expect((await act('/api/panes/w1:p4/keys', { keys: ['enter'] })).status).toBe(404) // a shell, not an agent
})

test('panes: writes need X-Hub-Action and a JSON content type', async () => {
  const before = fake.state.calls.length
  expect((await act('/api/panes/w1:p1/keys', { keys: ['enter'] }, {})).status).toBe(403)
  expect((await act('/api/panes/w1:p1/keys', { keys: ['enter'] }, { 'x-hub-action': '1', 'content-type': 'text/plain' })).status).toBe(403)
  expect((await act('/api/panes/w1:p1/keys', { keys: ['enter'] }, { 'x-hub-action': 'yes' })).status).toBe(403)
  expect(fake.state.calls.length).toBe(before)
})

test('panes: only allowlisted keys, at most 8', async () => {
  const before = fake.state.calls.length
  for (const keys of [['ctrl+c'], ['enter', 'q'], [], Array(9).fill('down'), 'enter', [1]]) {
    expect((await act('/api/panes/w1:p1/keys', { keys })).status).toBe(400)
  }
  expect(fake.state.calls.length).toBe(before)
  expect((await act('/api/panes/w1:p1/keys', { keys: ['2', 'shift+tab', 'esc', 'enter'] })).status).toBe(200)
  expect(fake.state.calls.at(-1)).toEqual({ op: 'keys', id: 'w1:p1', arg: ['2', 'shift+tab', 'esc', 'enter'] })
})

test('panes: prompt is 1-4000 chars; agent_blocked reaches the client', async () => {
  expect((await act('/api/panes/w1:p2/prompt', { text: '   ' })).status).toBe(400)
  expect((await act('/api/panes/w1:p2/prompt', { text: 'x'.repeat(4001) })).status).toBe(400)
  expect((await act('/api/panes/w1:p2/prompt', { text: 'x'.repeat(4000) })).status).toBe(200)
  fake.state.blocked = true
  const r = await act('/api/panes/w1:p2/prompt', { text: 'go' })
  expect(r.status).toBe(409)
  expect((await r.json()).code).toBe('agent_blocked')
  fake.state.blocked = false
})

test('panes: text is typed even while a dialog is up; no control characters', async () => {
  fake.state.blocked = true
  try {
    expect((await act('/api/panes/w1:p2/text', { text: 'my own answer' })).status).toBe(200)
    expect(fake.state.calls.at(-1)).toEqual({ op: 'text', id: 'w1:p2', arg: 'my own answer' })
    for (const text of ['', '  ', 'two\nlines', 'esc\x1b[A', 'x'.repeat(4001), 5]) {
      expect((await act('/api/panes/w1:p2/text', { text })).status).toBe(400)
    }
    expect((await act('/api/panes/w1:p4/text', { text: 'hi' })).status).toBe(404) // a shell, not an agent
    expect((await act('/api/panes/w1:p2/text', { text: 'hi' }, {})).status).toBe(403)
    const row = hub.db.query(`SELECT * FROM pane_actions WHERE action = 'text' ORDER BY id DESC LIMIT 1`).get() as any
    expect(row).toMatchObject({ pane: 'w1:p2', payload: '"my own answer"' })
  } finally { fake.state.blocked = false }
})

test('panes: every write is kept in pane_actions', async () => {
  await act('/api/panes/w1:p2/prompt', { text: 'audit me' })
  const row = hub.db.query(`SELECT * FROM pane_actions WHERE action = 'prompt' ORDER BY id DESC LIMIT 1`).get() as any
  expect(row).toMatchObject({ pane: 'w1:p2', title: 'claude', action: 'prompt', payload: '"audit me"', login: 'local' })
  const keys = hub.db.query(`SELECT * FROM pane_actions WHERE action = 'keys' ORDER BY id DESC LIMIT 1`).get() as any
  expect(JSON.parse(keys.payload)).toEqual(['2', 'shift+tab', 'esc', 'enter'])
})

test('panes: SSE panes event on a change; a push when one becomes blocked', async () => {
  const res = await user('/api/events')
  const p = readSSE(res, e => e.some(x => x.event === 'panes' && x.data.panes.some((q: Pane) => q.id === 'w1:p2' && q.status === 'blocked')))
  await Bun.sleep(100)
  fake.state.panes[1].status = 'blocked'
  const ev = await p
  expect(ev.some(x => x.event === 'panes')).toBe(true)
  const push = pushes.find(x => x.pane === 'w1:p2')
  expect(push).toMatchObject({ title: 'claude', body: 'Waiting for you', tag: 'pane:w1:p2', url: '/?pane=w1%3Ap2' })
  fake.state.panes[1].status = 'working'
})

test('panes: the real runner against a stub herdr binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-herdr-'))
  const bin = join(dir, 'herdr')
  writeFileSync(join(dir, 'list.json'), JSON.stringify(herdrList))
  writeFileSync(bin, `#!/bin/sh
printf '%s|' "$HERDR_SOCKET_PATH" "$@" >> "${dir}/argv"; echo >> "${dir}/argv"
case "$2" in
  list) cat "${dir}/list.json" ;;
  read) printf 'hello\\n\\n' ;;
  *) echo '{"id":"x","result":{"type":"ok"}}' ;;
esac
`)
  chmodSync(bin, 0o755)
  const h = startHub({ herdrBin: bin, herdrSocket: '/tmp/fake.sock' })
  try {
    expect((await (await h.user('/api/panes')).json()).panes.length).toBe(3)
    expect((await (await h.user('/api/panes/w1:p1/screen')).json()).text).toBe('hello')
    const r = await h.user('/api/panes/w1:p1/keys', { method: 'POST', body: JSON.stringify({ keys: ['1'] }), headers: { 'x-hub-action': '1' } })
    expect(r.status).toBe(200)
    const argv = readFileSync(join(dir, 'argv'), 'utf8')
    expect(argv).toContain('/tmp/fake.sock|agent|send-keys|w1:p1|1|')
  } finally { h.hub.stop() }
})
