import { describe, expect, it } from 'vitest'
import { returnableRead } from '../design-data'
import { EMPTY_START, sendHeld, startDirty, startProblems, type StartDraft } from '../model'
import { designScreen } from './fixtures'
import { remakeBodyOf, remakeStartProblems } from './model'

/** B-W2b-346 (SAL-298, RX2:02): a remake from the portal's "Start a return or claim". Made-up data. */

const read = returnableRead()
const draft = (over: Partial<StartDraft> = {}): StartDraft => ({ ...EMPTY_START, step: 'details', type: 'REMAKE', ...over })
const who = { preview: false, mayRequest: true, offline: false, busy: false } as Parameters<typeof sendHeld>[2]

describe('a remake asked from the portal', () => {
  it('needs one item that may come back and the fit in words', () => {
    expect(remakeStartProblems(draft(), read)).toEqual({ remakeItem: 'portal.problem.item', fit: 'portal.problem.fit' })
    expect(remakeStartProblems(draft({ remakeKey: 'line-1|54', fit: 'Too long.' }), read)).toEqual({ remakeItem: 'portal.problem.itemGone' })
    expect(remakeStartProblems(draft(), { items: [] })).toMatchObject({ remakeItem: 'portal.problem.nothing' })
    expect(startProblems(draft({ remakeKey: 'line-1|52', fit: 'The sleeves are 3 cm long.' }), read)).toEqual({})
    expect(sendHeld(draft({ remakeKey: 'line-1|52', fit: '' }), read, who)).toBe('start.held.problems')
  })

  it('sends one piece of the item with the fit, and counts as typed work', () => {
    const typed = draft({ remakeKey: 'line-1|52', fit: '  The sleeves are 3 cm long. ', serial: ' SN-1 ', customerRef: '' })
    const item = read.items[0]!
    expect(remakeBodyOf(typed, read)).toEqual({ lines: [{ invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: '52', quantity: 1, serial: 'SN-1' }], fit: 'The sleeves are 3 cm long.', customerRef: null })
    expect(startDirty(typed)).toBe(true)
    expect(startDirty(draft())).toBe(false)
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['type', 'details', 'details-problems', 'review', 'sent']))
  })
})
