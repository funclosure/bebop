// Settings → Companion: the companion reports itself (folder, engine, model), the hub reads its
// SOUL/USER/MEMORY and tells whether Bebop has an update (fork-aware, like /bebop:update).
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHub } from './helpers'
import { roleFromSoul, modelLabel, updateChecker } from '../hub/companion'
import { engineName } from '../channel/server'
import { fromHookEvent } from '../scripts/presence'

const { hub, agent, user } = startHub({ agentName: 'Faye' })
afterAll(() => hub.stop())

test('role: the first sentence under the title; model and engine names', () => {
  expect(roleFromSoul('# Faye\n\nYou are Faye, a chief of staff. You live on a Mac.\n\n## How you talk\n')).toBe('You are Faye, a chief of staff.')
  expect(roleFromSoul('# Faye\n\n## Role\n- x')).toBeNull()
  expect(roleFromSoul('# Faye\n\nYou are **Faye**, the [one](x) who helps')).toBe('You are Faye, the one who helps')
  expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelLabel('claude-sonnet-5-5-20261001')).toBe('Sonnet 5.5')
  expect(modelLabel({ id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' })).toBe('Haiku 5.5')
  expect(modelLabel('gpt-x')).toBe('gpt-x')
  expect(modelLabel(null)).toBeNull()
  expect(engineName('claude-code', '2.1.3')).toBe('Claude Code 2.1.3')
  expect(engineName(undefined, undefined)).toBe('Claude Code')
  // SessionStart sets no state (the model goes to /agent/companion instead).
  expect(fromHookEvent({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5' })).toBeNull()
})

test('hub: the companion reports itself; Settings reads its files, nothing else', async () => {
  const before = await (await user('/api/companion')).json()
  expect(before).toMatchObject({ name: 'Faye', engine: null, folder: null, files: [] })
  const folder = mkdtempSync(join(tmpdir(), 'comp-'))
  writeFileSync(join(folder, 'SOUL.md'), '# Faye\n\nYou are Faye, a chief of staff.\n')
  writeFileSync(join(folder, 'MEMORY.md'), '# Memory\n')
  writeFileSync(join(folder, 'hub.env'), 'HUB_URL="x"\n')
  expect((await agent('/agent/companion', { method: 'POST', body: JSON.stringify({ folder: 'relative/path' }) })).status).toBe(400)
  expect((await agent('/agent/companion', { method: 'POST', body: JSON.stringify({ folder, engine: 'Claude Code 2.1.3' }) })).status).toBe(200)
  expect((await agent('/agent/companion', { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5' }) })).status).toBe(200)
  const c = await (await user('/api/companion')).json()
  expect(c).toMatchObject({ name: 'Faye', role: 'You are Faye, a chief of staff.', engine: 'Claude Code 2.1.3', model: 'Opus 5.5', folder })
  expect(c.since).toBeGreaterThan(Date.now() - 10_000)
  expect(c.files.map((f: any) => f.name)).toEqual(['SOUL.md', 'MEMORY.md'])
  expect(c.bebop).toMatchObject({ state: 'unknown', reason: 'not_git' })
  const soul = await user('/api/companion/file?name=SOUL.md')
  expect(soul.headers.get('content-type')).toContain('text/markdown')
  expect(await soul.text()).toContain('chief of staff')
  // Only the three files, never anything else in the folder.
  for (const n of ['hub.env', '../SOUL.md', 'USER.md', '']) expect((await user(`/api/companion/file?name=${encodeURIComponent(n)}`)).status).toBe(404)
  // The agent's token isn't enough for the app's routes, and the app can't set it.
  expect((await user('/agent/companion', { method: 'POST', body: '{}' })).status).toBe(401)
})

function git(dir: string, ...a: string[]) {
  const r = Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
  return r.stdout.toString().trim()
}
test('update check: a clone, a fork with its own commits, no remote', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upd-'))
  const up = join(root, 'up'); mkdirSync(up); git(up, 'init', '-q'); writeFileSync(join(up, 'f'), 'a'); git(up, 'add', 'f'); git(up, 'commit', '-qm', 'a')
  git(root, 'clone', '-q', up, 'clone')
  const clone = join(root, 'clone')
  let t = 0
  const check = updateChecker(clone, { everyMs: 1000, now: () => t })
  expect(await check.status()).toMatchObject({ state: 'current', behind: 0, ahead: 0 })
  writeFileSync(join(up, 'f'), 'b'); git(up, 'commit', '-qam', 'b')
  expect((await check.status()).state).toBe('current') // cached for everyMs
  t = 2000
  expect(await check.status()).toMatchObject({ state: 'available', behind: 1, ahead: 0 })
  // A fork: origin is the fork, upstream is Bebop; commits of its own on top.
  git(root, 'clone', '-q', clone, 'fork')
  const fork = join(root, 'fork')
  git(fork, 'remote', 'add', 'upstream', up)
  writeFileSync(join(fork, 'g'), 'mine'); git(fork, 'add', 'g'); git(fork, 'commit', '-qm', 'mine')
  writeFileSync(join(up, 'f'), 'c'); git(up, 'commit', '-qam', 'c')
  expect(await updateChecker(fork).status()).toMatchObject({ state: 'available', behind: 2, ahead: 1, source: expect.stringMatching(/^upstream/) })
  const lone = join(root, 'lone'); mkdirSync(lone); git(lone, 'init', '-q'); writeFileSync(join(lone, 'f'), 'a'); git(lone, 'add', 'f'); git(lone, 'commit', '-qm', 'a')
  expect(await updateChecker(lone).status()).toMatchObject({ state: 'unknown', reason: 'no_remote' })
})
