import { test, expect, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { startHub } from './helpers'

const { hub, agent, user } = startHub({ agentName: 'Test Companion' })
afterAll(() => hub.stop())
const set = (name: string, body: unknown) => agent(`/agent/projects/${encodeURIComponent(name)}/link`, { method: 'POST', body: JSON.stringify(body) })
const links = async () => (await (await user('/api/threads')).json()).project_links

test('project link: the agent sets, relabels and removes a project\'s Open app link', async () => {
  expect(await links()).toEqual({})
  expect((await set('Demo App', { url: 'https://box.example:4443/' })).status).toBe(200)
  expect(await links()).toEqual({ 'demo app': { url: 'https://box.example:4443/', label: null } })
  await set('demo app', { url: 'https://box.example:4443/', label: '  Open demo  ' })
  expect((await links())['demo app'].label).toBe('Open demo')
  await set('Demo App', { url: null })
  expect(await links()).toEqual({})
})

test('project link: only https or http on this machine; the user side cannot set one', async () => {
  for (const url of ['javascript:alert(1)', 'http://box.example/', 'ftp://box.example/', 'not a url', 'https://u:p@box.example/'])
    expect((await set('demo', { url })).status).toBe(400)
  expect((await set('demo', { url: 'http://localhost:5173/' })).status).toBe(200)
  expect((await user('/agent/projects/demo/link', { method: 'POST', body: JSON.stringify({ url: 'https://x.example/' }) })).status).toBe(401)
  await set('demo', { url: '' })
})

test('project link: the header shows an Open app pill that opens in the browser', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'web', 'app.js'), 'utf8')
  expect(app).toContain("view.kind === 'project' ? projectLinkButton(view.key) : null")
  expect(app).toMatch(/function projectLinkButton[\s\S]{0,400}target: '_blank', rel: 'noopener noreferrer'/)
  expect(app).toContain('state.projectLinks = t.project_links')
})

test('project link: the app can set and remove a link (with the action header)', async () => {
  const post = (body: unknown, headers: Record<string, string> = { 'x-hub-action': '1' }) =>
    user('/api/projects/Demo/link', { method: 'POST', headers, body: JSON.stringify(body) })
  expect((await post({ url: 'https://box.example/' }, {})).status).toBe(403)
  expect((await post({ url: 'http://box.example/' })).status).toBe(400)
  expect((await post({ url: 'https://box.example/' })).status).toBe(200)
  expect((await links()).demo.url).toBe('https://box.example/')
  expect((await post({ url: null })).status).toBe(200)
  expect(await links()).toEqual({})
})

test('project link: right-click or long-press on a project header opens the App link editor', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'web', 'app.js'), 'utf8')
  expect(app).toContain("if (view.kind === 'project') attachLinkEditor(head, view.key, name)")
  expect(app).toMatch(/function attachLinkEditor[\s\S]{0,300}'contextmenu'/)
  expect(app).toMatch(/function editProjectLink[\s\S]{0,1500}api\(`api\/projects\/\$\{encodeURIComponent\(key\)\}\/link`/)
})
