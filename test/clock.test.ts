// The clock: timers in SQLite that put a kind "timer" note in the agent's inbox when due.
import { test, expect, afterAll } from 'bun:test'
import { startHub, readSSE } from './helpers'
import { openDb } from '../hub/db'
import { join } from 'path'
import { parseAt, parseRepeat, nextDue, localIso, MIN_EVERY_MS } from '../hub/clock'
import { renderContent, buildMeta, renderTimers } from '../channel/server'

const pushes: unknown[] = []
const h = startHub({ sendPush: p => { pushes.push(p) } })
afterAll(() => h.hub.stop())
const json = (r: Response) => r.json() as Promise<any>
const post = (f: typeof h.agent, path: string, body: unknown, headers: Record<string, string> = {}) =>
  f(path, { method: 'POST', body: JSON.stringify(body), headers })
const set = (body: object) => post(h.agent, '/agent/timers', body)
const hourAhead = () => localIso(Date.now() + 3_600_000).slice(0, 16) // "YYYY-MM-DDTHH:MM", local

// ---------- arithmetic ----------

test('parseAt: local time without an offset, Z or an offset pins it; ms; no date-only or impossible dates', () => {
  expect(parseAt('2026-11-18T09:00')).toBe(new Date(2026, 10, 18, 9, 0).getTime())
  expect(parseAt('2026-11-18 09:00:30')).toBe(new Date(2026, 10, 18, 9, 0, 30).getTime())
  expect(parseAt('2026-11-18T09:00:00Z')).toBe(Date.UTC(2026, 10, 18, 9))
  expect(parseAt('2026-11-18T09:00+08:00')).toBe(Date.UTC(2026, 10, 18, 1))
  expect(parseAt('2026-11-18T09:00-0530')).toBe(Date.UTC(2026, 10, 18, 14, 30))
  expect(parseAt(1_800_000_000_000)).toBe(1_800_000_000_000)
  for (const bad of ['2026-11-18', 'tomorrow', '2026-02-30T09:00', '2026-13-01T09:00', '2026-11-18T25:00', '', null, -5, NaN, {}])
    expect(parseAt(bad)).toBeNull()
})

test('parseRepeat: one spelling each; at least 15 minutes apart', () => {
  expect(parseRepeat('Daily')).toBe('daily')
  expect(parseRepeat('weekdays')).toBe('weekdays')
  expect(parseRepeat('weekly')).toBe('weekly')
  expect(parseRepeat('every 30 minutes')).toBe('every 30m')
  expect(parseRepeat('every 2h')).toBe('every 2h')
  expect(parseRepeat('every 3 days')).toBe('every 3d')
  expect(parseRepeat('every 15m')).toBe('every 15m')
  expect(parseRepeat(undefined)).toBeNull()
  expect(parseRepeat('')).toBeNull()
  for (const bad of ['every 5m', 'every 14 minutes', 'hourly', 'every 0d', 'monthly', 7]) expect(() => parseRepeat(bad)).toThrow(/at least 15 minutes/)
  expect(MIN_EVERY_MS).toBe(15 * 60_000)
})

test('nextDue: days keep the wall-clock time; weekdays skip the weekend; intervals step; missed ones are skipped', () => {
  const due = new Date(2026, 10, 16, 9, 0).getTime() // a Monday, 09:00
  const d = (ms: number) => new Date(ms)
  const daily = d(nextDue(due, 'daily', due))
  expect([daily.getDate(), daily.getHours(), daily.getMinutes()]).toEqual([17, 9, 0])
  // A week down: the next one, not seven.
  const late = d(nextDue(due, 'daily', new Date(2026, 10, 23, 12, 0).getTime()))
  expect([late.getDate(), late.getHours()]).toEqual([24, 9])
  const fri = new Date(2026, 10, 20, 9, 0).getTime()
  const wk = d(nextDue(fri, 'weekdays', fri))
  expect([wk.getDay(), wk.getDate(), wk.getHours()]).toEqual([1, 23, 9])
  expect(d(nextDue(due, 'weekly', due)).getDate()).toBe(23)
  expect(d(nextDue(due, 'every 3d', due)).getDate()).toBe(19)
  expect(nextDue(due, 'every 30m', due)).toBe(due + 30 * 60_000)
  expect(nextDue(due, 'every 2h', due + 5 * 3_600_000)).toBe(due + 6 * 3_600_000)
  // Across a clock change (wherever this runs): still 09:00.
  const march = new Date(2026, 2, 1, 9, 0).getTime()
  for (let i = 0, t = march; i < 60; i++) { t = nextDue(t, 'daily', t); expect(d(t).getHours()).toBe(9) }
})

test('localIso: local time with its offset, readable back', () => {
  const t = new Date(2026, 10, 18, 9, 5, 7).getTime()
  expect(localIso(t)).toMatch(/^2026-11-18T09:05:07[+-]\d{2}:\d{2}$/)
  expect(parseAt(localIso(t))).toBe(t)
})

// ---------- the agent's side ----------

test('timers: set with local time, list, a key replaces, cancel by key or id', async () => {
  const at = hourAhead()
  const r = await set({ text: 'Check the release notes', at, thread: 'release', key: 'task:release' })
  expect(r.status).toBe(201)
  const t = await json(r)
  expect(t).toMatchObject({ replaced: false, text: 'Check the release notes', due: parseAt(at), thread: 'release', key: 'task:release', state: 'scheduled', repeat: null })
  expect(t.due_local.startsWith(at)).toBe(true)
  // Same key: moved and reworded, same id.
  const later = localIso(Date.now() + 7_200_000).slice(0, 16)
  const moved = await json(await set({ text: 'Check the release notes (moved)', at: later, key: 'task:release', repeat: 'weekly' }))
  expect(moved).toMatchObject({ id: t.id, replaced: true, text: 'Check the release notes (moved)', due: parseAt(later), repeat: 'weekly', changed_by: 'agent' })
  const list = (await json(await h.agent('/agent/timers'))).timers
  expect(list.filter((x: any) => x.key === 'task:release').length).toBe(1)
  // By id too.
  expect((await json(await set({ id: t.id, text: 'By id', at: later }))).replaced).toBe(true)
  expect((await set({ id: 999999, text: 'x', at: later })).status).toBe(404)
  const c = await json(await post(h.agent, '/agent/timers/cancel', { key: 'task:release' }))
  expect(c).toMatchObject({ cancelled: 1, ids: [t.id] })
  expect(await json(await post(h.agent, '/agent/timers/cancel', { key: 'task:release' }))).toMatchObject({ cancelled: 0 })
  expect((await json(await h.agent('/agent/timers'))).timers.some((x: any) => x.id === t.id)).toBe(false)
  const all = (await json(await h.agent('/agent/timers?all=1'))).timers
  expect(all.find((x: any) => x.id === t.id)).toMatchObject({ state: 'cancelled', changed_by: 'agent' })
  // After cancelling, the key is free again: a new timer.
  expect((await json(await set({ text: 'Again', at, key: 'task:release' }))).replaced).toBe(false)
  expect((await post(h.agent, '/agent/timers/cancel', {})).status).toBe(400)
})

test('timers: refuses what it can\'t read', async () => {
  const bad = async (body: object) => { const r = await set(body); return r.status === 400 ? (await json(r)).error : `status ${r.status}` }
  expect(await bad({ at: hourAhead() })).toBe('text required')
  expect(await bad({ text: 'x', at: '2026-11-18' })).toContain('a date and time')
  expect(await bad({ text: 'x', at: 'next tuesday' })).toContain('a date and time')
  expect(await bad({ text: 'x', at: localIso(Date.now() - 3_600_000) })).toContain('in the past')
  expect(await bad({ text: 'x', at: Date.now() + 6 * 366 * 86_400_000 })).toContain('five years')
  expect(await bad({ text: 'x', at: hourAhead(), repeat: 'every 5m' })).toContain('at least 15 minutes')
  expect(await bad({ text: 'x'.repeat(2001), at: hourAhead() })).toContain('at most 2000')
})

test('firing: due → a kind "timer" note down the stream and quietly in its topic; a one-off is done, a repeat moves on', async () => {
  const stream = h.agent('/agent/stream').then(r => readSSE(r, e => e.filter(x => x.data.kind === 'timer').length >= 2, 4000))
  const events = h.user('/api/events').then(r => readSSE(r, e => e.some(x => x.event === 'message' && x.data.kind === 'timer') && e.some(x => x.event === 'timers'), 4000))
  await Bun.sleep(30)
  pushes.length = 0
  const once = await json(await set({ text: 'Check the build', at: Date.now() + 150, thread: 'build' }))
  // A repeat can't be under 15 minutes, so set one and let it come due by moving it now.
  const rep = await json(await set({ text: 'Standup notes', at: Date.now() + 3_600_000, repeat: 'daily', key: 'standup' }))
  h.hub.db.query('UPDATE timers SET due = ? WHERE id = ?').run(Date.now() + 200, rep.id)
  await set({ text: 'Nudge', at: Date.now() + 3_600_000 }) // re-arms the clock for the new due time
  const got = (await stream).filter(x => x.data.kind === 'timer').map(x => x.data)
  const a = got.find(m => m.body.timer === once.id)!
  expect(a).toMatchObject({ sender: 'clock', kind: 'timer', thread: 'build', body: { text: 'Check the build', timer: once.id, fires: 1 } })
  expect(a.user).toBeUndefined()
  expect(a.body.late).toBeUndefined()
  const b = got.find(m => m.body.timer === rep.id)!
  expect(b.body).toMatchObject({ repeat: 'daily', key: 'standup' })
  const all = (await json(await h.agent('/agent/timers?all=1'))).timers
  expect(all.find((x: any) => x.id === once.id)).toMatchObject({ state: 'done', fires: 1 })
  const r = all.find((x: any) => x.id === rep.id)
  expect(r).toMatchObject({ state: 'scheduled', fires: 1 })
  expect(r.due).toBeGreaterThan(Date.now() + 23 * 3_600_000)
  const ev = await events
  expect(ev.find(x => x.event === 'message' && x.data.kind === 'timer')!.data.sender).toBe('clock')
  expect(pushes).toEqual([])
  const shown = await json(await h.user('/api/messages?thread=build'))
  expect(shown.some((m: any) => m.kind === 'timer' && m.body.timer === once.id)).toBe(true)
  const threads = await json(await h.user('/api/threads'))
  expect(threads.threads.find((x: any) => x.id === 'build')?.unread ?? 0).toBe(0)
})

test('firing: one missed while the hub was down fires once at the next start, marked late; a repeat skips what it missed', async () => {
  const a = startHub()
  const t = await json(await post(a.agent, '/agent/timers', { text: 'Weekly review', at: Date.now() + 3_600_000, repeat: 'weekly' }))
  await a.hub.stop()
  const db = openDb(join(a.dataDir, 'hub.sqlite'))
  const due = Date.now() - 15 * 86_400_000 // two weeks and a day ago
  db.query('UPDATE timers SET due = ? WHERE id = ?').run(due, t.id)
  db.close()
  const b = startHub({ dataDir: a.dataDir })
  try {
    const ev = await readSSE(await b.agent('/agent/stream'), e => e.some(x => x.data.kind === 'timer'), 3000)
    const notes = ev.filter(x => x.data.kind === 'timer')
    expect(notes.length).toBe(1)
    expect(notes[0].data.body).toMatchObject({ timer: t.id, late: true, due })
    const meta = buildMeta(notes[0].data)
    expect(meta).toMatchObject({ kind: 'timer', timer_id: String(t.id), late: '1', repeat: 'weekly', due: localIso(due) })
    expect(renderContent(notes[0].data)).toContain('late: it was due')
    const left = (await json(await b.agent('/agent/timers'))).timers[0]
    expect(left.due).toBeGreaterThan(Date.now())
    expect(left.due).toBeLessThan(Date.now() + 7 * 86_400_000 + 1000)
  } finally { await b.hub.stop() }
})

// ---------- the user's side ----------

test('user: lists timers, moves or cancels one (X-Hub-Action); the agent hears of it, the conversation doesn\'t show it', async () => {
  const t = await json(await set({ text: 'Water the plants', at: hourAhead(), thread: 'garden', key: 'task:plants' }))
  const listed = (await json(await h.user('/api/timers'))).timers
  expect(listed.find((x: any) => x.id === t.id)).toMatchObject({ text: 'Water the plants', thread: 'garden' })
  expect((await post(h.user, `/api/timers/${t.id}`, { at: hourAhead() })).status).toBe(403)
  const stream = h.agent('/agent/stream').then(r => readSSE(r, e => e.filter(x => x.data.body?.change).length >= 2, 3000))
  await Bun.sleep(30)
  const newAt = localIso(Date.now() + 2 * 86_400_000).slice(0, 16)
  const moved = await json(await post(h.user, `/api/timers/${t.id}`, { at: newAt }, { 'x-hub-action': '1' }))
  expect(moved).toMatchObject({ id: t.id, due: parseAt(newAt), changed_by: 'user', state: 'scheduled' })
  expect((await post(h.user, `/api/timers/${t.id}`, { at: 'soon' }, { 'x-hub-action': '1' })).status).toBe(400)
  const cancelled = await json(await post(h.user, `/api/timers/${t.id}/cancel`, {}, { 'x-hub-action': '1' }))
  expect(cancelled).toMatchObject({ state: 'cancelled', changed_by: 'user' })
  expect((await post(h.user, `/api/timers/${t.id}/cancel`, {}, { 'x-hub-action': '1' })).status).toBe(404)
  const notes = (await stream).filter(x => x.data.body?.change).map(x => x.data)
  expect(notes.map(n => n.body.change)).toEqual(['moved', 'cancelled'])
  expect(notes[0].body).toMatchObject({ timer: t.id, due: parseAt(newAt), was: t.due, key: 'task:plants', by: 'local' })
  expect(buildMeta(notes[0])).toMatchObject({ kind: 'timer', change: 'moved', by: 'local', due: localIso(parseAt(newAt)!), key: 'task:plants' })
  expect(renderContent(notes[0])).toStartWith(`The user moved timer ${t.id} ("Water the plants") to ${localIso(parseAt(newAt)!)}`)
  expect(renderContent(notes[1])).toStartWith(`The user cancelled timer ${t.id}`)
  // Not in the conversation, not in search, not moving the topic.
  const shown = await json(await h.user('/api/messages?thread=garden'))
  expect(shown.some((m: any) => m.kind === 'timer')).toBe(false)
  expect((await json(await h.user('/api/messages?limit=200'))).some((m: any) => m.body?.change)).toBe(false)
  expect((await json(await h.user('/api/threads'))).threads.some((x: any) => x.id === 'garden')).toBe(false)
  // The agent's history has them.
  const hist = await json(await h.agent('/agent/history?thread=garden'))
  expect(hist.map((m: any) => m.body.change)).toEqual(['moved', 'cancelled'])
})

test('renderTimers: one line each', () => {
  expect(renderTimers([])).toBe('(no timers)')
  expect(renderTimers([{ id: 3, state: 'scheduled', due_local: '2026-11-18T09:00:00+08:00', repeat: 'weekly', key: 'task:x', thread: 'release', fires: 2, text: 'Ask' }]))
    .toBe('#3 2026-11-18T09:00:00+08:00 (weekly) key=task:x (release) fired 2×: Ask')
  expect(renderTimers([{ id: 4, state: 'cancelled', changed_by: 'user', due_local: '', fires: 0, text: 'Gone' }])).toBe('#4 cancelled by user: Gone')
})

test('the app: a fired timer\'s text takes the line; the topic and time wrap under it, the topic cut short, never the text', async () => {
  const web = (f: string) => Bun.file(join(import.meta.dir, '..', 'web', f)).text()
  const app = await web('app.js'), css = await web('style.css')
  const line = app.slice(app.indexOf('function buildTimerLine('), app.indexOf('\n}\n', app.indexOf('function buildTimerLine(')))
  // Late, topic and time are one group after the text (a long topic title once left the text no width on a phone).
  expect(line.indexOf("class: 'note-text'")).toBeLessThan(line.indexOf("class: 'note-meta'"))
  expect(line.slice(line.indexOf("class: 'note-meta'"))).toContain('threadTag(m)')
  expect(css).toContain('.note-line { display: flex; flex-wrap: wrap;')
  expect(css).toContain('.note-line .note-text { flex: 1 1 12em; min-width: 0; overflow-wrap: anywhere; }')
  expect(css).toContain('.note-meta > .thread-tag { flex: 0 1 auto; min-width: 0; max-width: 18em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }')
})
