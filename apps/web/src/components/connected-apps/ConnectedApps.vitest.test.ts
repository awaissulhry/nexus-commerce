/**
 * MCP.6 — the Connected apps section: what it lists in each place, when it stays away, how a revoke
 * asks first and then removes the row, and that a failure is said out loud.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The DS Modal portals to document.body, which a server render has not got: show its parts inline. */
vi.mock('@/design-system/components', async (original) => ({
  ...(await original<typeof import('@/design-system/components')>()),
  Modal: (props: { title?: ReactNode; subtitle?: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    createElement('div', { role: 'dialog', 'aria-modal': 'true' }, createElement('h4', null, props.title), createElement('p', null, props.subtitle), props.children, props.footer),
}))

import { ConnectedAppsView } from './ConnectedApps'
import {
  connectedAppsReducer,
  initialConnectedApps,
  loadConnectedApps,
  revokeConnectedApp,
  type ConnectedApp,
  type ConnectedAppsAction,
  type ConnectedAppsScope,
  type ConnectedAppsState,
} from './connectedAppsModel'

const claude: ConnectedApp = {
  id: 'g-1',
  appName: 'Claude',
  appHosts: ['claude.ai', 'claude.com'],
  businessId: 'w-1',
  businessName: 'Business One',
  scopes: ['nexus.read', 'nexus.write'],
  createdAt: '2026-09-20T10:00:00.000Z',
  lastUsedAt: null,
}
const claudeCode: ConnectedApp = {
  ...claude, id: 'g-2', appName: 'Claude Code', appHosts: ['localhost'], businessName: 'Business Two', scopes: ['nexus.read'],
  lastUsedAt: '2026-09-28T09:00:00.000Z',
}
const theirs: ConnectedApp = { ...claude, id: 'g-3', person: { name: 'Ada Person', email: 'ada@example.test', active: true } }
const leaver: ConnectedApp = { ...claude, id: 'g-4', person: { name: null, email: 'left@example.test', active: false } }

const ready = (grants: ConnectedApp[], enabled = true): ConnectedAppsState =>
  connectedAppsReducer(initialConnectedApps, { type: 'loaded', result: { kind: 'ok', enabled, grants } })
const run = (state: ConnectedAppsState, ...actions: ConnectedAppsAction[]) => actions.reduce(connectedAppsReducer, state)
const noop = () => undefined
const render = (state: ConnectedAppsState, scope: ConnectedAppsScope = 'mine') =>
  renderToStaticMarkup(createElement(ConnectedAppsView, { scope, state, onRetry: noop, onAsk: noop, onCancel: noop, onConfirm: noop }))
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ')

describe('MCP.6 — what the section lists', () => {
  it('my own: each app, where it returns, the business, what it may do, and a Revoke that names it', () => {
    const html = render(ready([claude, claudeCode]))
    const words = text(html)
    expect(words).toContain('Connected apps')
    expect(words).toContain('Claude Returns to claude.ai, claude.com')
    expect(words).toContain('Business One')
    expect(words).toContain('Reads, and asks for changes you approve')
    expect(words).toContain('Reads only')
    expect(words).toContain('never') // Claude has not been used yet
    expect(html).toContain('aria-label="Revoke Claude for Business One"')
    expect(html).toContain('aria-label="Revoke Claude Code for Business Two"')
    expect(html.match(/>Revoke<\/button>/g)).toHaveLength(2)
    expect(html).not.toContain('role="dialog"')
    expect(words).not.toContain('Connected by')
  })

  it('a business’s: who connected each one, and who has left it', () => {
    const words = text(render(ready([theirs, leaver]), 'business'))
    expect(words).toContain('Connected by Ada Person ada@example.test')
    expect(words).toContain('Reads, and asks for changes they approve') // the admin is not the one who approves
    expect(words).toContain('left@example.test Left this business')
    expect(words).toContain('Apps that people connected to this business')
  })

  it('empty while Claude can connect: says so, in plain words', () => {
    const words = text(render(ready([])))
    expect(words).toContain('No apps are connected.')
    expect(words).toContain('When you connect Claude to a business')
  })

  it('stays away while loading, when MCP is off with nothing to end, and from someone who may not see it', () => {
    expect(render(initialConnectedApps)).toBe('')
    expect(render(ready([], false))).toBe('')
    expect(render(connectedAppsReducer(initialConnectedApps, { type: 'loaded', result: { kind: 'forbidden' } }), 'business')).toBe('')
  })

  it('MCP off with connections left: lists them, says it is off, and still offers Revoke', () => {
    const words = text(render(ready([claude], false)))
    expect(words).toContain('Connecting Claude to Nexus is switched off. You can still end these connections.')
    expect(words).toContain('Revoke')
  })

  it('a failed load is shown as a failure, with Retry, never as an empty list', () => {
    const html = render(connectedAppsReducer(initialConnectedApps, { type: 'loaded', result: { kind: 'error', message: 'The API is not reachable.' } }))
    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('The API is not reachable. Retry')
    expect(text(html)).not.toContain('No apps are connected.')
  })
})

describe('MCP.6 — revoking', () => {
  it('asks first, in the DS dialog, with Cancel focused and the consequence in words', () => {
    const html = render(run(ready([theirs]), { type: 'ask', grant: theirs }), 'business')
    expect(html).toContain('role="dialog"')
    const words = text(html)
    expect(words).toContain('Revoke Claude?')
    expect(words).toContain('Ada Person · Business One')
    expect(words).toContain('Claude will lose access to this business at once. Ada Person can connect it again later if their role still allows it.')
    expect(html).toMatch(/<button[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/)
    expect(words).toContain('Revoke access')
  })

  it('my own names the business it loses', () => {
    const words = text(render(run(ready([claude]), { type: 'ask', grant: claude })))
    expect(words).toContain('Claude will lose access to Business One at once. To use it there again, connect it again.')
  })

  it('while it runs, both answers are held; then the row goes and the result is said', () => {
    const asked = run(ready([claude, claudeCode]), { type: 'ask', grant: claude })
    const busy = run(asked, { type: 'revoking' })
    const busyHtml = render(busy)
    expect(text(busyHtml)).toContain('Revoking…')
    expect(busyHtml.match(/<button[^>]*disabled=""[^>]*>(Cancel|Revoking…)<\/button>/g)).toHaveLength(2)
    expect(run(busy, { type: 'cancel' })).toBe(busy) // Escape or Cancel cannot drop an answer in flight

    const done = run(busy, { type: 'revoked', result: { kind: 'revoked' } })
    expect(done.grants.map((grant) => grant.id)).toEqual(['g-2'])
    expect(done.confirming).toBeNull()
    const html = render(done)
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('Revoke Claude for Business One')
    expect(text(html)).toContain('Claude no longer has access to Business One.')
  })

  it('the last one revoked while MCP is off: the section stays to say it happened', () => {
    const done = run(ready([claude], false), { type: 'ask', grant: claude }, { type: 'revoking' }, { type: 'revoked', result: { kind: 'revoked' } })
    expect(text(render(done))).toContain('Claude no longer has access to Business One.')
  })

  it('a connection that had already ended leaves the list, and the page says so', () => {
    const done = run(ready([claude]), { type: 'ask', grant: claude }, { type: 'revoking' }, { type: 'revoked', result: { kind: 'gone' } })
    expect(done.grants).toEqual([])
    expect(done.notice).toBe('That connection had already ended. Claude has no access to Business One.')
  })

  it('a failure keeps the row and the dialog open, says why, and lets the person try again', () => {
    const failed = run(ready([claude]), { type: 'ask', grant: claude }, { type: 'revoking' }, { type: 'revoked', result: { kind: 'error', message: 'The API is not reachable.' } })
    expect(failed.grants).toHaveLength(1)
    expect(failed.confirming).toEqual(claude)
    const html = render(failed)
    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('The API is not reachable.')
    expect(html).not.toMatch(/<button[^>]*disabled=""/)
  })
})

describe('MCP.6 — the requests', () => {
  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test'))
  afterEach(() => vi.unstubAllEnvs())
  const answer = (status: number, body: unknown) =>
    vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

  it('reads each place from its own route', async () => {
    const request = answer(200, { enabled: true, grants: [claude] })
    expect(await loadConnectedApps('mine', request)).toEqual({ kind: 'ok', enabled: true, grants: [claude] })
    await loadConnectedApps('business', request)
    expect(request.mock.calls.map(([url]) => url)).toEqual(['https://api.example.test/api/settings/connected-apps', 'https://api.example.test/api/connected-apps'])
  })

  it('no permission hides the section; any other refusal is an error with the API’s sentence', async () => {
    expect(await loadConnectedApps('business', answer(403, { code: 'forbidden', error: 'Access denied' }))).toEqual({ kind: 'forbidden' })
    expect(await loadConnectedApps('mine', answer(403, { code: 'mfa_required', error: 'Complete two-factor authentication.' })))
      .toEqual({ kind: 'error', message: 'Complete two-factor authentication.' })
    expect(await loadConnectedApps('mine', answer(502, 'Bad gateway'))).toEqual({ kind: 'error', message: 'Connected apps could not be loaded (HTTP 502).' })
    expect(await loadConnectedApps('mine', vi.fn(async () => { throw new TypeError('Failed to fetch') })))
      .toEqual({ kind: 'error', message: 'Connected apps could not be loaded. Check your connection and try again.' })
  })

  it('revokes with a POST to the connection’s own route; not found means it had already ended', async () => {
    const ok = answer(200, { ok: true })
    expect(await revokeConnectedApp('business', 'g/1', ok)).toEqual({ kind: 'revoked' })
    expect(ok).toHaveBeenCalledWith('https://api.example.test/api/connected-apps/g%2F1/revoke', { method: 'POST' })
    expect(await revokeConnectedApp('mine', 'g-1', answer(404, { code: 'not_found' }))).toEqual({ kind: 'gone' })
    expect(await revokeConnectedApp('mine', 'g-1', answer(403, { code: 'csrf_failed', error: 'Invalid or missing CSRF token' })))
      .toEqual({ kind: 'error', message: 'Invalid or missing CSRF token' })
  })
})
