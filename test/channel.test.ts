import { test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'path'
import { startHub } from './helpers'

const { hub, dataDir, user } = startHub()
const notes: any[] = []
let client: Client

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(25)
  }
}
const delivered = (id: number) => (hub.db.query('SELECT delivered_at FROM messages WHERE id = ?').get(id) as any)?.delivered_at

let early: any
beforeAll(async () => {
  // Sent while no agent is connected: must arrive once the channel starts.
  early = await (await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'sent while you were away' }) })).json()

  client = new Client({ name: 'test-host', version: '0.0.0' })
  client.fallbackNotificationHandler = async n => { notes.push(n) }
  await client.connect(new StdioClientTransport({
    command: 'bun',
    args: [join(import.meta.dir, '..', 'channel', 'server.ts')],
    env: { ...process.env, HUB_URL: hub.url, HUB_TOKEN_FILE: join(dataDir, 'agent.token'), MCP_PROTOCOL_NEGOTIATION: 'legacy' } as Record<string, string>,
    stderr: 'ignore',
  }))
})

afterAll(async () => {
  await client?.close()
  hub.stop()
})

test('declares the channel capability and lists the tools', async () => {
  const caps = client.getServerCapabilities()
  expect(caps?.experimental?.['claude/channel']).toEqual({})
  expect(caps?.experimental?.['claude/channel/permission']).toBeUndefined()
  const tools = (await client.listTools()).tools.map(t => t.name).sort()
  expect(tools).toEqual(['approve', 'ask', 'history', 'presence', 'progress', 'react', 'reply', 'set_commands', 'set_peers', 'set_tasks', 'set_threads'])
  expect(client.getInstructions()).toContain('<channel source="hub"')
})

test('a message sent while disconnected is delivered and acked', async () => {
  const n = await waitFor(() => notes.find(x => x.params.meta.message_id === String(early.id)))
  expect(n.method).toBe('notifications/claude/channel')
  expect(n.params.content).toBe('sent while you were away')
  await waitFor(() => delivered(early.id))
})

test('a user message arrives as a channel notification with meta, then is acked', async () => {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'circled.png', { type: 'image/png' }))
  const [file] = await (await fetch(hub.url + '/api/upload', { method: 'POST', body: fd })).json()
  const sent = await (await user('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ kind: 'text', text: 'this one', thread: 'design', reply_to: early.id, files: [file.id] }),
  })).json()

  const n = await waitFor(() => notes.find(x => x.params.meta.message_id === String(sent.id)))
  expect(n.params.content).toBe('this one')
  const meta = n.params.meta
  expect(meta).toMatchObject({ chat_id: 'hub', kind: 'text', thread: 'design', user: 'local', reply_to: String(early.id), reply_to_text: 'sent while you were away', file_names: 'circled.png' })
  expect(meta.image_path.startsWith(join(dataDir, 'files'))).toBe(true)
  expect(meta.file_paths).toBe(meta.image_path)
  expect(Object.keys(meta).every(k => /^[A-Za-z0-9_]+$/.test(k))).toBe(true)
  expect(n.params.content).not.toContain(meta.image_path)
  await waitFor(() => delivered(sent.id))
})

test('a voice note arrives with voice_path and voice_duration', async () => {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(512)], 'voice.webm', { type: 'audio/webm' }))
  const [file] = await (await fetch(hub.url + '/api/upload', { method: 'POST', body: fd })).json()
  const sent = await (await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'voice', files: [file.id], duration: 3.4 }) })).json()
  const n = await waitFor(() => notes.find(x => x.params.meta.message_id === String(sent.id)))
  expect(n.params.meta).toMatchObject({ kind: 'voice', voice_duration: '3.4' })
  expect(n.params.meta.voice_path).toEndWith('.webm')
  expect(n.params.content).toBe('(voice message, 3.4s, no transcript: off)')
})

test('tools write to the hub; an answer comes back rendered', async () => {
  const r = await client.callTool({ name: 'reply', arguments: { text: '**Hi**', thread: 'design', notify: false } })
  expect((r.content as any)[0].text).toMatch(/^sent \(id: \d+\)$/)

  const asked = await client.callTool({
    name: 'ask',
    arguments: {
      thread: 'design', notify: false,
      questions: [
        { id: 'pace', header: 'Pacing', prompt: 'How fast?', options: [{ label: 'Gentle', recommended: true }, { label: 'Brisk' }] },
        { id: 'mode', header: 'Mode', prompt: 'Which?', options: [{ label: 'Listen' }] },
      ],
    },
  })
  const qid = Number(/id: (\d+)/.exec((asked.content as any)[0].text)![1])
  await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'answer', to: qid, answers: { pace: ['Gentle'], mode: { other: 'try both' } } }) })
  const n = await waitFor(() => notes.find(x => x.params.meta.kind === 'answer'))
  expect(n.params.content).toBe(`Answer to question ${qid} — Pacing: Gentle; Mode: Other: 'try both'`)
  expect(n.params.meta.answer_to).toBe(String(qid))

  const p = await client.callTool({ name: 'progress', arguments: { text: 'Building' } })
  const pid = /id: (\d+)/.exec((p.content as any)[0].text)![1]
  await client.callTool({ name: 'progress', arguments: { id: pid, text: 'Building\nDone', done: true } })
  const list = await (await user('/api/messages?limit=20')).json()
  expect(list.find((m: any) => m.id === Number(pid)).body).toEqual({ text: 'Building\nDone', done: true })

  await client.callTool({ name: 'react', arguments: { message_id: String(early.id), emoji: '👀' } })
  const h = await client.callTool({ name: 'history', arguments: { limit: 50 } })
  expect((h.content as any)[0].text).toContain('reactions: 👀 by agent')

  const t = await client.callTool({ name: 'set_threads', arguments: { threads: [{ id: 'design', title: 'Design', state: 'open' }] } })
  expect((t.content as any)[0].text).toBe('threads set (1)')

  const c = await client.callTool({ name: 'set_commands', arguments: { commands: [{ name: 'new', description: 'Fresh session' }] } })
  expect((c.content as any)[0].text).toBe('commands set (1)')
  expect((await (await user('/api/commands')).json()).commands).toEqual([{ name: 'new', description: 'Fresh session' }])
  const pe = await client.callTool({ name: 'set_peers', arguments: { peers: [{ name: 'app-1', state: 'busy', detail: 'Building' }] } })
  expect((pe.content as any)[0].text).toBe('peers set (1)')
  expect((await (await user('/api/peers')).json()).peers).toEqual([{ name: 'app-1', state: 'busy', detail: 'Building' }])
  const ta = await client.callTool({ name: 'set_tasks', arguments: { tasks: [{ id: 'build', title: 'Build 1.4.2', state: 'running', started: '2026-10-20T10:00:00.000Z' }] } })
  expect((ta.content as any)[0].text).toBe('tasks set (1)')
  expect((await (await user('/api/tasks')).json()).tasks).toEqual([{ id: 'build', title: 'Build 1.4.2', state: 'running', started: '2026-10-20T10:00:00.000Z' }])
})

test('reply and ask upload local files through the channel', async () => {
  const p = join(dataDir, 'clip.png')
  await Bun.write(p, Buffer.from('89504e470d0a1a0a', 'hex'))
  const text = (r: any) => r.content[0].text as string
  const sent = await client.callTool({ name: 'reply', arguments: { text: 'see', files: [p], notify: false } })
  const id = Number(text(sent).match(/id: (\d+)/)![1])
  const msg = (await (await user('/api/messages?limit=10')).json()).find((x: any) => x.id === id)
  expect(msg.files[0]).toMatchObject({ name: 'clip.png', mime: 'image/png' })

  const asked = await client.callTool({ name: 'ask', arguments: { notify: false, questions: [{ id: 'a', prompt: 'Which?', options: [{ label: 'This', image: p }] }] } })
  expect(text(asked)).toStartWith('asked')

  const missing = await client.callTool({ name: 'reply', arguments: { text: 'x', files: [join(dataDir, 'nope.png')] } })
  expect(text(missing)).toContain('no such file')
})
