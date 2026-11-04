// Optional speech-to-text for voice notes, through any CLI the operator configures:
// HUB_TRANSCRIBE_CMD is a shell command template with {in} (the audio file) and
// {out} (where the transcript goes). The hub reads {out} when the command exits 0.
import { existsSync, readFileSync } from 'fs'

export type Cue = { at: number; text: string }
export type TranscriptResult =
  | { status: 'done'; text: string; cues: Cue[]; raw: string }
  | { status: 'failed' | 'timeout'; error: string }

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Plain text and timed cues from a transcript. Lines like "[1:23] text" or
 * "[1:02:03] text" are cues; anything before the first cue (a header) is dropped.
 * Without any cue lines, the whole file is the text. */
export function parseTranscript(raw: string): { text: string; cues: Cue[] } {
  const cues: Cue[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?\]\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const at = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
    if (m[4].trim()) cues.push({ at, text: m[4].trim() })
  }
  if (cues.length) return { text: cues.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim(), cues }
  return { text: raw.replace(/\s+/g, ' ').trim(), cues: [] }
}

export async function runTranscriber(template: string, inPath: string, outPath: string, timeoutMs: number): Promise<TranscriptResult> {
  const cmd = template.replaceAll('{in}', shq(inPath)).replaceAll('{out}', shq(outPath))
  const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'ignore', stderr: 'pipe' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs) })
  const outcome = await Promise.race([proc.exited, timedOut])
  clearTimeout(timer)
  if (outcome === 'timeout') {
    proc.kill()
    return { status: 'timeout', error: `no transcript after ${Math.round(timeoutMs / 1000)}s` }
  }
  if (outcome !== 0) {
    const err = (await new Response(proc.stderr).text()).trim().split('\n').slice(-3).join(' ')
    return { status: 'failed', error: `exit ${outcome}${err ? `: ${err}` : ''}`.slice(0, 300) }
  }
  if (!existsSync(outPath)) return { status: 'failed', error: 'transcriber wrote no output' }
  const raw = readFileSync(outPath, 'utf8')
  const parsed = parseTranscript(raw)
  if (!parsed.text) return { status: 'failed', error: 'empty transcript' }
  return { status: 'done', ...parsed, raw: raw.trim() }
}
