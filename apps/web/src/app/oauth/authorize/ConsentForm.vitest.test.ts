/**
 * MCP.5 — the consent form says who is asking, where it returns, which business and what it may
 * do; and it cannot be submitted without a business the person may connect and a 6-digit code.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConsentForm, type ConsentFormProps, type ConsentView } from './ConsentForm'

const view: ConsentView = {
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  loopback: false,
  scopes: ['nexus.read', 'nexus.write'],
  mfaEnrolled: true,
  businesses: [
    { id: 'w1', name: 'Xavia', canConnect: true },
    { id: 'w2', name: 'Other shop', canConnect: false },
  ],
}

const noop = () => undefined
function render(overrides: Partial<ConsentFormProps> = {}, viewOverrides: Partial<ConsentView> = {}) {
  return renderToStaticMarkup(createElement(ConsentForm, {
    view: { ...view, ...viewOverrides },
    workspaceId: 'w1', allowWrite: true, code: '', busy: false, error: null,
    onWorkspace: noop, onAllowWrite: noop, onCode: noop, onApprove: noop, onDeny: noop,
    ...overrides,
  }))
}

const connectDisabled = (html: string) => /<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/.test(html)

describe('MCP.5 — consent form', () => {
  it('names the app and where it returns', () => {
    const html = render()
    expect(html).toContain('Connect Claude to Nexus')
    expect(html).toContain('claude.ai')
    expect(html).not.toContain('program on this computer')
  })

  it('warns when it returns to a program on this computer', () => {
    expect(render({}, { loopback: true, redirectHost: 'localhost:53682' })).toContain('program on this computer')
  })

  it('offers only businesses the person may connect', () => {
    const html = render()
    expect(html).toMatch(/<option value="w1"[^>]*>Xavia<\/option>/)
    expect(html).toMatch(/<option value="w2" disabled=""[^>]*>Other shop — needs ai.run<\/option>/)
  })

  it('offers "ask for changes" only when the app asked for it', () => {
    expect(render()).toContain('Ask for changes')
    expect(render({}, { scopes: ['nexus.read'] })).not.toContain('Ask for changes')
  })

  it('Connect waits for a 6-digit code', () => {
    expect(connectDisabled(render({ code: '12345' }))).toBe(true)
    expect(connectDisabled(render({ code: '123456' }))).toBe(false)
  })

  it('without two-factor authentication there is no form, only the way to turn it on', () => {
    const html = render({}, { mfaEnrolled: false })
    expect(html).toContain('Turn on two-factor authentication')
    expect(html).toContain('href="/settings/security"')
    expect(html).not.toContain('one-time-code')
  })

  it('with no business to connect, it says why and offers only Cancel', () => {
    const html = render({ workspaceId: '' }, { businesses: [{ id: 'w2', name: 'Other shop', canConnect: false }] })
    expect(html).toContain('needs the permission to use the assistant')
    expect(html).not.toContain('one-time-code')
  })
})

describe('MCP.12 — the consent page follows the theme and the DS type scale', () => {
  const HERE = import.meta.dirname
  const source = (name: string) => readFileSync(join(HERE, name), 'utf8')

  it('the page applies the saved theme, as /profiles does (it has no top bar to do it)', () => {
    expect(source('page.tsx')).toMatch(/import \{ useTheme \} from '@\/lib\/theme\/use-theme'/)
    expect(source('page.tsx')).toMatch(/export default function AuthorizePage\(\) \{[\s\S]{0,200}useTheme\(\)/)
  })

  it('"Claude may" is a group label on the DS scale, and every paragraph takes the base size', () => {
    expect(render()).toMatch(/<p id="[^"]+" class="oauth-consent-group-label">Claude may<\/p>/)
    const css = source('consent.css')
    expect(css).toMatch(/\.oauth-consent p \{ font-size: var\(--nds-font-size-base\); \}/)
    expect(css).toMatch(/\.oauth-consent-group-label \{[^}]*font-size: var\(--nds-font-size-sm-plus\)/)
    expect(css).not.toMatch(/font-size:\s*\d/)
  })
})
