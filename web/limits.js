// Posting limits for tools (SPEC.md, Tools): at most one post every gapMs per tool. A post that comes
// sooner waits its turn in a short queue (queueMax) instead of being refused, and is acked once sent.
// perMin, counting posts sent in the last minute plus those waiting, is the hard limit: past it a
// post is refused at once. Shared by the PWA and the tests.

/** @returns {{ slot(id: string): Promise<void>, waiting(id: string): number }} */
export function postLimiter({ gapMs = 2000, perMin = 20, queueMax = 5, now = () => Date.now(), wait = (ms, f) => setTimeout(f, ms) } = {}) {
  const tools = new Map() // id → { sent: number[], queue: (() => void)[], timer: boolean }
  const get = id => {
    let t = tools.get(id)
    if (!t) tools.set(id, t = { sent: [], queue: [], timer: false })
    const n = now()
    t.sent = t.sent.filter(s => n - s < 60_000)
    return t
  }
  const drain = (id, t) => {
    if (t.timer || !t.queue.length) return
    const last = t.sent[t.sent.length - 1] ?? -Infinity
    t.timer = true
    wait(Math.max(0, last + gapMs - now()), () => {
      t.timer = false
      get(id) // prune
      const go = t.queue.shift()
      if (go) { t.sent.push(now()); go() }
      drain(id, t)
    })
  }
  return {
    slot(id) {
      const t = get(id)
      if (t.sent.length + t.queue.length >= perMin) return Promise.reject(new Error('too many posts; wait a minute'))
      const last = t.sent[t.sent.length - 1]
      if (!t.queue.length && (last === undefined || now() - last >= gapMs)) { t.sent.push(now()); return Promise.resolve() }
      if (t.queue.length >= queueMax) return Promise.reject(new Error('too many posts; wait a moment'))
      return new Promise(resolve => { t.queue.push(resolve); drain(id, t) })
    },
    waiting: id => tools.get(id)?.queue.length ?? 0,
  }
}
