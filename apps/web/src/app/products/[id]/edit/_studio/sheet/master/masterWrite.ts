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
import { commitLanguageGroups } from '../languageWrites'
import { getBackendUrl } from '@/lib/backend-url'

import { askForThemeChangePlan } from '../../variants/channel/themePlanAsk'
/**
 * 🔴 From the MODULE, not from `@/design-system/grid`. The barrel re-exports `NexusGrid.tsx` and a
 * node test importing anything through it dies at parse — the lesson this file's own header is
 * about. `editors/sheetWriter.ts` type-imports AG and value-imports only `./roundTrip`, which is
 * likewise a pure `.ts`, so this import keeps the module node-testable.
 */
import { variationThemeWrite } from '@/design-system/grid/editors/sheetWriter'

import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'
import type { VariationThemeWriteFacts } from '@/design-system/grid/editors/sheetWriter'
import type { StudioRow, StudioSheet } from './types'
import type { UseMasterSheetOptions } from './useMasterSheet'

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

async function commitMasterLanguage(
  req: SheetWriteRequest<StudioRow>,
  ctx: MasterCommitContext,
): Promise<SheetWriteResult> {
  const backend = getBackendUrl()
  const columns = ctx.sheet?.columns ?? []
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const cells: Record<string, { ok: boolean; reason?: string; unreachable?: boolean }> = {}

  const bulk = req.cells

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
            contentAddress: req.row?.values?.[c.colId]?.contentAddress,
            contentVersion: req.row?.values?.[c.colId]?.contentVersion,
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
        batchReason = body?.message || body?.error || 'Someone else changed this row. Refresh to see their version.'
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


/**
 * VT.2 — a `variationTheme` cell does NOT go through `PATCH /api/products/bulk`.
 *
 * Its fact has ONE writer (design §3.6, D-VT3), and the bulk route no longer accepts it at all —
 * `variation_theme` was removed from `CHANNEL_WRITABLE` and from `CHANNEL_FIELD_MAP` by VT.1, so a
 * batch carrying it would be refused by the write gate rather than landing somewhere nothing reads.
 *
 * 🔴 **This function is the reason the branch FIRES.** `variationThemeWrite` decided the endpoint,
 * the body and the plan/none outcomes from the first hour, and 20 tests proved every one of them —
 * and nothing on the sheet ever called it, so a witnessed reorder gesture on `VX-TEST-3AX` (the
 * editor's own footer reading `order`, Enter pressed, the cell repainted) issued **zero requests**
 * and left `Product.version` at 2. A decision function nobody calls is not a write path; it is a
 * unit test with a nice comment.
 */
export async function commitVariationTheme<T>(
  req: SheetWriteRequest<T>,
  productId: string,
): Promise<SheetWriteResult> {
  const backend = getBackendUrl()
  const cells: NonNullable<SheetWriteResult['cells']> = {}
  let version: number | undefined
  let conflict = false
  for (const cell of req.cells) {
    /* The reported value carries its own BASELINE (see `VariationThemeCell.baseline`); the row's
       current value cannot serve as one, because AG's setter already replaced it in place. */
    const after = (cell.value ?? null) as (VariationThemeWriteFacts & { baseline?: VariationThemeWriteFacts }) | null
    const decision = variationThemeWrite({ kind: 'variationTheme' }, after?.baseline ?? null, after)
    if (!decision.send) {
      /* A held commit is not a refusal to paint red: `plan` means VT.4's dry-run Modal opens and
         nothing is written, and `Nothing changed` means the operator closed an editor they had not
         edited. Both are `ok` with the server's own sentence carried as the reason. */
      const reason = 'plan' in decision ? decision.plan.reason : decision.reason
      /**
       * VT.2c — and now the Modal actually OPENS. `ThemeChangePlanHost` (mounted by `ChannelSheet`)
       * answers this and fetches the plan with `dryRun: true`; NOTHING is written on this path, which
       * is the decision `variationThemeWrite` already took two lines above.
       *
       * `askForThemeChangePlan` returning false means no host was listening, and the `reason` above is
       * then the whole of what the operator sees — a degraded answer, never a silent one, and never a
       * write either way.
       */
      /* `channel: null` is the MASTER coordinate, and master has no lock to plan for
         (`variation-rules.service.ts` returns `locked: null` there) — so a plan without a channel is a
         shape that cannot occur, and it is refused rather than coerced into a string. */
      if ('plan' in decision && after?.write?.coordinate.channel) {
        askForThemeChangePlan({
          reason,
          setChangeIs: decision.plan.setChangeIs,
          request: {
            /* The coordinate is sent back VERBATIM from the cell (contract §1's rule) — re-deriving it
               here is how a channel edit lands on the wrong coordinate. */
            coordinate: {
              productId,
              channel: after.write.coordinate.channel,
              market: after.write.coordinate.market,
              accountId: after.write.coordinate.accountId,
              aliasKey: after.write.aliasKey,
            },
            expectedVersion: after.write.expectedVersion,
            ...(after.resetRequested ? { reset: true } : {
            ...(after.theme ? { theme: after.theme.code } : {}),
            /**
             * 🔴 The FAMILY's own spelling (`Colore`), never the canonical key (`color`).
             *
             * Measured on the wire 2026-09-13: the first plan request sent
             * `mapping:[{axisKey:"color"},{axisKey:"size"}]` and the route answered **400
             * `bad_projection_request`** — `"Scollatura" is not one of this family's axes`, listing
             * `axes: ["Colore","Taglia"]`. The same fact VT.2b fixed for the `variation-axes` body one
             * function away: a cell carries its family spelling in `axes[].familyKey`, and a caller that
             * re-derives it sends a key no family has.
             */
            mapping: after.axes
              .filter((a) => a.included && a.target)
              .map((a, order) => ({ axisKey: a.familyKey ?? a.axisKey, target: a.target as string, order })),
            }),
          },
        })
      }
      cells[cell.colId] = { ok: true, reason }
      continue
    }
    const query = new URLSearchParams()
    if (decision.query.channel) query.set('channel', decision.query.channel)
    if (decision.query.market) query.set('market', decision.query.market)
    if (decision.query.accountId) query.set('accountId', decision.query.accountId)
    if (decision.query.aliasKey) query.set('aliasKey', decision.query.aliasKey)
    const url = `${backend}/api/products/${productId}/studio/${decision.endpoint}${query.size ? `?${query}` : ''}`
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        signal: AbortSignal.timeout(30_000),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision.body),
      })
      const payload = await res.json().catch(() => ({}))
      if (res.ok) {
        cells[cell.colId] = { ok: true }
        const next = (payload as { version?: number; product?: { version?: number } }).version ?? (payload as { product?: { version?: number } }).product?.version
        if (typeof next === 'number') version = next
      } else {
        /* 409 → repaint + refetch exactly like every other cell (design §3.6). */
        if (res.status === 409) conflict = true
        const body = payload as { error?: string; message?: string; detail?: string; locked?: { reason?: string; setChangeIs?: 'relist' | 'new-parent' | 'in-place' } }
        /**
         * 🔴 VT.F item A6 — the `axes_locked` RACE, which is the one 409 that is not a conflict to
         * repaint but an OPERATION to plan.
         *
         * The sequence: the cell was read while the coordinate was a draft, so `cell.locked` was null and
         * `variationThemeWrite` correctly decided to SEND; between that read and this PATCH the
         * coordinate went live, and VT.1b's route now answers `409 axes_locked` with the lock's own
         * sentence. Before this branch the operator's only signal was a refused cell carrying the raw
         * code `axes_locked` — the design's §3.5 rule ("a SET change on a live coordinate is a plan")
         * enforced on the local read and abandoned on the server's. The two doors must answer the same
         * way, so the server's 409 opens the SAME dry-run Modal the local gate opens, with the SERVER's
         * reason (it is the one that knows the listing went live).
         *
         * The cell reads `ok` with that sentence, exactly as the local plan path does: nothing was
         * written either way, and painting red would say a change failed when the truth is that it needs
         * a plan. `conflict` stays true, so the row refetches and comes back carrying the lock — without
         * that the next commit would race the same way again.
         */
        if (res.status === 409 && body.error === 'axes_locked' && after?.write?.coordinate.channel) {
          const reason = body.locked?.reason ?? body.message ?? 'This coordinate went live while you were editing it.'
          const opened = askForThemeChangePlan({
            reason,
            setChangeIs: body.locked?.setChangeIs ?? 'relist',
            request: {
              coordinate: {
                productId,
                channel: after.write.coordinate.channel,
                market: after.write.coordinate.market,
                accountId: after.write.coordinate.accountId,
                aliasKey: after.write.aliasKey,
              },
              expectedVersion: after.write.expectedVersion,
              ...(after.theme ? { theme: after.theme.code } : {}),
              mapping: after.axes
                .filter((a) => a.included && a.target)
                .map((a, order) => ({ axisKey: a.familyKey ?? a.axisKey, target: a.target as string, order })),
            },
          })
          /* 🔴 `askForThemeChangePlan` returning false means NO HOST WAS LISTENING. Reporting `ok` then
             would hide the refusal behind a Modal that never opened — so the cell keeps the server's
             sentence as a refusal in that case, which is degraded but never silent. */
          cells[cell.colId] = opened ? { ok: true, reason } : { ok: false, reason }
          continue
        }
        cells[cell.colId] = { ok: false, reason: body.detail ?? body.message ?? body.error ?? `The server refused this change (${res.status})` }
      }
    } catch (err) {
      /* A rejected fetch is an UNKNOWN outcome, never a refusal — the same rule the bulk path below
         records at length. */
      cells[cell.colId] = { ok: false, unreachable: true, reason: err instanceof Error ? err.message : String(err) }
    }
  }
  return { ok: Object.values(cells).every((c) => c.ok), cells, version, conflict }
}

export function commitMasterRow(req: SheetWriteRequest<StudioRow>, ctx: MasterCommitContext): Promise<SheetWriteResult> {
  const byKey = new Map(ctx.sheet?.columns.map(column => [column.key, column]) ?? [])
  /* Split the batch the way `commitLanguageGroups` splits it by language: a fill or a paste can
     carry a theme cell beside ordinary ones, and each half goes to the route that accepts it. */
  const theme = req.cells.filter((c) => byKey.get(c.colId)?.kind === 'variationTheme')
  if (theme.length > 0) {
    const rest = req.cells.filter((c) => byKey.get(c.colId)?.kind !== 'variationTheme')
    return (async () => {
      const themed = await commitVariationTheme({ ...req, cells: theme }, req.rowId)
      if (rest.length === 0) return themed
      const other = await commitMasterRow({ ...req, cells: rest }, ctx)
      return {
        ok: themed.ok && other.ok,
        cells: { ...themed.cells, ...other.cells },
        version: other.version ?? themed.version,
        conflict: themed.conflict || other.conflict,
        unreachable: themed.unreachable || other.unreachable,
        reason: themed.reason ?? other.reason,
      }
    })()
  }
  return commitLanguageGroups(req, key => byKey.get(key)?.locale ?? ctx.locale,
    (request, language) => commitMasterLanguage(request, { ...ctx, locale: language ?? ctx.locale }))
}
