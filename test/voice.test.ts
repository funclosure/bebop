import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHub, readSSE } from './helpers'
import { parseTranscript } from '../hub/transcribe'
import { buildMeta } from '../channel/server'

// A fake transcriber: waits $1 seconds, then writes a header + timed cues to {out}.
const bin = mkdtempSync(join(tmpdir(), 'hub-fake-stt-'))
const fake = join(bin, 'fake-stt')
writeFileSync(fake, `#!/bin/sh
sleep "$1"
printf 'Title\\nChannel\\nhttps://example.com\\n\\n[0:00] Ship the meadow header\\n[0:04] with the next version.\\n' > "$3"
`)
chmodSync(fake, 0o755)

async function upload(url: string) {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(2048)], 'voice.m4a', { type: 'audio/mp4' }))
  return (await (await fetch(url + '/api/upload', { method: 'POST', body: fd })).json())[0]
}
const sendVoice = (url: string, id: string) =>
  fetch(url + '/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'voice', files: [id], duration: 6.2 }) }).then(r => r.json())

test('parseTranscript drops the header and keeps timed cues', () => {
  const p = parseTranscript('T\nC\nU\n\n[0:01] hello\n[1:02:03] there\n')
  expect(p.text).toBe('hello there')
  expect(p.cues).toEqual([{ at: 1, text: 'hello' }, { at: 3723, text: 'there' }])
  expect(parseTranscript('just words\n').text).toBe('just words')
})

test('voice: delivery waits for the transcript, which is attached and announced', async () => {
  const h = startHub({ transcribeCmd: `${fake} 0.6 {in} {out}` })
  try {
    const f = await upload(h.hub.url)
    const events = h.user('/api/events').then(r => readSSE(r, e => e.some(x => x.event === 'update' && x.data.kind === 'voice'), 5000))
    await Bun.sleep(50)
    const m = await sendVoice(h.hub.url, f.id)
    expect(m.body).toMatchObject({ duration: 6.2, transcript: null, transcript_status: 'pending' })

    // Not on the agent stream yet.
    let ev = await readSSE(await h.agent('/agent/stream'), () => false, 300)
    expect(ev.some(x => x.data.id === m.id)).toBe(false)

    // Arrives once transcribed, with the text and a local audio path.
    ev = await readSSE(await h.agent('/agent/stream'), e => e.some(x => x.data.id === m.id), 4000)
    const got = ev.find(x => x.data.id === m.id)!.data
    expect(got.kind).toBe('voice')
    expect(got.body.transcript).toBe('Ship the meadow header with the next version.')
    expect(got.body.transcript_cues).toEqual([{ at: 0, text: 'Ship the meadow header' }, { at: 4, text: 'with the next version.' }])
    expect(got.files[0].path).toEndWith('.m4a')

    const upd = (await events).find(x => x.event === 'update' && x.data.id === m.id)!.data
    expect(upd.body.transcript_status).toBe('done')
  } finally { h.hub.stop() }
})

test('voice: a transcriber that takes too long times out and the note is delivered without text', async () => {
  const h = startHub({ transcribeCmd: `${fake} 5 {in} {out}`, transcribeTimeoutMs: 400 })
  try {
    const f = await upload(h.hub.url)
    const m = await sendVoice(h.hub.url, f.id)
    const ev = await readSSE(await h.agent('/agent/stream'), e => e.some(x => x.data.id === m.id), 3000)
    const got = ev.find(x => x.data.id === m.id)!.data
    expect(got.body).toMatchObject({ transcript: null, transcript_status: 'timeout' })
  } finally { h.hub.stop() }
})

test('voice: without a transcriber the note is delivered at once', async () => {
  const h = startHub()
  try {
    const f = await upload(h.hub.url)
    const m = await sendVoice(h.hub.url, f.id)
    expect(m.body.transcript_status).toBe('off')
    const ev = await readSSE(await h.agent('/agent/stream'), e => e.some(x => x.data.id === m.id), 1000)
    expect(ev.some(x => x.data.id === m.id)).toBe(true)
    expect((await sendVoice(h.hub.url, 'nope') as any).error).toBeDefined()
  } finally { h.hub.stop() }
})

// A fake refiner: {in} is the transcript; writes a two-line prompt to {out}.
const refiner = join(bin, 'fake-refine')
writeFileSync(refiner, `#!/bin/sh
printf 'Ship the header with the next version.\\n\\n- Keep the meadow.\\n' > "$2"
`)
chmodSync(refiner, 0o755)
const dictate = (url: string, body: unknown) =>
  fetch(url + '/api/dictate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('dictation: returns the raw transcript and the refined prompt, newlines kept', async () => {
  const h = startHub({ transcribeCmd: `${fake} 0 {in} {out}`, refineCmd: `${refiner} {in} {out}` })
  try {
    expect(await (await h.user('/api/config')).json()).toMatchObject({ dictation: true, refine: true })
    const f = await upload(h.hub.url)
    const r = await (await dictate(h.hub.url, { file: f.id })).json()
    expect(r).toEqual({ raw: 'Ship the meadow header with the next version.', refined: 'Ship the header with the next version.\n\n- Keep the meadow.', refine_status: 'done' })

    // Sent as text with the audio attached; the agent sees it as dictated.
    const m = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: r.refined, files: [f.id], dictation: { file: f.id, refined: true } }) })).json()
    expect(m.body.dictation).toEqual({ file: f.id, refined: true })
    const ev = await readSSE(await h.agent('/agent/stream'), e => e.some(x => x.data.id === m.id), 2000)
    const meta = buildMeta(ev.find(x => x.data.id === m.id)!.data)
    expect(meta.dictated).toBe('refined')
    expect(meta.raw_transcript_path).toEndWith('.m4a.transcript.txt')
  } finally { h.hub.stop() }
})

test('dictation: without a refiner it returns the transcript only; without a transcriber, 501', async () => {
  let h = startHub({ transcribeCmd: `${fake} 0 {in} {out}` })
  try {
    const f = await upload(h.hub.url)
    expect(await (await dictate(h.hub.url, { file: f.id })).json()).toMatchObject({ refined: null, refine_status: 'off' })
    expect((await dictate(h.hub.url, { file: 'nope' })).status).toBe(400)
  } finally { h.hub.stop() }
  h = startHub()
  try {
    const f = await upload(h.hub.url)
    expect((await dictate(h.hub.url, { file: f.id })).status).toBe(501)
  } finally { h.hub.stop() }
})
