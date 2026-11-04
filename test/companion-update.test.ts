// examples/companion/bin/update: Bebop's files are replaced unless you changed them; yours never.
import { test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TEMPLATE = join(import.meta.dir, '..', 'examples', 'companion')

/** A fake Bebop checkout (just the template) and a companion made from it, recorded like setup does. */
function setup(o: { record?: boolean; git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bebop-update-'))
  const checkout = join(root, 'bebop'), folder = join(root, 'sam')
  cpSync(TEMPLATE, join(checkout, 'examples', 'companion'), { recursive: true })
  cpSync(TEMPLATE, folder, { recursive: true })
  writeFileSync(join(folder, 'hub.env'), `HUB_HOME="${checkout}"\nHUB_URL="http://127.0.0.1:8788"\n`)
  const tpl = (f: string) => join(checkout, 'examples', 'companion', f)
  const here = (f: string) => join(folder, f)
  const run = (...args: string[]) => {
    const r = spawnSync('python3', [here('bin/update'), ...args], { encoding: 'utf8', env: { ...process.env, HUB_HOME: '' } })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const git = (...args: string[]) => spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).stdout
  if (o.git) {
    git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    spawnSync('git', ['-C', folder, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first'])
  }
  if (o.record !== false) expect(run('--record').code).toBe(0)
  return { root, checkout, folder, tpl, here, run, git, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('update: up to date right after setup; --record notes every Bebop file', () => {
  const t = setup()
  try {
    const rec = JSON.parse(readFileSync(t.here('.bebop.json'), 'utf8'))
    expect(Object.keys(rec.files)).toContain('bin/companion')
    expect(Object.keys(rec.files)).toContain('BEBOP.md')
    expect(Object.keys(rec.files)).not.toContain('SOUL.md')
    expect(t.run().out).toContain('up to date')
  } finally { t.done() }
})

test('update: Bebop\'s changed files replace unchanged ones; yours stay; --dry changes nothing', () => {
  const t = setup({ git: true })
  try {
    appendFileSync(t.tpl('bin/task'), '\n# new in Bebop\n')
    appendFileSync(t.tpl('BEBOP.md'), '\nNew rule from Bebop.\n')
    writeFileSync(t.tpl('SOUL.md'), '# Template soul, changed\n')     // never copied: it's the user's
    appendFileSync(t.here('SOUL.md'), '\nMine.\n')
    const dry = t.run('--dry')
    expect(dry.out).toContain('update  bin/task')
    expect(dry.out).toContain('update  BEBOP.md')
    expect(readFileSync(t.here('bin/task'), 'utf8')).not.toContain('new in Bebop')

    const r = t.run()
    expect(r.code).toBe(0)
    expect(readFileSync(t.here('bin/task'), 'utf8')).toContain('new in Bebop')
    expect(readFileSync(t.here('BEBOP.md'), 'utf8')).toContain('New rule from Bebop.')
    expect(readFileSync(t.here('SOUL.md'), 'utf8')).toContain('Mine.')
    expect(t.git('log', '--format=%s', '-1')).toContain('Update from Bebop')
    expect(t.git('status', '--porcelain')).toContain('SOUL.md') // the user's own change isn't committed for them
    expect(t.run().out).toContain('up to date')
  } finally { t.done() }
})

test('update: a file you changed stays when Bebop didn\'t change it; both changed → .bebop-new, then --accept', () => {
  const t = setup()
  try {
    appendFileSync(t.here('BEBOP.md'), '\nMy own note.\n')
    expect(t.run().out).toContain('up to date')                 // Bebop's BEBOP.md is the same: nothing to do
    appendFileSync(t.tpl('BEBOP.md'), '\nNew rule from Bebop.\n')
    const r = t.run()
    expect(r.out).toContain('yours   BEBOP.md')
    expect(readFileSync(t.here('BEBOP.md'), 'utf8')).toContain('My own note.')
    expect(readFileSync(t.here('BEBOP.md.bebop-new'), 'utf8')).toContain('New rule from Bebop.')
    expect(r.out).toContain('bin/update --accept BEBOP.md')
    expect(t.run('--accept', 'BEBOP.md').code).toBe(0)
    expect(existsSync(t.here('BEBOP.md.bebop-new'))).toBe(false)
    expect(t.run().out).toContain('up to date')                 // until Bebop changes it again
  } finally { t.done() }
})

test('update: a companion without .bebop.json (set up earlier) keeps every file that differs', () => {
  const t = setup({ record: false })
  try {
    appendFileSync(t.here('bin/recall'), '\n# local tweak\n')
    const r = t.run()
    expect(r.out).toContain('yours   bin/recall')
    expect(r.out).not.toContain('bin/task')                     // identical files just get recorded
    expect(readFileSync(t.here('bin/recall'), 'utf8')).toContain('local tweak')
    expect(existsSync(t.here('.bebop.json'))).toBe(true)
    expect(r.out).not.toContain('CLAUDE.md doesn')
    writeFileSync(t.here('CLAUDE.md'), '@SOUL.md\n\n## When running on Claude Code\nold rules\n')
    expect(t.run('--dry').out).toContain("CLAUDE.md doesn't load BEBOP.md")
    expect(readFileSync(t.here('CLAUDE.md'), 'utf8')).toContain('old rules') // never changed by bin/update
  } finally { t.done() }
})

test('update: settings.json is merged (your hooks and permissions stay), .gitignore gets missing lines', () => {
  const t = setup()
  try {
    const mine = JSON.parse(readFileSync(t.here('.claude/settings.json'), 'utf8'))
    mine.permissions.allow.push('Bash(make:*)')
    mine.hooks.Stop.push({ hooks: [{ type: 'command', command: 'say done' }] })
    mine.model = 'my-model'
    writeFileSync(t.here('.claude/settings.json'), JSON.stringify(mine, null, 2))
    const theirs = JSON.parse(readFileSync(t.tpl('.claude/settings.json'), 'utf8'))
    theirs.permissions.allow.push('Bash(bin/task:*)')
    theirs.model = 'bebop-default'
    writeFileSync(t.tpl('.claude/settings.json'), JSON.stringify(theirs, null, 2))
    appendFileSync(t.tpl('.gitignore'), 'new-ignore\n')

    expect(t.run().out).toContain('merge   .claude/settings.json')
    const out = JSON.parse(readFileSync(t.here('.claude/settings.json'), 'utf8'))
    expect(out.permissions.allow).toContain('Bash(make:*)')
    expect(out.permissions.allow).toContain('Bash(bin/task:*)')
    expect(out.model).toBe('my-model')
    expect(JSON.stringify(out.hooks.Stop)).toContain('say done')
    expect(out.hooks.Stop.filter((h: any) => JSON.stringify(h).includes('bin/presence')).length).toBe(1) // not doubled
    expect(readFileSync(t.here('.gitignore'), 'utf8')).toContain('new-ignore')
    expect(readFileSync(t.here('.gitignore'), 'utf8')).toContain('*.bebop-new')
  } finally { t.done() }
})

test('update: the checkout\'s own bin/update runs (new file list); a dropped file goes only if unchanged', () => {
  const t = setup()
  try {
    const u = t.tpl('bin/update')
    writeFileSync(u, readFileSync(u, 'utf8').replace('"bin/presence", "bin/recall", "bin/restart",', '"bin/presence", "bin/recall",'))
    appendFileSync(t.here('bin/restart'), '') // unchanged
    const r = t.run()
    expect(r.out).toContain('remove  bin/restart')
    expect(r.out).toContain('update  bin/update')
    expect(existsSync(t.here('bin/restart'))).toBe(false)
  } finally { t.done() }
})

test('update: refuses without a Bebop checkout', () => {
  const t = setup()
  try {
    writeFileSync(t.here('hub.env'), 'HUB_HOME="/nonexistent"\n')
    const r = t.run()
    expect(r.code).toBe(2)
    expect(r.out).toContain('no Bebop checkout found')
  } finally { t.done() }
})
