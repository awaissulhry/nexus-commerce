import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CONTAINMENT_KINDS, CONTAINMENT_STATUSES, DECISION_STATES } from '@nexus/factory-domain/quality/ncr/rules'
import { DISPOSITION_MOVES, DISPOSITION_OUTCOMES } from '@nexus/factory-domain/quality/defects/rules'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, flattenMessages, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import en from '../../../../../messages/en/ncr-record.json'
import it_ from '../../../../../messages/it/ncr-record.json'
import enNcr from '../../../../../messages/en/ncr.json'
import { RECORD, RECORD_OPEN, STOCK } from '../demo/fixtures'
import { designScreen } from './fixtures'
import { carryBodyOf, carryGap, carryHeld, carryKindOf, changesOf, draftHeld, draftOf, EMPTY_CARRY, holdBodyOf, holdSubjects, linkGroupsOf, linesTotal, plainQuantity, stockLinesOf, TIME_ZONE } from './view-model'

// The DS Modal opens in a portal after mount (nothing on a server render): drawn in place here, so every dialog's words
// and its code are rendered and checked too.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { 'data-modal': 'open' }, createElement('h2', null, title as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

const NAMESPACES = [...new Set([...Object.keys(en), ...Object.keys(enNcr)])].filter((name) => /^[a-zA-Z]+$/.test(name))
const LEFT_KEY = new RegExp(`\\b(?:${NAMESPACES.join('|')})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs quality.ncr.approve"); file names and the zone are data. */
const SAID = /\b(?:quality|inventory|production|purchasing|sales|files|tasks|compliance|threads)\.[a-zA-Z.]+|[\w-]+\.jpg|Europe\/Rome/g

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = designScreen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('SCR-145 the NCR record: every design case draws in both languages with no key left on screen', () => {
  it(`${(designScreen as unknown as DesignScreen<unknown>).cases.length} cases × it, en`, () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(item.model, locale).replace(SAID, '')
        expect(html.length, `${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('the garments-in-work scrap says why it is held (never a fake success)', () => {
    const item = designScreen.cases.find((entry) => entry.id === 'carry-held-garments')!
    expect(render(item.model, 'en')).toContain('Garments still in work are scrapped at the scan')
    expect(render(item.model, 'it')).toContain('I capi ancora in lavorazione si scartano alla lettura')
  })

  it('the dialogs draw: the carry-out lines, the claim, the close checklist, the hold fields', () => {
    const html = (id: string) => render(designScreen.cases.find((entry) => entry.id === id)!.model, 'en')
    expect(html('carry-scrap-lot')).toContain('Quantity from A1-STORE')
    expect(html('carry-claim')).toContain('Open a claim now')
    expect(html('close')).toContain('Closing checklist')
    expect(html('add-action-hold')).toContain('What is held')
    expect(html('carry-refused')).toContain('The moves take 10.0000 FT2')
    expect(html('link')).toContain('DEMO-LOT-0007')
  })

  it('the catalogue has every key in both languages, with the same placeholders', () => {
    const a = flattenMessages(en)
    const b = flattenMessages(it_)
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(a)) expect(holes(b[key]!), key).toEqual(holes(a[key]!))
  })

  it('every word the record names in its code exists (the grid cells draw only in the browser)', () => {
    const flat = flattenMessages(en)
    const flatNcr = flattenMessages(enNcr)
    const has = (dictionary: Record<string, string>, key: string) => key in dictionary || `${key}_one` in dictionary || `${key}_other` in dictionary
    const dir = join(__dirname, 'view')
    const sources = [...readdirSync(dir).map((name) => join(dir, name)), join(__dirname, 'NcrRecord.tsx'), join(__dirname, 'view-model.ts')].map((file) => readFileSync(file, 'utf8')).join('\n')
    const own = [...sources.matchAll(/\br\('([a-zA-Z.]+)'/g)].map((match) => match[1]!)
    const shared = [...sources.matchAll(/\bt\('([a-zA-Z.]+)'/g)].map((match) => match[1]!)
    const keyed = [...sources.matchAll(/(?:key: |return )'((?:carry|hold|problem|done|decide|rework|addAction|link|reason|photos|cell|disposition|linked|remove|register|cancelNcr|cancelAction|closeHold)\.[a-zA-Z.]+)'/g)].map((match) => match[1]!)
    expect(own.length).toBeGreaterThan(100)
    for (const key of own) expect(has(flat, key), `ncr-record: ${key}`).toBe(true)
    for (const key of shared) expect(has(flatNcr, key), `ncr: ${key}`).toBe(true)
    for (const key of keyed) expect(has(flat, key) || has(flatNcr, key), `either: ${key}`).toBe(true)
  })

  it('the dynamic words exist in both languages (kinds, states, outcomes, moves, tabs)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['ncr-record'])['ncr-record']!)
      const has = (key: string) => expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const kind of CONTAINMENT_KINDS) has(`kind.${kind}`)
      for (const status of CONTAINMENT_STATUSES) has(`actionStatus.${status}`)
      for (const state of DECISION_STATES) has(`decisionState.${state}`)
      for (const outcome of DISPOSITION_OUTCOMES) has(`outcome.${outcome}`)
      for (const move of DISPOSITION_MOVES) has(`move.${move}`)
      for (const tab of ['problem', 'containment', 'disposition', 'linked', 'activity']) has(`tab.${tab}`)
      for (const kind of ['stock', 'repair', 'claim', 'stockAndClaim', 'rework', 'none']) has(`carryKind.${kind}`)
    }
  })
})

describe('B-W2b-17 containment cancel reason', () => {
  it('a cancelled action carries its reason in its own column; one cancelled before keeps it out of the evidence', () => {
    const screen = designScreen as unknown as DesignScreen<{ record: { loaded: { status: string; record?: { containment: { status: string; cancelReason: string | null; evidenceNote: string | null }[] } } } }>
    const item = screen.cases.find((entry) => entry.id === 'w2b-containment-cancelled')!
    const cancelled = item.model.record.loaded.record!.containment.filter((action) => action.status === 'CANCELLED')
    expect(cancelled).toHaveLength(2)
    expect(cancelled.every((action) => action.cancelReason && action.cancelReason.length > 3)).toBe(true)
    expect(cancelled.filter((action) => action.evidenceNote?.startsWith('Cancelled: '))).toHaveLength(1)
    for (const locale of LOCALES) expect(flattenMessages(messagesFor(locale, ['ncr-record'])['ncr-record'])['containment.cancelledBecause']).toContain('{reason}')
  })
})

describe('the record rules', () => {
  it('a draft saves only what changed, quantities as typed', () => {
    const draft = draftOf(RECORD.ncr, TIME_ZONE)
    expect(changesOf(RECORD.ncr, draft, TIME_ZONE)).toEqual({})
    expect(changesOf(RECORD.ncr, { ...draft, title: ' New title ', quantitySuspect: '16,5', zone: '' }, TIME_ZONE)).toEqual({ title: 'New title', quantitySuspect: '16.5', zone: null })
    expect(draftHeld({ ...draft, title: ' ' })).toBe('problem.heldTitle')
    expect(draftHeld({ ...draft, quantityAffected: '0' })).toBe('problem.heldQuantity')
    expect(draftHeld(draft)).toBeNull()
    expect(plainQuantity('51.8000')).toBe('51.8')
    expect(plainQuantity('40')).toBe('40')
  })

  it('SCRAP of garments still in work (no lot, no material) is held; a lot has its stock lines', () => {
    const scrap = { ...RECORD.decisions[1]!, state: 'TO_CARRY_OUT' as const }
    expect(carryGap(scrap, RECORD.ncr)).toBe('carry.gapGarmentScrap')
    const lot = { ...RECORD.ncr, lot: { id: STOCK[0]!.lot!.id, code: 'DEMO-LOT-0007' }, item: STOCK[0]!.item, uom: 'FT2' as const }
    expect(carryGap(scrap, lot)).toBeNull()
    const lines = stockLinesOf(STOCK, '12')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.quantity).toBe('12')
    expect(linesTotal({ ...EMPTY_CARRY, lines }, 'FT2')).toBe(12)
    const body = carryBodyOf({ ...scrap, quantity: '12' }, lot, { ...EMPTY_CARRY, lines, note: ' cut through ' })
    expect(body).toEqual({ note: 'cut through', stock: { lines: [{ itemId: STOCK[0]!.item.id, itemColourId: null, lotId: STOCK[0]!.lot!.id, hideId: null, fromLocationId: STOCK[0]!.location.id, quantity: '12', uom: 'FT2' }] } })
    expect(carryHeld({ ...scrap, quantity: '12' }, lot, { ...EMPTY_CARRY, lines: [] })).toBe('carry.heldNoPlaces')
  })

  it('a rework decision is carried out by its rework order; a transfer needs its place; a claim its reason', () => {
    expect(carryKindOf(RECORD.decisions[0]!)).toBe('rework')
    const transfer = { ...RECORD.decisions[1]!, disposition: { ...RECORD.decisions[1]!.disposition!, stockMoveReason: 'TRANSFER' as const, followUp: 'SUPPLIER_CLAIM' as const }, state: 'TO_CARRY_OUT' as const }
    const lot = { ...RECORD.ncr, lot: { id: STOCK[0]!.lot!.id, code: 'L' }, supplier: { id: 's', code: 'S', name: 'Demo' } }
    const lines = stockLinesOf(STOCK, '8')
    expect(carryKindOf(transfer)).toBe('stockAndClaim')
    expect(carryHeld(transfer, lot, { ...EMPTY_CARRY, lines })).toBe('carry.heldTo')
    expect(carryHeld(transfer, lot, { ...EMPTY_CARRY, lines, toLocationId: 'q' })).toBe('carry.heldClaimReason')
    expect(carryBodyOf(transfer, lot, { ...EMPTY_CARRY, lines, toLocationId: 'q', claimReason: 'THICKNESS' })?.claim).toEqual({ kind: 'RETURN', reasonCode: 'THICKNESS', reasonNote: null, remedy: null })
  })

  it('a hold placed from the NCR holds its lot or work order, with an active reason', () => {
    const subjects = holdSubjects(RECORD_OPEN.ncr)
    expect(subjects.map((subject) => subject.subjectType)).toEqual(['WorkOrder'])
    expect(holdBodyOf({ subject: subjects[0]!.key, reasonCode: 'NCR', note: '' }, subjects, null)).toEqual({ subjectType: 'WorkOrder', subjectIds: [RECORD_OPEN.ncr.workOrder!.id], reasonCode: 'NCR', reasonNote: null })
    expect(holdBodyOf({ subject: subjects[0]!.key, reasonCode: 'SUSPECT', note: '' }, subjects, [{ id: 'r', code: 'SUSPECT', labelIt: 'x', labelEn: 'x', needsDetail: true }])).toBeNull()
  })

  it('the links come in the design groups: the source, the follow-ups, the rest', () => {
    const groups = linkGroupsOf(RECORD)
    expect(groups.source.map((link) => link.recordType)).toEqual(['Inspection'])
    expect(groups.follow.map((link) => link.recordType)).toEqual(['ReworkOrder'])
    expect(groups.other.map((link) => link.recordType)).toEqual(['WorkOrder'])
  })
})
