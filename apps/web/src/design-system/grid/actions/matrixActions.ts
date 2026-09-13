/**
 * MX.G — the Matrix's eleven verbs, declared ONCE (`MATRIX_VERB_LABELS`, design §3.8).
 *
 * Two layers, both pure:
 *
 * 1. `matrixActions(ctx)` → `MatrixVerbSpec[]` — what each verb NEEDS (`collect`, the parameter
 *    form the page renders), whether it is also a ROW verb, and whether the current selection may
 *    run it (`unavailable` with the reason, or `hidden`). This is the shape MX.P codes against.
 * 2. `matrixGridActions(ctx, host)` → `GridAction<T>[]` — the registry adapter (ruling #113: the type
 *    and its adapters are the DS's, the definitions are the lane's). It runs COLLECT → PREFLIGHT →
 *    CONFIRM → RUN in the registry's own order (`PARAMETERISED_VERB_ORDER`), with the confirm level
 *    coming from the PREVIEW (`VerbPreview.confirm`), never fixed here — `previewVerb` decides that
 *    −30 % on ≥ 100 cells is type-to-confirm, and `Set fulfilment…` always is.
 *
 * ## Availability is a SENTENCE, never a bare boolean
 *
 * A parent-only selection HIDES every verb (a parent has no listing of its own — there is nothing
 * to apply to, and a disabled verb would suggest there might be); a selection with no inventory
 * DISABLES the inventory verbs with the reason; a viewer without `products.edit` sees the price
 * verbs disabled with the permission named. `disabled(reason)` is what the DS renders as
 * `aria-disabled` + the sentence, never a silent `disabled` (`scripts/check-silent-disabled.mjs`).
 */
import { MATRIX_VERB_LABELS, type FulfilmentMethod, type MatrixVerbId, type VerbPreview } from '../matrix/contract'
import { AVAILABLE, HIDDEN, ROW, SELECTION, disabled, type ActionImpact, type ActionResult, type GridAction } from './registry'

/** What a verb needs to collect from the operator before it can be previewed. The page renders it. */
export type MatrixVerbField =
  | { kind: 'number'; label: string; min?: number; step?: number; currency?: string; integer?: boolean }
  | { kind: 'percent'; label: string }
  | { kind: 'coordinate'; label: string }
  | { kind: 'fulfilment'; label: string }

export interface MatrixVerbSpec {
  id: MatrixVerbId
  label: string
  /** ROW verbs also appear on the row ⋯; every verb is a SELECTION verb. */
  row: boolean
  danger?: boolean
  collect: MatrixVerbField | null
  /** Why this verb is not offered for the current selection, or `null` when it is. */
  unavailable?: string | null
  /** The verb does not apply to this selection at all (a parent-only selection). */
  hidden?: boolean
}

export interface MatrixActionsContext {
  /** The rows ticked carry inventory cells on the focused coordinates. */
  hasInventory: boolean
  hasPrice: boolean
  hasQueueFailure: boolean
  /** A parent-only selection offers nothing: a parent has no listing of its own. */
  parentOnly: boolean
  canEditPrices: boolean
  currency: string
  coordinateOptions: ReadonlyArray<{ value: string; label: string }>
}

export const MATRIX_PARENT_ONLY_REASON = 'The parent row has no listing of its own — tick its variants'
export const MATRIX_NO_INVENTORY_REASON = 'Nothing in this selection carries inventory'
export const MATRIX_NO_PRICE_REASON = 'Nothing in this selection carries a price'
export const MATRIX_NO_PRICE_PERMISSION_REASON = 'You do not have permission to change prices (products.edit)'
export const MATRIX_NO_FAILURE_REASON = 'Nothing in this selection has failed'
export const MATRIX_NO_SOURCE_COORDINATE_REASON = 'No other coordinate to copy from'

/** The eleven verbs, declared ONCE. The page renders `collect`; this declares it. */
export function matrixActions(ctx: MatrixActionsContext): MatrixVerbSpec[] {
  const hidden = ctx.parentOnly
  const parent = hidden ? MATRIX_PARENT_ONLY_REASON : null
  const noInventory = parent ?? (ctx.hasInventory ? null : MATRIX_NO_INVENTORY_REASON)
  const noPrice = parent ?? (!ctx.canEditPrices ? MATRIX_NO_PRICE_PERMISSION_REASON : ctx.hasPrice ? null : MATRIX_NO_PRICE_REASON)
  const noFailure = parent ?? (ctx.hasQueueFailure ? null : MATRIX_NO_FAILURE_REASON)
  const noSource = ctx.coordinateOptions.length ? null : MATRIX_NO_SOURCE_COORDINATE_REASON
  const label = (id: MatrixVerbId) => MATRIX_VERB_LABELS[id]
  return [
    { id: 'set-price', label: label('set-price'), row: false, collect: { kind: 'number', label: 'Price', min: 0, step: 0.01, currency: ctx.currency }, unavailable: noPrice, hidden },
    { id: 'adjust-prices', label: label('adjust-prices'), row: false, collect: { kind: 'percent', label: 'Change by' }, unavailable: noPrice, hidden },
    { id: 'copy-prices', label: label('copy-prices'), row: false, collect: { kind: 'coordinate', label: 'Copy from' }, unavailable: noPrice ?? noSource, hidden },
    { id: 'pin-quantity', label: label('pin-quantity'), row: false, collect: { kind: 'number', label: 'Quantity', min: 0, step: 1, integer: true }, unavailable: noInventory, hidden },
    { id: 'set-follow', label: label('set-follow'), row: false, collect: null, unavailable: noInventory, hidden },
    { id: 'set-buffer', label: label('set-buffer'), row: false, collect: { kind: 'number', label: 'Buffer', min: 0, step: 1, integer: true }, unavailable: noInventory, hidden },
    { id: 'pause-sync', label: label('pause-sync'), row: false, collect: null, unavailable: noInventory, hidden },
    { id: 'resume-sync', label: label('resume-sync'), row: false, collect: null, unavailable: noInventory, hidden },
    { id: 'push-now', label: label('push-now'), row: true, collect: null, unavailable: noInventory, hidden },
    { id: 'retry-sync', label: label('retry-sync'), row: true, collect: null, unavailable: noFailure, hidden },
    { id: 'set-fulfilment', label: label('set-fulfilment'), row: true, collect: { kind: 'fulfilment', label: 'Method' }, unavailable: noInventory, hidden },
  ]
}

/* ── the registry adapter ───────────────────────────────────────────────────────────────── */

/** The parameters a `collect` form yields, keyed the way `MatrixVerbParams` spells them. */
export type MatrixVerbCollected =
  | { value: number }
  | { percent: number }
  | { fromCoordinateKey: string }
  | { method: FulfilmentMethod }

export interface MatrixVerbHost<T> {
  /** COLLECT — the page's parameter form. Resolves `null` when the operator cancelled. */
  collect: (spec: MatrixVerbSpec, rows: T[]) => Promise<MatrixVerbCollected | null>
  /** PREFLIGHT — `previewVerb` in preview mode, `POST …/verbs commit:false` in live mode. */
  preview: (spec: MatrixVerbSpec, rows: T[], collected: MatrixVerbCollected | null) => Promise<VerbPreview>
  /** RUN — `applyVerb` in preview mode, `POST …/verbs commit:true` in live mode. The revert toast is the host's. */
  apply: (spec: MatrixVerbSpec, preview: VerbPreview, rows: T[]) => Promise<ActionResult>
}

/**
 * Appendix A, verbatim: `<n> cells change · <m> refused · <k> skipped (Amazon-managed)`.
 *
 * `skipped` is the refusals the operator did not cause and cannot fix here (an FBA row's quantity is
 * Amazon's); `refused` is every other refusal. Both are counted from the preview's own `kind`, so the
 * sentence and the list beneath it cannot disagree.
 */
export function matrixImpactTitle(preview: Pick<VerbPreview, 'changes' | 'refusals'>): string {
  const skipped = preview.refusals.filter((r) => r.kind === 'amazon-managed').length
  const refused = preview.refusals.length - skipped
  return `${preview.changes.length} cells change · ${refused} refused · ${skipped} skipped (Amazon-managed)`
}

/**
 * `VerbPreview` → `ActionImpact`. The level and the phrase are the preview's; the consequences are
 * itemised (never summarised into a count — the registry's own rule); the refusals are findings
 * the dialog can group; the notices (`Amazon EU: this covers …`, `Preview — nothing is sent`) are
 * side effects; the whole preview travels as `payload` so `run` applies the snapshot the operator
 * approved (ruling #118).
 */
export function matrixImpact(preview: VerbPreview, label: string): ActionImpact {
  const nothing = preview.changes.length === 0
  return {
    level: nothing ? 'none' : preview.confirm,
    title: `${label} — ${matrixImpactTitle(preview)}`,
    consequences: preview.changes.map((c) => `${c.sku} · ${c.coordinateKey}: ${c.fromLabel} → ${c.toLabel}${c.note ? ` — ${c.note}` : ''}`),
    sideEffects: preview.notices,
    findings: preview.refusals.map((r) => ({
      rowId: r.rowId,
      label: `${r.sku} · ${r.coordinateKey}: ${r.reason}`,
      severity: r.kind === 'amazon-managed' ? 'info' : 'warn',
    })),
    confirmPhrase: preview.confirmWord ?? undefined,
    unavailable: nothing ? 'Nothing in this selection would change' : undefined,
    payload: preview,
  }
}

/** The registry sees ONE `GridAction` per (verb × scope): SELECTION for all eleven, ROW for the three. */
export function matrixGridActions<T>(ctx: MatrixActionsContext, host: MatrixVerbHost<T>): GridAction<T>[] {
  const out: GridAction<T>[] = []
  for (const spec of matrixActions(ctx)) {
    const available = () => (spec.hidden ? HIDDEN : spec.unavailable ? disabled(spec.unavailable) : AVAILABLE)
    const preflight = async (rows: T[]): Promise<ActionImpact> => {
      const collected = spec.collect ? await host.collect(spec, rows) : null
      if (spec.collect && collected === null) return { level: 'none', title: spec.label, cancelled: true }
      return matrixImpact(await host.preview(spec, rows, collected), spec.label)
    }
    const run = async (rows: T[], impact?: ActionImpact): Promise<ActionResult> => {
      const preview = impact?.payload as VerbPreview | undefined
      if (!preview) return { ok: false, message: 'No preview to apply — the verb was not preflighted' }
      return host.apply(spec, preview, rows)
    }
    out.push({ id: spec.id, label: spec.label, scope: SELECTION, danger: spec.danger, available, preflight, run })
    if (spec.row) out.push({ id: `${spec.id}:row`, label: spec.label, scope: ROW, danger: spec.danger, available, preflight, run })
  }
  return out
}
