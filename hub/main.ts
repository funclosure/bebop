import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createHub } from './server'

const env = process.env
// Rex's CLI ships inside its app's server bundle; used when present unless HUB_REX_BIN says otherwise ('off' disables).
const rexDefault = join(homedir(), 'Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex')
const rexBin = env.HUB_REX_BIN === 'off' ? undefined : env.HUB_REX_BIN || (existsSync(rexDefault) ? rexDefault : undefined)
const hub = createHub({
  dataDir: env.HUB_DATA_DIR ?? join(import.meta.dir, '..', 'data'),
  port: Number(env.HUB_PORT ?? 8787),
  allowedLogins: (env.HUB_ALLOWED_LOGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  agentName: env.HUB_AGENT_NAME || 'Bebop',
  iconRoots: env.HUB_ICON_ROOTS ? env.HUB_ICON_ROOTS.split(':').map(s => s.trim()).filter(Boolean) : undefined,
  maxUploadMB: Number(env.HUB_MAX_UPLOAD_MB ?? 2048),
  vapidSubject: env.HUB_VAPID_SUBJECT,
  transcribeCmd: env.HUB_TRANSCRIBE_CMD,
  transcribeTimeoutMs: Number(env.HUB_TRANSCRIBE_TIMEOUT_S ?? 120) * 1000,
  refineCmd: env.HUB_REFINE_CMD,
  refineTimeoutMs: Number(env.HUB_REFINE_TIMEOUT_S ?? 90) * 1000,
  herdrBin: env.HUB_HERDR_BIN || undefined,
  herdrSocket: env.HUB_HERDR_SOCKET || undefined,
  rexBin,
  shells: (['on', 'rex', 'herdr'] as const).find(v => v === env.HUB_SHELLS) ?? false,
  shellsFile: env.HUB_SHELLS_FILE || undefined,
  toolsFile: env.HUB_TOOLS_FILE || undefined,
  publicOrigins: (env.HUB_PUBLIC_ORIGIN ?? '').split(/[\s,]+/).filter(Boolean),
  // Deprecated: list Board in tools.json instead. Until then this loads it as a built-in tool.
  boardOrigin: env.HUB_BOARD_ORIGIN || undefined,
  agentId: env.HUB_AGENT_ID || undefined,
  userName: env.HUB_USER_NAME || undefined,
})
console.log(`hub: listening on ${hub.url}`)

// Waits for run:true tools to exit (SIGTERM, SIGKILL after 5 s); a second signal doesn't wait.
let stopping = false
const stop = () => {
  if (stopping) process.exit(0)
  stopping = true
  hub.stop().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
