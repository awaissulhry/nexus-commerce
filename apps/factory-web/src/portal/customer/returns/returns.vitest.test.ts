import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CASE_CHIPS as DOMAIN_CHIPS, COMPLAINT_CASE_STATES, MILESTONE_STEPS, OUTCOMES_WANTED, RECORDED_OUTCOMES_WANTED, RETURN_CASE_STATES } from '@nexus/factory-domain/sales/portal-returns/rules'
import { RETURN_DISPOSITIONS, RETURN_GRADES } from '@nexus/factory-domain/sales/returns/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { CASE_CHIPS } from './api'
import { CASES, complaintRecord, returnableRead, returnRecord } from './design-data'
import { designScreen as listScreen } from './fixtures'
import {
  cancelHeld,
  caseHref,
  casesCsv,
  complaintBodyOf,
  complaintStateOfStatus,
  complaintSteps,
  eightDProgress,
  EMPTY_START,
  itemLine,
  listQuery,
  nextStep,
  NS,
  offersCancel,
  photoProblem,
  photosHeld,
  photosLeft,
  refusalKey,
  returnBodyOf,
  returnSteps,
  sendHeld,
  sendPhotosHeld,
  startDirty,
  startHeld,
  startProblems,
  stateTone,
  stateWords,
  tabOf,
  threadTypeOf,
  viaKey,
  type PickedPhoto,
  type StartDraft,
} from './model'
// ---- B-TH-275
import { caseThreadHref, newOnCase, RECORD_TABS } from './model'
import { returnBandOf, complaintBandOf } from './band'
import { returnWords } from './design-data'
import { repairBandOf } from './repair/band'
import { REPAIR_THREAD_TYPE, repairTabOf } from './repair/model'
import { designScreen as repairScreen } from './repair/fixtures'
import { portalArrivalOf } from '../../shell/record/model'
// ---- end B-TH-275
import { designScreen as recordScreen } from './record/fixtures'
// ---- follow-up (th9-web-b)
import { returnableSchema } from './api'
import { itemFacts, orderFact } from './model'
// ---- end follow-up

/**
 * SCR-187 (B-W2b-197): the customer's Returns & claims, pure — the addresses and tabs, the steps of a return and of a
 * complaint, why Cancel, Add photos and Start wait (OUR words by code), the photos a person picks, what the start of a
 * return or a complaint sends and why Send waits, a refusal in our words, the CSV of the selected cases — the words of
 * every code in both languages, and every design case drawn in Italian and English with no raw key and no money.
 */

const t = createTranslator('en', CATALOGUE.en[NS] ?? {})
const at = (iso: string) => iso
const WHO = { preview: false, mayRequest: true, offline: false }
const has = (locale: 'it' | 'en', key: string) => {
  const flat = (tree: unknown, prefix = ''): string[] =>
    typeof tree === 'object' && tree !== null ? Object.entries(tree).flatMap(([name, value]) => (typeof value === 'string' ? [prefix + name] : flat(value, `${prefix}${name}.`))) : []
  const keys = new Set(flat(CATALOGUE[locale][NS]))
  return keys.has(key) || (keys.has(`${key}_one`) && keys.has(`${key}_other`))
}

describe('the web keeps the API’s codes', () => {
  it('chips, outcomes and steps are the domain’s', () => {
    expect([...CASE_CHIPS]).toEqual([...DOMAIN_CHIPS])
    expect([...OUTCOMES_WANTED]).toEqual(['REPLACE', 'REPAIR', 'CREDIT'])
    expect([...MILESTONE_STEPS]).toEqual(['ASKED', 'DECIDED', 'BACK_WITH_US', 'INSPECTED', 'OUTCOME'])
  })
})

describe('addresses and tabs', () => {
  it('writes the chip and search in the address (Open, the default, is left out)', () => {
    expect(listQuery('OPEN', '')).toBe('')
    expect(listQuery('WAITING', ' R-2026 ')).toBe('?chip=WAITING&q=R-2026')
    expect(listQuery(null, '', { start: 'RETURN' })).toBe('?start=RETURN')
  })

  it('a return and a complaint open their own page on Status; Messages lands on the docked thread (B-TH-275)', () => {
    expect(caseHref('/p/X', 'RETURN', 'r1')).toBe('/p/X/returns/r1?tab=status')
    expect(caseHref('/p/X', 'COMPLAINT', 'c1', 'request')).toBe('/p/X/returns/complaints/c1?tab=request')
    expect(caseThreadHref('/p/X', 'RETURN', 'r1')).toBe('/p/X/returns/r1?tab=messages')
    expect(tabOf('nonsense')).toBe('status')
    expect(tabOf('request')).toBe('request')
    expect(threadTypeOf('RETURN')).toBe('ReturnAuthorisation')
    expect(threadTypeOf('COMPLAINT')).toBe('Complaint')
  })
})

describe('words by code, never the API’s sentence', () => {
  it('a state this page knows takes OUR words; an unknown one falls back to the API’s pair', () => {
    expect(stateWords(t, 'en', 'RETURN', 'SEND_IT_BACK', { it: 'x', en: 'x' })).toBe('Approved — send it back')
    expect(stateWords(t, 'en', 'RETURN', 'SOMETHING_NEW', { it: 'nuovo', en: 'new' })).toBe('new')
    expect(stateTone('RETURN', 'SEND_IT_BACK')).toBe('warning')
    expect(stateTone('RETURN', 'NOT_ACCEPTED')).toBe('danger')
    expect(stateTone('COMPLAINT', 'ANSWERED')).toBe('success')
    expect(complaintStateOfStatus('TRIAGED')).toBe('INVESTIGATING')
    expect(viaKey('LINK')).toBe('via.LINK')
    expect(viaKey('FAX')).toBe('via.OTHER')
  })

  it('the item cell: the first item with size and serial, and how many more', () => {
    expect(itemLine(CASES[0]!, t)).toEqual({ main: 'JKT-DEMO-01 Giacca Demo Touring · size 52 · serial SN-DEMO-000123', more: '+ 1 more item' })
  })
})

describe('where it is', () => {
  it('a return’s five steps for the DS tracker, each done with its day', () => {
    const steps = returnSteps(returnRecord('AUTHORISED').progress.milestones, t, at)
    expect(steps.map((step) => [step.id, step.state])).toEqual([
      ['ASKED', 'done'],
      ['DECIDED', 'done'],
      ['BACK_WITH_US', 'current'],
      ['INSPECTED', 'todo'],
      ['OUTCOME', 'todo'],
    ])
    expect(steps[0]!.label).toBe('Asked')
    expect(steps[0]!.date).not.toBeNull()
  })

  it('a complaint: received, being investigated, answered, closed (answered skipped when closed without a letter)', () => {
    expect(complaintSteps(complaintRecord('INVESTIGATING'), t, at).map((step) => step.state)).toEqual(['done', 'current', 'todo', 'todo'])
    expect(complaintSteps(complaintRecord('ANSWERED'), t, at).map((step) => step.state)).toEqual(['done', 'done', 'done', 'current'])
    expect(complaintSteps({ ...complaintRecord('CLOSED'), progress: { answerBy: null, answeredAt: null } }, t, at).map((step) => step.state)).toEqual(['done', 'done', 'skipped', 'done'])
  })

  it('the 8D bar from the step reached (the domain’s own words); a plain CAPA has none', () => {
    expect(eightDProgress({ en: 'D4 Root cause', it: 'D4 Causa radice' })).toEqual({ done: 3, of: 8 })
    expect(eightDProgress({ en: 'D8 Closure — done', it: 'D8 Chiusura — fatto' })).toEqual({ done: 8, of: 8 })
    expect(eightDProgress({ en: 'Plan', it: 'Pianificazione' })).toBeNull()
    expect(eightDProgress(null)).toBeNull()
  })
})

describe('why an act waits', () => {
  it('Cancel: a preview, may not ask, the goods are back, closed, offline — in that order', () => {
    const approved = returnRecord('AUTHORISED')
    expect(cancelHeld(approved, WHO)).toBeNull()
    expect(cancelHeld(approved, { ...WHO, preview: true })).toBe('held.preview')
    expect(cancelHeld(approved, { ...WHO, mayRequest: false })).toBe('held.mayRequest')
    expect(cancelHeld(returnRecord('RECEIVED'), WHO)).toBe('held.goodsBack')
    expect(cancelHeld(returnRecord('CLOSED'), WHO)).toBe('held.closed')
    expect(cancelHeld(approved, { ...WHO, offline: true })).toBe('held.offline')
    expect(offersCancel(returnRecord('INSPECTED'))).toBe(true)
    expect(offersCancel(returnRecord('CANCELLED'))).toBe(false)
  })

  it('Add photos: until we decide (a return) or answer (a complaint); the upload right; offline', () => {
    const who = { ...WHO, mayUpload: true }
    expect(photosHeld('RETURN', returnRecord('RECEIVED'), who)).toBeNull()
    expect(photosHeld('RETURN', returnRecord('INSPECTED'), who)).toBe('held.decided')
    expect(photosHeld('COMPLAINT', complaintRecord('ANSWERED'), who)).toBe('held.answered')
    expect(photosHeld('RETURN', returnRecord('REQUESTED'), { ...who, mayUpload: false })).toBe('held.mayUpload')
    expect(photosHeld('RETURN', returnRecord('REQUESTED'), { ...who, offline: true })).toBe('held.offline')
  })

  it('Start: a preview, may not ask, offline', () => {
    expect(startHeld(WHO)).toBeNull()
    expect(startHeld({ ...WHO, preview: true })).toBe('held.preview')
    expect(startHeld({ ...WHO, mayRequest: false })).toBe('held.mayRequest')
    expect(startHeld({ ...WHO, offline: true })).toBe('held.offline')
  })
})

describe('photos', () => {
  it('a photo the API takes: JPEG, PNG, WebP or HEIC up to 15 MB', () => {
    expect(photoProblem({ type: 'image/jpeg', size: 2_000_000 })).toBeNull()
    expect(photoProblem({ type: 'image/jpg', size: 2_000_000 })).toBeNull()
    expect(photoProblem({ type: 'application/pdf', size: 2_000 })).toBe('photos.problem.type')
    expect(photoProblem({ type: 'image/png', size: 16 * 1_048_576 })).toBe('photos.problem.size')
  })

  it('10 per record; Send waits with nothing to send or while sending', () => {
    const photo = (state: PickedPhoto['state'], problem: string | null = null): PickedPhoto => ({ id: Math.random().toString(), name: 'a.jpg', type: 'image/jpeg', size: 1, state, problem })
    expect(photosLeft(8, [photo('waiting'), photo('waiting', 'photos.problem.type')])).toBe(1)
    expect(photosLeft(10, [])).toBe(0)
    expect(sendPhotosHeld([photo('waiting')], null, false)).toBeNull()
    expect(sendPhotosHeld([photo('sent')], null, false)).toBe('photos.held.none')
    expect(sendPhotosHeld([photo('waiting')], null, true)).toBe('held.busy')
    expect(sendPhotosHeld([photo('waiting')], 'held.preview', false)).toBe('held.preview')
  })
})

describe('Start a return or claim', () => {
  const read = returnableRead()
  const draft = (over: Partial<StartDraft>): StartDraft => ({ ...EMPTY_START, ...over })

  it('a choice first; then the details, each problem at its field', () => {
    expect(nextStep(draft({}), read)).toEqual({ problems: { type: 'start.problem.type' } })
    expect(nextStep(draft({ type: 'RETURN' }), read)).toEqual({ step: 'details' })
    const problems = startProblems(draft({ step: 'details', type: 'RETURN', lines: { 'line-1|52': { picked: true, quantity: '9', reasonCode: 'DEFECT', reasonNote: '', serial: '' } } }), read)
    expect(problems).toEqual({ 'line-1|52.quantity': 'start.problem.tooMany', 'line-1|52.reasonNote': 'start.problem.reasonNote' })
    expect(startProblems(draft({ step: 'details', type: 'RETURN' }), read)).toEqual({ lines: 'start.problem.lines' })
    expect(startProblems(draft({ step: 'details', type: 'COMPLAINT' }), read)).toEqual({ description: 'start.problem.description' })
  })

  it('sends the picked items with their pieces and reasons, what they would like, their reference and note', () => {
    const body = returnBodyOf(draft({ type: 'RETURN', lines: { 'line-1|52': { picked: true, quantity: ' 2 ', reasonCode: 'WRONG_SIZE', reasonNote: ' ', serial: 'SN-1' }, 'line-2|50': { picked: false, quantity: '1', reasonCode: '', reasonNote: '', serial: '' } }, outcomeWanted: 'CREDIT', customerRef: ' BA-1 ', note: '' }), read)
    expect(body).toEqual({
      lines: [{ invoiceLineId: read.items[0]!.invoiceLineId, salesOrderLineId: read.items[0]!.salesOrderLineId, size: '52', quantity: 2, reasonCode: 'WRONG_SIZE', reasonNote: null, serial: 'SN-1' }],
      outcomeWanted: 'CREDIT',
      customerRef: 'BA-1',
      note: null,
    })
  })

  it('a complaint names the order line and size of the item picked, or none', () => {
    expect(complaintBodyOf(draft({ type: 'COMPLAINT', itemKey: 'line-1|54', description: ' Open seam ', serial: '', batchNumber: 'LOT-1' }), read)).toEqual({ description: 'Open seam', salesOrderLineId: read.items[1]!.salesOrderLineId, size: '54', serial: null, batchNumber: 'LOT-1', customerRef: null })
    expect(complaintBodyOf(draft({ type: 'COMPLAINT', description: 'x' }), read).salesOrderLineId).toBeNull()
  })

  it('Send waits: may not ask, still reading, sending, problems; typed work is guarded', () => {
    const ok = draft({ step: 'review', type: 'COMPLAINT', description: 'x' })
    expect(sendHeld(ok, read, { ...WHO, busy: false })).toBeNull()
    expect(sendHeld(ok, null, { ...WHO, busy: false })).toBe('held.reading')
    expect(sendHeld(ok, read, { ...WHO, busy: true })).toBe('held.busy')
    expect(sendHeld(draft({ step: 'review', type: 'COMPLAINT' }), read, { ...WHO, busy: false })).toBe('start.held.problems')
    expect(startDirty(draft({ type: 'RETURN' }))).toBe(false)
    expect(startDirty(ok)).toBe(true)
  })
})

describe('a refusal in our words', () => {
  it('maps the API’s kinds and issue paths to keys (never the API’s English)', () => {
    expect(refusalKey(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/lines/0/quantity' }]))).toBe('start.problem.tooManyNow')
    expect(refusalKey(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('problem.changed')
    expect(refusalKey(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('problem.forbidden')
    expect(refusalKey(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/contentType' }]))).toBe('photos.problem.type')
    expect(refusalKey(new Error('x'))).toBe('problem.internal')
  })
})

describe('the CSV of the selected cases', () => {
  it('the list’s columns in the person’s words; no money', () => {
    const csv = casesCsv([CASES[0]!], t, 'en', at).split('\n')
    expect(csv[0]).toBe('Case;Your reference;Type;Item;Opened;Status;Next step;Last update')
    expect(csv[1]).toContain('R-2026-0031;BA-RES-11;Return;')
    expect(csv[1]).toContain('Approved — send it back')
    expect(csv.join('\n')).not.toMatch(/€/)
  })
})

describe('words', () => {
  it('every code the pages word has its words in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const keys = [
        ...DOMAIN_CHIPS.map((chip) => `chip.${chip}`),
        ...RETURN_CASE_STATES.map((state) => `state.RETURN.${state}`),
        ...COMPLAINT_CASE_STATES.map((state) => `state.COMPLAINT.${state}`),
        ...MILESTONE_STEPS.map((step) => `step.${step}`),
        ...COMPLAINT_CASE_STATES.map((state) => `step.${state}`),
        // B-W2b-368: the recorded wish (REMAKE too) is shown on the request.
        ...RECORDED_OUTCOMES_WANTED.map((code) => `outcome.${code}`),
        ...RETURN_GRADES.map((grade) => `grade.${grade}`),
        ...RETURN_DISPOSITIONS.map((code) => `disposition.${code}`),
        ...['PORTAL', 'LINK', 'OFFICE', 'EMAIL', 'PHONE', 'OTHER'].map((via) => `via.${via}`),
        ...['RETURN', 'COMPLAINT'].flatMap((type) => [`type.${type}`, `start.type.${type}`, `start.typeBody.${type}`]),
        ...['preview', 'previewFiles', 'mayRequest', 'mayUpload', 'goodsBack', 'closed', 'decided', 'answered', 'offline', 'busy', 'reading', 'noDocuments', 'noPdf'].map((key) => `held.${key}`),
        ...['internal', 'forbidden', 'missing', 'changed', 'invalid', 'tooMany', 'unavailable', 'signedOut', 'documentForbidden', 'documentFailed'].map((key) => `problem.${key}`),
        ...['type', 'lines', 'tooManyLines', 'quantity', 'tooMany', 'tooManyNow', 'reason', 'reasonNote', 'long', 'description'].map((key) => `start.problem.${key}`),
        ...['type', 'size', 'full', 'failed'].map((key) => `photos.problem.${key}`),
        'photos.held.none',
        'start.held.problems',
      ]
      expect(keys.filter((key) => !has(locale, key)), locale).toEqual([])
    }
  })

  it('both catalogues hold the same keys', () => {
    const flat = (tree: unknown, prefix = ''): string[] =>
      typeof tree === 'object' && tree !== null ? Object.entries(tree).flatMap(([name, value]) => (typeof value === 'string' ? [prefix + name] : flat(value, `${prefix}${name}.`))) : []
    expect(flat(CATALOGUE.it[NS]).sort()).toEqual(flat(CATALOGUE.en[NS]).sort())
  })
})

const KEY = /\b(?:list|row|bulk|held|band|keys|chips|chip|col|state|ref|tabs|record|via|step|next|notice|messages|unsaved|problem|complaints|request|status|grade|disposition|outcome|cancel|photos|viewer|start|offline|noAccess|item|type|nav)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-187 design cases', () => {
  for (const screen of [listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: every case draws in Italian and English with no raw key and no money`, () => {
      for (const locale of ['it', 'en'] as const) {
        for (const entry of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: entry.model })))
          expect(html, `${screen.screen}/${entry.id} (${locale})`).toContain('main-content')
          expect(html.match(KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${entry.id} (${locale})`).not.toMatch(/€/)
          expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        }
      }
    })
  }
})

// ---- B-TH-275 (threads plan TH-6; P-CUS-RET, P-CUS-CMP, P-CUS-REP, P-CUS-RET-LIST; picture 22): the cases on the portal record
// frame — tabs 3 → 2, the conversation docked (no Messages tab, no Ask modal), the repair's OWN thread, the list's new-messages mark.
describe('B-TH-275 — returns, complaints and repairs dock their conversation', () => {
  const draw = (screen: DesignScreen<unknown>, id: string, locale: 'it' | 'en' = 'en') =>
    renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, Object.keys(CATALOGUE[locale])) }, createElement(screen.view, { model: screen.cases.find((item) => item.id === id)!.model })))

  it('tabs 3 → 2 (Request, Status); an old ?tab=messages lands on Status with the conversation shown and focused', () => {
    expect([...RECORD_TABS]).toEqual(['request', 'status'])
    expect((RECORD_TABS as readonly string[]).includes('messages')).toBe(false)
    expect(tabOf('messages')).toBe('status')
    expect(tabOf(null)).toBe('status')
    const href = caseThreadHref('/p/X', 'COMPLAINT', 'c1')
    expect(href).toBe('/p/X/returns/complaints/c1?tab=messages')
    expect(portalArrivalOf(href.slice(href.indexOf('?')))).toEqual({ openThread: true, focus: true })
  })

  it('the bands: two link tabs, "Ask a question" about the case itself', () => {
    const words = returnWords('en')
    const ret = returnRecord('AUTHORISED')
    const band = returnBandOf({ words, record: ret, tab: 'status', prefix: '/p/X', facts: { photosHeld: null, cancelHeld: null, labelHref: null, creditNotes: [] } })
    expect(band.tabs?.items.map((item) => item.id)).toEqual(['request', 'status'])
    expect(band.ask).toEqual({ type: 'ReturnAuthorisation', id: ret.id, label: ret.number })
    const complaint = complaintRecord('INVESTIGATING')
    const cband = complaintBandOf({ words, record: complaint, tab: 'request', prefix: '/p/X', photosHeld: null })
    expect(cband.tabs?.items.map((item) => item.id)).toEqual(['request', 'status'])
    expect(cband.ask?.type).toBe('Complaint')
  })

  it('a repair has its OWN thread (RepairOrder, B-TH-081): docked, and "Ask a question" asks about the repair', () => {
    expect(REPAIR_THREAD_TYPE).toBe('RepairOrder')
    expect(repairTabOf('messages')).toBe('status')
    const html = draw(repairScreen as unknown as DesignScreen<unknown>, 'estimate')
    expect(html.match(/<aside/g)?.length).toBe(1)
    expect(html).toContain('id="messages"')
    expect(html).toContain('data-mode="docked"')
    const page = readFileSync(new URL('./repair/RepairPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('<PortalThread type={REPAIR_THREAD_TYPE} id={repair.id} showRecord={false} />')
    const bandSource = readFileSync(new URL('./repair/band.ts', import.meta.url), 'utf8')
    expect(bandSource).toContain("ask: { type: 'RepairOrder', id: repair.id, label: repair.number }")
    expect(typeof repairBandOf).toBe('function')
  })

  it('a return and a complaint: ONE docked conversation beside the tab; narrower, "Messages (2 new)"', () => {
    const screen = recordScreen as unknown as DesignScreen<unknown>
    const docked = draw(screen, 'approved')
    expect(docked.match(/<aside/g)?.length).toBe(1)
    expect(docked).toContain('id="messages"')
    expect(docked).not.toContain('tab=messages')
    const narrow = draw(screen, 'th-275-narrow')
    expect(narrow).toContain('data-mode="stacked"')
    expect(narrow).toContain('Messages (2 new)')
    expect(draw(screen, 'complaint-narrow')).toContain('Messages (2 new)')
    // The case pages draw no office SO- order number (plan §0.5): the replacement order and the complaint's order in words.
    for (const entry of screen.cases) expect(draw(screen, entry.id).match(/\bSO-\d{4}-\d+/)?.[0] ?? null, entry.id).toBeNull()
  })

  it('the list: the person’s own new messages per case; the cell and the row’s Messages open the case with its conversation shown', () => {
    expect(newOnCase({ r1: { newCount: 2 } }, 'r1')).toBe(2)
    expect(newOnCase({ r1: { newCount: 2 } }, 'r2')).toBe(0)
    expect(newOnCase(null, 'r1')).toBe(0)
    // The column only with the thread right (`unread` null: no column); its door and the row menu's Messages are the same address.
    const view = readFileSync(new URL('./view/ReturnsListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('...(latest.current.model.unread')
    expect(view).toContain("href={caseThreadHref(latest.current.model.prefix, data.type, data.id)}")
    expect(view).toContain("{ id: 'messages', label: t('row.messages'), href: caseThreadHref(prefix, data.type, data.id) }")
    // ONE read of the cases shown, by each case's own thread type (a return's, a complaint's), through the portal's own client.
    const page = readFileSync(new URL('./ReturnsPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('(read?.items ?? []).map((item) => ({ recordType: threadTypeOf(item.type), id: item.id }))')
    expect(page).toContain('unread: readsThreads ? unread : null')
    expect(listScreen.cases.some((item) => item.id === 'th-275-new-messages')).toBe(true)
  })

  it('the words of the docked conversation exist in both languages; no Messages tab word is left', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale][NS]!
      expect(words['messages.labelReturn'], locale).toBeTruthy()
      expect(words['messages.labelComplaint'], locale).toBeTruthy()
      expect(words['status.replacementOpen'], locale).toBeTruthy()
      expect(words['request.orderOpen'], locale).toBeTruthy()
      expect(words['tabs.messages']).toBeUndefined()
      expect(words['messages.hint']).toBeUndefined()
      expect(CATALOGUE[locale]['returns-repair']!['portal.record.messagesLabel'], locale).toBeTruthy()
    }
  })
})
// ---- end B-TH-275

// ---- follow-up (th9-web-b; plan §0.5 "counts do not leak"): the start dialog names the customer's OWN order, never the office series.
describe('the order an item came on, in the customer’s own number', () => {
  const base = returnableRead().items[0]!
  const withOrder = (order: NonNullable<typeof base.order>) => ({ ...base, order })

  it('says “your order 12, line 1” from the customer’s own number, in both languages, and never an office number', () => {
    const own = withOrder({ id: 'o', yourNumber: { seq: 12, words: { en: 'Your order 12', it: 'Il vostro ordine 12' } }, yourRef: 'BA-PO-771', lineSeq: 1 })
    expect(orderFact(own.order, t)).toBe('your order 12, line 1')
    expect(orderFact(own.order, createTranslator('it', CATALOGUE.it[NS] ?? {}))).toBe('tuo ordine 12, riga 1')
    expect(itemFacts(own, t)[0]).toBe('your order 12, line 1')
    expect(itemFacts(own, t).join(' · ')).not.toMatch(/SO-/)
  })

  it('falls back to the PO they gave, then to “one of your orders”', () => {
    expect(orderFact({ id: 'o', yourNumber: null, yourRef: 'BA-PO-771', lineSeq: 2 }, t)).toBe('your PO BA-PO-771, line 2')
    expect(orderFact({ id: 'o', yourNumber: null, yourRef: null, lineSeq: 3 }, t)).toBe('one of your orders, line 3')
  })

  it('reads an answer with the customer’s number and refuses one that names only the office series', () => {
    const answer = { ...returnableRead(), items: [{ ...base, order: { id: 'o', yourNumber: { seq: 7, words: { en: 'Your order 7', it: 'Il vostro ordine 7' } }, yourRef: null, lineSeq: 1 } }] }
    expect(returnableSchema.parse(answer).items[0]!.order).toEqual({ id: 'o', yourNumber: { seq: 7, words: { en: 'Your order 7', it: 'Il vostro ordine 7' } }, yourRef: null, lineSeq: 1 })
    expect(returnableSchema.safeParse({ ...answer, items: [{ ...base, order: { id: 'o', number: 'SO-2026-0141', lineSeq: 1 } }] }).success).toBe(false)
  })

  it('has the three words in Italian and English', () => {
    for (const locale of ['it', 'en'] as const) for (const key of ['start.orderLine', 'start.orderRefLine', 'start.orderLineOnly']) expect(has(locale, key), `${locale} ${key}`).toBe(true)
  })
})
// ---- end follow-up
