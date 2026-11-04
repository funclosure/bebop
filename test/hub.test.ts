import { test, expect, afterAll } from 'bun:test'
import { createECDH, randomBytes } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { startHub, readSSE } from './helpers'

const { hub, dataDir, agent, user } = startHub({ agentName: 'Test Companion' })
afterAll(() => hub.stop())

test('user side: dev mode allows localhost without a login header, rejects any login header', async () => {
  expect((await user('/api/messages')).status).toBe(200)
  expect((await user('/api/messages', { headers: { 'tailscale-user-login': 'someone@example.com' } })).status).toBe(403)
})

test('user side: allowed logins are enforced', async () => {
  const h = startHub({ allowedLogins: ['a@example.com'] })
  try {
    expect((await h.user('/api/threads')).status).toBe(403)
    expect((await h.user('/api/threads', { headers: { 'tailscale-user-login': 'b@example.com' } })).status).toBe(403)
    expect((await h.user('/api/threads', { headers: { 'tailscale-user-login': 'a@example.com' } })).status).toBe(200)
    // The agent token does not open the user side.
    expect((await fetch(h.hub.url + '/api/threads', { headers: { authorization: `Bearer ${h.hub.token}` } })).status).toBe(403)
  } finally { h.hub.stop() }
})

test('agent side: bearer token required; user login header never counts as the agent', async () => {
  expect((await user('/agent/history')).status).toBe(401)
  expect((await user('/agent/history', { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
  expect((await agent('/agent/history')).status).toBe(200)
  // A request proxied by tailscale serve (has a login header) is refused even with the token.
  expect((await agent('/agent/history', { headers: { 'tailscale-user-login': 'a@example.com' } })).status).toBe(401)
})

test('durable delivery: un-acked user messages are redelivered on reconnect', async () => {
  const sent = await (await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'hello while offline', thread: 'durable' }) })).json()
  expect(sent.id).toBeGreaterThan(0)

  // First connection receives it, but does not ack.
  let ev = await readSSE(await agent('/agent/stream'), e => e.some(x => x.data.id === sent.id))
  expect(ev.find(x => x.data.id === sent.id)!.data.body.text).toBe('hello while offline')

  // Reconnect: still there.
  ev = await readSSE(await agent('/agent/stream'), e => e.some(x => x.data.id === sent.id))
  expect(ev.some(x => x.data.id === sent.id)).toBe(true)

  await agent('/agent/ack', { method: 'POST', body: JSON.stringify({ ids: [sent.id] }) })
  ev = await readSSE(await agent('/agent/stream'), () => false, 400)
  expect(ev.some(x => x.data.id === sent.id)).toBe(false)
})

test('live delivery: a message posted while the agent is connected arrives once', async () => {
  const res = await agent('/agent/stream')
  const p = readSSE(res, e => e.some(x => x.data.body?.text === 'live one'))
  await Bun.sleep(50)
  await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'live one' }) })
  const ev = await p
  expect(ev.filter(x => x.data.body?.text === 'live one').length).toBe(1)
  await agent('/agent/ack', { method: 'POST', body: JSON.stringify({ ids: ev.map(x => x.data.id) }) })
})

test('client_id makes user sends idempotent', async () => {
  const body = JSON.stringify({ kind: 'text', text: 'once', client_id: 'c-123' })
  const a = await (await user('/api/messages', { method: 'POST', body })).json()
  const b = await (await user('/api/messages', { method: 'POST', body })).json()
  expect(a.id).toBe(b.id)
})

test('upload streams to disk and /files serves Range', async () => {
  const bytes = randomBytes(300_000)
  const fd = new FormData()
  fd.append('file', new File([bytes], 'clip.mp4', { type: 'video/mp4' }))
  fd.append('file', new File(['note'], 'n.txt', { type: 'text/plain' }))
  const up = await (await fetch(hub.url + '/api/upload', { method: 'POST', body: fd })).json()
  expect(up.length).toBe(2)
  expect(up[0]).toMatchObject({ name: 'clip.mp4', mime: 'video/mp4', size: 300_000 })

  const full = await fetch(`${hub.url}/files/${up[0].id}`)
  expect(full.headers.get('content-type')).toBe('video/mp4')
  expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true)

  const part = await fetch(`${hub.url}/files/${up[0].id}`, { headers: { range: 'bytes=100-199' } })
  expect(part.status).toBe(206)
  expect(part.headers.get('content-range')).toBe('bytes 100-199/300000')
  expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true)

  const tail = await fetch(`${hub.url}/files/${up[0].id}`, { headers: { range: 'bytes=-10' } })
  expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(-10))).toBe(true)
  expect((await fetch(`${hub.url}/files/${up[0].id}`, { headers: { range: 'bytes=400000-' } })).status).toBe(416)

  // A message with the file reaches the agent with a local path.
  const m = await (await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: '', files: [up[0].id] }) })).json()
  const ev = await readSSE(await agent('/agent/stream'), e => e.some(x => x.data.id === m.id))
  const got = ev.find(x => x.data.id === m.id)!.data
  expect(got.files[0].path.startsWith(join(dataDir, 'files'))).toBe(true)
  const info = await (await agent(`/agent/file/${up[0].id}`)).json()
  expect(info.path).toBe(got.files[0].path)
  await agent('/agent/ack', { method: 'POST', body: JSON.stringify({ ids: ev.map(x => x.data.id) }) })
})

test('agent send copies local files', async () => {
  const p = join(dataDir, 'shot.png')
  writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'))
  const { id } = await (await agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'see', files: [p], notify: false }) })).json()
  const list = await (await user('/api/messages?limit=5')).json()
  const msg = list.find((x: any) => x.id === id)
  expect(msg.files[0]).toMatchObject({ name: 'shot.png', mime: 'image/png' })
  expect((await agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'x', files: ['relative.png'] }) })).status).toBe(400)
})

test('question → answer flow', async () => {
  const { id } = await (await agent('/agent/send', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'question', thread: 'pacing', notify: false,
      questions: [
        { id: 'pace', header: 'Pace', prompt: 'How fast?', options: [{ label: 'Gentle', recommended: true }, { label: 'Brisk' }] },
        { id: 'mode', header: 'Mode', prompt: 'Which modes?', multi: true, options: [{ label: 'Listen' }, { label: 'Write' }] },
      ],
    }),
  })).json()

  const stream = await agent('/agent/stream')
  const got = readSSE(stream, e => e.some(x => x.data.kind === 'answer' && x.data.body.to === id))

  expect((await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'answer', to: id, answers: { pace: ['Gentle'] } }) })).status).toBe(400)
  const ans = await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'answer', to: id, answers: { pace: ['Gentle'], mode: { other: 'try both' } } }) })
  expect(ans.status).toBe(201)
  expect((await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'answer', to: id, answers: { pace: ['Brisk'], mode: ['Listen'] } }) })).status).toBe(409)

  const ev = (await got).find(x => x.data.kind === 'answer')!.data
  expect(ev.thread).toBe('pacing')
  expect(ev.target.body.questions[0].header).toBe('Pace')
  expect(ev.body.answers.mode).toEqual({ other: 'try both' })
  await agent('/agent/ack', { method: 'POST', body: JSON.stringify({ ids: [ev.id] }) })

  const q = (await (await user('/api/messages?thread=pacing')).json()).find((x: any) => x.id === id)
  expect(q.body.answered.pace).toEqual(['Gentle'])
})

test('approval answer records the label', async () => {
  const { id } = await (await agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'approval', prompt: 'Push 1.4.0?', notify: false }) })).json()
  await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'answer', to: id, answers: { approval: ['Approve'] } }) })
  const m = (await (await user('/api/messages')).json()).find((x: any) => x.id === id)
  expect(m.body.answered).toBe('Approve')
  expect(m.body.options).toEqual(['Approve', 'Not yet', 'Change'])
})

test('progress updates in place and SSE reports it; reactions fold into targets', async () => {
  const events = user('/api/events').then(r => readSSE(r, e => e.some(x => x.event === 'reaction')))
  await Bun.sleep(50)
  const { id } = await (await agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'progress', text: 'Building' }) })).json()
  await agent('/agent/update', { method: 'POST', body: JSON.stringify({ id, text: 'Building\nUploading' }) })
  await agent('/agent/update', { method: 'POST', body: JSON.stringify({ id, done: true, text: 'Done' }) })
  await agent('/agent/react', { method: 'POST', body: JSON.stringify({ to: id, emoji: '✅' }) })
  const ev = await events
  expect(ev[0]).toMatchObject({ event: 'message' })
  const updates = ev.filter(x => x.event === 'update')
  expect(updates.at(-1)!.data.body).toEqual({ text: 'Done', done: true })
  expect(ev.find(x => x.event === 'reaction')!.data).toEqual({ to: id, reactions: [{ emoji: '✅', sender: 'agent' }] })

  const list = await (await user('/api/messages?limit=10')).json()
  const m = list.find((x: any) => x.id === id)
  expect(m.reactions).toEqual([{ emoji: '✅', sender: 'agent' }])
  expect(list.some((x: any) => x.kind === 'reaction')).toBe(false)

  // User reaction replaces the user's earlier one; '' clears it.
  await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'reaction', to: id, emoji: '👍' }) })
  await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'reaction', to: id, emoji: '❤️' }) })
  let r = (await (await user('/api/messages?limit=10')).json()).find((x: any) => x.id === id).reactions
  expect(r).toEqual([{ emoji: '✅', sender: 'agent' }, { emoji: '❤️', sender: 'user' }])
  await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'reaction', to: id, emoji: '' }) })
  r = (await (await user('/api/messages?limit=10')).json()).find((x: any) => x.id === id).reactions
  expect(r).toEqual([{ emoji: '✅', sender: 'agent' }])
})

test('topics: lanes and details publish without touching archive state', async () => {
  await agent('/agent/threads/topic-a', { method: 'POST', body: JSON.stringify({ title: 'Old', state: 'archived' }) })
  await agent('/agent/topics', { method: 'POST', body: JSON.stringify([
    { id: 'topic-a', title: 'A', lane: 'you', detail: 'Tap it' },
    { id: 'topic-b', title: 'B', lane: 'mine', updated: 5000 },
  ]) })
  let list = (await (await user('/api/threads')).json()).threads
  const a = list.find((x: any) => x.id === 'topic-a')
  expect([a.title, a.lane, a.detail, a.state]).toEqual(['A', 'you', 'Tap it', 'archived'])
  expect(list.find((x: any) => x.id === 'topic-b').updated).toBe(5000)
  await agent('/agent/topics', { method: 'POST', body: JSON.stringify([{ id: 'topic-a', title: 'A', lane: 'others' }]) })
  list = (await (await user('/api/threads')).json()).threads
  const b = list.find((x: any) => x.id === 'topic-b')
  expect([b.title, b.lane, b.detail]).toEqual(['B', null, null])
  expect(list.find((x: any) => x.id === 'topic-a').lane).toBe('others')
  await agent('/agent/topics', { method: 'POST', body: JSON.stringify([{ id: 'topic-a', title: 'A', lane: 'others', history: Array.from({ length: 10 }, (_, i) => `step ${i}`) }]) })
  list = (await (await user('/api/threads')).json()).threads
  expect(list.find((x: any) => x.id === 'topic-a').history).toEqual(Array.from({ length: 8 }, (_, i) => `step ${i + 2}`))
  await agent('/agent/threads/topic-a', { method: 'POST', body: JSON.stringify({ state: 'open' }) })
  expect((await (await user('/api/threads')).json()).threads.find((x: any) => x.id === 'topic-a').lane).toBe('others')
})

test('threads: agent metadata, unread counts, read marks', async () => {
  await agent('/agent/threads', { method: 'POST', body: JSON.stringify([{ id: 'release', title: 'Release 1.4', state: 'waiting' }]) })
  const { id } = await (await agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'built', thread: 'release', notify: false }) })).json()
  let t = (await (await user('/api/threads')).json()).threads.find((x: any) => x.id === 'release')
  expect(t).toMatchObject({ title: 'Release 1.4', state: 'waiting', unread: 1 })
  await user('/api/read', { method: 'POST', body: JSON.stringify({ thread: 'release', last_id: id }) })
  t = (await (await user('/api/threads')).json()).threads.find((x: any) => x.id === 'release')
  expect(t.unread).toBe(0)
  // after= returns only newer messages
  const newer = await (await user(`/api/messages?after=${id}`)).json()
  expect(newer.every((x: any) => x.id > id)).toBe(true)
})

test('push: payload is encrypted and expired subscriptions are removed', async () => {
  const received: Headers[] = []
  const gone = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => { received.push(new Headers(req.headers)); return new Response(null, { status: 410 }) } })
  try {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
    const sub = { endpoint: `http://127.0.0.1:${gone.port}/push/abc`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') } }
    expect((await user('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) })).status).toBe(201)
    expect((hub.db.query('SELECT COUNT(*) AS n FROM push_subs').get() as any).n).toBe(1)
    expect((await (await user('/api/push/key')).json()).key).toBe(hub.vapid.publicKey)

    await agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'ping me' }) })
    for (let i = 0; i < 50 && (hub.db.query('SELECT COUNT(*) AS n FROM push_subs').get() as any).n; i++) await Bun.sleep(20)
    expect(received.length).toBe(1)
    expect(received[0].get('content-encoding')).toBe('aes128gcm')
    expect(received[0].get('authorization')).toStartWith('vapid t=')
    expect((hub.db.query('SELECT COUNT(*) AS n FROM push_subs').get() as any).n).toBe(0)
  } finally { gone.stop(true) }
})

test('static: index is templated with the agent name, manifest is dynamic', async () => {
  const html = await (await user('/')).text()
  expect(html).toContain('Test Companion')
  const man = await (await user('/manifest.webmanifest')).json()
  expect(man.name).toBe('Test Companion')
  expect((await user('/../package.json')).status).toBe(404)
})

test('commands: agent publishes, user reads, SSE announces', async () => {
  const events = user('/api/events').then(r => readSSE(r, e => e.some(x => x.event === 'commands')))
  await Bun.sleep(50)
  expect((await user('/agent/commands', { method: 'POST', body: '[]' })).status).toBe(401)
  const r = await (await agent('/agent/commands', { method: 'POST', body: JSON.stringify([
    { name: '/new', description: 'Save and start a fresh session' },
    { name: 'task', description: 'Show a task', args: '<id>' },
    { name: 'bad name!' },
  ]) })).json()
  expect(r.count).toBe(2)
  const got = await (await user('/api/commands')).json()
  expect(got.commands).toEqual([{ name: 'new', description: 'Save and start a fresh session' }, { name: 'task', description: 'Show a task', args: '<id>' }])
  expect(got.updated).toBeGreaterThan(0)
  expect((await events).find(x => x.event === 'commands')!.data.commands.length).toBe(2)
  // Replaces, not merges.
  await agent('/agent/commands', { method: 'POST', body: JSON.stringify({ commands: [{ name: 'now' }] }) })
  expect((await (await user('/api/commands')).json()).commands).toEqual([{ name: 'now' }])
})

test('peers: agent publishes with updated time, user reads, SSE announces', async () => {
  const events = user('/api/events').then(r => readSSE(r, e => e.some(x => x.event === 'peers')))
  await Bun.sleep(50)
  const updated = '2026-10-20T10:00:00Z'
  await agent('/agent/peers', { method: 'POST', body: JSON.stringify({ updated, peers: [
    { name: '@app-1', kind: 'claude', state: 'busy', detail: 'Building 1.4.2', project: 'app' },
    { name: 'site-2', state: 'idle' },
    { name: 'no spaces allowed' },
  ] }) })
  const got = await (await user('/api/peers')).json()
  expect(got.updated).toBe(Date.parse(updated))
  expect(got.peers).toEqual([{ name: 'app-1', kind: 'claude', state: 'busy', detail: 'Building 1.4.2', project: 'app' }, { name: 'site-2', state: 'idle' }])
  expect((await events).find(x => x.event === 'peers')!.data.peers.length).toBe(2)
  expect((await user('/api/peers', { headers: { 'tailscale-user-login': 'x@example.com' } })).status).toBe(403)
})

test('tasks: agent replaces the list, it persists, user reads, SSE announces', async () => {
  expect(await (await user('/api/tasks')).json()).toEqual({ tasks: [], updated: null })
  expect((await user('/agent/tasks', { method: 'POST', body: '[]' })).status).toBe(401)
  expect((await agent('/agent/tasks', { method: 'POST', body: '{"tasks":"no"}' })).status).toBe(400)
  const events = user('/api/events').then(r => readSSE(r, e => e.some(x => x.event === 'tasks')))
  await Bun.sleep(50)
  const r = await (await agent('/agent/tasks', { method: 'POST', body: JSON.stringify({ tasks: [
    { id: 'helper-1', title: 'Research RevenueCat', state: 'running', detail: 'Reading the job post', started: '2026-10-20T10:00:00Z' },
    { id: 7, title: 'Waiting on app-1', state: 'WAITING' },
    { id: 'old', title: 'Tests', state: 'done', started: 1760954400000 },
    { id: 'x', title: 'Weird state', state: 'sleeping' },
    { id: 'no-title' },
  ] }) })).json()
  expect(r.count).toBe(4)
  const got = await (await user('/api/tasks')).json()
  expect(got.updated).toBeGreaterThan(0)
  expect(got.tasks).toEqual([
    { id: 'helper-1', title: 'Research RevenueCat', state: 'running', detail: 'Reading the job post', started: '2026-10-20T10:00:00.000Z' },
    { id: '7', title: 'Waiting on app-1', state: 'waiting' },
    { id: 'old', title: 'Tests', state: 'done', started: new Date(1760954400000).toISOString() },
    { id: 'x', title: 'Weird state', state: 'running' },
  ])
  expect((await events).find(x => x.event === 'tasks')!.data.tasks.length).toBe(4)
  // Persisted in the database, so a restarted hub still has it.
  expect((hub.db.query('SELECT COUNT(*) AS n FROM tasks').get() as any).n).toBe(4)
  // Replaces, not merges.
  await agent('/agent/tasks', { method: 'POST', body: JSON.stringify([{ id: 'a', title: 'Only one', state: 'running' }]) })
  expect((await (await user('/api/tasks')).json()).tasks).toEqual([{ id: 'a', title: 'Only one', state: 'running' }])
  expect((await user('/api/tasks', { headers: { 'tailscale-user-login': 'x@example.com' } })).status).toBe(403)
})

test('presence: agent sets it, user reads it, SSE announces, it expires to idle', async () => {
  const h = startHub({ presenceTtlMs: 300 })
  try {
    expect((await h.user('/api/presence').then(r => r.json())).state).toBe('idle')
    expect((await h.user('/agent/presence', { method: 'POST', body: '{"state":"working"}' })).status).toBe(401)
    expect((await h.agent('/agent/presence', { method: 'POST', body: '{"state":"dancing"}' })).status).toBe(400)
    const events = h.user('/api/events').then(r => readSSE(r, e => e.filter(x => x.event === 'presence').length >= 2, 3000))
    await Bun.sleep(50)
    await h.agent('/agent/presence', { method: 'POST', body: JSON.stringify({ state: 'working', detail: 'Running a command' }) })
    expect(await h.user('/api/presence').then(r => r.json())).toMatchObject({ state: 'working', detail: 'Running a command', thread: null })
    const ev = (await events).filter(x => x.event === 'presence')
    expect(ev[0].data.state).toBe('working')
    expect(ev[1].data).toMatchObject({ state: 'idle', detail: null }) // expired after the TTL
  } finally { h.hub.stop() }
})

test('peers: a project folder gets its icon, confined to the roots, and path stays private', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs')
  const { tmpdir } = await import('os')
  const root = mkdtempSync(join(tmpdir(), 'icons-'))
  const outside = mkdtempSync(join(tmpdir(), 'icons-out-'))
  for (const d of [root, outside]) {
    mkdirSync(join(d, 'site/public'), { recursive: true })
    writeFileSync(join(d, 'site/public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  }
  const h = startHub({ iconRoots: [root] })
  await h.agent('/agent/peers', { method: 'POST', body: JSON.stringify({ peers: [
    { name: 'site-1', state: 'idle', path: join(root, 'site') },
    { name: 'out-2', state: 'idle', path: join(outside, 'site') },
    { name: 'none-3', state: 'idle', path: join(root, 'missing') },
  ] }) })
  const { peers } = await (await h.user('/api/peers')).json()
  expect(peers[0].icon).toMatch(/^api\/icons\/[0-9a-f]{24}\.svg$/)
  expect(peers[1]).toEqual({ name: 'out-2', state: 'idle' })
  expect(peers[2]).toEqual({ name: 'none-3', state: 'idle' })
  const r = await h.user('/' + peers[0].icon)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('image/svg+xml')
  expect(r.headers.get('content-security-policy')).toContain('sandbox')
  expect((await h.user('/api/icons/..%2Fhub.sqlite')).status).toBe(404)
  expect((await h.user('/' + peers[0].icon, { headers: { 'tailscale-user-login': 'x@example.com' } })).status).toBe(403)
  h.hub.stop()
})

test('icons: Xcode source takes the main target, default appearance, largest image', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { xcodeIcon, webIcon } = await import('../hub/icons')
  const d = mkdtempSync(join(tmpdir(), 'xc-'))
  const set = (rel: string, images: unknown[]) => {
    mkdirSync(join(d, rel), { recursive: true })
    writeFileSync(join(d, rel, 'Contents.json'), JSON.stringify({ images }))
    for (const i of images as { filename?: string }[]) if (i.filename) writeFileSync(join(d, rel, i.filename), 'x')
  }
  set('AWidgets/Assets.xcassets/AppIcon.appiconset', [{ filename: 'w.png', size: '1024x1024' }])
  set('App/Assets.xcassets/AppIcon.appiconset', [
    { filename: 'dark.png', size: '1024x1024', appearances: [{ appearance: 'luminosity', value: 'dark' }] },
    { filename: 'small.png', size: '16x16', scale: '1x' },
    { filename: 'big.png', size: '512x512', scale: '2x' },
    { size: '1024x1024', idiom: 'mac' },
  ])
  expect(xcodeIcon.find(d)).toBe(join(d, 'App/Assets.xcassets/AppIcon.appiconset/big.png'))
  expect(webIcon.find(d)).toBeNull()
})

test('projects: a topic carries its project, and one with no peer still gets an icon', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs')
  const { tmpdir } = await import('os')
  const root = mkdtempSync(join(tmpdir(), 'proj-'))
  mkdirSync(join(root, 'Projects/MyApp/public'), { recursive: true })
  writeFileSync(join(root, 'Projects/MyApp/public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  mkdirSync(join(root, 'Elsewhere/public'), { recursive: true })
  writeFileSync(join(root, 'Elsewhere/public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" id="e"/>')
  const h = startHub({ iconRoots: [root] })
  const threads = async () => (await h.user('/api/threads')).json()
  const icons = async (n: number) => {
    for (let i = 0; i < 100; i++) { const t = await threads(); if (Object.keys(t.projects).length >= n) return t; await Bun.sleep(10) }
    return threads()
  }
  await h.agent('/agent/topics', { method: 'POST', body: JSON.stringify([
    { id: 'a', title: 'A', lane: 'you', project: 'myapp' }, // the folder is MyApp: case doesn't matter
    { id: 'b', title: 'B', lane: 'mine', project: 'custom', path: join(root, 'Elsewhere') },
    { id: 'c', title: 'C', lane: 'others' },
    { id: 'd', title: 'D', lane: 'mine', project: 'no-such-folder' },
  ]) })
  const t = await icons(2)
  expect(t.threads.find((x: any) => x.id === 'a').project).toBe('myapp')
  expect(t.threads.find((x: any) => x.id === 'c').project).toBeNull()
  expect(t.projects.myapp).toMatch(/^api\/icons\/[0-9a-f]{24}\.svg$/)
  expect(t.projects.custom).toMatch(/^api\/icons\//)
  expect(t.projects['no-such-folder']).toBeUndefined()
  expect((await h.user('/' + t.projects.myapp)).status).toBe(200)
  // Left out of the next list: no project, like lane and detail.
  await h.agent('/agent/topics', { method: 'POST', body: JSON.stringify([{ id: 'c', title: 'C', lane: 'others', project: 'myapp' }]) })
  const t2 = await threads()
  expect(t2.threads.find((x: any) => x.id === 'a').project).toBeNull()
  expect(t2.threads.find((x: any) => x.id === 'c').project).toBe('myapp')
  h.hub.stop()
})

test('projects: icons cannot be read from outside the roots, and odd names find no folder', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { iconResolver } = await import('../hub/icons')
  const root = mkdtempSync(join(tmpdir(), 'proj-')), out = mkdtempSync(join(tmpdir(), 'proj-out-'))
  mkdirSync(join(root, 'Projects/app'), { recursive: true })
  mkdirSync(join(out, 'public'), { recursive: true })
  writeFileSync(join(out, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const ic = iconResolver({ cacheDir: join(root, '.cache'), roots: [root] })
  expect(ic.folder('APP')).toEndWith('/Projects/app')
  expect(ic.folder('../x')).toBeNull()
  expect(ic.folder(null)).toBeNull()
  expect(await ic.resolve(out)).toBeNull()
})

test('projects: an older database gains the column and keeps its topics', async () => {
  const { mkdtempSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { Database } = await import('bun:sqlite')
  const { openDb } = await import('../hub/db')
  const path = join(mkdtempSync(join(tmpdir(), 'mig-')), 'hub.sqlite')
  const old = new Database(path, { create: true })
  old.exec(`CREATE TABLE thread_meta (id TEXT PRIMARY KEY, title TEXT, state TEXT, updated INTEGER, lane TEXT, detail TEXT, history TEXT); INSERT INTO thread_meta (id, title, lane) VALUES ('x', 'X', 'you')`)
  old.close()
  const db = openDb(path)
  expect(db.query('SELECT id, lane, project FROM thread_meta').all()).toEqual([{ id: 'x', lane: 'you', project: null }])
  db.close()
})

test('projects: the hub finds its own icon in web/icons', async () => {
  const { webIcon } = await import('../hub/icons')
  expect(webIcon.find(join(import.meta.dir, '..'))).toEndWith('web/icons/icon-512.png')
})

test('project conversation: an @peer message in project-<key> is delivered as typed, lists under the project, survives topics, and reopens', async () => {
  const h = startHub()
  const thread = 'project-notes'
  const send = (text: string) => h.user('/api/messages', { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify({ kind: 'text', text, thread, client_id: crypto.randomUUID() }) })
  const stream = h.agent('/agent/stream').then(r => readSSE(r, e => e.some(x => x.event === 'message')))
  await Bun.sleep(30)
  expect((await send('@notes-1a look at the binding')).status).toBeLessThan(300)
  const got = (await stream).find(x => x.event === 'message')!.data
  expect(got.body.text).toBe('@notes-1a look at the binding')
  expect(got.thread).toBe(thread)
  const find = async () => (await (await h.user('/api/threads')).json()).threads.find((t: any) => t.id === thread)
  expect((await find()).project).toBe('notes')
  await h.agent('/agent/topics', { method: 'POST', body: JSON.stringify([{ id: 'other', title: 'O', lane: 'you' }]) })
  expect((await find()).project).toBe('notes')
  await h.agent(`/agent/threads/${thread}`, { method: 'POST', body: JSON.stringify({ state: 'archived' }) })
  expect((await find()).state).toBe('archived')
  await send('@notes-1a one more')
  expect((await find()).state).toBeNull()
  h.hub.stop()
})

test('focus: follows acks and sends, keeps through hook calls, explicit wins, idle and TTL clear it', async () => {
  const h = startHub({ presenceTtlMs: 200 })
  const presence = () => h.user('/api/presence').then(r => r.json())
  const say = (body: any) => h.agent('/agent/presence', { method: 'POST', body: JSON.stringify(body) })
  const userMsg = async (thread?: string, kind = 'text') => (await (await h.user('/api/messages', { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify({ kind, text: 'hi', thread, client_id: crypto.randomUUID() }) })).json()).id
  const ack = (...ids: number[]) => h.agent('/agent/ack', { method: 'POST', body: JSON.stringify({ ids }) })
  const a = await userMsg('topic-a'), b = await userMsg('topic-b')
  await say({ state: 'thinking' })
  expect((await presence()).thread).toBeNull()
  await ack(a, b) // newest wins
  expect((await presence()).thread).toBe('topic-b')
  await ack(a) // already delivered: not news
  expect((await presence()).thread).toBe('topic-b')
  await say({ state: 'working', detail: 'Running a command' }) // a hook: no thread
  expect(await presence()).toMatchObject({ state: 'working', thread: 'topic-b' })
  const u = (await presence()).updated
  await h.agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'on it', thread: 'topic-c' }) })
  expect(await presence()).toMatchObject({ thread: 'topic-c', updated: u })
  await h.agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'general' }) })
  expect((await presence()).thread).toBeNull()
  await say({ state: 'working', thread: 'explicit' })
  expect((await presence()).thread).toBe('explicit')
  await say({ state: 'idle' })
  expect(await presence()).toMatchObject({ state: 'idle', thread: null })
  // An ack before the hook: the focus waits for it, even while idle.
  await ack(await userMsg('topic-d'))
  expect((await presence()).thread).toBeNull()
  await say({ state: 'working' })
  expect((await presence()).thread).toBe('topic-d')
  await say({ state: 'idle' })
  await say({ state: 'working' })
  expect((await presence()).thread).toBeNull()
  await say({ state: 'working', thread: 'topic-e' })
  await Bun.sleep(300) // the TTL
  expect(await presence()).toMatchObject({ state: 'idle', thread: null })
  await say({ state: 'working' })
  expect((await presence()).thread).toBeNull()
  h.hub.stop()
})

test('tasks: a task carries its thread, and one without still works', async () => {
  const h = startHub()
  await h.agent('/agent/tasks', { method: 'POST', body: JSON.stringify({ tasks: [{ id: 'a', title: 'Build', state: 'running', thread: 'topic-a' }, { id: 'b', title: 'Plain', state: 'waiting' }] }) })
  const { tasks } = await (await h.user('/api/tasks')).json()
  expect(tasks[0]).toMatchObject({ id: 'a', thread: 'topic-a' })
  expect(tasks[1].thread).toBeUndefined()
  h.hub.stop()
})

test('tasks: an older database gains the thread column', async () => {
  const { mkdtempSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { Database } = await import('bun:sqlite')
  const { openDb } = await import('../hub/db')
  const path = join(mkdtempSync(join(tmpdir(), 'mig-')), 'hub.sqlite')
  const old = new Database(path, { create: true })
  old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, started INTEGER, pos INTEGER NOT NULL); INSERT INTO tasks VALUES ('x', 'X', 'running', NULL, NULL, 0)`)
  old.close()
  const db = openDb(path)
  expect(db.query('SELECT id, thread FROM tasks').all()).toEqual([{ id: 'x', thread: null }])
  db.close()
})

test('moving messages into a topic: shown there, gone from the old topic, still in the main stream, stays read', async () => {
  const sent = await (await agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'branch me', notify: false }) })).json() as any
  const id = sent.id ?? sent.message?.id
  const r = await (await agent('/agent/threads/branch-x/messages', { method: 'POST', body: JSON.stringify({ ids: [id] }) })).json() as any
  expect(r.moved).toBe(1)
  const inTopic = await (await user('/api/messages?thread=branch-x')).json() as any
  expect((inTopic.messages ?? inTopic).map((m: any) => m.id)).toEqual([id])
  const main = await (await user('/api/messages')).json() as any
  expect((main.messages ?? main).map((m: any) => m.id)).toContain(id)
  const list = await (await user('/api/threads')).json() as any
  expect(list.threads.find((t: any) => t.id === 'branch-x').unread ?? 0).toBe(0)
  expect((await agent('/agent/threads/branch-x/messages', { method: 'POST', body: JSON.stringify({ ids: [] }) })).status).toBe(400)
})
