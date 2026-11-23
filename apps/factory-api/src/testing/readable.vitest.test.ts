import { describe, expect, it } from 'vitest'
import { readableText } from './readable'

/**
 * cw-fx9 — `readableText`: the text a wall test searches for a figure. The first case is the end check's own flake: the alert row
 * of B-CP-021 held no amount, and its "no amount" check failed on the Owner's generated user id. Every id here is made up.
 */
describe('readableText: what a person reads of rows — generated ids and times left out, everything else kept', () => {
  // The notification row of the failed run, as the test read it: no amount anywhere; "399" stands in the user id by chance.
  const row = {
    userId: '01a2075d-7197-77c2-82a6-88e2939977b7',
    category: 'ALERT',
    messageKey: 'notifications.priceCheck.customerChanged',
    params: { orderId: '01a2075d-89bd-752c-907e-1828944cf46e' },
    recordType: 'SalesOrder',
    recordId: '01a2075d-89bd-752c-907e-1828944cf46e',
    recordLabel: 'SO-2026-0003',
  }

  it('a figure that stands in a generated id by chance is no figure a person reads', () => {
    expect(JSON.stringify([row])).toMatch(/399|420/) // the flake: "…88e2939977b7"
    expect(readableText([row])).not.toMatch(/399|420/)
    expect(readableText([row])).toBe('[{"userId":"<id>","category":"ALERT","messageKey":"notifications.priceCheck.customerChanged","params":{"orderId":"<id>"},"recordType":"SalesOrder","recordId":"<id>","recordLabel":"SO-2026-0003"}]')
  })

  it('the wall keeps its strength: an amount in a word, a label, a parameter or a number still shows', () => {
    expect(readableText([{ ...row, recordLabel: 'SO-2026-0003 · 399,00' }])).toMatch(/399|420/)
    expect(readableText([{ ...row, params: { orderId: row.params.orderId, figure: '420' } }])).toMatch(/399|420/)
    expect(readableText([{ ...row, params: { orderId: row.params.orderId, unitPrice: 399 } }])).toMatch(/399|420/)
    expect(readableText([{ ...row, messageKey: 'notifications.priceCheck.customerChanged.420' }])).toMatch(/399|420/)
    // Also beside an id in one string, and as a key.
    expect(readableText({ groupKey: `price:${row.recordId}:399` })).toBe('{"groupKey":"price:<id>:399"}')
    expect(readableText({ [row.recordId]: { 420: true } })).toBe('{"<id>":{"420":true}}')
  })

  it('a time is left out (its seconds and milliseconds are digits of their own); a plain day stays', () => {
    const at = new Date('2026-11-23T07:45:00.399Z')
    expect(JSON.stringify({ at })).toMatch(/399/)
    expect(readableText({ at, since: '2026-11-23T18:50:04.200+01:00', due: '2026-12-04' })).toBe('{"at":"<time>","since":"<time>","due":"2026-12-04"}')
    expect(readableText({ note: 'Due 2026-12-04, 18.50 a piece' })).toMatch(/18\.50/)
  })

  it('nothing to read: an empty text, never a throw', () => {
    expect(readableText(undefined)).toBe('')
    expect(readableText(null)).toBe('null')
    expect(readableText([])).toBe('[]')
  })
})
