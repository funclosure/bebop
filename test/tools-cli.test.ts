import { test, expect, beforeAll } from 'bun:test'
import { spawnSync } from 'child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadTools } from '../hub/tools'

// `bun run tools` against local bare git repos made from examples/tools/hello: no network.
const root = mkdtempSync(join(tmpdir(), 'hub-tools-cli-'))
const trashDir = join(root, 'trash')
const script = join(import.meta.dir, '..', 'scripts', 'tools.ts')

function sh(args: string[], cwd: string) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}
/** A work repo (to commit to) and a bare clone of it (the "remote"), from the hello example. */
function repo(name: string, edit?: (m: any) => void) {
  const work = join(root, name)
  cpSync(join(import.meta.dir, '..', 'examples', 'tools', 'hello'), work, { recursive: true })
  if (edit) {
    const m = JSON.parse(readFileSync(join(work, 'bebop-tool.json'), 'utf8'))
    edit(m)
    writeFileSync(join(work, 'bebop-tool.json'), JSON.stringify(m, null, 2))
  }
  sh(['init', '-q', '-b', 'main'], work)
  sh(['add', '-A'], work)
  sh(['commit', '-qm', 'v1'], work)
  sh(['tag', 'v1'], work)
  const bare = join(root, `${name}.git`)
  sh(['clone', '-q', '--bare', work, bare], root)
  return { work, bare, v1: sh(['rev-parse', 'HEAD'], work) }
}
function tools(file: string, ...args: string[]) {
  const r = spawnSync('bun', [script, ...args, '--file', file], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BEBOP_TRASH_DIR: trashDir, HUB_PUBLIC_ORIGIN: 'https://hub.example.ts.net' } })
  return { code: r.status, out: r.stdout + r.stderr }
}
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'))

let hello: ReturnType<typeof repo>
beforeAll(() => { hello = repo('hello') })

test('add (git): shows the manifest and commands, needs --origin and a yes, clones at the ref and pins it', () => {
  const dir = mkdtempSync(join(root, 'data-'))
  const file = join(dir, 'tools.json')
  const noOrigin = tools(file, 'add', `${hello.bare}#v1`)
  expect(noOrigin.code).toBe(1)
  expect(noOrigin.out).toContain('--origin is required')
  expect(noOrigin.out).toContain('tailscale serve --bg --https=8444 5180')
  // Not a terminal and no --yes: shown, not added.
  const noYes = tools(file, 'add', `${hello.bare}#v1`, '--origin', 'http://localhost:5199')
  expect(noYes.code).toBe(1)
  expect(noYes.out).toContain('"id": "hello"')
  expect(noYes.out).toContain('serve:   bun server.ts')
  expect(noYes.out).toContain('--yes')
  expect(existsSync(file)).toBe(false)
  expect(existsSync(join(dir, 'tools', 'hello'))).toBe(false)
  // The hub's own origin is refused.
  expect(tools(file, 'add', `${hello.bare}#v1`, '--origin', 'https://hub.example.ts.net', '--yes').out).toContain("not the hub's own")

  const ok = tools(file, 'add', `file://${hello.bare}#v1`, '--origin', 'http://localhost:5199', '--port', '5199', '--run', '--env', 'GREETING=hi', '--yes')
  expect(ok.code).toBe(0)
  const source = `git+file://${hello.bare}#v1`
  expect(json(file)).toEqual([{ source, origin: 'http://localhost:5199', port: 5199, run: true, env: { GREETING: 'hi' } }])
  const lock = json(join(dir, 'tools.lock.json'))
  expect(lock.hello).toMatchObject({ id: 'hello', source, ref: 'v1', commit: hello.v1, installed: hello.v1 })
  expect(readFileSync(join(dir, 'tools', 'hello', '.git', 'HEAD'), 'utf8').trim()).toBe(hello.v1)
  // Shallow: one commit.
  expect(sh(['rev-list', '--count', 'HEAD'], join(dir, 'tools', 'hello'))).toBe('1')
  // No temp clones left behind.
  expect(readdirSync(join(dir, 'tools'))).toEqual(['hello'])

  // The hub loads it from the clone, at the pinned commit.
  const logs: string[] = []
  const [t] = loadTools(file, { log: m => logs.push(m) })
  expect(t).toMatchObject({ id: 'hello', dir: join(dir, 'tools', 'hello'), commit: hello.v1, origin: 'http://localhost:5199' })
  expect(t.entry).toMatchObject({ run: true, port: 5199 })

  // Same source or id again: refused.
  expect(tools(file, 'add', `${hello.bare}#v1`, '--origin', 'http://localhost:5199', '--yes').out).toContain('already added')
  expect(tools(file, 'add', hello.work, '--origin', 'http://localhost:5198', '--yes').out).toContain('already in')

  // A checkout that moved off the pin isn't loaded.
  writeFileSync(join(dir, 'tools.lock.json'), JSON.stringify({ hello: { ...lock.hello, commit: 'f'.repeat(40) } }))
  logs.length = 0
  expect(loadTools(file, { log: m => logs.push(m) })).toEqual([])
  expect(logs.join('\n')).toContain('the lock pins ffffffffffff')
  // Not in the lock at all: not loaded.
  writeFileSync(join(dir, 'tools.lock.json'), '{}')
  logs.length = 0
  expect(loadTools(file, { log: m => logs.push(m) })).toEqual([])
  expect(logs.join('\n')).toContain("isn't pinned")
})

test('install: runs the argv steps in the clone with no shell; the hub loads the tool only once installed', () => {
  const r = repo('needs-install', m => {
    m.id = 'needsinst'
    m.install = [['bun', '-e', 'require("fs").writeFileSync("installed.json", JSON.stringify(process.argv.slice(1)))', '$(touch pwned)', 'a;b']]
  })
  const dir = mkdtempSync(join(root, 'data-'))
  const file = join(dir, 'tools.json')
  const add = tools(file, 'add', `${r.bare}#main`, '--origin', 'http://localhost:5198', '--yes')
  expect(add.code).toBe(0)
  expect(add.out).toContain("install: bun -e 'require(\"fs\")")
  expect(add.out).toContain('bun run tools install needsinst')
  expect(json(join(dir, 'tools.lock.json')).needsinst.installed).toBeNull()
  const logs: string[] = []
  expect(loadTools(file, { log: m => logs.push(m) })).toEqual([])
  expect(logs.join('\n')).toContain('run `bun run tools install needsinst`')
  expect(tools(file, 'list').out).toContain('(not installed)')

  expect(tools(file, 'install', 'needsinst').code).toBe(1) // no --yes off a terminal
  const ins = tools(file, 'install', 'needsinst', '--yes')
  expect(ins.code).toBe(0)
  const clone = join(dir, 'tools', 'needsinst')
  expect(json(join(clone, 'installed.json'))).toEqual(['$(touch pwned)', 'a;b'])
  expect(existsSync(join(clone, 'pwned'))).toBe(false)
  expect(json(join(dir, 'tools.lock.json')).needsinst.installed).toBe(r.v1)
  expect(loadTools(file).map(t => t.id)).toEqual(['needsinst'])
})

test('update re-pins to the ref\'s new head after a yes (old checkout to the Trash); remove trashes the clone', () => {
  const r = repo('moving', m => { m.id = 'moving' })
  const dir = mkdtempSync(join(root, 'data-'))
  const file = join(dir, 'tools.json')
  expect(tools(file, 'add', `${r.bare}#main`, '--origin', 'http://localhost:5197', '--yes').code).toBe(0)
  expect(tools(file, 'update', 'moving', '--yes').out).toContain('already at')

  // A new commit on main, pushed to the "remote".
  const m = json(join(r.work, 'bebop-tool.json'))
  m.version = '0.2.0'
  m.install = [['bun', '--version']]
  writeFileSync(join(r.work, 'bebop-tool.json'), JSON.stringify(m, null, 2))
  sh(['commit', '-qam', 'v2'], r.work)
  sh(['push', '-q', r.bare, 'main'], r.work)
  const v2 = sh(['rev-parse', 'HEAD'], r.work)

  const before = existsSync(trashDir) ? readdirSync(trashDir).length : 0
  const up = tools(file, 'update', 'moving', '--yes')
  expect(up.code).toBe(0)
  expect(up.out).toContain(`${r.v1.slice(0, 12)} (main) → ${v2.slice(0, 12)} (main)`)
  expect(up.out).toContain('the install steps changed')
  const lock = json(join(dir, 'tools.lock.json')).moving
  expect(lock).toMatchObject({ commit: v2, installed: null })
  expect(readFileSync(join(dir, 'tools', 'moving', '.git', 'HEAD'), 'utf8').trim()).toBe(v2)
  expect(readdirSync(trashDir).length).toBe(before + 1)

  // --ref moves the pin back to the tag, and the source in tools.json with it.
  expect(tools(file, 'update', 'moving', '--ref', 'v1', '--yes').code).toBe(0)
  expect(json(file)[0].source).toBe(`git+file://${r.bare}#v1`)
  expect(json(join(dir, 'tools.lock.json')).moving).toMatchObject({ ref: 'v1', commit: r.v1, installed: r.v1 })

  const rm = tools(file, 'remove', 'moving', '--yes')
  expect(rm.code).toBe(0)
  expect(json(file)).toEqual([])
  expect(json(join(dir, 'tools.lock.json'))).toEqual({})
  expect(existsSync(join(dir, 'tools', 'moving'))).toBe(false)
  expect(readdirSync(trashDir).some(n => n.startsWith('moving-'))).toBe(true)
})

test('a local folder is added in place, not pinned, and left alone on remove', () => {
  const dir = mkdtempSync(join(root, 'data-'))
  const file = join(dir, 'tools.json')
  const add = tools(file, 'add', hello.work, '--origin', 'http://localhost:5196', '--yes')
  expect(add.code).toBe(0)
  expect(add.out).toContain('used in place')
  expect(json(file)).toEqual([{ source: hello.work, origin: 'http://localhost:5196' }])
  expect(existsSync(join(dir, 'tools.lock.json'))).toBe(false)
  expect(loadTools(file).map(t => [t.id, t.dir])).toEqual([['hello', hello.work]])
  expect(tools(file, 'update', 'hello', '--yes').out).toContain('used in place')
  expect(tools(file, 'list').out).toContain(hello.work)
  expect(tools(file, 'remove', 'hello', '--yes').code).toBe(0)
  expect(existsSync(join(hello.work, 'bebop-tool.json'))).toBe(true)
  expect(json(file)).toEqual([])
})

test('a bad manifest in a git source is refused and its clone trashed', () => {
  const r = repo('bad', m => { m.id = 'tool' })
  const dir = mkdtempSync(join(root, 'data-'))
  const file = join(dir, 'tools.json')
  const out = tools(file, 'add', `${r.bare}#v1`, '--origin', 'http://localhost:5195', '--yes')
  expect(out.code).toBe(1)
  expect(out.out).toContain('reserved id')
  expect(existsSync(file)).toBe(false)
  expect(readdirSync(join(dir, 'tools'))).toEqual([])
})
