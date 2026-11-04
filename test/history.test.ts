// Long history: search, opening the conversation at a message or a day, archived threads.
import { test, expect, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { startHub, readSSE } from './helpers'
import { createHub } from '../hub/server'

const { hub, agent, user } = startHub()
afterAll(() => hub.stop())

const say = async (text: string, thread?: string) =>
  (await (await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text, thread }) })).json()).id as number
const tell = async (body: Record<string, unknown>) =>
  (await (await agent('/agent/send', { method: 'POST', body: JSON.stringify({ notify: false, ...body }) })).json()).id as number
const search = async (qs: string) => (await (await user(`/api/search?${qs}`)).json()) as any[]

test('search: text, transcripts, card prompts and options; all words must match; reactions skipped', async () => {
  const a = await say('The **RevenueCat** application is drafted', 'jobs')
  const b = await tell({ kind: 'text', text: 'Pushed [the fix](https://example.com/pr/12) to `main`', thread: 'release' })
  const c = await tell({ kind: 'question', questions: [{ prompt: 'Which header art?', options: [{ label: 'Meadow', description: 'the old one' }, { label: 'Night sky' }] }] })
  const d = await tell({ kind: 'approval', prompt: 'Deploy the video page?', detail: 'PR #27 on production' })
  const e = await say('軟體資訊網路 的筆記')
  await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'reaction', to: a, emoji: '👍' }) })

  expect((await search('q=revenuecat')).map(m => m.id)).toEqual([a])            // case-insensitive, markdown flattened
  expect((await search('q=the fix')).map(m => m.id)).toEqual([b])               // every word, any order
  expect((await search('q=example.com/pr')).map(m => m.id)).toEqual([b])        // link targets are searchable
  expect((await search('q=night sky')).map(m => m.id)).toEqual([c])             // question options
  expect((await search('q=production')).map(m => m.id)).toEqual([d])            // approval detail
  expect((await search('q=資訊')).map(m => m.id)).toEqual([e])                  // two CJK characters (below the trigram length)
  expect((await search('q=revenuecat nothing-like-this')).length).toBe(0)
  expect((await search('q=')).length).toBe(0)
  expect((await search('q=100%')).length).toBe(0)                               // % is literal, not a wildcard

  const hit = (await search('q=fix'))[0]
  expect(hit).toMatchObject({ id: b, sender: 'agent', thread: 'release', kind: 'text' })
  expect(hit.body.text).toContain('[the fix]')
  expect(hit.snippet).toBe('Pushed the fix https://example.com/pr/12 to main')
  expect(hit.reactions).toEqual([])

  // Thread filter and paging back with before.
  expect((await search('q=the&thread=jobs')).map(m => m.id)).toEqual([a])
  const all = await search('q=the')
  expect(all.length).toBeGreaterThanOrEqual(3)
  expect((await search(`q=the&before=${all[0].id}&limit=1`))[0].id).toBe(all[1].id)
})

test('search: long text gets a snippet around the first match; edits and transcripts are reindexed', async () => {
  const long = `${'filler words here. '.repeat(30)}the needle sits in the middle${' and more padding.'.repeat(30)}`
  await tell({ kind: 'text', text: long })
  const s = (await search('q=needle'))[0].snippet as string
  expect(s.startsWith('…')).toBe(true)
  expect(s.endsWith('…')).toBe(true)
  expect(s).toContain('the needle sits')
  expect(s.length).toBeLessThanOrEqual(142)

  const id = await tell({ kind: 'progress', text: 'Starting the build' })
  expect((await search('q=uploading dsym')).length).toBe(0)
  await agent('/agent/update', { method: 'POST', body: JSON.stringify({ id, text: 'Starting the build\nUploading dSYM', done: true, notify: false }) })
  expect((await search('q=uploading dsym')).map(m => m.id)).toEqual([id])
  expect((await search('q=starting the build')).map(m => m.id)).toEqual([id])
})

test('search index is backfilled at startup for rows written before it existed', async () => {
  const h = startHub()
  const id = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'an old message about lanterns' }) })).json().then((m: any) => m.id)
  h.hub.stop()
  // Simulate an older hub: no index rows.
  const raw = new Database(join(h.dataDir, 'hub.sqlite'))
  raw.exec('DELETE FROM messages_fts')
  raw.close()
  const logs: string[] = []
  const again = createHub({ dataDir: h.dataDir, port: 0, log: m => logs.push(m) })
  try {
    const hits = await (await fetch(`${again.url}/api/search?q=lanterns`)).json()
    expect(hits.map((m: any) => m.id)).toEqual([id])
    expect(logs.some(l => l.includes('search index: added'))).toBe(true)
  } finally { again.stop() }
})

test('messages: around opens a window in the middle; after pages forward without a gap', async () => {
  const h = startHub()
  try {
    const ids: number[] = []
    for (let i = 0; i < 30; i++) ids.push(await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: `m${i}`, thread: i % 2 ? 'odd' : undefined }) })).json().then((m: any) => m.id))
    const win = await (await h.user(`/api/messages?around=${ids[15]}&limit=10`)).json()
    expect(win.map((m: any) => m.id)).toEqual(ids.slice(11, 21).reverse()) // 4 older, the anchor, 5 newer; newest first
    // after= alone: the next page forward, newest first, so scrolling down has no gap.
    const next = await (await h.user(`/api/messages?after=${ids[20]}&limit=3`)).json()
    expect(next.map((m: any) => m.id)).toEqual([ids[23], ids[22], ids[21]])
    // Thread filter applies to the window.
    const odd = await (await h.user(`/api/messages?around=${ids[15]}&thread=odd&limit=4`)).json()
    expect(odd.map((m: any) => m.id)).toEqual([ids[19], ids[17], ids[15], ids[13]])
    // Near the start: fewer older ones, the rest newer.
    const start = await (await h.user(`/api/messages?around=${ids[0]}&limit=5`)).json()
    expect(start.map((m: any) => m.id)).toEqual(ids.slice(0, 3).reverse())
  } finally { h.hub.stop() }
})

test('messages: date opens at the first message of that day (in the client timezone)', async () => {
  const h = startHub()
  try {
    const send = async (text: string, thread?: string) => (await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text, thread }) })).json()).id as number
    const a = await send('day one, morning')
    const b = await send('day one, evening', 'x')
    const c = await send('day two')
    const d = await send('day three', 'x')
    // Pin the timestamps: Taipei (UTC+8) days 2026-10-01, 10-01, 10-02, 10-05.
    const at = (id: number, iso: string) => h.hub.db.query('UPDATE messages SET ts = ? WHERE id = ?').run(Date.parse(iso), id)
    at(a, '2026-09-30T17:00:00Z'); at(b, '2026-10-01T12:00:00Z'); at(c, '2026-10-01T16:30:00Z'); at(d, '2026-10-05T01:00:00Z')
    const tz = -480 // what getTimezoneOffset() says in Taipei
    const open = async (q: string) => (await (await h.user(`/api/messages?${q}`)).json()).map((m: any) => m.id)

    expect((await open(`date=2026-10-01&tz=${tz}&limit=10`)).at(-1)).toBe(a)     // the window starts at that day's first message
    expect(await open(`date=2026-10-02&tz=${tz}&limit=10`)).toEqual([d, c, b, a])  // anchor c, older ones before it
    expect(await open(`date=2026-10-02&tz=0&limit=3`)).toEqual([d, c])             // in UTC, c is still on 10-01
    expect(await open(`date=2026-10-03&tz=${tz}&limit=2`)).toEqual([d])           // a day without messages: the next one
    expect(await open(`date=2026-10-02&tz=${tz}&thread=x&limit=2`)).toEqual([d])  // thread filter: first in that thread from that day
    expect(await open(`date=2030-01-01&tz=${tz}&limit=3`)).toEqual([d, c])        // past the end: the newest
    expect((await h.user('/api/messages?date=yesterday')).status).toBe(400)
  } finally { h.hub.stop() }
})

test('threads: archive one by hand or from the agent; a new message un-archives it', async () => {
  const h = startHub()
  try {
    const th = async () => (await (await h.user('/api/threads')).json()).threads as any[]
    await h.agent('/agent/threads', { method: 'POST', body: JSON.stringify([{ id: 'app-59', title: 'App release', state: 'waiting' }, { id: 'kana', title: 'Notes' }]) })
    await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'hello', thread: 'loose' }) })

    // Agent: one thread, the rest untouched; title kept when only state is given.
    expect((await h.user('/agent/threads/app-59', { method: 'POST', body: '{"state":"archived"}' })).status).toBe(401)
    const r = await (await h.agent('/agent/threads/app-59', { method: 'POST', body: JSON.stringify({ state: 'archived' }) })).json()
    expect(r.thread).toEqual({ id: 'app-59', title: 'App release', state: 'archived' })
    let t = await th()
    expect(t.find(x => x.id === 'app-59').state).toBe('archived')
    expect(t.find(x => x.id === 'kana')).toMatchObject({ title: 'Notes', state: null })

    // A thread the hub has no metadata for (only messages) can be archived from the app.
    const events = h.user('/api/events').then(res => readSSE(res, e => e.some(x => x.event === 'threads' && x.data.threads.find((y: any) => y.id === 'loose')?.state === 'archived')))
    await Bun.sleep(50)
    expect((await h.user('/api/threads/loose/archive', { method: 'POST' })).status).toBe(200)
    expect((await events).length).toBeGreaterThan(0)
    expect((await th()).find(x => x.id === 'loose')).toMatchObject({ title: 'loose', state: 'archived' })

    // Replacing the list keeps archived threads archived (listed without a state, or left out).
    await h.agent('/agent/threads', { method: 'POST', body: JSON.stringify([{ id: 'app-59', title: 'App 0.12.5' }, { id: 'kana', title: 'Notes', state: 'open' }]) })
    t = await th()
    expect(t.find(x => x.id === 'app-59')).toMatchObject({ title: 'App 0.12.5', state: 'archived' })
    expect(t.find(x => x.id === 'loose').state).toBe('archived')

    // A reaction does not bring it back; a new message from either side does.
    const old = (await (await h.user('/api/messages?thread=loose')).json())[0].id
    await h.agent('/agent/react', { method: 'POST', body: JSON.stringify({ to: old, emoji: '👀' }) })
    expect((await th()).find(x => x.id === 'loose').state).toBe('archived')
    await h.agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'one more thing', thread: 'app-59', notify: false }) })
    expect((await th()).find(x => x.id === 'app-59').state).toBe(null)
    await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'back again', thread: 'loose' }) })
    expect((await th()).find(x => x.id === 'loose').state).toBe(null)

    // Unarchive by hand, and 'open' from the agent clears the state.
    await h.user('/api/threads/kana/archive', { method: 'POST' })
    await h.user('/api/threads/kana/unarchive', { method: 'POST' })
    expect((await th()).find(x => x.id === 'kana').state).toBe(null)
    await h.agent('/agent/threads/kana', { method: 'POST', body: JSON.stringify({ state: 'archived', title: 'Kana 1.4.2' }) })
    await h.agent('/agent/threads/kana', { method: 'POST', body: JSON.stringify({ state: 'open' }) })
    expect((await th()).find(x => x.id === 'kana')).toMatchObject({ title: 'Kana 1.4.2', state: null })
    // The user side needs a user; the agent token doesn't open it.
    expect((await h.user('/api/threads/kana/archive', { method: 'POST', headers: { 'tailscale-user-login': 'x@example.com' } })).status).toBe(403)
  } finally { h.hub.stop() }
})

test('search: type= filters by attachment; without words it lists the latest of that kind', async () => {
  const fd = new FormData()
  fd.append('file', new File(['png'], 'shot.png', { type: 'image/png' }))
  fd.append('file', new File(['mp4'], 'clip.mp4', { type: 'video/mp4' }))
  fd.append('file', new File(['md'], 'notes.md', { type: 'text/markdown' }))
  const [png, mp4, md] = await (await fetch(hub.url + '/api/upload', { method: 'POST', body: fd })).json()
  const send = async (files: string[], text = '') =>
    (await (await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text, files }) })).json()).id as number
  const p = await send([png.id], 'harbour at dusk')
  const v = await send([mp4.id])
  const both = await send([png.id, mp4.id])
  const f = await send([md.id])

  expect((await search('type=photo')).map(m => m.id)).toEqual([both, p])
  expect((await search('type=video')).map(m => m.id)).toEqual([both, v])
  expect((await search('type=file')).map(m => m.id)).toEqual([f])
  expect((await search('type=photo&q=harbour')).map(m => m.id)).toEqual([p])
  expect((await search(`type=photo&before=${both}`)).map(m => m.id)).toEqual([p])
  expect((await search('type=nonsense')).length).toBe(0)
})
