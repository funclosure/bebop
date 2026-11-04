import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHub } from '../hub/server'

export function startHub(extra: Partial<Parameters<typeof createHub>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-test-'))
  // Icon lookups stay inside the test's own folder, never the real home folder.
  const hub = createHub({ dataDir, port: 0, log: () => {}, iconRoots: [dataDir], ...extra })
  const agent = (path: string, init: RequestInit = {}) =>
    fetch(hub.url + path, { ...init, headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const user = (path: string, init: RequestInit = {}) =>
    fetch(hub.url + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { hub, dataDir, agent, user }
}

/** Reads SSE events from a fetch Response until `until` returns true or the timeout hits. */
export async function readSSE(res: Response, until: (events: { event: string; data: any; id?: string }[]) => boolean, ms = 3000) {
  const events: { event: string; data: any; id?: string }[] = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + ms
  try {
    while (!until(events)) {
      const left = deadline - Date.now()
      if (left <= 0) break
      const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)])
      if (!r || r.done) break
      buf += dec.decode(r.value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        let event = 'message', data = '', id: string | undefined
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) data += line.slice(6)
          else if (line.startsWith('id: ')) id = line.slice(4)
        }
        if (data) events.push({ event, data: JSON.parse(data), id })
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return events
}
