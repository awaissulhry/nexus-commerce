/**
 * PES.5 / #364 — the moments a record can actually be restored TO.
 *
 * PES.4's `Restore record` offered a free timestamp, which lets an operator pick
 * a moment where nothing changed and get a no-op they cannot tell from a
 * success. This returns the instants that genuinely hold changes.
 *
 * ── What the audit trail actually contains (measured 2026-09-02, 398 Product
 * rows across 83 products), because it decides the shape of this contract ──
 *
 *   update 100 · imagePublishBulk 70 · imagePublishCompleted 46
 *   imagePublishStarted 38 · imagePublishFailed 37 · soft-delete 30
 *   create 24 · hard-delete 24 · ai-draft.approve (…)
 *
 * **320 of 398 rows carry no field at all.** The image-publish lifecycle (191
 * rows) and create/delete rows record that something happened, not which values
 * changed — there is nothing to restore to. Listing them as restore points would
 * offer the operator a moment that cannot restore anything, which is the exact
 * failure this endpoint exists to remove, so they are EXCLUDED and counted in
 * `coverage` rather than silently dropped.
 *
 * Two payload shapes are both real and both handled:
 *   • descriptor — `{ field, value }`, one field per row (the bulk PATCH path)
 *   • map — `{ "de.description": "…" }`, several keys (the ai-draft path)
 * Reading only the first is what makes `getCellHistory` skip 320 rows.
 */

import { RESTORABLE_MASTER_FIELDS } from './restorable-fields.js'
import { asDescriptor } from './audit-state.js'

/**
 * Actions restored through the FORMULA path rather than by writing a master
 * field. `formula.pinned` records the expression that a pinned literal replaced.
 */
const FORMULA_ACTIONS = new Set(['formula.pinned'])

/** Actions that record an event, not a value change — nothing to restore to. */
const NON_VALUE_ACTIONS = new Set([
  'imagePublishBulk', 'imagePublishCompleted', 'imagePublishStarted', 'imagePublishFailed',
  'create', 'soft-delete', 'hard-delete', 'restore',
])

export interface RestorePoint {
  /** ISO instant — what `POST /products/:id/restore` takes as `at`. */
  at: string
  action: string
  actor: string | null
  /** Every field recorded as changed at this instant. */
  fields: string[]
  /**
   * The subset `POST /restore` will actually write. Carried because the restore
   * path accepts master scalar columns only: a moment that changed
   * `attr_material` or `de.description` is real history and still cannot be
   * restored, and the drawer must not imply otherwise.
   */
  restorableFields: string[]
  /** False when nothing at this instant can be written back. */
  restorable: boolean
  /**
   * WHICH restore this point needs — PES.4's (H). A formula pin
   * (`formula.pinned`) is restored through the formula path, not by writing a
   * master field, and the two are not interchangeable.
   *
   * Set here so the drawer never infers the verb from the action name: a client
   * parsing `action` would be reimplementing this decision, and would silently
   * pick 'master' for any future formula action nobody told it about.
   */
  restoreVia: 'master' | 'formula'
  /**
   * Present only on a `restoreVia: 'formula'` point (#488). Carries the ONE
   * audit row the restore acts on, so PES.4 routes on `restoreVia` and passes
   * `formula.auditLogId` without having to re-derive which row a merged instant
   * meant. `expr` is here so the confirm can name the formula it is bringing
   * back rather than an opaque id.
   */
  formula?: { auditLogId: string; fieldKey: string; expr: string | null }
  /** `master` | `channel` when the row recorded one. */
  layer: string | null
}

export interface RestorePointsResult {
  productId: string
  points: RestorePoint[]
  coverage: {
    auditRowsScanned: number
    /** Rows excluded because they record an event, not values. */
    eventRowsExcluded: number
    /** Rows carrying neither a descriptor nor a map — nothing readable. */
    unreadableRowsExcluded: number
    note: string
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * The fields one audit payload says changed. Pure — exported for tests.
 * Returns `[]` when the row carries nothing readable, which the caller must
 * distinguish from "changed nothing".
 */
export function fieldsChangedIn(after: unknown, before: unknown): string[] {
  // Descriptor first, via the SAME `asDescriptor` the history reader uses — it
  // already encodes "exactly { field, value }", and a second copy of that test
  // here would be one more thing to drift. Order matters: a descriptor read as
  // a map reports the literal keys "field" and "value".
  const desc = asDescriptor(after) ?? asDescriptor(before)
  if (desc) return [desc.field]
  const a = asRecord(after)
  if (a) return Object.keys(a).filter((k) => k !== 'field' && k !== 'value')
  return []
}

export async function getRestorePoints(input: {
  productId: string
  limit?: number
}): Promise<RestorePointsResult> {
  const { default: prisma } = await import('../../db.js')
  const limit = Math.min(200, Math.max(1, input.limit ?? 50))

  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'Product', entityId: input.productId },
    orderBy: { createdAt: 'desc' },
    // Over-fetch: event rows are filtered in process and are the MAJORITY of
    // the table, so taking `limit` here would return a mostly-empty page.
    take: limit * 6,
    select: { id: true, createdAt: true, userId: true, action: true, before: true, after: true, metadata: true },
  })

  let eventRowsExcluded = 0
  let unreadableRowsExcluded = 0
  // Keyed by exact instant: two rows written at the same millisecond are one
  // moment. No time WINDOW is invented — measured, only 1 instant in the whole
  // table carries multiple rows, so clustering by proximity would merge edits
  // that are genuinely separate for no benefit.
  const byInstant = new Map<string, RestorePoint>()

  for (const r of rows) {
    const action = String(r.action ?? '')
    if (NON_VALUE_ACTIONS.has(action)) { eventRowsExcluded++; continue }

    const at = r.createdAt.toISOString()
    const meta = asRecord(r.metadata) ?? {}
    const isFormula = FORMULA_ACTIONS.has(action)

    // A `formula.*` row does NOT use either value-descriptor shape. The real
    // writer records `before: { formula: "<expr>" }`, `after: null`, and puts
    // the field in `metadata.fieldKey` — so `fieldsChangedIn` misses on all
    // three branches, returns `[]`, and the row was discarded as unreadable
    // before it could ever reach the formula branch. A real pin produced NO
    // restore point.
    //
    // For these actions `metadata.fieldKey` is authoritative and the row is a
    // restore point whatever the descriptor looks like. The writer is not
    // changed: its metadata is the richer record, and the reader is what was
    // wrong.
    //
    // ⚠ This was verified 8/8 against fixtures I hand-composed in a shape the
    // writer never produces — the check measured my own assumption, not the
    // system (`reference_inference_from_your_own_scaffolding`). The test for
    // this fix reads rows the real writer created.
    const metaFieldKey = typeof meta.fieldKey === 'string' && meta.fieldKey ? meta.fieldKey : null
    const fields = isFormula && metaFieldKey ? [metaFieldKey] : fieldsChangedIn(r.after, r.before)
    if (fields.length === 0) { unreadableRowsExcluded++; continue }
    // #488 — a formula pin is its OWN point and is never merged with
    // master-scalar rows sharing the instant. Merging is what made "the
    // auditLogId of this point" unanswerable: one point would have covered two
    // rows with two different restore verbs. Keying by the row id keeps the
    // map's merge behaviour for everything else and exempts exactly this.
    const bucket = isFormula ? `${at}#${r.id}` : at
    const existing = byInstant.get(bucket)
    const merged = existing ?? {
      at,
      action,
      actor: r.userId ?? null,
      fields: [],
      restorableFields: [],
      restorable: false,
      restoreVia: isFormula ? 'formula' : 'master',
      layer: typeof meta.layer === 'string' ? meta.layer : null,
    }
    for (const f of fields) if (!merged.fields.includes(f)) merged.fields.push(f)
    merged.restorableFields = merged.fields.filter((f) => RESTORABLE_MASTER_FIELDS.has(f))
    // A formula point restores through the formula path, so the master-scalar
    // allow-list must not veto it — `attr_color` is not a master column and a
    // formula on it is still restorable. Without this, every formula point on a
    // non-scalar field would arrive `restorable: false` and the drawer would
    // correctly refuse to offer a restore that does exist.
    merged.restorable = merged.restoreVia === 'formula'
      ? merged.fields.length > 0
      : merged.restorableFields.length > 0
    if (isFormula && !merged.formula) {
      // The expr travels on the audit row's metadata; `null` when the writer did
      // not record it, which the confirm must be able to say rather than render
      // as an empty formula.
      const expr = typeof meta.expr === 'string' ? meta.expr
        : typeof asRecord(r.before)?.formula === 'string' ? String(asRecord(r.before)!.formula)
        : null
      merged.formula = { auditLogId: r.id, fieldKey: metaFieldKey ?? fields[0] ?? '', expr }
    }
    byInstant.set(bucket, merged)
  }

  const points = [...byInstant.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)

  return {
    productId: input.productId,
    points,
    coverage: {
      auditRowsScanned: rows.length,
      eventRowsExcluded,
      unreadableRowsExcluded,
      note:
        'Only instants recording a VALUE change are offered. Image-publish, create and delete rows ' +
        'are events with nothing to restore to and are excluded. `restorable: false` means the change ' +
        'is real history but POST /restore cannot write those fields — it accepts master scalar columns ' +
        'only, not attr_* attributes, locale-prefixed keys, or sku.',
    },
  }
}
