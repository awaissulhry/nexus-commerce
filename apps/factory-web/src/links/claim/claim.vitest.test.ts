import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMPLAINT_CASE_STATES, RETURN_CASE_STATES } from '@nexus/factory-domain/sales/portal-returns/rules'
import { ApiError } from '../../lib/api/errors'
import { linkTaskOf } from '../_nav/link-types'
import { claimPageSchema, type ClaimItem, type ClaimPage } from './api'
import { designScreen } from './fixtures'
import {
  bodyOf,
  caseStateKey,
  CASE_GROUP,
  complaintItems,
  draftDataOf,
  EMPTY_FORM,
  formFromDraft,
  issueProblem,
  lineIdFor,
  photosInForm,
  photosNeeded,
  problemsIn,
  problemsOf,
  sendHeldKey,
  sendRefusal,
  togglePick,
  uploadSummary,
  WHOLE_DELIVERY,
  type ClaimForm,
} from './model'

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../messages/${locale}/link-claim.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
/** A key the page says, as the translator finds it (a plural key by its `_one` / `_other` forms). */
const has = (keys: Record<string, string>, key: string) => key in keys || (`${key}_one` in keys && `${key}_other` in keys)

const start = designScreen.cases.find((entry) => entry.id === 'start')!.model.page!
const item = (key: string): ClaimItem => start.items.find((entry) => entry.key === key)!
const [JACKET, PANTS, GLOVES] = start.items as [ClaimItem, ClaimItem, ClaimItem, ClaimItem]
const returnForm = (): ClaimForm => designScreen.cases.find((entry) => entry.id === 'review-return')!.model.form
const complaintForm = (): ClaimForm => designScreen.cases.find((entry) => entry.id === 'review-complaint')!.model.form

describe('SCR-197 Report a problem — the link page', () => {
  it('a CLAIM link of a shipment or an order opens this page (link-type registry)', () => {
    expect(linkTaskOf({ purpose: 'CLAIM', record: { type: 'Shipment' } })).toBe('report-problem')
    expect(linkTaskOf({ purpose: 'CLAIM', record: { type: 'SalesOrder' } })).toBe('report-problem')
  })

  it('checks step by step: what you need, the items and their pieces, the reasons, the photos of a damage', () => {
    expect(problemsOf(EMPTY_FORM, start, [])).toEqual([{ step: 'type', field: 'type', key: 'check.type' }])
    const none = problemsOf({ ...EMPTY_FORM, type: 'RETURN' }, start, [])
    expect(problemsIn(none, 'item')).toEqual([{ step: 'item', field: 'items', key: 'check.items' }])
    const form = togglePick({ ...EMPTY_FORM, type: 'RETURN' }, JACKET)
    expect(form.picks).toEqual([{ key: JACKET.key, quantity: 1, reasonCode: null, reasonNote: '', serial: '' }])
    const tooMany = { ...form, picks: [{ ...form.picks[0]!, quantity: JACKET.canReturn + 1 }] }
    expect(problemsIn(problemsOf(tooMany, start, []), 'item')).toEqual([{ step: 'item', field: `pick.${JACKET.key}.quantity`, key: 'check.quantityMax', params: { max: JACKET.canReturn } }])
    expect(problemsIn(problemsOf(form, start, []), 'details')).toEqual([{ step: 'details', field: `pick.${JACKET.key}.reason`, key: 'check.reason' }])
    const defect = { ...form, picks: [{ ...form.picks[0]!, reasonCode: 'DEFECT' }] }
    expect(problemsIn(problemsOf(defect, start, []), 'details')).toEqual([{ step: 'details', field: `pick.${JACKET.key}.reasonNote`, key: 'check.reasonNote' }])
    // A defect needs two photos; a wrong size none.
    expect(photosNeeded(defect, JACKET.key)).toBe(2)
    expect(problemsIn(problemsOf(defect, start, [{ group: JACKET.key }]), 'photos')).toEqual([{ step: 'photos', field: `photos.${JACKET.key}`, key: 'check.photos', params: { count: 1, needed: 2 } }])
    expect(photosNeeded({ ...form, picks: [{ ...form.picks[0]!, reasonCode: 'WRONG_SIZE' }] }, JACKET.key)).toBe(0)
    expect(problemsOf(returnForm(), start, [{ group: JACKET.key }, { group: JACKET.key }])).toEqual([])
  })

  it('an item with nothing left is never picked; a page with nothing to send back says so', () => {
    expect(togglePick({ ...EMPTY_FORM, type: 'RETURN' }, GLOVES).picks).toEqual([])
    const empty: ClaimPage = { ...start, items: [GLOVES] }
    expect(problemsIn(problemsOf({ ...EMPTY_FORM, type: 'RETURN' }, empty, []), 'item')[0]?.key).toBe('check.nothingBack')
  })

  it('a complaint names one item (or the whole delivery), says what happened, and shows two photos', () => {
    const form: ClaimForm = { ...EMPTY_FORM, type: 'COMPLAINT' }
    const problems = problemsOf(form, start, [])
    expect(problems.map((problem) => problem.key)).toEqual(['check.complaintItem', 'check.description', 'check.photos'])
    expect(photosNeeded(form, CASE_GROUP)).toBe(2)
    expect(problemsOf(complaintForm(), start, [{ group: CASE_GROUP }, { group: CASE_GROUP }])).toEqual([])
    expect(complaintItems(start).map((entry) => entry.key)).toEqual(start.items.map((entry) => entry.key))
    expect(problemsOf({ ...complaintForm(), itemKey: WHOLE_DELIVERY }, start, [{ group: CASE_GROUP }, { group: CASE_GROUP }])).toEqual([])
  })

  it('the body is the API’s: a return’s lines from the items picked, words trimmed, empty words left out', () => {
    const body = bodyOf({ ...returnForm(), typedName: '  Anna Esempio ' }, start)
    expect(body).toMatchObject({ type: 'RETURN', typedName: 'Anna Esempio', outcomeWanted: 'REPLACE', customerRef: 'PO-DEMO-17' })
    if (body.type !== 'RETURN') throw new Error('a return')
    expect(body.lines).toEqual([
      { invoiceLineId: null, salesOrderLineId: JACKET.salesOrderLineId, size: 'M', quantity: 2, reasonCode: 'DEFECT', reasonNote: 'La cucitura della spalla destra si è aperta dopo due giorni.', serial: '0000-DEMO-48' },
      { invoiceLineId: null, salesOrderLineId: PANTS.salesOrderLineId, size: 'L', quantity: 1, reasonCode: 'WRONG_SIZE', reasonNote: null, serial: null },
    ])
    const whole = bodyOf({ ...complaintForm(), itemKey: WHOLE_DELIVERY }, start)
    expect(whole).toMatchObject({ type: 'COMPLAINT', salesOrderLineId: null, size: null, serial: '0000-DEMO-48', batchNumber: 'L-DEMO-311', typedName: null })
    expect(bodyOf(complaintForm(), start)).toMatchObject({ salesOrderLineId: JACKET.salesOrderLineId, size: 'M' })
  })

  it('the draft comes back made to fit the page: items gone dropped, pieces within what is left, unknown reasons cleared', () => {
    const saved = draftDataOf({ ...returnForm(), picks: [...returnForm().picks.map((pick) => ({ ...pick, quantity: 9 })), { key: 'gone', quantity: 1, reasonCode: null, reasonNote: '', serial: '' }] }, 'details')
    const restored = formFromDraft(saved, { ...start, reasons: start.reasons.filter((reason) => reason.code !== 'WRONG_SIZE') })!
    expect(restored.step).toBe('details')
    expect(restored.form.picks.map((pick) => [pick.key, pick.quantity, pick.reasonCode])).toEqual([
      [JACKET.key, JACKET.canReturn, 'DEFECT'],
      [PANTS.key, PANTS.canReturn, null],
    ])
    expect(formFromDraft(draftDataOf(EMPTY_FORM, 'type'), start)).toBeNull()
    expect(formFromDraft({ v: 2 }, start)).toBeNull()
    expect(formFromDraft(draftDataOf({ ...complaintForm(), type: 'COMPLAINT' }, 'photos'), { ...start, types: ['RETURN'] })?.step).toBe('type')
  })

  it('a refused send says where: the pieces at their item, the link gone, a lost answer kept with the same key', () => {
    const form = returnForm()
    const above = sendRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/lines/1/quantity' }]), form)
    expect(above).toEqual({ key: 'problem.aboveSold', issues: [{ step: 'item', field: `pick.${PANTS.key}.quantity`, key: 'refusal.quantity' }], reload: true, keepKey: false })
    expect(sendRefusal(new ApiError('conflict', 409, 'invalid_state', 'x'), form)).toMatchObject({ key: 'problem.changed', reload: true })
    expect(sendRefusal(new ApiError('not_found', 404, 'not_found', 'x'), form)).toMatchObject({ link: 'unavailable', keepKey: false })
    expect(sendRefusal(new ApiError('unavailable', 503, 'network', 'x'), form)).toMatchObject({ key: 'problem.unavailable', keepKey: true })
    expect(sendRefusal(new Error('boom'), form)).toMatchObject({ key: 'problem.internal', keepKey: true })
    expect(issueProblem({ path: 'body/lines/0/reasonNote' }, form)).toEqual({ step: 'details', field: `pick.${JACKET.key}.reasonNote`, key: 'check.reasonNote' })
    expect(issueProblem({ path: 'body/description' }, complaintForm())).toEqual({ step: 'details', field: 'description', key: 'check.description' })
    expect(issueProblem({ path: 'body/typedName' }, form).step).toBe('review')
  })

  it('photos go onto the line of their item (the API numbers the lines 10, 20 … in the order sent)', () => {
    const lines = [
      { id: 'l10', seq: 10 },
      { id: 'l20', seq: 20 },
    ]
    expect(lineIdFor(PANTS.key, returnForm().picks, lines)).toBe('l20')
    expect(lineIdFor(CASE_GROUP, returnForm().picks, lines)).toBeNull()
    expect(lineIdFor(JACKET.key, returnForm().picks, [])).toBeNull()
    expect(photosInForm({ ...returnForm(), picks: returnForm().picks.slice(1) }, [{ group: JACKET.key }, { group: PANTS.key }])).toEqual([{ group: PANTS.key }])
    expect(uploadSummary({ a: 'sent', b: 'failed', c: 'sending' })).toEqual({ total: 3, sent: 1, failed: 1, busy: 1 })
  })

  it('the send is held when the link expired or took its last report', () => {
    expect(sendHeldKey(start)).toBeNull()
    expect(sendHeldKey({ link: { ...start.link, usesLeft: 0 } })).toBe('send.held.used')
    expect(sendHeldKey({ link: { ...start.link, live: false } })).toBe('send.held.expired')
  })

  it('every made-up page parses as the API answers it, and the design cases cover the states', () => {
    for (const entry of designScreen.cases) if (entry.model.page) expect(() => claimPageSchema.parse(entry.model.page), entry.id).not.toThrow()
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const state of ['start', 'items-return', 'item-complaint', 'details-return', 'photos-needed', 'photo-dialog', 'scan', 'review-return', 'sending', 'refused-quantity', 'held-used', 'draft-restored', 'finish-later', 'earlier-reports', 'done-return', 'done-photo-failed', 'loading', 'error', 'gone', 'wrong-person']) expect(ids).toContain(state)
    expect(item(JACKET.key).style?.name).toBeTruthy()
  })

  it('both catalogues have the same keys and placeholders, and every word the page names is there', () => {
    const it = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(en)) expect(holes(it[key]!), key).toEqual(holes(en[key]!))
    const named = [
      ...['type', 'items', 'nothingBack', 'manyItems', 'itemGone', 'quantityMin', 'quantityMax', 'long', 'reason', 'reasonNote', 'complaintItem', 'description', 'photos'].map((key) => `check.${key}`),
      'refusal.field',
      'refusal.quantity',
      ...['gone', 'wrongPerson', 'invalid', 'aboveSold', 'changed', 'rateLimited', 'unavailable', 'internal', 'read'].flatMap((key) => [`problem.${key}`, `problem.${key}Body`]),
      ...[...RETURN_CASE_STATES, ...COMPLAINT_CASE_STATES].map((state) => caseStateKey(state)!),
      'send.held.used',
      'send.held.expired',
      'photos.held.max',
    ]
    for (const key of named) expect(has(en, key), key).toBe(true)
  })
})
