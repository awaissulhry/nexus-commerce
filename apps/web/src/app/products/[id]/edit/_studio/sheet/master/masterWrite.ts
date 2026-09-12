/**
 * PES.2 — the master scope's WRITE, in its own module so the node suite can reach it.
 *
 * 🔴 Two separate reasons this file exists, and the second one is the trap.
 *
 * 1. `commit` was declared **inside** `useMasterSheet`, so no test could touch it — the master
 *    sheet's whole write path, and the function at the centre of P2-1's in-flight latch. Its twin
 *    `commitChannelRow` was module-level with `channelWrite.vitest.test.ts` beside it. Same
 *    operation, two lanes: one testable and tested, one neither. (FE.1's set-scan, hub #348.)
 *
 * 2. **Hoisting it to module scope was NOT enough**, and this is the part worth remembering.
 *    `useMasterSheet.ts` VALUE-imports `@/design-system/grid` for `SheetWriter` and
 *    `CellSaveTracker`; that barrel re-exports `NexusGrid.tsx`, and a node test importing anything
 *    from that module dies at **parse** — before a single test runs. `useChannelSheet.ts` is
 *    testable because its grid import is `import type`, which is erased. So the rule is not "hoist
 *    to module scope", it is: **a unit is testable only if nothing on its import path is a `.tsx`.**
 *    Same lesson as `design-system/grid/renderers/emptyValue.ts`, in a second place.
 *
 * This module therefore type-imports the grid and imports no React at all.
 */
import { getBackendUrl } from '@/lib/backend-url'

import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'
import type { SheetColumn, StudioRow, StudioSheet } from './types'
import type { UseMasterSheetOptions } from './useMasterSheet'

/**
 * Where one cell writes.
 *
 * The bulk endpoint takes `Product` columns and `attr_*` (its `categoryAttributes` merge); a locale
 * slot has no route through it and goes to the per-product global patch. A batch can therefore be
 * split across two calls for one row — which is fine, and is why `commit` returns per-cell outcomes
 * rather than one verdict for the row.
 */
const routeFor = (column: SheetColumn | undefined) =>
  column?.storage === 'localizedContent' ? 'localized' : 'bulk'

/**
 * The master scope's write, as a MODULE-LEVEL function so it can be tested.
 *
 * 🔴 This was declared inside `useMasterSheet` and **no test touched it** — the master sheet's whole
 * write path, the `commit` that `SheetWriter` calls, and the function at the centre of the P2-1
 * in-flight latch. Its counterpart `commitChannelRow` is a module-level export in
 * `useChannelSheet.ts` with `channelWrite.vitest.test.ts` beside it, and that is the one that got
 * probed with a stubbed `fetch` when the `errors[]`-before-`updated` ordering needed confirming.
 * Same operation, two lanes: one testable and tested, one neither. Found by FE.1's set-scan, which
 * measured that 76% of the logic in these trees is unreachable by the suite that exists.
 *
 * It hoisted cleanly because it only ever captured three things — two refs and a scalar — so the
 * context is passed explicitly. **The refs are read by the CALLER at call time**, not captured here:
 * `sheet` is whatever the last read produced, and a stale copy would write against a column set the
 * operator is no longer looking at.
 */
export interface MasterCommitContext {
  /** The sheet as of THIS call — supplies `columns`, i.e. where each cell writes. */
  sheet: StudioSheet | null
  /** Only the write callbacks; this function has no business with the rest of the options. */
  opts: Pick<UseMasterSheetOptions, 'onWriteStart' | 'onWriteEnd'>
  locale: string
  /**
   * 🔴 The marketplace the sheet was READ with — NOT `sheet.scope.marketplace`.
   *
   * The ruling said to take it from the sheet's own scope. Measured before writing: on master the
   * server returns `scope: { kind: 'master', marketplace: null, locale: 'de', label: 'Master' }`
   * even when the sheet was requested at `?market=DE`. So the scope does not carry it back, and a
   * fix reading from there would have omitted the context and left every `attr_*` write refused —
   * the defect intact behind a change that looked like the fix.
   *
   * This is the same coordinate that built the read URL, so the write is validated against exactly
   * the schema that declared the columns writable.
   */
  market: string
}

export async function commitMasterRow(
  req: SheetWriteRequest<StudioRow>,
  ctx: MasterCommitContext,
): Promise<SheetWriteResult> {
  const backend = getBackendUrl()
  const columns = ctx.sheet?.columns ?? []
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const cells: Record<string, { ok: boolean; reason?: string; unreachable?: boolean }> = {}

  const bulk = req.cells.filter((c) => routeFor(byKey.get(c.colId)) === 'bulk')
  const localized = req.cells.filter((c) => routeFor(byKey.get(c.colId)) === 'localized')

/**
 * The row version a response is allowed to teach us — `undefined` when it is about something else.
 *
 * 🔴 `currentVersion` is NOT unconditionally the product's (#701, PES.5). The route answers
 * `versionOf: 'product' | 'channelListing'`, and on a channel-only write the number is the
 * LISTING's version. Storing that as the product's would poison the row: every later write would
 * send a version the product never had and come back 409 "someone else changed this row", when the
 * someone else was this arithmetic. Absent is treated as `product` because that is what the route
 * omits it for — a master write that answered before the field existed.
 *
 * Keeping the held version is the conservative direction, and it is what the 200 branch's own
 * comment already argues for: a kept version costs at most one recoverable 409, a wrong one costs a
 * row that cannot be written until reload.
 *
 * ⚠ `sheetWriter.ts:223` has a METHOD called `versionOf(rowId)` that returns a row's version. It is
 * a homonym of this response field, in the same subsystem, and grepping the name finds it first.
 */
function versionFromBody(body: { currentVersion?: unknown; versionOf?: unknown } | null): number | undefined {
  if (typeof body?.currentVersion !== 'number') return undefined
  if (body.versionOf !== undefined && body.versionOf !== 'product') return undefined
  return body.currentVersion
}

  /* The ROW is the subject the header counts (#693) — passed explicitly rather than parsed back
     out of `writeId`, because the three reporter callers each build that id differently and a
     frame that split on ':' would be guessing at two of them. */
  const writeId = `${req.rowId}:${Date.now()}`
  ctx.opts.onWriteStart?.(writeId, req.rowId)

  let version: number | undefined
  let conflict = false
  let batchReason: string | undefined
  let anyOk = false

  try {
    if (bulk.length > 0) {
      const res = await fetch(`${backend}/api/products/bulk`, {
        method: 'PATCH',
        signal: AbortSignal.timeout(30_000),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: bulk.map((c) => ({
            id: req.rowId,
            // The server told us the field name; never re-derive it from the column key.
            field: byKey.get(c.colId)?.writeField ?? c.colId,
            // 🔴 On the MASTER scope a `reset` really is "store nothing here", because the layer
            // above is the parent and `resolveAttributes` falls through to it the moment this row
            // holds no value of its own. That is a fact about THIS scope, not about resets: a
            // channel scope resets by clearing `*Override` and restoring `followMaster*`, which
            // is a different route entirely (PES.3 owns that `commit`). The intent is honoured
            // here rather than in the writer precisely so the two can differ.
            value: c.intent === 'reset' ? null : c.value === '' ? null : c.value,
            ...(c.intent === 'reset' ? { intent: 'reset' } : {}),
          })),
          /* 🔴 THE MARKETPLACE CONTEXT. Without it every `attr_*` write on the master scope was
             REFUSED — the Owner's "I'm unable to write a lot of attributes still, such as color".
             `products.routes.ts:1403` validates each `attr_*` change with
             `getFieldDefinition(field, { marketplace: primaryContext?.marketplace ?? null })`, and
             this body carried no contexts at all, so every master attribute arrived with
             `marketplace: null` and came back 400 "Unknown or read-only category attribute".
             SC.1 measured it across the whole schema: **master DE/de 60 of 60 `attr_*` columns
             refused, Amazon·DE 57 accepted** — the difference being that the channel writer sends
             its contexts and this one did not.

             The marketplace comes from the coordinate the sheet was READ with — see
             `MasterCommitContext.market` for why NOT from `sheet.scope`, which the server returns
             as `null` on this endpoint. A write is validated against the schema that declared the
             column, or the two are answering different questions. */
          ...(ctx.market
            ? { marketplaceContexts: [{ marketplace: ctx.market, locale: ctx.locale }] }
            : {}),
          // Omitted when unknown — the endpoint treats absent as "no concurrency guard", which is
          // honest, where a guessed number would refuse a write the operator is entitled to make.
          //
          // ⚠ NOT covered by a test, and it cannot be: `expectedVersion: req.expectedVersion` with
          // an undefined value is an EQUIVALENT MUTANT, because `JSON.stringify` drops undefined
          // properties — both forms put identical bytes on the wire. The spread stays because it
          // states the intent at the call site, but do not read the green suite as evidence that
          // this line is load-bearing; it becomes so only if the body stops going through
          // `JSON.stringify`.
          ...(req.expectedVersion !== undefined ? { expectedVersion: req.expectedVersion } : {}),
        }),
      })
      const body = await res.json().catch(() => null)
      if (res.status >= 500 || res.ok && (!body || typeof body.updated !== 'number' && !Array.isArray(body.errors))) throw new Error('Save confirmation was unavailable. Checking the stored values.')

      if (res.status === 409) {
        conflict = true
        version = versionFromBody(body)
        batchReason = 'Someone else changed this row. Refresh to see their version.'
        for (const c of bulk) cells[c.colId] = { ok: false, reason: batchReason }
      } else if (!res.ok) {
        const errors: Array<{ id?: string; field?: string; error?: string }> = Array.isArray(body?.errors) ? body.errors : []
        batchReason = body?.error || body?.message || errors[0]?.error || `Refused (HTTP ${res.status})`
        for (const c of bulk) {
          const field = byKey.get(c.colId)?.writeField ?? c.colId
          const mine = errors.find(e => e.id === req.rowId && (e.field === field || e.field === c.colId))
          cells[c.colId] = { ok: false, reason: mine?.error || batchReason }
        }
      } else {
        // A 200 can still carry per-cell refusals beside a partial success.
        const errors: Array<{ id?: string; field?: string; error?: string }> = Array.isArray(body?.errors) ? body.errors : []
        for (const c of bulk) {
          const field = byKey.get(c.colId)?.writeField ?? c.colId
          const mine = errors.find((e) => e.id === req.rowId && (e.field === field || e.field === c.colId))
          cells[c.colId] = mine ? { ok: false, reason: mine.error || 'Refused' } : { ok: true }
          if (!mine) anyOk = true
        }
        /*
         * 🔴 READ BACK, never computed. The `expectedVersion + 1` that used to sit here invented a
         * version the row might never have had — the banked `Product.version` ≠ row version trap —
         * and the route was doing the same arithmetic on its own side
         * (`freshChannelVersion ?? expectedVersion + 1`), directly beneath a comment explaining why
         * computing is wrong. **Two independent guesses agreeing is not a measurement.**
         *
         * If the server returns no version it did not participate in the CAS, and the caller keeps
         * the version it read from the sheet. A guessed version loses a race it should have won.
         */
        version = versionFromBody(body) ?? version
      }
    }

    if (localized.length > 0) {
      const patch: Record<string, Record<string, unknown>> = { [ctx.locale]: {} }
      const reset: Record<string, string[]> = {}
      for (const c of localized) {
        const col = byKey.get(c.colId)
        const field = (col?.slot ? `${col.slot.of}[${col.slot.index}]` : c.colId).replace(/^attr_/, '').replace(/^name$/, 'title')
        if (c.intent === 'reset') (reset[ctx.locale] ??= []).push((col?.slot?.of ?? c.colId).replace(/^attr_/, '').replace(/^name$/, 'title'))
        else patch[ctx.locale][field] = c.value === '' ? null : c.value
      }
      const res = await fetch(`${backend}/api/products/${req.rowId}/global`, {
        method: 'PATCH',
        signal: AbortSignal.timeout(30_000),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch, ...(Object.keys(reset).length ? { reset } : {}), expectedVersion: version ?? req.expectedVersion }),
      })
      const body = await res.json().catch(() => null)
      if (res.status >= 500 || res.ok && !body) throw new Error('Save confirmation was unavailable. Checking the stored values.')
      if (res.ok) {
        version = versionFromBody(body) ?? version
        for (const c of localized) cells[c.colId] = { ok: true }
        anyOk = true
      } else {
        if (res.status === 409) conflict = true
        const detail = Array.isArray(body?.details) ? body.details[0] : undefined
        const reason = detail || body?.error || `Refused (HTTP ${res.status})`
        for (const c of localized) cells[c.colId] = { ok: false, reason }
      }
    }
  } catch (err) {
    /*
     * 🔴 `unreachable: true`. This catch swallows a NETWORK failure — `fetch` rejects when the
     * connection is refused — and returning a plain `{ ok: false }` made it indistinguishable from
     * a server refusal, so the writer painted `refused`. Measured against a real API restart:
     * `net::ERR_CONNECTION_REFUSED`, cell `refused`, and the operator told a change had failed that
     * the server may well have applied.
     *
     * The writer's `unknown` path existed and was UNREACHABLE from this sheet, because the unit
     * test mocked a `commit` that rejects and the real one never does.
     */
    const reason = err instanceof Error ? err.message : String(err)
    for (const c of req.cells) cells[c.colId] = cells[c.colId] ? { ...cells[c.colId], unreachable: false } : { ok: false, reason, unreachable: true }
    ctx.opts.onWriteEnd?.(writeId, false, reason, req.rowId)
    return { ok: false, reason, cells, unreachable: true }
  }

  const ok = Object.values(cells).every((c) => c.ok)
  // Ruling #27: the header renders the reporter's message verbatim, so it must never be empty on
  // a failure. A 200 can carry per-cell refusals with no batch-level reason at all, and reporting
  // `undefined` there would leave the header saying a write failed without saying why.
  const firstReason = Object.values(cells).find((c) => !c.ok)?.reason
  ctx.opts.onWriteEnd?.(writeId, ok, ok ? undefined : (batchReason ?? firstReason), req.rowId)
  return { ok: ok || anyOk, reason: batchReason, version, cells, conflict }
}
