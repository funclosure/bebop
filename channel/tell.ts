#!/usr/bin/env bun
/**
 * bebop tell: a project session leaves a note for the agent, through the hub.
 *
 *   bebop tell "text" [file …]         the text, with files attached (relative paths are fine)
 *   bebop tell - [file …]              the text from stdin
 *   bebop tell --thread <id> "text"    into one of this project's topics (default: its conversation)
 *
 * It finds its project by the folder it runs in (data/peer-tokens/folders.json, which the hub writes
 * when the agent makes the project's token), sends with that project's token, and adds this
 * session's name from Claude Code's session file, so the agent can answer it. The note reaches the
 * agent at its next turn and shows quietly in the app; it never pings the user.
 *
 * Env: BEBOP_HUB_URL (default http://127.0.0.1:8787), BEBOP_DATA_DIR (default the data folder of
 * the hub this file belongs to), CLAUDE_CONFIG_DIR (where Claude Code keeps sessions/).
 * Exit: 0 sent; 1 the hub refused it (it says why); 2 usage or setup; 3 the hub can't be reached.
 */
import { readFileSync, realpathSync, existsSync } from 'fs'
import { join, resolve, sep } from 'path'
import { homedir } from 'os'

const USAGE = `Usage: bebop tell "text" [file …]
       bebop tell - [file …]            (the text from stdin)
       bebop tell --thread <id> "text"  (one of this project's topics)

Leaves a note for the agent through the hub. It reaches the agent at its next turn and never pings the user.`

const HUB_URL = (process.env.BEBOP_HUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const DATA_DIR = process.env.BEBOP_DATA_DIR || join(import.meta.dir, '..', 'data')

function fail(code: number, msg: string): never {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n')
  process.exit(code)
}

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

/** The project whose registered folder holds `dir` (the deepest one), from the hub's folders.json. */
export function projectFor(dir: string, folders: Record<string, string>): string | null {
  const hit = Object.keys(folders).filter(f => within(dir, f)).sort((a, b) => b.length - a.length)[0]
  return hit ? folders[hit] : null
}

/** This session's name: walk up from this process to the Claude Code process that has a session file. */
export function sessionName(start = process.ppid): string | null {
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions')
  let pid = start
  for (let i = 0; i < 12 && pid > 1; i++) {
    const f = join(dir, `${pid}.json`)
    if (existsSync(f)) {
      try {
        const name = JSON.parse(readFileSync(f, 'utf8'))?.name
        return typeof name === 'string' && name ? name : null
      } catch { return null }
    }
    const r = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)], { stderr: 'ignore' })
    const up = Number(r.stdout.toString().trim())
    if (!Number.isInteger(up) || up === pid) return null
    pid = up
  }
  return null
}

async function tell(args: string[]) {
  let thread: string | undefined
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--thread') { thread = args[++i]; if (!thread) fail(2, USAGE) }
    else if (args[i] === '-h' || args[i] === '--help') { console.log(USAGE); process.exit(0) }
    else rest.push(args[i])
  }
  if (!rest.length) fail(2, USAGE)
  const text = (rest[0] === '-' ? await Bun.stdin.text() : rest[0]).replace(/\s+$/, '')
  const cwd = (() => { try { return realpathSync(process.cwd()) } catch { return process.cwd() } })()
  const files = rest.slice(1).map(f => resolve(cwd, f))
  for (const f of files) if (!existsSync(f)) fail(2, `No such file: ${f}`)

  let folders: Record<string, string> = {}
  try { folders = JSON.parse(readFileSync(join(DATA_DIR, 'peer-tokens', 'folders.json'), 'utf8')) } catch {}
  const project = projectFor(cwd, folders)
  if (!project) fail(2, `This folder has no peer token: ${cwd}\nAsk the agent to make one for this project (POST /agent/peer-tokens {project, folders}). Nothing was sent.`)
  let token: string
  try { token = readFileSync(join(DATA_DIR, 'peer-tokens', `${project}.token`), 'utf8').trim() }
  catch { fail(2, `The token file for ${project} is missing; ask the agent to make it again. Nothing was sent.`) }

  const session = sessionName()
  let res: Response
  try {
    res = await fetch(`${HUB_URL}/peer/tell`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, files, ...(thread ? { thread } : {}), ...(session ? { session } : {}) }),
    })
  } catch (e) {
    fail(3, `The hub at ${HUB_URL} can't be reached (${(e as Error).message}). Nothing was sent.`)
  }
  const data: any = await res.json().catch(() => null)
  if (!res.ok) fail(1, `The hub refused the note (${res.status}): ${data?.error ?? 'no reason given'}`)
  console.log(`Sent to the agent as note ${data.id} from ${project}${session ? ` (${session})` : ''}, in ${data.thread}. It reaches the agent at its next turn.`)
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'tell') await tell(args)
  else if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 2) }
  else fail(2, `Unknown command: ${cmd}\n\n${USAGE}`)
}
