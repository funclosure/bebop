// examples/transcribe.sh (whisper.cpp) with stand-in tools: SRT → "[m:ss] text" cues that
// parseTranscript reads, and plain errors when a tool or the model is missing.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseTranscript } from '../hub/transcribe'

const script = join(import.meta.dir, '..', 'examples', 'transcribe.sh')
const root = mkdtempSync(join(tmpdir(), 'tr-'))
const bin = join(root, 'bin'); mkdirSync(bin)
const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
// ffmpeg: copy the input to the last argument. whisper-cli: write an SRT next to -of, record its args.
tool('ffmpeg', 'for a; do last="$a"; done; cp "$4" "$last" 2>/dev/null || : > "$last"')
tool('whisper-cli', `echo "$@" > "${root}/args"; of=""; while [ $# -gt 0 ]; do [ "$1" = "-of" ] && of="$2"; shift; done
printf '1\\n00:00:00,000 --> 00:00:02,500\\nHello Bob,\\nplease check the build.\\n\\n2\\n00:01:05,100 --> 00:01:07,000\\n 然後告訴我。 \\n\\n3\\n01:02:03,000 --> 01:02:04,000\\nLate.\\n' > "$of.srt"`)
const model = join(root, 'model.bin'); writeFileSync(model, 'x')
const run = (env: Record<string, string>, ...args: string[]) => {
  const r = Bun.spawnSync(['bash', script, ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, BEBOP_WHISPER_MODEL: model, ...env }, stderr: 'pipe', stdout: 'pipe' })
  return { code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString() }
}

test('transcribe.sh: cues per segment, the language and prompt passed on', () => {
  const inp = join(root, 'note.m4a'), out = join(root, 'note.txt')
  writeFileSync(inp, 'audio')
  const r = run({ BEBOP_WHISPER_PROMPT: '以下是繁體中文的句子。' }, inp, out)
  expect(r.code).toBe(0)
  const txt = readFileSync(out, 'utf8')
  expect(txt).toBe('[0:00] Hello Bob, please check the build.\n[1:05] 然後告訴我。\n[1:02:03] Late.\n')
  expect(parseTranscript(txt).cues.map(c => c.at)).toEqual([0, 65, 3723])
  const args = readFileSync(join(root, 'args'), 'utf8')
  expect(args).toContain('-l auto')
  expect(args).toContain('--prompt 以下是繁體中文的句子。')
  expect(run({}, '--check').out).toContain('ok:')
})

test('transcribe.sh: says what is missing', () => {
  const inp = join(root, 'note.m4a'), out = join(root, 'x.txt')
  const noCli = run({ WHISPER_CLI: 'no-such-whisper' }, inp, out)
  expect(noCli.code).toBe(2)
  expect(noCli.err).toContain('whisper-cli not found (macOS: brew install whisper-cpp')
  expect(run({}, join(root, 'nope.m4a'), out).err).toContain('no such audio file')
  // No model: start the download in the background (here to a dead address) and say so.
  const r = run({ BEBOP_WHISPER_MODEL: join(root, 'models', 'm.bin'), BEBOP_WHISPER_URL: 'http://127.0.0.1:9/m.bin' }, inp, out)
  expect(r.code).toBe(2)
  expect(r.err).toContain('downloading the speech model')
  expect(run({ BEBOP_WHISPER_MODEL: join(root, 'none.bin') }, '--check').err).toContain('no model at')
})
