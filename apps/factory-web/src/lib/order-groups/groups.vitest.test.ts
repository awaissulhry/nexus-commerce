import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ORDER_PHASES } from '@nexus/factory-domain/production-brand/stages'
import { LOCALES } from '../i18n/locales'
import { createTranslator, messagesFor } from '../i18n/messages'
import { I18nProvider } from '../i18n/provider'
import { CLOSED_GROUPS, CUSTOMER_GROUPS, groupMarkOf, groupNameOf, groupNoteOf, groupsOf, isClosedGroup, OFFICE_GROUPS, ORDER_LIST_NS, PHASE_ICON, phasePhrase, type GroupFace, type OrderGroup } from './groups'
import { GroupsBand, type GroupsBandActions, type GroupsBandModel } from './view/GroupsBand'

/**
 * pg-w1 (portal grid plan § 2, § 5 pg-1.2; 18-lead-settles Z2, Z3) — the groups of a customer's orders: ONE set per face, one mark per
 * group, the words read where they live; the band draws the counts it is given ("—" while not read), never a sum of its own.
 * Made-up data only.
 */

const say = (locale: (typeof LOCALES)[number]) => {
  const all = messagesFor(locale, ['orders', 'orders-sheet', ORDER_LIST_NS])
  return (words: { ns: string; key: string }, params?: Record<string, string | number>) => createTranslator(locale, all[words.ns] ?? {})(words.key, params)
}

describe('pg-w1: the groups of both faces', () => {
  it('the office face is the domain\'s seven phases; the customer face the eight groups of the server\'s sheet answer (pg-server § Shapes)', () => {
    expect(OFFICE_GROUPS).toEqual(ORDER_PHASES)
    expect(CUSTOMER_GROUPS).toEqual(['REQUESTS', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'CLOSED_REQUESTS'])
    expect(groupsOf('office')).toBe(OFFICE_GROUPS)
    expect(groupsOf('customer')).toBe(CUSTOMER_GROUPS)
    // Apart (quiet): the office's Cancelled; the customer's Cancelled and Closed requests (closed requests never vanish).
    expect(CLOSED_GROUPS.office).toEqual(['CANCELLED'])
    expect(CLOSED_GROUPS.customer).toEqual(['CANCELLED', 'CLOSED_REQUESTS'])
    expect(isClosedGroup('customer', 'CLOSED_REQUESTS')).toBe(true)
    expect(isClosedGroup('office', 'DONE')).toBe(false)
  })

  it('one mark per group on each face (told apart by word, mark and place — never by colour alone)', () => {
    for (const face of ['office', 'customer'] as const satisfies readonly GroupFace[]) {
      const marks = groupsOf(face).map((group) => groupMarkOf(face, group))
      expect(marks.every(Boolean), face).toBe(true)
      expect(new Set(marks).size, face).toBe(groupsOf(face).length)
    }
    // The office's marks are the sheet's own (moved here); Confirmed shares the hourglass with "Production not started".
    for (const phase of ORDER_PHASES) expect(groupMarkOf('office', phase)).toBe(PHASE_ICON[phase])
    expect(groupMarkOf('customer', 'CONFIRMED')).toBe(PHASE_ICON.NOT_STARTED)
    expect(groupMarkOf('customer', 'NOT_SENT' as OrderGroup)).toBeNull()
  })

  it('the words are read where they live: the office\'s phase words unchanged, the customer\'s six status names from `orders`, two new', () => {
    expect(ORDER_PHASES.map((phase) => phasePhrase(phase))).toEqual([{ key: 'phase.NOT_SENT' }, { key: 'phase.NOT_STARTED' }, { key: 'rows.IN_PRODUCTION', orders: true }, { key: 'rows.READY', orders: true }, { key: 'rows.SHIPPED', orders: true }, { key: 'phase.DONE' }, { key: 'rows.CANCELLED', orders: true }])
    expect(groupNameOf('office', 'NOT_SENT')).toEqual({ ns: 'orders-sheet', key: 'phase.NOT_SENT' })
    expect(groupNameOf('office', 'READY')).toEqual({ ns: 'orders', key: 'rows.READY' })
    expect(groupNameOf('customer', 'CONFIRMED')).toEqual({ ns: 'orders', key: 'rows.CONFIRMED' })
    expect(groupNameOf('customer', 'REQUESTS')).toEqual({ ns: ORDER_LIST_NS, key: 'customer.group.REQUESTS' })
    expect(groupNoteOf('office', 'DONE')).toEqual({ ns: 'orders-sheet', key: 'phase.note.DONE' })
    expect(groupNoteOf('customer', 'DELIVERED')).toEqual({ ns: ORDER_LIST_NS, key: 'customer.note.DELIVERED' })
    for (const locale of LOCALES) {
      const t = say(locale)
      for (const face of ['office', 'customer'] as const) {
        for (const group of groupsOf(face)) {
          const name = groupNameOf(face, group)
          const note = groupNoteOf(face, group)
          expect(t(name), `${locale} ${face} ${group}`).not.toBe(name.key)
          expect(t(note), `${locale} ${face} ${group} note`).not.toBe(note.key)
        }
      }
    }
    expect(CUSTOMER_GROUPS.map((group) => say('en')(groupNameOf('customer', group)))).toEqual(['Requests', 'Confirmed', 'In production', 'Ready to ship', 'Shipped', 'Delivered', 'Cancelled', 'Closed requests'])
    expect(CUSTOMER_GROUPS.map((group) => say('it')(groupNameOf('customer', group)))).toEqual(['Richieste', 'Confermati', 'In produzione', 'Pronti da spedire', 'Spediti', 'Consegnati', 'Annullati', 'Richieste chiuse'])
  })

  it('every customer word of the band in both languages, "voi" in Italian, no raw key', () => {
    for (const locale of LOCALES) {
      const w = createTranslator(locale, messagesFor(locale, [ORDER_LIST_NS])[ORDER_LIST_NS]!)
      for (const key of ['band.label', 'band.groups', 'band.open', 'band.openCount', 'band.groupTip', 'band.groupOnTip', 'band.sum']) expect(w(`customer.${key}`, { group: 'X' }), `${locale} ${key}`).not.toBe(`customer.${key}`)
      for (const count of [1, 2]) expect(w('customer.band.needsYou', { count }), `${locale} ${count}`).toMatch(new RegExp(`^${count} `))
    }
    const it_ = createTranslator('it', messagesFor('it', [ORDER_LIST_NS])[ORDER_LIST_NS]!)
    expect([it_('customer.band.needsYou', { count: 1 }), it_('customer.band.needsYou', { count: 2 })]).toEqual(['1 attende la vostra risposta', '2 attendono la vostra risposta'])
    expect(it_('customer.band.label')).toContain('vostri')
  })
})

describe('pg-w1: the groups band draws the counts it is given', () => {
  const customerModel = (over: Partial<GroupsBandModel> = {}): GroupsBandModel => ({
    face: 'customer',
    groups: CUSTOMER_GROUPS.map((group, index) => ({ group, count: index + 1, door: true })),
    total: 15,
    needsYou: 2,
    shown: null,
    state: 'ready',
    ...over,
  })
  const html = (model: GroupsBandModel, actions?: GroupsBandActions, locale: (typeof LOCALES)[number] = 'en') => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(GroupsBand, { model, ...(actions ? { actions } : {}) })))
  const numbers = (page: string) => [...page.matchAll(/class="fw-cwb-num">([^<]*)</g)].map((match) => match[1])

  it('customer: six tiles, Cancelled and Closed requests apart, every number the one it was given; the notes line and its doors', () => {
    const actions: GroupsBandActions = { onGroup: () => undefined, onEverything: () => undefined }
    const page = html(customerModel(), actions)
    expect(page).toContain('aria-label="Your orders by where they are"')
    expect(page).toContain('role="group" aria-label="Groups of your orders"')
    expect(page.match(/class="nds-metric btn/g)?.length).toBe(6)
    // The tiles' numbers, then the closed groups' (FilterChip counts are their own), the notes line's total, the phone's fold.
    expect(numbers(page).slice(0, 6)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(page).toContain('class="fw-cb-closed"')
    for (const words of ['Cancelled', 'Closed requests']) expect(page).toContain(words)
    expect(page).toContain('Your open orders and requests:')
    expect(page).toContain('<b class="fw-cwb-num">15</b>')
    // "N need your answer": the Requests tile's warning dot and its tip, and the notes line's door to Requests.
    expect(page).toContain('title="Show: Requests · 2 need your answer"')
    expect(page).toContain('<b>Requests:</b> <button type="button" class="fw-cb-link">2 need your answer</button>')
    expect(page).toContain('About these numbers')
  })

  it('while read: no tiles, every number "—"; nothing needs you: no warning words; failed: said once, its words the button', () => {
    const reading = html(customerModel({ state: 'reading', groups: CUSTOMER_GROUPS.map((group) => ({ group, count: null, door: true })), total: null, needsYou: null }))
    expect(reading).toContain('nds-skeleton')
    expect(reading).not.toContain('nds-metrics')
    expect(reading).toContain('<b class="fw-cwb-num">—</b>')
    expect(reading).not.toContain('need your answer')
    const failed = html(customerModel({ state: 'failed' }), { onRetry: () => undefined })
    expect(failed.match(/Couldn(’|'|&#x27;)t be read · Try again/g)?.length).toBe(1)
    expect(failed).toContain('<p class="fw-cb-failed" role="status"><button type="button" class="fw-cb-link">')
  })

  it('pg-fx3 (walk W-06): the customer\'s failed read says only that — no notes line of "—", no ⓘ; the office keeps its own facts', () => {
    const failed = html(customerModel({ state: 'failed', total: null, needsYou: null }), { onRetry: () => undefined, onEverything: () => undefined })
    expect(failed).toContain('class="fw-cb-failed" role="status"')
    expect(failed).not.toContain('Your open orders and requests')
    expect(failed).not.toContain('About these numbers')
    expect(failed).not.toContain('fw-cb-notes')
    const office: GroupsBandModel = { face: 'office', groups: ORDER_PHASES.map((group) => ({ group, count: null, door: true })), total: null, shown: null, state: 'failed', customer: 'Brand Alpha', officeFacts: { line: 'All orders of Brand Alpha: —' } }
    const page = html(office, { onRetry: () => undefined })
    expect(page).toContain('class="fw-cb-failed" role="status"')
    expect(page).toContain('All orders of Brand Alpha: —') // the Work tab's own line stays (cw fx6)
    expect(page).toContain('About these numbers')
  })

  it('a pressed group says so (its tip, aria-pressed); a group without the host\'s handler is a plain count', () => {
    const page = html(customerModel({ shown: 'SHIPPED' }), { onGroup: () => undefined })
    expect(page).toContain('aria-pressed="true" title="Showing: Shipped. Press again to show everything open."')
    expect(html(customerModel()).match(/class="nds-metric btn/g)).toBeNull()
  })

  it('Italian: the customer\'s words in "voi"; office: the customer page\'s own words with the customer\'s name', () => {
    expect(html(customerModel(), { onGroup: () => undefined }, 'it')).toContain('I vostri ordini e richieste aperti:')
    const office: GroupsBandModel = { face: 'office', groups: ORDER_PHASES.map((group) => ({ group, count: 2, door: true })), total: 14, shown: null, state: 'ready', customer: 'Brand Alpha' }
    const page = html(office, { onGroup: () => undefined })
    expect(page).toContain('role="group" aria-label="Orders by where they are"')
    expect(page.match(/class="nds-metric btn/g)?.length).toBe(6) // Cancelled apart
    expect(page).toContain('Brand Alpha')
    expect(page).not.toContain('Your open orders')
  })

  it('it fetches nothing and imports no office or portal code', () => {
    const part = readFileSync(new URL('./view/GroupsBand.tsx', import.meta.url), 'utf8')
    expect(part).not.toMatch(/lib\/api\/|lib\/session\/|fetch\(|matchMedia|innerWidth/)
    expect(part).toContain('<CustomerBand')
  })
})
