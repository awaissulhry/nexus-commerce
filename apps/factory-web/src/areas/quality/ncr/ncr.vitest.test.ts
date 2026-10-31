import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { CONTAINMENT_KINDS, NCR_FROM_TYPES, NCR_LINK_TYPES, NCR_SOURCES, NCR_STAGES, NCR_TITLE_KEYS, STAGE_CHECKS } from '@nexus/factory-domain/quality/ncr/rules'
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
import { assignNcrs, editNcr, getNcrSettings, moveNcr, ncrPrefill, raiseNcr, saveNcrSettings } from './api'
import { CONTAINMENT_SETTINGS, LANES, PREFILL_BUNDLE, PREFILL_DEFECTS, RECORD, RECORD_OPEN, RECORD_READY, ROWS } from './demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import { newHeldKey } from './list/view/NewNcrDialog'
import { draftOf, EMPTY_DRAFT } from './list/view-model'
import {
  assignRefusalKey,
  assignRefusals,
  bandHeld,
  checkSay,
  containmentDraftOf,
  containmentHoursOf,
  containmentSaveHeld,
  containmentSpan,
  defectIdsOf,
  titleWords,
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
    expect(sales.areas.find((area) => area.id === 'quality')?.sections?.flatMap((section) => section.items.map((item) => item.href))).toEqual(['/quality/ncr', '/quality/complaints'])
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

  it('B-W2b-17: picked defect lines ride on the address of New NCR from an inspection only', () => {
    const [a, b] = [ROWS[0]!.id, ROWS[1]!.id]
    const picked = ncrAddressOf(params(`new=1&from=Inspection&id=${RECORD.ncr.id}&defects=${a},${b},${a},nope`))
    expect(picked.defects).toEqual([a, b])
    expect(ncrAddressText(picked)).toBe(`?new=1&from=Inspection&id=${RECORD.ncr.id}&defects=${a}%2C${b}`)
    expect(ncrAddressOf(params(`new=1&from=Lot&id=${RECORD.ncr.id}&defects=${a}`)).defects).toEqual([])
    expect(ncrAddressOf(params('view=open')).defects).toEqual([])
    expect(newNcrAddress('/w/DEMO', { recordType: 'Inspection', recordId: RECORD.ncr.id }, [a])).toContain(`defects=${a}`)
    expect(defectIdsOf(Array.from({ length: 60 }, (_, index) => `0190f0e2-5399-7000-8000-${String(index).padStart(12, '0')}`).join(','))).toHaveLength(50)
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
    const dialog = { kind: 'new' as const, draft: EMPTY_DRAFT, from: null, defects: [], containment: null, busy: false, notice: null }
    expect(newHeldKey(dialog, { raise: false })).toBe('new.heldRaise')
    expect(newHeldKey(dialog, can)).toBe('new.heldSite')
    expect(newHeldKey({ ...dialog, draft: { ...EMPTY_DRAFT, siteId: 's' } }, can)).toBe('new.heldTitle')
    expect(newHeldKey({ ...dialog, draft: { ...EMPTY_DRAFT, siteId: 's', title: 'Seam', quantityAffected: '0' } }, can)).toBe('new.heldQuantity')
    expect(newHeldKey({ ...dialog, draft: { ...EMPTY_DRAFT, siteId: 's', title: 'Seam', quantityAffected: '2,5' } }, can)).toBe('new.heldSeverity')
    expect(newHeldKey({ ...dialog, draft: { ...EMPTY_DRAFT, siteId: 's', title: 'Seam', quantityAffected: '2', severity: 'MINOR' } }, can)).toBeNull()
    expect(newHeldKey({ ...dialog, from: { recordType: 'Lot', recordId: 'x', prefill: null, problem: null } }, can)).toBe('new.heldReading')
  })

  it('B-W2b-17: a prefill with title parts leaves the title to the reader\'s words; picked lines and the containment time', () => {
    expect(draftOf(PREFILL_DEFECTS, EMPTY_DRAFT).title).toBe('')
    expect(draftOf(PREFILL_DEFECTS, EMPTY_DRAFT, 'Due difetti').title).toBe('Due difetti')
    expect(draftOf(PREFILL_DEFECTS, { ...EMPTY_DRAFT, title: 'Typed first' }, 'Due difetti').title).toBe('Typed first')
    expect(draftOf(PREFILL_DEFECTS, EMPTY_DRAFT)).toMatchObject({ quantityAffected: '5', zone: '' })
    const dialog = listScreen.cases.find((item) => item.id === 'w2b-new-from-defects')!.model.model.dialog as { from: { prefill: { defectIds: string[] } } }
    expect(dialog.from.prefill.defectIds).toHaveLength(2)
  })

  it('a prefill fills what the record says', () => {
    const draft = draftOf({ ...(listScreen.cases.find((item) => item.id === 'new-from')!.model.model.dialog as { from: { prefill: Parameters<typeof draftOf>[0] } }).from.prefill }, EMPTY_DRAFT)
    expect(draft).toMatchObject({ title: 'Open seam at the left shoulder', quantityAffected: '13', severity: 'MAJOR', zone: 'SHOULDER_L', source: 'INSPECTION', foundAt: 'FINAL' })
  })
})

describe('ncr: B-W2b-17 words (titles in parts, the containment time, refused owners)', () => {
  it('every title key has words in both languages, plurals by count, no key or placeholder left', () => {
    const SAMPLE: Record<string, string> = { defect: 'SEAM-OPEN', defectWords: 'Cucitura aperta', inspection: 'INS-DEMO-0412', count: '2', operation: 'Attaccatura manica', operationCode: 'OP-30', reason: 'BROKEN', bundle: 'DEMO-BN-0031', workOrder: 'WO-DEMO-0150', serial: 'DEMO-SN-000412', lot: 'DEMO-LOT-0007', hide: 'DEMO-H-0031', receipt: 'GR-DEMO-0004', kind: 'WRONG_COLOUR', claim: 'CLM-DEMO-0003', reasonCode: 'SUSPECT', rma: 'RMA-DEMO-0002', description: 'Giacca Demo', complaint: 'CMP-DEMO-0004' }
    for (const locale of LOCALES) {
      const tr = createTranslator(locale, messagesFor(locale, ['ncr']).ncr!)
      for (const key of NCR_TITLE_KEYS) {
        const text = titleWords(tr, { key, values: SAMPLE })!
        expect(text, `${locale} ${key}`).not.toMatch(/title\.|\{[a-zA-Z]+\}/)
        expect(text.length, `${locale} ${key}`).toBeGreaterThan(5)
      }
      expect(titleWords(tr, { key: 'SCAN_REJECTED', values: { count: '1' } })).not.toMatch(/\{|title\./)
      expect(titleWords(tr, { key: 'DISCREPANCY', values: { kind: 'SHORT', receipt: 'GR-1' } })).not.toContain('SHORT')
      expect(titleWords(tr, { key: 'DISCREPANCY', values: { kind: 'NEW_KIND', receipt: 'GR-1' } })).toContain('NEW_KIND')
    }
    const it = createTranslator('it', messagesFor('it', ['ncr']).ncr!)
    expect(titleWords(it, PREFILL_BUNDLE.titleParts)).toBe('Pacco DEMO-BN-0031 scartato')
    expect(titleWords(it, PREFILL_DEFECTS.titleParts)).toBe("2 difetti all'ispezione INS-DEMO-0412")
    expect(titleWords(it, { key: 'INSPECTION_DEFECT', values: { defect: 'SEAM', defectWords: 'Open seam', inspection: 'INS-1', defectCodeId: 'd1' } }, () => 'Cucitura aperta')).toBe("Cucitura aperta all'ispezione INS-1")
    expect(titleWords(it, null)).toBeNull()
  })

  it('the containment time in words, its draft and why Save is held', () => {
    expect(containmentSpan(24)).toEqual({ key: 'containmentTime.days', params: { count: 1 } })
    expect(containmentSpan(36)).toEqual({ key: 'containmentTime.hours', params: { count: 36 } })
    expect(containmentSpan(8)).toEqual({ key: 'containmentTime.hours', params: { count: 8 } })
    const settings = CONTAINMENT_SETTINGS.settings
    expect(containmentDraftOf(settings)).toEqual({ follow: false, hours: '48' })
    expect(containmentDraftOf({ ...settings, own: null, inForce: { hours: 24, source: 'TENANT' } })).toEqual({ follow: true, hours: '24' })
    expect(containmentHoursOf({ follow: true, hours: 'x' })).toBeNull()
    expect(containmentHoursOf({ follow: false, hours: '8' })).toBe(8)
    expect(containmentHoursOf({ follow: false, hours: '721' })).toBeUndefined()
    expect(containmentHoursOf({ follow: false, hours: '0' })).toBeUndefined()
    expect(containmentSaveHeld({ mayChange: false, settings, draft: { follow: false, hours: '8' } })).toBe('containmentTime.heldNoRight')
    expect(containmentSaveHeld({ mayChange: true, settings: null, draft: { follow: false, hours: '8' } })).toBe('containmentTime.heldReading')
    expect(containmentSaveHeld({ mayChange: true, settings, draft: { follow: false, hours: '8' }, offline: true })).toBe('containmentTime.heldOffline')
    expect(containmentSaveHeld({ mayChange: true, settings, draft: { follow: false, hours: '900' } })).toBe('containmentTime.heldHours')
    expect(containmentSaveHeld({ mayChange: true, settings, draft: { follow: false, hours: '48' } })).toBe('containmentTime.heldSame')
    expect(containmentSaveHeld({ mayChange: true, settings, draft: { follow: false, hours: '8' } })).toBeNull()
    expect(containmentSaveHeld({ mayChange: true, settings, draft: { follow: true, hours: '48' } })).toBeNull()
    for (const locale of LOCALES) {
      const tr = createTranslator(locale, messagesFor(locale, ['ncr']).ncr!)
      for (const hours of [1, 8, 24, 48, 720]) expect(sayWith(tr, locale, containmentSpan(hours))).not.toMatch(/containmentTime|\{/)
      for (const key of ['heldNoRight', 'heldReading', 'heldOffline', 'heldHours', 'heldSame', 'source.COMPANY', 'source.TENANT', 'source.DEFAULT']) expect(tr(`containmentTime.${key}`)).not.toBe(`containmentTime.${key}`)
    }
  })

  it('a refused bulk owner: each NCR by its number and why, in our words', () => {
    expect(assignRefusalKey('NCR-1 changed since it was read: read the list again.')).toBe('assign.refused.stale')
    expect(assignRefusalKey('NCR-1: assigning an owner needs quality.ncr.manage at its site.')).toBe('assign.refused.noRight')
    expect(assignRefusalKey('NCR-1: The NCR is closed: it never changes.')).toBe('assign.refused.frozen')
    expect(assignRefusalKey('NCR not found.')).toBe('assign.refused.notFound')
    expect(assignRefusalKey('Something new')).toBe('assign.refused.other')
    // The API's codes win over the sentence (B-W2b-17: `ncrs/<i>/<CODE>`).
    expect(assignRefusalKey('Something new', 'CLOSED')).toBe('assign.refused.frozen')
    const picked = [ROWS[0]!, ROWS[1]!, ROWS[2]!]
    expect(assignRefusals([{ path: 'ncrs/0/NO_RIGHT', message: 'x' }], picked)).toEqual([{ number: picked[0]!.number, key: 'assign.refused.noRight' }])
    expect(assignRefusals([{ path: 'ncrs/1', message: 'changed since it was read' }, { path: 'ncrs/2', message: 'needs quality.ncr.manage' }, { path: 'body/ownerId', message: 'x' }], picked)).toEqual([
      { number: ROWS[1]!.number, key: 'assign.refused.stale' },
      { number: ROWS[2]!.number, key: 'assign.refused.noRight' },
    ])
    for (const locale of LOCALES) {
      const tr = createTranslator(locale, messagesFor(locale, ['ncr']).ncr!)
      for (const key of ['stale', 'noRight', 'frozen', 'notFound', 'other']) expect(tr(`assign.refused.${key}`, { number: 'NCR-1' })).toMatch(/^NCR-1: /)
      expect(tr('assign.refused.title', { count: 2, total: 3 })).not.toMatch(/\{/)
    }
  })
})

describe('ncr: the calls as the API takes them', () => {
  it('B-W2b-17: the prefill with picked lines, one bulk owner call, the containment time', async () => {
    const calls: { url: string; method: string; body: unknown; headers: Headers }[] = []
    const answers: Record<string, unknown> = {
      'GET /api/quality/ncr/prefill': { prefill: PREFILL_DEFECTS },
      'POST /api/quality/ncr/assign': { ncrs: [ROWS[0], ROWS[1]], changed: [ROWS[1]!.id] },
      'GET /api/quality/ncr/settings': CONTAINMENT_SETTINGS,
      'PUT /api/quality/ncr/settings': CONTAINMENT_SETTINGS,
    }
    const fetcher = (async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init.headers) })
      return new Response(JSON.stringify(answers[`${method} ${url.split('?')[0]}`]), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const api = createApiClient({ baseUrl: '/api', fetch: fetcher, csrfToken: () => 'csrf-demo', company: 'DEMO' })
    const prefill = await ncrPrefill(api, { recordType: 'Inspection', recordId: PREFILL_DEFECTS.fromId, defectIds: PREFILL_DEFECTS.defectIds })
    expect(prefill.defectIds).toEqual(PREFILL_DEFECTS.defectIds)
    expect(new URL(calls[0]!.url, 'http://x').searchParams.get('defectIds')).toBe(PREFILL_DEFECTS.defectIds.join(','))
    await ncrPrefill(api, { recordType: 'Lot', recordId: PREFILL_DEFECTS.fromId })
    expect(new URL(calls[1]!.url, 'http://x').searchParams.has('defectIds')).toBe(false)
    const assigned = await assignNcrs(api, { ncrs: [{ id: ROWS[0]!.id, version: 3 }, { id: ROWS[1]!.id, version: 1 }], ownerId: 'u1' }, 'key-assign')
    expect(assigned.changed).toEqual([ROWS[1]!.id])
    expect(calls[2]!.body).toEqual({ ncrs: [{ id: ROWS[0]!.id, version: 3 }, { id: ROWS[1]!.id, version: 1 }], ownerId: 'u1' })
    expect(calls[2]!.headers.get('idempotency-key')).toBe('key-assign')
    expect((await getNcrSettings(api, 'c1')).settings.inForce.hours).toBe(48)
    await saveNcrSettings(api, { companyId: 'c1', defaultContainmentHours: 8, version: 3 })
    expect(calls[4]!.body).toEqual({ companyId: 'c1', defaultContainmentHours: 8, version: 3 })
    expect(calls[4]!.headers.get('idempotency-key')).toBeTruthy()
  })

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
  /\b(?:common|stage|severity|source|foundAt|recordType|uom|quantity|decided|due|age|check|checkName|board|held|problem|keys|close|list|view|tile|col|csv|new|zone|containmentTime|assign|discrepancyKind)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
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
