/**
 * ApprovalsWaiting — the one line Settings › AI and the Fleet overview show about approvals (Owner, 2026-10-05).
 * Rendered HTML (node SSR) for each state, and the source text.
 *
 * Pins the rule: "Other pages may show that approvals are waiting; none of them may decide one"
 * (docs/2026-08-07-naf-aq-approvals-page.md). The line has a count and a link, never Approve or Reject, and the two
 * pages that used to decide no longer call a decide route.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/workspaces/Link', () => ({
  default: ({ href, children, className }: { href: string; children?: ReactNode; className?: string }) => createElement('a', { href, className }, children),
}))

const { ApprovalsWaitingView } = await import('./ApprovalsWaiting')
const { approvalsWaitingLine } = await import('./approvals-waiting-words')
type WaitingLine = import('./approvals-waiting-words').WaitingLine

const view = (line: WaitingLine, props: { heading?: string; id?: string } = {}) =>
  renderToStaticMarkup(createElement(ApprovalsWaitingView, { line, ...props }))
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('ApprovalsWaiting — a count and a link, nothing to decide', () => {
  it('says how many need you, and links to the Approvals page', () => {
    const html = view(approvalsWaitingLine({ counts: { needsYou: 8, failed: 1 }, failed: false }))
    expect(text(html)).toBe('8 requests need you · 1 failed Open Approvals')
    expect(html).toContain('href="/fleet/approvals"')
    expect(html).toMatch(/nds-banner neutral/)
    expect(html).not.toMatch(/<button|<input/)
    expect(text(html)).not.toMatch(/\b(Approve|Reject)\b/)
  })

  it('nothing waiting, a failed read, and the first read still on its way', () => {
    expect(text(view(approvalsWaitingLine({ counts: { needsYou: 0, failed: 0 }, failed: false })))).toBe('Nothing needs you right now. Open Approvals')
    const failed = view(approvalsWaitingLine({ counts: null, failed: true }))
    expect(text(failed)).toBe('Nexus could not read the approvals count. Open Approvals')
    expect(failed).toContain('href="/fleet/approvals"')
    const loading = view({ kind: 'loading' })
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('nds-skeleton')
    expect(text(loading)).toBe('Open Approvals')
  })

  it('takes a heading and an id for Settings › AI (its agents link to #agent-approvals)', () => {
    const html = view({ kind: 'clear', text: 'Nothing needs you right now.' }, { heading: 'Agent approvals', id: 'agent-approvals' })
    expect(html).toContain('id="agent-approvals"')
    expect(html).toMatch(/<h2 id="([^"]+)"[^>]*>Agent approvals<\/h2>/)
    const [, headingId] = html.match(/<h2 id="([^"]+)"/) ?? []
    expect(html).toContain(`aria-labelledby="${headingId}"`)
    expect(view({ kind: 'loading' })).toContain('aria-label="Approvals"')
  })
})

describe('built on the design system only, on tokens the fleet light pin covers', () => {
  const source = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8')

  it('no raw control, no Tailwind, no legacy kit', () => {
    const code = source('ApprovalsWaiting.tsx')
    expect(code).not.toMatch(/<(button|input|select|table|textarea)[\s>]/)
    expect(code).not.toMatch(/components\/ui/)
    expect(code).not.toMatch(/className="/)
  })

  it('the stylesheet reads only --nds-* tokens that fleet-pages.css pins', () => {
    const css = source('ApprovalsWaiting.module.css')
    const pin = source('../fleet-pages.css')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    for (const [, token] of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      expect(token).toMatch(/^--nds-/)
      // Colour roles must be pinned light on fleet pages; size, space and weight tokens do not change with the theme.
      if (/^--nds-(text|surface|bg|border|primary)/.test(token)) expect(pin, token).toContain(`${token}:`)
    }
  })
})

describe('the two older lists no longer decide', () => {
  const app = join(import.meta.dirname, '..', '..')
  const read = (path: string) => readFileSync(join(app, path), 'utf8')

  it('Settings › AI shows the line and calls no approve or reject route', () => {
    const page = read('settings/ai/page.tsx')
    expect(page).toMatch(/<ApprovalsWaiting\b/)
    expect(page).not.toMatch(/approvals\/\$\{[^}]+\}\/(approve|reject)|AiApprovalsClient/)
  })

  it('the Fleet overview shows the line and calls no decide route', () => {
    const tab = read('marketing/ads/rules-automation/fleet/FleetTab.tsx')
    expect(tab).toMatch(/<ApprovalsWaiting \/>/)
    expect(tab).not.toMatch(/\/decide|reject-all|bulk-decide|bulk-preview|\/undo`|\/commit`|ApprovalInbox/)
  })
})
