// Bebop PWA. No framework: the server is the source of truth, the DOM
// is patched per message id, and only drafts and the outbox live locally.
import { marked } from './vendor/marked.js'
import DOMPurify from './vendor/purify.js'
import { S } from './strings.js'
import { parseAnsi, layoutScreen, spanCss, fleetCounts, findLinks, projectThread, newProjectThread, projectOfThread, validPeer, addressed, unaddressed } from './term.js'
import { parseDialog, keysFor, cardable } from './dialog.js'
import { postLimiter } from './limits.js'
import { markDataUrl, markParams, ORIGINAL_SEED } from './mark.js'

const $ = id => document.getElementById(id)
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'html') el.innerHTML = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid))
  return el
}

marked.setOptions({ gfm: true, breaks: true })
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer') }
})
const md = text => DOMPurify.sanitize(marked.parse(text ?? ''))
const mdInline = text => DOMPurify.sanitize(marked.parseInline(text ?? ''))
// A Copy button on each code block (titles, descriptions, commands to paste elsewhere).
function addCopyButtons(el) {
  for (const pre of el.querySelectorAll('pre')) {
    const btn = h('button', { type: 'button', class: 'code-copy' }, S.copy)
    btn.onclick = async e => {
      e.stopPropagation()
      try { await navigator.clipboard.writeText(pre.textContent.replace(/\n$/, '')) } catch { return toast(S.copyFailed) }
      btn.textContent = S.copied; btn.classList.add('done')
      clearTimeout(btn._t)
      btn._t = setTimeout(() => { btn.textContent = S.copy; btn.classList.remove('done') }, 1500)
    }
    pre.replaceWith(h('div', { class: 'code-wrap' }, pre.cloneNode(true), btn))
  }
  return el
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

const fine = matchMedia('(pointer: fine)').matches
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const EMOJIS = ['👍', '❤️', '😂', '👀', '✅', '❌']

// ---------- state ----------
const state = {
  thread: null,           // null = All
  home: null,             // wide layout: { kind: 'project', key } or { kind: 'needs' } in a column beside the conversation
  blank: false,           // that column has no topic to show, so the conversation is covered
  threads: [],
  projectIcons: {},       // lowercase project name -> icon url, for projects with no peer
  generalUnread: 0,
  msgs: new Map(),        // id -> message (current view)
  nodes: new Map(),       // id -> element
  oldest: 0, newest: 0, hasMore: true, loadingOlder: false,
  // false while reading a window in the middle of the history (after a search, a jump to a
  // date or to an old quote): newer pages load on scroll down, live messages wait in skipped.
  atLatest: true, loadingNewer: false, skipped: new Map(),
  replyTo: null,
  atts: [],
  newCount: 0,
  composing: false,
  viewerOpen: false,
  qstate: new Map(),
  outbox: store.get('outbox', []),
}

const list = $('list'), messagesEl = $('messages'), input = $('input')

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } })
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`); e.status = res.status
    e.body = await res.clone().json().catch(() => null)
    if (res.status === 401 && !path.startsWith('api/auth/')) showLock()
    throw e
  }
  return res.json()
}
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString()

// ---------- formatting ----------
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const dayKey = ts => new Date(ts).toDateString()
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`
const fileUrl = id => `files/${encodeURIComponent(id)}`
const plain = m => m.body?.text ?? m.body?.prompt ?? m.body?.transcript ?? (m.kind === 'voice' ? `🎙 ${S.voiceNote}` : null) ?? m.body?.questions?.map(q => q.prompt).join(' · ') ?? ''
const inView = m => m.kind !== 'answer' && m.kind !== 'reaction' && (state.thread == null || m.thread === state.thread)

// ---------- rendering ----------
function renderMarkdownBlock(text, long) {
  const block = addCopyButtons(h('div', { class: 'md', html: md(text) }))
  if (!long) return block
  block.classList.add('clamp')
  const btn = h('button', { class: 'toggle-more', type: 'button' }, S.showMore)
  btn.onclick = e => {
    e.stopPropagation()
    const open = block.classList.toggle('clamp')
    btn.textContent = open ? S.showMore : S.showLess
  }
  return h('div', {}, block, btn)
}
const isLong = t => (t?.length ?? 0) > 900 || (t?.split('\n').length ?? 0) > 14

function renderFiles(m) {
  const files = m.files ?? []
  const images = files.filter(f => f.mime.startsWith('image/'))
  const videos = files.filter(f => f.mime.startsWith('video/'))
  const audios = files.filter(f => f.mime.startsWith('audio/'))
  const others = files.filter(f => !/^(image|video|audio)\//.test(f.mime))
  const out = []
  if (images.length) {
    const n = images.length
    const grid = h('div', { class: `media ${n <= 4 ? 'n' + n : 'many'}` })
    images.forEach((f, i) => grid.append(h('button', { type: 'button', 'aria-label': f.name, onclick: e => { e.stopPropagation(); openViewer(images.map(x => x.id), i) } },
      h('img', { src: fileUrl(f.id), alt: f.name, loading: 'lazy', decoding: 'async' }))))
    out.push(grid)
  }
  // #t= makes iOS draw the first frame instead of a black box; the chip below saves or shares it.
  // The box starts at 16:9 (style.css) so a late poster doesn't push the list around; only a
  // video of another shape changes it, once, when its size is known.
  for (const f of videos) out.push(h('video', { src: `${fileUrl(f.id)}#t=0.1`, controls: true, preload: 'metadata', playsinline: true, onloadedmetadata: videoShape }), downloadChip(f, '🎬'))
  for (const f of audios) out.push(audioPlayer(fileUrl(f.id), 0, { title: f.name, id: m.id }), downloadChip(f, '🎧'))
  for (const f of others) {
    out.push(isText(f)
      ? h('button', { class: 'file-chip', type: 'button', onclick: e => { e.stopPropagation(); openDoc(f) } }, ...chipParts(f, '📄'))
      : downloadChip(f, '📄'))
  }
  return out
}
function videoShape(e) {
  const v = e.currentTarget, r = v.videoWidth / v.videoHeight
  if (r && Math.abs(r - 16 / 9) > 0.02) v.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`
}
const chipParts = (f, icon) => [h('span', {}, icon), h('span', { class: 'name' }, f.name), h('span', { class: 'size' }, fmtSize(f.size))]
const downloadChip = (f, icon) =>
  h('a', { class: 'file-chip', href: `${fileUrl(f.id)}?download`, download: f.name, onclick: e => { e.stopPropagation(); shareInstead(e, f) } }, ...chipParts(f, icon))

// ---------- document viewer (text attachments) ----------
const isMarkdown = f => /\.(md|markdown)$/i.test(f.name) || f.mime === 'text/markdown'
const isText = f => isMarkdown(f) || f.mime.startsWith('text/') || /json|yaml|toml/.test(f.mime) ||
  /\.(txt|log|csv|json|ya?ml|toml|swift|ts|js|py|sh)$/i.test(f.name)
let docToken = 0, docFile = null
async function openDoc(f) {
  const body = $('doc-body'), token = ++docToken
  docFile = null
  $('doc-title').textContent = f.name
  $('doc-sub').textContent = fmtSize(f.size)
  $('doc-download').href = `${fileUrl(f.id)}?download`
  $('doc-download').download = f.name
  $('doc-download').onclick = e => shareInstead(e, f, docFile)
  body.className = 'sheet-body doc-body'
  body.textContent = S.loading
  body.scrollTop = 0
  docSheet.show()
  try {
    const res = await fetch(fileUrl(f.id))
    if (!res.ok) throw new Error(res.status)
    const text = await res.text()
    if (token !== docToken) return
    docFile = new File([text], f.name, { type: f.mime || 'text/plain' })
    if (isMarkdown(f)) { body.classList.add('md'); body.innerHTML = md(text); addCopyButtons(body) }
    else body.replaceChildren(h('pre', { class: 'doc-plain' }, text))
  } catch {
    if (token === docToken) body.textContent = S.loadFailed
  }
}

// On a phone, Download opens the share sheet. A plain download navigates the
// standalone app to iOS's file preview, which has no way back.
const sharing = () => matchMedia('(pointer: coarse)').matches && !!navigator.canShare
async function shareInstead(e, f, ready) {
  if (!sharing()) return
  e.preventDefault()
  shareFiles(async () => [ready || await fetchFile(f)])
}
// Save from the action sheet: the share sheet on a phone (Save Image / Save to Files), a download elsewhere.
function saveFiles(fs) {
  if (sharing()) return shareFiles(() => Promise.all(fs.map(fetchFile)))
  for (const f of fs) h('a', { href: `${fileUrl(f.id)}?download`, download: f.name ?? '' }).click()
}
// Name and type come from the server when the caller only has an id (the image viewer).
async function fetchFile(f) {
  const res = await fetch(fileUrl(f.id))
  if (!res.ok) throw new Error(res.status)
  const cd = res.headers.get('content-disposition') ?? ''
  const name = f.name ?? decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? f.id)
  const blob = await res.blob()
  return new File([blob], name, { type: f.mime ?? blob.type })
}
async function shareFiles(load) {
  let files
  const share = () => navigator.share({ files }).catch(err => {
    // Fetching first can use up the tap's activation: one more tap, file in hand.
    if (err?.name === 'NotAllowedError') toast(S.shareReady, 6000, { label: S.share, run: () => { $('toast').hidden = true; share() } })
    else if (err?.name !== 'AbortError') toast(S.shareFailed)
  })
  try {
    files = (await load()).map(file => navigator.canShare({ files: [file] }) ? file : new File([file], file.name, { type: 'text/plain' }))
  } catch { return toast(S.shareFailed) }
  share()
}

// ---------- audio player (voice notes and audio files) ----------
const fmtDur = s => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>'
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>'
let playing = null // one audio at a time: { audio, total, title, id }, kept while paused so the now-playing bar stays
// The now-playing bar above the composer: the same audio, still in reach once its message scrolls away.
function paintNow() {
  const root = $('now-bar')
  if (!playing) { root.hidden = true; return }
  const { audio, total, title } = playing, t = total(), btn = $('now-play'), bar = $('now-seek')
  root.hidden = false
  $('now-title').textContent = title
  btn.innerHTML = audio.paused ? ICON_PLAY : ICON_PAUSE
  btn.setAttribute('aria-label', audio.paused ? S.play : S.pause)
  bar.value = String(t ? Math.round((audio.currentTime / t) * 1000) : 0)
  bar.style.setProperty('--p', `${Number(bar.value) / 10}%`)
  $('now-time').textContent = `${fmtDur(audio.currentTime)} / ${fmtDur(t)}`
}
function stopNow() { const p = playing; playing = null; p?.audio.pause(); paintNow() }
$('now-play').addEventListener('click', () => { if (!playing) return; if (playing.audio.paused) playing.audio.play().catch(() => {}); else playing.audio.pause() })
$('now-seek').addEventListener('input', e => { if (!playing) return; const t = playing.total(); if (t) playing.audio.currentTime = (Number(e.target.value) / 1000) * t; paintNow() })
$('now-title').addEventListener('click', () => { if (playing?.id) jumpTo(playing.id) })
$('now-close').addEventListener('click', stopNow)
function skipNow(by) {
  if (!playing) return
  const a = playing.audio, t = playing.total()
  a.currentTime = Math.max(0, t ? Math.min(t, a.currentTime + by) : a.currentTime + by)
  paintNow()
}
$('now-back').addEventListener('click', () => skipNow(-15))
$('now-forward').addEventListener('click', () => skipNow(15))
// Lock screen and headphones: the same 15 s skips.
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('seekbackward', () => skipNow(-15))
  navigator.mediaSession.setActionHandler('seekforward', () => skipNow(15))
}
function audioPlayer(src, knownDuration, info = {}) {
  const audio = h('audio', { src, preload: 'metadata' })
  const btn = h('button', { class: 'ap-play', type: 'button', 'aria-label': S.play, html: ICON_PLAY })
  const bar = h('input', { class: 'ap-bar', type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': S.seek })
  const time = h('span', { class: 'ap-time' }, fmtDur(knownDuration))
  // WebM from MediaRecorder often reports Infinity until fully read: fall back to the recorded length.
  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : knownDuration || 0)
  const paint = () => {
    const t = total()
    bar.value = String(t ? Math.round((audio.currentTime / t) * 1000) : 0)
    bar.style.setProperty('--p', `${Number(bar.value) / 10}%`)
    time.textContent = audio.paused && !audio.currentTime ? fmtDur(t) : fmtDur(audio.currentTime)
    if (playing === me) paintNow()
  }
  const me = { audio, total, title: info.title ?? S.audio, id: info.id }
  audio.addEventListener('loadedmetadata', paint)
  audio.addEventListener('timeupdate', paint)
  audio.addEventListener('play', () => { btn.innerHTML = ICON_PAUSE; btn.setAttribute('aria-label', S.pause); if (playing === me) paintNow() })
  audio.addEventListener('pause', () => { btn.innerHTML = ICON_PLAY; btn.setAttribute('aria-label', S.play); if (playing === me) paintNow() })
  audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); if (playing === me) stopNow() })
  btn.addEventListener('click', e => {
    e.stopPropagation()
    if (audio.paused) { if (playing && playing !== me) playing.audio.pause(); playing = me; paintNow(); audio.play().catch(() => {}) } else audio.pause()
  })
  bar.addEventListener('input', e => { e.stopPropagation(); const t = total(); if (t) audio.currentTime = (Number(bar.value) / 1000) * t; paint() })
  bar.addEventListener('click', e => e.stopPropagation())
  return h('div', { class: 'player' }, audio, btn, bar, time)
}

function renderVoice(m) {
  const b = m.body
  const f = m.files?.[0]
  const bubble = h('div', { class: 'bubble voice' }, quoteFor(m), f ? audioPlayer(fileUrl(f.id), b.duration, { title: S.voiceNote, id: m.id }) : h('div', { class: 'player ph' }, `🎙 ${fmtDur(b.duration)}`))
  const st = b.transcript_status
  if (st === 'pending') bubble.append(h('div', { class: 'transcript pending' }, h('span', { class: 'spinner', 'aria-hidden': true }), S.transcribing))
  else if (b.transcript) {
    const long = b.transcript.length > 180
    const t = h('div', { class: `transcript${long ? ' clamp3' : ''}`, title: S.transcript }, b.transcript)
    if (long) t.addEventListener('click', e => { e.stopPropagation(); t.classList.toggle('clamp3') })
    bubble.append(t)
  } else if (st === 'timeout' || st === 'failed') bubble.append(h('div', { class: 'transcript none' }, S.noTranscript))
  return bubble
}

function quoteFor(m) {
  if (!m.reply_preview) return null
  const p = m.reply_preview
  return h('button', { class: 'quote', type: 'button', onclick: e => { e.stopPropagation(); jumpTo(p.id) } },
    h('span', { class: 'quote-who' }, p.sender === 'user' ? S.you : document.title),
    h('span', { class: 'quote-text' }, plainPreview(p.text) || S.attachment))
}
// One line of a message for a quote: Markdown marks dropped, links reduced to their text.
function plainPreview(t = '') {
  return t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|`+|~~)/g, '').replace(/^\s*(#+|>|[-*]|\d+\.)\s+/gm, '').replace(/\s+/g, ' ').trim()
}

function renderReactions(m) {
  if (!m.reactions?.length) return null
  return h('div', { class: 'reactions' }, m.reactions.map(r => h('span', { class: `reaction${r.sender === 'user' ? ' mine' : ''}` }, r.emoji)))
}

function renderText(m) {
  // In a project conversation the @peer prefix is for the relay, not for reading.
  const text = m.sender === 'user' && projectOfThread(m.thread) ? unaddressed(m.body.text ?? '') : m.body.text
  return h('div', { class: 'bubble' }, quoteFor(m), renderFiles(m), text ? renderMarkdownBlock(text, isLong(text)) : null)
}

function collapseRuns(lines) {
  const out = []
  for (let i = 0; i < lines.length;) {
    const key = lines[i].split(/\s+/)[0]
    let j = i
    while (j < lines.length && lines[j].split(/\s+/)[0] === key) j++
    if (j - i >= 3) out.push(`${lines[j - 1]}  (×${j - i})`)
    else out.push(...lines.slice(i, j))
    i = j
  }
  return out
}

function renderProgress(m) {
  const lines = (m.body.text ?? '').split('\n').map(s => s.trim()).filter(Boolean)
  const done = !!m.body.done
  const lastUpdate = m.edited_at ?? m.ts
  const stalled = !done && Date.now() - lastUpdate > 10 * 60 * 1000
  const card = h('div', { class: `card progress${stalled ? ' stalled' : ''}` })
  if (!done) {
    const steps = collapseRuns(lines.slice(1)).slice(-4)
    card.append(
      h('div', { class: 'head' }, h('span', { class: 'spinner', 'aria-hidden': true }), h('span', { class: 'status' }, lines[0] ?? S.working),
        h('span', { class: 'elapsed', 'data-since': m.ts, title: stalled ? S.stalled : '' }, S.elapsed(Math.floor((Date.now() - m.ts) / 1000)))),
      steps.length ? h('ul', { class: 'steps' }, steps.map(s => h('li', {}, s))) : null,
    )
  } else {
    const secs = Math.max(0, Math.floor((lastUpdate - m.ts) / 1000))
    card.append(h('div', { class: 'head' }, h('span', { class: 'check' }, '✓'), h('span', { class: 'status' }, lines.at(-1) ?? S.done), h('span', { class: 'elapsed' }, S.elapsed(secs))))
    if (lines.length > 1) card.append(h('details', {}, h('summary', {}, S.steps(lines.length)), h('ul', { class: 'steps' }, lines.map(s => h('li', {}, s)))))
  }
  return card
}

function fmtAnswer(v) {
  if (Array.isArray(v)) return v.join(', ')
  if (v && typeof v.other === 'string') return `${S.other}: ${v.other}`
  return String(v)
}

function qState(m) {
  let st = state.qstate.get(m.id)
  if (!st) {
    st = { step: 0, sending: false, ans: {} }
    for (const q of m.body.questions) st.ans[q.id] = { sel: [], other: '', otherOn: false }
    state.qstate.set(m.id, st)
  }
  return st
}
const qValid = a => (a.sel.length > 0 && !(a.otherOn && !a.other.trim())) || (a.otherOn && !!a.other.trim())

function renderQuestion(m) {
  const qs = m.body.questions
  const card = h('div', { class: 'card question' })
  if (m.body.answered) {
    card.append(h('ul', { class: 'answers' }, qs.map(q => h('li', {}, h('span', { class: 'k' }, `${q.header ?? q.prompt}: `), fmtAnswer(m.body.answered[q.id])))),
      h('div', { class: 'answered-note' }, `✓ ${S.answered}`))
    return card
  }
  const st = qState(m)
  const rerender = () => replaceNode(m)
  if (qs.length > 1) {
    card.append(h('div', { class: 'card-chips' }, qs.map((q, i) => h('button', {
      type: 'button', class: `qchip${i === st.step ? ' current' : qValid(st.ans[q.id]) ? ' done' : ''}`,
      onclick: e => { e.stopPropagation(); st.step = i; rerender() },
    }, `${qValid(st.ans[q.id]) && i !== st.step ? '✓ ' : ''}${q.header ?? `${i + 1}`}`))))
  }
  const q = qs[st.step]
  const a = st.ans[q.id]
  const hasImages = q.options.some(o => o.image)
  card.append(h('p', { class: 'q-prompt md', html: mdInline(q.prompt) }))
  const opts = h('div', { class: `options${hasImages ? ' images' : ''}` })
  const pick = label => {
    if (q.multi) a.sel = a.sel.includes(label) ? a.sel.filter(x => x !== label) : [...a.sel, label]
    else { a.sel = [label]; a.otherOn = false }
    rerender()
  }
  for (const o of q.options) {
    const selected = a.sel.includes(o.label)
    const textBody = h('div', { class: 'body' },
      h('div', { class: 'label' }, o.label, o.recommended ? h('span', { class: 'tag' }, S.recommended) : null),
      o.description ? h('div', { class: 'desc' }, o.description) : null)
    const row = h('button', { type: 'button', class: `option${q.multi ? ' multi' : ''}${selected ? ' selected' : ''}`, 'aria-pressed': selected ? 'true' : 'false', onclick: e => { e.stopPropagation(); pick(o.label) } })
    if (o.image) {
      const imgs = q.options.filter(x => x.image).map(x => x.image)
      row.append(h('span', { class: 'opt-img', role: 'img', onclick: e => { e.stopPropagation(); openViewer(imgs, imgs.indexOf(o.image)) } }, h('img', { src: fileUrl(o.image), alt: o.label, loading: 'lazy' })),
        h('div', { class: 'head' }, h('span', { class: 'ind' }), textBody))
    } else row.append(h('span', { class: 'ind' }), textBody)
    opts.append(row)
  }
  const otherRow = h('button', { type: 'button', class: `option other${q.multi ? ' multi' : ''}${a.otherOn ? ' selected' : ''}`, onclick: e => {
    e.stopPropagation()
    a.otherOn = q.multi ? !a.otherOn : true
    if (!q.multi) a.sel = []
    rerender()
    if (a.otherOn) requestAnimationFrame(() => state.nodes.get(m.id)?.querySelector('.other-input')?.focus())
  } }, h('span', { class: 'ind' }), h('div', { class: 'body' }, h('div', { class: 'label' }, S.other)))
  opts.append(otherRow)
  card.append(opts)

  const isLast = st.step === qs.length - 1
  const btn = h('button', { type: 'button', class: 'primary' }, st.sending ? S.sending : isLast ? S.submit : S.next)
  const refreshBtn = () => { btn.disabled = st.sending || !qValid(a) }
  if (a.otherOn) {
    const other = h('input', { class: 'other-input', type: 'text', placeholder: S.otherPlaceholder, value: a.other, enterkeyhint: isLast ? 'send' : 'next' })
    other.addEventListener('input', () => { a.other = other.value; refreshBtn() })
    other.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
      e.preventDefault(); e.stopPropagation()
      if (!btn.disabled) btn.click()
    })
    other.addEventListener('click', e => e.stopPropagation())
    card.append(other)
  }
  btn.onclick = async e => {
    e.stopPropagation()
    if (!isLast) { st.step++; rerender(); return }
    const missing = qs.findIndex(x => !qValid(st.ans[x.id]))
    if (missing >= 0) { st.step = missing; rerender(); return }
    const answers = {}
    for (const x of qs) {
      const v = st.ans[x.id]
      const other = v.otherOn && v.other.trim()
      answers[x.id] = other ? (v.sel.length ? [...v.sel, `${S.other}: ${other}`] : { other }) : v.sel
    }
    st.sending = true; rerender()
    enqueue({ kind: 'answer', to: m.id, answers })
  }
  refreshBtn()
  card.append(h('div', { class: 'card-foot' }, btn))
  return card
}

function renderApproval(m) {
  const b = m.body
  const card = h('div', { class: 'card approval' }, h('div', { class: 'q-prompt md', html: mdInline(b.prompt) }), b.detail ? h('div', { class: 'detail md', html: md(b.detail) }) : null)
  if (b.answered) {
    card.append(h('div', { class: 'outcome' }, h('strong', {}, b.answered), b.answered_note ? ` · ${b.answered_note}` : ''))
    return card
  }
  const st = state.qstate.get(m.id) ?? {}
  card.append(h('div', { class: 'pills-row' }, b.options.map((label, i) => h('button', {
    type: 'button', class: `pill-btn${i === 0 ? ' primary-pill' : ''}`, disabled: !!st.sending,
    onclick: e => {
      e.stopPropagation()
      // Approvals need a fresh Face ID. stepUp() has to start inside this tap, so no await before it.
      const go = () => {
        state.qstate.set(m.id, { sending: true }); replaceNode(m)
        enqueue({ kind: 'answer', to: m.id, answers: { approval: [label] } })
      }
      if (!lockState.enabled) go()
      else stepUp().then(go, () => toast(S.stepupFailed))
      if (/^change/i.test(label)) { setReply(m); input.placeholder = S.changeHint; input.focus() }
    },
  }, label))))
  return card
}

function buildNode(m) {
  const el = h('div', { class: `msg ${m.sender}${m.kind !== 'text' ? ' wide' : ''}`, id: `m${m.id}`, 'data-id': m.id })
  const metaBits = []
  if (m.sender === 'agent' && m.source) metaBits.push(h('span', {}, S.via(m.source)))
  if (state.thread == null && m.thread) metaBits.push(h('button', { class: 'thread-tag', type: 'button', onclick: () => switchThread(m.thread) }, threadTitle(m.thread)))
  metaBits.push(h('span', {}, timeFmt.format(m.ts)))
  if (m.edited_at && m.kind === 'text') metaBits.push(h('span', {}, S.edited))
  el.append(h('div', { class: 'meta-line' }, metaBits))

  const content = m.kind === 'question' ? renderQuestion(m) : m.kind === 'approval' ? renderApproval(m) : m.kind === 'progress' ? renderProgress(m) : m.kind === 'voice' ? renderVoice(m) : renderText(m)
  const wrap = h('div', { class: 'bubble-wrap' }, content)
  if (!m.pending) {
    wrap.append(h('button', { class: 'more-btn', type: 'button', 'aria-label': 'More', onclick: e => { e.stopPropagation(); openSheet(m) } }, '⋯'))
    attachGestures(wrap, m)
  }
  el.append(wrap)
  const r = renderReactions(m)
  if (r) el.append(r)
  if (m.pending) {
    el.classList.add(m.failed ? 'failed' : 'pending')
    el.append(h('div', { class: 'status-line' }, m.failed ? h('button', { type: 'button', onclick: () => retryOutbox(m.client_id) }, S.notSent) : S.sending))
  }
  return el
}

function threadTitle(id) { return state.threads.find(t => t.id === id)?.title ?? id }

// A day header is also the date picker: a transparent native <input type="date"> lies
// over the label, so a tap opens the system picker (iOS opens it for a tap on the input
// itself; desktop browsers need showPicker()).
function daySep(ts) {
  const day = isoDay(new Date(ts))
  const pick = h('input', { type: 'date', class: 'day-pick', value: day, max: isoDay(new Date()), 'aria-label': S.pickDate, title: S.pickDate })
  pick.addEventListener('click', () => { try { pick.showPicker?.() } catch {} })
  pick.addEventListener('change', () => { if (pick.value && pick.value !== day) jumpToDate(pick.value) })
  return h('div', { class: 'day', 'data-day': dayKey(ts) }, h('span', { class: 'day-label' }, dayFmt.format(ts), pick))
}

function renderAll() {
  messagesEl.textContent = ''
  state.nodes.clear()
  let lastDay = null
  const sorted = [...state.msgs.values()].filter(inView).sort((a, b) => a.id - b.id)
  for (const m of sorted) {
    const d = dayKey(m.ts)
    if (d !== lastDay) { messagesEl.append(daySep(m.ts)); lastDay = d }
    const n = buildNode(m)
    state.nodes.set(m.id, n)
    messagesEl.append(n)
  }
  for (const p of pendingForView()) messagesEl.append(buildPending(p))
  $('empty').hidden = sorted.length > 0 || pendingForView().length > 0
  paintEmpty()
  updateWaiting()
}

// Older messages are prepended, not re-rendered: WebKit has no scroll anchoring,
// so we keep the reader's place by adding the height we inserted.
function prependOlder(older) {
  if (!older.length) return
  const frag = document.createDocumentFragment()
  let lastDay = null
  for (const m of older) {
    const d = dayKey(m.ts)
    if (d !== lastDay) { frag.append(daySep(m.ts)); lastDay = d }
    const n = buildNode(m)
    state.nodes.set(m.id, n)
    frag.append(n)
  }
  const before = list.scrollHeight // measure before any DOM change
  const first = messagesEl.firstElementChild
  if (first?.classList.contains('day') && first.dataset.day === lastDay) first.remove()
  messagesEl.prepend(frag)
  list.scrollTop += list.scrollHeight - before
  updateWaiting()
}

function replaceNode(m) {
  const old = state.nodes.get(m.id)
  if (!old) return
  const n = buildNode(m)
  old.replaceWith(n)
  state.nodes.set(m.id, n)
}

function insertNode(m) {
  if (!inView(m) || state.nodes.has(m.id)) return
  const stick = atBottom() || m.sender === 'user'
  const n = buildNode(m)
  state.nodes.set(m.id, n)
  const later = [...state.nodes.entries()].filter(([id]) => id > m.id).sort((a, b) => a[0] - b[0])[0]
  if (later) {
    later[1].before(n)
  } else {
    const lastMsg = [...messagesEl.querySelectorAll('.msg:not(.pending):not(.failed)')].at(-1)
    const lastTs = lastMsg ? state.msgs.get(Number(lastMsg.dataset.id))?.ts : null
    const firstPending = messagesEl.querySelector('.msg.pending, .msg.failed')
    const anchor = firstPending ?? null
    if (!lastTs || dayKey(lastTs) !== dayKey(m.ts)) anchor ? anchor.before(daySep(m.ts)) : messagesEl.append(daySep(m.ts))
    anchor ? anchor.before(n) : messagesEl.append(n)
  }
  $('empty').hidden = true
  state.newest = Math.max(state.newest, m.id)
  if (stick) scrollToBottom()
  else if (m.sender === 'agent') { state.newCount++; updateNewPill() }
  updateWaiting()
}

function upsert(m) {
  if (!inView(m)) return
  const had = state.msgs.has(m.id)
  if (!had && !state.atLatest && m.id > state.newest) {
    // Reading older history: the gap below isn't loaded, so don't attach this to the window.
    if (!state.skipped.has(m.id) && m.sender === 'agent') { state.newCount++; updateNewPill() }
    state.skipped.set(m.id, m)
    return
  }
  state.msgs.set(m.id, m)
  if (had) {
    const st = state.qstate.get(m.id)
    if (st && (m.body.answered != null)) state.qstate.delete(m.id)
    replaceNode(m)
    updateWaiting()
  } else if (m.id > state.oldest || !state.hasMore) {
    insertNode(m)
  }
}

// ---------- scrolling ----------
const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80
function scrollToBottom() { requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; state.newCount = 0; updateNewPill(); markRead() }) }
function updateNewPill() {
  const p = $('new-pill')
  p.hidden = state.atLatest && state.newCount === 0
  p.textContent = state.newCount ? S.newBelow(state.newCount) : S.jumpLatest
}
$('new-pill').onclick = async () => {
  if (state.atLatest) return scrollToBottom()
  await loadLatest()
  scrollToBottom()
}

// Scrolls to a message and flashes it. One that isn't loaded opens a window around it.
async function jumpTo(id, { smooth = true } = {}) {
  if (panes.open && wide.matches) closePanes()
  if (state.blank) closeHome()
  let n = state.nodes.get(id)
  if (!n) {
    try { await openAt({ around: id }) } catch { return }
    n = state.nodes.get(id)
    smooth = false
  }
  if (!n) return
  n.scrollIntoView({ block: 'center', behavior: smooth && !reducedMotion.matches ? 'smooth' : 'auto' })
  n.classList.remove('flash')
  void n.offsetWidth // restart the animation if it is already flashing
  n.classList.add('flash')
  setTimeout(() => n.classList.remove('flash'), 2200)
}

function updateWaiting() {
  const waiting = [...state.msgs.values()].filter(m => inView(m) && m.sender === 'agent' && (m.kind === 'question' || m.kind === 'approval') && m.body.answered == null).sort((a, b) => a.id - b.id)
  const p = $('waiting-pill')
  p.hidden = waiting.length === 0
  p.textContent = S.waiting(waiting.length)
  p.onclick = () => waiting[0] && jumpTo(waiting[0].id)
}

// Stay pinned to the bottom while late content (images, video posters) grows the list.
let pinned = true
// Observing the list too keeps the last message in view when the keyboard shrinks it.
const pin = new ResizeObserver(() => { if (pinned) list.scrollTop = list.scrollHeight })
pin.observe(messagesEl)
pin.observe(list)
pin.observe($('typing'))
list.addEventListener('scroll', () => {
  pinned = state.atLatest && atBottom()
  if (list.scrollTop < 1200) loadOlder() // early, so the prepend lands well above what the reader sees
  if (!state.atLatest) { if (list.scrollHeight - list.scrollTop - list.clientHeight < 1200) loadNewer(); return }
  if (atBottom()) { if (state.newCount) { state.newCount = 0; updateNewPill() } markRead() }
}, { passive: true })

// ---------- loading ----------
async function loadLatest() {
  const page = await api(`api/messages?${qs({ thread: state.thread, limit: 50 })}`)
  // Anything that arrived live while the page was in flight is newer than the page: keep it.
  const top = page[0]?.id ?? 0
  const live = [...state.msgs.values(), ...state.skipped.values()].filter(m => m.id > top && inView(m))
  state.msgs.clear()
  state.skipped.clear()
  for (const m of [...page, ...live]) state.msgs.set(m.id, m)
  state.oldest = page.length ? page.at(-1).id : 0
  state.newest = Math.max(top, ...live.map(m => m.id))
  state.hasMore = page.length === 50
  state.atLatest = true
  state.newCount = 0
  updateNewPill()
  renderAll()
  pinned = true
  list.scrollTop = list.scrollHeight
  markRead()
}

/** Opens a window in the middle of the history: { around: id } or { date, tz }. */
async function openAt(params) {
  const page = await api(`api/messages?${qs({ thread: state.thread, limit: 50, ...params })}`)
  state.msgs.clear()
  state.skipped.clear()
  for (const m of page) state.msgs.set(m.id, m)
  state.oldest = page.length ? page.at(-1).id : 0
  state.newest = page.length ? page[0].id : 0
  state.hasMore = true // loadOlder finds out
  state.atLatest = false
  state.newCount = 0
  pinned = false
  renderAll()
  updateNewPill()
  void loadNewer() // if the window already reaches the newest message, this says so
  return page
}

async function loadNewer() {
  if (state.loadingNewer || state.atLatest) return
  state.loadingNewer = true
  $('newer').textContent = S.loadingOlder
  try {
    const page = await api(`api/messages?${qs({ thread: state.thread, after: state.newest, limit: 50 })}`)
    const asc = page.reverse().filter(m => !state.msgs.has(m.id))
    for (const m of asc) { state.msgs.set(m.id, m); state.skipped.delete(m.id) }
    if (page.length) state.newest = Math.max(state.newest, page.at(-1).id)
    appendNewer(asc.filter(inView))
    if (page.length < 50) {
      // Caught up: from here on live messages attach as usual. Ones that came in while the
      // last page was in flight are in skipped.
      state.atLatest = true
      const late = [...state.skipped.values()].filter(m => m.id > state.newest).sort((a, b) => a.id - b.id)
      state.skipped.clear()
      for (const m of late) upsert(m)
      state.newCount = 0
      updateNewPill()
    }
  } catch {} finally {
    state.loadingNewer = false
    $('newer').textContent = ''
  }
}

// Newer messages are appended under the window; that never moves what the reader sees.
function appendNewer(newer) {
  if (!newer.length) return
  const anchor = messagesEl.querySelector('.msg.pending, .msg.failed')
  const lastMsg = [...messagesEl.querySelectorAll('.msg:not(.pending):not(.failed)')].at(-1)
  let lastDay = lastMsg ? dayKey(state.msgs.get(Number(lastMsg.dataset.id))?.ts ?? 0) : null
  const frag = document.createDocumentFragment()
  for (const m of newer) {
    const d = dayKey(m.ts)
    if (d !== lastDay) { frag.append(daySep(m.ts)); lastDay = d }
    const n = buildNode(m)
    state.nodes.set(m.id, n)
    frag.append(n)
  }
  anchor ? anchor.before(frag) : messagesEl.append(frag)
  $('empty').hidden = true
  updateWaiting()
}

// Opens the current view at the first message of a day (YYYY-MM-DD, local time), with that
// day's header at the top.
async function jumpToDate(day) {
  const [y, mo, d] = day.split('-').map(Number)
  const start = new Date(y, mo - 1, d)
  let page
  try { page = await openAt({ date: day, tz: start.getTimezoneOffset() }) } catch { return toast(S.notSent.split(' · ')[0]) }
  const shown = page.filter(inView).sort((a, b) => a.id - b.id)
  const first = shown.find(m => m.ts >= start.getTime()) ?? shown.at(-1)
  if (!first) return
  if (dayKey(first.ts) !== start.toDateString()) toast(S.noneThatDay(dayFmt.format(start)), 3500)
  const sep = messagesEl.querySelector(`.day[data-day="${CSS.escape(dayKey(first.ts))}"]`)
  ;(sep ?? state.nodes.get(first.id))?.scrollIntoView({ block: 'start' })
}

async function loadOlder() {
  if (state.loadingOlder || !state.hasMore || !state.oldest) return
  state.loadingOlder = true
  $('older').textContent = S.loadingOlder
  try {
    const page = await api(`api/messages?${qs({ thread: state.thread, before: state.oldest, limit: 50 })}`)
    for (const m of page) state.msgs.set(m.id, m)
    if (page.length) state.oldest = page.at(-1).id
    state.hasMore = page.length === 50
    prependOlder(page.filter(inView).reverse())
  } catch {} finally {
    state.loadingOlder = false
    $('older').textContent = ''
  }
}

/** After a resume: fetch everything newer than what we have, and refresh the recent window for edits/answers. */
async function catchUp() {
  try {
    if (!state.atLatest) { // reading the middle: the window stays; newer pages load on scroll
      await loadThreads(); await loadLists(); await loadPresence()
      return
    }
    let after = state.newest
    for (let i = 0; i < 10; i++) {
      const page = await api(`api/messages?${qs({ thread: state.thread, after, limit: 200 })}`)
      for (const m of page.reverse()) upsert(m)
      if (page.length < 200) break
      after = page.at(-1).id
    }
    const recent = await api(`api/messages?${qs({ thread: state.thread, limit: 50 })}`)
    for (const m of recent) upsert(m)
    await loadThreads()
    await loadLists()
    await loadPresence()
  } catch {}
}

// ---------- threads ----------
async function loadThreads() {
  try {
    const t = await api('api/threads')
    setThreads(t)
  } catch {}
}
function setThreads(t) {
  state.threads = t.threads
  for (const x of state.threads) if (x.title === x.id && projectOfThread(x.id)) x.title = S.projectChat
  state.generalUnread = t.general_unread
  state.projectIcons = t.projects ?? state.projectIcons
  renderThreads()
  retryBlank()
  // The selected topic was archived, here or from elsewhere: on to the next, or the session.
  if (state.home && wide.matches && !panes.open && isArchived(curTopic()) && !inHome(state.thread)) openHome(state.home)
}
const isArchived = t => t?.state === 'archived'
const openTopics = () => state.threads.filter(t => !isArchived(t))
const ICON_BOARD = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="12" rx="1.8" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="m7.5 13 3-3.2 2.4 2.2 3.6-3.8M9 20l3-3.5 3 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
const ICON_ARCHIVE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3.5" y="5" width="17" height="4.5" rx="1.2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5.5 9.5V18a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V9.5M10 13.5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>'
// Threads with no open task sit under Other, collapsed by default.
const COLLAPSED_KEY = 'topics-collapsed'
state.collapsed = (() => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '["other"]')) } catch { return new Set(['other']) } })()
function toggleLane(lane) {
  if (!state.collapsed.delete(lane)) state.collapsed.add(lane)
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsed])) } catch {}
  renderNav()
}
// A topic can have a task but no messages: show the task's next step and recent log instead.
function paintEmpty() {
  const el = $('empty'), t = state.threads.find(x => x.id === state.thread)
  const known = t && (t.detail || t.history?.length)
  el.classList.toggle('task', !!known)
  const key = projectOfThread(state.thread)
  if (!known) return el.textContent = key ? S.startPeer(sessionPeer(key) ?? $('app').dataset.name) : S.empty
  el.replaceChildren(
    h('h2', {}, t.title),
    t.detail ? h('p', {}, h('strong', {}, S.taskNext), t.detail) : null,
    t.history?.length ? h('ul', {}, ...t.history.map(line => h('li', {}, line))) : null,
    h('p', { class: 'empty-note' }, S.taskNoMessages))
}
// ---------- status and projects ----------
// One scale everywhere: red = you need to act, amber = someone else has it, green = moving,
// quiet (an empty circle) = nothing happening. Offline sessions are quiet too, with the icon dimmed.
const DOT_RANK = { red: 0, amber: 1, green: 2, quiet: 3 }
const worstDot = dots => dots.reduce((a, b) => DOT_RANK[b] < DOT_RANK[a] ? b : a, 'quiet')
const dotEl = (cls, title, live) => h('span', { class: `state-dot ${cls}${live ? ' live' : ''}`, title })
const topicDotEl = t => { const { dot, live } = topicState(t); return dotEl(dot, undefined, live) }
const isOffline = st => String(st ?? '').toLowerCase() === 'offline'
const TOPIC_DOT = { you: 'red', others: 'amber', mine: 'green' }
// The one rule for all three levels. A topic: its lane's dot, but a live topic is green unless
// it's red, which stays red. The chat shows the same live set; a project takes the worst of its
// topics and pulses only if that came out green with a live topic.
const presenceOn = (p = state.presence) => p.state !== 'idle' && Date.now() - p.updated < 10 * 60 * 1000
function liveThreads({ presence = true, waiting = true } = {}) {
  const live = new Map() // thread id (null = main chat) -> what it's doing
  for (const t of state.tasks) if (t.thread && (t.state === 'running' || (waiting && t.state === 'waiting'))) live.set(t.thread, t.detail || t.title)
  if (presence && presenceOn()) live.set(state.presence.thread ?? null, presenceText(state.presence))
  return live
}
function topicState(t) {
  const base = TOPIC_DOT[t.lane] ?? 'quiet', live = liveThreads().has(t.id)
  return { dot: live && base !== 'red' ? 'green' : base, live }
}
const topicDot = t => topicState(t).dot
const byDot = (a, b) => DOT_RANK[topicDot(a)] - DOT_RANK[topicDot(b)] || (b.unread > 0) - (a.unread > 0) || b.updated - a.updated
const projectKey = name => (name ?? '').toLowerCase()
const wide = matchMedia('(min-width: 900px)')
const selfName = () => $('app').dataset.name?.toLowerCase()

// A project's sessions: its live panes, or the peers published for it when it has none.
function sessionsOf(key) {
  const live = panes.list.filter(p => projectKey(p.project) === key)
    .map(p => ({ pane: p.id, state: p.status, detail: p.title }))
  if (live.length) return live
  return state.peers.filter(p => projectKey(p.project) === key)
    .map(p => ({ pane: null, state: p.state, detail: p.detail || p.name }))
}
// Every project with an open topic, a peer or a live pane, most urgent first.
function projectList() {
  const seen = new Map()
  const add = (name, icon) => {
    const key = projectKey(name)
    if (!key || key === selfName()) return
    if (!seen.has(key)) seen.set(key, { key, name: S.projectName(name), icon: state.projectIcons[key] ?? null, topics: [] })
    if (icon) seen.get(key).icon = icon
  }
  for (const p of state.peers) add(p.project, p.icon)
  for (const p of panes.list) add(p.project)
  for (const t of openTopics()) if (t.project) { add(t.project); seen.get(projectKey(t.project))?.topics.push(t) }
  for (const p of seen.values()) {
    p.sessions = sessionsOf(p.key)
    p.topics.sort(byDot)
    p.red = p.topics.filter(t => topicDot(t) === 'red').length
    p.dot = worstDot([...p.topics.map(topicDot), ...p.sessions.map(x => stateClass(x.state))])
    p.live = p.dot === 'green' && p.topics.some(t => topicState(t).live)
    p.offline = p.sessions.length > 0 && p.sessions.every(x => isOffline(x.state))
    p.unread = p.topics.some(t => t.unread > 0)
  }
  return [...seen.values()].sort((a, b) => DOT_RANK[a.dot] - DOT_RANK[b.dot] || a.name.localeCompare(b.name))
}
function blockedSessions() {
  return panes.list.filter(p => stateClass(p.status) === 'red')
    .map(p => ({ pane: p.id, state: p.status, detail: [S.projectName(p.project ?? p.agent), p.title].join(' · ') }))
}
// The peer a project conversation is addressed to: its first live session. The peers list can
// lag behind herdr, so an "offline" peer still counts while the project has a live pane.
function sessionPeer(key) {
  if (!key) return null
  const mine = state.peers.filter(p => projectKey(p.project) === key && validPeer(p.name))
  const live = mine.find(p => !isOffline(p.state)) ?? (panes.list.some(p => projectKey(p.project) === key) ? mine[0] : null)
  return live?.name ?? null
}
const needsTopics = () => openTopics().filter(t => topicDot(t) === 'red').sort(byDot)
const needsCount = () => needsTopics().length + blockedSessions().length

function projectIcon(p, cls = 'proj-icon') {
  // A project without an icon of its own gets the mark made from its name (web/mark.js).
  const fallback = () => h('img', { class: `${cls} proj-made`, src: markDataUrl(p.name ?? '?'), alt: '' })
  const img = p.icon ? h('img', { class: cls, src: p.icon, alt: '', loading: 'lazy' }) : null
  if (img) img.onerror = () => img.replaceWith(fallback())
  const el = img ?? fallback()
  if (p.offline) el.classList.add('offline')
  return el
}
const projectRow = (p, onclick, current) => h('button', { type: 'button', class: `proj${current ? ' current' : ''}${p.unread ? ' unread' : ''}`, 'aria-current': current ? 'true' : null, onclick },
  projectIcon(p), h('span', { class: 'proj-name' }, p.name), p.red ? h('span', { class: 'proj-n' }, String(p.red)) : null, dotEl(p.dot, undefined, p.live))
// Hover reveals when a topic last spoke and an archive button. Touch screens keep the context bar's.
function topicHover(t) {
  return h('span', { class: 'topic-hover' }, t.last ? h('time', { class: 'topic-time', title: new Date(t.last).toLocaleString() }, S.topicTime(t.last)) : null,
    h('button', { type: 'button', class: 'topic-archive', title: S.archive, 'aria-label': S.archive, html: ICON_ARCHIVE, onclick: () => setArchived(t, true) }))
}
const plainRow = (t, pick) => h('div', { class: 'topic-row' },
  h('button', { type: 'button', class: `proj plain${state.thread === t.id && !state.home ? ' current' : ''}${t.unread > 0 ? ' unread' : ''}`, onclick: () => pick(t.id) },
    h('span', { class: 'proj-name' }, t.title), topicDotEl(t)),
  topicHover(t))
// Below the projects: topics with no project, then threads with no task, then the archive.
function looseRows(pick) {
  const loose = openTopics().filter(t => !t.project)
  const tasks = loose.filter(t => t.lane).sort(byDot), rest = loose.filter(t => !t.lane).sort(byDot)
  const parts = []
  if (tasks.length) parts.push(h('div', { class: 'lane-group' }, h('div', { class: 'lane' }, S.noProject), ...tasks.map(t => plainRow(t, pick))))
  if (rest.length) {
    const closed = state.collapsed.has('other')
    const shown = closed ? rest.filter(t => t.unread > 0 || t.id === state.thread) : rest
    parts.push(h('div', { class: 'lane-group' },
      h('button', { type: 'button', class: 'lane', 'aria-expanded': String(!closed), onclick: () => toggleLane('other') },
        h('span', { class: 'lane-caret', 'aria-hidden': 'true' }, closed ? '▸' : '▾'), S.otherTopics, h('span', { class: 'lane-n' }, String(rest.length))),
      ...shown.map(t => plainRow(t, pick))))
  }
  const cur = state.threads.find(t => t.id === state.thread)
  if (isArchived(cur)) parts.push(plainRow(cur, pick))
  const archived = state.threads.filter(isArchived)
  if (archived.length) parts.push(h('button', { type: 'button', class: 'lane plain', onclick: openArchived }, S.archivedN(archived.length)))
  return parts
}
// The agent's row carries the global status on wide windows: what it's doing or what went wrong on
// a second line (the row keeps its height, so the list below doesn't move) and the background
// tasks' count, a button of its own beside the row's.
function agentRow(name, current, unread) {
  const line = agentLine(), n = activeTasks()
  return h('div', { class: 'agent-row' },
    h('button', { type: 'button', class: `proj agent-chat${current ? ' current' : ''}${unread ? ' unread' : ''}${n ? ' counted' : ''}`, 'aria-current': current ? 'true' : null, onclick: () => switchThread(null) },
      projectIcon({ name, icon: 'icons/icon-192.png' }),
      h('span', { class: 'proj-stack' }, h('span', { class: 'proj-name' }, name), line ? h('span', { class: 'proj-line', title: line }, line) : null),
      dotEl(agentDot())),
    n ? h('button', { type: 'button', class: `agent-tasks${state.tasks.some(x => x.state === 'running') ? ' running' : ''}`, title: S.tasksLabel(n.active, n.running), 'aria-label': S.tasksLabel(n.active, n.running), 'aria-haspopup': 'dialog', onclick: openTasks }, String(n.active)) : null)
}
const ICON_TERMINAL = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
// An agent session's mark: a neutral sparkle (not any vendor's logo, so Bebop ships it);
// one per agent later (codex, pi…). >_ is kept for plain terminals.
const ICON_AGENT = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path d="M11 3.5c.7 4.6 2.9 6.8 7.5 7.5-4.6.7-6.8 2.9-7.5 7.5-.7-4.6-2.9-6.8-7.5-7.5 4.6-.7 6.8-2.9 7.5-7.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/><path d="M18.5 3v3.5M16.75 4.75h3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>'
const AGENT_MARKS = {} // e.g. { codex: '<svg…>' }
// On a terminal, the >_ slot closes it: the same frame with an × for the prompt.
const ICON_TERMINAL_CLOSE = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="m9.5 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>'
const agentMark = agent => agent === 'shell' ? ICON_TERMINAL : AGENT_MARKS[agent] ?? ICON_AGENT
const markEl = (agent, cls = 'agent-mark') => h('span', { class: cls, title: agent === 'shell' ? S.terminal : agent, html: agentMark(agent) })
function sessionsRow() {
  const cur = state.home?.kind === 'sessions', n = panes.list.filter(p => p.status === 'working').length
  return h('button', { type: 'button', class: `proj${cur ? ' current' : ''}`, 'aria-current': cur ? 'true' : null, onclick: () => openHome({ kind: 'sessions' }) },
    h('span', { class: 'proj-icon proj-slot', html: ICON_AGENT }), h('span', { class: 'proj-name' }, S.sessions), n ? h('span', { class: 'proj-n' }, String(n)) : null,
    dotEl(worstDot(panes.list.map(p => stateClass(p.status)))))
}
const byPaneDot = (a, b) => DOT_RANK[stateClass(a.status)] - DOT_RANK[stateClass(b.status)]
function sessionItem(p) {
  const cur = panes.open && panes.id === p.id
  return h('button', { type: 'button', class: `sess sess-row sess-item${cur ? ' current' : ''}`, 'aria-current': cur ? 'true' : null, onclick: () => selectSession(p.id) },
    projectIcon(paneIcon(p)),
    h('div', { class: 'sess-main' }, h('div', {}, p.title), h('small', {}, [p.project, S.paneStatus(p.status)].filter(Boolean).join(' · '))),
    dotEl(stateClass(p.status), p.status))
}
const sameView = (a, b) => a?.kind === b?.kind && a?.key === b?.key
const curTopic = () => state.threads.find(t => t.id === state.thread)
function renderSide() {
  const allUnread = state.generalUnread + state.threads.reduce((s, t) => s + t.unread, 0)
  const onAgent = !state.home && state.thread == null, needs = state.home?.kind === 'needs', n = needsCount()
  const name = $('app').dataset.name
  $('side-pins').replaceChildren(...[
    agentRow(name, onAgent, allUnread > 0 && !onAgent),
    h('button', { type: 'button', class: `proj${needs ? ' current' : ''}`, 'aria-current': needs ? 'true' : null, onclick: () => openHome({ kind: 'needs' }) },
      h('span', { class: 'proj-icon proj-slot' }, dotEl(n ? 'red' : 'quiet')), h('span', { class: 'proj-name' }, S.needsYou), n ? h('span', { class: 'proj-n' }, String(n)) : null),
    panes.on ? sessionsRow() : null].filter(Boolean))
  const inThread = !state.home && curTopic()?.project ? projectKey(curTopic().project) : null
  const list = projectList()
  const el = $('side-topics'), top = el.scrollTop
  el.replaceChildren(...(list.length ? [h('div', { class: 'lane-group' }, h('div', { class: 'lane' }, S.projects),
    ...list.map(p => projectRow(p, () => openHome({ kind: 'project', key: p.key }), state.home?.key === p.key || inThread === p.key)))] : []),
    ...looseRows(switchThread))
  el.scrollTop = top
}
// "My App: rethink layout" reads as "Rethink layout" under My App's own heading.
function shortTitle(title, p) {
  if (!p) return title
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rest = title.replace(new RegExp(`^(${esc(p.name)}|${esc(p.key)})(: *| · | +)`, 'i'), '')
  return rest ? rest[0].toUpperCase() + rest.slice(1) : title
}
function sessionCard(x, go, column) {
  const dot = dotEl(stateClass(x.state)), can = x.pane != null && panes.on
  const agent = x.pane != null ? panes.list.find(p => p.id === x.pane)?.agent : null
  const main = h('div', { class: `sess-main${isOffline(x.state) ? ' offline' : ''}` }, h('div', { class: 'sess-line' }, agent ? markEl(agent) : null, S.sessionLine(x.state)), x.detail ? h('small', {}, x.detail) : null)
  // Beside the conversation a session is selected like a topic; in the sheet it opens full screen.
  if (column && can) {
    const cur = panes.open && panes.id === x.pane
    return h('button', { type: 'button', class: `sess sess-row${cur ? ' current' : ''}`, 'aria-current': cur ? 'true' : null, onclick: () => go(x.pane) }, dot, main)
  }
  return h('div', { class: 'sess' }, dot, main, can && !column ? h('button', { type: 'button', class: 'sess-term', onclick: () => go(x.pane) }, S.openSession) : null)
}
function topicItem(t, p, pick, column) {
  const cur = column && t.id === state.thread && !panes.open
  return h('div', { class: 'topic-row' },
    h('button', { type: 'button', class: `home-topic${t.unread > 0 ? ' unread' : ''}${cur ? ' current' : ''}`, 'aria-current': cur ? 'true' : null, onclick: () => pick(t.id) }, topicDotEl(t),
      h('span', { class: 'home-topic-main' }, h('span', { class: 'home-topic-title' }, shortTitle(t.title, p)), t.detail ? h('span', { class: 'home-topic-next' }, t.detail) : null)),
    topicHover(t))
}
// Always a way to talk to the session, topics or not. Each pick is a fresh conversation until
// something is sent in it; the project's first one keeps the plain id.
function newConversationRow(key, pick) {
  const known = id => state.threads.some(t => t.id === id)
  const cur = projectOfThread(state.thread) === key && !known(state.thread) && !panes.open
  const id = cur ? state.thread : known(projectThread(key)) ? newProjectThread(key) : projectThread(key)
  return h('button', { type: 'button', class: `home-new${cur ? ' current' : ''}`, 'aria-current': cur ? 'true' : null, onclick: () => pick(id) }, S.newConversation)
}
// A view's open topics in sort order. Archived ones are never here, so they can't be picked.
const viewTopics = view => view.kind === 'sessions' ? [] : view.kind === 'needs' ? needsTopics() : openTopics().filter(t => projectKey(t.project) === view.key).sort(byDot)
// A project's column, or Needs you: the same contents beside the conversation and in the sheet.
function homeNodes(view, pick, term, column = false) {
  if (view.kind === 'sessions') {
    const all = [...panes.list].sort(byPaneDot)
    return [h('div', { class: 'home-head' }, h('h2', {}, S.sessions), shareButton()), ...all.map(sessionItem), all.length ? null : h('p', { class: 'home-empty' }, S.noPanes)].filter(Boolean)
  }
  const p = view.kind === 'project' ? projectList().find(x => x.key === view.key) : null
  const name = p?.name ?? (view.kind === 'needs' ? S.needsYou : S.projectName(view.key ?? ''))
  const sessions = view.kind === 'needs' ? blockedSessions() : p?.sessions ?? sessionsOf(view.key)
  const topics = view.kind === 'needs' ? needsTopics() : p?.topics ?? []
  return [
    h('div', { class: 'home-head' }, view.kind === 'needs' ? h('span', { class: 'home-icon proj-slot' }, dotEl('red')) : projectIcon(p ?? { name }, 'home-icon'), h('h2', {}, name),
      view.kind === 'project' ? projectToolButtons(view.key, name) : null),
    ...sessions.map(x => sessionCard(x, term, column)),
    h('div', { class: 'home-topics' }, ...topics.map(t => topicItem(t, p, pick, column))),
    column && view.kind === 'project' ? newConversationRow(view.key, pick) : null,
    !column && !sessions.length && !topics.length ? h('p', { class: 'home-empty' }, view.kind === 'needs' ? S.needsEmpty : S.projectEmpty) : null,
  ].filter(Boolean)
}
function renderHome() {
  if (!state.home) return
  const el = $('home'), top = el.scrollTop
  el.replaceChildren(...homeNodes(state.home, switchThread, selectSession, true))
  el.scrollTop = top
}
function setHome(view) {
  state.home = view
  $('home').hidden = !view
  $('app').classList.toggle('home-on', !!view)
  const u = new URL(location.href)
  u.searchParams.delete('project'); u.searchParams.delete('view')
  if (view?.kind === 'project') u.searchParams.set('project', view.key)
  if (view?.kind === 'needs' || view?.kind === 'sessions') u.searchParams.set('view', view.kind)
  history.replaceState(null, '', u)
}
function setBlank(on) {
  state.blank = on
  $('home-blank').hidden = !on
  $('home-blank').textContent = on ? ({ sessions: S.noPanes }[state.home?.kind] ?? S.pickNothing) : ''
  $('app').classList.toggle('blank', on)
}
// The topic last read in each view, while it is still open there.
const LAST_TOPIC_KEY = 'project-topic'
const LAST_CHAT_KEY = 'project-chat', LAST_PANE_KEY = 'project-pane' // one each, for the header's terminal toggle
const viewKey = view => view.kind === 'project' ? view.key : `*${view.kind}`
const remember = (map, view, id) => store.set(map, { ...store.get(map, {}), [viewKey(view)]: id })
function rememberTopic(view, id) {
  remember(LAST_TOPIC_KEY, view, id)
  if (id.startsWith('pane:')) remember(LAST_PANE_KEY, view, id.slice(5))
  else remember(LAST_CHAT_KEY, view, id)
}
function firstTopic(view) {
  const topics = viewTopics(view), last = store.get(LAST_TOPIC_KEY, {})[viewKey(view)]
  return (topics.find(t => t.id === last) ?? topics[0])?.id ?? null
}
const paneInView = (view, id) => panes.list.some(p => p.id === id && (view.kind === 'sessions' || (view.kind === 'needs' ? p.status === 'blocked' : projectKey(p.project) === view.key)))
// What a view opens on: its remembered session if it's still there, its remembered or first
// topic, a conversation with its session, or, with no peer to talk to, its terminal.
function homePick(view) {
  const last = store.get(LAST_TOPIC_KEY, {})[viewKey(view)]
  if (typeof last === 'string' && last.startsWith('pane:') && paneInView(view, last.slice(5))) return last
  if (view.kind === 'sessions') { const first = [...panes.list].sort(byPaneDot)[0]; return first ? `pane:${first.id}` : null }
  const id = firstTopic(view)
  if (id != null || view.kind !== 'project') return id
  if (sessionPeer(view.key)) return projectThread(view.key)
  const pane = panes.list.find(p => projectKey(p.project) === view.key)
  return pane ? `pane:${pane.id}` : projectThread(view.key)
}
const inHome = id => id != null && !!state.home && (viewTopics(state.home).some(t => t.id === id) || (state.home.kind === 'project' && projectOfThread(id) === state.home.key))
// A blank view fills in once there is something to show (peers and panes load after threads).
function retryBlank() { if (state.blank && homePick(state.home) != null) openHome(state.home) }
function openHome(view) {
  if (!wide.matches) return openTopicsSheet(view)
  setHome(view)
  $('home').scrollTop = 0
  const id = homePick(view)
  if (id?.startsWith('pane:')) {
    setBlank(false)
    if (panes.id !== id.slice(5)) showPane(id.slice(5))
    return renderThreads()
  }
  if (panes.open) closePanes()
  setBlank(id == null)
  if (id != null && id !== state.thread) return switchThread(id)
  renderThreads()
}
function closeHome() { setHome(null); setBlank(false); renderThreads() }
// The header's terminal icon, wide layout: a toggle between a project's chat and its terminal.
function toggleTerminal() {
  const view = state.home
  if (panes.open) {
    const last = view && store.get(LAST_CHAT_KEY, {})[viewKey(view)]
    const topics = view ? viewTopics(view) : []
    const chat = (topics.find(t => t.id === last) ?? topics[0])?.id ?? (view?.kind === 'project' ? projectThread(view.key) : state.thread)
    return switchThread(chat)
  }
  if (view?.kind === 'project') {
    const mine = panes.list.filter(p => projectKey(p.project) === view.key), last = store.get(LAST_PANE_KEY, {})[viewKey(view)]
    if (mine.length) return selectSession((mine.find(p => p.id === last) ?? mine[0]).id)
  }
  openHome({ kind: 'sessions' })
}
// Wide layout: the right side shows what's selected on the left, so a session is a selection,
// in the view it belongs to: this one if it's listed here, else its project.
function selectSession(id) {
  const p = panes.list.find(x => x.id === id)
  const view = state.home && paneInView(state.home, id) ? state.home : p?.project ? { kind: 'project', key: projectKey(p.project) } : null
  if (!sameView(view, state.home)) setHome(view)
  if (view) rememberTopic(view, `pane:${id}`)
  setBlank(false)
  showPane(id)
  renderThreads()
}
wide.addEventListener('change', () => {
  if (wide.matches && panes.open && panes.id == null) closePanes() // the list is the phone's
  if (!wide.matches && state.home) closeHome(); else renderThreads()
})
// Column widths on wide windows: drag the edge, arrows when focused, double-click resets.
// Remembered per browser. The conversation always keeps CONVO_MIN.
const CONVO_MIN = 380
const COLUMNS = [
  { handle: 'side-col-resize', key: 'side-width', prop: '--side-w', min: 200, max: 420, el: () => $('side') },
  { handle: 'home-col-resize', key: 'home-width', prop: '--home-col', min: 220, max: 480, el: () => $('home') },
  // A tool sits on the right, so its handle is its left edge: dragging left widens it. Was board-width before tools.
  { handle: 'tool-col-resize', key: 'tool-width', oldKey: 'board-width', prop: '--tool-col', min: 320, max: 1400, el: () => $('tool'), dir: -1 },
]
function colLimit(c) {
  const others = COLUMNS.filter(o => o !== c).map(o => o.el()).reduce((w, el) => w + (el.hidden ? 0 : el.getBoundingClientRect().width), 0)
  return Math.max(c.min, Math.min(c.max, innerWidth - CONVO_MIN - others))
}
function setColumn(c, px, save = true) {
  const root = document.documentElement.style
  if (px == null) root.removeProperty(c.prop)
  else root.setProperty(c.prop, `${Math.round(Math.max(c.min, Math.min(px, colLimit(c))))}px`)
  if (save) try { px == null ? localStorage.removeItem(c.key) : localStorage.setItem(c.key, Math.round(px)) } catch {}
}
function loadColumns() {
  for (const c of COLUMNS) {
    let px = null
    try { px = Number(localStorage.getItem(c.key) ?? (c.oldKey && localStorage.getItem(c.oldKey))) || null } catch {}
    if (px != null) setColumn(c, px, false)
  }
}
for (const c of COLUMNS) {
  const handle = $(c.handle)
  handle.setAttribute('aria-label', S.resizeColumn)
  handle.addEventListener('pointerdown', e => {
    if (e.button) return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX, startW = c.el().getBoundingClientRect().width
    handle.classList.add('dragging')
    document.body.classList.add('col-dragging')
    const move = ev => setColumn(c, startW + (c.dir ?? 1) * (ev.clientX - startX))
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      handle.classList.remove('dragging')
      document.body.classList.remove('col-dragging')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
  handle.addEventListener('dblclick', () => setColumn(c, null))
  handle.addEventListener('keydown', e => {
    const step = (e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0) * (c.dir ?? 1)
    if (!step) return
    e.preventDefault()
    setColumn(c, c.el().getBoundingClientRect().width + step)
  })
}
loadColumns()
addEventListener('resize', loadColumns) // a narrower window gives the conversation its room back
// Everything that lists projects, repainted together when topics, peers or panes change.
// In a project conversation the composer names who gets the message: its session, or the agent
// when the project has none (the hub itself, a session the peers list can't name).
function renderAddress() {
  const key = projectOfThread(state.thread)
  if (key) input.placeholder = S.messagePeer(sessionPeer(key) ?? $('app').dataset.name)
  else if (input.placeholder.startsWith(S.messagePeer(''))) input.placeholder = S.placeholder
  refreshSend()
}
function renderNav() {
  renderSide()
  renderHome()
  if (topicsSheet.open) renderSheet()
}
// The chips are the short list for the phone: All, the full list, what's being read, what's
// unread, then what needs the user. The sidebar replaces them on wide windows.
function renderThreads() {
  const nav = $('threads')
  nav.textContent = ''
  const allUnread = state.generalUnread + state.threads.reduce((s, t) => s + t.unread, 0)
  const chip = (id, label, unread, extra = '') => h('button', { type: 'button', class: `chip${state.thread === id ? ' current' : ''}${extra}`, onclick: () => switchThread(id) }, label, unread ? h('span', { class: 'dot' }) : null)
  nav.append(chip(null, S.all, allUnread > 0 && state.thread !== null))
  nav.append(h('button', { type: 'button', class: 'chip more', 'aria-haspopup': 'dialog', onclick: () => openTopicsSheet() }, S.topicsN(openTopics().length)))
  const wanted = t => t.id === state.thread || (!isArchived(t) && (t.unread > 0 || t.lane === 'you'))
  const rank = t => t.id === state.thread ? 2 : t.unread > 0 ? 1 : 0
  for (const t of state.threads.filter(wanted).sort((a, b) => rank(b) - rank(a) || b.updated - a.updated))
    nav.append(chip(t.id, t.title, t.unread > 0 && state.thread !== t.id, isArchived(t) ? ' archived' : ''))
  // Keep the current chip in view (horizontally only: scrollIntoView could move the shell on iOS).
  const curChip = nav.querySelector('.chip.current')
  if (curChip && (curChip.offsetLeft < nav.scrollLeft || curChip.offsetLeft + curChip.offsetWidth > nav.scrollLeft + nav.clientWidth)) nav.scrollLeft = curChip.offsetLeft - 16
  const ctx = $('context')
  const cur = state.threads.find(t => t.id === state.thread)
  ctx.hidden = !cur
  if (cur) {
    const arch = isArchived(cur)
    ctx.replaceChildren(...[
      cur.project && !wide.matches ? h('button', { type: 'button', class: 'context-btn back', onclick: () => openHome({ kind: 'project', key: projectKey(cur.project) }) }, S.back(S.projectName(cur.project))) : null,
      h('span', { class: 'context-text' }, [cur.project ? shortTitle(cur.title, { name: S.projectName(cur.project), key: projectKey(cur.project) }) : cur.title, cur.detail].filter(Boolean).join(' · ')),
      ...toolButtons(cur),
      h('button', { type: 'button', class: 'context-btn archive', onclick: () => setArchived(cur, !arch) }, arch ? S.unarchive : S.archive, h('span', { class: 'context-icon', 'aria-hidden': 'true', html: ICON_ARCHIVE }))].filter(Boolean))
  }
  syncTool()
  if (archivedSheet.open) renderArchived()
  renderNav()
  renderAddress()
  if (!$('empty').hidden) paintEmpty()
  if (navigator.setAppBadge) (allUnread ? navigator.setAppBadge(allUnread) : navigator.clearAppBadge?.())?.catch?.(() => {})
}

async function setArchived(t, on, { quiet = false } = {}) {
  try {
    setThreads(await api(`api/threads/${encodeURIComponent(t.id)}/${on ? 'archive' : 'unarchive'}`, { method: 'POST' }).then(() => api('api/threads')))
  } catch { return toast(`${S.notSent.split(' · ')[0]}`) }
  if (quiet && !on && wide.matches && state.home) switchThread(t.id) // undo: back to where it was
  if (!quiet) toast(on ? S.archivedToast(t.title) : S.unarchivedToast(t.title), 4000, { label: S.undo, run: () => { $('toast').hidden = true; setArchived(t, !on, { quiet: true }) } })
}

function renderArchived() {
  const list = state.threads.filter(isArchived)
  $('archived-title').textContent = S.archivedN(list.length).replace(/ \(\d+\)$/, '')
  $('archived-sub').textContent = list.length ? S.archivedSub(list.length) : ''
  const ul = $('archived-list')
  if (!list.length) return ul.replaceChildren(h('li', { class: 'peer-empty' }, S.noArchived))
  ul.replaceChildren(...list.map(t => h('li', { class: 'archived-row' },
    h('button', { type: 'button', class: 'peer', onclick: () => { archivedSheet.hide(); switchThread(t.id) } },
      h('span', { class: 'peer-main' },
        h('span', { class: 'peer-name' }, t.title),
        h('span', { class: 'peer-meta' }, [t.id !== t.title ? t.id : null, t.updated ? S.lastActive(t.updated) : null].filter(Boolean).join(' · ')))),
    h('button', { type: 'button', class: 'pill-btn small', onclick: () => setArchived(t, false) }, S.unarchive))))
}
function openArchived() { topicsSheet.hide(); renderArchived(); archivedSheet.show() }
function pickTopic(id) { topicsSheet.hide(); switchThread(id) }
// The phone's list: the same projects, with a project's page inside the sheet.
let sheetView = null
function renderSheet() {
  const el = $('topics-list'), top = el.scrollTop
  $('topics-title').hidden = !!sheetView
  $('topics-back').hidden = !sheetView
  if (sheetView) {
    el.replaceChildren(...homeNodes(sheetView, pickTopic, id => { topicsSheet.hide(); openPanes(id) }))
  } else {
    const n = needsCount()
    const list = projectList()
    el.replaceChildren(
      h('button', { type: 'button', class: 'needs-chip', onclick: () => showSheet({ kind: 'needs' }) }, dotEl(n ? 'red' : 'quiet'), `${S.needsYou}${n ? ` ${n}` : ''}`),
      ...list.map(p => projectRow(p, () => showSheet({ kind: 'project', key: p.key }), false)),
      ...looseRows(pickTopic))
  }
  el.scrollTop = top
}
function showSheet(view) {
  sheetView = view
  renderSheet()
  $('topics-list').scrollTop = 0
}
function openTopicsSheet(view = null) {
  $('topics-title').textContent = S.projects
  $('topics-back').textContent = S.back(S.projects)
  showSheet(view)
  topicsSheet.show()
}
$('topics-back').onclick = () => showSheet(null)

async function switchThread(id, { load = true } = {}) {
  saveDraft()
  if (panes.open && wide.matches) closePanes()
  if (state.home && !inHome(id)) setHome(null)
  else if (state.home) rememberTopic(state.home, id)
  if (state.blank) setBlank(false)
  state.thread = id
  state.newCount = 0
  updateNewPill()
  clearReply()
  const u = new URL(location.href)
  if (id) u.searchParams.set('thread', id); else u.searchParams.delete('thread')
  u.hash = ''
  history.replaceState(null, '', u)
  renderThreads()
  restoreDraft()
  if (load) await loadLatest()
  renderPresence()
}

let readTimer
function markRead() {
  if (document.hidden || state.blank || (panes.open && wide.matches)) return // the conversation is covered: nothing was read
  clearTimeout(readTimer)
  readTimer = setTimeout(async () => {
    const last = Math.max(0, ...[...state.msgs.values()].filter(m => m.sender === 'agent').map(m => m.id))
    if (!last) return
    try {
      await api('api/read', { method: 'POST', body: JSON.stringify({ thread: state.thread ?? '*', last_id: last }) })
      if (state.thread == null) { state.generalUnread = 0; state.threads.forEach(t => (t.unread = 0)) }
      else { const t = state.threads.find(x => x.id === state.thread); if (t) t.unread = 0 }
      renderThreads()
    } catch {}
  }, 400)
}

// ---------- outbox (offline queue, idempotent via client_id) ----------
const saveOutbox = () => { store.set('outbox', state.outbox); renderSide() }
const shownPending = k => k === 'text' || k === 'voice'
const pendingForView = () => state.outbox.filter(p => shownPending(p.payload.kind) && (state.thread == null || p.payload.thread === state.thread))
function buildPending(p) {
  const kind = p.payload.kind
  const body = kind === 'voice' ? { files: p.payload.files, duration: p.payload.duration } : { text: p.payload.text }
  const m = { id: `c-${p.client_id}`, client_id: p.client_id, ts: p.ts, sender: 'user', kind, thread: p.payload.thread, body, files: p.files ?? [], reactions: [], reply_preview: p.reply_preview, pending: true, failed: p.failed }
  const n = buildNode(m)
  n.dataset.client = p.client_id
  return n
}
function enqueue(payload, extra = {}) {
  const item = { client_id: crypto.randomUUID(), ts: Date.now(), payload, ...extra }
  item.payload.client_id = item.client_id
  state.outbox.push(item)
  saveOutbox()
  if (shownPending(payload.kind)) { $('empty').hidden = true; messagesEl.append(buildPending(item)); scrollToBottom() }
  flushOutbox()
}
function removePending(client_id) { messagesEl.querySelector(`[data-client="${CSS.escape(client_id)}"]`)?.remove() }
function retryOutbox(client_id) {
  const p = state.outbox.find(x => x.client_id === client_id)
  if (!p) return
  p.failed = false; saveOutbox()
  const old = messagesEl.querySelector(`[data-client="${CSS.escape(client_id)}"]`)
  old?.replaceWith(buildPending(p))
  flushOutbox()
}

let flushing = false, backoff = 1000, flushTimer
async function flushOutbox() {
  if (flushing) return
  flushing = true
  clearTimeout(flushTimer)
  try {
    for (const p of [...state.outbox]) {
      if (p.failed) continue
      try {
        const res = await api('api/messages', { method: 'POST', body: JSON.stringify(p.payload) })
        state.outbox = state.outbox.filter(x => x.client_id !== p.client_id); saveOutbox()
        removePending(p.client_id)
        if (res?.id) upsert(res)
        if (res?.thread && !state.threads.some(t => t.id === res.thread)) loadThreads() // a new conversation is a new topic
        backoff = 1000
      } catch (e) {
        if (e.status === 401) break // locked: kept for after the unlock
        if (e.status === 409 && p.payload.kind === 'answer') {
          state.outbox = state.outbox.filter(x => x.client_id !== p.client_id); saveOutbox()
          state.qstate.delete(p.payload.to); catchUp()
        } else if (e.status >= 400 && e.status < 500) {
          if (shownPending(p.payload.kind)) {
            p.failed = true; saveOutbox()
            messagesEl.querySelector(`[data-client="${CSS.escape(p.client_id)}"]`)?.replaceWith(buildPending(p))
          } else {
            state.outbox = state.outbox.filter(x => x.client_id !== p.client_id); saveOutbox()
            if (p.payload.to) { state.qstate.delete(p.payload.to); const m = state.msgs.get(p.payload.to); if (m) replaceNode(m) }
            toast(`${S.notSent.split(' · ')[0]} (${e.status})`)
          }
        } else {
          flushTimer = setTimeout(flushOutbox, backoff)
          backoff = Math.min(backoff * 2, 30000)
          break
        }
      }
    }
  } finally { flushing = false }
}

// ---------- composer ----------
const draftKey = () => `draft:${state.thread ?? '*'}`
function saveDraft() { store.set(draftKey(), input.value) }
function restoreDraft() { input.value = store.get(draftKey(), ''); autoGrow(); refreshSend() }
function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, innerHeight * 0.4) + 'px' }
const uploading = () => state.atts.some(a => a.status === 'uploading')
function refreshSend() {
  const hasContent = input.value.trim() || state.atts.some(a => a.status === 'done')
  const dictating = state.dict && state.dict.raw == null
  $('send').disabled = !hasContent || uploading() || !!dictating
  // Empty composer: the mic takes the send button's place (iMessage-style).
  // A voice note has no text to carry the @peer, so a project conversation is typed.
  const showMic = !hasContent && !state.atts.length && !projectOfThread(state.thread) && !!(navigator.mediaDevices && window.MediaRecorder)
  $('send').hidden = showMic
  $('mic').hidden = !showMic
}
input.placeholder = S.placeholder
input.addEventListener('input', () => { autoGrow(); refreshSend(); saveDraft(); updateSuggest() })
input.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return // IME: confirming a candidate is not a command
  if (suggest.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      suggest.i = (suggest.i + (e.key === 'ArrowDown' ? 1 : -1) + suggest.items.length) % suggest.items.length
      return renderSuggest()
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); return pickSuggest(suggest.i) }
    if (e.key === 'Escape') { e.preventDefault(); return closeSuggest() }
  }
  if (e.key === 'Enter' && fine && !e.shiftKey) { e.preventDefault(); send() }
})
input.addEventListener('click', () => updateSuggest())
input.addEventListener('keyup', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') updateSuggest() })
input.addEventListener('blur', () => closeSuggest())
document.addEventListener('compositionstart', () => { state.composing = true; closeSuggest() }, true)
document.addEventListener('compositionend', () => { state.composing = false; setTimeout(updateSuggest) }, true)

// ---------- autocomplete: "/" commands at the start, "@" peers anywhere ----------
const suggest = { open: false, items: [], i: 0, kind: null, q: null, start: 0, end: 0 }
function triggerAt() {
  if (input.selectionStart !== input.selectionEnd) return null
  const c = input.selectionStart
  const before = input.value.slice(0, c)
  let m = /^\/([\w-]*)$/.exec(before)
  if (m) return { kind: 'cmd', q: m[1].toLowerCase(), start: 0, end: c + (/^[\w-]*/.exec(input.value.slice(c))[0].length) }
  m = /(^|\s)@([\p{L}\p{M}\p{N}_.-]*)$/u.exec(before)
  if (m) return { kind: 'peer', q: m[2].toLowerCase(), start: c - m[2].length - 1, end: c + (/^[\p{L}\p{M}\p{N}_.-]*/u.exec(input.value.slice(c))[0].length) }
  return null
}
function updateSuggest() {
  const t = !state.composing && document.activeElement === input ? triggerAt() : null
  if (!t) return closeSuggest()
  const rank = name => (name.toLowerCase().startsWith(t.q) ? 0 : 1)
  const items = t.kind === 'cmd'
    ? state.commands.filter(c => c.name.toLowerCase().includes(t.q)).sort((a, b) => rank(a.name) - rank(b.name))
    : state.peers.filter(p => p.name.toLowerCase().includes(t.q)).sort((a, b) => rank(a.name) - rank(b.name))
  if (!items.length) return closeSuggest()
  if (suggest.kind !== t.kind || suggest.q !== t.q) suggest.i = 0
  Object.assign(suggest, { open: true, items, kind: t.kind, q: t.q, start: t.start, end: t.end })
  renderSuggest()
}
function renderSuggest() {
  const ul = $('suggest')
  ul.hidden = false
  ul.replaceChildren(...suggest.items.map((it, i) => {
    const li = suggest.kind === 'cmd'
      ? h('li', { role: 'option', 'aria-selected': i === suggest.i ? 'true' : 'false' },
          h('span', { class: 'sg-name' }, `/${it.name}`, it.args ? h('span', { class: 'sg-args' }, ` ${it.args}`) : null),
          it.description ? h('span', { class: 'sg-desc' }, it.description) : null)
      : h('li', { role: 'option', 'aria-selected': i === suggest.i ? 'true' : 'false' },
          h('span', { class: 'sg-name' }, h('span', { class: `state-dot ${stateClass(it.state)}` }), `@${it.name}`),
          h('span', { class: 'sg-desc' }, [it.state, it.detail].filter(Boolean).join(' · ')))
    tapToPick(li, () => pickSuggest(i))
    return li
  }))
  ul.children[suggest.i]?.scrollIntoView({ block: 'nearest' })
}
// Pick on a tap, not on touch-down: a finger that lands on a row to scroll the
// list must not choose it. preventDefault on mousedown/touchend keeps focus (and
// the keyboard) on the composer.
function tapToPick(el, pick) {
  let y0 = null, moved = false
  el.addEventListener('mousedown', e => e.preventDefault())
  el.addEventListener('click', e => { if (y0 === null) pick() }) // mouse; touch is handled on touchend
  el.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; moved = false }, { passive: true })
  el.addEventListener('touchmove', e => { if (Math.abs(e.touches[0].clientY - y0) > 8) moved = true }, { passive: true })
  el.addEventListener('touchend', e => {
    if (!moved) { e.preventDefault(); pick() }
    setTimeout(() => { y0 = null }, 400)
  })
}
function closeSuggest() { suggest.open = false; suggest.kind = null; suggest.q = null; $('suggest').hidden = true }
function pickSuggest(i) {
  const it = suggest.items[i]
  if (!it) return
  const insert = suggest.kind === 'cmd' ? `/${it.name} ` : `@${it.name} `
  const v = input.value
  const rest = v.slice(suggest.end).replace(/^ /, '')
  input.value = v.slice(0, suggest.start) + insert + rest
  const caret = suggest.start + insert.length
  input.setSelectionRange(caret, caret)
  closeSuggest(); autoGrow(); refreshSend(); saveDraft()
  input.focus()
}
const stateClass = st => ({ blocked: 'red', error: 'red', stalled: 'red', waiting: 'amber', busy: 'green', working: 'green', running: 'green', thinking: 'green' }[String(st ?? '').toLowerCase()] ?? 'quiet')

// ---------- agent-published lists ----------
state.commands = []
state.peers = []
state.peersUpdated = null
async function loadLists() {
  try { state.commands = (await api('api/commands')).commands } catch {}
  try { setPeers(await api('api/peers')) } catch {}
  try { setTasks(await api('api/tasks')) } catch {}
}
function setPeers(p) {
  state.peers = p.peers ?? []
  state.peersUpdated = p.updated ?? null
  const dots = state.peers.map(x => stateClass(x.state)), dot = worstDot(dots)
  $('peers-dot').hidden = dot !== 'red' && dot !== 'amber'
  $('peers-dot').classList.toggle('amber', dot === 'amber')
  if (peersSheet.open) renderPeers()
  renderNav()
  renderAddress()
  retryBlank()
}
// A peer's face: its project's icon, or its initial, with the state dot on the corner.
function peerAvatar(p, dot = true) {
  const fallback = () => h('span', { class: 'peer-initial' }, [...p.name][0]?.toUpperCase() ?? '?')
  const img = p.icon ? h('img', { class: 'peer-icon', src: p.icon, alt: '', loading: 'lazy' }) : null
  if (img) img.onerror = () => img.replaceWith(fallback())
  return h('span', { class: `peer-avatar${isOffline(p.state) ? ' offline' : ''}` }, img ?? fallback(), dot ? h('span', { class: `state-dot ${stateClass(p.state)}`, title: p.state ?? '' }) : null)
}
function renderPeers() {
  $('peers-title').textContent = S.peers
  $('peers-refresh').textContent = S.refresh
  $('peers-updated').textContent = state.peersUpdated ? S.updatedAgo(Date.now() - state.peersUpdated) : S.neverUpdated
  const ul = $('peer-list')
  if (!state.peers.length) return ul.replaceChildren(h('li', { class: 'peer-empty' }, S.noPeers))
  ul.replaceChildren(...state.peers.map(p => h('li', {}, h('button', { type: 'button', class: 'peer', onclick: () => startPeerMessage(p.name) },
    peerAvatar(p),
    h('span', { class: 'peer-main' },
      h('span', { class: 'peer-name' }, p.name, p.state ? h('span', { class: 'peer-state' }, p.state) : null),
      p.detail ? h('span', { class: 'peer-detail' }, p.detail) : null,
      p.project || p.kind ? h('span', { class: 'peer-meta' }, [p.project, p.kind].filter(Boolean).join(' · ')) : null)))))
}
function openPeers() {
  renderPeers()
  peersSheet.show()
}
function startPeerMessage(name) {
  peersSheet.hide()
  // Wide layout: a peer is a selection too. With no project there's the agent's chat to address it from.
  if (wide.matches) {
    const peer = state.peers.find(p => p.name === name), key = projectKey(peer?.project)
    const pane = key && panes.list.find(p => projectKey(p.project) === key)
    if (pane) return selectSession(pane.id)
    if (key) return openHome({ kind: 'project', key })
    if (panes.open || state.blank) switchThread(null)
  }
  const mention = `@${name} `
  const v = input.value.replace(/^@[\p{L}\p{M}\p{N}_.-]+ /u, '')
  input.value = mention + v
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  autoGrow(); refreshSend(); saveDraft()
}
$('peers-btn').onclick = openPeers
$('peers-refresh').onclick = () => {
  enqueue({ kind: 'text', text: '/peers', thread: state.thread ?? undefined })
  toast(S.refreshAsked)
}
setInterval(() => {
  if (peersSheet.open && state.peersUpdated) $('peers-updated').textContent = S.updatedAgo(Date.now() - state.peersUpdated)
  if (tasksSheet.open && state.tasksUpdated) $('tasks-updated').textContent = S.updatedAgo(Date.now() - state.tasksUpdated)
}, 30000)

// ---------- background tasks: a chip next to the status dot, a sheet with the list ----------
state.tasks = []
state.tasksUpdated = null
const TASK_ORDER = { running: 0, waiting: 1, done: 2 }
function activeTasks() {
  const running = state.tasks.filter(x => x.state === 'running').length
  const active = running + state.tasks.filter(x => x.state === 'waiting').length
  return active ? { running, active } : null
}
function setTasks(t) {
  state.tasks = t.tasks ?? []
  state.tasksUpdated = t.updated ?? null
  const { running, active } = activeTasks() ?? { running: 0, active: 0 }
  const chip = $('tasks-chip')
  chip.hidden = !active
  chip.classList.toggle('running', running > 0)
  $('tasks-count').textContent = String(active)
  chip.setAttribute('aria-label', S.tasksLabel(active, running))
  chip.title = S.tasksLabel(active, running)
  if (tasksSheet.open) renderTasks()
  renderSide()
  renderPresence()
}
function openTasks() { renderTasks(); tasksSheet.show() }
function renderTasks() {
  $('tasks-title').textContent = S.tasks
  $('tasks-updated').textContent = state.tasksUpdated ? S.updatedAgo(Date.now() - state.tasksUpdated) : S.neverUpdated
  const ul = $('task-list')
  if (!state.tasks.length) return ul.replaceChildren(h('li', { class: 'peer-empty' }, S.noTasks))
  const sorted = [...state.tasks].sort((a, b) => (TASK_ORDER[a.state] ?? 0) - (TASK_ORDER[b.state] ?? 0))
  ul.replaceChildren(...sorted.map(t => {
    const since = t.started ? Date.parse(t.started) : NaN
    const live = t.state !== 'done' && Number.isFinite(since)
    return h('li', { class: `peer task ${t.state}` },
      t.state === 'running' ? h('span', { class: 'spinner small', 'aria-hidden': 'true' }) : h('span', { class: `state-dot ${stateClass(t.state)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'peer-main' },
        h('span', { class: 'peer-name' }, t.title, h('span', { class: 'peer-state' }, S.taskState(t.state))),
        t.detail ? h('span', { class: 'peer-detail' }, t.detail) : null),
      live ? h('span', { class: 'elapsed task-elapsed', 'data-since': String(since) }, S.elapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)))) : null)
  }))
}
$('tasks-chip').onclick = openTasks
$('compose-form').addEventListener('submit', e => { e.preventDefault(); send() })

function send() {
  if ($('send').disabled) return
  const text = input.value
  const done = state.atts.filter(a => a.status === 'done')
  if (!text.trim() && !done.length) return
  const d = state.dict
  const dict = d?.file && done.some(a => a.meta.id === d.file) ? { file: d.file, refined: d.mode === 'refined' } : undefined
  const peer = sessionPeer(projectOfThread(state.thread))
  const payload = { kind: 'text', text: peer ? addressed(text, peer) : text, thread: state.thread ?? undefined, reply_to: state.replyTo?.id, files: done.length ? done.map(a => a.meta.id) : undefined, dictation: dict }
  const reply_preview = state.replyTo ? { id: state.replyTo.id, sender: state.replyTo.sender, text: state.replyTo.text } : null
  if (!state.atLatest) void loadLatest() // a sent message belongs at the bottom of the conversation
  enqueue(payload, { files: done.map(a => a.meta), reply_preview })
  input.value = ''
  saveDraft(); autoGrow()
  state.atts = []; renderAtts()
  clearDict()
  clearReply()
  input.placeholder = S.placeholder
  renderAddress()
  if (!fine) input.blur()
}

function setReply(m) {
  state.replyTo = { id: m.id, sender: m.sender, text: plain(m).replace(/\s+/g, ' ').slice(0, 140) || S.attachment }
  $('reply-strip').hidden = false
  $('reply-text').textContent = state.replyTo.text
}
function clearReply() { state.replyTo = null; $('reply-strip').hidden = true }
$('reply-cancel').onclick = () => { clearReply(); input.placeholder = S.placeholder; renderAddress() }

// Attachments upload as soon as they're picked (XHR for progress).
$('file-input').addEventListener('change', e => {
  for (const file of e.target.files) startUpload({ key: crypto.randomUUID(), file, status: 'uploading', progress: 0 })
  e.target.value = ''
})
// Pasting a photo (the iOS keyboard's "Paste from Screenshots", ⌘V) attaches it like +.
// Text pasted alongside it still lands in the box.
input.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])]
  if (!files.length) return
  if (!e.clipboardData.types.includes('text/plain')) e.preventDefault()
  for (const f of files) {
    const ext = (f.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg')
    const file = !f.name || /^image\.\w+$/.test(f.name) ? new File([f], `pasted-${Date.now()}.${ext}`, { type: f.type }) : f
    startUpload({ key: crypto.randomUUID(), file, status: 'uploading', progress: 0 })
  }
})
function startUpload(a) {
  if (!state.atts.includes(a)) state.atts.push(a)
  a.status = 'uploading'; a.progress = 0
  const fd = new FormData()
  fd.append('file', a.file, a.file.name)
  const xhr = new XMLHttpRequest()
  a.xhr = xhr
  xhr.open('POST', 'api/upload')
  xhr.upload.onprogress = ev => { if (ev.lengthComputable) { a.progress = ev.loaded / ev.total; const bar = document.querySelector(`[data-att="${a.key}"] .bar i`); if (bar) bar.style.width = `${a.progress * 100}%` } }
  xhr.onload = () => {
    if (xhr.status === 201) { a.meta = JSON.parse(xhr.responseText)[0]; a.status = 'done' } else { a.status = 'error'; toast(S.uploadFailed) }
    renderAtts(); refreshSend()
  }
  xhr.onerror = () => { a.status = 'error'; renderAtts(); refreshSend(); toast(S.uploadFailed) }
  xhr.send(fd)
  renderAtts(); refreshSend()
}
function renderAtts() {
  const box = $('attachments')
  box.hidden = state.atts.length === 0
  box.textContent = ''
  for (const a of state.atts) {
    if (!a.thumb && a.file.type.startsWith('image/')) a.thumb = URL.createObjectURL(a.file)
    box.append(h('div', { class: `att${a.status === 'error' ? ' error' : ''}`, 'data-att': a.key, onclick: () => a.status === 'error' && startUpload(a) },
      a.thumb ? h('img', { src: a.thumb, alt: '' }) : h('span', { class: 'ph' }, (a.file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase()),
      h('span', { class: 'name' }, a.file.name),
      a.status === 'uploading' ? h('span', { class: 'bar' }, h('i', { style: `width:${a.progress * 100}%` })) : null,
      h('button', { class: 'x', type: 'button', 'aria-label': 'Remove', onclick: e => {
        e.stopPropagation(); a.xhr?.abort(); if (a.thumb) URL.revokeObjectURL(a.thumb)
        state.atts = state.atts.filter(x => x !== a); renderAtts(); refreshSend()
        if (state.dict && (a.meta?.id === state.dict.file || !state.dict.file)) clearDict()
      } }, '✕')))
  }
}

// ---------- voice notes: record, upload, send ----------
// iOS rules: the mic prompt and AudioContext.resume() must happen inside the tap,
// and the mic track must be stopped as soon as recording ends so the orange
// indicator goes away. iOS records audio/mp4 (AAC), Chromium audio/webm (Opus).
// target: 'compose' (voice note or dictation in the composer) or 'pane' (dictation into a pane's prompt line).
const rec = { active: false, target: 'compose', mr: null, stream: null, ctx: null, chunks: [], t0: 0, timer: 0, raf: 0, cancelled: false, mime: '', levels: [] }
const MAX_RECORD_S = 10 * 60
function pickMime() {
  for (const t of ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'])
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t
  return ''
}
const recUI = () => rec.target === 'pane'
  ? { row: $('pane-rec'), form: $('pane-prompt-form'), time: $('pane-rec-time'), level: $('pane-rec-level') }
  : { row: $('rec'), form: $('compose-form'), time: $('rec-time'), level: $('rec-level') }
function showRecording(on) {
  rec.active = on
  const ui = recUI()
  ui.row.hidden = !on
  ui.form.hidden = on
  if (on) {
    ui.time.textContent = '0:00'
    ui.level.replaceChildren(...Array.from({ length: 28 }, () => h('i')))
  }
}
async function startRecording(target = 'compose') {
  if (rec.active) return
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast(S.micUnsupported)
  const AC = window.AudioContext || window.webkitAudioContext
  try { rec.ctx = AC ? new AC() : null; rec.ctx?.resume?.() } catch { rec.ctx = null } // inside the gesture
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch (e) {
    rec.ctx?.close?.().catch?.(() => {}); rec.ctx = null
    return toast(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? S.micDenied : S.micFailed, 5000)
  }
  rec.stream = stream; rec.chunks = []; rec.cancelled = false; rec.levels = []; rec.target = target
  rec.mime = pickMime()
  try { rec.mr = new MediaRecorder(stream, rec.mime ? { mimeType: rec.mime } : undefined) }
  catch { rec.mr = new MediaRecorder(stream) }
  rec.mr.ondataavailable = e => { if (e.data?.size) rec.chunks.push(e.data) }
  rec.mr.onstop = finishRecording
  rec.mr.start(1000)
  rec.t0 = performance.now()
  ;(target === 'pane' ? paneInput : input).blur()
  showRecording(true)
  const ui = recUI()
  rec.timer = setInterval(() => {
    const s = (performance.now() - rec.t0) / 1000
    ui.time.textContent = fmtDur(s)
    if (s >= MAX_RECORD_S) stopRecording(false)
  }, 250)
  if (rec.ctx) { // cheap level meter: RMS of the waveform, one bar per ~80ms
    const src = rec.ctx.createMediaStreamSource(stream)
    const an = rec.ctx.createAnalyser()
    an.fftSize = 512
    src.connect(an)
    const buf = new Uint8Array(an.fftSize)
    let last = 0
    const tick = now => {
      if (!rec.active) return
      if (now - last > 80) {
        last = now
        an.getByteTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += (v - 128) ** 2
        const level = Math.min(1, Math.sqrt(sum / buf.length) / 40)
        rec.levels = [...rec.levels.slice(-27), level]
        const bars = ui.level.children
        const off = bars.length - rec.levels.length
        for (let i = 0; i < bars.length; i++) bars[i].style.transform = `scaleY(${Math.max(0.12, i >= off ? rec.levels[i - off] : 0)})`
      }
      rec.raf = requestAnimationFrame(tick)
    }
    rec.raf = requestAnimationFrame(tick)
  }
}
function releaseMic() {
  clearInterval(rec.timer); cancelAnimationFrame(rec.raf)
  rec.stream?.getTracks().forEach(t => t.stop()) // the iOS mic indicator goes away here
  rec.stream = null
  rec.ctx?.close?.().catch?.(() => {}); rec.ctx = null
  showRecording(false)
  refreshSend(); refreshPaneSend()
}
function stopRecording(cancel, refine = false) {
  if (!rec.active) return
  rec.cancelled = cancel
  rec.refine = refine
  rec.duration = (performance.now() - rec.t0) / 1000
  try { if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop() } catch {}
  releaseMic()
}
function finishRecording() {
  if (rec.cancelled || (rec.duration ?? 0) < 0.4 || !rec.chunks.length) return
  const type = ((rec.mr?.mimeType || rec.mime || 'audio/webm').split(';')[0]) || 'audio/webm'
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const file = new File(rec.chunks, `voice-${stamp}.${ext}`, { type })
  if (rec.target === 'pane') dictatePane(file)
  else if (rec.refine) dictate(file)
  else sendVoice(file, rec.duration)
}
function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('file', file, file.name)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', 'api/upload')
    xhr.onload = () => (xhr.status === 201 ? resolve(JSON.parse(xhr.responseText)[0]) : reject(new Error(`HTTP ${xhr.status}`)))
    xhr.onerror = () => reject(new Error('network'))
    xhr.send(fd)
  })
}
async function sendVoice(file, duration) {
  const reply = state.replyTo
  const thread = state.thread ?? undefined
  clearReply()
  if (!state.atLatest) await loadLatest().catch(() => {})
  // A local placeholder until the upload is done; then it becomes a normal outbox item.
  const temp = h('div', { class: 'msg user pending wide' }, h('div', { class: 'bubble-wrap' }, h('div', { class: 'bubble voice' }, h('div', { class: 'player ph' }, `🎙 ${fmtDur(duration)}`))), h('div', { class: 'status-line' }, S.sendingVoice))
  $('empty').hidden = true
  messagesEl.append(temp); scrollToBottom()
  for (let attempt = 0; ; attempt++) {
    try {
      const meta = await uploadFile(file)
      temp.remove()
      enqueue({ kind: 'voice', files: [meta.id], duration: Math.round(duration * 10) / 10, thread, reply_to: reply?.id }, {
        files: [meta], reply_preview: reply ? { id: reply.id, sender: reply.sender, text: reply.text } : null,
      })
      return
    } catch {
      if (attempt >= 2) {
        temp.classList.replace('pending', 'failed')
        temp.querySelector('.status-line').replaceChildren(h('button', { type: 'button', onclick: () => { temp.remove(); sendVoice(file, duration) } }, S.notSent))
        return
      }
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}
$('mic').addEventListener('click', () => startRecording())
$('rec-send').addEventListener('click', () => stopRecording(false))
$('rec-refine').addEventListener('click', () => stopRecording(false, true))

// ---------- dictation: speak, get a refined prompt in the composer, review, send ----------
// The audio rides along as an attachment; the hub keeps the raw transcript beside it.
// state.dict = { file, raw, refined, mode, edits: { raw, refined } } while a draft is under review.
const dictation = { on: false, refine: false }
function showDict(status, busy = false) {
  $('dict-strip').hidden = false
  $('dict-status').textContent = status
  $('dict-status').classList.toggle('busy', busy)
  $('dict-toggle').hidden = !(state.dict?.raw && state.dict?.refined)
}
function clearDict() {
  state.dict = null
  $('dict-strip').hidden = true
  input.readOnly = false
}
function setDictMode(mode) {
  const d = state.dict
  if (!d || d.mode === mode) return
  d.edits[d.mode] = input.value
  d.mode = mode
  input.value = d.edits[mode] ?? d[mode]
  for (const b of $('dict-toggle').children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
  $('dict-status').textContent = mode === 'refined' ? S.dictRefined : S.dictRaw
  saveDraft(); autoGrow(); refreshSend()
}
for (const b of $('dict-toggle').children) b.addEventListener('click', () => setDictMode(b.dataset.mode))
async function dictate(file) {
  const a = { key: crypto.randomUUID(), file, status: 'uploading', progress: 0 }
  state.atts.push(a); renderAtts()
  state.dict = { file: null, raw: null, refined: null, mode: 'refined', edits: {} }
  const d = state.dict
  showDict(S.dictTranscribing, true)
  input.readOnly = true
  refreshSend()
  try {
    a.meta = await uploadFile(file); a.status = 'done'; renderAtts()
    d.file = a.meta.id
    const r = await api('api/dictate', { method: 'POST', body: JSON.stringify({ file: d.file }) })
    if (state.dict !== d) return // sent or cleared meanwhile
    d.raw = r.raw; d.refined = r.refined
    d.mode = r.refined ? 'refined' : 'raw'
    const prefix = input.value.trim() ? input.value.replace(/\s*$/, '\n\n') : ''
    input.value = prefix + (d[d.mode] ?? '')
    input.readOnly = false
    showDict(r.refined ? S.dictRefined : r.refine_status === 'off' ? S.dictRaw : S.dictRefineFailed)
    for (const b of $('dict-toggle').children) b.setAttribute('aria-pressed', String(b.dataset.mode === d.mode))
    saveDraft(); autoGrow(); refreshSend()
    input.focus()
  } catch {
    if (state.dict !== d) return
    if (a.status === 'uploading') { a.status = 'error'; renderAtts() }
    input.readOnly = false
    state.dict = null
    $('dict-strip').hidden = true
    toast(S.dictFailed, 5000)
    refreshSend()
  }
}
$('rec-cancel').addEventListener('click', () => stopRecording(true))
addEventListener('keydown', e => { if (rec.active && e.key === 'Escape') { e.stopImmediatePropagation(); stopRecording(true) } }) // not also close the pane screen
refreshSend()

// ---------- gestures: long-press / swipe-right on a bubble ----------
function attachGestures(wrap, m) {
  let timer, sx, sy, dx = 0, active = false, fired = false, horiz = false
  wrap.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.target.closest('button, a, input, video, details, .option, .player, .transcript')) return
    active = true; fired = false; horiz = false; sx = e.clientX; sy = e.clientY; dx = 0
    if (e.pointerType !== 'mouse') timer = setTimeout(() => { fired = true; active = false; navigator.vibrate?.(10); getSelection()?.removeAllRanges(); openSheet(m) }, 450)
  })
  wrap.addEventListener('pointermove', e => {
    if (!active) return
    const mx = e.clientX - sx, my = e.clientY - sy
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimeout(timer)
    if (!horiz && Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.5 && e.pointerType !== 'mouse') horiz = true
    if (horiz) { dx = Math.max(0, Math.min(mx, 72)); wrap.style.transform = `translateX(${dx}px)` }
  })
  const end = () => {
    clearTimeout(timer)
    if (horiz && dx > 56) { setReply(m); input.focus() }
    wrap.style.transform = ''
    active = false; horiz = false
  }
  wrap.addEventListener('pointerup', end)
  wrap.addEventListener('pointercancel', end)
  wrap.addEventListener('contextmenu', e => { if (fine) { e.preventDefault(); openSheet(m) } else e.preventDefault() })
  wrap.addEventListener('click', e => { if (fired) { e.preventDefault(); e.stopPropagation() } }, true)
}

// ---------- action sheet ----------
function openSheet(m) {
  const mine = m.reactions?.find(r => r.sender === 'user')?.emoji
  const close = () => actionSheet.hide()
  $('sheet-emojis').replaceChildren(...EMOJIS.map(em => h('button', { type: 'button', class: em === mine ? 'mine' : '', onclick: () => {
    close()
    const emoji = em === mine ? '' : em
    m.reactions = [...(m.reactions ?? []).filter(r => r.sender !== 'user'), ...(emoji ? [{ emoji, sender: 'user' }] : [])]
    replaceNode(m)
    enqueue({ kind: 'reaction', to: m.id, emoji })
  } }, em)))
  const actions = [h('button', { type: 'button', onclick: () => { close(); setReply(m); input.focus() } }, S.reply)]
  const text = m.body.text ?? m.body.prompt
  if (text) actions.push(h('button', { type: 'button', onclick: async () => { close(); try { await navigator.clipboard.writeText(text); toast(S.copied) } catch {} } }, S.copy))
  const files = (m.files ?? []).filter(f => m.kind !== 'voice' || !f.mime.startsWith('audio/'))
  if (files.length) actions.push(h('button', { type: 'button', onclick: () => { close(); saveFiles(files) } }, S.save))
  $('sheet-actions').replaceChildren(...actions)
  actionSheet.show()
}

// ---------- search ----------
// A full view over the app (not a sheet: it has to follow the keyboard like the composer
// does). Searches all threads by default; the Thread chip picks one from a sheet.
// A result opens its thread (All for one without a thread) at that message.
// A kind chip (Photos, Videos, …) filters by attachment, and lists the latest of that kind
// without any words; photos and videos then show as a grid.
const search = { open: false, q: '', scope: null, type: null, results: [], seq: 0, timer: 0, more: false }
const SEARCH_PAGE = 30
const sInput = $('search-input')
sInput.placeholder = S.searchPlaceholder
$('search-cancel').textContent = S.cancel
function openSearch() {
  search.open = true
  search.scope = null
  $('search').hidden = false
  closeSuggest()
  sInput.focus() // in the tap, so iOS raises the keyboard
  sInput.select()
  renderSearchTypes()
  if (sInput.value.trim() || search.type) runSearch()
  else renderSearch()
}
// The first chip picks the thread (All threads by default), the rest the kind.
function renderSearchTypes() {
  const scope = search.scope != null ? threadTitle(search.scope) : null
  const threadChip = h('button', { type: 'button', class: `chip scope-chip${scope ? ' current' : ''}`, 'aria-haspopup': 'dialog', onclick: openScopePicker },
    h('span', { class: 'scope-name' }, scope ?? S.allThreads), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'))
  $('search-types').replaceChildren(threadChip, ...Object.entries(S.searchTypes).map(([type, label]) =>
    h('button', { type: 'button', class: `chip${search.type === type ? ' current' : ''}`, 'aria-pressed': search.type === type ? 'true' : 'false', onclick: () => {
      search.type = search.type === type ? null : type
      renderSearchTypes()
      sInput.blur() // the results, not the keyboard
      runSearch()
    } }, label)))
}
renderSearchTypes()
// A sheet over the search view: All threads, the thread you came from, then the rest by
// latest activity, archived ones last.
function openScopePicker() {
  sInput.blur()
  const pick = id => { scopeSheet.hide(); search.scope = id; renderSearchTypes(); if (search.q || search.type) runSearch() }
  const row = (id, name, meta) => h('li', {}, h('button', { type: 'button', class: 'peer', 'aria-pressed': search.scope === id ? 'true' : 'false', onclick: () => pick(id) },
    h('span', { class: 'peer-main' }, h('span', { class: 'peer-name' }, name), meta ? h('span', { class: 'peer-meta' }, meta) : null),
    search.scope === id ? h('span', { class: 'check' }, '✓') : null))
  const here = state.threads.find(t => t.id === state.thread)
  const rest = state.threads.filter(t => t !== here).sort((a, b) => isArchived(a) - isArchived(b) || (b.updated ?? 0) - (a.updated ?? 0))
  $('scope-title').textContent = S.searchIn
  $('scope-list').replaceChildren(row(null, S.allThreads),
    ...(here ? [row(here.id, here.title, S.thisThread)] : []),
    ...rest.map(t => row(t.id, t.title, [isArchived(t) ? S.archivedTag : null, t.updated ? S.lastActive(t.updated) : null].filter(Boolean).join(' · '))))
  scopeSheet.show()
}
function closeSearch() {
  search.open = false
  clearTimeout(search.timer)
  sInput.blur()
  $('search').hidden = true
  applyPendingUpdate()
}
async function runSearch(more = false) {
  const q = sInput.value.trim()
  search.q = q
  const seq = ++search.seq
  if (!q && !search.type) { search.results = []; search.more = false; return renderSearch() }
  if (!more) $('search-status').textContent = S.searching
  try {
    const before = more ? search.results.at(-1)?.id : undefined
    const page = await api(`api/search?${qs({ q, type: search.type, thread: search.scope, before, limit: SEARCH_PAGE })}`)
    if (seq !== search.seq) return // a newer query is on its way
    search.results = more ? [...search.results, ...page] : page
    search.more = page.length === SEARCH_PAGE
    renderSearch()
    if (!more) $('search-body').scrollTop = 0
  } catch { if (seq === search.seq) $('search-status').textContent = S.notSent.split(' · ')[0] }
}
// Text with each query word wrapped in <mark>, built from text nodes (no HTML from the server).
function highlight(text, q) {
  const words = q.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return [text]
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'))
  return parts.map((p, i) => (i % 2 ? h('mark', {}, p) : p))
}
const resultDate = ts => (new Date(ts).getFullYear() === new Date().getFullYear() ? dayFmt : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })).format(ts)
function renderSearch() {
  const ul = $('search-results')
  const status = $('search-status')
  $('search-more').hidden = !search.more
  $('search-more').textContent = S.moreResults
  if (!search.q && !search.type) { status.textContent = S.searchHint; return ul.replaceChildren() }
  status.textContent = search.results.length ? '' : search.q ? S.noResults(search.q) : S.noneOfType(S.searchTypes[search.type])
  if (search.type === 'photo' || search.type === 'video') return ul.replaceChildren(searchGrid(search.type))
  ul.replaceChildren(...search.results.map(m => {
    const who = m.sender === 'user' ? S.you : (m.source ? S.via(m.source) : document.title)
    const text = m.snippet || plain(m) || S.attachment
    return h('li', {}, h('button', { type: 'button', class: 'result', onclick: () => openResult(m) },
      h('span', { class: 'result-meta' },
        h('span', { class: 'result-thread' }, m.thread ? threadTitle(m.thread) : S.general),
        h('span', {}, who),
        h('span', { class: 'result-date' }, `${resultDate(m.ts)} ${timeFmt.format(m.ts)}`)),
      h('span', { class: 'result-text' }, highlight(text, search.q))))
  }))
}
// Every photo (or video) in the results, newest first. A photo opens the viewer with its
// neighbours to swipe through; a video opens its message, where it plays.
function searchGrid(type) {
  const tiles = search.results.flatMap(m => (m.files ?? []).filter(f => f.mime.startsWith(type === 'photo' ? 'image/' : 'video/')).map(f => ({ m, f })))
  const ids = tiles.map(t => t.f.id)
  return h('li', {}, h('div', { class: 'search-grid' }, tiles.map(({ m, f }, i) => {
    const label = `${f.name} · ${resultDate(m.ts)} ${timeFmt.format(m.ts)}`
    return type === 'photo'
      ? h('button', { type: 'button', 'aria-label': label, onclick: () => openViewer(ids, i) }, h('img', { src: fileUrl(f.id), alt: '', loading: 'lazy', decoding: 'async' }))
      : h('button', { type: 'button', 'aria-label': label, onclick: () => openResult(m) },
        h('video', { src: `${fileUrl(f.id)}#t=0.1`, preload: 'metadata', muted: true, playsinline: true }), h('span', { class: 'play' }, '▶'))
  })))
}
async function openResult(m) {
  closeSearch()
  const thread = search.scope ?? m.thread ?? null
  if (thread !== state.thread || state.blank) { await switchThread(thread, { load: false }); state.nodes.clear() } // the old view's nodes don't count
  await jumpTo(m.id, { smooth: false })
}
$('search-btn').onclick = openSearch
$('search-cancel').onclick = closeSearch
$('search-more').onclick = () => runSearch(true)
$('search-form').addEventListener('submit', e => { e.preventDefault(); clearTimeout(search.timer); runSearch(); sInput.blur() })
sInput.addEventListener('input', e => {
  if (e.isComposing || state.composing) return // IME: wait for the candidate to be confirmed
  clearTimeout(search.timer)
  search.timer = setTimeout(runSearch, 250)
})
sInput.addEventListener('compositionend', () => { clearTimeout(search.timer); search.timer = setTimeout(runSearch, 250) })

// ---------- panes: agent sessions in the terminal multiplexer ----------
// A full view like search. The list comes from the hub (SSE `panes`, every 3 s while the
// app is open); a pane's screen is fetched every 1.5 s while it is open and the app is
// visible. Keys and prompts go out once: nothing is retried, so a stray resend can't
// answer a dialog twice.
const panes = { on: false, digits: false, list: [], updated: null, open: false, id: null, seq: 0, timer: 0, status: null, gone: false, raw: null, stick: true,
  // The dialog on screen as a card (web/dialog.js): what it is, its signature (re-render only
  // when it changes), the option just tapped (busy until the screen moves on), the free-text
  // option the prompt line is typing into, and the key bar's manual override (null = auto).
  dialog: null, dlgSig: '', dlgBusy: null, dlgInput: null, keysOn: null,
  // Earlier turns from the transcript: session, cursor (next page's `before`), button state.
  hist: null,
  // One of the hub's own shells (hub/shells.ts): projects that may have one, whether the open
  // pane is one, when typing was last allowed (Face ID or a write), and a command to confirm.
  shellsOn: false, shellShare: false, shell: false, armedAt: 0, confirm: null }
const PANE_ORDER = { blocked: 0, working: 1 }
const paneInput = $('pane-prompt')
function setPanes(p) {
  panes.list = p.panes ?? []
  panes.updated = p.updated ? Date.parse(p.updated) : null
  $('panes-dot').hidden = !panes.list.some(x => x.status === 'blocked')
  if (panes.open && panes.id == null) renderPaneList()
  if (panes.open && panes.id != null) {
    const cur = panes.list.find(x => x.id === panes.id)
    if (cur) setPaneStatus(cur.status)
    if (cur?.agent === 'claude') $('pane-hist').hidden = false // opened (from a push) before the list came
    renderTermBtn()
    if (cur?.agent === 'shell' && !panes.shell) {
      panes.shell = true
      $('panes-title').replaceChildren(markEl(cur.agent, 'agent-mark title-mark'), cur.title, h('span', { class: 'shell-badge' }, cur.shell === 'shared' ? S.sharedBadge : S.shellBadge))
      renderShellBar(); renderPaneKeys(); renderTermBtn()
    }
    renderFleet()
    // The session ended: the view falls back to its first topic.
    if (!cur && wide.matches) { if (state.home) openHome(state.home); else switchThread(null) }
  }
  if (panePick.open) renderPanePick()
  renderNav()
  renderAddress()
  retryBlank()
}
async function loadPanes() {
  try { setPanes(await api('api/panes')); $('panes-status').textContent = '' }
  catch { if (panes.open && panes.id == null) $('panes-status').textContent = S.panesFailed }
}
// A session opens as the selection on wide, full screen on the phone.
function openPanes(id = null) {
  if (wide.matches && id != null) return selectSession(id)
  showPane(id)
}
function showPane(id = null) {
  if (search.open) closeSearch()
  panes.open = true
  $('panes').hidden = false
  $('app').classList.add('pane-on')
  $('panes-btn').classList.add('active'); $('panes-btn').setAttribute('aria-pressed', 'true')
  $('panes-close').textContent = S.sessionsDone
  closeSuggest()
  $('pane-pick-title').textContent = S.sessions
  if (id != null) openPane(id)
  else showPaneList()
  loadPanes()
}
function closePanes() {
  leaveShell()
  stopPaneScreen()
  panes.open = false
  panes.id = null
  renderTermBtn()
  panes.raw = null
  panes.dialog = null; panes.dlgSig = ''; panes.dlgBusy = null; panes.dlgInput = null
  paneInput.blur()
  $('panes').hidden = true
  $('app').classList.remove('pane-on')
  $('panes-btn').classList.remove('active'); $('panes-btn').setAttribute('aria-pressed', 'false')
  applyPendingUpdate()
}
function showPaneList() {
  leaveShell()
  stopPaneScreen()
  panes.id = null
  renderTermBtn()
  paneInput.blur()
  $('pane-screen').hidden = true
  $('panes-list-body').hidden = false
  renderPaneList()
}
const sortedPanes = () => [...panes.list].sort((a, b) => (PANE_ORDER[a.status] ?? 2) - (PANE_ORDER[b.status] ?? 2))
const paneIcon = p => {
  const key = projectKey(p.project)
  return { name: S.projectName(p.project ?? p.agent ?? '?'), icon: key === selfName() ? 'icons/icon-192.png' : state.peers.find(x => projectKey(x.project) === key)?.icon ?? state.projectIcons[key] ?? null }
}
const paneRow = (p, onclick, current = false) => h('li', {}, h('button', { type: 'button', class: `peer pane-row ${p.status}${current ? ' current' : ''}`, 'aria-current': current ? 'true' : null, onclick },
  projectIcon(paneIcon(p)),
  h('span', { class: 'peer-main' },
    h('span', { class: 'peer-name' }, p.title, h('span', { class: 'peer-state' }, S.paneStatus(p.status))),
    h('span', { class: 'peer-meta pane-meta' }, markEl(p.agent), [p.project, p.agent === 'shell' ? S.terminal.toLowerCase() : p.agent].filter(Boolean).join(' · '))),
  dotEl(stateClass(p.status), p.status)))
function renderPaneList() {
  $('panes-title').textContent = S.sessions
  $('panes-sub').textContent = [panes.list.length ? S.fleet(fleetCounts(panes.list)) : '', panes.updated ? S.updatedAgo(Date.now() - panes.updated) : ''].filter(Boolean).join(' · ')
  const ul = $('pane-list')
  const share = shareButton()
  const head = share ? [h('li', { class: 'share-row' }, share)] : []
  if (!panes.list.length) return ul.replaceChildren(...head, h('li', { class: 'peer-empty' }, S.noPanes))
  ul.replaceChildren(...head, ...sortedPanes().map(p => paneRow(p, () => openPane(p.id))))
}
// The fleet strip over a pane's screen: a dot and a count per state; tap it to switch.
function renderFleet() {
  const n = fleetCounts(panes.list)
  const part = (k, cls, label) => n[k] ? h('span', { class: 'fleet-part' }, h('span', { class: `state-dot ${cls}` }), label) : null
  const words = S.fleet(n).split(' · ')
  let i = 0
  const parts = [n.blocked && part('blocked', 'red', words[i++]), n.working && part('working', 'green', words[i++]), n.idle && part('idle', 'quiet', words[i++]), n.other && part('other', 'quiet', words[i++])].filter(Boolean)
  $('pane-fleet').replaceChildren(h('span', { class: 'fleet-parts' }, ...parts), h('span', { class: 'fleet-switch' }, S.switchSession,
    h('span', { class: 'fleet-chev', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="13" height="13"><path d="m7 10 5 5 5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' })))
}
// Picker sheet: every session, the open one marked; a tap switches without the list.
function renderPanePick() {
  $('pane-pick-sub').textContent = S.fleet(fleetCounts(panes.list))
  const ul = $('pane-pick-list')
  if (!panes.list.length) return ul.replaceChildren(h('li', { class: 'peer-empty' }, S.noPanes))
  ul.replaceChildren(...sortedPanes().map(p => paneRow(p, () => { panePick.hide(); if (p.id !== panes.id) openPane(p.id) }, p.id === panes.id)))
}
function openPanePick() {
  if (panes.id == null) return
  renderPanePick()
  panePick.show()
  loadPanes()
}
/** The next or previous session in list order (a swipe on the header). */
function stepPane(dir) {
  const list = sortedPanes()
  const i = list.findIndex(p => p.id === panes.id)
  if (i < 0 || list.length < 2) return
  const next = list[(i + dir + list.length) % list.length].id
  if (wide.matches) selectSession(next); else openPane(next)
}
function openPane(id) {
  leaveShell(id)
  stopPaneScreen()
  panes.id = id
  panes.gone = false
  panes.status = null
  panes.raw = null
  panes.stick = true
  panes.dialog = null; panes.dlgSig = ''; panes.dlgBusy = null; panes.dlgInput = null; panes.keysOn = null
  renderDialog()
  const p = panes.list.find(x => x.id === id)
  panes.shell = p?.agent === 'shell'
  panes.confirm = null
  renderTermBtn()
  $('panes-title').replaceChildren(p ? markEl(p.agent, 'agent-mark title-mark') : '', p?.title ?? id, panes.shell ? h('span', { class: 'shell-badge' }, p.shell === 'shared' ? S.sharedBadge : S.shellBadge) : '')
  renderShellBar()
  $('panes-sub').textContent = p ? [p.project, S.paneStatus(p.status)].filter(Boolean).join(' · ') : ''
  $('panes-list-body').hidden = true
  $('pane-screen').hidden = false
  $('pane-lines').replaceChildren()
  resetHist(p)
  paneInput.placeholder = S.panePrompt
  panes.digits = false
  renderPaneKeys()
  renderFleet()
  setPaneStatus(p?.status ?? null)
  pollPaneScreen()
}
function stopPaneScreen() {
  clearTimeout(panes.timer); panes.seq++
  if (rec.active && rec.target === 'pane') stopRecording(true)
}
async function pollPaneScreen() {
  clearTimeout(panes.timer)
  const seq = ++panes.seq, id = panes.id
  if (id == null) return
  if (!document.hidden) {
    try {
      const s = await api(`api/panes/${encodeURIComponent(id)}/screen?lines=150&ansi=1`)
      if (seq !== panes.seq) return
      renderPaneText(s.ansi ?? s.text) // a hub before colors sends text only
      setPaneStatus(s.status)
    } catch (e) {
      if (seq !== panes.seq) return
      if (e.status === 404) return paneGone() // it ended: stop polling
    }
  }
  if (seq === panes.seq) panes.timer = setTimeout(pollPaneScreen, 1500)
}
// The screen, fitted to the phone (web/term.js): lines the agent wrapped at its desk width
// are joined and wrapped again here, with hanging indents; rules span the width; tables
// scroll sideways on their own. The font shrinks to fit the pane's columns when it can
// (a tablet, a wide window) but never below PANE_FONT_MIN, where wrapping takes over.
const PANE_FONT_MIN = 11.5, PANE_FONT_MAX = 13
const darkMode = matchMedia('(prefers-color-scheme: dark)')
let monoRatio = 0 // advance width of one monospace column, per px of font size
function monoAdvance(el) {
  if (monoRatio) return monoRatio
  const probe = h('span', { style: 'position:absolute;visibility:hidden;white-space:pre;font-size:100px' }, '0'.repeat(20))
  el.append(probe)
  monoRatio = probe.getBoundingClientRect().width / 2000 || 0.6
  probe.remove()
  return monoRatio
}
function renderPaneText(raw, force = false) {
  if (raw === panes.raw && !force) return
  panes.raw = raw
  const box = $('pane-text'), out = $('pane-lines')
  let lines = parseAnsi(raw)
  // With the dialog shown as a card, the screen shows what led up to it (the whole
  // screen again with the keys on, to check the card against).
  const d = dialogOf(raw)
  if (panes.dialog && !keysShown() && d && JSON.stringify(d) === panes.dlgSig && d.top > 0) lines = lines.slice(0, d.top)
  const { cols, rows } = layoutScreen(lines, { join: !panes.shell })
  const cs = getComputedStyle(box)
  const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const ratio = monoAdvance(out)
  const fs = Math.max(PANE_FONT_MIN, Math.min(PANE_FONT_MAX, Math.floor(avail / (cols * ratio) * 4) / 4))
  box.style.fontSize = `${fs}px`
  const maxIndent = Math.max(2, Math.floor(avail / (fs * ratio) * 0.35)) // deep indents are capped, so text keeps room
  const dark = darkMode.matches
  const spanOf = (sp, t) => sp.st ? h('span', { style: spanCss(sp.st, dark) }, t) : t
  // Links stay tappable: each span's part inside a link becomes an <a> to the whole URL.
  const spansOf = spans => {
    const links = findLinks(spans.map(sp => sp.t).join(''))
    if (!links.length) return spans.map(sp => spanOf(sp, sp.t))
    const out = []
    let pos = 0
    for (const sp of spans) {
      const end = pos + sp.t.length
      let at = pos
      for (const l of links) {
        if (l.end <= at || l.start >= end) continue
        if (l.start > at) out.push(spanOf(sp, sp.t.slice(at - pos, l.start - pos)))
        const stop = Math.min(l.end, end)
        out.push(h('a', { href: l.href, target: '_blank', rel: 'noopener', class: 'tlink' }, spanOf(sp, sp.t.slice(Math.max(l.start, at) - pos, stop - pos))))
        at = stop
      }
      if (at < end) out.push(spanOf(sp, sp.t.slice(at - pos)))
      pos = end
    }
    return out
  }
  const nodes = []
  let table = null
  for (const r of rows) {
    if (r.kind !== 'table') table = null
    if (r.kind === 'blank') nodes.push(h('div', { class: 'tl blank' }, '\u00a0'))
    else if (r.kind === 'rule') {
      const label = r.label ? h('span', { class: 'tr-label' }, r.label) : null
      nodes.push(h('div', { class: `tr ${r.align}`, style: spanCss(r.st, dark) }, label))
    } else if (r.kind === 'table') {
      if (!table) { table = h('div', { class: 'tt' }); nodes.push(table) }
      table.append(h('div', {}, ...spansOf(r.spans)))
    } else {
      const lead = Math.min(r.lead, maxIndent), indent = Math.min(r.indent, maxIndent)
      nodes.push(h('div', { class: `tl${r.box ? ' box' : ''}`, style: `padding-left:${indent}ch;text-indent:${lead - indent}ch` }, ...spansOf(r.spans)))
    }
  }
  out.replaceChildren(...nodes)
  if (panes.stick) box.scrollTop = box.scrollHeight
}
// Follow the bottom unless the user scrolled up to read; scrolling back down follows again.
$('pane-text').addEventListener('scroll', e => {
  const el = e.currentTarget
  panes.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}, { passive: true })
// A new width (rotation, a split window) refits the font; a new height (the keyboard)
// keeps the bottom in view.
let paneBoxW = 0
new ResizeObserver(([e]) => {
  const w = Math.round(e.contentRect.width)
  if (panes.raw != null && w !== paneBoxW) { paneBoxW = w; renderPaneText(panes.raw, true) }
  else if (panes.stick) $('pane-text').scrollTop = $('pane-text').scrollHeight
}).observe($('pane-text'))
darkMode.addEventListener?.('change', () => { if (panes.raw != null) renderPaneText(panes.raw, true) })
// ---------- shells: plain terminals the hub opened (hub/shells.ts) ----------
// Opening one takes Face ID; so does typing after SHELL_ARM_MS without a write or after the
// app was in the background. A risky command comes back as a confirm card. Leaving the shell
// (another session, the list, Done) closes it; the hub also closes it after 10 min idle.
const SHELL_ARM_MS = 4.5 * 60_000 // a little under the hub's 5 min, so the hub never has to refuse
const shellPost = (id, what) => api(`api/shells/${encodeURIComponent(id)}/${what}`, { method: 'POST', headers: { 'x-hub-action': '1' }, body: '{}' })
const isShared = id => panes.list.find(x => x.id === id)?.shell === 'shared'
// On a session's screen: a terminal in that session's folder (Face ID in the tap).
function renderTermBtn() {
  const p = panes.list.find(x => x.id === panes.id)
  // A session and its terminal are siblings: >_ opens the terminal, the same slot closes it.
  const closing = !!(panes.open && panes.shell && panes.id != null && !panes.gone)
  const on = closing || !!(panes.open && panes.on && panes.shellsOn && p && p.agent !== 'shell' && p.cwd && !panes.gone)
  // At the right end of the session's (or terminal's) header. No hover title: one was left
  // up when the button changed under the pointer.
  for (const b of [$('pane-term-btn')]) {
    b.hidden = !on
    b.classList.toggle('closing', closing)
    b.setAttribute('aria-label', closing ? S.shellClose : S.openTerminal)
    b.innerHTML = closing ? ICON_TERMINAL_CLOSE : ICON_TERMINAL
  }
}
function openTerminal() {
  const from = panes.id
  if (from == null) return
  if (!lockState.enabled) return toast(S.shellLockOff, 4000)
  // Face ID has to start inside this tap, so no await before it.
  stepUp().then(async () => {
    try {
      const r = await api('api/shells', { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify({ pane: from }) })
      panes.armedAt = Date.now()
      panes.shellFrom = from
      await loadPanes()
      openPanes(r.id)
    } catch (e) {
      const code = e.body?.code
      toast(code === 'too_many' ? S.shellTooMany : code === 'lock_off' ? S.shellLockOff : code === 'no_folder' ? S.shellNoFolder : S.shellOpenFailed, 4000)
    }
  }, () => toast(S.stepupFailed))
}
// Closing goes back to the session it was opened from (leaving the terminal closes it).
function closeTerminal() {
  const back = panes.shellFrom
  if (back != null && back !== panes.id && panes.list.some(x => x.id === back)) return openPanes(back)
  if (wide.matches) closePanes(); else showPaneList()
}
const termTap = () => (panes.shell ? closeTerminal() : openTerminal())
$('pane-term-btn').addEventListener('click', termTap)
// Share one of your own terminals: Face ID (in the tap) lists the plain ones, a tap shows it here.
const shareButton = () => panes.on && panes.shellsOn && panes.shellShare
  ? h('button', { type: 'button', class: 'context-btn shell-btn share-btn', title: S.shareHint, onclick: openShareSheet }, S.shareTerminal) : null
function openShareSheet() {
  if (!lockState.enabled) return toast(S.shellLockOff, 4000)
  stepUp().then(async () => {
    $('share-sub').textContent = S.shareSub
    $('share-list').replaceChildren(h('li', { class: 'peer-empty' }, S.paneEarlierLoading))
    shareSheet.show()
    try {
      const { terminals } = await api('api/shells/shareable', { method: 'POST', headers: { 'x-hub-action': '1' }, body: '{}' })
      if (!terminals.length) return $('share-list').replaceChildren(h('li', { class: 'peer-empty' }, S.shareNone))
      $('share-list').replaceChildren(...terminals.map(t => h('li', {}, h('button', { type: 'button', class: 'peer pane-row', onclick: () => shareTerminal(t.id) },
        h('span', { class: 'peer-main' },
          h('span', { class: 'peer-name' }, t.title),
          h('span', { class: 'peer-meta' }, [String(t.cwd ?? '').replace(/^\/Users\/[^/]+/, '~'), t.backend].filter(Boolean).join(' · ')))))))
    } catch (e) {
      $('share-list').replaceChildren(h('li', { class: 'peer-empty' }, e.body?.code === 'stepup' ? S.shellStepup : S.shareFailed))
    }
  }, () => toast(S.stepupFailed))
}
async function shareTerminal(id) {
  try {
    await api('api/shells/share', { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify({ id }) })
    shareSheet.hide()
    panes.armedAt = Date.now()
    await loadPanes()
    openPanes(id)
  } catch (e) {
    const code = e.body?.code
    toast(code === 'too_many' ? S.shellTooMany : code === 'stepup' ? S.shareAgain : code === 'not_shareable' ? S.shareGone : S.shareFailed, 4000)
  }
}
/** Resolves when the open shell may be typed into: at once, or after Face ID (started in the tap). */
function shellArmed() {
  if (!panes.shell || !lockState.enabled || Date.now() - panes.armedAt < SHELL_ARM_MS) return Promise.resolve()
  return stepUp().then(() => { panes.armedAt = Date.now() }, e => { toast(S.stepupFailed); throw Object.assign(e ?? new Error('stepup'), { stepup: true }) })
}
/** A shell's refusal (Face ID needed, the lock off): handled here, true if it was one. */
function shellRefused(e) {
  const code = e?.body?.code
  if (code === 'stepup') { panes.armedAt = 0; toast(S.shellStepup, 3000); return true }
  if (code === 'lock_off') { toast(S.shellLockOff, 4000); return true }
  return !!e?.stepup // Face ID was cancelled: nothing was sent, and it said so
}
function leaveShell(nextId = null) {
  if (!panes.shell || panes.id == null || panes.id === nextId) return
  const id = panes.id, shared = isShared(id)
  panes.shell = false; panes.armedAt = 0; panes.confirm = null
  renderShellBar()
  shellPost(id, 'close').then(() => { toast(shared ? S.shellUnshared : S.shellClosed, 1800); loadPanes() }, () => {})
}
function renderShellBar() {
  const bar = $('pane-shell')
  bar.hidden = !panes.shell
  if (!panes.shell) { $('pane-shell-confirm').replaceChildren(); $('pane-shell-confirm').hidden = true; return }
  const p = panes.list.find(x => x.id === panes.id)
  const shared = p?.shell === 'shared'
  // Closing is the top bar's ×; a shared terminal (sharing is opt-in) keeps Stop sharing here.
  bar.replaceChildren(h('span', { class: 'shell-note' }, (shared ? S.shellNoteShared : S.shellNote)(p?.cwd ?? '')),
    ...(shared ? [h('button', { type: 'button', class: 'text-btn shell-close', onclick: closeTerminal }, S.shellStopSharing)] : []))
  renderShellConfirm()
}
function renderShellConfirm() {
  const box = $('pane-shell-confirm'), c = panes.confirm
  box.hidden = !c
  if (!c) return box.replaceChildren()
  const run = async () => {
    panes.confirm = null; renderShellConfirm()
    try {
      await shellArmed()
      await paneWrite('prompt', { text: c.text, confirm: true })
      panes.armedAt = Date.now()
      if (paneInput.value === c.text) { paneInput.value = ''; growPaneInput(); refreshPaneSend() }
      setTimeout(pollPaneScreen, 300)
    } catch (e) { if (!shellRefused(e)) paneWriteFailed(e) }
  }
  box.replaceChildren(h('div', { class: 'card question pane-card permission' },
    h('div', { class: 'q-prompt' }, S.shellConfirmTitle),
    h('pre', { class: 'shell-cmd' }, c.text),
    h('div', { class: 'detail' }, S.shellConfirmWhy(c.reason)),
    h('div', { class: 'pills-row' },
      h('button', { type: 'button', class: 'pill-btn primary-pill', onclick: run }, S.shellRun),
      h('button', { type: 'button', class: 'pill-btn', onclick: () => { panes.confirm = null; renderShellConfirm() } }, S.paneCancel))))
}

// ---------- earlier turns, from the session's transcript ----------
// A Claude Code session draws on the alternate screen, so its pane only ever holds one screen.
// "Load earlier" reads the turns before it from the transcript (hub/transcript.ts), a page at
// a time going back, and keeps the reader's place while a page lands above.
function resetHist(p) {
  panes.hist = { id: panes.id, session: null, next: undefined, loading: false, state: 'more', count: 0 }
  $('pane-hist-items').replaceChildren()
  $('pane-hist').hidden = p?.agent !== 'claude'
  renderHistBtn()
}
function renderHistBtn() {
  const st = panes.hist?.state ?? 'more', b = $('pane-hist-more')
  b.textContent = { more: S.paneEarlier, loading: S.paneEarlierLoading, none: S.paneEarlierNone, start: S.paneEarlierStart, failed: S.paneEarlierFailed }[st]
  b.disabled = st === 'loading' || st === 'none' || st === 'start'
}
async function loadEarlier(tries = 0) {
  const hs = panes.hist
  if (!hs || hs.loading || hs.next === null) return
  hs.loading = true; hs.state = 'loading'; renderHistBtn()
  try {
    const r = await api(`api/panes/${encodeURIComponent(hs.id)}/history?${qs({ limit: 20, before: hs.next, session: hs.session })}`)
    if (panes.hist !== hs) return
    if (hs.session && r.session !== hs.session) { $('pane-hist-items').replaceChildren(); hs.count = 0 } // a new session (/clear): start over
    hs.session = r.session; hs.next = r.next; hs.loading = false
    prependHist(r.items)
    hs.state = r.next == null ? (hs.count ? 'start' : 'none') : 'more'
    renderHistBtn()
    if (!r.items.length && r.next != null && tries < 3) loadEarlier(tries + 1) // a stretch with nothing to show
  } catch (e) {
    if (panes.hist !== hs) return
    hs.loading = false
    hs.state = e.status === 404 ? 'none' : 'failed'
    renderHistBtn()
  }
}
$('pane-hist-more').addEventListener('click', () => loadEarlier())
function prependHist(items) {
  if (!items.length) return
  const box = $('pane-text'), wrap = $('pane-hist-items')
  const nodes = histNodes(items)
  if (!wrap.childElementCount) nodes.push(h('div', { class: 'ph-now' }, S.paneNow))
  const top = box.scrollTop, height = box.scrollHeight
  wrap.prepend(...nodes)
  panes.hist.count += items.length
  box.scrollTop = top + (box.scrollHeight - height) // what the reader was looking at stays put
}
const histTime = ts => {
  const d = new Date(ts)
  return dayKey(d) === dayKey(Date.now()) ? timeFmt.format(d) : `${dayFmt.format(d)}, ${timeFmt.format(d)}`
}
function histNodes(items) {
  const out = []
  let tools = []
  const flush = () => {
    if (!tools.length) return
    const rows = tools.map(t => h('div', { class: `ph-tool${t.error ? ' error' : ''}`, title: t.text }, t.text))
    out.push(tools.length > 3 ? h('details', { class: 'ph-tools' }, h('summary', {}, S.paneToolCalls(tools.length)), ...rows) : h('div', { class: 'ph-toolrun' }, ...rows))
    tools = []
  }
  for (const it of items) {
    if (it.kind === 'tool') { tools.push(it); continue }
    flush()
    if (it.kind === 'user') out.push(h('div', { class: 'ph ph-user' }, it.ts ? h('span', { class: 'ph-time' }, histTime(it.ts)) : null, it.text))
    else if (it.kind === 'assistant') out.push(addCopyButtons(h('div', { class: 'ph ph-assistant md', html: md(it.text) })))
    else if (it.kind === 'peer') out.push(h('div', { class: 'ph ph-peer' }, h('b', {}, it.name), it.text))
    else out.push(h('div', { class: 'ph ph-note' }, it.text))
  }
  flush()
  return out
}
function paneGone() {
  panes.gone = true
  renderTermBtn()
  panes.raw = null
  panes.dialog = null; panes.dlgSig = ''; panes.dlgInput = null
  renderDialog()
  $('pane-lines').replaceChildren(h('div', { class: 'tl gone' }, S.paneGone))
  setPaneStatus(null)
}
function setPaneStatus(st) {
  panes.status = st
  const p = panes.list.find(x => x.id === panes.id)
  if (p) $('panes-sub').textContent = [p.project, S.paneStatus(st ?? p.status)].filter(Boolean).join(' · ')
  updateDialog()
}
// A question or permission dialog at the bottom of the screen becomes a card under it.
// It shows while herdr says the pane is blocked (or can't tell, and the dialog's footer is
// on screen). A dialog it can't read leaves the raw screen and the keys. In a multi-select a
// tap toggles a box, and Next (→) moves on to the next question or the review.
let dlgMemo = { raw: null, d: null }
function dialogOf(raw) {
  if (raw == null) return null
  if (dlgMemo.raw !== raw) dlgMemo = { raw, d: parseDialog(String(raw).replace(/\x1b\[[0-9;:]*m/g, '')) }
  return dlgMemo.d
}
const keysShown = () => !panes.gone && (panes.keysOn ?? (panes.status === 'blocked' && !panes.dialog))
function updateDialog() {
  const d = !panes.gone && !panes.shell ? dialogOf(panes.raw) : null
  const st = panes.status
  const dialog = cardable(d) && (st === 'blocked' || ((st == null || st === 'unknown') && !!d.footer)) ? d : null
  const sig = dialog ? JSON.stringify(dialog) : ''
  if (sig !== panes.dlgSig) {
    const hadCard = !!panes.dialog
    panes.dlgSig = sig
    panes.dialog = dialog
    panes.dlgBusy = null
    if (!dialog?.options.some(o => o.input && o.n === panes.dlgInput?.n)) panes.dlgInput = null
    if (hadCard !== !!dialog) panes.keysOn = null // back to automatic
    renderDialog()
    refreshPaneChrome()
    if (panes.raw != null) renderPaneText(panes.raw, true)
    return
  }
  refreshPaneChrome()
}
function refreshPaneChrome() {
  const blocked = panes.status === 'blocked', card = !!panes.dialog, typing = !!panes.dlgInput
  $('pane-screen').classList.toggle('blocked', blocked)
  paneInput.disabled = panes.gone || ((blocked || card) && !typing)
  paneInput.placeholder = panes.shell ? S.shellPrompt : typing ? S.paneTypeHint : card ? S.paneCardHint : blocked ? S.paneBlockedHint : S.panePrompt
  const keys = keysShown()
  $('pane-keys').hidden = !keys
  const kb = $('pane-keys-btn')
  kb.classList.toggle('on', keys)
  kb.setAttribute('aria-pressed', keys ? 'true' : 'false')
  kb.disabled = panes.gone
  for (const b of $('pane-keys').querySelectorAll('.pane-key')) b.disabled = panes.gone
  refreshPaneSend()
}
function renderDialog() {
  const box = $('pane-dialog'), d = panes.dialog
  box.hidden = !d
  if (!d) return box.replaceChildren()
  const busy = panes.dlgBusy != null
  const card = h('div', { class: `card question pane-card ${d.kind}` },
    h('div', { class: 'pane-card-kicker' }, [S.paneDialogKind(d.kind), d.header].filter(Boolean).join(' · ')))
  if (d.tabs) card.append(h('div', { class: 'card-chips' }, d.tabs.map(t => h('span', { class: `qchip${t.done ? ' done' : ''}` }, `${t.done ? '✓ ' : ''}${t.label}`))))
  if (d.title) card.append(h('div', { class: 'pane-card-title' }, d.title))
  if (d.context.length) card.append(h('pre', { class: 'pane-card-context' }, d.context.join('\n')))
  card.append(h('p', { class: 'q-prompt' }, d.prompt))
  const opts = h('div', { class: 'options' })
  for (const o of d.options) {
    const box = o.checked != null
    const selected = box ? o.checked || panes.dlgInput?.n === o.n : panes.dlgInput?.n === o.n || panes.dlgBusy === o.n
    opts.append(h('button', {
      type: 'button', class: `option${box ? ' multi' : ''}${selected ? ' selected' : ''}${o.chat ? ' chat' : ''}${o.separated ? ' separated' : ''}${o.input ? ' other' : ''}`,
      'aria-pressed': selected ? 'true' : 'false', disabled: busy, onclick: () => pickDialogOption(o),
    }, h('span', { class: 'ind' }),
      h('div', { class: 'body' },
        h('div', { class: 'label' }, o.label, o.recommended ? h('span', { class: 'tag' }, S.recommended) : null),
        o.description ? h('div', { class: 'desc' }, o.description) : null),
      d.plain ? null : h('span', { class: 'opt-n', 'aria-hidden': 'true' }, o.n)))
  }
  card.append(opts, h('div', { class: 'card-foot pane-card-foot' },
    h('button', { type: 'button', class: 'text-btn', disabled: busy, onclick: cancelDialog }, `${S.paneCancel} (Esc)`),
    d.multi ? h('button', { type: 'button', class: 'primary pane-card-next', disabled: busy, onclick: nextDialogStep }, S.paneNext) : null))
  box.replaceChildren(card)
}
const paneSleep = ms => new Promise(r => setTimeout(r, ms))
async function sendPaneKeys(keys) {
  for (let i = 0; i < keys.length; i += 8) await paneWrite('keys', { keys: keys.slice(i, i + 8) })
}
function paneWriteFailed(e) {
  if (e.status === 404) paneGone(); else toast(S.paneSendFailed)
}
async function pickDialogOption(o) {
  const d = panes.dialog
  if (!d || panes.dlgBusy != null || panes.gone) return
  if (o.input) { // the prompt line types into it (select, type, Enter on send)
    panes.dlgInput = o
    renderDialog(); refreshPaneChrome()
    paneInput.focus()
    return
  }
  const keys = keysFor(d, o)
  if (!keys) { panes.keysOn = true; return refreshPaneChrome() }
  panes.dlgInput = null
  panes.dlgBusy = o.n
  renderDialog(); refreshPaneChrome()
  try {
    await sendPaneKeys(keys)
    setTimeout(pollPaneScreen, 250)
  } catch (e) { panes.dlgBusy = null; renderDialog(); paneWriteFailed(e); return }
  // Busy until the screen moves on (updateDialog), or a few seconds if it doesn't.
  setTimeout(() => { if (panes.dlgBusy === o.n && panes.dialog === d) { panes.dlgBusy = null; renderDialog() } }, 4000)
}
/** A multi-select's Next: → moves to the next question, or the review before submitting. */
async function nextDialogStep() {
  if (!panes.dialog || panes.dlgBusy != null) return
  panes.dlgInput = null
  try { await sendPaneKeys(['right']); setTimeout(pollPaneScreen, 250) }
  catch (e) { paneWriteFailed(e) }
  refreshPaneChrome()
}
async function cancelDialog() {
  if (!panes.dialog || panes.dlgBusy != null) return
  panes.dlgInput = null
  try { await sendPaneKeys(['esc']); toast(S.paneSent, 1200); setTimeout(pollPaneScreen, 250) }
  catch (e) { paneWriteFailed(e) }
  refreshPaneChrome()
}
/** The free-text option: focus it with arrows, type the text, then Enter. */
async function sendDialogText(text) {
  const d = panes.dialog, o = panes.dlgInput
  const keys = d && keysFor(d, o)
  if (!keys) { toast(S.paneTypeFailed); panes.keysOn = true; return refreshPaneChrome() }
  $('pane-send').disabled = true
  try {
    if (keys.length) { await sendPaneKeys(keys); await paneSleep(200) } // let the dialog move its focus first
    await paneWrite('text', { text })
    await paneSleep(150)
    await paneWrite('keys', { keys: ['enter'] })
    paneInput.value = ''; clearPaneDict(); growPaneInput()
    panes.dlgInput = null
    panes.dlgBusy = o.n
    renderDialog()
    toast(S.paneSent, 1200)
    setTimeout(pollPaneScreen, 300)
  } catch (e) { paneWriteFailed(e) }
  refreshPaneChrome()
}
function refreshPaneSend() {
  const empty = !paneInput.value.trim()
  $('pane-send').disabled = paneInput.disabled || empty || paneDict.busy
  // Empty line: the mic takes the send button's place, as in the composer. It dictates
  // (speech → refined prompt to review), so it needs the hub's transcriber.
  const showMic = empty && !paneInput.disabled && !paneDict.busy && dictation.on && !!(navigator.mediaDevices && window.MediaRecorder)
  $('pane-send').hidden = showMic
  $('pane-mic').hidden = !showMic
}
// ---------- dictation on a pane's screen: speak, review the refined prompt, send ----------
// paneDict.d = { raw, refined, mode, prefix, edits } while a draft is under review.
const paneDict = { d: null, busy: false }
function showPaneDict(status, busy = false) {
  $('pane-dict').hidden = false
  $('pane-dict-status').textContent = status
  $('pane-dict-status').classList.toggle('busy', busy)
  $('pane-dict-toggle').hidden = !(paneDict.d?.raw && paneDict.d?.refined)
}
function clearPaneDict() {
  paneDict.d = null; paneDict.busy = false
  $('pane-dict').hidden = true
  paneInput.readOnly = false
  refreshPaneSend()
}
function setPaneDictMode(mode) {
  const d = paneDict.d
  if (!d || paneDict.busy || d.mode === mode) return
  d.edits[d.mode] = paneInput.value
  d.mode = mode
  paneInput.value = d.edits[mode] ?? d.prefix + d[mode]
  for (const b of $('pane-dict-toggle').children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
  $('pane-dict-status').textContent = mode === 'refined' ? S.dictRefined : S.dictRaw
  growPaneInput(); refreshPaneSend()
}
for (const b of $('pane-dict-toggle').children) b.addEventListener('click', () => setPaneDictMode(b.dataset.mode))
async function dictatePane(file) {
  const d = paneDict.d = { raw: null, refined: null, mode: 'refined', prefix: '', edits: {} }
  paneDict.busy = true
  showPaneDict(S.dictTranscribing, true)
  paneInput.readOnly = true
  refreshPaneSend()
  try {
    const meta = await uploadFile(file)
    const r = await api('api/dictate', { method: 'POST', body: JSON.stringify({ file: meta.id }) })
    if (paneDict.d !== d) return // sent, cleared or switched meanwhile
    d.raw = r.raw; d.refined = r.refined
    d.mode = r.refined ? 'refined' : 'raw'
    d.prefix = paneInput.value.trim() ? paneInput.value.replace(/\s*$/, '\n\n') : ''
    paneInput.value = d.prefix + (d[d.mode] ?? '')
    paneDict.busy = false
    paneInput.readOnly = false
    showPaneDict(r.refined ? S.dictRefined : r.refine_status === 'off' ? S.dictRaw : S.dictRefineFailed)
    for (const b of $('pane-dict-toggle').children) b.setAttribute('aria-pressed', String(b.dataset.mode === d.mode))
    growPaneInput(); refreshPaneSend()
    paneInput.focus()
  } catch {
    if (paneDict.d !== d) return
    clearPaneDict()
    toast(S.paneDictFailed, 5000)
  }
}
$('pane-mic').addEventListener('click', () => startRecording('pane'))
$('pane-rec-done').addEventListener('click', () => stopRecording(false, true))
$('pane-rec-cancel').addEventListener('click', () => stopRecording(true))
// The digits sit behind one key: it swaps the top row for ‹ 1 2 3 4 5, and sending a
// digit (or ‹) folds them away again.
function renderPaneKeys() {
  const key = (k, onclick) => {
    const b = h('button', { type: 'button', class: `pane-key${k.fold ? ' fold' : ''}`, 'aria-label': k.aria ?? k.label }, k.label)
    b.onclick = () => onclick(b)
    return b
  }
  const fold = open => { panes.digits = open; renderPaneKeys(); refreshPaneChrome() }
  const rows = S.paneKeys.map(row => row.map(k => key(k, b => (k.fold ? fold(true) : sendPaneKey(k.key, b)))))
  if (panes.shell) rows[1].unshift(key({ label: '^C', aria: S.shellCtrlC }, b => sendPaneKey('ctrl+c', b)))
  if (panes.digits) rows[0] = [key({ label: '‹', aria: S.paneDigitsClose }, () => fold(false)),
    ...S.paneDigits.map(d => key({ label: d }, async b => { await sendPaneKey(d, b); setTimeout(() => panes.digits && fold(false), 500) }))]
  $('pane-keys').replaceChildren(...rows.map(r => h('div', { class: 'pane-keys-row' }, ...r)))
}
const paneWrite = (what, body) => api(`api/panes/${encodeURIComponent(panes.id)}/${what}`, { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify(body) })
async function sendPaneKey(key, btn) {
  if (panes.id == null || panes.gone) return
  btn.classList.remove('sent', 'failed')
  try {
    await shellArmed() // a shell wants Face ID after a pause; it has to start in this tap
    await paneWrite('keys', { keys: [key] })
    if (panes.shell) panes.armedAt = Date.now()
    flashKey(btn, 'sent')
    setTimeout(pollPaneScreen, 250) // show the result without waiting for the next poll
  } catch (e) {
    flashKey(btn, 'failed')
    if (shellRefused(e)) return
    if (e.status === 404) paneGone(); else toast(S.paneSendFailed)
  }
}
function flashKey(btn, cls) {
  btn.classList.add(cls)
  clearTimeout(btn._t)
  btn._t = setTimeout(() => btn.classList.remove(cls), 900)
}
$('pane-prompt-form').addEventListener('submit', async e => {
  e.preventDefault()
  const text = paneInput.value
  if (!text.trim() || paneInput.disabled) return
  if (panes.dlgInput) return sendDialogText(text)
  $('pane-send').disabled = true
  try {
    await shellArmed()
    await paneWrite('prompt', { text })
    if (panes.shell) panes.armedAt = Date.now()
    paneInput.value = ''
    clearPaneDict()
    growPaneInput()
    toast(S.paneSent, 1200)
    setTimeout(pollPaneScreen, 300)
  } catch (err) {
    if (err.body?.code === 'confirm') { panes.confirm = { text, reason: err.body.reason }; renderShellConfirm() }
    else if (shellRefused(err)) {}
    else if (err.status === 409) { toast(S.paneBlocked); setPaneStatus('blocked') }
    else if (err.status === 404) paneGone()
    else toast(S.paneSendFailed)
  }
  refreshPaneSend()
})
// Return adds a line on the phone; with a hardware keyboard, Enter sends and Shift+Enter adds a line.
function growPaneInput() { paneInput.style.height = 'auto'; paneInput.style.height = Math.min(paneInput.scrollHeight + 2, innerHeight * 0.3) + 'px' }
paneInput.addEventListener('input', () => { growPaneInput(); refreshPaneSend() })
paneInput.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && fine && !e.shiftKey) { e.preventDefault(); $('pane-prompt-form').requestSubmit() }
})
$('pane-keys-btn').onclick = () => {
  panes.keysOn = !keysShown()
  refreshPaneChrome()
  if (panes.dialog && panes.raw != null) renderPaneText(panes.raw, true) // the whole screen with the keys
}
$('panes-btn').onclick = () => { if (wide.matches) toggleTerminal(); else openPanes() }
$('panes-close').onclick = closePanes
$('pane-fleet').onclick = openPanePick
// A sideways swipe on the header or the fleet strip steps to the next or previous session.
for (const el of [$('panes-heading'), $('pane-fleet')]) {
  let start = null
  el.addEventListener('touchstart', e => { start = panes.id != null && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null }, { passive: true })
  el.addEventListener('touchend', e => {
    if (!start) return
    const t = e.changedTouches[0], dx = t.clientX - start.x, dy = t.clientY - start.y
    start = null
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) { e.preventDefault(); stepPane(dx < 0 ? 1 : -1) } // preventDefault: no click after a swipe
  })
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && panes.open && panes.id != null) pollPaneScreen()
  if (document.hidden && panes.shell && panes.id != null) { // Face ID again when it comes back
    panes.armedAt = 0
    shellPost(panes.id, 'disarm').catch(() => {})
  }
})
setInterval(() => { if (panes.open && panes.id == null && panes.updated) $('panes-sub').textContent = S.updatedAgo(Date.now() - panes.updated) }, 30000)

// ---------- sheets: one bottom-sheet behaviour for every sheet ----------
// A sheet slides up over a dimmed backdrop and closes on a backdrop tap, Esc, or a
// drag down: on the grabber or head at any time, on .sheet-body only when it is
// scrolled to the top (otherwise the drag scrolls the list). The sheet follows the
// finger; on release it closes if pulled past a third of its height or flicked
// down, and springs back otherwise. While a sheet is open the app behind is inert
// (no scrolling, no focus); focus moves to the sheet and goes back where it was.
const openSheets = []
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
function makeSheet(backdrop) {
  const panel = backdrop.querySelector('.sheet')
  const touchUI = matchMedia('(pointer: coarse)').matches
  let returnFocus = null, hideTimer = 0, drag = null, swallowClick = 0
  const resetDrag = () => { panel.style.transform = ''; backdrop.style.removeProperty('--dim') }
  const sheet = {
    get open() { return openSheets.includes(sheet) },
    show() {
      if (sheet.open) return
      clearTimeout(hideTimer)
      returnFocus = document.activeElement
      resetDrag()
      backdrop.hidden = false
      void backdrop.offsetHeight // commit the closed position so the slide-up transitions
      backdrop.classList.add('open')
      openSheets.push(sheet)
      $('app').inert = true
      panel.focus({ preventScroll: true })
    },
    hide() {
      if (!sheet.open) return
      openSheets.splice(openSheets.indexOf(sheet), 1)
      if (!openSheets.length) $('app').inert = false
      drag = null
      panel.classList.remove('dragging'); backdrop.classList.remove('dragging')
      resetDrag() // in the same frame as removing .open: the slide-down starts where the finger left it
      backdrop.classList.remove('open')
      // Back to the opener; not to a text field on a touch screen, which would raise the keyboard.
      const back = returnFocus
      returnFocus = null
      if (back?.isConnected && back !== document.body && !(touchUI && /^(TEXTAREA|INPUT)$/.test(back.tagName))) back.focus({ preventScroll: true })
      else if (panel.contains(document.activeElement)) document.activeElement.blur()
      hideTimer = setTimeout(() => { backdrop.hidden = true; applyPendingUpdate() }, reducedMotion.matches ? 0 : 340)
    },
  }
  backdrop.addEventListener('click', e => { if (e.target === backdrop) sheet.hide() })
  panel.addEventListener('click', e => { if (Date.now() < swallowClick) { e.preventDefault(); e.stopPropagation() } }, true)

  // Drag to dismiss.
  const height = () => panel.getBoundingClientRect().height
  function start(x, y, target) {
    if (!sheet.open || target.closest('input, textarea, select')) return
    const body = target.closest('.sheet-body')
    if (body && body.scrollTop > 0) return // the gesture belongs to the list
    drag = { x0: x, y0: y, dy: 0, inBody: !!body, active: false, samples: [[performance.now(), y]] }
  }
  function move(x, y, e) {
    if (!drag) return
    const dx = x - drag.x0, dy = y - drag.y0
    if (!drag.active) {
      // Claim a downward start in a list at its top before iOS commits to scrolling.
      if (drag.inBody && dy > 0 && dy >= Math.abs(dx) && e?.cancelable) e.preventDefault()
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
      if (Math.abs(dx) > Math.abs(dy) || (drag.inBody && dy < 0)) { drag = null; return } // sideways, or scrolling the list
      drag.active = true
      panel.classList.add('dragging'); backdrop.classList.add('dragging')
    }
    if (e?.cancelable) e.preventDefault()
    drag.dy = dy
    // Downward follows the finger 1:1; upward resists, like a rubber band.
    const off = dy >= 0 ? dy : -Math.min(24, Math.sqrt(-dy) * 2)
    panel.style.transform = `translateY(${off}px)`
    backdrop.style.setProperty('--dim', String(Math.max(0, 1 - Math.max(0, dy) / height())))
    const now = performance.now()
    drag.samples.push([now, y])
    while (drag.samples.length > 2 && now - drag.samples[0][0] > 100) drag.samples.shift()
  }
  function end() {
    const d = drag
    drag = null
    if (!d?.active) return
    swallowClick = Date.now() + 400
    panel.classList.remove('dragging'); backdrop.classList.remove('dragging')
    // Velocity over the last ~100 ms, in px/ms (down is positive); a finger that paused has none.
    const now = performance.now(), first = d.samples[0], last = d.samples.at(-1)
    const v = now - last[0] > 80 ? 0 : (last[1] - first[1]) / Math.max(1, last[0] - first[0])
    if (d.dy > 0 && (d.dy > height() / 3 || (v > 0.45 && d.dy > 20))) sheet.hide()
    else resetDrag()
  }
  panel.addEventListener('touchstart', e => { if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY, e.target); else drag = null }, { passive: true })
  panel.addEventListener('touchmove', e => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY, e) }, { passive: false })
  panel.addEventListener('touchend', end)
  panel.addEventListener('touchcancel', () => { drag = null; panel.classList.remove('dragging'); backdrop.classList.remove('dragging'); resetDrag() })
  // A mouse drags by the grabber or the head only, so text in the body stays selectable.
  panel.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !e.target.closest('.sheet-grabber, .sheet-head') || e.target.closest('button')) return
    start(e.clientX, e.clientY, e.target)
    const mv = ev => move(ev.clientX, ev.clientY, ev)
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); end() }
    addEventListener('pointermove', mv)
    addEventListener('pointerup', up)
  })
  return sheet
}
const actionSheet = makeSheet($('sheet'))
const peersSheet = makeSheet($('peers-sheet'))
const panePick = makeSheet($('pane-pick-sheet'))
const shareSheet = makeSheet($('share-sheet'))
const tasksSheet = makeSheet($('tasks-sheet'))
const settingsSheet = makeSheet($('settings-sheet'))
const archivedSheet = makeSheet($('archived-sheet'))
const topicsSheet = makeSheet($('topics-sheet'))
const docSheet = makeSheet($('doc-sheet'))
const scopeSheet = makeSheet($('scope-sheet'))
addEventListener('keydown', e => {
  if (e.key === 'Escape' && openSheets.length && !state.viewerOpen) { e.preventDefault(); openSheets.at(-1).hide() }
  else if (e.key === 'Escape' && search.open && !state.viewerOpen && !e.isComposing) { e.preventDefault(); closeSearch() }
  else if (e.key === 'Escape' && panes.open && !wide.matches && !state.viewerOpen && !e.isComposing) { e.preventDefault(); closePanes() }
})

// ---------- image viewer: pinch, pan, double-tap, wheel, swipe between photos ----------
// Three <img> slots sit side by side: the current photo and its neighbours, so a
// sideways drag pulls the next photo in behind the current one, like Photos.
const viewer = { ids: [], i: 0, s: 1, x: 0, y: 0, fit: null }
const vStage = $('viewer-stage'), GAP = 24
let vImg = $('viewer-img'), vPrev = vStage.appendChild(h('img', { alt: '' })), vNext = vStage.appendChild(h('img', { alt: '' }))
function openViewer(ids, i) {
  viewer.ids = ids; viewer.i = Math.max(0, i)
  $('viewer').hidden = false; state.viewerOpen = true
  showViewerImage()
}
function closeViewer() {
  $('viewer').hidden = true; state.viewerOpen = false
  for (const img of [vImg, vPrev, vNext]) img.removeAttribute('src')
  applyPendingUpdate()
}
const neighbour = dir => viewer.ids[viewer.i + dir] ?? null
function updateViewerChrome() {
  $('viewer-prev').hidden = neighbour(-1) == null
  $('viewer-next').hidden = neighbour(1) == null
  $('viewer-open').href = fileUrl(viewer.ids[viewer.i])
  $('viewer-save').href = `${fileUrl(viewer.ids[viewer.i])}?download`
}
function showViewerImage() {
  updateViewerChrome()
  vImg.style.opacity = '0'
  vImg.onload = () => { layoutFit(); vImg.style.opacity = '1' }
  vImg.src = fileUrl(viewer.ids[viewer.i])
  loadSide(vPrev, neighbour(-1)); loadSide(vNext, neighbour(1))
}
function sizeImg(img) {
  const W = vStage.clientWidth, H = vStage.clientHeight
  const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1
  const k = Math.min(W / iw, H / ih, 1)
  Object.assign(img.style, { position: 'absolute', left: '0', top: '0', width: `${iw * k}px`, height: `${ih * k}px`, maxWidth: 'none', maxHeight: 'none' })
  return { w: iw * k, h: ih * k, W, H }
}
function loadSide(img, id) {
  img.style.opacity = '0'
  img.onload = () => { sizeImg(img); placeSides(0); img.style.opacity = '1' }
  if (id == null) img.removeAttribute('src')
  else img.src = fileUrl(id)
}
// dx: how far the row is dragged from rest.
function placeSides(dx) {
  const W = vStage.clientWidth, H = vStage.clientHeight
  for (const [img, side] of [[vPrev, -1], [vNext, 1]]) {
    const w = parseFloat(img.style.width) || 0, ht = parseFloat(img.style.height) || 0
    img.style.transform = `translate(${(W - w) / 2 + side * (W + GAP) + dx}px, ${(H - ht) / 2}px)`
  }
}
function layoutFit() {
  const f = sizeImg(vImg)
  viewer.fit = f
  viewer.s = 1; viewer.x = (f.W - f.w) / 2; viewer.y = (f.H - f.h) / 2
  applyT()
}
function applyT() { vImg.style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.s})` }
function zoomAt(px, py, ns) {
  ns = Math.min(Math.max(ns, 1), 8)
  viewer.x = px - (px - viewer.x) * (ns / viewer.s)
  viewer.y = py - (py - viewer.y) * (ns / viewer.s)
  viewer.s = ns
  if (ns === 1) { const f = viewer.fit; viewer.x = (f.W - f.w) / 2; viewer.y = (f.H - f.h) / 2 }
  applyT()
}
function slideRow(dx, ms) {
  for (const img of [vImg, vPrev, vNext]) img.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.8,.3,1)` : ''
  vImg.style.transform = `translate(${viewer.x + dx}px, ${viewer.y}px)`
  placeSides(dx)
}
// Slide the row one photo over, then rotate the slots so the neighbour becomes current.
let sliding = false
function goTo(dir) {
  const side = dir > 0 ? vNext : vPrev
  if (neighbour(dir) == null || sliding) return
  if (!side.naturalWidth || reducedMotion.matches) { viewer.i += dir; showViewerImage(); return }
  sliding = true
  slideRow(-dir * (vStage.clientWidth + GAP), 240)
  setTimeout(() => {
    for (const img of [vImg, vPrev, vNext]) { img.style.transition = ''; img.onload = null }
    if (dir > 0) [vPrev, vImg, vNext] = [vImg, vNext, vPrev]
    else [vNext, vImg, vPrev] = [vImg, vPrev, vNext]
    viewer.i += dir
    layoutFit()
    loadSide(dir > 0 ? vNext : vPrev, neighbour(dir))
    placeSides(0)
    updateViewerChrome()
    sliding = false
  }, 240)
}
{
  const pts = new Map()
  // At fit size a one-finger drag locks to an axis: sideways moves the row, down closes.
  let pinch = null, lastTap = 0, swipeX = 0, swipeY = 0, axis = null, downAt = 0
  const rel = e => { const r = vStage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  vStage.addEventListener('pointerdown', e => {
    if (sliding) return
    vStage.setPointerCapture(e.pointerId)
    pts.set(e.pointerId, rel(e))
    if (pts.size === 2) {
      const [a, b] = [...pts.values()]
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: viewer.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
    }
    for (const img of [vImg, vPrev, vNext]) img.style.transition = ''
    swipeX = 0; swipeY = 0; axis = pts.size === 1 ? null : 'none'; downAt = Date.now()
  })
  vStage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return
    const prev = pts.get(e.pointerId), cur = rel(e)
    pts.set(e.pointerId, cur)
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      viewer.x += mx - pinch.mx; viewer.y += my - pinch.my
      pinch.mx = mx; pinch.my = my
      zoomAt(mx, my, pinch.s * (d / pinch.d))
    } else if (pts.size === 1) {
      if (viewer.s > 1) { viewer.x += cur.x - prev.x; viewer.y += cur.y - prev.y; applyT() }
      else if (axis !== 'none') {
        swipeX += cur.x - prev.x; swipeY += cur.y - prev.y
        if (!axis && Math.hypot(swipeX, swipeY) > 8) axis = Math.abs(swipeX) > Math.abs(swipeY) && viewer.ids.length > 1 ? 'x' : 'y'
        // Past the first or last photo the row drags with resistance.
        if (axis === 'x') slideRow(neighbour(swipeX < 0 ? 1 : -1) == null ? swipeX / 3 : swipeX, 0)
        if (axis === 'y') vImg.style.transform = `translate(${viewer.x}px, ${viewer.y + Math.max(0, swipeY)}px)`
      }
    }
  })
  const up = e => {
    const p = pts.get(e.pointerId)
    pts.delete(e.pointerId)
    if (pts.size < 2) pinch = null
    if (pts.size === 0 && viewer.s === 1) {
      if (axis === 'y' && swipeY > 120) { closeViewer(); return }
      const dir = swipeX < 0 ? 1 : -1, flick = Math.abs(swipeX) / Math.max(1, Date.now() - downAt) > 0.4
      if (axis === 'x' && neighbour(dir) != null && (Math.abs(swipeX) > viewer.fit.W / 3 || (flick && Math.abs(swipeX) > 30))) { goTo(dir); return }
      if (axis) slideRow(0, 200)
      else applyT()
    }
    if (e.type === 'pointerup' && p && !axis) {
      const now = Date.now()
      if (now - lastTap < 300) { zoomAt(p.x, p.y, viewer.s > 1 ? 1 : 2.5); lastTap = 0 } else lastTap = now
    }
  }
  vStage.addEventListener('pointerup', up)
  vStage.addEventListener('pointercancel', up)
  vStage.addEventListener('wheel', e => { e.preventDefault(); const p = rel(e); zoomAt(p.x, p.y, viewer.s * Math.exp(-e.deltaY / 300)) }, { passive: false })
  $('viewer-close').onclick = closeViewer
  $('viewer-prev').onclick = () => goTo(-1)
  $('viewer-next').onclick = () => goTo(1)
  $('viewer-save').onclick = e => shareInstead(e, { id: viewer.ids[viewer.i] })
  addEventListener('keydown', e => {
    if (!state.viewerOpen) return
    if (e.key === 'Escape') closeViewer()
    if (e.key === 'ArrowLeft') goTo(-1)
    if (e.key === 'ArrowRight') goTo(1)
  })
  addEventListener('resize', () => {
    if (!state.viewerOpen) return
    layoutFit()
    for (const img of [vPrev, vNext]) if (img.naturalWidth) sizeImg(img)
    placeSides(0)
  })
}

// ---------- presence: typing bubble + header dot ----------
// The agent (or its hooks) reports idle / thinking / working. While not idle a typing
// bubble sits under the last message; an agent message hides it until the next
// presence update, so a reply never shows "typing" underneath itself.
state.presence = { state: 'idle', detail: null, thread: null, updated: 0 }
let presenceHiddenAt = 0
function setPresenceState(p) { state.presence = p; renderPresence() }
function renderPresence() {
  const p = state.presence
  const active = presenceOn(p)
  $('conn').classList.toggle('busy', active)
  const line = active ? presenceText(p) : null
  if (state.agentActive !== active || state.agentPresence !== line) { state.agentActive = active; state.agentPresence = line; renderSide() }
  // The bubble is someone working right here: the agent's presence in this chat, or a running
  // task in its own topic. A waiting task keeps its topic live (the dot) but never types, and
  // All (the main chat, which shows every topic) shows only the agent's presence, wherever it
  // is: another topic's task there read as the agent typing.
  // Presence stays out of it under a reply until its next update; a task doesn't.
  const fresh = p.updated > presenceHiddenAt
  const says = liveThreads({ presence: fresh, waiting: false })
  const text = state.thread == null ? (fresh && presenceOn(p) ? presenceText(p) : undefined) : says.get(state.thread)
  const show = !!text
  const el = $('typing')
  const wasHidden = el.hidden
  el.hidden = !show
  if (show) {
    $('typing-detail').textContent = text
    if (wasHidden && pinned) scrollToBottom()
  }
  const sig = JSON.stringify([...liveThreads().keys()])
  if (sig !== state.liveSig) { state.liveSig = sig; renderNav() }
}
const presenceText = p => p.detail ? `${p.detail}…`.replace(/…+$/, '…') : (p.state === 'working' ? S.working : S.thinking)
const hubLost = () => $('conn').classList.contains('lost')
const sendFailed = () => state.outbox.some(p => p.failed)
// The agent's dot: green while working, empty when idle, red when the hub is lost or a send failed.
const agentDot = () => hubLost() || sendFailed() ? 'red' : state.agentActive ? 'green' : 'quiet'
const agentLine = () => hubLost() ? S.reconnecting : sendFailed() ? S.notSent.split(' · ')[0] : state.agentPresence ?? null
function hidePresenceForMessage() { presenceHiddenAt = Math.max(presenceHiddenAt, state.presence.updated); renderPresence() }
async function loadPresence() {
  try { setPresenceState(await api('api/presence')) } catch {}
  try { setListening(await api('api/listening')) } catch {}
}
// "Not connected": nothing has listened on the agent side (its watcher or channel) for a while.
// A watcher reconnects between messages, so a short gap is normal; only a long one shows.
const LISTEN_GAP_MS = 3 * 60_000
function setListening(l) { state.listening = l; renderListening() }
function renderListening() {
  const b = $('agent-off'), l = state.listening
  const now = Date.now()
  const off = !!l && !l.listening && !hubLost() && now - (l.last ?? l.started) > LISTEN_GAP_MS
  b.hidden = !off
  if (!off) return
  const name = $('app').dataset.name
  b.replaceChildren(h('strong', {}, S.agentOff(name)), ' ', h('span', {}, l.last ? S.agentOffSince(agoText(now - l.last)) : S.agentNeverOn))
}
const agoText = ms => ms < 3_600_000 ? S.minutesAgo(Math.max(1, Math.round(ms / 60_000))) : ms < 86_400_000 ? S.hoursAgo(Math.round(ms / 3_600_000)) : S.daysAgo(Math.round(ms / 86_400_000))
setInterval(renderListening, 30_000)
setInterval(renderPresence, 30000) // lets an old presence expire even without events

// ---------- live events ----------
let es, lostTimer
function setConn(cls, title) {
  $('conn').classList.remove('on', 'lost')
  $('conn').classList.add(cls)
  $('conn').title = title
  renderSide()
}
function connect() {
  es?.close()
  es = new EventSource('api/events')
  es.onopen = () => { clearTimeout(lostTimer); lostTimer = 0; setConn('on', S.connected) }
  es.onerror = () => {
    $('conn').classList.remove('on'); $('conn').title = S.reconnecting
    // iOS drops the stream on every resume: only a gap that lasts counts as an error. Retries
    // fail again every few seconds, so the first failure starts the clock and the rest don't.
    lostTimer ||= setTimeout(() => setConn('lost', S.reconnecting), 8000)
    // A refused stream (401 once the lock times out) closes for good: ask why, which shows the lock.
    if (es.readyState === EventSource.CLOSED) probeSession()
  }
  es.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.client_id) removePending(m.client_id)
    if (m.sender === 'agent') hidePresenceForMessage()
    if (!inView(m)) { if (m.sender === 'agent') loadThreads(); return }
    upsert(m)
    if (m.sender === 'agent') loadThreads()
  })
  es.addEventListener('update', e => upsert(JSON.parse(e.data)))
  es.addEventListener('moved', e => {
    const { ids, thread } = JSON.parse(e.data)
    // The user's own message that just went out started a new topic: follow it there,
    // so it (and the answer to it) doesn't vanish from the view they're looking at.
    const mine = [...state.msgs.values()].filter(m => m.sender === 'user' && !m.pending)
    const latest = mine.reduce((a, m) => (!a || m.id > a.id ? m : a), null)
    // The main stream (thread null) shows every topic, so nothing vanishes there: stay.
    if (state.thread != null && thread !== state.thread && latest && ids.includes(latest.id) && Date.now() - Date.parse(latest.ts) < 10 * 60e3) {
      switchThread(thread)
      return
    }
    if (thread === state.thread || ids.some(id => state.msgs.has(id))) loadLatest()
  })
  es.addEventListener('reaction', e => {
    const { to, reactions } = JSON.parse(e.data)
    const m = state.msgs.get(to)
    if (m) { m.reactions = reactions; replaceNode(m) }
  })
  es.addEventListener('threads', e => setThreads(JSON.parse(e.data)))
  es.addEventListener('commands', e => { state.commands = JSON.parse(e.data).commands; if (suggest.open) updateSuggest() })
  es.addEventListener('peers', e => setPeers(JSON.parse(e.data)))
  es.addEventListener('presence', e => setPresenceState(JSON.parse(e.data)))
  es.addEventListener('listening', e => setListening(JSON.parse(e.data)))
  es.addEventListener('icon', e => iconChanged(JSON.parse(e.data).seed))
  es.addEventListener('tasks', e => setTasks(JSON.parse(e.data)))
  es.addEventListener('panes', e => setPanes(JSON.parse(e.data)))
}

// The stream and <img>/<video> can't tell a 401 apart from a network error: a plain API call
// can, and shows the lock screen on 401. Otherwise the stream is reopened.
let probing = false
async function probeSession() {
  if (probing || !lockState.unlocked) return
  probing = true
  try { await api('api/presence'); setTimeout(() => { if (es?.readyState === EventSource.CLOSED) connect() }, 3000) }
  catch {}
  finally { probing = false }
}
messagesEl.addEventListener('error', e => {
  if (/^(IMG|VIDEO|SOURCE)$/.test(e.target.tagName) && (e.target.getAttribute('src') ?? '').startsWith('files/')) probeSession()
}, true)
/** After an unlock: attachments that failed while locked load again. */
function reloadMedia() {
  for (const el of messagesEl.querySelectorAll('img[src^="files/"]')) if (el.complete && !el.naturalWidth) el.src = el.getAttribute('src')
  for (const el of messagesEl.querySelectorAll('video[src^="files/"]')) if (el.error) el.load()
}

// iOS kills a backgrounded app's EventSource silently: reopen and fill the gap on every resume.
let lastResume = 0
function resume() {
  if (Date.now() - lastResume < 1000) return
  lastResume = Date.now()
  connect()
  catchUp()
  flushOutbox()
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Away longer than the lock allows: cover the screen before anything loads.
    if (lockState.enabled && Date.now() - lockState.hiddenAt > lockState.idleMin * 60_000) showLock()
    resume(); markRead()
  } else { lockState.hiddenAt = Date.now(); saveDraft(); applyPendingUpdate() }
})
addEventListener('pageshow', e => { if (e.persisted) resume() })
addEventListener('online', resume)
setInterval(() => {
  for (const el of document.querySelectorAll('.elapsed[data-since]')) el.textContent = S.elapsed(Math.floor((Date.now() - Number(el.dataset.since)) / 1000))
}, 1000)

// ---------- keyboard / viewport ----------
// iOS doesn't shrink the layout viewport for the keyboard; only the visual viewport
// shrinks (and may be panned, offsetTop > 0, to reveal the focused field). The fixed
// shell follows the visual viewport. Two rules keep this smooth:
//  1. Coalesce to one write per frame, and write only values that changed: the old
//     code re-laid out the whole shell on every viewport scroll event, chasing
//     iOS's pan one frame late, which is what made scrolling jagged.
//  2. Don't let a drag pan the page at all (touchmove guard below), so offsetTop
//     only changes when the keyboard opens or closes.
//  3. Rotation: iOS can leave visualViewport.offsetTop (and window.scrollY) non-zero
//     after the phone turns and back, without a further scroll event. Followed
//     blindly, that stale offset pushed the whole shell down by its amount, leaving
//     a band under the status bar and the composer off the bottom, for good. So the
//     offset is used only while the keyboard is up and the visual viewport is
//     actually shorter than the layout viewport (with no keyboard and no zoom the
//     two coincide, so the shell sits at 0), and every resize or orientation change
//     re-reads the viewport a few times while iOS settles.
// Browsers that honour interactive-widget=resizes-content resize the layout
// viewport instead; then height == innerHeight and offsetTop == 0, and this is a no-op.
const vv = window.visualViewport
const root = document.documentElement
root.classList.toggle('ios', isIOS)
let vvFrame = 0
const vvLast = { h: -1, top: -1, kb: null }
const vvBase = { w: 0, h: 0 }
const appEl = $('app')
const coarse = matchMedia('(pointer: coarse)').matches
function syncViewport() {
  if (vv && !vvFrame) vvFrame = requestAnimationFrame(applyViewport)
}
function applyViewport() {
  vvFrame = 0
  const ae = document.activeElement
  const typing = coarse && !!ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && !/^(button|checkbox|radio|file|submit)$/.test(ae.type)))
  // With no field focused there is no keyboard, so innerHeight is the full height:
  // a visual viewport that fills it is not panned, whatever offsetTop says.
  const full = !typing && vv.height >= innerHeight - 1
  // Keyboard-up signal. innerHeight is not a stable baseline on iOS while typing (it
  // can shrink with the keyboard too), so compare against the visual viewport's height
  // at this width with no keyboard, and also treat a focused text field on a touch
  // screen as keyboard-up. A full, keyboard-less reading resets the baseline, so a
  // height caught mid-rotation can't stick to the new orientation.
  if (innerWidth !== vvBase.w) { vvBase.w = innerWidth; vvBase.h = 0 }
  vvBase.h = full ? vv.height : Math.max(vvBase.h, vv.height)
  const kb = vv.height < vvBase.h * 0.8 || typing
  // With no keyboard the shell is plain 100dvh, which iOS keeps right by itself. A measured
  // height is written only while the visual viewport is shorter: a stale reading (seen after
  // a resume) once left the shell taller than the screen, the composer off the bottom and the
  // list unable to scroll.
  const h = full ? 0 : Math.round(Math.min(vv.height, innerHeight)), top = full ? 0 : Math.max(0, Math.round(vv.offsetTop))
  if (full && (scrollX || scrollY)) scrollTo(0, 0) // a page left scrolled by a rotation or the keyboard
  if (h !== vvLast.h) { vvLast.h = h; h ? root.style.setProperty('--app-h', `${h}px`) : root.style.removeProperty('--app-h') }
  // 100dvh itself can go stale: after a full-screen video iOS has left it taller than the
  // screen, with the composer off the bottom and the list unable to reach its end. Check
  // the shell against the screen and pin it to the measured height when it overflows.
  if (full && !h && appEl.offsetHeight > Math.round(vv.height) + 1) { vvLast.h = Math.round(vv.height); root.style.setProperty('--app-h', `${vvLast.h}px`) }
  if (top !== vvLast.top) { vvLast.top = top; root.style.setProperty('--app-top', `${top}px`) }
  if (kb !== vvLast.kb) { vvLast.kb = kb; root.classList.toggle('kb', kb) }
}
// After a rotation iOS reports the new viewport in steps, and not always with a
// visualViewport event at the end; read it again until it has settled.
let settleTimers = []
function resettle() {
  syncViewport()
  for (const t of settleTimers) clearTimeout(t)
  settleTimers = [120, 350, 800].map(ms => setTimeout(syncViewport, ms))
}
vv?.addEventListener('resize', syncViewport)
vv?.addEventListener('scroll', syncViewport)
addEventListener('resize', resettle)
addEventListener('orientationchange', resettle)
screen.orientation?.addEventListener?.('change', resettle)
document.addEventListener('visibilitychange', () => { if (!document.hidden) resettle() })
addEventListener('pageshow', resettle)
// Leaving iOS's full-screen video player doesn't always fire a resize. These don't bubble: capture them.
document.addEventListener('webkitendfullscreen', resettle, true)
document.addEventListener('fullscreenchange', resettle)
document.addEventListener('webkitfullscreenchange', resettle)
document.addEventListener('focusin', syncViewport)
// A video leaving full screen or stopping is when the stale height has shown up; recheck then,
// and whenever a drag starts, so a list that can't scroll is fixed by the first try.
document.addEventListener('pause', resettle, true)
document.addEventListener('ended', resettle, true)
list.addEventListener('touchstart', syncViewport, { passive: true })
document.addEventListener('focusout', () => setTimeout(syncViewport, 50))
syncViewport()

// A one-finger drag that doesn't start inside something scrollable would pan the
// whole page on iOS (the shell is fixed, so there is nothing to scroll there).
// Walk up from the target: any element that can actually scroll keeps the drag.
function canScroll(el) {
  const cs = getComputedStyle(el)
  const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1
  const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1
  return y || x
}
document.addEventListener('touchmove', e => {
  if (e.touches.length !== 1) return
  for (let el = e.target; el && el !== document.body; el = el.parentElement) {
    if (el.matches('.viewer-stage, textarea') || canScroll(el)) return // the viewer handles its own gestures
  }
  e.preventDefault()
}, { passive: false })

// ---------- notifications ----------
const b64ToBytes = s => { const p = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(p), c => c.charCodeAt(0)) }
async function pushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return reg ? reg.pushManager.getSubscription() : null
}
/** Asks for permission and subscribes. Call it straight from a tap (iOS wants the gesture). */
async function turnOnNotifications() {
  if (isIOS && !standalone) return toast(S.installHint, 8000)
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return toast(S.notifyUnsupported)
  const existing = await pushSubscription()
  if (existing && Notification.permission === 'granted') return toast(S.notifyOn)
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return toast(S.notifyDenied)
  try {
    const reg = await navigator.serviceWorker.ready
    const { key } = await api('api/push/key')
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) })
    await api('api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) })
    toast(S.notifyOn)
  } catch (e) { toast(String(e.message ?? e)) }
}

// ---------- passkey lock ----------
// The server holds the lock (see hub/lock.ts); this shows the lock screen on a 401 and
// runs Face ID. WebAuthn wants the prompt to start inside the tap, so the options are
// fetched ahead of time and navigator.credentials.* is called without an await before it.
const lockState = { enabled: false, unlocked: true, idleMin: 5, hiddenAt: Date.now(), opts: null, regOpts: null, waiters: [] }
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const credJSON = c => c.toJSON?.() ?? {
  id: c.id, rawId: b64u(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: c.getClientExtensionResults(),
  response: c.response.attestationObject
    ? { clientDataJSON: b64u(c.response.clientDataJSON), attestationObject: b64u(c.response.attestationObject), transports: c.response.getTransports?.() ?? [] }
    : { clientDataJSON: b64u(c.response.clientDataJSON), authenticatorData: b64u(c.response.authenticatorData), signature: b64u(c.response.signature), userHandle: c.response.userHandle ? b64u(c.response.userHandle) : undefined },
}
const withIds = list => (list ?? []).map(c => ({ ...c, id: b64ToBytes(c.id) }))

// Challenges expire on the server after 5 min, so they're refreshed every 4.
async function prefetchLock() {
  try {
    if (lockState.enabled) lockState.opts = { ...await api('api/auth/login/options', { method: 'POST', body: '{}' }), at: Date.now() }
    else lockState.regOpts = { ...await api('api/auth/register/options', { method: 'POST', body: '{}' }), at: Date.now() }
  } catch {}
}
const fresh = o => o && Date.now() - o.at < 4 * 60_000 ? o : null
setInterval(() => { if (!document.hidden && window.PublicKeyCredential) prefetchLock() }, 4 * 60_000)
async function loadLock() {
  try {
    const st = await api('api/auth/status')
    lockState.enabled = st.enabled; lockState.unlocked = st.unlocked; lockState.idleMin = st.idle_min
    lockState.passkeys = st.passkeys ?? []
  } catch {}
  await prefetchLock()
}

/** Face ID → a fresh assertion. Resolves when the server accepted it. */
function stepUp() {
  const o = fresh(lockState.opts)
  lockState.opts = null
  if (!o) { prefetchLock(); return Promise.reject(new Error('not ready')) }
  delete o.at
  return navigator.credentials.get({ publicKey: { ...o, challenge: b64ToBytes(o.challenge), allowCredentials: withIds(o.allowCredentials) } })
    .then(c => api('api/auth/login/verify', { method: 'POST', body: JSON.stringify({ response: credJSON(c) }) }))
    .then(r => { rememberPasskey(r?.id); return r })
    .finally(prefetchLock)
}
// The passkey this browser last unlocked with: Settings marks it "This device".
const PASSKEY_KEY = 'hub-passkey'
function rememberPasskey(id) { if (typeof id === 'string') try { localStorage.setItem(PASSKEY_KEY, id) } catch {} }
function thisPasskey() { try { return localStorage.getItem(PASSKEY_KEY) } catch { return null } }

function showLock() {
  lockState.enabled = true
  if (!lockState.unlocked && !$('lock-screen').hidden) return
  lockState.unlocked = false
  es?.close()
  // The button waits for a fresh challenge, so the tap can go straight to Face ID.
  if (!fresh(lockState.opts)) { $('lock-unlock').disabled = true; prefetchLock().finally(() => { $('lock-unlock').disabled = false }) }
  $('lock-title').textContent = `${$('app').dataset.name} · ${S.locked}`
  $('lock-unlock').textContent = S.unlock
  $('lock-error').textContent = ''
  $('lock-screen').hidden = false
}
/** Resolves once unlocked: right away when the lock is off. */
const unlocked = () => lockState.unlocked ? Promise.resolve() : new Promise(r => lockState.waiters.push(r))
$('lock-unlock').onclick = () => {
  $('lock-error').textContent = ''
  stepUp().then(() => {
    lockState.unlocked = true
    $('lock-screen').hidden = true
    reloadMedia()
    const w = lockState.waiters.splice(0)
    if (w.length) w.forEach(r => r())
    else { lastResume = 0; resume(); loadConfig() }
  }, () => { $('lock-error').textContent = S.unlockFailed })
}

async function lockNow() {
  await api('api/auth/lock', { method: 'POST', body: '{}' }).catch(() => {})
  showLock()
}
/** Registers a passkey: the first one turns the lock on. Call it straight from a tap. */
function registerPasskey(okText) {
  const o = fresh(lockState.regOpts)
  lockState.regOpts = null
  const failed = okText ? S.passkeyAddFailed : S.lockSetupFailed
  if (!o) { prefetchLock(); if (settingsSheet.open) renderSettings(); return toast(failed) }
  delete o.at
  // Adding "this device": ask for the device's own authenticator, or a browser offers a phone QR.
  const authenticatorSelection = okText ? { ...o.authenticatorSelection, authenticatorAttachment: 'platform' } : o.authenticatorSelection
  navigator.credentials.create({ publicKey: { ...o, authenticatorSelection, challenge: b64ToBytes(o.challenge), user: { ...o.user, id: b64ToBytes(o.user.id) }, excludeCredentials: withIds(o.excludeCredentials) } })
    .then(c => api('api/auth/register/verify', { method: 'POST', body: JSON.stringify({ response: credJSON(c), name: isIOS ? 'iPhone' : /Mac/.test(navigator.platform) ? 'Mac' : navigator.platform }) }))
    .then(async r => { rememberPasskey(r?.id); await loadLock(); toast(okText ?? S.lockOn(lockState.idleMin), 5000); if (settingsSheet.open) renderSettings() },
      e => { prefetchLock(); toast(e?.name === 'InvalidStateError' ? S.passkeyExists : failed, 5000); if (settingsSheet.open) renderSettings() })
}
/** Adding a passkey takes two taps: browsers want a tap right before each passkey prompt. */
function confirmAddPasskey() {
  stepUp()
    .then(() => api('api/auth/register/options', { method: 'POST', body: '{}' }))
    .then(o => { lockState.regOpts = { ...o, at: Date.now() }; if (settingsSheet.open) renderSettings() })
    .catch(() => toast(S.passkeyAddFailed))
}

// ---------- passkeys in Settings: tap one to rename or remove it ----------
// Both need a fresh Face ID, which has to start inside the tap (stepUp first, no await before it).
// The last passkey can't be removed here: that would turn the lock off (the hub machine does that).
const keyEdit = { id: null, confirm: false, focus: false }
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12M10 10.5v6M14 10.5v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
function passkeyRows(p, count) {
  const mine = p.id === thisPasskey()
  const name = p.name || S.passkeys
  const dates = S.passkeyLine(shortDate(p.created), shortDate(p.last_used))
  const tag = mine ? h('span', { class: 'key-mine' }, S.thisDevice) : null
  const close = () => { keyEdit.id = null; keyEdit.confirm = false; renderSettings() }
  if (keyEdit.id !== p.id) {
    return [h('button', { type: 'button', class: 'set-row set-row-btn', 'aria-expanded': 'false',
      onclick: () => { keyEdit.id = p.id; keyEdit.confirm = false; keyEdit.focus = true; renderSettings() } },
      h('span', { class: 'set-label' }, h('span', {}, name, tag), h('span', { class: 'set-sub' }, dates)))]
  }
  // Tapped: the row itself turns into the editor (or the remove question).
  if (keyEdit.confirm) {
    return [h('div', { class: 'set-row key-edit' },
      h('span', { class: 'set-sub key-ask' }, S.removePasskeyAsk(name, mine)),
      h('span', { class: 'key-btns' },
        h('button', { type: 'button', class: 'set-btn plain', onclick: () => { keyEdit.confirm = false; renderSettings() } }, S.cancel),
        h('button', { type: 'button', class: 'set-btn danger', onclick: () => removePasskey(p, mine) }, S.remove)))]
  }
  // Save shows only once the name was changed; Remove is a trash icon (it still asks first).
  const save = h('button', { type: 'button', class: 'set-btn plain', hidden: true, onclick: () => renamePasskey(p, input.value) }, S.save)
  const changed = () => { const v = input.value.trim(); return !!v && v !== (p.name ?? '') }
  const input = h('input', { class: 'key-name', type: 'text', value: p.name ?? '', maxlength: '60', 'aria-label': S.passkeyName, enterkeyhint: 'done',
    oninput: () => { save.hidden = !changed() },
    onkeydown: e => {
      if (e.key === 'Enter') { e.preventDefault(); renamePasskey(p, input.value) }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    },
    // Leaving the field unchanged puts the row back (after a beat, so a tap on the trash lands first).
    onblur: () => setTimeout(() => {
      if (keyEdit.id === p.id && !keyEdit.confirm && !changed() && !row.contains(document.activeElement) && row.isConnected) close()
    }, 250) })
  let trash = null
  if (count > 1) {
    trash = h('button', { type: 'button', class: 'icon-btn key-trash', 'aria-label': S.removePasskey, onclick: () => { keyEdit.confirm = true; renderSettings() } })
    trash.innerHTML = ICON_TRASH
  }
  // Field and buttons on one line, so Save and the trash line up with the field; the dates go under it.
  const row = h('div', { class: 'set-row key-edit key-editor' },
    h('span', { class: 'key-line' }, input, h('span', { class: 'key-btns' }, save, trash)),
    h('span', { class: 'set-sub' }, count > 1 ? dates : S.lastPasskey))
  if (keyEdit.focus) { keyEdit.focus = false; requestAnimationFrame(() => input.focus()) }
  return [row]
}
function keyAction(path, body, done) {
  stepUp()
    .then(() => api(path, { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify(body) }))
    .then(async r => { keyEdit.id = null; keyEdit.confirm = false; await loadLock(); done(r); if (settingsSheet.open) renderSettings() })
    .catch(e => toast(e?.body?.code === 'last_passkey' ? S.lastPasskey : e?.message === 'not ready' ? S.tryAgain : S.passkeyChangeFailed, 5000))
}
function renamePasskey(p, value) {
  const name = value.trim()
  if (!name || name === p.name) { keyEdit.id = null; return renderSettings() }
  keyAction('api/auth/passkeys/rename', { id: p.id, name }, () => toast(S.passkeyRenamed))
}
function removePasskey(p, mine) {
  keyAction('api/auth/passkeys/remove', { id: p.id }, () => {
    if (mine) try { localStorage.removeItem(PASSKEY_KEY) } catch {}
    toast(S.passkeyRemoved(mine), 8000)
  })
}

// ---------- the app's icon: the mark made from the agent's name, and a seed for another one ----------
// Seed 0 is the name's own; Settings shows nine at a time to pick from. The hub draws every
// icon (SVG and PNG) from the seed, so changing it changes the header, the sidebar, the
// favicon and the icon offered when the app is added to the Home Screen.
const iconPick = { seed: 0, open: false, from: 0 }
async function loadIcon() { try { iconPick.seed = (await api('api/icon')).seed ?? 0 } catch {} }
function iconChanged(seed) {
  iconPick.seed = seed
  // Reload every picture of the app's own icon (the hub serves them fresh).
  for (const img of document.querySelectorAll('img[src*="icons/"]')) img.src = img.src.replace(/\?v=\d+$/, '') + `?v=${seed}`
  for (const l of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')) l.href = l.href.replace(/\?v=\d+$/, '') + `?v=${seed}`
  if (settingsSheet.open) renderSettings()
}
async function setIcon(seed) {
  try {
    await api('api/icon', { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify({ seed }) })
    iconPick.open = false
    iconChanged(seed)
    toast(S.iconSet, 6000)
  } catch { toast(S.iconFailed) }
}
// Which turns are taken already: projects showing a mark made from their name. A variant on the
// same turn has the same colour too (one angle sets both), so the grid says which it matches.
function takenTurns() {
  const taken = new Map()
  for (const p of projectList()) if (!p.icon && p.key !== selfName()) taken.set(markParams(p.name).angle, p.name)
  return taken
}
const iconLine = seed => seed === ORIGINAL_SEED ? S.iconOriginal : seed ? S.iconSeedLine(seed) : S.iconFromName
function appearanceRows() {
  const name = $('app').dataset.name
  const cur = h('img', { class: 'icon-now', src: markDataUrl(name, iconPick.seed), alt: '', width: 32, height: 32 })
  const rows = [setRow(S.appIcon, h('span', { class: 'icon-pick-now' }, cur,
    h('button', { type: 'button', class: 'set-btn plain', 'aria-expanded': String(iconPick.open), onclick: () => { iconPick.open = !iconPick.open; iconPick.from = 0; renderSettings() } }, iconPick.open ? S.done : S.change)),
    iconLine(iconPick.seed))]
  if (!iconPick.open) return rows
  const seeds = Array.from({ length: 9 }, (_, i) => iconPick.from + i)
  const taken = takenTurns()
  const choice = (seed, label) => {
    const clash = seed === ORIGINAL_SEED ? null : taken.get(markParams(name, seed).angle)
    return h('button', { type: 'button', class: `icon-choice${seed === iconPick.seed ? ' on' : ''}${clash ? ' clash' : ''}`, role: 'radio', 'aria-checked': String(seed === iconPick.seed),
      'aria-label': label + (clash ? `. ${S.iconClash(clash)}` : ''), title: clash ? S.iconClash(clash) : null, onclick: () => setIcon(seed) },
      h('img', { src: markDataUrl(name, seed), alt: '', width: 56, height: 56 }),
      clash ? h('span', { class: 'icon-clash' }, S.iconLike(clash)) : null)
  }
  rows.push(h('div', { class: 'set-row icon-grid-row' },
    h('div', { class: 'icon-grid', role: 'radiogroup', 'aria-label': S.appIcon }, seeds.map(seed => choice(seed, iconLine(seed)))),
    h('div', { class: 'icon-original' }, choice(ORIGINAL_SEED, S.iconOriginal), h('span', { class: 'set-sub' }, S.iconOriginal)),
    h('span', { class: 'icon-grid-more' },
      iconPick.from ? h('button', { type: 'button', class: 'set-btn plain', onclick: () => { iconPick.from = Math.max(0, iconPick.from - 9); renderSettings() } }, S.iconLess) : null,
      h('button', { type: 'button', class: 'set-btn plain', onclick: () => { iconPick.from += 9; renderSettings() } }, S.iconMore))))
  return rows
}

// ---------- settings: a sheet from the title ----------
const shortDate = ts => ts ? dayFmt.format(new Date(ts)) : ''
async function notifyStatus() {
  if (isIOS && !standalone) return 'install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const sub = await pushSubscription().catch(() => null)
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}
const setRow = (label, value, sub) => h('div', { class: 'set-row' },
  h('span', { class: 'set-label' }, label, sub ? h('span', { class: 'set-sub' }, sub) : null),
  value == null ? null : typeof value === 'string' ? h('span', { class: 'set-value' }, value) : value)
const section = (title, rows, note) => h('section', { class: 'set-section' }, h('h3', {}, title), h('div', { class: 'set-group' }, rows), note ? h('p', { class: 'set-note' }, note) : null)
async function renderSettings() {
  const [ns, version] = await Promise.all([
    notifyStatus(),
    caches.keys().then(k => k.find(x => x.startsWith('shell-')) ?? '').catch(() => ''),
  ])
  const lockRows = [setRow(S.faceIdLock,
    !window.PublicKeyCredential ? S.lockUnsupported
      : lockState.enabled ? h('button', { type: 'button', class: 'set-btn plain', onclick: () => { settingsSheet.hide(); lockNow() } }, S.lockNow)
      : h('button', { type: 'button', class: 'set-btn', onclick: () => registerPasskey() }, S.turnOn),
    S.lockStatus(lockState.enabled, lockState.idleMin))]
  const keys = lockState.enabled ? lockState.passkeys ?? [] : []
  for (const p of keys) lockRows.push(...passkeyRows(p, keys.length))
  if (lockState.enabled && window.PublicKeyCredential) {
    const ready = fresh(lockState.regOpts)
    lockRows.push(setRow(S.addPasskeyLabel, h('button', { type: 'button', class: 'set-btn', onclick: ready ? () => registerPasskey(S.passkeyAdded) : confirmAddPasskey }, ready ? S.addThisDevice : S.addPasskey), ready ? S.addThisDeviceHint : null))
  }
  const notifyRows = [setRow(S.notifications,
    ns === 'off' ? h('button', { type: 'button', class: 'set-btn', onclick: async () => { await turnOnNotifications(); renderSettings() } }, S.turnOn) : S.notifyStatus(ns))]
  $('settings-body').replaceChildren(
    section(S.secSecurity, lockRows, lockState.enabled ? S.lockOffHint : S.lockHint),
    section(S.secNotifications, notifyRows, ns === 'install' ? S.installHint : null),
    section(S.secAppearance, appearanceRows(), S.iconHint),
    section(S.secAbout, [
      setRow(S.version, version.replace('shell-', '') || '–'),
      setRow(S.signedIn, state.login ?? '–'),
      setRow(S.hubAddress, location.host),
    ]))
}
async function openSettings() {
  keyEdit.id = null; keyEdit.confirm = false
  iconPick.open = false
  await Promise.all([loadLock(), loadIcon()])
  await renderSettings()
  settingsSheet.show()
}
$('title-btn').onclick = openSettings
$('side-settings').onclick = openSettings // wide windows: the title chip is the phone's, the agent has its own row there
$('side-settings-label').textContent = S.settings

// ---------- toast ----------
let toastTimer
function toast(text, ms = 2500, action) {
  const t = $('toast')
  t.replaceChildren(h('span', {}, text), ...(action ? [h('button', { type: 'button', onclick: action.run }, action.label)] : []))
  t.hidden = false
  clearTimeout(toastTimer)
  if (ms) toastTimer = setTimeout(() => { t.hidden = true }, ms)
}

// ---------- service worker + update flow ----------
let waitingWorker = null
const holds = () => rec.active || !!input.value.trim() || state.composing || state.viewerOpen || uploading() || openSheets.length > 0 || search.open || panes.open
function applyPendingUpdate() {
  if (!waitingWorker || (holds() && !document.hidden)) return
  waitingWorker.postMessage({ type: 'SKIP_WAITING' })
  waitingWorker = null
}
function offerUpdate(w) {
  waitingWorker = w
  if (!holds()) return applyPendingUpdate()
  toast(S.updateReady, 0, { label: S.reload, run: () => { $('toast').hidden = true; saveDraft(); w.postMessage({ type: 'SKIP_WAITING' }) } })
}
if ('serviceWorker' in navigator) {
  addEventListener('load', async () => {
    const hadController = !!navigator.serviceWorker.controller
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) { saveDraft(); location.reload() } })
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'open') openTarget(e.data.thread ?? null, e.data.id)
      if (e.data?.type === 'open-pane' && panes.on) openPanes(e.data.pane)
    })
    try {
      const reg = await navigator.serviceWorker.register('sw.js')
      if (reg.waiting && reg.active) offerUpdate(reg.waiting)
      reg.addEventListener('updatefound', () => {
        const w = reg.installing
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && reg.active) offerUpdate(w) })
      })
    } catch {}
  })
}

async function openTarget(thread, id) {
  if (thread !== state.thread || state.blank || (panes.open && wide.matches)) await switchThread(thread)
  if (id) jumpTo(Number(id))
}

// Panes are off unless the hub has a provider; `?pane=` (from a push) opens one.
async function loadConfig(pane) {
  try {
    const c = await api('api/config')
    state.login = c.login
    dictation.on = !!c.dictation; dictation.refine = !!c.refine
    $('rec-refine').hidden = !dictation.on
    // A tool on this app's own origin is never framed (see openTool).
    tools.list = (Array.isArray(c.tools) ? c.tools : []).filter(t => t && t.origin !== location.origin)
    tools.user = c.user_name || 'You'
    tools.agent = { id: c.agent_id || 'agent', name: c.name || '' }
    if (tools.list.length) renderThreads()
    panes.on = !!c.panes
    panes.shellsOn = c.shells === true
    panes.shellShare = c.shell_share === true
    $('panes-btn').hidden = !panes.on
    if (!panes.on) return
    await loadPanes()
    if (pane) {
      openPanes(pane)
      const u = new URL(location.href); u.searchParams.delete('pane'); history.replaceState(null, '', u)
    } else if (wide.matches && state.home) openHome(state.home) // its remembered session may be back
  } catch {}
}

// ---------- tools: a topic's tool (Board, the whiteboard, say), embedded ----------
// Each tool runs on its own origin and talks over postMessage, protocol `bebop-tool` v1 (SPEC.md,
// Tools): it says hello until we init it, then ready; status is a short line; a post goes into the
// topic as the user (files attached) and is acked within 10 s. Board's own `board-host` v1 bridge is
// still accepted from the "board" tool until Board speaks bebop-tool. Messages count only from the
// tool's origin and from this iframe's window; we answer only to that origin.
const tools = { list: [], user: 'You', agent: { id: 'agent', name: '' } }
// A project tool (scope "project") opens at a page: the topic's id, or "overview" from the project's
// header (then thread is null, project is the key, and from is the topic shown when it opened).
const panel = { tool: null, thread: null, project: null, page: null, from: null, instance: null, origin: null, frame: null, ready: false, link: null, status: null, timer: 0 }
const OVERVIEW_PAGE = 'overview'
const TOOL_ACK_MS = 9000
const TOOL_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads'
const TOOL_FILES_MAX = 4, TOOL_BYTES_MAX = 10 * 1024 * 1024
const TOOL_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/json', 'text/plain'])
const TOOL_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'application/json': '.json', 'text/plain': '.txt' }
const ICON_TOOL = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/><rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/><rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M16.5 13.5v6M13.5 16.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
const toolById = id => tools.list.find(t => t.id === id)
const httpUrlOn = (s, origin) => { try { const u = new URL(s); return u.origin === origin ? u.href : null } catch { return null } }

const toolIconEl = t => t.icon ? h('img', { class: 'context-icon', src: t.icon, alt: '' }) : h('span', { class: 'context-icon', 'aria-hidden': 'true', html: t.id === 'board' ? ICON_BOARD : ICON_TOOL })
// One context-bar button per tool.
function toolButtons(cur) {
  return tools.list.map(t => {
    const on = panel.tool === t.id && panel.thread === cur.id
    return h('button', { type: 'button', class: `context-btn tool-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: () => toggleTool(t.id, cur.id) }, t.name, toolIconEl(t))
  })
}
// A project's header: one button per project tool, opening its overview page.
function projectToolButtons(key, name) {
  const list = tools.list.filter(t => t.scope === 'project')
  if (!list.length) return null
  return h('span', { class: 'home-tools' }, ...list.map(t => {
    const on = panel.tool === t.id && panel.thread == null && panel.project === key
    return h('button', { type: 'button', class: `context-btn tool-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), title: S.toolOverview(t.name, name),
      onclick: () => on ? closeTool() : openProjectTool(t.id, key, name) }, t.name, toolIconEl(t))
  }))
}
function toggleTool(id, thread) {
  if (panel.tool === id && panel.thread === thread) return closeTool()
  openTool(id, thread)
}
async function openTool(id, thread) {
  const tool = toolById(id)
  if (!tool || !thread) return
  let r
  try { r = await api(`api/threads/${encodeURIComponent(thread)}/tools/${id}`, { method: 'POST', headers: { 'x-hub-action': '1' } }) } catch { return toast(S.toolFailed(tool.name)) }
  if (state.thread !== thread) return // moved on while it was asked for
  showTool(tool, r, { thread })
}
// From the project's header: the project tool's overview page. On the phone it covers the Topics sheet.
async function openProjectTool(id, key, name) {
  const tool = toolById(id)
  if (!tool || !key) return
  let r
  try { r = await api(`api/projects/${encodeURIComponent(key)}/tools/${id}`, { method: 'POST', headers: { 'x-hub-action': '1' }, body: JSON.stringify({ name }) }) } catch { return toast(S.toolFailed(tool.name)) }
  if (!wide.matches && topicsSheet.open) topicsSheet.hide()
  showTool(tool, r, { thread: null, project: key, from: state.thread })
}
function showTool(tool, r, at) {
  const id = tool.id, thread = at.thread
  if (panel.tool === id && panel.instance === r.instance && panel.page === (r.page ?? null) && panel.thread === thread) return
  // Never this app's origin: a same-origin frame could call our /api as the user.
  const src = httpUrlOn(r.frame, tool.origin)
  if (!src || tool.origin === location.origin) return toast(S.toolFailed(tool.name))
  const project = at.project ?? (r.scope === 'project' ? projectKey(state.threads.find(t => t.id === thread)?.project) || null : null)
  Object.assign(panel, { tool: id, thread, project, page: r.page ?? null, from: at.from ?? null, instance: r.instance, origin: tool.origin, ready: false, status: null, link: httpUrlOn(r.link, tool.origin) ?? src })
  const frame = h('iframe', { src, sandbox: TOOL_SANDBOX, allow: tool.allow.join('; ') || null, referrerpolicy: 'origin', title: tool.name })
  panel.frame = frame
  $('tool-frame').replaceChildren(frame)
  clearTimeout(panel.timer)
  panel.timer = setTimeout(() => { if (panel.frame === frame && !panel.ready) renderToolHead(S.toolNoAnswer(tool.name)) }, 12000)
  $('tool').hidden = false
  $('app').classList.add('tool-on')
  loadColumns()
  syncToolModal()
  renderToolHead()
  renderThreads()
}
function closeTool() {
  if (!panel.tool) return
  Object.assign(panel, { tool: null, thread: null, project: null, page: null, from: null, instance: null, origin: null, frame: null, ready: false, status: null, link: null })
  clearTimeout(panel.timer)
  $('tool-frame').replaceChildren()
  $('tool').hidden = true
  $('app').classList.remove('tool-on')
  syncToolModal()
  renderThreads()
}
// The panel follows the topic: another topic opens the same tool there (a project tool at that
// topic's page), anything else closes it. An overview stays until another topic is picked.
function syncTool() {
  if (!panel.tool || panel.thread === state.thread) return
  if (panel.thread == null && panel.page === OVERVIEW_PAGE && panel.from === state.thread) return
  const t = state.threads.find(x => x.id === state.thread)
  if (t && !state.blank && !(panes.open && wide.matches) && toolById(panel.tool)) openTool(panel.tool, t.id)
  else closeTool()
}
// On the phone it's a full-screen sheet: the app behind it is inert.
function syncToolModal() {
  const modal = !!panel.tool && !wide.matches
  $('app').inert = modal
  $('side').inert = modal
}
wide.addEventListener('change', syncToolModal)
function renderToolHead(note) {
  const tool = toolById(panel.tool)
  const name = tool?.name ?? ''
  const t = state.threads.find(x => x.id === panel.thread)
  // A project tool's overview is named by its project, also when opened from the overview's own topic.
  const proj = panel.project ?? (t?.project ? projectKey(t.project) : null)
  $('tool-title').textContent = panel.page === OVERVIEW_PAGE && proj ? `${name} · ${S.projectName(proj)}` : t ? `${name} · ${t.title}` : name
  $('tool-status').textContent = note ?? (!panel.ready ? S.toolConnecting : panel.status?.text ?? '')
  $('tool-status').classList.toggle('busy', !!panel.status?.busy)
  $('tool-open').href = panel.link ?? '#'
  $('tool-close').setAttribute('aria-label', S.toolClose(name))
}
$('tool-open').textContent = S.toolOpen
$('tool-close').onclick = closeTool
addEventListener('keydown', e => { if (e.key === 'Escape' && panel.tool && !wide.matches) closeTool() })

addEventListener('message', e => {
  const frame = panel.frame
  if (!frame || e.origin !== panel.origin || e.source !== frame.contentWindow) return
  const d = e.data
  if (!d || typeof d !== 'object' || d.v !== 1 || typeof d.type !== 'string') return
  if (d.protocol === 'bebop-tool') onToolMessage(e.source, d)
  else if (d.protocol === 'board-host' && panel.tool === 'board') onBoardHost(e.source, d)
})
// The page a tool opened at, for its init: the id it posts back as ref.page, and a title to name it by.
function toolPage() {
  if (panel.page === OVERVIEW_PAGE && panel.thread == null) return { id: OVERVIEW_PAGE, title: S.overviewPage }
  const t = state.threads.find(x => x.id === panel.thread)
  return { id: panel.page, title: panel.page === OVERVIEW_PAGE ? S.overviewPage : t?.title ?? panel.page }
}
function toolSend(win, protocol, msg) { win.postMessage({ protocol, v: 1, ...msg }, panel.origin) }
// The ack must reach the tool within 10 s; a post that takes longer is reported as failed.
// The ack goes back once the post is in the topic (or refused): a queued post waits for its turn first.
function ackedPost(post, ack) {
  const tool = toolById(panel.tool), thread = panel.thread, instance = panel.instance
  postToolEvent(tool, thread, instance, post).then(() => ack(true), err => ack(false, String(err?.message ?? err).slice(0, 200)))
}

function onToolMessage(win, d) {
  const P = 'bebop-tool'
  if (d.type === 'hello') {
    if (!Array.isArray(d.versions) || !d.versions.includes(1)) return
    // A project tool's page, and its title at the top level too (Board names its page from it).
    const page = panel.page != null ? toolPage() : null
    toolSend(win, P, { type: 'init', instance: panel.instance, ...(page ? { page, title: page.title } : {}), agent: { ...tools.agent }, user: { name: tools.user } })
  } else if (d.type === 'ready') {
    panel.ready = true
    const link = typeof d.link === 'string' && httpUrlOn(d.link, panel.origin)
    if (link) panel.link = link
    renderToolHead()
  } else if (d.type === 'status') {
    panel.ready = true
    panel.status = { text: typeof d.text === 'string' ? d.text.replace(/\s+/g, ' ').trim().slice(0, 80) : '', busy: d.busy === true }
    renderToolHead()
  } else if (d.type === 'post' && typeof d.id === 'string' && d.id.length <= 100) {
    ackedPost(d, (ok, error) => toolSend(win, P, { type: 'post-ack', id: d.id, ok, ...(error ? { error } : {}) }))
  }
}

// Board's host bridge v1 (docs/host-bridge.md in Board), mapped onto the generic post.
function onBoardHost(win, d) {
  const P = 'board-host'
  if (d.type === 'hello') {
    if (!Array.isArray(d.versions) || !d.versions.includes(1)) return
    toolSend(win, P, { type: 'init', deliver: [tools.agent.id], defaultAnswerer: tools.agent.id, user: { name: tools.user } })
  } else if (d.type === 'ready') {
    onToolMessage(win, { type: 'ready', link: d.link })
  } else if (d.type === 'status') {
    const n = Number(d.openThreads) || 0
    panel.ready = true
    panel.status = { text: [d.drawing ? S.boardDrawing : null, S.boardThreads(n)].filter(Boolean).join(' · '), busy: !!d.drawing }
    renderToolHead()
  } else if (d.type === 'comment' && typeof d.id === 'string') {
    const ack = (ok, error) => toolSend(win, P, { type: 'comment-ack', id: d.id, ok, ...(error ? { error } : {}) })
    const ctx = d.context
    if (!ctx || typeof ctx !== 'object' || ctx.boardId !== panel.instance) return ack(false, 'not this board')
    const { snapshot, ...rest } = ctx
    const files = [...(snapshot ? [{ name: 'board-snapshot.png', mime: 'image/png', data: snapshot }] : []), { name: 'board-context.json', mime: 'application/json', data: rest }]
    const text = String(ctx.text ?? '').trim()
    ackedPost({ text: Number.isInteger(ctx.threadNumber) ? `#${ctx.threadNumber}: ${text}` : text, link: ctx.link, files,
      ref: { thread: ctx.threadId, number: ctx.threadNumber }, key: ctx.commentId }, ack)
  }
}

// Posting limits per tool: one every 2 s (sooner ones queue, up to 5), 20 a minute at most (web/limits.js).
const toolLimits = postLimiter({ gapMs: 2000, perMin: 20, queueMax: 5 })
function dataUrlBlob(url) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url ?? '')
  if (!m) return null
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]))
  return new Blob([bytes], { type: m[1] })
}
function toolFile(f, i, tool) {
  const mime = String(f?.mime ?? '')
  if (!TOOL_MIMES.has(mime)) throw new Error(`file type not allowed: ${mime.slice(0, 40)}`)
  let blob = null
  if (typeof f.data === 'string' && f.data.startsWith('data:')) blob = dataUrlBlob(f.data)
  else if (mime === 'application/json') blob = new Blob([typeof f.data === 'string' ? f.data : JSON.stringify(f.data, null, 2)])
  else if (mime === 'text/plain' && typeof f.data === 'string') blob = new Blob([f.data])
  if (!blob || (blob.type && blob.type !== mime)) throw new Error('bad file data')
  const name = (typeof f.name === 'string' ? f.name.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 100) : '') || `${tool.id}-${i + 1}${TOOL_EXT[mime]}`
  return { blob: new Blob([blob], { type: mime }), name }
}
// The message's client_id makes a resent post a no-op; hashed, so a long instance or key can't be cut into a collision.
async function toolClientId(id, instance, key) {
  const k = `${instance}:${typeof key === 'string' && key ? key.slice(0, 200) : crypto.randomUUID()}`
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k)))
    return `tool:${id}:${[...hash.slice(0, 20)].map(b => b.toString(16).padStart(2, '0')).join('')}`
  } catch { return `tool:${id}:${k}`.slice(0, 64) }
}
async function postToolEvent(tool, thread, instance, p) {
  // A project tool's post may come from its overview, with no topic: the hub puts it where its page says.
  if (!tool || !instance || (!thread && tool.scope !== 'project')) throw new Error('no topic')
  const given = Array.isArray(p.files) ? p.files : []
  if (given.length > TOOL_FILES_MAX) throw new Error(`at most ${TOOL_FILES_MAX} files`)
  const files = given.map((f, i) => toolFile(f, i, tool))
  if (files.reduce((n, f) => n + f.blob.size, 0) > TOOL_BYTES_MAX) throw new Error('files too large (10 MB in all)')
  const text = typeof p.text === 'string' ? p.text.trim().slice(0, 4000) : ''
  if (!text && !files.length) throw new Error('empty post')
  // Checked first, then in line: a post within 2 s of the last waits here, and is timed from when it leaves.
  await toolLimits.slot(tool.id)
  let late
  const deadline = new Promise((_, no) => { late = setTimeout(() => no(new Error('timed out')), TOOL_ACK_MS) })
  try { await Promise.race([sendToolPost(tool, thread, instance, p, files, text), deadline]) } finally { clearTimeout(late) }
}
async function sendToolPost(tool, thread, instance, p, files, text) {
  let ids = []
  if (files.length) {
    const fd = new FormData()
    for (const f of files) fd.append('file', f.blob, f.name)
    const up = await fetch('api/upload', { method: 'POST', body: fd })
    if (up.status === 401) showLock()
    if (up.status !== 201) throw new Error(`upload failed (HTTP ${up.status})`)
    ids = (await up.json()).map(f => f.id)
  }
  const link = (typeof p.link === 'string' && httpUrlOn(p.link, tool.origin)) || (panel.instance === instance ? panel.link : null)
  const ref = p.ref && typeof p.ref === 'object' && !Array.isArray(p.ref) ? p.ref : {}
  const res = await api('api/messages', { method: 'POST', body: JSON.stringify({
    kind: 'text', thread, text: `${S.toolPost(tool.name, text)}${link ? `\n\n${link}` : ''}`, files: ids,
    tool: { id: tool.id, instance, ref, ...(link ? { link } : {}) },
    client_id: await toolClientId(tool.id, instance, p.key),
  }) })
  if (res?.id) upsert(res)
}

// ---------- boot ----------
async function boot() {
  const u = new URL(location.href)
  state.thread = u.searchParams.get('thread') || null
  await loadLock()
  if (lockState.enabled && !lockState.unlocked) { showLock(); await unlocked() }
  restoreDraft()
  renderAtts()
  await loadThreads()
  renderThreads()
  loadLists()
  loadPresence()
  loadConfig(u.searchParams.get('pane'))
  await loadLatest().catch(() => { renderAll() })
  if (wide.matches && u.searchParams.get('project')) openHome({ kind: 'project', key: u.searchParams.get('project') })
  if (wide.matches && u.searchParams.get('view') === 'needs') openHome({ kind: 'needs' })
  if (wide.matches && u.searchParams.get('view') === 'sessions') openHome({ kind: 'sessions' })
  const target = /^#m(\d+)$/.exec(location.hash)
  if (target) jumpTo(Number(target[1]))
  connect()
  flushOutbox()
}
boot()

// Exposed for tests and debugging.
window.__hub = { state, selectSession, setPresenceState, setTasks, panes, setPanes, setPeers, openHome, openTopicsSheet, switchThread, openViewer, jumpTo, jumpToDate, openSearch, openPanes }
