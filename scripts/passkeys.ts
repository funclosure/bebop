// Passkey lock recovery, run on the hub machine: `bun scripts/passkeys.ts [list|remove <id>|off]`.
// `off` removes every passkey (and session), which turns the lock off until a new one is registered.
import { Database } from 'bun:sqlite'
import { join } from 'path'

const db = new Database(join(process.env.HUB_DATA_DIR ?? join(import.meta.dir, '..', 'data'), 'hub.sqlite'))
const [cmd = 'list', id] = process.argv.slice(2)
const day = (ts: number | null) => ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '-'
if (cmd === 'list') {
  for (const p of db.query('SELECT id, login, name, created, last_used FROM passkeys ORDER BY created').all() as any[])
    console.log(`${p.id}  ${p.name ?? ''}  ${p.login}  created ${day(p.created)}  last used ${day(p.last_used)}`)
} else if (cmd === 'remove' && id) {
  console.log(db.query('DELETE FROM passkeys WHERE id = ?').run(id).changes ? 'removed' : 'no such passkey')
} else if (cmd === 'off') {
  db.exec('DELETE FROM passkeys; DELETE FROM auth_sessions')
  console.log('lock off: no passkeys left')
} else {
  console.log('usage: bun scripts/passkeys.ts [list|remove <id>|off]')
  process.exit(1)
}
