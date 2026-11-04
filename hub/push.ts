// Web Push with VAPID. web-push does the encryption and the signed JWT;
// the request itself goes out through fetch.
import webpush from 'web-push'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { Database } from 'bun:sqlite'

export type Vapid = { publicKey: string; privateKey: string }

export function loadVapid(file: string): Vapid {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const keys = webpush.generateVAPIDKeys()
  writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  return keys
}

/** `tag` replaces an earlier notification with the same tag; `pane` makes a tap open that pane. */
export type PushPayload = { title: string; body: string; thread: string | null; id: number | null; tag?: string; pane?: string; url?: string }

export async function sendPushToAll(
  db: Database, vapid: Vapid, subject: string, payload: PushPayload,
): Promise<{ sent: number; removed: number }> {
  const subs = db.query('SELECT endpoint, json FROM push_subs').all() as { endpoint: string; json: string }[]
  let sent = 0, removed = 0
  await Promise.all(subs.map(async s => {
    try {
      const d = webpush.generateRequestDetails(JSON.parse(s.json), JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 24 * 3600,
        urgency: 'high',
      })
      const res = await fetch(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body })
      if (res.status === 404 || res.status === 410) {
        db.query('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint)
        removed++
      } else if (res.ok) {
        sent++
      } else {
        console.warn(`push: ${res.status} from ${new URL(d.endpoint).host}`)
      }
    } catch (err) {
      console.warn(`push: failed: ${err}`)
    }
  }))
  return { sent, removed }
}
