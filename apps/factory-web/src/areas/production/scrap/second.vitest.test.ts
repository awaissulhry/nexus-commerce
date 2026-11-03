import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { DOWNGRADES, OPTIONS, OPTIONS_PIECE, ROWS, ROWS_WITH_SECOND, SECOND_TOTALS, canAs } from './demo/fixtures'
import { addressOf, addressText, downgradeBody, downgradedOf, downgradeHeld, downgradeOpenHeld, downgradeRow, emptyDowngradeDraft, filterRows, pareto, tileValue, withDowngrades, writeProblem, type DowngradeDraft } from './model'

const manager = canAs('manager')
const inspector = canAs('inspector')
const TODAY = Date.parse('2026-10-29T23:00:00.000Z')
const filled: DowngradeDraft = { quantity: '1', reasonCode: 'STAIN', note: '', target: 'SKU', itemId: '', toLocationId: OPTIONS.places[1]!.id, ppeConfirmed: true }

describe('second quality rows (MES-133)', () => {
  it('reads a downgrade as a SECOND row with its reason in the person’s words, newest first among the rest', () => {
    const second = downgradeRow(DOWNGRADES[0]!)
    expect(second).toMatchObject({ id: `second:${DOWNGRADES[0]!.id}`, kind: 'SECOND', pieces: 1, reasonLabel: { it: 'Difetto della pelle', en: 'Leather flaw' }, operation: null, materials: [] })
    const rows = withDowngrades(ROWS, DOWNGRADES)
    expect(rows).toHaveLength(ROWS.length + 2)
    expect(rows.map((row) => Date.parse(row.at))).toEqual([...rows.map((row) => Date.parse(row.at))].sort((a, b) => b - a))
    expect(withDowngrades(ROWS, null)).toEqual(ROWS)
  })

  it('has a tile that is a saved filter, counting the period without withdrawn rows; the pareto never counts them twice', () => {
    expect(tileValue('downgraded', null, SECOND_TOTALS)).toBe('1')
    expect(tileValue('downgraded', null, null)).toBe('—')
    const address = addressOf(new URLSearchParams('view=second'))
    expect(filterRows(ROWS_WITH_SECOND, address, TODAY, 'en').every((row) => row.kind === 'SECOND')).toBe(true)
    expect(addressOf(new URLSearchParams('kind=SECOND')).kind).toBe('SECOND')
    const total = (rows: typeof ROWS) => pareto(rows, 'reason', 'en').reduce((sum, bar) => sum + bar.pieces, 0)
    expect(total(ROWS_WITH_SECOND)).toBe(total(ROWS))
  })

  it('opens Downgrade from the address and back', () => {
    const row = ROWS[0]!.id
    const address = addressOf(new URLSearchParams(`downgrade=${row}`))
    expect(address.downgrade).toBe(row)
    expect(addressText(address)).toBe(`?downgrade=${encodeURIComponent(row)}`)
  })
})

describe('why Second quality… is held, and what Downgrade sends', () => {
  it('holds a rework row, no right, a cut piece, and a row sent already', () => {
    expect(downgradeOpenHeld(ROWS[0]!, ROWS_WITH_SECOND, manager)).toBeNull()
    expect(downgradeOpenHeld(ROWS[5]!, ROWS_WITH_SECOND, manager)?.key).toBe('second.held.notScrap')
    expect(downgradeOpenHeld(ROWS[0]!, ROWS_WITH_SECOND, inspector)).toMatchObject({ key: 'held.permission', params: { permission: 'production.downgrade' } })
    expect(downgradeOpenHeld(ROWS[1]!, ROWS_WITH_SECOND, manager)).toMatchObject({ key: 'second.held.part', params: { part: 'sleeve' } })
    // Row 4's hole went to second quality already (its one garment).
    expect(downgradedOf(ROWS[3]!, ROWS_WITH_SECOND)).toBe(1)
    expect(downgradeOpenHeld(ROWS[3]!, ROWS_WITH_SECOND, manager)?.key).toBe('second.held.covered')
    // The withdrawn downgrade of row 7 frees its garment again.
    expect(downgradedOf(ROWS[6]!, ROWS_WITH_SECOND)).toBe(0)
  })

  it('checks the dialog as the API does, one reason at a time, in words', () => {
    expect(downgradeHeld(OPTIONS, filled, manager, false)).toBeNull()
    expect(downgradeHeld(null, filled, manager, false)?.key).toBe('held.loading')
    expect(downgradeHeld(OPTIONS_PIECE, filled, manager, false)?.key).toBe('second.refusal.NOT_A_GARMENT')
    expect(downgradeHeld(OPTIONS, { ...filled, quantity: '3' }, manager, false)).toMatchObject({ key: 'second.held.quantity', params: { max: 2 } })
    expect(downgradeHeld(OPTIONS, { ...filled, reasonCode: '' }, manager, false)?.key).toBe('second.held.reason')
    expect(downgradeHeld(OPTIONS, { ...filled, reasonCode: 'OTHER' }, manager, false)?.key).toBe('second.refusal.REASON_WORDS')
    expect(downgradeHeld(OPTIONS, { ...filled, toLocationId: OPTIONS.places[0]!.id }, manager, false)?.key).toBe('second.refusal.SKU_IN_FINISHED_GOODS')
    expect(downgradeHeld(OPTIONS, { ...filled, target: 'ITEM', toLocationId: OPTIONS.places[0]!.id, itemId: OPTIONS.items[0]!.id }, manager, false)).toBeNull()
    expect(downgradeHeld(OPTIONS, { ...filled, target: 'ITEM' }, manager, false)?.key).toBe('second.held.item')
    expect(downgradeHeld(OPTIONS, { ...filled, ppeConfirmed: false }, manager, false)?.key).toBe('second.refusal.PPE_CONFIRM')
    expect(downgradeHeld(OPTIONS, filled, inspector, false)?.key).toBe('held.permission')
    expect(downgradeHeld(OPTIONS, filled, manager, true)?.key).toBe('held.busy')
  })

  it('starts the draft with every garment left and the one place outside finished goods', () => {
    expect(emptyDowngradeDraft(OPTIONS)).toMatchObject({ quantity: '2', target: 'SKU', toLocationId: OPTIONS.places[1]!.id, reasonCode: '', ppeConfirmed: false })
    expect(emptyDowngradeDraft({ ...OPTIONS, sku: null }).target).toBe('ITEM')
  })

  it('sends the source, the garments, the reason, what they are kept as and where', () => {
    expect(downgradeBody(ROWS[0]!, { ...filled, note: '  A mark  ' }, OPTIONS)).toEqual({ sourceScanId: ROWS[0]!.source.id, quantity: 1, reasonCode: 'STAIN', note: 'A mark', target: 'SKU', toLocationId: OPTIONS.places[1]!.id, ppeConfirmed: true })
    expect(downgradeBody(ROWS[6]!, { ...filled, target: 'ITEM', itemId: 'i1' }, { ...OPTIONS, ppe: false })).toEqual({ reworkOrderId: ROWS[6]!.source.id, quantity: 1, reasonCode: 'STAIN', target: 'ITEM', itemId: 'i1', toLocationId: OPTIONS.places[1]!.id })
  })

  it('says a refusal of the API in this page’s words', () => {
    const refused = (code: string) => new ApiError('conflict', 409, 'refused', 'English', null, [{ path: `refusal/${code}`, message: 'English' }])
    for (const code of ['PPE_CONFIRM', 'SKU_IN_FINISHED_GOODS', 'NOT_A_GARMENT', 'SCRAP_WAITS_APPROVAL', 'ALREADY_WITHDRAWN', 'GARMENTS_MOVED']) expect(writeProblem(refused(code))).toEqual({ key: `second.refusal.${code}` })
    expect(writeProblem(refused('MORE_THAN_SCRAPPED'))).toEqual({ key: 'problem.moreThanScrapped' })
  })
})
