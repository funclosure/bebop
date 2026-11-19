// A video's size from its file (hub/media.ts), sent with the file so the app gives the video its
// shape before it loads; and the app keeping the reader's place when something above them grows.
import { test, expect, afterAll } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { videoSize } from '../hub/media'
import { startHub } from './helpers'

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length); head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}
// A tkhd body: version 0 (84 bytes) or 1 (96), the given matrix's a and b, and a 16.16 size.
function tkhd(w: number, h: number, { v1 = false, turned = false } = {}) {
  const b = Buffer.alloc(v1 ? 96 : 84)
  b[0] = v1 ? 1 : 0
  const m = v1 ? 52 : 40
  b.writeInt32BE(turned ? 0 : 0x10000, m); b.writeInt32BE(turned ? 0x10000 : 0, m + 4)
  b.writeInt32BE(turned ? -0x10000 : 0, m + 12); b.writeInt32BE(turned ? 0 : 0x10000, m + 16)
  b.writeUInt32BE(w * 65536, m + 36); b.writeUInt32BE(h * 65536, m + 40)
  return box('tkhd', b)
}
const trak = (t: Buffer) => box('trak', t, box('mdia', Buffer.alloc(16)))
const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1'))
const mdat = box('mdat', Buffer.alloc(4096, 7))
const dir = mkdtempSync(join(tmpdir(), 'media-test-'))
const file = (name: string, ...parts: Buffer[]) => { const p = join(dir, name); writeFileSync(p, Buffer.concat(parts)); return p }

test('the size of a web-ready MP4 (moov first) and of one with moov at the end', () => {
  const moov = box('moov', box('mvhd', Buffer.alloc(100)), trak(tkhd(1080, 1920)))
  expect(videoSize(file('first.mp4', ftyp, moov, mdat), 'video/mp4')).toEqual({ w: 1080, h: 1920 })
  expect(videoSize(file('last.mp4', ftyp, mdat, moov), 'video/mp4')).toEqual({ w: 1080, h: 1920 })
})

test('the audio track (no size) is skipped; a version 1 tkhd and a quarter turn are read', () => {
  const moov = box('moov', trak(tkhd(0, 0)), trak(tkhd(1920, 1080, { v1: true, turned: true })))
  expect(videoSize(file('turned.mov', ftyp, moov, mdat), 'video/quicktime')).toEqual({ w: 1080, h: 1920 })
})

test('anything it can\'t read gives null: no moov, random bytes, WebM, a missing file', () => {
  expect(videoSize(file('nomoov.mp4', ftyp, mdat), 'video/mp4')).toBeNull()
  expect(videoSize(file('noise.mp4', Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 256))), 'video/mp4')).toBeNull()
  expect(videoSize(file('clip.webm', ftyp, box('moov', trak(tkhd(640, 360))), mdat), 'video/webm')).toBeNull()
  expect(videoSize(join(dir, 'missing.mp4'), 'video/mp4')).toBeNull()
})

const { hub, user } = startHub()
afterAll(() => hub.stop())

test('a video\'s size goes out with the file (w, h); other files have none', async () => {
  const fd = new FormData()
  fd.append('file', new File([Buffer.concat([ftyp, box('moov', trak(tkhd(1080, 1920))), mdat])], 'reel.mp4', { type: 'video/mp4' }))
  fd.append('file', new File(['x'], 'cover.jpg', { type: 'image/jpeg' }))
  const up = await (await fetch(hub.url + '/api/upload', { method: 'POST', body: fd })).json()
  expect(up[0]).toMatchObject({ name: 'reel.mp4', w: 1080, h: 1920 })
  expect(up[1].w).toBeUndefined()
  await user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'reel', files: up.map((f: any) => f.id) }) })
  const page = await (await user('/api/messages?limit=1')).json()
  expect(page[0].files[0]).toMatchObject({ w: 1080, h: 1920 })
})

const web = (f: string) => Bun.file(join(import.meta.dir, '..', 'web', f)).text()
const body = (src: string, name: string) => { const i = src.indexOf(name); return src.slice(i, src.indexOf('\n}\n', i)) }

test('the app gives a video its known shape at once, and measures only the ones the hub can\'t', async () => {
  const files = body(await web('app.js'), 'function renderFiles(')
  expect(files).toContain('const known = f.w > 0 && f.h > 0')
  expect(files).toContain('if (known) v.style.aspectRatio = `${f.w} / ${f.h}`')
  expect(files).toContain('onloadedmetadata: known ? null : videoShape')
})

test('away from the bottom the list keeps the reader\'s place when something above grows; scrolling up lets go of the bottom', async () => {
  const app = await web('app.js')
  expect(app).toContain('const pin = new ResizeObserver(() => { if (pinned) list.scrollTop = list.scrollHeight; else keepPlace() })')
  const keep = body(app, 'function keepPlace(')
  expect(keep).toContain('if (!n?.isConnected) return')
  expect(keep).toContain('if (Math.abs(d) >= 1) list.scrollTop += d')
  // Noted on every scroll, with the reader's way: up (and not just moved to the end) unpins at once.
  expect(app).toContain('const up = top < lastTop - 1 && top < list.scrollHeight - list.clientHeight - 1')
  expect(app).toContain('pinned = state.atLatest && atBottom() && !up\n  notePlace()')
})
