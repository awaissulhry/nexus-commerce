import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { CONTAINMENT_KINDS, NCR_FROM_TYPES, NCR_LINK_TYPES, NCR_SOURCES, NCR_STAGES, STAGE_CHECKS } from '@nexus/factory-domain/quality/ncr/rules'
import { QUALITY_STAGES, DEFECT_CLASSES } from '@nexus/factory-domain/quality/defects/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, flattenMessages, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { editNcr, moveNcr, raiseNcr } from './api'
import { LANES, RECORD, RECORD_OPEN, RECORD_READY, ROWS } from './demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import { newHeldKey } from './list/view/NewNcrDialog'
import { draftOf, EMPTY_DRAFT } from './list/view-model'
import {
  bandHeld,
  checkSay,
  decidedOf,
  decisionHeld,
  factsOfRecord,
  factsOfSummary,
  laneHeld,
  ncrAddressOf,
  ncrAddressText,
  ncrCan,
  ncrQueryOf,
  newNcrAddress,
  NCR_VIEWS,
  quantityText,
  recordLabel,
  refusalOf,
  stepsOf,
} from './model'
import { sayWith } from './parts'
import { officeArea } from '../nav'

/**
 * Quality › Nonconformances (SCR-144 list and board, SCR-145 record; B-W2a-68 on the API of B-W2a-47): the pure rules
 * (the address ⇄ the API's own filters, the board's refusals in words from a card's facts, the checks and the band in
 * our words, the "decided" bar, a refusal read from an API error), the calls as the API takes them, the navigation and
 * record links, and every list design case drawn in Italian and English with no message key or placeholder on screen.
 */

const params = (text: string) => new URLSearchParams(text)

describe('ncr: who may do what, and where it lives', () => {
  it('reads the five NCR rights and the rights of what a decision makes', () => {
    expect(ncrCan(templateOf('quality_inspector')!.permissions)).toMatchObject({ view: true, raise: true, manage: true, approve: true, close: true, rework: true, scrap: true })
    expect(ncrCan(templateOf('production_manager')!.permissions)).toMatchObject({ view: true, raise: true, manage: true, approve: true, close: false })
    expect(ncrCan(templateOf('sales')!.permissions)).toMatchObject({ view: true, raise: true, manage: false, approve: false, close: false })
    expect(ncrCan(templateOf('maintenance')!.permissions).view).toBe(false)
  })

  it('Quality › Problems › Nonconformances asks quality.ncr.view; the record and list open here', () => {
    const problems = officeArea.area.sections?.find((section) => section.id === 'quality-problems')
    expect(problems?.items.map((item) => [item.href, item.permission])).toContainEqual(['/quality/ncr', 'quality.ncr.view'])
    expect(OFFICE_PAGES.has('/quality/ncr')).toBe(true)
    expect(OFFICE_PAGES.has('/quality/ncr/[id]')).toBe(true)
    expect(recordAddress({ type: 'Nonconformance', id: 'abc' }, OFFICE_PAGES)).toBe('/quality/ncr/abc')
    expect(LIST_PAGES['/quality/ncr']).toBe('/quality/ncr')
    const sales = officeNavFor(permissionCheck(templateOf('sales')!.permissions))
    expect(sales.areas.find((area) => area.id === 'quality')?.sections?.flatMap((section) => section.items.map((item) => item.href))).toEqual(['/quality/ncr'])
  })
})

describe('ncr: the address and the rows', () => {
  it('reads and writes the address; unknown values fall back', () => {
    expect(ncrAddressOf(params('view=critical&q=seam&mode=board'))).toMatchObject({ view: 'critical', q: 'seam', mode: 'board', isNew: false, from: null })
    expect(ncrAddressOf(params('view=nope&site=not-a-uuid'))).toMatchObject({ view: 'open', siteId: null, mode: 'list' })
    const from = ncrAddressOf(params(`new=1&from=Inspection&id=${ROWS[0]!.id}`))
    expect(from.from).toEqual({ recordType: 'Inspection', recordId: ROWS[0]!.id })
    expect(ncrAddressText(from)).toBe(`?new=1&from=Inspection&id=${ROWS[0]!.id}`)
    expect(ncrAddressOf(params('new=1&from=drop table&id=1')).from).toBeNull()
    expect(newNcrAddress('/w/DEMO', { recordType: 'Lot', recordId: ROWS[1]!.id })).toBe(`/w/DEMO/quality/ncr?new=1&from=Lot&id=${ROWS[1]!.id}`)
  })

  it('every saved row is one of the API filters', () => {
    const query = (view: (typeof NCR_VIEWS)[number]) => ncrQueryOf({ view, q: '', siteId: null })
    expect(query('open')).toEqual({ siteId: null, q: null })
    expect(query('mine')).toMatchObject({ ownerId: 'me' })
    expect(query('critical')).toMatchObject({ severity: 'CRITICAL' })
    expect(query('supplier')).toMatchObject({ source: 'SUPPLIER' })
    expect(query('waiting')).toMatchObject({ waiting: true })
    expect(query('overdue')).toMatchObject({ overdue: true })
    expect(query('closed')).toMatchObject({ stage: ['CLOSED'] })
    expect(query('all')).toMatchObject({ open: false })
  })
})

describe('ncr: words from the facts, never the API English', () => {
  const t = createTranslator('en', messagesFor('en', ['ncr']).ncr!)
  const say = (words: Parameters<typeof sayWith>[2]) => sayWith(t, 'en-GB', words)

  it('the decided bar', () => {
    expect(say(decidedOf(RECORD.ncr).say)).toBe('28 of 40 pcs decided · 12 left')
    expect(decidedOf(RECORD.ncr).percent).toBe(70)
    expect(say(decidedOf(RECORD_READY.ncr).say)).toBe('All 40 pcs decided')
    expect(quantityText('51.8000', 'it-IT')).toBe('51,8')
  })

  it('the board refuses a move with what the card still needs', () => {
    const can = { manage: true, close: true }
    const open = { ...ROWS[0]!, next: { stage: 'CONTAINED' as const, ready: false, words: 'English' } }
    expect(say(laneHeld(open, 'CONTAINED', can))).toBe('No containment action is done yet: do one first (hold the stock, check the work in progress …).')
    expect(say(laneHeld(open, 'DECIDED', can))).toBe('An NCR moves one stage at a time: next is Contained.')
    const contained = { ...RECORD.ncr, next: { stage: 'DECIDED' as const, ready: false, words: null } }
    expect(say(laneHeld(contained, 'DECIDED', can))).toBe('28 of 40 pcs decided · 12 left: decide the rest first.')
    expect(say(laneHeld(contained, 'OPEN', can))).toBe('An NCR never goes back a stage.')
    expect(say(laneHeld(contained, 'DECIDED', { manage: false, close: true }))).toContain('quality.ncr.manage')
    const decided = { ...ROWS[4]!, next: { stage: 'CLOSED' as const, ready: false, words: null } }
    expect(say(laneHeld(decided, 'CLOSED', can))).toBe('1 decision waits for its stock move or follow-up record: carry it out first.')
    expect(say(laneHeld(decided, 'CLOSED', { manage: true, close: false }))).toContain('quality.ncr.close')
    expect(laneHeld({ ...decided, next: { stage: 'CLOSED', ready: true, words: null } }, 'CLOSED', can)).toBeNull()
  })

  it('every check of every key has words in both languages, with the counts', () => {
    for (const locale of LOCALES) {
      const tr = createTranslator(locale, messagesFor(locale, ['ncr']).ncr!)
      for (const key of STAGE_CHECKS)
        for (const ok of [true, false]) {
          const words = sayWith(tr, locale, checkSay(key, ok, factsOfRecord(RECORD), 'CLOSED'))!
          expect(words, `${locale} ${key} ${ok}`).not.toMatch(/^check\.|\{/)
        }
    }
    expect(say(checkSay('APPROVED', false, factsOfRecord(RECORD)))).toBe("1 decision waits for another person's approval.")
    expect(say(checkSay('APPROVED', false, factsOfSummary(ROWS[0]!)))).toBe("A decision waits for another person's approval.")
    expect(say(checkSay('HOLDS', true, factsOfRecord(RECORD)))).toBe('1 hold this NCR decides is closed with it.')
  })

  it('the band says why each action waits, from the record', () => {
    const band = bandHeld(RECORD)
    expect(band.edit).toBeNull()
    expect(say(band.decide)).toBe('28 of 40 pcs decided · 12 left: decide the rest first.')
    expect(say(band.close)).toBe('28 of 40 pcs decided · 12 left: decide the rest first.')
    expect(say(bandHeld(RECORD_OPEN).contain)).toBe('No containment action is done yet: do one first (hold the stock, check the work in progress …).')
    expect(bandHeld(RECORD_READY).close).toBeNull()
    expect(say(bandHeld(RECORD_READY).edit)).toBe('The NCR is decided: its problem is read-only now.')
    expect(stepsOf(RECORD)).toMatchObject({ current: 1, next: 'DECIDED' })
    expect(stepsOf(RECORD).missing.map(say)).toEqual(['28 of 40 pcs decided · 12 left: decide the rest first.', "1 decision waits for another person's approval."])
  })

  it('four eyes: the decider never approves; another person may', () => {
    const owner = ncrCan(templateOf('owner')!.permissions)
    const waiting = RECORD.decisions[1]!
    expect(say(decisionHeld(waiting, RECORD, owner, waiting.decidedById!).approve)).toBe('You decided this: another person approves it (four eyes).')
    expect(decisionHeld(waiting, RECORD, owner, 'someone-else').approve).toBeNull()
    expect(say(decisionHeld(waiting, RECORD, owner, 'someone-else').carryOut)).toBe("This decision waits for another person's approval first.")
    expect(say(decisionHeld(waiting, RECORD, ncrCan(templateOf('sales')!.permissions), 'x').approve)).toContain('quality.ncr.approve')
  })

  it('a refusal: our words; the checks of a 409; a stale version read again', () => {
    const checks = refusalOf(new ApiError('conflict', 409, 'conflict', 'Not yet.', null, [{ path: 'stage/ACTION_DONE', message: 'x' }, { path: 'stage/NO_OPEN_ACTION', message: 'y' }]))
    expect(checks).toMatchObject({ say: { key: 'problem.checks' }, checks: ['ACTION_DONE', 'NO_OPEN_ACTION'], detail: [], stale: false })
    const stale = refusalOf(new ApiError('conflict', 409, 'conflict', 'This Nonconformance changed since it was read', null, [{ path: 'version', message: 'v' }]))
    expect(stale).toMatchObject({ say: { key: 'problem.stale' }, stale: true, detail: [] })
    const invalid = refusalOf(new ApiError('invalid', 400, 'validation_failed', 'The NCR is not complete.', null, [{ path: 'body/severity', message: 'How serious it is.' }]))
    expect(invalid).toMatchObject({ say: { key: 'problem.invalid' }, fields: ['severity'], detail: ['The NCR is not complete.', 'How serious it is.'] })
  })

  it("a record the API names in English is said in the reader's words", () => {
    const it = createTranslator('it', messagesFor('it', ['ncr']).ncr!)
    expect(recordLabel(it, 'Lot', 'Lot DEMO-LOT-0007')).toBe('Lotto DEMO-LOT-0007')
    expect(recordLabel(it, 'WorkOrder', 'Work order WO-0150')).toBe('Ordine di lavoro WO-0150')
    expect(recordLabel(it, 'PurchaseOrder', 'Purchase order PO-0009')).toBe("Ordine d'acquisto PO-0009")
    expect(recordLabel(it, 'PpeRegisterEntry', 'PPE register REG-12')).toBe('Voce del registro DPI REG-12')
    expect(recordLabel(it, 'ReworkOrder', 'Rework of 4 on WO-0150')).toBe('Rilavorazione di 4 su WO-0150')
    expect(recordLabel(it, 'ReceiptDiscrepancy', 'Receipt GR-0003 discrepancy 2')).toBe('Entrata GR-0003, differenza 2')
    expect(recordLabel(it, 'ReturnLine', 'Return RMA-1 line 2')).toBe('Reso RMA-1, riga 2')
    expect(recordLabel(it, 'OperationScan', 'Scan of bundle BN-1 at Cucitura manica')).toBe('Lettura del pacco BN-1 a Cucitura manica')
    expect(recordLabel(it, 'QualityHold', 'Hold of Lot LOT-1, Hide HD-2')).toBe('Blocco di Lotto LOT-1, Pelle HD-2')
    expect(recordLabel(it, 'QualityHold', 'Hold of Lot')).toBe('Blocco di Lotto')
    expect(recordLabel(it, 'RepairOrder', 'RP-0004')).toBe('Riparazione RP-0004')
    expect(recordLabel(it, 'Style', null)).toBe('Modello')
    expect(recordLabel(t, 'ReworkOrder', 'Rework of 4 on WO-0150')).toBe('Rework of 4 on WO-0150')
  })
})

describe('ncr: New NCR', () => {
  it('Create is held with its reason until the NCR can be made', () => {
    const can = { raise: true }
    const dialog = { kind: 'new' as const, draft: EMPTY_DRAFT, from: null, defects: [], busy: false, notice: null }
    expect(newHeldKey(dialog, { raise: false })).toBe('new.heldRaise')
    expect(newHeldKey(dialog, can)).toBe('new.heldSite')
    expect(newHeldKey({ ...dialog, draft: { ...EMPTY_DRAFT, siteId: 's' } }, can)).toBe('new.heldTitle')
    expect(newHeldKey({ ...dialog, draft: { ...EMPTY_DRAFT, siteId: 's', title: 'Seam', quantityAffected: '0' } }, can)).toBe('new.heldQuantity')
    expect(newHeldKey({ ...dialog, draft: { ...EMPTY_DRAFT, siteId: 's', title: 'Seam', quantityAffected: '2,5' } }, can)).toBe('new.heldSeverity')
    expect(newHeldKey({ ...dialog, draft: { ...EMPTY_DRAFT, siteId: 's', title: 'Seam', quantityAffected: '2', severity: 'MINOR' } }, can)).toBeNull()
    expect(newHeldKey({ ...dialog, from: { recordType: 'Lot', recordId: 'x', prefill: null, problem: null } }, can)).toBe('new.heldReading')
  })

  it('a prefill fills what the record says', () => {
    const draft = draftOf({ ...(listScreen.cases.find((item) => item.id === 'new-from')!.model.model.dialog as { from: { prefill: Parameters<typeof draftOf>[0] } }).from.prefill }, EMPTY_DRAFT)
    expect(draft).toMatchObject({ title: 'Open seam at the left shoulder', quantityAffected: '13', severity: 'MAJOR', zone: 'SHOULDER_L', source: 'INSPECTION', foundAt: 'FINAL' })
  })
})

describe('ncr: the calls as the API takes them', () => {
  it('every write sends an Idempotency-Key and the version read', async () => {
    const calls: { url: string; method: string; body: unknown; headers: Headers }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init.headers) })
      return new Response(JSON.stringify({ record: RECORD }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const api = createApiClient({ baseUrl: '/api', fetch: fetcher, csrfToken: () => 'csrf-demo', company: 'DEMO' })
    await moveNcr(api, RECORD.ncr.id, { version: 9, to: 'DECIDED' })
    await editNcr(api, RECORD.ncr.id, { version: 9, ownerId: null })
    await raiseNcr(api, { title: 'Seam', quantityAffected: '2', severity: 'MINOR', siteId: RECORD.ncr.siteId }, 'key-1')
    expect(calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([`POST /api/quality/ncr/${RECORD.ncr.id}/stage`, `PATCH /api/quality/ncr/${RECORD.ncr.id}`, 'POST /api/quality/ncr'])
    expect(calls[0]!.body).toEqual({ version: 9, to: 'DECIDED' })
    expect(calls[2]!.headers.get('idempotency-key')).toBe('key-1')
    for (const call of calls) {
      expect(call.headers.get('idempotency-key'), call.url).toBeTruthy()
      expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
    }
  })
})

const LEFT_KEY =
  /\b(?:common|stage|severity|source|foundAt|recordType|uom|quantity|decided|due|age|check|checkName|board|held|problem|keys|close|list|view|tile|col|csv|new|zone)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs quality.ncr.manage"); file names are not keys. */
const SAID = /\b(?:quality\.ncr\.[a-z]+|quality\.defects\.view|tasks\.manage|files\.upload|production\.rework|purchasing\.claims\.manage|inventory\.[a-z]+|zip-pull\.jpg|shoulder-seam\.jpg)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('every list design case draws in both languages with no key left on screen', () => {
  it(`SCR-144: ${listScreen.cases.length} cases × it, en`, () => {
    for (const item of listScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(listScreen as unknown as DesignScreen<unknown>, item.model, locale).replace(SAID, '')
        expect(html.length, `${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('the board design case has a card in every lane but Closed and the closed lane counts', () => {
    expect(LANES.map((lane) => lane.cards.length)).toEqual([2, 1, 2, 1])
  })

  it('the dynamic words exist in both languages (stages, severities, sources, kinds, units, zones, record types)', () => {
    for (const locale of LOCALES) {
      const tr = createTranslator(locale, messagesFor(locale, ['ncr']).ncr!)
      const has = (key: string) => expect(tr(key), `${locale}: ${key}`).not.toBe(key)
      for (const stage of NCR_STAGES) has(`stage.${stage}`)
      for (const severity of DEFECT_CLASSES) has(`severity.${severity}`)
      for (const source of NCR_SOURCES) has(`source.${source}`)
      for (const stage of QUALITY_STAGES) has(`foundAt.${stage}`)
      for (const uom of UOMS) has(`uom.${uom}`)
      for (const zone of GARMENT_ZONES) has(`zone.${zone.id}`)
      for (const type of [...NCR_FROM_TYPES, ...NCR_LINK_TYPES]) has(`recordType.${type}`)
      for (const key of STAGE_CHECKS) has(`checkName.${key}`)
      for (const view of NCR_VIEWS) has(`view.${view}`)
      void CONTAINMENT_KINDS
    }
  })

  it('it and en hold the same keys', () => {
    const it = Object.keys(flattenMessages(messagesFor('it', ['ncr']).ncr)).sort()
    const en = Object.keys(flattenMessages(messagesFor('en', ['ncr']).ncr)).sort()
    expect(it).toEqual(en)
  })
})
