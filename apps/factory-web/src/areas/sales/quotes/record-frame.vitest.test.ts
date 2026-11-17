import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { REQUEST_STATE_WORDS } from '@nexus/factory-domain/sales/portal-requests/state'
import { customerSeesOf, MERGED_TABS, QUOTE_TABS, tabOf } from './model'
// TH-6 part B (B-TH-257 follow-up)
import { requestWithdrawnOf } from './model'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { designScreen as listScreen } from './list/fixtures'
import { designScreen, quote } from './record/fixtures'

/**
 * B-TH-257 — the quote on the record frame (O-SAL-QUO-REC; the rule of picture 38, the tabs of 08-tabs.tsv): the band in the area row,
 * ONE thread docked beside the five tabs, Activity's tools in the thread's "⋯" (R-ACT), Documents merged into "Approval & sending"
 * (R-1), one notice, the old addresses (R-8); "Made from INQ-… — Open" and "Customer sees: …" from the quote's own state (B-TH-078);
 * the Quotes list's New messages and the accepted rows' orders.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const list = (id: string, locale: 'it' | 'en' = 'en') => renderView(listScreen.view as ComponentType<{ model: unknown }>, listScreen.cases.find((item) => item.id === id)!.model, locale)

describe('the quote on RecordFrame', () => {
  it('ONE thread on the page: the docked thread, no Activity tab and no record panels', () => {
    const html = draw('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).not.toContain('fw-rp-tabs')
    expect(html).not.toContain('fw-q-dock')
    expect(textOf(html)).not.toMatch(/\bActivity\b/)
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab (Activity’s tools moved there)', () => {
    for (const id of ['owner-lines', 'price-owner', 'terms-edit', 'versions', 'sending-draft', 'accepted', 'thread-docked']) expect(draw(id), id).toContain('aria-label="Thread tools"')
  })

  it('the tabs 7 → 5: Lines · Price & margin · Terms & delivery · Revisions · Approval & sending', () => {
    expect(QUOTE_TABS).toEqual(['lines', 'price', 'terms', 'versions', 'approval'])
    const text = textOf(draw('thread-docked'))
    for (const tab of ['Lines', 'Price & margin', 'Terms & delivery', 'Revisions', 'Approval & sending']) expect(text).toContain(tab)
    const html = draw('thread-docked')
    expect(html).not.toContain('?tab=documents')
    expect(html).not.toContain('?tab=activity')
    const italian = textOf(draw('thread-docked', 'it'))
    for (const tab of ['Righe', 'Prezzo e margine', 'Condizioni e consegna', 'Revisioni', 'Approvazione e invio']) expect(italian).toContain(tab)
  })

  it('Approval & sending keeps all of Documents’ work: the rules, the PDF (live and frozen), the accept link, the evidence, the deposit', () => {
    const draft = textOf(draw('sending-draft'))
    expect(draft).toContain('Rule check')
    expect(draft).toContain('Quote PDF — preview')
    const accepted = draw('accepted')
    const text = textOf(accepted)
    expect(accepted).toContain('class="fw-q-merged"')
    for (const part of ['Rule check', 'Quote PDF — as sent', 'Accept link', 'Acceptance evidence', 'Deposit request']) expect(text, part).toContain(part)
    expect(text.indexOf('Rule check')).toBeLessThan(text.indexOf('Quote PDF — as sent'))
  })

  it('every old ?tab= keeps working (R-8): Documents → Approval & sending, Activity → Lines with the thread opened', () => {
    expect(MERGED_TABS).toEqual({ documents: 'approval', activity: 'lines' })
    expect(tabOf('documents')).toBe('approval')
    expect(tabOf('activity')).toBe('lines')
    for (const tab of QUOTE_TABS) expect(tabOf(tab)).toBe(tab)
    expect(tabOf('nope')).toBe('lines')
    expect(tabOf(null)).toBe('lines')
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(tabOf(name)).toBe('lines') // TH-6 part B
  })

  it('one notice: the most serious shows in the body column, never above the thread', () => {
    const html = draw('th-257-order-waits')
    expect(html).toContain('class="fw-rcf-notices"')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    expect(html.slice(html.indexOf('class="fw-rcf-body"'), dockAt)).toContain('fw-rcf-notices-list')
    expect(html.slice(dockAt)).not.toContain('fw-rcf-notices')
  })

  it('the page mounts the office thread docked with this quote’s customer only; no dock hook, no ?tab=activity push', () => {
    const container = readFileSync(new URL('./record/QuoteRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain("record={{ type: 'Quote', id: value.id, companyId: value.companyId, siteId: null }}")
    expect(container).toContain('party={{ id: value.partyId, name: value.party.legalName }}')
    expect(container).toContain('partyRole="customer"')
    expect(container).not.toContain("tabHref('activity')")
    expect(container).not.toContain('DOCK_KEY')
    const viewSource = readFileSync(new URL('./record/view/QuoteRecordView.tsx', import.meta.url), 'utf8')
    expect(viewSource).toContain('<RecordFrame')
    expect(viewSource).not.toContain('RecordPanelsView')
    expect(viewSource).not.toContain("'activity'")
  })
})

describe('B-TH-078 on the band: where the quote came from and where it went', () => {
  it('"Made from INQ-… — Open" opens the request; "Customer sees" says what the customer reads of a draft', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('th-257-made-from', locale)
      expect(html).toContain('/sales/incoming/0190f0e2-5151-7000-8000-000000000042')
      expect(textOf(html)).toContain(locale === 'en' ? 'Made from INQ-2026-0042 — Open' : 'Creato da INQ-2026-0042 — Apri')
      expect(textOf(html)).toContain(locale === 'en' ? 'Customer sees: Quote being prepared' : 'Il cliente legge: Preventivo in preparazione')
    }
  })

  it('"Customer sees" comes from the quote’s own state with the portal’s own words: a draft is never "Quote sent"; no request → nothing', () => {
    expect(customerSeesOf(quote({ madeFrom: { inquiryId: 'i', number: 'INQ-1' }, order: null }))).toBe('QUOTE_BEING_PREPARED')
    expect(customerSeesOf(quote({ status: 'PENDING_APPROVAL', madeFrom: { inquiryId: 'i', number: 'INQ-1' } }))).toBe('QUOTE_BEING_PREPARED')
    expect(customerSeesOf(quote({ status: 'SENT', madeFrom: { inquiryId: 'i', number: 'INQ-1' } }))).toBe('QUOTE_SENT')
    expect(customerSeesOf(quote({ status: 'ACCEPTED', madeFrom: { inquiryId: 'i', number: 'INQ-1' }, order: { state: 'MADE', id: 'o', number: 'SO-1', status: 'PENDING_APPROVAL', reason: null, words: null } }))).toBe('ORDER_WAITING')
    expect(customerSeesOf(quote({ status: 'ACCEPTED', madeFrom: { inquiryId: 'i', number: 'INQ-1' }, order: { state: 'WAITS', id: null, number: null, status: null, reason: 'NOT_MADE', words: 'x' } }))).toBe('QUOTE_ACCEPTED')
    expect(customerSeesOf(quote({ madeFrom: null }))).toBeNull()
    expect(customerSeesOf(quote())).toBeNull()
    expect(textOf(draw('th-257-customer-sees-sent'))).toContain(`Customer sees: ${REQUEST_STATE_WORDS.QUOTE_SENT.en}`)
    expect(textOf(draw('owner-lines'))).not.toContain('Customer sees')
  })

  it('without the requests right the number stays, without a link', () => {
    const html = draw('th-257-no-request-right')
    expect(textOf(html)).toContain('Made from INQ-2026-0042')
    expect(html).not.toContain('/sales/incoming/0190f0e2-5151-7000-8000-000000000042')
  })

  it('accepted: "Order SO-… — Open"; no order yet: the notice says why, Make the order now (held without orders.manage)', () => {
    const made = draw('th-257-order')
    expect(made).toContain('/sales/orders/0190f0e2-4444-7000-8000-000000000088')
    expect(textOf(made)).toContain('Order SO-2026-0088 — Open')
    const waits = textOf(draw('th-257-order-waits'))
    expect(waits).toContain('Order waits: the customer accepted the quote and its order is not made yet.')
    expect(waits).toContain('Make the order now')
    expect(draw('th-257-order-waits-held')).toContain('Making an order needs the right to manage orders (orders.manage).')
    const series = textOf(draw('th-257-order-waits-series'))
    expect(series).toContain('Order waits: the company has no order numbering yet.')
    expect(series).not.toContain('Make the order now')
  })
})

describe('the Quotes list: New messages, "from INQ-…", an accepted row’s order', () => {
  // The grid's cells draw in a browser only (AG Grid): the column, its door and its read are held in the sources and the words.
  const listView = readFileSync(new URL('./list/view/QuotesListView.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./list/QuotesPage.tsx', import.meta.url), 'utf8')

  it('New messages: one read per page of the quotes on screen, only with threads.read; the cell opens the thread at the first new one', () => {
    expect(page).toContain("const readsThreads = session.permissions.includes('threads.read')")
    expect(page).toContain("recordType: 'Quote'")
    expect(page).toContain('useUnread(readsThreads ? readUnreadWith(api) : null')
    expect(page).toContain('unread: readsThreads ? unread : null')
    expect(listView).toContain("...(model.unread ? ([{ colId: 'newMessages'")
    expect(listView).toContain('href={`${recordHref(data)}?thread=new`}')
  })

  it('"from INQ-…" (a door with the requests right) and an accepted row’s order ("Order SO-…", "Order waits"), in it and en', () => {
    expect(listView).toContain("t('list.madeFrom', { number: data.madeFrom.number })")
    expect(listView).toContain("t('list.orderWaits')")
    expect(listScreen.cases.some((item) => item.id === 'th-257-sources')).toBe(true)
    for (const locale of ['en', 'it'] as const) expect(textOf(list('th-257-sources', locale)).length).toBeGreaterThan(100)
  })

  // ---- TH-6 part B (B-TH-257 follow-up; grid-F01): the quote row's Picture, as the Orders sheet's (its API: GET /sales/quotes rows'
  // `picture` + GET /sales/quotes/:id/picture, files.read only).
  it('Picture: the first column, the small preview read once per row (never the original), the picture large on click', () => {
    expect(listView).toContain("{ colId: 'picture', headerName: t('list.col.picture')")
    expect(listView).toContain('<QuotePictureCell row={data} load={latest.current.actions?.loadPicture}')
    expect(listView).toContain('<QuotePictureViewer row={row}')
    expect(page).toContain('const picture = await readQuotePicture(api, quoteId)')
    expect(page).toContain('return picture.small ? { url: picture.small.url, expiresAt: picture.small.expiresAt } : null')
    const cell = readFileSync(new URL('./list/view/QuotePicture.tsx', import.meta.url), 'utf8')
    expect(cell).toContain('useRequestPicture({ id: row.id, picture: row.picture ?? null }, load, demo)')
  })

  it('the Picture words in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const words = CATALOGUE[locale].sales ?? {}
      for (const key of ['list.col.picture', 'list.picture.open', 'list.picture.noneOf', 'list.picture.alt', 'list.picture.viewerOf', 'list.picture.small', 'list.picture.none', 'list.picture.openStyle', 'list.picture.close', 'list.picture.more', 'list.picture.moreStyles_other']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
  // ---- end TH-6 part B
})

// ---- TH-6 part B (B-TH-257 follow-up; B-TH-090's WITHDRAWN, #1564): "Customer sees" reads the request's own state ----------------
describe('TH-6 part B: a request the customer withdrew is never "Quote being prepared"', () => {
  it('the request’s own state decides, as the portal reads it; an older answer without it reads QUOTED as before', () => {
    expect(customerSeesOf(quote({ madeFrom: { inquiryId: 'i', number: 'INQ-1', status: 'WITHDRAWN', declineReason: null, closedAt: '2026-10-28T10:15:00.000Z' }, order: null }))).toBe('CLOSED')
    expect(customerSeesOf(quote({ status: 'SENT', madeFrom: { inquiryId: 'i', number: 'INQ-1', status: 'WITHDRAWN' } }))).toBe('CLOSED')
    expect(customerSeesOf(quote({ status: 'SENT', madeFrom: { inquiryId: 'i', number: 'INQ-1', status: 'QUOTED' } }))).toBe('QUOTE_SENT')
    expect(customerSeesOf(quote({ status: 'SENT', madeFrom: { inquiryId: 'i', number: 'INQ-1' } }))).toBe('QUOTE_SENT')
    expect(customerSeesOf(quote({ madeFrom: { inquiryId: 'i', number: 'INQ-1', status: 'DECLINED', declineReason: 'NOT_AN_ORDER' } }))).toBe('CLOSED')
    expect(customerSeesOf(quote({ madeFrom: { inquiryId: 'i', number: 'INQ-1', status: 'DECLINED', declineReason: 'PRICE' } }))).toBe('DECLINED')
  })

  it('the office reads why: "The customer withdrew the request on …" beside the customer’s "Closed"; nothing for any other state', () => {
    expect(requestWithdrawnOf(quote({ madeFrom: { inquiryId: 'i', number: 'INQ-1', status: 'WITHDRAWN', closedAt: '2026-10-28T10:15:00.000Z' } }))).toEqual({ at: '2026-10-28T10:15:00.000Z' })
    expect(requestWithdrawnOf(quote({ madeFrom: { inquiryId: 'i', number: 'INQ-1', status: 'WITHDRAWN' } }))).toEqual({ at: null })
    expect(requestWithdrawnOf(quote({ madeFrom: { inquiryId: 'i', number: 'INQ-1', status: 'QUOTED' } }))).toBeNull()
    expect(requestWithdrawnOf(quote({ madeFrom: null }))).toBeNull()
    const en = textOf(draw('th-6b-request-withdrawn'))
    expect(en).toContain(`Customer sees: ${REQUEST_STATE_WORDS.CLOSED.en}`)
    expect(en).toContain('The customer withdrew the request on')
    expect(en).not.toContain('Quote being prepared')
    const it = textOf(draw('th-6b-request-withdrawn', 'it'))
    expect(it).toContain(`Il cliente legge: ${REQUEST_STATE_WORDS.CLOSED.it}`)
    expect(it).toContain('Il cliente ha ritirato la richiesta il')
    expect(textOf(draw('th-257-made-from'))).not.toContain('withdrew')
  })
})
// ---- end TH-6 part B
