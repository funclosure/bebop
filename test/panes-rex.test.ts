import { test, expect } from 'bun:test'
import { rexProvider, combinedProvider, rexStatus, rexAgent, rexVtSpaces, rexPaneId, parseRexPaneId, PaneError, type Pane, type PaneProvider, type Runner } from '../hub/panes'

const S = 'session:01a1a1c7-8977-7b0c-a168-25b49b93a925'
const B1 = 'block:01a1a1c7-8977-7bc7-a5a7-51aa30da369d'
const B2 = 'block:01a1a1c7-0000-7bc7-a5a7-51aa30da369d'
const claude = { foreground: { pid: 7, argv0: 'claude', invoked_path: '/u/.local/bin/claude', name: '2.1.317', cwd: '/work/proj-r' } }
const zsh = { foreground: { pid: 8, argv0: '-zsh', name: 'zsh', cwd: '/work' } }

/** A fake rex CLI: answers by argv, records every call. */
function fakeRex(over: Record<string, { code?: number; stdout: string; stderr?: string }> = {}) {
  const calls: string[][] = []
  const run: Runner = async argv => {
    const a = argv.slice(1)
    calls.push(a)
    const key = a.join(' ')
    for (const [k, v] of Object.entries(over)) if (key.startsWith(k)) return { code: v.code ?? 0, stdout: v.stdout, stderr: v.stderr ?? '' }
    if (key === 'api call session.list') return { code: 0, stdout: JSON.stringify({ sessions: [{ session_id: S, label: 'board' }] }), stderr: '' }
    if (key.startsWith('api call session.list_blocks')) return { code: 0, stdout: JSON.stringify({ blocks: [
      { block_id: B1, creator_name: 'com.superlogical.terminal' },
      { block_id: B2, creator_name: 'com.superlogical.terminal' },
      { block_id: 'block:x', creator_name: 'com.superlogical.onboarding' },
    ] }), stderr: '' }
    if (key === `block call -b ${B1} process`) return { code: 0, stdout: JSON.stringify(claude), stderr: '' }
    if (key === `block call -b ${B2} process`) return { code: 0, stdout: JSON.stringify(zsh), stderr: '' }
    if (key === `block call -b ${B1} program_status`) return { code: 0, stdout: JSON.stringify({ records: [{ state: 'blocked', kind: 'question', owner: { pid: 7 } }] }), stderr: '' }
    if (key === `block call -b ${B1} title`) return { code: 0, stdout: '{"title":"✳ Tea or coffee"}', stderr: '' }
    return { code: 0, stdout: '{}', stderr: '' }
  }
  return { calls, run }
}

test('rex: pane ids carry session and block, and nothing else parses', () => {
  const id = rexPaneId(S, B1)
  expect(id).toBe('rex:01a1a1c7-8977-7b0c-a168-25b49b93a925:01a1a1c7-8977-7bc7-a5a7-51aa30da369d')
  expect(id.length).toBeLessThanOrEqual(100)
  expect(parseRexPaneId(id)).toEqual({ session: S, block: B1 })
  for (const bad of ['w1:p1', 'rex:x:y', `${id};rm`, `rex:${'0'.repeat(36)}`]) expect(parseRexPaneId(bad)).toBeNull()
})

test('rex: status comes from the foreground program; stale, unknown and error records are handled', () => {
  expect(rexStatus({ records: [{ state: 'working', owner: { pid: 7 } }] }, claude)).toBe('working')
  expect(rexStatus({ records: [{ state: 'blocked', owner: { pid: 99 } }] }, claude)).toBe('unknown') // an earlier program's report
  expect(rexStatus({ records: [{ id: 'build', state: 'working' }] }, claude)).toBe('unknown') // child records don't count
  expect(rexStatus({ records: [{ state: 'error' }] }, claude)).toBe('idle')
  expect(rexStatus({ records: [] }, claude)).toBe('unknown')
  expect(rexAgent(claude)).toBe('claude')
  expect(rexAgent(zsh)).toBeNull()
  expect(rexAgent({})).toBeNull()
})

test('rex: cursor-right runs become spaces', () => {
  expect(rexVtSpaces('\x1b[5Ca\x1b[Cb')).toBe('     a b')
})

test('rex: list keeps agent blocks only, with title, status and project', async () => {
  const f = fakeRex()
  const list = await rexProvider({ bin: '/opt/rex', run: f.run }).list()
  expect(list).toEqual([{ id: rexPaneId(S, B1), title: 'Tea or coffee', agent: 'claude', status: 'blocked', cwd: '/work/proj-r', project: 'proj-r', focused: false }])
})

test('rex: screen, keys, text and prompt use argv arrays; prompt is refused under a dialog', async () => {
  const f = fakeRex({ capture: { stdout: '\x1b[1mQ\x1b[0m\r\n\x1b[2C1.\x1b[1CTea\r\n\r\n' } })
  const p = rexProvider({ bin: '/opt/rex', run: f.run })
  const id = rexPaneId(S, B1)
  expect(await p.screen(id, 10, { ansi: true })).toBe('\x1b[1mQ\x1b[0m\n  1. Tea')
  expect(f.calls.at(-1)).toEqual(['capture', '-b', B1, '--format', 'vt'])
  await p.keys(id, ['esc', '2', 'shift+tab'])
  expect(f.calls.at(-1)).toEqual(['send-key', '-b', B1, 'escape', '2', 'shift+tab'])
  await p.text(id, '-x answer')
  const ev = f.calls.at(-1)!
  expect(ev.slice(0, 3)).toEqual(['api', 'call', 'block.event'])
  expect(JSON.parse(ev[3])).toEqual({ session_id: S, block_id: B1, event: { type: 'paste', payload: { text: '-x answer' } } })
  const e = await p.prompt(id, 'hi').catch(x => x)
  expect(e).toBeInstanceOf(PaneError)
  expect(e.code).toBe('agent_blocked')
  expect(await p.screen('w1:p1', 5).catch(x => x.code)).toBe('agent_not_found')
})

test('rex: prompt pastes then presses Enter when the agent is not blocked', async () => {
  const f = fakeRex({ [`block call -b ${B1} program_status`]: { stdout: '{"records":[{"state":"idle","owner":{"pid":7}}]}' } })
  await rexProvider({ bin: '/opt/rex', run: f.run }).prompt(rexPaneId(S, B1), 'go')
  expect(f.calls.slice(-2).map(c => c[0] === 'api' ? c[2] : c.join(' '))).toEqual(['block.event', `send-key -b ${B1} enter`])
})

test('rex: a CLI failure becomes a PaneError', async () => {
  const f = fakeRex({ 'api call session.list': { code: 1, stdout: '', stderr: 'Error: dial unix: connection refused\nmore' } })
  const e = await rexProvider({ bin: '/opt/rex', run: f.run }).list().catch(x => x)
  expect(e).toBeInstanceOf(PaneError)
  expect(e.message).toBe('dial unix: connection refused')
})

test('combined: lists are joined, actions go to the provider that listed the pane, one failing provider is skipped', async () => {
  const mk = (ids: string[], log: string[], fail = false): PaneProvider => ({
    async list() { if (fail) throw new PaneError('failed', 'down'); return ids.map(id => ({ id, title: id, agent: 'claude', status: 'idle', cwd: null, project: null, focused: false }) as Pane) },
    async screen(id) { log.push(`screen ${id}`); return id },
    async keys(id) { log.push(`keys ${id}`) },
    async prompt(id) { log.push(`prompt ${id}`) },
    async text(id) { log.push(`text ${id}`) },
  })
  const la: string[] = [], lb: string[] = []
  const c = combinedProvider([mk(['w1:p1'], la), mk(['rex:a'], lb)])
  expect((await c.list()).map(p => p.id)).toEqual(['w1:p1', 'rex:a'])
  await c.keys('rex:a', ['1'])
  await c.screen('w1:p1', 5)
  expect(la).toEqual(['screen w1:p1'])
  expect(lb).toEqual(['keys rex:a'])
  expect(await c.prompt('nope', 'x').catch(e => e.code)).toBe('agent_not_found')

  const d = combinedProvider([mk(['w1:p1'], []), mk([], [], true)])
  expect((await d.list()).map(p => p.id)).toEqual(['w1:p1'])
  const all = combinedProvider([mk([], [], true), mk([], [], true)])
  expect(await all.list().catch(e => e.message)).toBe('down')
})
