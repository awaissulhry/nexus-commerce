/**
 * MX.G — the Matrix's eleven verbs: declared once, offered by the registry's own rules.
 */
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_VERB_LABELS, type MatrixVerbId, type VerbPreview } from '../matrix/contract'
import {
  MATRIX_NO_FAILURE_REASON,
  MATRIX_NO_INVENTORY_REASON,
  MATRIX_NO_PRICE_PERMISSION_REASON,
  MATRIX_NO_PRICE_REASON,
  MATRIX_NO_SOURCE_COORDINATE_REASON,
  MATRIX_PARENT_ONLY_REASON,
  matrixActions,
  matrixGridActions,
  matrixImpact,
  matrixImpactTitle,
  type MatrixActionsContext,
  type MatrixVerbHost,
} from './matrixActions'
import { actionsFor, requiresTypedConfirm, ROW, SELECTION, validateImpact } from './registry'

const ctx = (over: Partial<MatrixActionsContext> = {}): MatrixActionsContext => ({
  hasInventory: true, hasPrice: true, hasQueueFailure: false, parentOnly: false, canEditPrices: true, currency: 'EUR',
  coordinateOptions: [{ value: 'AMAZON:DE', label: 'Amazon · DE' }],
  ...over,
})
const ALL: MatrixVerbId[] = ['set-price', 'adjust-prices', 'copy-prices', 'pin-quantity', 'set-follow', 'set-buffer', 'pause-sync', 'resume-sync', 'push-now', 'retry-sync', 'set-fulfilment']

const preview = (over: Partial<VerbPreview> = {}): VerbPreview => ({
  verb: 'adjust-prices',
  changes: [
    { rowId: 'r1', sku: 'GALE-S', coordinateKey: 'AMAZON:IT', cell: 'price', from: 105, to: 99.75, fromLabel: '€105.00', toLabel: '€99.75', note: 'Set here (was: follows the base price)' },
    { rowId: 'r2', sku: 'GALE-M', coordinateKey: 'AMAZON:IT', cell: 'price', from: 105, to: 99.75, fromLabel: '€105.00', toLabel: '€99.75' },
  ],
  refusals: [
    { rowId: 'r3', sku: 'GALE-L', coordinateKey: 'AMAZON:IT', kind: 'amazon-managed', reason: 'Amazon-managed — the quantity is never written' },
    { rowId: 'r4', sku: 'GALE-XL', coordinateKey: 'AMAZON:IT', kind: 'formula', reason: 'A formula owns this cell — edit the formula' },
  ],
  notices: ['Amazon EU: this covers IT DE FR ES', 'Preview — nothing is sent'],
  confirm: 'confirm',
  confirmWord: null,
  simulated: true,
  ...over,
})

describe('matrixActions — eleven verbs, Appendix A labels, the three ROW verbs', () => {
  it('declares exactly the eleven verbs in MATRIX_VERB_LABELS order, each with its label verbatim', () => {
    const specs = matrixActions(ctx())
    expect(specs.map((s) => s.id)).toEqual(ALL)
    expect(specs.map((s) => s.id)).toEqual(Object.keys(MATRIX_VERB_LABELS))
    for (const s of specs) expect(s.label).toBe(MATRIX_VERB_LABELS[s.id])
    expect(specs.filter((s) => s.row).map((s) => s.id)).toEqual(['push-now', 'retry-sync', 'set-fulfilment'])
  })

  it('declares the parameter form each verb collects, and none for the bare ones', () => {
    const by = Object.fromEntries(matrixActions(ctx()).map((s) => [s.id, s.collect]))
    expect(by['set-price']).toEqual({ kind: 'number', label: 'Price', min: 0, step: 0.01, currency: 'EUR' })
    expect(by['adjust-prices']).toEqual({ kind: 'percent', label: 'Change by' })
    expect(by['copy-prices']).toEqual({ kind: 'coordinate', label: 'Copy from' })
    expect(by['pin-quantity']).toEqual({ kind: 'number', label: 'Quantity', min: 0, step: 1, integer: true })
    expect(by['set-buffer']).toEqual({ kind: 'number', label: 'Buffer', min: 0, step: 1, integer: true })
    expect(by['set-fulfilment']).toEqual({ kind: 'fulfilment', label: 'Method' })
    for (const id of ['set-follow', 'pause-sync', 'resume-sync', 'push-now', 'retry-sync'] as const) expect(by[id]).toBeNull()
  })

  it('a good selection offers every verb but Retry, which needs a failure', () => {
    const specs = matrixActions(ctx())
    for (const s of specs) expect(s.hidden).toBe(false)
    expect(specs.filter((s) => s.unavailable).map((s) => [s.id, s.unavailable])).toEqual([['retry-sync', MATRIX_NO_FAILURE_REASON]])
    expect(matrixActions(ctx({ hasQueueFailure: true })).find((s) => s.id === 'retry-sync')!.unavailable).toBeNull()
  })

  it('no inventory → the inventory verbs are disabled with the reason; the price verbs stay', () => {
    const specs = matrixActions(ctx({ hasInventory: false }))
    for (const id of ['pin-quantity', 'set-follow', 'set-buffer', 'pause-sync', 'resume-sync', 'push-now', 'set-fulfilment'] as const) {
      expect(specs.find((s) => s.id === id)!.unavailable).toBe(MATRIX_NO_INVENTORY_REASON)
    }
    for (const id of ['set-price', 'adjust-prices', 'copy-prices'] as const) expect(specs.find((s) => s.id === id)!.unavailable).toBeNull()
  })

  it('no price / no permission → the price verbs say which; no source coordinate → Copy prices says so', () => {
    expect(matrixActions(ctx({ hasPrice: false })).find((s) => s.id === 'set-price')!.unavailable).toBe(MATRIX_NO_PRICE_REASON)
    expect(matrixActions(ctx({ canEditPrices: false })).find((s) => s.id === 'adjust-prices')!.unavailable).toBe(MATRIX_NO_PRICE_PERMISSION_REASON)
    expect(matrixActions(ctx({ coordinateOptions: [] })).find((s) => s.id === 'copy-prices')!.unavailable).toBe(MATRIX_NO_SOURCE_COORDINATE_REASON)
    expect(matrixActions(ctx({ coordinateOptions: [] })).find((s) => s.id === 'set-price')!.unavailable).toBeNull()
  })

  it('a parent-only selection HIDES every verb and carries the reason', () => {
    const specs = matrixActions(ctx({ parentOnly: true }))
    for (const s of specs) { expect(s.hidden).toBe(true); expect(s.unavailable).toBe(MATRIX_PARENT_ONLY_REASON) }
  })
})

describe('matrixImpact — the preview becomes the registry’s impact, Appendix A sentence verbatim', () => {
  it('counts changes, refusals and skipped (Amazon-managed) from the preview’s own kinds', () => {
    expect(matrixImpactTitle(preview())).toBe('2 cells change · 1 refused · 1 skipped (Amazon-managed)')
    expect(matrixImpactTitle({ changes: [], refusals: [] })).toBe('0 cells change · 0 refused · 0 skipped (Amazon-managed)')
  })
  it('carries the level, the phrase, itemised consequences, findings by severity, the notices and the payload', () => {
    const i = matrixImpact(preview({ confirm: 'type-to-confirm', confirmWord: 'APPLY' }), 'Adjust prices by %…')
    expect(i.level).toBe('type-to-confirm')
    expect(i.title).toBe('Adjust prices by %… — 2 cells change · 1 refused · 1 skipped (Amazon-managed)')
    expect(i.consequences).toEqual(['GALE-S · AMAZON:IT: €105.00 → €99.75 — Set here (was: follows the base price)', 'GALE-M · AMAZON:IT: €105.00 → €99.75'])
    expect(i.findings).toEqual([
      { rowId: 'r3', label: 'GALE-L · AMAZON:IT: Amazon-managed — the quantity is never written', severity: 'info' },
      { rowId: 'r4', label: 'GALE-XL · AMAZON:IT: A formula owns this cell — edit the formula', severity: 'warn' },
    ])
    expect(i.sideEffects).toEqual(['Amazon EU: this covers IT DE FR ES', 'Preview — nothing is sent'])
    expect(i.confirmPhrase).toBe('APPLY')
    expect(i.payload).toBeDefined()
    expect(requiresTypedConfirm(i)).toBe(true)
    expect(validateImpact(i)).toEqual([])
  })
  it('a preview with nothing to change is level none and says so — never a confirm over nothing', () => {
    const i = matrixImpact(preview({ changes: [], confirm: 'confirm' }), 'Set to Follow')
    expect(i.level).toBe('none')
    expect(i.unavailable).toBe('Nothing in this selection would change')
    expect(validateImpact(i)).toEqual([])
  })
  it('a type-to-confirm without a word is refused by the registry’s own validator (negative control)', () => {
    const i = matrixImpact(preview({ confirm: 'type-to-confirm', confirmWord: null }), 'Set fulfilment…')
    expect(validateImpact(i).length).toBe(1)
  })
})

describe('matrixGridActions — the registry adapter runs COLLECT → PREFLIGHT → CONFIRM → RUN', () => {
  type Row = { id: string }
  const host = (): MatrixVerbHost<Row> & { collect: ReturnType<typeof vi.fn>; preview: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> } => ({
    collect: vi.fn(async () => ({ percent: -5 })),
    preview: vi.fn(async () => preview()),
    apply: vi.fn(async () => ({ ok: true })),
  })

  it('declares 11 SELECTION verbs and 3 ROW verbs, and the registry offers them by scope', () => {
    const actions = matrixGridActions<Row>(ctx(), host())
    expect(actions.length).toBe(14)
    expect(actionsFor(actions, SELECTION, [{ id: 'r1' }]).map((a) => a.action.id)).toEqual(ALL)
    expect(actionsFor(actions, ROW, [{ id: 'r1' }]).map((a) => a.action.id)).toEqual(['push-now:row', 'retry-sync:row', 'set-fulfilment:row'])
  })

  it('availability: a hidden verb is dropped by the registry, a disabled one is kept with its reason', () => {
    const hidden = matrixGridActions<Row>(ctx({ parentOnly: true }), host())
    expect(actionsFor(hidden, SELECTION, [{ id: 'p' }])).toEqual([])
    const noInv = actionsFor(matrixGridActions<Row>(ctx({ hasInventory: false }), host()), SELECTION, [{ id: 'r1' }])
    expect(noInv.find((a) => a.action.id === 'pin-quantity')!.availability).toEqual({ kind: 'disabled', reason: MATRIX_NO_INVENTORY_REASON })
    expect(noInv.find((a) => a.action.id === 'set-price')!.availability).toEqual({ kind: 'available' })
  })

  it('preflight collects, previews, and hands the impact the preview decided; run applies THAT preview', async () => {
    const h = host()
    const adjust = matrixGridActions<Row>(ctx(), h).find((a) => a.id === 'adjust-prices')!
    const impact = await adjust.preflight!([{ id: 'r1' }])
    expect(h.collect).toHaveBeenCalledTimes(1)
    expect(h.preview).toHaveBeenCalledWith(expect.objectContaining({ id: 'adjust-prices' }), [{ id: 'r1' }], { percent: -5 })
    expect(impact.level).toBe('confirm')
    const result = await adjust.run([{ id: 'r1' }], impact)
    expect(result).toEqual({ ok: true })
    expect(h.apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'adjust-prices' }), impact.payload, [{ id: 'r1' }])
  })

  it('a cancelled collect stops silently; a verb with nothing to collect skips the form; a run without a preview refuses', async () => {
    const h = host()
    h.collect.mockResolvedValueOnce(null)
    const setPrice = matrixGridActions<Row>(ctx(), h).find((a) => a.id === 'set-price')!
    expect((await setPrice.preflight!([{ id: 'r1' }])).cancelled).toBe(true)
    expect(h.preview).not.toHaveBeenCalled()
    const follow = matrixGridActions<Row>(ctx(), h).find((a) => a.id === 'set-follow')!
    await follow.preflight!([{ id: 'r1' }])
    expect(h.collect).toHaveBeenCalledTimes(1) // not called again for a verb with `collect: null`
    expect(h.preview).toHaveBeenCalledWith(expect.objectContaining({ id: 'set-follow' }), [{ id: 'r1' }], null)
    expect((await follow.run([{ id: 'r1' }], undefined)).ok).toBe(false)
    expect(h.apply).not.toHaveBeenCalled()
  })
})
