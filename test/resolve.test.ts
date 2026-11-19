import { test, expect, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { startHub } from './helpers'
import { renderContent, buildMeta, resolveText } from '../channel/server'

const { hub, agent, user } = startHub({ agentName: 'Test Companion' })
afterAll(() => hub.stop())
const post = (f: typeof agent, path: string, body: unknown) => f(path, { method: 'POST', body: JSON.stringify(body) })
const send = async (body: unknown) => (await (await post(agent, '/agent/send', { notify: false, ...(body as object) })).json()).id as number
const ask = () => send({ kind: 'question', questions: [{ id: 'q1', prompt: 'Which plan?', options: [{ label: 'A' }, { label: 'B' }] }] })
const approval = () => send({ kind: 'approval', prompt: 'Ship it?' })
const msg = async (id: number) => (await (await user('/api/messages?limit=200')).json()).find((m: any) => m.id === id)
const resolve = async (body: unknown) => (await post(agent, '/agent/resolve', body)).json()

test('resolve: the agent closes a card; it can no longer be answered; a second resolve says already', async () => {
  const old = await ask(), newer = await ask()
  const r = await resolve({ id: old, reason: 'Replaced by the newer plan', superseded_by: newer })
  expect(r).toMatchObject({ closed: true, state: 'resolved', resolved: { by: 'agent', reason: 'Replaced by the newer plan', superseded_by: newer } })
  expect((await msg(old)).body.resolved.superseded_by).toBe(newer)
  const late = await post(user, '/api/messages', { kind: 'answer', to: old, answers: { q1: ['A'] } })
  expect(late.status).toBe(409)
  expect((await late.json()).error).toBe('already closed')
  expect(await resolve({ id: old })).toMatchObject({ closed: true, already: true })
  expect(resolveText(await resolve({ id: old }))).toContain('already closed')
})

test('resolve: only the agent\'s questions and approvals; superseded_by must exist', async () => {
  const text = await send({ kind: 'text', text: 'hi' })
  expect((await post(agent, '/agent/resolve', { id: text })).status).toBe(404)
  expect((await post(agent, '/agent/resolve', { id: 999999 })).status).toBe(404)
  const q = await ask()
  expect((await post(agent, '/agent/resolve', { id: q, superseded_by: 999999 })).status).toBe(400)
  expect((await post(agent, '/agent/resolve', { id: q, superseded_by: q })).status).toBe(400)
  expect((await post(user, '/agent/resolve', { id: q })).status).toBe(401)
})

test('race: an answer that lands first wins; resolve reports it', async () => {
  const id = await approval()
  expect((await post(user, '/api/messages', { kind: 'answer', to: id, answers: { approval: ['Approve'] } })).status).toBe(201)
  const r = await resolve({ id, reason: 'stale' })
  expect(r).toMatchObject({ closed: false, state: 'answered', answered: 'Approve' })
  expect(resolveText(r)).toContain('already answered')
  expect((await msg(id)).body.resolved).toBeUndefined()
})

test('dismiss: the user closes a card without answering; the agent hears it; resolve after it says so', async () => {
  const id = await approval()
  const res = await post(user, '/api/messages', { kind: 'answer', to: id, dismiss: true })
  expect(res.status).toBe(201)
  const row = await res.json()
  expect(row.body).toEqual({ to: id, dismissed: true })
  expect((await msg(id)).body.resolved.by).toBe('user')
  expect((await post(user, '/api/messages', { kind: 'answer', to: id, dismiss: true })).status).toBe(409)
  expect((await post(user, '/api/messages', { kind: 'answer', to: id, answers: { approval: ['Approve'] } })).status).toBe(409)
  const r = await resolve({ id })
  expect(r).toMatchObject({ closed: false, state: 'dismissed' })
  expect(resolveText(r)).toContain('dismissed')
  const hist = await (await agent('/agent/history?limit=200')).json()
  expect(hist.find((m: any) => m.id === row.id).body.dismissed).toBe(true)
})

test('channel: a dismissal reads as one, with dismissed="1"', () => {
  const m = { id: 9, ts: 0, kind: 'answer', user: 'u', body: { to: 4, dismissed: true }, target: { kind: 'approval', body: { prompt: 'Ship it?' } } }
  expect(renderContent(m)).toBe('Dismissed approval 4 (Ship it?): the user closed it without answering. Stop waiting on it.')
  expect(buildMeta(m)).toMatchObject({ kind: 'answer', answer_to: '4', dismissed: '1' })
  expect(buildMeta({ ...m, body: { to: 4, answers: {} } }).dismissed).toBeUndefined()
})

test('app: closed cards stop counting as waiting; Dismiss in the sheet and by swiping left', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'web', 'app.js'), 'utf8')
  expect(app).toContain('const openCard = m => isCard(m) && m.body.answered == null && !m.body.resolved')
  expect(app).toContain('.filter(m => inView(m) && openCard(m))')
  expect(app).toContain("if (openCard(m)) actions.push(h('button', { type: 'button', class: 'danger', onclick: () => { close(); dismissCard(m) } }, S.dismiss))")
  expect(app).toMatch(/class: 'swipe-dismiss'[\s\S]{0,200}dismissCard\(m\)/)
  expect(app).toContain("enqueue({ kind: 'answer', to: m.id, dismiss: true })")
})
