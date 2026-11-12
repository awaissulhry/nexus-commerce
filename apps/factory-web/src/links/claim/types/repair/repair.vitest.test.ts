import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { claimPageSchema, type ClaimItem } from '../../api'
import { designScreen } from '../../fixtures'
import { draftDataOf, EMPTY_FORM, formFromDraft, issueProblem, photoGroups, photosNeeded, problemsOf, sendRefusal, type ClaimForm } from '../../model'
import { ApiError } from '../../../../lib/api/errors'
import { EMPTY_REPAIR, OTHER_GARMENT, repairBodyOf, repairItems, repairNextKey, repairProblems, repairStageKey, type RepairForm } from './model'

/**
 * SCR-197 › Repair or alteration (B-W2b-342; RR1:01): the repair's part of the claim form — its checks step by step, the
 * body the API takes, the two damage photos, the draft kept with us, the refusals in our words, its design cases and its
 * words in both catalogues.
 */

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../../../messages/${locale}/returns-repair.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
const has = (keys: Record<string, string>, key: string) => key in keys || (`${key}_one` in keys && `${key}_other` in keys)

const typeCase = designScreen.cases.find((entry) => entry.id === 'w2b-342-type')!
const page = typeCase.model.page!
const JACKET = repairItems(page)[0] as ClaimItem
const form = (repair: Partial<RepairForm>, over: Partial<ClaimForm> = {}): ClaimForm => ({ ...EMPTY_FORM, type: 'REPAIR', repair: { ...EMPTY_REPAIR, ...repair }, ...over })

describe('the repair on the claim link (RR1:01)', () => {
  it('checks the garment, a repair’s words and an alteration’s work, step by step', () => {
    expect(repairProblems(EMPTY_REPAIR, page).map((problem) => [problem.step, problem.field])).toEqual([['item', 'repair.item'], ['details', 'repair.problem']])
    expect(repairProblems({ ...EMPTY_REPAIR, itemKey: OTHER_GARMENT }, page).map((problem) => problem.field)).toEqual(['repair.serial', 'repair.problem'])
    expect(repairProblems({ ...EMPTY_REPAIR, kind: 'ALTERATION', itemKey: JACKET.key }, page).map((problem) => [problem.field, problem.key])).toEqual([['repair.workWanted', 'returns-repair:check.workWanted']])
    expect(repairProblems({ ...EMPTY_REPAIR, itemKey: JACKET.key, problem: 'Torn seam', serial: 'x'.repeat(61) }, page)).toEqual([{ step: 'item', field: 'repair.serial', key: 'returns-repair:check.long', params: { max: 60 } }])
    expect(repairProblems({ ...EMPTY_REPAIR, itemKey: 'gone', problem: 'Torn seam' }, page).map((problem) => problem.field)).toEqual(['repair.item'])
  })

  it('asks two damage photos for a repair, none for an alteration, and joins the claim form’s own checks', () => {
    const repair = form({ itemKey: JACKET.key, problem: 'The seam opened.' })
    expect(photoGroups(repair)).toEqual(['case'])
    expect(photosNeeded(repair, 'case')).toBe(2)
    expect(photosNeeded(form({ kind: 'ALTERATION' }), 'case')).toBe(0)
    expect(problemsOf(repair, page, []).map((problem) => [problem.step, problem.field])).toEqual([['photos', 'photos.case']])
    expect(problemsOf(repair, page, [{ group: 'case' }, { group: 'case' }])).toEqual([])
    expect(problemsOf(form({}, { type: 'REPAIR' }), { ...page, types: ['RETURN', 'COMPLAINT'] }, [])[0]).toMatchObject({ step: 'type', key: 'check.type' })
  })

  it('sends the API’s body: the item’s order line and size, or another garment by its serial', () => {
    expect(repairBodyOf({ kind: 'REPAIR', itemKey: JACKET.key, serial: ' 0000-DEMO-48 ', problem: ' The seam opened. ', workWanted: '' }, page, ' Anna ')).toEqual({ kind: 'REPAIR', salesOrderLineId: JACKET.salesOrderLineId, size: JACKET.size, serial: '0000-DEMO-48', problem: 'The seam opened.', workWanted: null, typedName: 'Anna' })
    expect(repairBodyOf({ kind: 'ALTERATION', itemKey: OTHER_GARMENT, serial: 'SN-9', problem: '', workWanted: 'Add 2 cm' }, page, '')).toMatchObject({ salesOrderLineId: null, size: null, serial: 'SN-9', workWanted: 'Add 2 cm', typedName: null })
  })

  it('keeps the repair in the draft and makes it fit the page when read back', () => {
    const repair = form({ kind: 'ALTERATION', itemKey: JACKET.key, workWanted: 'Add 2 cm' })
    expect(formFromDraft(draftDataOf(repair, 'details'), page)?.form.repair).toEqual(repair.repair)
    const gone = draftDataOf(form({ itemKey: 'gone-item', problem: 'x' }), 'item')
    expect(formFromDraft(gone, page)?.form.repair.itemKey).toBeNull()
    // A draft of before B-W2b-342 (no repair part) still reads.
    const old = draftDataOf({ ...EMPTY_FORM, type: 'RETURN', note: 'old' }, 'details') as { form: Record<string, unknown> }
    delete old.form.repair
    expect(formFromDraft(old, page)?.form.repair).toEqual(EMPTY_REPAIR)
  })

  it('puts the API’s refusals at the repair’s fields, and an open repair of the garment in its own words', () => {
    const repair = form({ itemKey: JACKET.key, problem: 'x' })
    expect(issueProblem({ path: 'body/workWanted', message: 'x' }, repair)).toMatchObject({ step: 'details', field: 'repair.workWanted' })
    expect(issueProblem({ path: 'body/serial', message: 'x' }, repair)).toMatchObject({ step: 'item', field: 'repair.serial', key: 'returns-repair:refusal.serial' })
    const open = sendRefusal(new ApiError('conflict', 409, 'conflict', 'Repair REP-1 is open', null, [{ path: 'body/serial', message: 'x' }]), repair)
    expect(open).toMatchObject({ key: 'returns-repair:refusal.open', reload: false, keepKey: false })
  })

  it('has design cases for every step and the end, pages the API would answer, and both catalogues with the same keys', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const state of ['w2b-342-type', 'w2b-342-item', 'w2b-342-item-other', 'w2b-342-details', 'w2b-342-details-alteration', 'w2b-342-photos', 'w2b-342-review', 'w2b-342-refused', 'w2b-342-done', 'w2b-342-earlier']) expect(ids).toContain(state)
    for (const entry of designScreen.cases) if (entry.model.page) expect(() => claimPageSchema.parse(entry.model.page), entry.id).not.toThrow()
    const it = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(en)) expect(holes(it[key]!), key).toEqual(holes(en[key]!))
    const named = [
      ...['item', 'serial', 'long', 'problem', 'workWanted'].map((key) => `check.${key}`),
      'refusal.serial',
      'refusal.open',
      'refusal.openBody',
      'link.repairs.title',
      ...['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED', 'SHIPPED', 'CANCELLED'].map(repairStageKey),
      ...['SEND_GARMENT', 'WE_ESTIMATE', 'ANSWER_ESTIMATE', 'WE_DECIDE', 'WE_REPAIR', 'WE_CHECK', 'ON_ITS_WAY', 'DONE', 'CANCELLED'].map(repairNextKey),
    ]
    for (const key of named) expect(has(en, key), key).toBe(true)
  })
})
