/**
 * Bulk history: a skipped item's message is a neutral "Reason", a failed item's stays a red "Error" (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. `BulkActionItem.errorMessage` also carries why a row was skipped ("Not changed: 45.00 is below
 * its pricing floor of 46.00."). The history page showed every message in red text and, in the item drawer, in a
 * danger banner titled "Error" — so a row the job deliberately left alone read as a failure.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ItemMessageBanner, ItemMessageText, itemMessageKind } from './ItemMessage'
import s from './history.module.css'

const REASON = 'Not changed: 45.00 is below its pricing floor of 46.00.'
const ERROR = 'MasterPriceService.update: product p-1 not found'

describe('which kind of message an item carries', () => {
  it('SKIPPED → reason; FAILED and every other status → error, as before', () => {
    expect(itemMessageKind('SKIPPED')).toBe('reason')
    for (const status of ['FAILED', 'SUCCEEDED', 'PENDING', 'anything']) expect(itemMessageKind(status), status).toBe('error')
  })
})

describe('🔴 the item drawer', () => {
  const drawer = (status: string, message: string) => renderToStaticMarkup(createElement(ItemMessageBanner, { status, message }))

  it('a SKIPPED item: a neutral "Reason" banner with the sentence as plain text — no alert, no danger, no code block', () => {
    const html = drawer('SKIPPED', REASON)
    expect(html).toContain('class="nds-banner neutral"')
    expect(html).toContain('role="status"')
    expect(html).toContain('<div class="nds-banner-title">Reason</div>')
    expect(html).toContain(`<div class="nds-banner-desc">${REASON}</div>`)
    expect(html).not.toMatch(/danger|role="alert"|>Error<|<pre/)
  })

  it('a FAILED item: the danger "Error" banner with the message in a code block, as today', () => {
    const html = drawer('FAILED', ERROR)
    expect(html).toContain('class="nds-banner danger"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('<div class="nds-banner-title">Error</div>')
    expect(html).toContain(`<pre class="${s.pre}">${ERROR}</pre>`)
    expect(html).not.toContain('Reason')
  })
})

describe('🔴 the items list', () => {
  const row = (status: string, message: string) => renderToStaticMarkup(createElement(ItemMessageText, { status, message }))

  it('a SKIPPED item: the page\'s plain secondary text, labelled "Reason" for screen readers — not the error colour', () => {
    // Not vacuous: the two page classes are real and different.
    expect(s.subtle).toBeTruthy()
    expect(s.subtle).not.toBe(s.errorText)
    const html = row('SKIPPED', REASON)
    expect(html).toBe(`<span class="${s.subtle}"><span class="nds-vh">Reason: </span>${REASON}</span>`)
    expect(html).not.toContain(`class="${s.errorText}"`)
  })

  it('a FAILED item: the error text, as today', () => {
    expect(row('FAILED', ERROR)).toBe(`<span class="${s.errorText}">${ERROR}</span>`)
  })
})

describe('🔴 the history page uses these for every item message', () => {
  const page = readFileSync(join(__dirname, 'HistoryClient.tsx'), 'utf8')

  it('the list row and the drawer render the message through ItemMessageText / ItemMessageBanner', () => {
    expect(page).toContain('<ItemMessageText status={it.status} message={it.errorMessage} />')
    expect(page).toContain('<ItemMessageBanner status={item.status} message={item.errorMessage} />')
  })

  it('no item message is rendered by hand any more (the red text and the "Error" banner for every status)', () => {
    expect(page).not.toMatch(/>\{it\.errorMessage\}</)
    expect(page).not.toMatch(/>\{item\.errorMessage\}</)
    expect(page).not.toContain('title="Error"')
  })
})
