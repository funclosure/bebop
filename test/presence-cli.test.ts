import { test, expect } from 'bun:test'
import { join } from 'path'
import { startHub } from './helpers'
import { toolLabel, fromHookEvent } from '../scripts/presence'

const script = join(import.meta.dir, '..', 'scripts', 'presence.ts')
const run = (args: string[], env: Record<string, string>, stdin?: string) => {
  const p = Bun.spawn(['bun', script, ...args], { env: { ...process.env, ...env }, stdin: stdin ? new Blob([stdin]) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return p.exited.then(async code => ({ code, out: await new Response(p.stdout).text() }))
}

test('tool labels and hook mapping', () => {
  expect(toolLabel('Bash')).toBe('Running a command')
  expect(toolLabel('Grep')).toBe('Reading files')
  expect(toolLabel('Write')).toBe('Editing files')
  expect(toolLabel('WebFetch')).toBe('Searching the web')
  expect(toolLabel('Agent')).toBe('Asking a helper')
  expect(toolLabel('mcp__hub__reply')).toBeNull()
  expect(toolLabel('mcp__claude_ai_Slack__search')).toBe('Using claude ai Slack')
  expect(fromHookEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).toEqual({ state: 'thinking' })
  expect(fromHookEvent({ hook_event_name: 'Stop' })).toEqual({ state: 'idle' })
  expect(fromHookEvent({ hook_event_name: 'PreToolUse', tool_name: 'mcp__hub__reply', tool_input: {} })).toBeNull()
})

test('CLI: hook mode sets presence and prints nothing; hub down exits 0 fast', async () => {
  const { hub, dataDir, user } = startHub()
  try {
    const env = { HUB_URL: hub.url, HUB_TOKEN_FILE: join(dataDir, 'agent.token') }
    const r = await run(['--hook'], env, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }))
    expect(r).toEqual({ code: 0, out: '' })
    expect(await user('/api/presence').then(x => x.json())).toMatchObject({ state: 'working', detail: 'Running a command' })
    await run(['idle'], env)
    expect((await user('/api/presence').then(x => x.json())).state).toBe('idle')
  } finally { hub.stop() }
  const t0 = Date.now()
  const down = await run(['thinking'], { HUB_URL: 'http://127.0.0.1:9', HUB_TOKEN_FILE: '/nonexistent' })
  expect(down).toEqual({ code: 0, out: '' })
  expect(Date.now() - t0).toBeLessThan(1500)
})
