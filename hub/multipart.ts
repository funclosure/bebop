// Streaming multipart/form-data parser: parts are written to their sinks as
// bytes arrive, so a 2 GB video never sits in memory.

export type PartHeaders = { name: string; filename?: string; contentType: string }
export type Sink = { write(chunk: Uint8Array): Promise<void>; end(): Promise<void> }

export function boundaryOf(contentType: string | null): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  return m ? (m[1] ?? m[2]).trim() : null
}

function parseHeaders(raw: string): PartHeaders {
  const h: Record<string, string> = {}
  for (const line of raw.split('\r\n')) {
    const i = line.indexOf(':')
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  const cd = h['content-disposition'] ?? ''
  const name = /\bname="([^"]*)"/i.exec(cd)?.[1] ?? ''
  let filename = /\bfilename="([^"]*)"/i.exec(cd)?.[1]
  const star = /\bfilename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1]
  if (star) {
    try { filename = decodeURIComponent(star.replace(/^"|"$/g, '')) } catch {}
  }
  return { name, filename, contentType: h['content-type'] ?? 'application/octet-stream' }
}

/**
 * Reads `body` and calls `onPart` for each part. Return a Sink to receive the
 * part's bytes, or null to skip it. Throws on malformed input or when the
 * total exceeds `maxBytes`.
 */
export async function streamMultipart(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  onPart: (h: PartHeaders) => Promise<Sink | null>,
  maxBytes = Infinity,
): Promise<void> {
  const delim = Buffer.from(`\r\n--${boundary}`)
  const headerEnd = Buffer.from('\r\n\r\n')
  // Prefix CRLF so the first boundary looks like every other one.
  let buf: Buffer = Buffer.from('\r\n')
  let state: 'preamble' | 'after' | 'headers' | 'body' | 'done' = 'preamble'
  let sink: Sink | null = null
  let total = 0

  const step = async (final: boolean): Promise<boolean> => {
    switch (state) {
      case 'preamble': {
        const i = buf.indexOf(delim)
        if (i < 0) { buf = buf.subarray(Math.max(0, buf.length - delim.length)); return false }
        buf = buf.subarray(i + delim.length); state = 'after'; return true
      }
      case 'after': {
        if (buf.length < 2) return false
        if (buf[0] === 0x2d && buf[1] === 0x2d) { state = 'done'; return false }
        if (buf[0] === 0x0d && buf[1] === 0x0a) { buf = buf.subarray(2); state = 'headers'; return true }
        throw new Error('malformed multipart boundary')
      }
      case 'headers': {
        const i = buf.indexOf(headerEnd)
        if (i < 0) {
          if (buf.length > 16384) throw new Error('multipart headers too large')
          return false
        }
        const h = parseHeaders(new TextDecoder().decode(buf.subarray(0, i)))
        buf = buf.subarray(i + 4)
        sink = await onPart(h)
        state = 'body'
        return true
      }
      case 'body': {
        const i = buf.indexOf(delim)
        if (i >= 0) {
          if (sink) { await sink.write(buf.subarray(0, i)); await sink.end() }
          sink = null
          buf = buf.subarray(i + delim.length); state = 'after'; return true
        }
        const keep = final ? 0 : delim.length
        if (buf.length > keep) {
          if (sink) await sink.write(buf.subarray(0, buf.length - keep))
          buf = buf.subarray(buf.length - keep)
        }
        return false
      }
      default:
        return false
    }
  }

  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) throw new Error('upload too large')
      buf = buf.length ? Buffer.concat([buf, value]) : Buffer.from(value)
      while (await step(false)) {}
      if (state === 'done') break
    }
  } finally {
    reader.releaseLock()
  }
  if (state !== 'done') {
    if (sink) await (sink as Sink).end()
    throw new Error('multipart body ended early')
  }
}
