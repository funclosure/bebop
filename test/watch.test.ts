import { test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { startHub } from './helpers'

const { hub, dataDir, user } = startHub()
afterAll(() => hub.stop())

const post = (text: string) => user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text }) }).then(r => r.json())
const delivered = (id: number) => (hub.db.query('SELECT delivered_at FROM messages WHERE id = ?').get(id) as any)?.delivered_at

function watch() {
  return Bun.spawn(['bun', join(import.meta.dir, '..', 'channel', 'watch.ts')], {
    env: { ...process.env, HUB_URL: hub.url, HUB_TOKEN_FILE: join(dataDir, 'agent.token'), HUB_WATCH_SETTLE_MS: '300' },
    stdout: 'pipe', stderr: 'ignore',
  })
}

test('prints waiting messages as channel tags, acks them, exits', async () => {
  const a = await post('first')
  const b = await post('second part')
  const p = watch()
  expect(await p.exited).toBe(0)
  const out = await new Response(p.stdout).text()
  expect(out).toContain(`<channel source="hub" chat_id="hub" message_id="${a.id}"`)
  expect(out).toContain('first\n</channel>')
  expect(out).toContain('second part\n</channel>')
  expect(out).toContain('Start the hub watcher again')
  expect(delivered(a.id)).toBeTruthy()
  expect(delivered(b.id)).toBeTruthy()
})

test('waits for a message that arrives later', async () => {
  const p = watch()
  await Bun.sleep(300)
  const c = await post('later')
  expect(await p.exited).toBe(0)
  const out = await new Response(p.stdout).text()
  expect(out).toContain(`message_id="${c.id}"`)
  expect(out).not.toContain('first')
  expect(delivered(c.id)).toBeTruthy()
})
