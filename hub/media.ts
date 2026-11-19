// A video's size in pixels, read from its file, so the app can give the video its shape before it
// loads. A box that changes shape when the video arrives moves the message list under the reader.
// MP4 / QuickTime only (the `tkhd` of the first track with a size, turned when the track is
// rotated a quarter turn); anything else, or a file it can't read, gives null and the app falls
// back to measuring the video when it loads.
import { openSync, readSync, closeSync, fstatSync } from 'fs'

export type Size = { w: number; h: number }

const MAX_MOOV = 32 << 20 // a moov this big is not a phone clip; don't read it

function read(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len)
  return b.subarray(0, readSync(fd, b, 0, len, pos))
}

/** The boxes inside an ISO BMFF buffer: type and body. */
function* boxes(b: Buffer): Generator<{ type: string; body: Buffer }> {
  let p = 0
  while (p + 8 <= b.length) {
    let len = b.readUInt32BE(p), head = 8
    if (len === 1) { if (p + 16 > b.length) return; len = Number(b.readBigUInt64BE(p + 8)); head = 16 }
    else if (len === 0) len = b.length - p
    if (len < head || p + len > b.length) return
    yield { type: b.toString('latin1', p + 4, p + 8), body: b.subarray(p + head, p + len) }
    p += len
  }
}

/** Width and height from a `tkhd` body (16.16 fixed point), swapped for a quarter-turn matrix. */
function tkhdSize(t: Buffer): Size | null {
  const v1 = t[0] === 1
  const matrix = v1 ? 52 : 40
  if (t.length < matrix + 44) return null
  const a = t.readInt32BE(matrix), b = t.readInt32BE(matrix + 4)
  let w = Math.round(t.readUInt32BE(matrix + 36) / 65536), h = Math.round(t.readUInt32BE(matrix + 40) / 65536)
  if (!w || !h) return null // an audio track
  if (a === 0 && b !== 0) [w, h] = [h, w]
  return { w, h }
}

function moovSize(moov: Buffer): Size | null {
  for (const trak of boxes(moov)) {
    if (trak.type !== 'trak') continue
    for (const box of boxes(trak.body)) if (box.type === 'tkhd') { const s = tkhdSize(box.body); if (s) return s }
  }
  return null
}

/** Finds `moov` among the top-level boxes (at the start of a web-ready file, at the end otherwise). */
function mp4Size(fd: number): Size | null {
  const size = fstatSync(fd).size
  let pos = 0
  for (let i = 0; i < 64 && pos + 8 <= size; i++) {
    const h = read(fd, pos, 16)
    if (h.length < 8) return null
    let len = h.readUInt32BE(0), head = 8
    if (len === 1) { len = Number(h.readBigUInt64BE(8)); head = 16 } else if (len === 0) len = size - pos
    if (len < head) return null
    if (h.toString('latin1', 4, 8) === 'moov') return len > MAX_MOOV ? null : moovSize(read(fd, pos + head, len - head))
    pos += len
  }
  return null
}

const MP4 = /^video\/(mp4|quicktime|x-m4v|3gpp)$/

export function videoSize(path: string, mime: string): Size | null {
  if (!MP4.test(mime)) return null
  let fd: number
  try { fd = openSync(path, 'r') } catch { return null }
  try { return mp4Size(fd) } catch { return null } finally { closeSync(fd) }
}
