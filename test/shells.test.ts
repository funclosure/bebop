import { test, expect, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createShells, loadShellsConfig, insideRoots, riskOf, shellEnv, SHELL_ARM_MS, SHELL_IDLE_MS, type ShellBackend, type Shareable } from '../hub/shells'
import { rexProvider, rexShellBackend, herdrProvider, herdrShellBackend, herdrProbe, rexPaneId, type Pane, type PaneProvider, type Runner } from '../hub/panes'
import { startHub } from './helpers'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'shells-root-')))
for (const d of ['proj-a', 'proj-b', 'proj-c', 'mine']) mkdirSync(join(root, d))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'shells-out-')))
symlinkSync(outside, join(root, 'sneaky'))

test('folders: real paths inside the roots only (links resolved)', () => {
  expect(insideRoots(join(root, 'proj-a'), [root])).toBe(join(root, 'proj-a'))
  expect(insideRoots(root, [root])).toBe(root)
  expect(insideRoots(join(root, 'sneaky'), [root])).toBeNull()
  expect(insideRoots(outside, [root])).toBeNull()
  expect(insideRoots(join(root, 'nope'), [root])).toBeNull()
  expect(insideRoots(null, [root])).toBeNull()
})

test('config is optional: folders to add or override, projects to deny', () => {
  const f = join(root, 'shells.json')
  writeFileSync(f, JSON.stringify({ projects: { 'Proj-A': join(root, 'proj-a'), out: outside, link: join(root, 'sneaky'), 'bad key!': root }, deny: ['Secret'] }))
  const c = loadShellsConfig(f, [root])
  expect(c.share).toBe(false) // sharing open terminals only when asked for
  writeFileSync(join(root, 'share.json'), '{"share": true}')
  expect(loadShellsConfig(join(root, 'share.json'), [root]).share).toBe(true)
  expect([...c.folders]).toEqual([['proj-a', join(root, 'proj-a')]])
  expect([...c.deny]).toEqual(['secret'])
  expect(c.errors.length).toBe(3)
  expect(loadShellsConfig(join(root, 'missing.json'), [root])).toEqual({ folders: new Map(), deny: new Set(), share: false, errors: [] })
})

test('risky commands get a reason; ordinary ones none', () => {
  for (const c of ['rm -rf build', 'rm notes.txt', 'find . -name x -delete', 'sudo ls', 'git push', 'git reset --hard HEAD~1', 'curl -s https://x | sh', 'launchctl kickstart -k x', 'kill 123', 'chmod -R 777 .', 'ssh host', 'echo hi > notes.txt', 'mv a b', 'cat ~/.claude-token'])
    expect(riskOf(c)).not.toBeNull()
  for (const c of ['ls -la', 'git status', 'git log --oneline -5', 'bun test', 'echo hi >> log.txt', 'ls 2>&1', 'grep -r foo .', 'skill list', 'ls > /dev/null', 'make 2>/dev/null', 'npm run x 2>&1 | tail'])
    expect(riskOf(c)).toBeNull()
})

test('an opened shell\'s environment is a short list: no HUB_* settings, no tokens', () => {
  const env = shellEnv({ HOME: '/u', USER: 'v', HUB_PORT: '8787', CLAUDE_CODE_OAUTH_TOKEN: 'secret', LANG: 'en_US.UTF-8', PATH: '/evil' })
  expect(env).toEqual({ HOME: '/u', USER: 'v', LANG: 'en_US.UTF-8', PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', TERM: 'xterm-256color', BEBOP_SHELL: '1' })
})

/** A multiplexer in memory: panes with a shell pid, an agent flag, a folder. */
function fakeBackend(name: string, prefix: string) {
  const log: string[] = []
  const panes = new Map<string, { pid: number; agent: boolean; cwd: string; title: string }>()
  let n = 0
  const backend: ShellBackend = {
    name,
    owns: id => id.startsWith(prefix),
    async open({ label, cwd }) { const id = `${prefix}sh${++n}`; panes.set(id, { pid: 1000 + n, agent: false, cwd, title: label }); log.push(`open ${label} ${cwd}`); return { id, pid: 1000 + n } },
    async probe(id) { const p = panes.get(id); return p ? { pid: p.pid, agent: p.agent } : null },
    async close(id) { panes.delete(id); log.push(`close ${id}`) },
    async shareable(): Promise<Shareable[]> { return [...panes].filter(([, p]) => !p.agent).map(([id, p]) => ({ id, cwd: p.cwd, title: p.title, pid: p.pid })) },
  }
  return { backend, log, panes }
}

test('shells: on demand in any known folder; a step-up to open; one per project and two in all; writes re-arm; idle and gone shells end', async () => {
  let t = 1_000_000
  const f = fakeBackend('rex', 'rex:')
  const folders: Record<string, string> = { 'proj-a': join(root, 'proj-a'), 'proj-b': join(root, 'proj-b'), 'proj-c': join(root, 'proj-c'), out: outside }
  const sh = createShells({ db: new Database(':memory:'), backends: [f.backend], folderOf: k => folders[k] ?? null, roots: [root], now: () => t })
  expect(await sh.open('proj-a', 'v', false).catch(e => e.code)).toBe('stepup')
  expect(await sh.open('unknown', 'v', true).catch(e => e.code)).toBe('no_folder')
  expect(await sh.open('out', 'v', true).catch(e => e.code)).toBe('no_folder') // outside the roots
  const a = await sh.open('Proj-A', 'v', true)
  expect(a).toEqual({ id: 'rex:sh1', reused: false })
  expect(f.log).toEqual([`open bebop-shell-proj-a ${join(root, 'proj-a')}`])
  expect(await sh.open('proj-a', 'v', true)).toEqual({ id: 'rex:sh1', reused: true })
  await sh.open('proj-b', 'v', true)
  expect(await sh.open('proj-c', 'v', true).catch(e => e.code)).toBe('too_many')

  await sh.checkWrite('rex:sh1', false) // armed by the open
  t += SHELL_ARM_MS + 1
  expect(await sh.checkWrite('rex:sh1', false).catch(e => e.code)).toBe('stepup')
  await sh.checkWrite('rex:sh1', true)
  await sh.checkWrite('rex:sh1', false)
  sh.disarm('rex:sh1') // the app went to the background
  expect(await sh.checkWrite('rex:sh1', false).catch(e => e.code)).toBe('stepup')

  // Another process in the pane, or an agent started in it: not the hub's shell any more.
  f.panes.get('rex:sh2')!.pid = 9
  expect(await sh.checkWrite('rex:sh2', true).catch(e => e.code)).toBe('agent_not_found')
  expect(sh.get('rex:sh2')).toBeNull()
  t += SHELL_IDLE_MS + 1
  await sh.sweep()
  expect(sh.list()).toEqual([])
  expect(f.log.filter(l => l.startsWith('close'))).toEqual(['close rex:sh2', 'close rex:sh1'])
})

test('shells: opened at a session\'s folder: its folder name is the project; same folder → the same shell; outside or denied → none', async () => {
  const f = fakeBackend('rex', 'rex:')
  const sh = createShells({ db: new Database(':memory:'), backends: [f.backend], folderOf: () => null, roots: [root], denied: k => k === 'proj-b' })
  const a = await sh.open('', 'v', true, join(root, 'mine'))
  expect(sh.get(a.id)).toMatchObject({ project: 'mine', cwd: join(root, 'mine'), mode: 'opened' })
  expect(await sh.open('', 'v', true, join(root, 'mine'))).toEqual({ id: a.id, reused: true })
  expect(await sh.open('', 'v', true, outside).catch(e => e.code)).toBe('no_folder')
  expect(await sh.open('', 'v', true, join(root, 'proj-b')).catch(e => e.code)).toBe('no_folder')
  expect(await sh.open('', 'v', true, '').catch(e => e.code)).toBe('no_folder')
})

test('shells: sharing shows the user\'s own terminal (no agent, inside the roots) and never ends it', async () => {
  let t = 5_000_000
  const rex = fakeBackend('rex', 'rex:'), herdr = fakeBackend('herdr', 'w')
  herdr.panes.set('w1:p1', { pid: 77, agent: false, cwd: join(root, 'mine'), title: 'me@box:~/mine' })
  herdr.panes.set('w1:p2', { pid: 78, agent: true, cwd: join(root, 'mine'), title: 'claude' })
  herdr.panes.set('w1:p3', { pid: 79, agent: false, cwd: outside, title: 'tmp' })
  herdr.panes.set('w1:p4', { pid: 80, agent: false, cwd: join(root, 'mine'), title: 'claude --resume x' })
  const off = createShells({ db: new Database(':memory:'), backends: [herdr.backend], folderOf: () => null, roots: [root] })
  expect(await off.shareable().catch(e => e.code)).toBe('share_off')
  expect(await off.share('w1:p1', 'v', true).catch(e => e.code)).toBe('share_off')
  const sh = createShells({ db: new Database(':memory:'), backends: [rex.backend, herdr.backend], folderOf: () => null, roots: [root], now: () => t,
    share: true, neverShare: s => /claude/.test(s.title) })
  expect((await sh.shareable()).map(s => [s.id, s.project, s.backend])).toEqual([['w1:p1', 'mine', 'herdr']])
  expect(await sh.share('w1:p1', 'v', false).catch(e => e.code)).toBe('stepup')
  expect(await sh.share('w1:p2', 'v', true).catch(e => e.code)).toBe('not_shareable') // an agent
  expect(await sh.share('w1:p3', 'v', true).catch(e => e.code)).toBe('not_shareable') // outside
  expect(await sh.share('w1:p1', 'v', true)).toEqual({ id: 'w1:p1', reused: false })
  expect(sh.get('w1:p1')).toMatchObject({ mode: 'shared', backend: 'herdr', project: 'mine', pid: 77 })
  expect(await sh.shareable()).toEqual([]) // shown already
  await sh.checkWrite('w1:p1', false)
  // Stopping, idling out or a restart only stops sharing: the pane stays.
  await sh.close('w1:p1', 'stopped sharing in the app')
  expect(herdr.panes.has('w1:p1')).toBe(true)
  expect(herdr.log).toEqual([])
  await sh.share('w1:p1', 'v', true)
  // An agent started in a shared terminal: it stops being shared at the next write.
  herdr.panes.get('w1:p1')!.agent = true
  expect(await sh.checkWrite('w1:p1', true).catch(e => e.code)).toBe('agent_not_found')
  expect(herdr.panes.has('w1:p1')).toBe(true)
})

test('shells: at start every shell left from before ends (a shared one is only unshared)', async () => {
  const db = new Database(':memory:')
  const f = fakeBackend('rex', 'rex:')
  f.panes.set('rex:own', { pid: 5, agent: false, cwd: join(root, 'mine'), title: 'own' })
  const mk = () => createShells({ db, backends: [f.backend], folderOf: k => k === 'proj-a' ? join(root, 'proj-a') : null, roots: [root], share: true })
  const first = mk()
  await first.open('proj-a', 'v', true)
  await first.share('rex:own', 'v', true)
  const next = mk()
  await next.closeAll('hub restart')
  expect(next.list()).toEqual([])
  expect(f.log).toEqual([`open bebop-shell-proj-a ${join(root, 'proj-a')}`, 'close rex:sh1'])
  expect(f.panes.has('rex:own')).toBe(true)
})

// ---------- Rex ----------

const S = 'session:01a1a609-0ce3-7167-a4b3-a51bec7845f9'
const B = 'block:01a1a609-0ce3-71e8-9e06-fc0f5a7ff296'
function fakeRex(proc: any) {
  const calls: string[][] = []
  const run: Runner = async argv => {
    const a = argv.slice(1)
    calls.push(a)
    const key = a.join(' ')
    if (a[0] === 'new') return { code: 0, stdout: JSON.stringify({ session_id: S, initial_windows: [{ block_ids: [B] }] }), stderr: '' }
    if (key === 'api call session.list') return { code: 0, stdout: JSON.stringify({ sessions: [{ session_id: S, label: 'bebop-shell-proj-a' }] }), stderr: '' }
    if (key.startsWith('api call session.list_blocks')) return { code: 0, stdout: JSON.stringify({ blocks: [{ block_id: B, creator_name: 'com.superlogical.terminal' }] }), stderr: '' }
    if (key.includes(' process')) return { code: 0, stdout: JSON.stringify(proc), stderr: '' }
    return { code: 0, stdout: '{}', stderr: '' }
  }
  return { calls, run }
}

test('rex: a plain shell is listed only when it is one of the hub\'s; the backend opens zsh through env -i, probes, shares and kills', async () => {
  const zsh = { child: { pid: 50, name: 'zsh', cwd: '/w/proj-a' }, foreground: { pid: 50, argv0: '/bin/zsh', name: 'zsh', cwd: '/w/proj-a' } }
  const f = fakeRex(zsh)
  const ids = new Set<string>()
  const p = rexProvider({ bin: '/opt/rex', run: f.run, shells: () => ids })
  expect(await p.list()).toEqual([])
  ids.add(rexPaneId(S, B))
  expect(await p.list()).toEqual([{ id: rexPaneId(S, B), title: 'proj-a', agent: 'shell', status: 'idle', cwd: '/w/proj-a', project: 'proj-a', focused: false }])
  const busy = fakeRex({ ...zsh, foreground: { pid: 51, name: 'sleep', cwd: '/w/proj-a' } })
  expect((await rexProvider({ bin: '/opt/rex', run: busy.run, shells: () => ids }).list())[0].status).toBe('working')

  const be = rexShellBackend({ bin: '/opt/rex', run: f.run })
  expect(be.owns(rexPaneId(S, B))).toBe(true)
  expect(be.owns('w1:p1')).toBe(false)
  expect(await be.open({ label: 'bebop-shell-proj-a', cwd: '/w/proj-a', env: { HOME: '/u', BEBOP_SHELL: '1' } })).toEqual({ id: rexPaneId(S, B), pid: 50 })
  expect(f.calls.find(c => c[0] === 'new')).toEqual(['new', 'bebop-shell-proj-a', '--cwd', '/w/proj-a', '--json', '--shell', 'none', '--', '/usr/bin/env', '-i', 'HOME=/u', 'BEBOP_SHELL=1', '/bin/zsh', '-l'])
  expect(await be.probe(rexPaneId(S, B))).toEqual({ pid: 50, agent: false })
  expect(await be.shareable()).toEqual([{ id: rexPaneId(S, B), cwd: '/w/proj-a', title: 'bebop-shell-proj-a', pid: 50 }])
  const claude = fakeRex({ child: { pid: 60 }, foreground: { pid: 61, argv0: 'claude', cwd: '/w' } })
  const cb = rexShellBackend({ bin: '/opt/rex', run: claude.run })
  expect(await cb.probe(rexPaneId(S, B))).toEqual({ pid: 60, agent: true })
  expect(await cb.shareable()).toEqual([])
  await be.close(rexPaneId(S, B))
  expect(f.calls.at(-1)).toEqual(['kill', S])
})

// ---------- herdr ----------

function fakeHerdr(o: { fg?: any[]; agents?: string[] } = {}) {
  const calls: string[][] = []
  const run: Runner = async argv => {
    const a = argv.slice(1)
    calls.push(a)
    const ok = (result: any) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: '' })
    if (a[0] === 'tab' && a[1] === 'create') return ok({ root_pane: { pane_id: 'w8:p3', tab_id: 'w8:t2' }, tab: { tab_id: 'w8:t2' } })
    if (a[0] === 'pane' && a[1] === 'process-info') return ok({ process_info: { shell_pid: 72985, foreground_processes: o.fg ?? [{ argv0: 'zsh', name: 'zsh', argv: ['-zsh'], pid: 72985 }] } })
    if (a[0] === 'pane' && a[1] === 'get') return ok({ pane: { pane_id: a[2], tab_id: 'w8:t2' } })
    if (a[0] === 'pane' && a[1] === 'list') return ok({ panes: [{ pane_id: 'w8:p3', cwd: '/w/proj-a', foreground_cwd: '/w/proj-a', terminal_title_stripped: 'me@box:~/w/proj-a' }, { pane_id: 'w1:p1', cwd: '/w/x' }] })
    if (a[0] === 'agent' && a[1] === 'list') return ok({ agents: (o.agents ?? []).map(id => ({ pane_id: id, agent: 'claude', agent_status: 'idle', cwd: '/w/x' })) })
    if (a[0] === 'pane' && a[1] === 'read') return { code: 0, stdout: '$ ls\n', stderr: '' }
    if (a[0] === 'pane' && (a[1] === 'send-text' || a[1] === 'send-keys')) return { code: 0, stdout: '', stderr: '' } // herdr prints nothing here
    return ok({ type: 'ok' })
  }
  return { calls, run }
}

test('herdr: probe sees the shell pid and an agent in front', () => {
  expect(herdrProbe({ result: { process_info: { shell_pid: 5, foreground_processes: [{ argv0: 'zsh', pid: 5 }] } } })).toEqual({ pid: 5, agent: false })
  expect(herdrProbe({ result: { process_info: { shell_pid: 5, foreground_processes: [{ argv0: 'node', name: '2.1.318', argv: ['/u/.local/bin/claude'] }] } } })).toEqual({ pid: 5, agent: true })
  expect(herdrProbe({ result: {} })).toBeNull()
})

test('herdr: the backend opens a tab, execs a clean zsh (quoted), shares plain panes, closes the tab', async () => {
  const f = fakeHerdr({ agents: ['w1:p1'] })
  const be = herdrShellBackend({ bin: '/opt/herdr', run: f.run })
  expect(be.owns('w8:p3')).toBe(true)
  expect(be.owns(rexPaneId(S, B))).toBe(false)
  expect(await be.open({ label: 'bebop-shell-proj-a', cwd: '/w/proj-a', env: { HOME: '/u', USER: "o'neil" } })).toEqual({ id: 'w8:p3', pid: 72985 })
  expect(f.calls[0]).toEqual(['tab', 'create', '--cwd', '/w/proj-a', '--label', 'bebop-shell-proj-a', '--no-focus'])
  expect(f.calls.find(c => c[1] === 'run')).toEqual(['pane', 'run', 'w8:p3', `exec /usr/bin/env -i 'HOME=/u' 'USER=o'\\''neil' /bin/zsh -l`])
  expect(await be.shareable()).toEqual([{ id: 'w8:p3', cwd: '/w/proj-a', title: 'me@box:~/w/proj-a', pid: 72985 }]) // w1:p1 runs an agent
  await be.close('w8:p3')
  expect(f.calls.at(-1)).toEqual(['tab', 'close', 'w8:t2'])
})

test('herdr: the provider lists the hub\'s shells next to agents and drives them through pane commands', async () => {
  const f = fakeHerdr()
  const ids = new Set<string>(['w8:p3'])
  const p = herdrProvider({ bin: '/opt/herdr', run: f.run, shells: () => ids })
  expect(await p.list()).toEqual([{ id: 'w8:p3', title: 'proj-a', agent: 'shell', status: 'idle', cwd: '/w/proj-a', project: 'proj-a', focused: false }])
  await p.screen('w8:p3', 10)
  expect(f.calls.at(-1)!.slice(0, 3)).toEqual(['pane', 'read', 'w8:p3'])
  await p.keys('w8:p3', ['ctrl+c'])
  expect(f.calls.at(-1)).toEqual(['pane', 'send-keys', 'w8:p3', 'ctrl+c'])
  await p.prompt('w8:p3', 'ls -la')
  expect(f.calls.slice(-2)).toEqual([['pane', 'send-text', 'w8:p3', 'ls -la'], ['pane', 'send-keys', 'w8:p3', 'enter']])
  // Without shells it is the agent list only, as before.
  const q = fakeHerdr()
  expect(await herdrProvider({ bin: '/opt/herdr', run: q.run }).list()).toEqual([])
  expect(q.calls.map(c => c.slice(0, 2).join(' '))).toEqual(['agent list'])
})

// ---------- the API ----------

const fb = fakeBackend('rex', 'rex:')
fb.panes.set('rex:mine', { pid: 42, agent: false, cwd: join(root, 'mine'), title: 'my shell' })
const writes: string[] = []
let shown = new Set<string>()
const provider: PaneProvider = {
  async list() {
    const agent: Pane = { id: 'w1:p1', title: 'Claude', agent: 'claude', status: 'idle', cwd: null, project: null, focused: false }
    const inMine: Pane = { id: 'w1:p9', title: 'Claude in mine', agent: 'claude', status: 'idle', cwd: join(root, 'mine'), project: 'mine', focused: false }
    return [agent, inMine, ...[...fb.panes.keys()].filter(id => shown.has(id)).map(id => ({ id, title: 'Shell', agent: 'shell', status: 'idle', cwd: fb.panes.get(id)!.cwd, project: 'x', focused: false }) as Pane)]
  },
  async screen() { return '$' },
  async keys(id, k) { writes.push(`keys ${id} ${k.join(' ')}`) },
  async prompt(id, t) { writes.push(`prompt ${id} ${t}`) },
  async text(id, t) { writes.push(`text ${id} ${t}`) },
}
const shellsFile = join(root, 'api-shells.json')
writeFileSync(shellsFile, JSON.stringify({ projects: { 'proj-a': join(root, 'proj-a') }, deny: ['proj-b'], share: true }))
const auth = { lockOn: true, stepped: false }
const h = startHub({
  paneProvider: provider, shells: 'on', shellsFile, shellBackends: [fb.backend], iconRoots: [root],
  shellAuth: { lockOn: () => auth.lockOn, steppedUp: () => auth.stepped },
  paneTiming: { fastMs: 60_000, slowMs: 60_000 },
})
afterAll(() => h.hub.stop())
const post = (path: string, body: any) => h.user(path, { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify(body) })

test('API: open on demand (lock on, step-up, a known folder, deny honoured), then one line at a time with confirms', async () => {
  const cfg = await (await h.user('/api/config')).json()
  expect([cfg.shells, cfg.shell_share]).toEqual([true, true])
  auth.lockOn = false
  expect((await (await post('/api/shells', { project: 'proj-a' })).json()).code).toBe('lock_off')
  auth.lockOn = true
  expect((await (await post('/api/shells', { project: 'proj-a' })).json()).code).toBe('stepup')
  expect((await h.user('/api/shells', { method: 'POST', body: '{}' })).status).toBe(403) // no X-Hub-Action
  auth.stepped = true
  expect((await (await post('/api/shells', { project: 'proj-b' })).json()).code).toBe('no_folder') // denied (and has none)
  // proj-c has no entry in shells.json: found under the roots by name, on demand.
  const c = await (await post('/api/shells', { project: 'proj-c' })).json()
  expect(c.reused).toBe(false)
  expect(fb.panes.get(c.id)!.cwd).toBe(join(root, 'proj-c'))
  await post(`/api/shells/${encodeURIComponent(c.id)}/close`, {})
  // From a session's screen: a terminal in that session's folder; a session with no folder, or a shell, has none.
  const fromSession = await (await post('/api/shells', { pane: 'w1:p9' })).json()
  expect(fb.panes.get(fromSession.id)!.cwd).toBe(join(root, 'mine'))
  expect((await (await post('/api/shells', { pane: 'w1:p1' })).json()).code).toBe('no_folder')
  expect((await (await post('/api/shells', { pane: 'nope' })).json()).code).toBe('no_folder')
  await post(`/api/shells/${encodeURIComponent(fromSession.id)}/close`, {})
  const r = await (await post('/api/shells', { project: 'proj-a' })).json()
  shown = new Set([r.id])
  const id = r.id, path = `/api/panes/${encodeURIComponent(id)}`
  auth.stepped = false
  const list = await (await h.user('/api/panes')).json()
  expect(list.panes.find((p: any) => p.id === id).shell).toBe('opened')

  expect((await post(`${path}/prompt`, { text: 'ls -la' })).status).toBe(200)
  const risky = await post(`${path}/prompt`, { text: 'rm -rf build' })
  expect(risky.status).toBe(409)
  expect(await risky.json()).toMatchObject({ code: 'confirm', reason: 'deletes files' })
  expect((await post(`${path}/prompt`, { text: 'rm -rf build', confirm: true })).status).toBe(200)
  expect((await post(`${path}/prompt`, { text: 'ls\nrm -rf /' })).status).toBe(400)
  expect((await post(`${path}/text`, { text: 'ls' })).status).toBe(400)
  expect((await post(`${path}/keys`, { keys: ['ctrl+c'] })).status).toBe(200)
  expect((await post('/api/panes/w1%3Ap1/keys', { keys: ['ctrl+c'] })).status).toBe(400)
  expect(writes).toEqual([`prompt ${id} ls -la`, `prompt ${id} rm -rf build`, `keys ${id} ctrl+c`])
  expect((await post(`/api/shells/${encodeURIComponent(id)}/disarm`, {})).status).toBe(200)
  expect((await (await post(`${path}/prompt`, { text: 'pwd' })).json()).code).toBe('stepup')
  expect((await post(`/api/shells/${encodeURIComponent(id)}/close`, {})).status).toBe(200)
  expect(fb.panes.has(id)).toBe(false)
  const acts = h.hub.db.query('SELECT action FROM pane_actions WHERE pane = ? ORDER BY id').all(id).map((r: any) => r.action)
  expect(acts).toEqual(['shell-open', 'prompt', 'prompt', 'keys', 'shell-close'])
})

test('API: share one of the user\'s terminals (Face ID to list and to share); stopping leaves it running', async () => {
  auth.stepped = false
  expect((await (await post('/api/shells/shareable', {})).json()).code).toBe('stepup')
  auth.stepped = true
  const { terminals } = await (await post('/api/shells/shareable', {})).json()
  expect(terminals).toEqual([{ id: 'rex:mine', title: 'my shell', cwd: join(root, 'mine'), project: 'mine', backend: 'rex' }])
  // A pane the hub has seen running an agent is never offered, even after the agent exited.
  fb.panes.set('w1:p1', { pid: 3, agent: false, cwd: join(root, 'mine'), title: 'zsh' })
  expect((await (await post('/api/shells/shareable', {})).json()).terminals.map((t: any) => t.id)).toEqual(['rex:mine'])
  fb.panes.delete('w1:p1')
  expect((await (await post('/api/shells/share', { id: 'rex:nope' })).json()).code).toBe('not_shareable')
  expect(await (await post('/api/shells/share', { id: 'rex:mine' })).json()).toEqual({ id: 'rex:mine', reused: false })
  shown = new Set(['rex:mine'])
  const list = await (await h.user('/api/panes')).json()
  expect(list.panes.find((p: any) => p.id === 'rex:mine').shell).toBe('shared')
  expect((await post('/api/panes/rex%3Amine/prompt', { text: 'git status' })).status).toBe(200)
  expect((await post('/api/shells/rex%3Amine/close', {})).status).toBe(200)
  expect(fb.panes.has('rex:mine')).toBe(true)
  const acts = h.hub.db.query("SELECT action FROM pane_actions WHERE pane = 'rex:mine' ORDER BY id").all().map((r: any) => r.action)
  expect(acts).toEqual(['shell-share', 'prompt', 'shell-unshare'])
})

test('API: sharing is off without "share": true in shells.json', async () => {
  const plain = join(root, 'plain-shells.json')
  writeFileSync(plain, '{}')
  const o = startHub({ paneProvider: provider, shells: 'on', shellsFile: plain, shellBackends: [fakeBackend('rex', 'rex:').backend], iconRoots: [root],
    shellAuth: { lockOn: () => true, steppedUp: () => true }, paneTiming: { fastMs: 60_000, slowMs: 60_000 } })
  const cfg = await (await o.user('/api/config')).json()
  expect([cfg.shells, cfg.shell_share]).toEqual([true, false])
  const r = await o.user('/api/shells/shareable', { method: 'POST', headers: { 'x-hub-action': '1' }, body: '{}' })
  expect([r.status, (await r.json()).code]).toEqual([404, 'share_off'])
  o.hub.stop()
})

test('API: shells are 404 when off', async () => {
  const off = startHub({ paneProvider: provider, paneTiming: { fastMs: 60_000, slowMs: 60_000 } })
  expect((await off.user('/api/shells', { method: 'POST', headers: { 'x-hub-action': '1' }, body: '{"project":"proj-a"}' })).status).toBe(404)
  expect((await (await off.user('/api/config')).json()).shells).toBe(false)
  off.hub.stop()
})
