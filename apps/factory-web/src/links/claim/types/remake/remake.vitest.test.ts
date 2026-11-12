import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bodyOf, formFromDraft, draftDataOf, EMPTY_FORM, issueProblem, photosNeeded, problemsOf, type ClaimForm } from '../../model'
import { designScreen } from './fixtures'
import { offeredTypes, pickRemakeItem, remakeBodyOf, remakePhotoKey, remakePhotoName, typeKey } from './model'

/** B-W2b-346 (SAL-298, RX2:01): the remake's path through the claim page. Made-up data (the fixtures'). */

const start = designScreen.cases.find((entry) => entry.id === 'type')!.model.page!
const [SUIT, JACKET, GLOVES] = start.items
const remake = (over: Partial<ClaimForm> = {}): ClaimForm => ({ ...EMPTY_FORM, type: 'REMAKE', ...over })

describe('a remake on the claim page', () => {
  it('is offered beside a return, and its words come from this step’s catalogue', () => {
    expect(offeredTypes(start)).toEqual(['RETURN', 'COMPLAINT', 'REMAKE'])
    expect(offeredTypes({ types: ['COMPLAINT'] })).toEqual(['COMPLAINT'])
    expect(typeKey('REMAKE', 'typeTitle')).toBe('returns-remake:claim.type.title')
    expect(typeKey('RETURN', 'send')).toBe('send.button.RETURN')
    expect(typeKey(null, 'doneTitle')).toBe('done.title.RETURN')
  })

  it('takes one item, one piece; asks the fit in words and the front and back photos', () => {
    expect(problemsOf(remake(), start, []).map((problem) => [problem.step, problem.field, problem.key])).toEqual([
      ['item', 'items', 'returns-remake:claim.check.item'],
      ['details', 'fit', 'returns-remake:claim.check.fit'],
    ])
    const picked = pickRemakeItem(pickRemakeItem(remake(), SUIT!), JACKET!)
    expect(picked.picks).toEqual([{ key: JACKET!.key, quantity: 1, reasonCode: null, reasonNote: '', serial: '' }])
    expect(pickRemakeItem(remake(), GLOVES!).picks).toEqual([])
    const form = remake({ picks: [{ key: SUIT!.key, quantity: 1, reasonCode: null, reasonNote: '', serial: 'SN-1' }], fit: 'The back is short.' })
    expect(photosNeeded(form, SUIT!.key)).toBe(2)
    expect(problemsOf(form, start, [{ group: SUIT!.key }]).map((problem) => [problem.field, problem.key, problem.params])).toEqual([[`photos.${SUIT!.key}`, 'returns-remake:claim.check.photos', { count: 1, needed: 2 }]])
    expect(problemsOf(form, start, [{ group: SUIT!.key }, { group: SUIT!.key }])).toEqual([])
    expect(bodyOf(form, start)).toEqual(remakeBodyOf(form, start))
    expect(remakeBodyOf(form, start)).toEqual({ type: 'REMAKE', typedName: null, lines: [{ invoiceLineId: null, salesOrderLineId: SUIT!.salesOrderLineId, size: '52', quantity: 1, serial: 'SN-1' }], fit: 'The back is short.', customerRef: null })
  })

  it('keeps its fit in the draft, maps the API’s refusal at the fit, and names the photos front and back', () => {
    const form = remake({ picks: [{ key: SUIT!.key, quantity: 1, reasonCode: null, reasonNote: '', serial: '' }], fit: 'Too tight.' })
    expect(formFromDraft(draftDataOf(form, 'details'), start)).toEqual({ form, step: 'details' })
    // A draft from before the remake came (no `fit`) still reads.
    const old = draftDataOf({ ...EMPTY_FORM, type: 'RETURN' }, 'type') as { form: Record<string, unknown> }
    delete old.form.fit
    expect(formFromDraft(old, start)?.form.fit).toBe('')
    expect(issueProblem({ path: 'body/fit', message: 'x' }, form)).toEqual({ step: 'details', field: 'fit', key: 'returns-remake:claim.check.fit' })
    expect([remakePhotoKey(0), remakePhotoKey(1), remakePhotoKey(2)]).toEqual(['returns-remake:claim.photos.front', 'returns-remake:claim.photos.back', null])
    expect(remakePhotoName('RMA-1', 1)).toBe('RMA-1-back.jpg')
  })

  it('every key the remake names is in both catalogues, with the same placeholders', () => {
    const read = (locale: string) => JSON.parse(readFileSync(new URL(`../../../../../messages/${locale}/returns-remake.json`, import.meta.url), 'utf8')) as Record<string, unknown>
    const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
      Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
    const en = flat(read('en'))
    const it = flat(read('it'))
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    const named = ['claim.type.title', 'claim.type.body', 'claim.type.none', 'claim.type.later', 'claim.item.legend', 'claim.send', 'claim.done.title', 'claim.done.next', 'claim.check.item', 'claim.check.fit', 'claim.check.photos_one', 'claim.check.photos_other', 'claim.photos.front', 'claim.photos.back']
    for (const key of named) expect(en[key], key).toBeTruthy()
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['type', 'item', 'details', 'photos-needed', 'review', 'refused-fit', 'done']))
  })
})
