// Copies the few browser libraries the PWA uses into web/vendor/ (no build step).
import { mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'

const root = join(import.meta.dir, '..')
const out = join(root, 'web', 'vendor')
mkdirSync(out, { recursive: true })
const files: [string, string][] = [
  ['node_modules/marked/lib/marked.esm.js', 'marked.js'],
  ['node_modules/dompurify/dist/purify.es.mjs', 'purify.js'],
]
for (const [from, to] of files) copyFileSync(join(root, from), join(out, to))
