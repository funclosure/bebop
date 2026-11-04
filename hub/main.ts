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
  maxUploadMB: Number(env.HUB_MAX_UPLOAD_MB ?? 2048),
  vapidSubject: env.HUB_VAPID_SUBJECT,
  transcribeCmd: env.HUB_TRANSCRIBE_CMD,
  transcribeTimeoutMs: Number(env.HUB_TRANSCRIBE_TIMEOUT_S ?? 120) * 1000,
  refineCmd: env.HUB_REFINE_CMD,
  refineTimeoutMs: Number(env.HUB_REFINE_TIMEOUT_S ?? 90) * 1000,
  herdrBin: env.HUB_HERDR_BIN || undefined,
  herdrSocket: env.HUB_HERDR_SOCKET || undefined,
  rexBin,
  boardOrigin: env.HUB_BOARD_ORIGIN || undefined,
  userName: env.HUB_USER_NAME || undefined,
  boardAnswerer: env.HUB_BOARD_ANSWERER || undefined,
  iconRoots: env.HUB_ICON_ROOTS ? env.HUB_ICON_ROOTS.split(':').map(s => s.trim()).filter(Boolean) : undefined,
})
console.log(`hub: listening on ${hub.url}`)

const stop = () => { hub.stop(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
