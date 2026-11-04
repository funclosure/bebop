import { test, expect } from 'bun:test'
import { startHub, readSSE } from './helpers'
import { boardIdFor, BOARD_ID, answererIdFor } from '../hub/server'
import { buildMeta } from '../channel/server'

const upload = async (url: string, name: string, type: string, data: string | Uint8Array) => {
  const fd = new FormData()
  fd.append('file', new File([data], name, { type }))
  const r = await fetch(url + '/api/upload', { method: 'POST', body: fd })
  return (await r.json())[0]
}

test('boardIdFor: readable, valid for Board, padded when short', () => {
  expect(boardIdFor('draw-on-the-board')).toBe('draw-on-the-board')
  expect(boardIdFor('project-my-app~mw0onowd')).toBe('project-my-app-mw0onowd')
  expect(boardIdFor('a b')).toBe('a-b-board')
  expect(boardIdFor('~~')).toBe('board-')
  expect(boardIdFor('x'.repeat(200))).toHaveLength(64)
  expect(boardIdFor('x'.repeat(200), 2)).toEndWith('-2')
  for (const t of ['draw-on-the-board', 'a', '日本語', 'x'.repeat(200), 'a.b/c?d']) expect(boardIdFor(t)).toMatch(BOARD_ID)
})

test('answererIdFor: the agent name as a Board answerer id', () => {
  expect(answererIdFor('Sam')).toBe('sam')
  expect(answererIdFor('My Companion')).toBe('my-companion')
  expect(answererIdFor('  ')).toBe('agent')
})

test('board: the answerer is the configured agent, or HUB_BOARD_ANSWERER', async () => {
  const h = startHub({ boardOrigin: 'http://localhost:5173', agentName: 'Ada Bot' })
  const h2 = startHub({ boardOrigin: 'http://localhost:5173', agentName: 'Ada Bot', boardAnswerer: 'ada' })
  try {
    expect((await (await h.user('/api/config')).json()).board_answerer).toBe('ada-bot')
    expect((await (await h2.user('/api/config')).json()).board_answerer).toBe('ada')
  } finally { h.hub.stop(); h2.hub.stop() }
})

test('board: off without an origin', async () => {
  const h = startHub()
  try {
    expect((await (await h.user('/api/config')).json()).board).toBeNull()
    expect((await h.user('/api/threads/t1/board', { method: 'POST' })).status).toBe(404)
  } finally { h.hub.stop() }
})

test('board: one stable id per topic, kept across a threads rewrite; collisions get a suffix', async () => {
  const h = startHub({ boardOrigin: 'http://localhost:5173/' })
  try {
    expect((await (await h.user('/api/config')).json()).board).toBe('http://localhost:5173')
    expect((await (await h.user('/api/config')).json()).board_answerer).toBe('bebop')
    const first = await (await h.user(`/api/threads/${encodeURIComponent('my.topic')}/board`, { method: 'POST' })).json()
    expect(first).toEqual({ board: 'my-topic', origin: 'http://localhost:5173' })
    // The agent replacing the thread list doesn't lose it.
    await h.agent('/agent/threads', { method: 'POST', body: JSON.stringify([{ id: 'my.topic', title: 'T' }]) })
    expect((await (await h.user('/api/threads/my.topic/board', { method: 'POST' })).json()).board).toBe('my-topic')
    // Another thread that reads the same gets its own board.
    expect((await (await h.user('/api/threads/my-topic/board', { method: 'POST' })).json()).board).toBe('my-topic-2')
  } finally { h.hub.stop() }
})

test('board: a comment posted into the topic carries the board ref to the agent', async () => {
  const h = startHub({ boardOrigin: 'http://localhost:5173' })
  try {
    const png = await upload(h.hub.url, 'board-snapshot.png', 'image/png', new Uint8Array([137, 80, 78, 71]))
    const ctx = await upload(h.hub.url, 'board-context.json', 'application/json', JSON.stringify({ boardId: 'topic-1', threadId: 'comment-thread:abc' }))
    const link = 'http://localhost:5173/b/topic-1'
    const m = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({
      kind: 'text', thread: 'topic-1', text: `📌 Board #2: make it bigger\n\n${link}`, files: [png.id, ctx.id],
      board: { id: 'topic-1', thread: 'comment-thread:abc', number: 2, link, junk: 'x' },
    }) })).json()
    expect(m.body.board).toEqual({ id: 'topic-1', thread: 'comment-thread:abc', number: 2, link })
    const ev = await readSSE(await h.agent('/agent/stream'), e => e.some(x => x.data.id === m.id), 2000)
    const meta = buildMeta(ev.find(x => x.data.id === m.id)!.data)
    expect(meta.board_id).toBe('topic-1')
    expect(meta.board_thread).toBe('comment-thread:abc')
    expect(meta.image_path).toEndWith('.png')
    expect(meta.file_names).toBe('board-snapshot.png;board-context.json')

    // A malformed ref is dropped, the message still goes.
    const bad = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'x', board: { id: 'no' } }) })).json()
    expect(bad.body.board).toBeUndefined()
  } finally { h.hub.stop() }
})
