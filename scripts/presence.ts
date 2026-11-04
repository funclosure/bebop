#!/usr/bin/env bun
/**
 * Report the agent's presence (idle / thinking / working) to the Bebop hub.
 * Made to be called from agent hooks: it exits fast, prints nothing on stdout and
 * never fails the caller (always exit 0). What went wrong goes to stderr in one line
 * (no hub, a refused token, a missing setting), so it shows in the hook's output.
 *
 *   bun scripts/presence.ts <idle|thinking|working> [detail]
 *   bun scripts/presence.ts --hook        # reads a Claude Code hook event on stdin
 *
 * In --hook mode the state comes from the event:
 *   UserPromptSubmit → thinking
 *   PreToolUse       → working, with a short label for tool_name
 *   Stop             → idle
 * The hub's own tools (mcp__hub__*) leave the state alone.
 *
 * Env: HUB_URL (default http://127.0.0.1:8787), HUB_TOKEN_FILE (default
 * ../data/agent.token next to this script).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

export function toolLabel(tool: string): string | null {
  if (/^mcp__hub__/.test(tool)) return null // replying to the user is not "work" to show
  const map: Record<string, string> = {
    Bash: 'Running a command', BashOutput: 'Running a command', KillShell: 'Running a command',
    Read: 'Reading files', Grep: 'Reading files', Glob: 'Reading files', LS: 'Reading files', NotebookRead: 'Reading files',
    Edit: 'Editing files', MultiEdit: 'Editing files', Write: 'Editing files', NotebookEdit: 'Editing files',
    WebSearch: 'Searching the web', WebFetch: 'Searching the web',
    Agent: 'Asking a helper', Task: 'Asking a helper', SendMessage: 'Asking a helper',
    TodoWrite: 'Planning', Skill: 'Using a skill',
  }
  if (map[tool]) return map[tool]
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(tool)
  if (mcp) return `Using ${mcp[1].replace(/^plugin_[^_]+_/, '').replace(/[_-]+/g, ' ')}`
  return 'Working'
}

export function fromHookEvent(ev: any): { state: string; detail?: string } | null {
  switch (ev?.hook_event_name) {
    case 'UserPromptSubmit': return { state: 'thinking' }
    case 'PreToolUse': {
      const label = toolLabel(String(ev.tool_name ?? ''))
      return label ? { state: 'working', detail: label } : null
    }
    case 'Stop': case 'SessionEnd': return { state: 'idle' }
    default: return null
  }
}

async function main() {
  const args = process.argv.slice(2)
  let body: { state: string; detail?: string } | null
  if (args[0] === '--hook') {
    let ev: any = null
    try { ev = JSON.parse(await Bun.stdin.text()) } catch {}
    body = fromHookEvent(ev)
  } else {
    body = args[0] ? { state: args[0], ...(args[1] ? { detail: args.slice(1).join(' ') } : {}) } : null
  }
  if (!body) return
  // With a hub.env (bin/hub-env.zsh sets HUB_ENV_FILE) the settings come from it, never a default.
  if (process.env.HUB_ENV_FILE && (!process.env.HUB_URL || !process.env.HUB_TOKEN_FILE))
    throw new Error(`hub.env (${process.env.HUB_ENV_FILE}) must set HUB_URL and HUB_TOKEN_FILE`)
  const url = (process.env.HUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const tokenFile = process.env.HUB_TOKEN_FILE || join(import.meta.dir, '..', 'data', 'agent.token')
  let token: string
  try { token = readFileSync(tokenFile, 'utf8').trim() } catch (e: any) { throw new Error(`can't read the token file ${tokenFile} (${e?.code ?? e})`) }
  let res: Response
  try {
    res = await fetch(`${url}/agent/presence`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    })
  } catch (e: any) { throw new Error(`no hub at ${url} (${e?.cause?.code ?? e?.name ?? e})`) }
  if (res.status === 401) throw new Error(`the hub at ${url} refused the token from ${tokenFile}`)
  if (!res.ok) throw new Error(`the hub at ${url} answered HTTP ${res.status}`)
}

if (import.meta.main) {
  const deadline = setTimeout(() => process.exit(0), 1500) // never block the caller
  try { await main() } catch (e) { process.stderr.write(`presence: ${e instanceof Error ? e.message : e}\n`) }
  clearTimeout(deadline)
  process.exit(0)
}
