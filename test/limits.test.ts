import { test, expect } from 'bun:test'
// @ts-ignore: plain JS module shared with the PWA
import { postLimiter } from '../web/limits.js'

/** A limiter on a fake clock: advance(ms) runs the timers that come due. */
function fake(opts = {}) {
  let t = 1_000_000
  let timers: { at: number; f: () => void }[] = []
  const lim = postLimiter({ ...opts, now: () => t, wait: (ms: number, f: () => void) => { timers.push({ at: t + ms, f }) } })
  const advance = async (ms: number) => {
    const end = t + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > end) break
      timers = timers.slice(1)
      t = next.at
      next.f()
      await Promise.resolve()
    }
    t = end
    await Promise.resolve()
  }
  return { lim, advance, now: () => t }
}
const settle = () => new Promise(r => setTimeout(r, 0))

test('a post within 2 s of the last waits its turn instead of being refused, and goes out 2 s apart', async () => {
  const { lim, advance, now } = fake()
  const t0 = now()
  const sent: [string, number][] = []
  const post = (name: string) => lim.slot('board').then(() => sent.push([name, now() - t0]), (e: Error) => sent.push([`${name}: ${e.message}`, now() - t0]))
  post('a'); post('b'); post('c')
  await settle()
  expect(sent).toEqual([['a', 0]])
  expect(lim.waiting('board')).toBe(2)
  await advance(2000); await settle()
  expect(sent).toEqual([['a', 0], ['b', 2000]])
  await advance(2000); await settle()
  expect(sent).toEqual([['a', 0], ['b', 2000], ['c', 4000]])
  // Other tools have their own line.
  const other: string[] = []
  lim.slot('hello').then(() => other.push('now'))
  await settle()
  expect(other).toEqual(['now'])
})

test('the queue holds 5; a sixth waiting post is refused at once', async () => {
  const { lim } = fake()
  const out: string[] = []
  for (let i = 0; i < 7; i++) lim.slot('t').then(() => out.push(`ok${i}`), (e: Error) => out.push(`no${i}: ${e.message}`))
  await settle()
  expect(out).toEqual(['ok0', 'no6: too many posts; wait a moment'])
  expect(lim.waiting('t')).toBe(5)
})

test('20 a minute is the hard limit (sent plus waiting); the minute slides', async () => {
  const { lim, advance } = fake({ queueMax: 50 })
  let ok = 0
  const refused: string[] = []
  for (let i = 0; i < 25; i++) lim.slot('t').then(() => ok++, (e: Error) => refused.push(e.message))
  await settle()
  expect(refused.length).toBe(5)
  expect(refused[0]).toBe('too many posts; wait a minute')
  await advance(40_000); await settle()
  expect(ok).toBe(20)
  // 20 sent in the last minute: still refused...
  await expect(lim.slot('t')).rejects.toThrow('wait a minute')
  // ...until the first ones are a minute old.
  await advance(20_001)
  await expect(lim.slot('t')).resolves.toBeUndefined()
})
