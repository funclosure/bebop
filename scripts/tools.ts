#!/usr/bin/env bun
// bun run tools <command>: add, install, list, update and remove the hub's tools (README, Tools).
//
//   add <git-url#ref | path> --origin <origin> [--port n] [--run] [--env K=V]… [--allow perm]… [--yes]
//   install <id> [--yes]
//   list
//   update <id> [--ref ref] [--yes]
//   remove <id> [--yes]
//
// A git source is cloned (--depth 1, at the ref) into <tools dir>/tools/<id>/ and pinned to its
// commit in tools.lock.json; a folder is used in place. Nothing a tool ships runs before you
// confirm: `add` shows the manifest and the exact commands, `install` runs the install steps
// (argv lists, no shell). The hub only reads tools.json; it never adds, installs or updates a tool.
//
// The tools file is --file, else HUB_TOOLS_FILE, else data/tools.json in this checkout.
// Removed clones go to ~/.Trash (BEBOP_TRASH_DIR in tests), never rm -rf.
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { randomBytes } from 'crypto'
import {
  ToolEntry, ToolManifest, checkedOutCommit, isGitSource, lockFileFor, parseGitSource, readLock,
  toolOriginOf, toolsHomeFor, type LockEntry,
} from '../hub/tools'

class Fail extends Error {}
const fail = (m: string): never => { throw new Fail(m) }
const say = (m = '') => console.log(m)

// ---------- arguments ----------

type Flags = { origin?: string; port?: number; run?: boolean; env: Record<string, string>; allow: string[]; yes: boolean; ref?: string; file?: string }
function parseArgs(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const flags: Flags = { env: {}, allow: [], yes: false }
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => argv[++i] ?? fail(`${a} needs a value`)
    if (a === '--yes' || a === '-y') flags.yes = true
    else if (a === '--run') flags.run = true
    else if (a === '--origin') flags.origin = val()
    else if (a === '--port') { const p = Number(val()); if (!Number.isInteger(p) || p < 1 || p > 65535) fail('--port: a port number'); flags.port = p }
    else if (a === '--env') { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(val()); if (!m) fail('--env: NAME=value'); flags.env[m![1]] = m![2] }
    else if (a === '--allow') flags.allow.push(val())
    else if (a === '--ref') flags.ref = val()
    else if (a === '--file') flags.file = val()
    else if (a === '-h' || a === '--help') args.unshift('help')
    else if (a.startsWith('-')) fail(`unknown option ${a}`)
    else args.push(a)
  }
  return { cmd: args.shift() ?? 'help', args, flags }
}

const HELP = `bun run tools <command>
  add <git-url#ref | path> --origin <origin> [--port n] [--run] [--env K=V]… [--allow perm]… [--yes]
      git: cloned at the ref (tag, branch or commit) into tools/<id>/ and pinned in tools.lock.json
      path: a folder with bebop-tool.json, used in place
  install <id> [--yes]     run the manifest's install steps in the tool's folder
  list                     the tools in the tools file
  update <id> [--ref r]    re-pin a git tool to the ref's current commit (asks first)
  remove <id> [--yes]      drop it from tools.json; a clone goes to ~/.Trash
Options: --file <tools.json> (default HUB_TOOLS_FILE, else data/tools.json)`

// ---------- files ----------

const repoRoot = resolve(import.meta.dir, '..')
type ToolsFile = { path: string; wrapped: boolean; list: any[] }
function readToolsFile(flags: Flags): ToolsFile {
  const path = resolve(flags.file ?? process.env.HUB_TOOLS_FILE ?? join(repoRoot, 'data', 'tools.json'))
  if (!existsSync(path)) return { path, wrapped: false, list: [] }
  let raw: any
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { fail(`${path} is not JSON: ${(e as Error).message}`) }
  if (Array.isArray(raw)) return { path, wrapped: false, list: raw }
  if (Array.isArray(raw?.tools)) return { path, wrapped: true, list: raw.tools }
  return fail(`${path} should be a list of tools`)
}
function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
const saveToolsFile = (tf: ToolsFile) => writeJson(tf.path, tf.wrapped ? { tools: tf.list } : tf.list)
const saveLock = (tf: ToolsFile, lock: Record<string, LockEntry>) => writeJson(lockFileFor(tf.path), lock)

/** Moves a path to the Trash (BEBOP_TRASH_DIR, default ~/.Trash) under a unique name. */
function trash(path: string): string {
  const dir = process.env.BEBOP_TRASH_DIR ?? join(homedir(), '.Trash')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${basename(path)}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`)
  const r = spawnSync('mv', [path, dest], { encoding: 'utf8' })
  if (r.status !== 0) fail(`couldn't move ${path} to the Trash: ${r.stderr?.trim()}`)
  return dest
}

function readManifest(dir: string): ToolManifest {
  const f = join(dir, 'bebop-tool.json')
  if (!existsSync(f)) fail(`no bebop-tool.json in ${dir}`)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { fail(`${f} is not JSON: ${(e as Error).message}`) }
  const p = ToolManifest.safeParse(raw)
  if (!p.success) fail(`bebop-tool.json: ${p.error!.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  return p.data!
}

// ---------- git ----------

function git(args: string[], cwd?: string): string {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (r.error) fail(`git: ${r.error.message}`)
  if (r.status !== 0) fail(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout.trim()
}

/** `<url>#<ref>` given on the command line → the git+ source tools.json keeps; null for a plain folder. */
function gitSourceOf(arg: string): { source: string; url: string; ref: string } | null {
  let s = arg.startsWith('git+') ? arg.slice(4) : arg
  const urlish = /^(https?|ssh|git|file):\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s)
  const hash = s.lastIndexOf('#')
  const bare = hash < 0 ? s : s.slice(0, hash)
  if (!arg.startsWith('git+') && !urlish && hash < 0 && !/\.git\/?$/.test(bare)) return null
  if (!urlish) s = 'file://' + resolve(bare) + (hash < 0 ? '' : s.slice(hash)) // a path to a repo
  const parsed = parseGitSource('git+' + s) ?? fail(`not a git source: ${arg}`)
  return { source: `git+${parsed.url}#${parsed.ref}`, ...parsed }
}

/** A shallow clone of url at ref in a new folder; returns the commit checked out. */
function fetchAt(url: string, ref: string, dir: string): string {
  mkdirSync(dirname(dir), { recursive: true })
  git(['init', '-q', dir])
  git(['fetch', '-q', '--depth', '1', '--no-tags', url, ref], dir)
  git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir)
  return git(['rev-parse', 'HEAD'], dir)
}

// ---------- showing what will run ----------

const q = (a: string) => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`
const cmdline = (argv: string[]) => argv.map(q).join(' ')

function showTool(m: ToolManifest, dir: string, entry: ToolEntry) {
  say(`\n${m.name} (${m.id}) ${m.version ?? ''}`.trimEnd())
  if (m.description) say(m.description)
  say('\nbebop-tool.json:')
  say(JSON.stringify(m, null, 2).replace(/^/gm, '  '))
  say(`\nCommands, run in ${dir} with no shell:`)
  const install = m.install ?? []
  if (install.length) install.forEach((c, i) => say(`  ${i ? '         ' : 'install: '}${cmdline(c)}`))
  else say('  install: (none)')
  const port = entry.port ?? m.serve?.port
  if (m.serve?.command) say(`  serve:   ${cmdline(m.serve.command)}  (PORT=${port ?? '?'}, health ${m.serve.health ?? '/'}) ${entry.run ? '— the hub runs it (run: true)' : '— you run it, or add --run'}`)
  else say('  serve:   (none: you run the server)')
  if (m.secrets?.length) say(`  secrets it expects in its environment: ${m.secrets.join(', ')}`)
  say(`\nOrigin: ${entry.origin}`)
  const granted = new Set(['clipboard-write', 'fullscreen', ...(entry.allow ?? [])])
  const allow = (m.frame.allow ?? []).filter(a => granted.has(a))
  if (allow.length) say(`Frame permissions: ${allow.join(', ')}`)
  const refused = (m.frame.allow ?? []).filter(a => !granted.has(a))
  if (refused.length) say(`Not granted (add --allow to grant): ${refused.join(', ')}`)
  if (entry.env && Object.keys(entry.env).length) say(`Environment: ${Object.keys(entry.env).join(', ')}`)
  say('\nA tool is code that runs as you: in the app, beside your topics, and on this machine.')
}

function confirm(question: string, flags: Flags): boolean {
  if (flags.yes) return true
  if (!process.stdin.isTTY) fail('not a terminal: read the above, then run again with --yes')
  const a = prompt(`${question} [y/N]`)
  return /^y(es)?$/i.test((a ?? '').trim())
}

/** Hub origins a tool may not use: HUB_PUBLIC_ORIGIN and the hub's own port. */
function hubOrigins(): string[] {
  const port = process.env.HUB_PORT ?? '8787'
  return [...(process.env.HUB_PUBLIC_ORIGIN ?? '').split(/[\s,]+/).filter(Boolean).map(o => { try { return new URL(o).origin } catch { return o } }),
    `http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

function originHint(port: number | undefined): string {
  let host = '<machine>.<tailnet>.ts.net'
  try {
    const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 2000 })
    const name = JSON.parse(r.stdout || '{}')?.Self?.DNSName
    if (typeof name === 'string' && name) host = name.replace(/\.$/, '')
  } catch {}
  const p = port ?? '<port>'
  return [
    '--origin is required: where the app reaches the tool, on its own origin (never a path under the hub).',
    `  On this machine only:  --origin http://localhost:${p}`,
    `  Over the tailnet:      tailscale serve --bg --https=8444 ${p}   (any free HTTPS port)`,
    `                         --origin https://${host}:8444`,
  ].join('\n')
}

// ---------- finding a tool by id ----------

type Found = { index: number; entry: ToolEntry; dir: string; manifest: ToolManifest | null; pin?: LockEntry; error?: string }
function findAll(tf: ToolsFile, lock: Record<string, LockEntry>): Found[] {
  return tf.list.map((x, index) => {
    const e = ToolEntry.safeParse(x)
    if (!e.success) return { index, entry: x, dir: '', manifest: null, error: 'bad entry' }
    const entry = e.data
    let dir: string, pin: LockEntry | undefined
    if (isGitSource(entry.source)) {
      pin = Object.values(lock).find(l => l?.source === entry.source)
      if (!pin) return { index, entry, dir: '', manifest: null, error: 'not pinned in tools.lock.json' }
      dir = join(toolsHomeFor(tf.path), pin.id)
    } else dir = isAbsolute(entry.source) ? entry.source : resolve(dirname(tf.path), entry.source)
    try { return { index, entry, dir, manifest: readManifest(dir), pin } }
    catch (err) { return { index, entry, dir, manifest: null, pin, error: (err as Error).message } }
  })
}
function findOne(tf: ToolsFile, lock: Record<string, LockEntry>, id: string): Found {
  return findAll(tf, lock).find(f => f.manifest?.id === id || f.pin?.id === id) ?? fail(`no tool "${id}" in ${tf.path} (bun run tools list)`)
}

// ---------- commands ----------

function add(arg: string | undefined, flags: Flags) {
  if (!arg) fail('add <git-url#ref | path> --origin <origin>')
  const tf = readToolsFile(flags)
  const lock = readLock(lockFileFor(tf.path))
  const known = findAll(tf, lock)
  const g = gitSourceOf(arg!)
  let dir: string, commit: string | undefined, tmp: string | undefined
  if (g) {
    if (known.some(f => f.entry.source === g.source)) fail(`${g.source} is already added`)
    tmp = join(toolsHomeFor(tf.path), `.add-${randomBytes(4).toString('hex')}`)
    say(`Fetching ${g.url} at ${g.ref}…`)
    try { commit = fetchAt(g.url, g.ref, tmp) } catch (e) { if (existsSync(tmp)) trash(tmp); throw e }
    dir = tmp
  } else {
    dir = resolve(arg!)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`${dir} is not a folder (a git source needs git+, a URL, .git or #ref)`)
  }
  const drop = () => { if (tmp && existsSync(tmp)) trash(tmp) }
  try {
    const m = readManifest(dir)
    const clash = known.find(f => f.manifest?.id === m.id || f.pin?.id === m.id)
    if (clash) fail(`a tool "${m.id}" is already in ${tf.path}; use update or remove`)
    if (g && existsSync(join(toolsHomeFor(tf.path), m.id))) fail(`${join(toolsHomeFor(tf.path), m.id)} already exists; move it away first`)
    const port = flags.port ?? m.serve?.port
    if (!flags.origin) fail(originHint(port))
    if (!toolOriginOf(flags.origin, hubOrigins())) fail(`--origin ${flags.origin}: https (or http on localhost), only an origin, and not the hub's own`)
    if (flags.run && !m.serve?.command) fail('--run: the manifest has no serve.command')
    if (flags.run && !port) fail('--run needs a port: --port, or serve.port in the manifest')
    const entry: ToolEntry = {
      source: g ? g.source : dir, origin: toolOriginOf(flags.origin)!,
      ...(flags.port ? { port: flags.port } : {}), ...(flags.run ? { run: true } : {}),
      ...(Object.keys(flags.env).length ? { env: flags.env } : {}), ...(flags.allow.length ? { allow: flags.allow } : {}),
    }
    const ok = ToolEntry.safeParse(entry)
    if (!ok.success) fail(`entry: ${ok.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const finalDir = g ? join(toolsHomeFor(tf.path), m.id) : dir
    if (g) say(`\nSource: ${g.url} at ${g.ref} = commit ${commit}`)
    else say(`\nSource: ${dir} (used in place, not pinned)`)
    showTool(m, finalDir, entry)
    if (!confirm(`\nAdd ${m.name} to ${tf.path}?`, flags)) { drop(); say('Not added.'); return }
    if (g) {
      renameSync(dir, finalDir)
      tmp = undefined
      lock[m.id] = { id: m.id, source: g.source, url: g.url, ref: g.ref, commit: commit!, installed: m.install?.length ? null : commit!, added: new Date().toISOString() }
      saveLock(tf, lock)
    }
    tf.list.push(entry)
    saveToolsFile(tf)
    say(`\nAdded ${m.id}${g ? ` at ${commit!.slice(0, 12)} in ${finalDir}` : ''}.`)
    say('Next:')
    if (m.install?.length) say(`  bun run tools install ${m.id}`)
    if (entry.origin.startsWith('https:') && port) say(`  tailscale serve --bg --https=${new URL(entry.origin).port || 443} ${port}   (if not done yet)`)
    if (!entry.run && m.serve?.command) say(`  start it yourself: cd ${finalDir} && PORT=${port ?? '<port>'} BEBOP_HUB_ORIGIN=<hub origin> ${cmdline(m.serve.command)}`)
    say('  restart the hub (it reads tools.json at start)')
  } catch (e) { drop(); throw e }
}

function install(id: string | undefined, flags: Flags) {
  if (!id) fail('install <id>')
  const tf = readToolsFile(flags)
  const lock = readLock(lockFileFor(tf.path))
  const f = findOne(tf, lock, id!)
  if (!f.manifest) fail(`${id}: ${f.error}`)
  if (f.pin && checkedOutCommit(f.dir) !== f.pin.commit) fail(`${f.dir} isn't at the pinned ${f.pin.commit.slice(0, 12)}; run update or add again`)
  const steps = f.manifest!.install ?? []
  if (!steps.length) say(`${id}: no install steps.`)
  else {
    say(`In ${f.dir}, with no shell:`)
    for (const c of steps) say(`  ${cmdline(c)}`)
    if (!confirm('Run these?', flags)) { say('Not installed.'); return }
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HUB_')))
    for (const c of steps) {
      say(`\n$ ${cmdline(c)}`)
      const r = spawnSync(c[0], c.slice(1), { cwd: f.dir, stdio: 'inherit', env })
      if (r.error) fail(`${c[0]}: ${r.error.message}`)
      if (r.status !== 0) fail(`${cmdline(c)} exited with ${r.status ?? r.signal}; not installed`)
    }
  }
  if (f.pin) { lock[f.pin.id] = { ...f.pin, installed: f.pin.commit }; saveLock(tf, lock) }
  say(`\n${id} installed${f.pin ? ` at ${f.pin.commit.slice(0, 12)}` : ''}. Restart the hub to load it.`)
}

function list(flags: Flags) {
  const tf = readToolsFile(flags)
  const lock = readLock(lockFileFor(tf.path))
  const all = findAll(tf, lock)
  if (!all.length) { say(`No tools in ${tf.path}.`); return }
  say(tf.path)
  for (const f of all) {
    const m = f.manifest
    const id = m?.id ?? f.pin?.id ?? '?'
    const where = f.pin ? `${f.pin.url}#${f.pin.ref} @ ${f.pin.commit.slice(0, 12)}${f.pin.installed === f.pin.commit || !m?.install?.length ? '' : ' (not installed)'}` : f.entry.source
    const run = f.entry.run ? ` run on ${f.entry.port ?? m?.serve?.port ?? '?'}` : ''
    say(`  ${id.padEnd(16)} ${m ? `${m.name} ${m.version ?? ''}`.trim() : `(${f.error})`}`)
    say(`  ${''.padEnd(16)} ${where}`)
    say(`  ${''.padEnd(16)} ${f.entry.origin}${run}`)
  }
}

function update(id: string | undefined, flags: Flags) {
  if (!id) fail('update <id> [--ref ref]')
  const tf = readToolsFile(flags)
  const lock = readLock(lockFileFor(tf.path))
  const f = findOne(tf, lock, id!)
  if (!f.pin) fail(`${id} is a local folder (${f.dir}), used in place: nothing to update`)
  const pin = f.pin!
  const ref = flags.ref ?? pin.ref
  const source = `git+${pin.url}#${ref}`
  if (!parseGitSource(source)) fail(`bad ref ${ref}`)
  const tmp = join(toolsHomeFor(tf.path), `.update-${randomBytes(4).toString('hex')}`)
  say(`Fetching ${pin.url} at ${ref}…`)
  let commit: string
  try { commit = fetchAt(pin.url, ref, tmp) } catch (e) { if (existsSync(tmp)) trash(tmp); throw e }
  try {
    if (commit === pin.commit && ref === pin.ref) { trash(tmp); say(`${id} is already at ${commit.slice(0, 12)} (${ref}).`); return }
    const m = readManifest(tmp)
    if (m.id !== pin.id) fail(`the new manifest's id is "${m.id}", not "${pin.id}"`)
    const old = f.manifest
    say(`\n${id}: ${pin.commit.slice(0, 12)} (${pin.ref}) → ${commit.slice(0, 12)} (${ref})`)
    const changed = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
    if (old && changed(old.install, m.install)) say('Note: the install steps changed.')
    if (old && changed(old.serve, m.serve)) say('Note: the serve command changed.')
    if (old && changed(old.frame, m.frame)) say('Note: the frame (URL or permissions) changed.')
    showTool(m, f.dir, f.entry)
    if (!confirm(`\nRe-pin ${id} to ${commit.slice(0, 12)}? The current checkout goes to the Trash.`, flags)) { trash(tmp); say('Not updated.'); return }
    const was = existsSync(f.dir) ? trash(f.dir) : null
    renameSync(tmp, f.dir)
    lock[pin.id] = { ...pin, source, ref, commit, installed: m.install?.length ? null : commit, updated: new Date().toISOString() }
    saveLock(tf, lock)
    if (source !== pin.source) { tf.list[f.index] = { ...tf.list[f.index], source }; saveToolsFile(tf) }
    say(`\n${id} pinned to ${commit.slice(0, 12)}.${was ? ` The old checkout is in ${was}.` : ''}`)
    if (m.install?.length) say(`Next: bun run tools install ${id}, then restart the hub.`)
    else say('Next: restart the hub.')
  } catch (e) { if (existsSync(tmp)) trash(tmp); throw e }
}

function remove(id: string | undefined, flags: Flags) {
  if (!id) fail('remove <id>')
  const tf = readToolsFile(flags)
  const lock = readLock(lockFileFor(tf.path))
  const f = findOne(tf, lock, id!)
  say(f.pin ? `Remove ${id} from ${tf.path}, and move its clone ${f.dir} to the Trash.` : `Remove ${id} from ${tf.path}. Its folder ${f.dir} stays where it is.`)
  if (!confirm('Remove it?', flags)) { say('Not removed.'); return }
  tf.list.splice(f.index, 1)
  saveToolsFile(tf)
  if (f.pin) {
    delete lock[f.pin.id]
    saveLock(tf, lock)
    if (existsSync(f.dir)) say(`Moved ${f.dir} to ${trash(f.dir)}.`)
  }
  say(`Removed ${id}. Restart the hub to drop it. Its log stays in data/logs/tools/.`)
}

if (import.meta.main) {
  try {
    const { cmd, args, flags } = parseArgs(process.argv.slice(2))
    if (cmd === 'add') add(args[0], flags)
    else if (cmd === 'install') install(args[0], flags)
    else if (cmd === 'list') list(flags)
    else if (cmd === 'update') update(args[0], flags)
    else if (cmd === 'remove') remove(args[0], flags)
    else { say(HELP); if (cmd !== 'help') process.exit(2) }
  } catch (e) {
    if (e instanceof Fail) { console.error(e.message); process.exit(1) }
    throw e
  }
}
