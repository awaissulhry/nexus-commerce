import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIST_SEARCH_SELECTOR, pageKeepsSlash, portalKeyAction } from './model'

/**
 * pg-fx3 (walk W-01, portal grid lane) — `/` on a portal page: where the page shows a list's own search box (the list frame's), `/`
 * focuses it, as on the office's lists; everywhere else it opens the portal's Search window. The rule reads the field the frame's
 * own `/` looks for, so the shell gives way exactly when the frame takes the key.
 */
const docWith = (selectors: readonly string[]) => ({ querySelector: (selector: string) => (selectors.includes(selector) ? {} : null) })

describe('pg-fx3 (W-01): `/` and the list search', () => {
  it('a page with a list search keeps `/`; a page without one opens Search', () => {
    expect(LIST_SEARCH_SELECTOR).toBe('.fw-list .nds-toolbar input')
    expect(pageKeepsSlash(docWith([LIST_SEARCH_SELECTOR]))).toBe(true)
    expect(pageKeepsSlash(docWith([]))).toBe(false)
    expect(portalKeyAction('/', false, {})).toEqual({ kind: 'search' })
  })
  it('the selector is the list frame\'s own: its root `.fw-list` and the toolbar input its `/` focuses (no change to the frame)', () => {
    const frame = readFileSync(new URL('../../list-frame/ListFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain('<div className="fw-list" ref={frameRef}>')
    expect(frame).toContain(`querySelector<HTMLInputElement>('.nds-toolbar input[type="search"], .nds-toolbar input')`)
    expect(frame).toContain("if (event.key === '/') {")
  })
  it('the shell gives way before it prevents the key or opens Search', () => {
    const shell = readFileSync(new URL('./PortalShell.tsx', import.meta.url), 'utf8')
    const handler = shell.slice(shell.indexOf('const action = portalKeyAction('), shell.indexOf("if (action.kind === 'shortcuts') open('shortcuts')"))
    const yieldAt = handler.indexOf("if (action.kind === 'search' && pageKeepsSlash(document)) return")
    expect(yieldAt).toBeGreaterThan(0)
    expect(yieldAt).toBeLessThan(handler.indexOf('event.preventDefault()'))
    expect(yieldAt).toBeLessThan(handler.indexOf("open('search')"))
  })
})
