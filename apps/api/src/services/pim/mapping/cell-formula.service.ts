import { workspaceKey } from '@nexus/database/workspace-context'
import { formulaStorage, formulaStoragePatch } from './formula-storage.js'
import { createHash } from 'node:crypto'
import { formulaGraph, formulaCellKey, formulaScopeKey } from './formula-graph.js'
import type { SheetColumn, SheetColumnSet } from '../sheet-columns.service.js'
import { formulaChannelValues, getFormulaColumns } from './formula-reference-values.js'
/**
 * PES.6 wave-4 (D16) — per-cell formulas.
 *
 * Design: `docs/2026-09-02-wave4-design.md` §1 as amended by §1.6 (A)–(G). The rules that shape
 * this file, each of which was a correction rather than a preference:
 *
 *  (A) The formula lives in `CellFormula`; the VALUE it evaluates to is written where values
 *      already live — the master field, or `ChannelListing.overrideData`. `overrideData` is read
 *      as a value layer by `resolveAttributes` (`attribute-resolver.ts:258`), so a formula string
 *      stored there would publish literally and preflight would call it valid.
 *  (B) `=` is a real equality operator in this language. The editor strips a leading `=`; a stored
 *      expr that still begins with one is REFUSED here.
 *  (E) There is no cached value on the formula row. The value layer is the only authority — a
 *      copy drifts the moment bulk PATCH, an import or apply-mapping writes without this path.
 *  (F) Pinning a literal over a formula writes an `AuditLog` row (`formula.pinned`) carrying
 *      enough to re-create the formula, because PES.4's restore points derive from `AuditLog` and
 *      deleting a `CellFormula` row is not a Product field write.
 *  (G) An errored formula retains the last valid value and records an explicit error.
 *
 * Rules stay computed on read (channel rules in `resolveChannelField`, master rules in
 * `master-rule.service`). CELL formulas are materialised, because their value has to be a real
 * stored value for publish, export and sort — and they are re-evaluated SYNCHRONOUSLY inside the
 * write that changes one of their dependencies on the same product. No job, no propagation.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { primaryConnectionIds } from '../../connection-resolver.service.js'
import { auditLogService } from '../../audit-log.service.js'
import { resolveAttributes } from '../attribute-resolver.js'
import { resolveSourcePath, isPresent } from '../resolve-channel-field.js'
import { evaluateExpr, validateExpr, exprDependenciesDeep, exprRefPositions } from './expr.js'
import { getMappingForMarketplace } from '../schema-mapping.service.js'
import { getFieldCatalogue, type CatalogueField } from './field-catalogue.service.js'
import { writerAcceptsField } from '../master-field-gate.js'

/** The audit action that carries a pinned-over formula. Deliberately NOT one of the event-only
 *  actions PES.4's restore reader excludes (`create`, `imagePublish*`, `soft-delete`). */
export const FORMULA_PINNED_ACTION = 'formula.pinned'
/**
 * #765 — a formula SAVE is audited. Before this the only audit write in the
 * service was the PIN, so a save wrote a product field, incremented
 * `Product.version` and left NO row: no actor, no ip, no record. Demonstrated
 * twice on 2026-09-02 — UX.1's 17:53:44Z PUT and an unidentified 18:16:48Z save
 * that took a fixture row to version 10 with zero audit rows and zero
 * BulkOperations behind it.
 */
export const FORMULA_SET_ACTION = 'formula.set'

/**
 * Owner design §8 (docs/2026-09-02-formula-recalculation-design.md) — a CASCADED
 * write is audited apart from the save that triggered it. `formula.set` says
 * "someone wrote this formula"; `formula.recalc` says "this cell re-evaluated
 * because a field it depends on moved", and carries `sourceField` so a
 * recalculated value on a push column (which pushes exactly as a typed one
 * does) traces back to the edit that caused it rather than to whoever last
 * touched the formula.
 */
export const FORMULA_RECALC_ACTION = 'formula.recalc'

/**
 * #775 — a formula writes through the SAME writer an ordinary cell edit uses.
 *
 * The rule the Owner set is "a formula can write anything the operator can
 * type". That is only true if there is one writer, not two lists kept in step:
 * this path had its own set of twelve master scalars while the bulk PATCH
 * accepted thirty-eight plus every `attr_*` and mapped channel field, so a
 * formula could not write fields an operator could type by hand.
 *
 * Injected rather than imported: the writer is the bulk PATCH route itself,
 * reached with `fastify.inject` exactly as the studio import path already does
 * (`product-studio.routes.ts`). That reuses the real gates, the registry
 * validation, the marketplace context, the CAS and the audit rows — none of it
 * reimplemented here, none of it able to drift.
 *
 * REQUIRED, with no fallback to a direct write. A fallback would be the second
 * write path this exists to remove, and it would be the one taken silently
 * whenever wiring was forgotten.
 */
export type FormulaFieldWriter = (args: {
  productId: string
  /** The name that goes on the wire — `attr_color`, not `color`. */
  writeField: string
  localizedField?: string
  value: unknown
  scope: FormulaScope
  channel?: string | null
  marketplace?: string | null
  market?: string | null
  locale?: string | null
  channelConnectionId?: string | null
  aliasKey?: string | null
  atomic?: () => unknown[]
  expectedVersion?: number
  dryRun?: boolean
  updatedBy?: string | null
}) => Promise<{ ok: boolean; error?: string | null; atomicResults?: unknown[] }>

let fieldWriter: FormulaFieldWriter | null = null

/** Wired once by `cell-formula.routes.ts`, which has the Fastify instance. */
export function setFormulaFieldWriter(w: FormulaFieldWriter): void {
  fieldWriter = w
}

/**
 * The sheet column this coordinate names — the ONE place `writeField` and
 * `options` come from, so the gate, the write and the option check all speak
 * about the same column.
 *
 * Returns null only when the market is missing, and callers REFUSE in that case
 * rather than proceeding: a silently unresolved column would skip the option
 * check and gate on the raw key, which is precisely the pair of bugs #775 fixes.
 */
async function columnFor(
  coord: CellCoordinate,
  columnSet: SheetColumnSet | null,
): Promise<(SheetColumn & { writeTarget: 'master' | 'channelListing' }) | null> {
  if (!columnSet) return null
  const col = columnSet.columns.find(c => c.key === coord.fieldKey)
  if (!col) return null
  const { resolveWriteRouting } = await import('../studio-sheet.service.js')
  return { ...col, ...resolveWriteRouting(col, coord.scope === 'channel' && coord.channel ? { channel: coord.channel } : null, coord.aliasKey ?? null) }
}

/**
 * #775(2) — THE allowed-option check. One implementation.
 *
 * There were two, and they disagreed about what they ACCEPTED, not merely about
 * wording: this one (exact match, raw codes) and an older one inside
 * `evaluateAgainstContext` (trimmed, case-insensitive, localised labels, and it
 * normalised the value to the canonical option). `catalogueFieldFor` returns
 * null for any non-channel scope, so scope decided which ran — master took mine,
 * channel took the other, and `"TRUE"` was therefore valid on one scope and
 * refused on the other. Only mine returned the `allowedOptions`/`actualValue`
 * contract the sheet renders, so half the refusals could not be displayed as
 * designed. Found by a peer noticing two different sentences for one field.
 *
 * The merge keeps BOTH useful halves: the older matching (a formula that
 * produces `"TRUE"` or `" true"` resolves to the canonical `true` rather than
 * being refused for its casing) and this contract shape, with labels when the
 * source has them.
 *
 * A yes/no column is a select here — no column reaches the wire as
 * `kind: 'boolean'`; the boolean schemas arrive as selects over `['false','true']`.
 */
type OptionSource = {
  options?: string[] | null
  optionLabels?: Record<string, string> | null
  label?: string | null
  selectionOnly?: boolean | null
} | null

function checkOptions(
  source: OptionSource,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string; allowedOptions: string[]; actualValue: unknown } {
  const options = source?.options
  if (!options || options.length === 0) return { ok: true, value }
  if (value === null || value === undefined || value === '') return { ok: true, value }

  const trimmed = String(value).trim()
  const hit = options.includes(trimmed)
    ? trimmed
    : options.find((o) => o.toLowerCase() === trimmed.toLowerCase())
  // Normalising to the canonical option is deliberate and pre-existing: the
  // store should hold `true`, not `TRUE`, and refusing on casing alone would
  // fail a formula that is right about the value and wrong about its spelling.
  if (hit !== undefined) return { ok: true, value: hit }

  const labelled = options.map((o) => source?.optionLabels?.[o] ?? o)
  // A cell tooltip cannot hold 268 country codes, and a truncated list that
  // pretends to be complete is worse than one that says how many there are.
  const shown = labelled.length > 8
    ? `${labelled.slice(0, 8).join(', ')} … (${labelled.length} in all)`
    : labelled.join(', ')
  return {
    ok: false,
    error: `${JSON.stringify(String(value))} is not an allowed value for ${source?.label ?? 'this column'} — choose one of: ${shown}`,
    allowedOptions: options,
    actualValue: value,
  }
}

/**
 * #782 — THE option verdict. One function, used by the save, the cascade AND
 * the editor's live preview, so the three cannot disagree about what is
 * allowed.
 *
 * It also decides which source names the FIELD and which names its OPTIONS,
 * because they are deliberately different sources:
 *
 *   · the OPTIONS, and their labels, come from the catalogue when there is one
 *     — that is the list the cell's own editor shows (`Sì`/`No` on Amazon·IT);
 *   · the FIELD NAME comes from the studio column — that is the header the
 *     operator is reading ("Are batteries included?"), on every coordinate.
 *
 * Before this the catalogue supplied both on a channel scope, so a refusal
 * named the field in Italian while the sheet header one row above said
 * English. The raw codes stay in `allowedOptions` as data, untranslated.
 */
export function optionVerdict(input: {
  /** The studio column — names the field. Null only when the market is unknown. */
  column: OptionSource
  /** The channel catalogue entry, when the scope has one. Supplies the option list. */
  catalogueField: OptionSource
  value: unknown
}): { ok: true; value: unknown } | { ok: false; error: string; allowedOptions: string[]; actualValue: unknown } {
  const optionSource = input.catalogueField ?? input.column
  if (!optionSource) return { ok: true, value: input.value }
  return checkOptions(
    { ...optionSource, label: input.column?.label ?? optionSource.label },
    input.value,
  )
}

export type FormulaScope = 'master' | 'channel'

/** Resolve legacy primary requests once; explicit accounts and aliases are never
 * replaced by a default. The ordinary writer rechecks ownership on mutation. */
export async function assertFormulaListingScope(input: { locale?: string | null; productId?: string; scope?: string; channel?: string | null; marketplace?: string | null; aliasKey?: string | null; channelConnectionId?: string | null }) {
  if (input.locale) input.locale = input.locale.toLowerCase()
  if (input.scope === 'master' || !input.channel) {
    if (input.aliasKey || input.channelConnectionId) throw new Error('Shared formulas cannot target a channel account or listing.')
    return
  }
  if (!input.marketplace) throw new Error('A channel formula requires a marketplace.')
  if (input.aliasKey && !input.channelConnectionId) throw new Error('A named listing formula requires its account.')
  if (input.channelConnectionId && input.productId) {
    const { resolveWorkspaceDestination } = await import('../workspace-destination.js')
    const destination = await resolveWorkspaceDestination({ productId: input.productId, channel: input.channel,
      marketplace: input.marketplace, accountId: input.channelConnectionId, aliasKey: input.aliasKey ?? '' })
    input.channelConnectionId = destination.accountId
  } else if (!input.channelConnectionId) {
    input.channelConnectionId = (await primaryConnectionIds([input.channel])).get(input.channel) ?? null
  }
  input.aliasKey ??= ''
}

export async function primaryFormulaListingWhere(productId: string, channel: string, marketplace: string, coord?: { channelConnectionId?: string | null; aliasKey?: string | null }) {
  const connectionId = coord?.channelConnectionId ?? (await primaryConnectionIds([channel])).get(channel) ?? null
  return { productId, channel, marketplace, aliasKey: coord?.aliasKey ?? '', channelConnectionId: connectionId || null }
}


export interface CellCoordinate {
  aliasKey?: string | null
  channelConnectionId?: string | null
  productId: string
  scope: FormulaScope
  /** null/undefined for master scope. Stored as '' — Postgres treats NULLs as distinct in a
   *  unique index, so nullable coordinate columns would accept the same cell twice. */
  channel?: string | null
  marketplace?: string | null
  locale?: string | null
  /**
   * #732 — the SHEET's market, a different axis from `marketplace`: a
   * master-scope formula has no marketplace but is still authored in a market,
   * and the column key set a `$ref` may name differs per market. Absent on rows
   * authored before the column existed; the write path then falls back to the
   * attribute-only universe rather than inventing one.
   */
  market?: string | null
  fieldKey: string
}

export interface CellFormulaRow {
  id: string
  productId: string
  scope: FormulaScope
  channelConnectionId: string | null
  aliasKey: string
  channel: string | null
  marketplace: string | null
  locale: string | null
  /** #732 — the SHEET's market the formula was authored in. Null on rows written
   *  before the column existed; those fall back to the attribute-only universe. */
  market: string | null
  fieldKey: string
  expr: string
  dependsOn: string[]
  lastError: string | null
  evaluatedAt: string | null
  version: number
  updatedBy: string | null
}

const s = (v: string | null | undefined) => v ?? ''
const orNull = (v: string) => (v === '' ? null : v)

function toRow(r: any): CellFormulaRow {
  return {
    id: r.id,
    productId: r.productId,
    scope: r.scope as FormulaScope,
    channelConnectionId: r.channelConnectionId || null, aliasKey: r.aliasKey ?? '',
    channel: orNull(r.channel),
    marketplace: orNull(r.marketplace),
    locale: orNull(r.locale),
    /** #732 — the sheet's market the formula was authored in; null on rows
     *  written before the column existed. */
    market: r.market ?? null,
    fieldKey: r.fieldKey,
    expr: r.expr,
    dependsOn: r.dependsOn ?? [],
    lastError: r.lastError,
    evaluatedAt: r.evaluatedAt ? r.evaluatedAt.toISOString() : null,
    version: r.version,
    updatedBy: r.updatedBy,
  }
}

const whereCoord = (c: CellCoordinate) => ({
  productId_scope_channel_marketplace_locale_fieldKey: workspaceKey({
    productId: c.productId,
    scope: c.scope,
    channel: s(c.channel),
    marketplace: s(c.marketplace),
    locale: s(c.locale),
    channelConnectionId: s(c.channelConnectionId), aliasKey: s(c.aliasKey),
    fieldKey: c.fieldKey,
  }),
})

// ────────────────────────────────────────────────────────────────────
// Evaluation
// ────────────────────────────────────────────────────────────────────

export interface EvaluationOutcome {
  value: unknown
  /** Set when no new value may be stored. The previous value is retained. */
  error: string | null
  warnings: string[]
  dependsOn: string[]
}

/** Load everything one product needs to evaluate any of its formulas, ONCE. */
async function loadContext(productId: string, coord: { channelConnectionId?: string | null; aliasKey?: string | null; scope?: FormulaScope; channel?: string | null; marketplace?: string | null; locale?: string | null; market?: string | null }) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { translations: true } })
  if (!product) throw new Error(`Product not found: ${productId}`)
  const parent = product.parentId
    ? await prisma.product.findUnique({ where: { id: product.parentId }, include: { translations: true } })
    : null
  const locale = coord.locale || 'en'
  // A master formula resolves with NO listing — `resolveAttributes` stops at variant level, which
  // is exactly the master row (`sheet-rows.service.ts:397` already reads that way).
  const channelListing =
    coord.channel && coord.marketplace
      ? await prisma.channelListing.findFirst({
          where: await primaryFormulaListingWhere(productId, coord.channel, coord.marketplace, coord),
        })
      : null
  const resolved = resolveAttributes({
    product: product as any,
    parent: parent as any,
    channelListing: channelListing as any,
    locale,
  })
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(resolved)) flat[k] = v.value

  // #728 — the same key set the sheet exposes, so a formula that PREVIEWS as
  // valid cannot fail differently when it is saved.
  //
  // ⚠ Only when a market is known. `CellFormula` stores `marketplace` (the
  // listing coordinate) and has no field for the SHEET's market, which is a
  // different axis — a master-scope formula therefore has no market here, and
  // the universe stays the attribute-only one it has always been. The
  // consequence, stated rather than hidden: a saved MASTER formula still
  // cannot detect an unknown COLUMN reference, only an unknown attribute one.
  // Closing that needs an additive `market` column on CellFormula.
  // #732 — the SHEET's market first; `marketplace` only as the channel-scope
  // fallback. A master-scope formula has no marketplace, which is exactly the
  // case that could not detect an unknown COLUMN ref before this column existed.
  const market = (coord.market ?? coord.marketplace ?? '').trim()
  const columnSet = market ? await getFormulaColumns({ product, parent, scope: coord.scope ?? (coord.channel ? 'channel' : 'master'),
    channel: coord.channel, marketplace: coord.marketplace, channelConnectionId: coord.channelConnectionId, aliasKey: coord.aliasKey, locale, market }) : null
  if (columnSet) {
    Object.assign(resolved, resolveAttributes({ product: product as any, parent: parent as any, channelListing: channelListing as any, locale,
      localizableKeys: columnSet.columns.filter(c => c.storage === 'localizedContent').map(c => c.slot?.of ?? (c.key === 'name' ? 'title' : c.key)) }))
    const { formulaLookupMap } = await import('../studio-sheet.service.js')
    Object.assign(flat, formulaLookupMap(columnSet.columns, product as never, resolved as never, parent as never))
    for (const column of columnSet.columns) {
      const source = resolved[column.slot?.of ?? (column.storage === 'localizedContent' && column.key === 'name' ? 'title' : column.key)]
      if (source) resolved[column.key] = { ...source, value: flat[column.key] }
    }
    Object.assign(flat, await formulaChannelValues({ flat, columnSet, productId,
      onSource: (key, cell) => { resolved[key] = { value: cell.value, source: 'channelExplicit', inheritedFrom: channelListing?.id ?? null, requestedLocale: cell.requestedLocale, effectiveLocale: cell.effectiveLocale, translationState: cell.translationState } },
      scope: coord.scope ?? (coord.channel ? 'channel' : 'master'), channel: coord.channel, marketplace: coord.marketplace, channelConnectionId: coord.channelConnectionId, aliasKey: coord.aliasKey, locale }))
  }
  return { product, parent, channelListing, locale, resolved, flat, columnSet }
}

/** A shared field has one physical value and one formula, even when viewed in
 * another language. Keep the original formula's source language on subsequent
 * reads/edits. Historical competing expressions require an explicit correction. */
async function loadOwnedContext(input: CellCoordinate) {
  let ctx = await loadContext(input.productId, input)
  const column = ctx.columnSet?.columns.find(c => c.key === input.fieldKey)
  if (!column || column.storage === 'localizedContent') return ctx
  const formulas = await prisma.cellFormula.findMany({ where: {
    productId: input.productId, scope: input.scope, channel: s(input.channel), marketplace: s(input.marketplace),
    channelConnectionId: s(input.channelConnectionId), aliasKey: s(input.aliasKey), fieldKey: input.fieldKey,
  } })
  if (formulas.length > 1) throw new Error('This shared field has competing formulas in multiple languages. Review their history and retain one formula before changing its value.')
  if (formulas[0] && s(input.locale) !== formulas[0].locale) {
    input.locale = formulas[0].locale || null
    ctx = await loadContext(input.productId, input)
  }
  return ctx
}

/**
 * Evaluate ONE formula against an already-loaded row context, and check the result against the
 * channel's caps. Pure once the context exists — the topological pass calls it repeatedly.
 */
export function evaluateAgainstContext(input: {
  expr: string
  ctx: Awaited<ReturnType<typeof loadContext>>
  expressions: Record<string, string>
  field?: CatalogueField | null
  /** Values written earlier in this same topological pass, so a dependent sees fresh input. */
  overlay?: Record<string, unknown>
}): EvaluationOutcome {
  const { expr, ctx, expressions, field, overlay } = input

  const deep = exprDependenciesDeep(expr, expressions)
  if (deep === null) {
    const bad = validateExpr(expr)
    return {
      value: null,
      error: `${bad?.message ?? 'the formula does not parse'} (at character ${(bad?.pos ?? 0) + 1})`,
      warnings: [],
      dependsOn: [],
    }
  }
  if (deep.cycle) {
    return { value: null, error: `Circular reference: ${deep.cycle.join(' → ')}`, warnings: [], dependsOn: deep.attributes }
  }

  // #723 — the write path refuses an unknown reference for the same reason the
  // preview does: a formula that reads nothing is not a formula that evaluates
  // to null. Stored WITH `lastError` and no value (§1.6(G)) so the cell says
  // why, rather than looking like a field that is simply empty.
  const unknownRefs = exprRefPositions(expr)
    .filter((r) => !r.name.includes('.'))
    .filter((r) => !(r.name in ctx.flat))
  if (unknownRefs.length > 0) {
    const first = unknownRefs[0]
    return {
      value: null,
      error: `unknown attribute $${first.name} at ${first.pos}`,
      warnings: [],
      dependsOn: deep.attributes,
    }
  }

  const staleSource = deep.attributes.find(path => {
    if (overlay && Object.prototype.hasOwnProperty.call(overlay, path)) return false
    const hit = ctx.resolved?.[path] ?? ctx.resolved?.[path.replace(/^attr_/, '').replace(/^name$/, 'title')]
    return hit?.translationState === 'fallback' || hit?.translationState === 'outdated'
  })
  if (staleSource) return { value: null, error: `Formula source ${staleSource} needs current ${ctx.locale} content. Translate or review the source before applying this formula.`, warnings: [], dependsOn: deep.attributes }

  const res = evaluateExpr(expr, {
    lookup: (path) => {
      if (overlay && Object.prototype.hasOwnProperty.call(overlay, path)) return overlay[path]
      if (!path.includes('.') && !(path in ctx.flat)) return undefined
      return resolveSourcePath(path, ctx.flat, ctx.product as any, ctx.locale)
    },
    namedExpression: (name) => expressions[name],
  })

  if (res.error) {
    return { value: null, error: res.error, warnings: res.warnings, dependsOn: deep.attributes }
  }

  let value = res.value

  // The same value checks the resolver applies, so a formula cannot smuggle in what a typed
  // value could not. A refusal stores the formula WITHOUT a value (§1.6(G) clears it).
  if (field) {
    // #775(2) — the option check moved OUT of here to `checkOptions`, so master
    // and channel scopes cannot disagree about what they accept. It runs once,
    // in the caller, where the sheet column is also available as a source.
    if (typeof value === 'string') {
      if (field.maxLength && value.length > field.maxLength) {
        return { value: null, error: `The result is ${value.length} characters; ${field.label} accepts ${field.maxLength}.`, warnings: res.warnings, dependsOn: deep.attributes }
      }
      const bytes = Buffer.byteLength(value, 'utf8')
      if (field.maxBytes && bytes > field.maxBytes) {
        return { value: null, error: `The result is ${bytes} UTF-8 bytes; ${field.label} accepts ${field.maxBytes}.`, warnings: res.warnings, dependsOn: deep.attributes }
      }
    }
    if (!isPresent(value) && field.priority === 'required') {
      return { value: null, error: `${field.label} is required, and the formula resolved to nothing.`, warnings: res.warnings, dependsOn: deep.attributes }
    }
  }

  // A formula that evaluates cleanly to NOTHING while warning about why is not a success. The
  // engine reports division by zero, an unknown attribute and a skipped transform as WARNINGS and
  // yields null — so without this the cell would empty itself with `formulaError` unset, which the
  // contract reads as "never had a value" and the operator reads as "my formula is fine".
  // A formula that legitimately produces an empty result and warns about nothing stays clean.
  if (!isPresent(value) && res.warnings.length > 0) {
    return {
      value: null,
      error: `The formula produced no value — ${res.warnings.join('; ')}.`,
      warnings: res.warnings,
      dependsOn: deep.attributes,
    }
  }

  return { value, error: null, warnings: res.warnings, dependsOn: deep.attributes }
}

// ────────────────────────────────────────────────────────────────────
// The value layer — §1.6(A): write where values already live
// ────────────────────────────────────────────────────────────────────

// #775 — the twelve-scalar gate that lived here is GONE, not moved. The writer
// a formula uses is now the operator's own, so its gate is the only gate; a
// second list would be the drift this item removes.

async function writeValue(
  coord: CellCoordinate,
  value: unknown,
  col: SheetColumn & { writeTarget: 'master' | 'channelListing' },
  atomic?: () => unknown[],
  expectedVersion?: number,
  dryRun = false,
): Promise<{ atomicResults?: unknown[] }> {
  // #775 — delegated to the ordinary cell writer. Everything this used to do by
  // hand (the master allow-list, the channel column mapping, the `attr_*` merge
  // with its marketplace context, the select validation, the CAS, the audit row)
  // now happens once, in the path the operator's own edits take.
  if (!fieldWriter) {
    throw new Error(
      'The formula field writer is not wired — `setFormulaFieldWriter` must be called before a formula can write. ' +
        'This is a configuration error, not a bad formula.',
    )
  }
  const writeField = col.writeField
  const contentKey = (col.slot ? `${col.slot.of}[${col.slot.index}]` : writeField).replace(/^attr_/, '').replace(/^name$/, 'title')
  const res = await fieldWriter({
    productId: coord.productId,
    updatedBy: (coord as CellCoordinate & { updatedBy?: string | null }).updatedBy,
    writeField,
    ...(col.storage === 'localizedContent' && col.writeTarget === 'master' ? { localizedField: contentKey } : {}),
    value,
    atomic,
    expectedVersion,
    dryRun,
    scope: coord.scope,
    channelConnectionId: coord.channelConnectionId, aliasKey: coord.aliasKey, locale: coord.locale,
    channel: coord.channel,
    marketplace: coord.marketplace,
    market: (coord as { market?: string | null }).market ?? coord.marketplace ?? null,
  })
  if (!res.ok) {
    throw new Error(res.error ?? `The write of "${writeField}" was refused.`)
  }
  return res
}

// ────────────────────────────────────────────────────────────────────
// Set / delete / restore
// ────────────────────────────────────────────────────────────────────

export interface SetFormulaResult {
  formula: CellFormulaRow
  value: unknown
  error: string | null
  /** #775(2) — present only on an option refusal; the cell renders `error`. */
  allowedOptions?: string[]
  actualValue?: unknown
  warnings: string[]
  /** Other cells on this product that were re-evaluated because they read this field. */
  cascaded: Array<{ fieldKey: string; scope: FormulaScope; value: unknown; error: string | null }>
}

export function formulaStateToken(ctx: Awaited<ReturnType<typeof loadContext>>, formula?: { expr: string; version?: number; lastError?: string | null } | null): string {
  return createHash('sha256').update(JSON.stringify([ctx.product.updatedAt, ctx.product.version,
    ctx.channelListing?.updatedAt, ctx.channelListing?.version, ctx.flat, formula ? [formula.expr, formula.version, formula.lastError] : null])).digest('hex')
}

async function prepareCellFormula(input: CellCoordinate & { expr: string; expectedState?: string; expectedValue?: unknown; allowSelfReference?: boolean }) {
  await assertFormulaListingScope(input)
  // (B) — the editor strips the `=`; a stored expr that still carries one is refused, because
  // `=` is the equality operator and `="a" + $b` would parse as a comparison.
  if (input.expr.trimStart().startsWith('=')) {
    throw new Error('Store the formula without its leading "=" — the editor strips it, and "=" is the equality operator in this language.')
  }
  const expr = input.expr.trim()
  if (!expr) throw new Error('The formula is empty.')

  const bad = validateExpr(expr)
  if (bad) throw new Error(`${bad.message} (at character ${bad.pos + 1})`)

  const ctx = await loadOwnedContext(input)
  const expressions =
    input.scope === 'channel' && input.channel && input.marketplace
      ? (await getMappingForMarketplace(input.channel, input.marketplace)).expressions ?? {}
      : {}

  const deep = exprDependenciesDeep(expr, expressions)!
  // A cell whose formula reads its own field would re-trigger itself forever.
  if (!input.allowSelfReference && deep.attributes.includes(input.fieldKey)) {
    throw new Error(`This formula reads ${input.fieldKey}, which is the field it writes — a cell cannot depend on itself.`)
  }
  if (deep.cycle) throw new Error(`Circular reference: ${deep.cycle.join(' → ')}`)

  const siblings = await prisma.cellFormula.findMany({ where: { productId: input.productId, scope: input.scope, channel: s(input.channel), marketplace: s(input.marketplace), locale: s(input.locale), channelConnectionId: s(input.channelConnectionId), aliasKey: s(input.aliasKey) } })
  const proposed = { ...input, expr, dependsOn: deep.attributes }
  if (!input.allowSelfReference && formulaGraph([...siblings.filter(row => row.fieldKey !== input.fieldKey), proposed]).cycles.has(formulaCellKey(proposed))) {
    throw new Error('Circular reference. This formula creates a loop between product fields.')
  }

  const field = await catalogueFieldFor(input)
  const outcome = evaluateAgainstContext({ expr, ctx, expressions, field })

  // #775 — resolve the column ONCE: `writeField` for the gate and the write,
  // `options` for the check. Refusing when it cannot be resolved is deliberate;
  // proceeding would gate on the raw key and skip the option check silently.
  const col = await columnFor(input, ctx.columnSet)
  if (!col) {
    throw new Error(
      'market is required — a formula is checked against the columns of the scope it is written in, and those differ per market.',
    )
  }
  if (input.scope === 'channel' && col.writeTarget === 'master') throw new Error('This field belongs to Shared product. Set its formula there so every listing shares one value.')
  const writeField = col.writeField

  // The gate, asked of the ROUTED name. #758 asked the same function the raw
  // key here and the routed name in the contract, so the sheet offered columns
  // this refused: `attr_batteries_included` writable, `batteries_included` not.
  if (!writerAcceptsField(writeField)) {
    throw new Error(`"${input.fieldKey}" is not a field a formula can write.`)
  }
  // Formula authoring follows the same editability contract as a typed value.
  if (col.editable === false) {
    throw new Error(`"${input.fieldKey}" is read-only and cannot hold a formula.`)
  }

  // #775(2) — BEFORE `writeValue`. A refusal after the write would leave the
  // product field changed with no formula to explain it, which breaks the
  // never-revert rule from the inside (caught by PES.2 before it shipped).
  //
  // The catalogue field is the richer source (localised labels, `selectionOnly`)
  // but exists only on a channel scope; the sheet column carries the options on
  // every scope. Preferring one and falling back to the other is what stops the
  // two scopes accepting different values.
  const checked = outcome.error ? null : optionVerdict({ column: col, catalogueField: field, value: outcome.value })
  const refusal = checked && checked.ok === false ? checked : null
  /** The value as the store should hold it — `TRUE` resolved to `true`. */
  const normalisedValue = checked && checked.ok ? checked.value : outcome.value
  /** One verdict from here down: an evaluation error and an option refusal are
   *  the same thing to the row, the audit trail and the client. */
  const effectiveError = refusal ? refusal.error : outcome.error

  if (input.expectedState && input.expectedState !== formulaStateToken(ctx, siblings.find(row => row.fieldKey === input.fieldKey))) {
    throw new Error('This product changed after the preview. Preview again before applying.')
  }
  if (Object.prototype.hasOwnProperty.call(input, 'expectedValue') && (effectiveError || JSON.stringify(input.expectedValue) !== JSON.stringify(normalisedValue))) {
    throw new Error('The calculation changed after the preview. Preview again before applying.')
  }
  return { ctx, expr, outcome, col, writeField, normalisedValue, effectiveError, refusal, existing: siblings.find(row => row.fieldKey === input.fieldKey) }
}

export async function previewCellFormula(input: CellCoordinate & { expr: string; allowSelfReference?: boolean }) {
  const prepared = await prepareCellFormula(input)
  const { ctx, outcome, col, writeField, normalisedValue, effectiveError, refusal } = prepared
  let error = effectiveError
  if (!error) {
    try { await writeValue(input, normalisedValue, col, undefined, undefined, true) }
    catch (e) { error = e instanceof Error ? e.message : String(e) }
  }
  return { ok: !error, error, value: error ? null : normalisedValue,
    before: ctx.flat[input.fieldKey] ?? null, expectedState: formulaStateToken(ctx, prepared.existing),
    dependsOn: outcome.dependsOn, warnings: outcome.warnings,
    ...(refusal ? { allowedOptions: refusal.allowedOptions, actualValue: refusal.actualValue } : {}),
    unknownRefs: exprRefPositions(input.expr).filter(ref => !ref.name.includes('.') && !Object.prototype.hasOwnProperty.call(ctx.flat, ref.name)),
    errorPos: exprRefPositions(input.expr).find(ref => !ref.name.includes('.') && !Object.prototype.hasOwnProperty.call(ctx.flat, ref.name))?.pos ?? null,
    sourceLabel: input.scope === 'channel' ? `${input.channel} · ${input.marketplace} · ${ctx.locale}` : `Shared product · ${ctx.locale}`,
    fieldLabel: col.label,
  }
}

export async function setCellFormula(input: CellCoordinate & {
  expr: string
  expectedState?: string
  expectedValue?: unknown
  updatedBy?: string | null
  /** #765 — the caller's address, recorded on the audit row as the bulk path does. */
  ip?: string | null
}): Promise<SetFormulaResult> {
  const { ctx, expr, outcome, col, writeField, normalisedValue, effectiveError, refusal } = await prepareCellFormula(input)
  // #765 — read the version BEFORE the write, so the audit row can state what
  // moved rather than implying it. Taken from the context that was already
  // loaded; no extra query.
  const versionBefore = (ctx.product as unknown as { version?: number } | null)?.version ?? null

  const mutation = () => prisma.cellFormula.upsert({
    where: whereCoord(input),
    create: {
      productId: input.productId, scope: input.scope,
      channel: s(input.channel), marketplace: s(input.marketplace), locale: s(input.locale), channelConnectionId: s(input.channelConnectionId), aliasKey: s(input.aliasKey),
      fieldKey: input.fieldKey, expr, dependsOn: outcome.dependsOn,
      market: input.market ? String(input.market).toUpperCase() : null,
      lastError: effectiveError, evaluatedAt: new Date(), updatedBy: input.updatedBy ?? null,
    },
    update: {
      expr, dependsOn: outcome.dependsOn, lastError: effectiveError,
      // Re-stamped on every save: the market a formula was last authored in is
      // the one whose columns it was checked against.
      ...(input.market ? { market: String(input.market).toUpperCase() } : {}),
      evaluatedAt: new Date(), version: { increment: 1 }, updatedBy: input.updatedBy ?? null,
    },
  })

  // An invalid expression is retained for correction while the previous value stays intact.
  // A valid expression and its materialised result commit in the ordinary writer's transaction.
  const saved = effectiveError ? await mutation() :
    (await writeValue(input, normalisedValue, col, () => [mutation()], col.writeTarget === 'channelListing' ? ctx.channelListing?.version : ctx.product.version)).atomicResults?.[0] as Awaited<ReturnType<typeof mutation>>
  if (!saved) throw new Error('The formula transaction did not return its saved expression.')
  const versionAfter =
    (await prisma.product.findUnique({ where: { id: input.productId }, select: { version: true } }))?.version ?? null

  // #765 — ONE row per save, written whether the formula evaluated or was
  // refused. A refusal gets a row too: "no row" is the state that made three
  // unattributed writes unanswerable tonight, and a save that was attempted and
  // rejected is a fact about the system, not an absence.
  await auditLogService.write({
    userId: input.updatedBy ?? null,
    ip: input.ip ?? null,
    entityType: 'Product',
    entityId: input.productId,
    action: FORMULA_SET_ACTION,
    before: { field: input.fieldKey, value: ctx.flat[input.fieldKey] ?? null, version: versionBefore },
    after: {
      field: input.fieldKey,
      value: effectiveError ? ctx.flat[input.fieldKey] ?? null : (normalisedValue as never),
      version: versionAfter,
    },
    metadata: {
      scope: input.scope,
      channelConnectionId: input.channelConnectionId ?? null, aliasKey: input.aliasKey ?? '',
      channel: orNull(input.channel),
      marketplace: orNull(input.marketplace),
      locale: orNull(input.locale),
      market: input.market ?? null,
      fieldKey: input.fieldKey,
      expr,
      dependsOn: outcome.dependsOn,
      lastError: effectiveError,
      refused: Boolean(effectiveError),
      /** #775(2) — an option refusal names what was rejected and what was allowed. */
      ...(refusal ? { allowedOptions: refusal.allowedOptions, actualValue: refusal.actualValue } : {}),
      // ⚠ For a CHANNEL save the ChannelListing's version moves, not the
      // Product's, so before/after are legitimately equal on those rows.
      versionOf: input.scope === 'master' ? 'product' : 'channelListing',
    },
  })

  const cascaded = await reevaluateDependents({
    productId: input.productId,
    changedFields: [input.fieldKey],
    ...(col.writeTarget === 'channelListing' && input.channel && input.marketplace ? { coordinate: { channel: input.channel, marketplace: input.marketplace, channelConnectionId: input.channelConnectionId, aliasKey: input.aliasKey, locale: input.locale } } : {}),
    updatedBy: input.updatedBy ?? null,
    seed: [formulaCellKey(input)],
    ip: input.ip,
  })

  return {
    formula: toRow(saved),
    value: effectiveError ? ctx.flat[input.fieldKey] ?? null : normalisedValue,
    error: effectiveError,
    ...(refusal ? { allowedOptions: refusal.allowedOptions, actualValue: refusal.actualValue } : {}),
    warnings: outcome.warnings,
    cascaded,
  }
}

/** The catalogue entry for a channel cell, so caps and closed lists apply. Master cells have no
 *  channel schema behind them, so they validate only on the master write allow-list. */
export async function catalogueFieldFor(c: CellCoordinate): Promise<CatalogueField | null> {
  if (c.scope !== 'channel' || !c.channel || !c.marketplace) return null
  const { productCategoryContext } = await import('../product-category-context.js')
  const context = await productCategoryContext([c.productId], c.channel, c.marketplace, c.channelConnectionId)
  const category = context.byRow.get(`${c.productId}:${c.aliasKey ?? ''}`) ?? context.defaults[c.productId]
  const cat = await getFieldCatalogue({ locale: c.locale ?? undefined, channel: c.channel, marketplace: c.marketplace, accountId: c.channelConnectionId, productType: category?.channelCategoryId ?? null })
  return cat.fields.find((f) => f.fieldKey === c.fieldKey) ?? null
}

/**
 * (F) Pin a literal over a formula: the formula row goes, the value stays, and an `AuditLog` row
 * carries enough to put it back. PES.4's restore points read `AuditLog`, and deleting a
 * `CellFormula` row is not a Product field write, so without this the formula would be
 * unrecoverable.
 */
export async function pinOverFormula(
  input: CellCoordinate & { userId?: string | null; ip?: string | null },
): Promise<{ pinned: boolean; reason?: 'not_found' | 'coordinate_mismatch'; storedAt?: Array<{ locale: string; channel: string; marketplace: string }> }> {
  await assertFormulaListingScope(input)
  if (input.market || input.marketplace) await loadOwnedContext(input)
  const existing = await prisma.cellFormula.findUnique({ where: whereCoord(input) })
  if (!existing) {
    // #763 — "nothing was deleted" is not one answer, it is two, and the route
    // cannot tell them apart from a bare `false`. UX.1's restore sent no
    // `locale` while the stored row carried "de": the coordinate missed, this
    // returned `{pinned:false}`, and the route answered **200** with the
    // formula still stored — a delete that deleted nothing reporting success.
    //
    // So: is there a formula on this field at all, under some other coordinate?
    // If yes the caller addressed the wrong one (almost always a missing
    // `locale`) and deserves to be told which parts exist; if no, there is
    // simply nothing here. One extra read, only on the path that already failed.
    const siblings = await prisma.cellFormula.findMany({
      where: { productId: input.productId, scope: input.scope, fieldKey: input.fieldKey, channel: s(input.channel), marketplace: s(input.marketplace), channelConnectionId: s(input.channelConnectionId), aliasKey: s(input.aliasKey) },
      select: { locale: true, channel: true, marketplace: true },
    })
    return {
      pinned: false,
      reason: siblings.length > 0 ? 'coordinate_mismatch' : 'not_found',
      storedAt: siblings.map((r) => ({ locale: r.locale, channel: r.channel, marketplace: r.marketplace })),
    }
  }

  await auditLogService.write({
    userId: input.userId ?? null,
    // #764 — the request IP, exactly as the bulk-patch path records it
    // (`products.routes.ts`: `ip: request.ip ?? null`). It was omitted here, so
    // every `formula.pinned` row carried `ip = null` while the bulk rows beside
    // it carried an address: when three unattributed writes had to be traced
    // tonight, the instrument that identified the writer existed on one path
    // and not the other. Purely additive — `AuditLog.ip` and
    // `auditLogService.write`'s `ip` both already existed; only this caller
    // failed to pass it.
    ip: input.ip ?? null,
    entityType: 'Product',
    entityId: input.productId,
    action: FORMULA_PINNED_ACTION,
    before: { formula: existing.expr },
    after: null,
    metadata: {
      fieldKey: existing.fieldKey,
      expr: existing.expr,
      scope: existing.scope,
      channelConnectionId: existing.channelConnectionId || null, aliasKey: existing.aliasKey ?? '',
      channel: orNull(existing.channel),
      marketplace: orNull(existing.marketplace),
      locale: orNull(existing.locale),
      dependsOn: existing.dependsOn,
    },
  })
  await prisma.cellFormula.delete({ where: { id: existing.id } })
  return { pinned: true }
}

export async function readFormulaCell(input: CellCoordinate) {
  await assertFormulaListingScope(input)
  const ctx = await loadOwnedContext(input)
  const formula = await prisma.cellFormula.findUnique({ where: whereCoord(input) })
  const col = await columnFor(input, ctx.columnSet)
  const storage = col && ctx.columnSet ? formulaStorage(input, col, ctx.columnSet, ctx.product, ctx.channelListing) : null
  return { storage, targetState: createHash('sha256').update(JSON.stringify({ storage, expr: formula?.expr ?? null, error: formula?.lastError ?? null })).digest('hex'), value: ctx.flat[input.fieldKey] ?? null, expr: formula?.expr ?? null,
    formula: formula ? { expr: formula.expr, dependsOn: formula.dependsOn, lastError: formula.lastError, market: formula.market } : null,
    expectedState: formulaStateToken(ctx, formula) }
}

/** Replace a formula and its value together. Used by typing, paste, fill, and one-time transforms. */
export async function setCellLiteral(input: CellCoordinate & {
  value: unknown; expectedState?: string; updatedBy?: string | null; ip?: string | null
}) {
  await assertFormulaListingScope(input)
  const ctx = await loadOwnedContext(input)
  const existing = await prisma.cellFormula.findUnique({ where: whereCoord(input) })
  if (input.expectedState && input.expectedState !== formulaStateToken(ctx, existing)) {
    throw new Error('This product changed after the preview. Preview again before applying.')
  }
  const col = await columnFor(input, ctx.columnSet)
  if (!col || col.editable === false || !writerAcceptsField(col.writeField)) throw new Error('This field cannot be edited in this scope.')
  const verdict = optionVerdict({ column: col, catalogueField: await catalogueFieldFor(input), value: input.value })
  if (verdict.ok === false) throw new Error(verdict.error)
  const atomic = () => [
    prisma.cellFormula.deleteMany({ where: whereCoord(input).productId_scope_channel_marketplace_locale_fieldKey }),
    ...(existing ? [prisma.auditLog.create({ data: {
      userId: input.updatedBy ?? null, ip: input.ip ?? null, entityType: 'Product', entityId: input.productId,
      action: FORMULA_PINNED_ACTION, before: { formula: existing.expr },
      metadata: { ...whereCoord(input).productId_scope_channel_marketplace_locale_fieldKey,
        market: input.market ?? null, expr: existing.expr, dependsOn: existing.dependsOn },
    } })] : []),
  ]
  await writeValue(input, verdict.value, col, atomic,
    col.writeTarget === 'channelListing' ? ctx.channelListing?.version : ctx.product.version)
  const cascaded = await reevaluateDependents({ productId: input.productId, changedFields: [input.fieldKey],
    updatedBy: input.updatedBy, ip: input.ip,
    ...(col.writeTarget === 'channelListing' && input.channel && input.marketplace ? { coordinate: { channel: input.channel, marketplace: input.marketplace, channelConnectionId: input.channelConnectionId, aliasKey: input.aliasKey, locale: input.locale } } : {}) })
  return { ok: true, value: verdict.value, cascaded }
}

/** Restore an operation snapshot, including a formula that had kept its last valid value. */
export async function restoreFormulaSnapshot(input: CellCoordinate & {
  snapshot: Awaited<ReturnType<typeof readFormulaCell>>; expectedState: string; updatedBy?: string | null; ip?: string | null
}) {
  await assertFormulaListingScope(input)
  const ctx = await loadOwnedContext(input)
  const existing = await prisma.cellFormula.findUnique({ where: whereCoord(input) })
  if (formulaStateToken(ctx, existing) !== input.expectedState) throw new Error('This product changed. Its newer changes were kept.')
  const col = await columnFor(input, ctx.columnSet)
  if (!col || col.editable === false || !writerAcceptsField(col.writeField)) throw new Error('This field cannot be edited in this scope.')
  let restored = input.snapshot.formula
  let restoredValue = input.snapshot.value
  // Restoring inheritance must also publish today's effective value to following channels.
  // Passing the old displayed snapshot to the ordinary writer would refresh them with stale
  // parent content even though the final raw field correctly returned to null/inherited.
  if (!restored && input.snapshot.storage?.target === 'master') {
    const product = { ...ctx.product, ...formulaStoragePatch(input.snapshot.storage, ctx.product) }
    const resolved = resolveAttributes({ product: product as never, parent: ctx.parent as never, locale: ctx.locale })
    const { formulaLookupMap } = await import('../studio-sheet.service.js')
    const values = formulaLookupMap(ctx.columnSet?.columns ?? [], product as never, resolved as never, ctx.parent as never)
    restoredValue = Object.prototype.hasOwnProperty.call(values, input.fieldKey) ? values[input.fieldKey] : resolved[input.fieldKey]?.value ?? input.snapshot.value
  }
  // A restored link uses today's sources. An already-broken formula keeps its last good value.
  if (restored && !restored.lastError) {
    const checked = await previewCellFormula({ ...input, expr: restored.expr })
    if (checked.ok) { restoredValue = checked.value; restored = { ...restored, dependsOn: checked.dependsOn } }
    else restored = { ...restored, lastError: checked.error ?? 'This formula could not be recalculated.' }
  }
  const data = restored ? { ...restored, updatedBy: input.updatedBy ?? null, evaluatedAt: new Date() } : null
  await writeValue(input, restoredValue, col, () => [
    ...(data ? [prisma.cellFormula.upsert({ where: whereCoord(input),
      create: { ...whereCoord(input).productId_scope_channel_marketplace_locale_fieldKey, ...data },
      update: { ...data, version: { increment: 1 } } })] : [prisma.cellFormula.deleteMany({ where: whereCoord(input).productId_scope_channel_marketplace_locale_fieldKey })]),
    prisma.auditLog.create({ data: { userId: input.updatedBy ?? null, ip: input.ip ?? null,
      entityType: 'Product', entityId: input.productId, action: 'formula.restored',
      after: { value: restoredValue, formula: restored?.expr ?? null } as never,
      metadata: whereCoord(input).productId_scope_channel_marketplace_locale_fieldKey } }),
  ], col.writeTarget === 'channelListing' ? ctx.channelListing?.version : ctx.product.version)
  if (input.snapshot.storage && (!restored || restored.lastError)) {
    const storage = input.snapshot.storage
    if (storage.target !== col.writeTarget || storage.writeField !== col.writeField.replace(/\[\d+\]$/, '')) throw new Error('This field’s storage changed. Its current value was kept.')
    if (storage.target === 'master') {
      const current = await prisma.product.findUniqueOrThrow({ where: { id: input.productId } })
      await prisma.product.update({ where: { id: current.id }, data: formulaStoragePatch(storage, current) as never })
    } else {
      const current = await prisma.channelListing.findFirstOrThrow({ where: await primaryFormulaListingWhere(input.productId, input.channel!, input.marketplace!, input) })
      await prisma.channelListing.update({ where: { id: current.id }, data: formulaStoragePatch(storage, current) as never })
    }
  }
  const cascaded = await reevaluateDependents({ productId: input.productId, changedFields: [input.fieldKey],
    seed: [formulaCellKey(input)], updatedBy: input.updatedBy, ip: input.ip,
    ...(col.writeTarget === 'channelListing' && input.channel && input.marketplace ? { coordinate: { channel: input.channel, marketplace: input.marketplace, channelConnectionId: input.channelConnectionId, aliasKey: input.aliasKey, locale: input.locale } } : {}) })
  return { ok: true, value: restoredValue, cascaded }
}

/** Re-create a formula from its `formula.pinned` audit row and re-evaluate it. */
export async function restoreCellFormula(input: { auditLogId: string; userId?: string | null }): Promise<SetFormulaResult> {
  const row = await prisma.auditLog.findUnique({ where: { id: input.auditLogId } })
  if (!row || row.action !== FORMULA_PINNED_ACTION) {
    throw new Error('That restore point is not a pinned formula.')
  }
  const m = (row.metadata ?? {}) as any
  if (m.scope === 'channel' && !Object.prototype.hasOwnProperty.call(m, 'channelConnectionId')) throw new Error('This older restore point has no recorded account. Review its original destination before restoring; its saved history is preserved.')
  return setCellFormula({
    productId: row.entityId,
    scope: m.scope, channel: m.channel, marketplace: m.marketplace, locale: m.locale, channelConnectionId: m.channelConnectionId, aliasKey: m.aliasKey,
    fieldKey: m.fieldKey, expr: m.expr, updatedBy: input.userId ?? null,
  })
}

// ────────────────────────────────────────────────────────────────────
// Synchronous dependency re-evaluation
// ────────────────────────────────────────────────────────────────────

/**
 * Re-evaluate every formula on THIS product whose `dependsOn` includes a field just written,
 * then anything depending on those, in topological order. Synchronous and in-process: a product
 * has ≤ ~100 fields, and a job would break "the value you see is the value that was stored".
 *
 * A cycle across cells is refused at SAVE (`setCellFormula`), so the walk terminates; the visited
 * set is belt-and-braces against a graph that predates that check.
 *
 * 🔴 OWNER RULING, 2026-09-03: **synchronous, always.** The design draft's rule 1 recommended
 * falling back to a queue above 50 dependants; that clause is REFUSED. There is no threshold, no
 * cap and no deferral in this walk — every dependant is re-evaluated in the request that wrote the
 * source, however many there are. Do not re-introduce one: it would restore exactly the gap this
 * function's own first line of reasoning rejects ("the value you see is the value that was
 * stored"), and on this machine a queue-backed path is INERT (no Redis), so a fallback would look
 * identical to a working one while silently dropping the tail of the fan-out.
 * Pinned by `cell-formula-recalc.vitest.test.ts` — "no cap: 60 dependants all recalculate inline".
 */
export async function reevaluateDependents(input: {
  productId: string
  changedFields: string[]
  coordinate?: { channel: string; marketplace: string; channelConnectionId?: string | null; aliasKey?: string | null; locale?: string | null }
  /** Product families have one parent and its variants. */
  includeChildren?: boolean
  updatedBy?: string | null
  /**
   * Owner design §8 — the address of the ORIGINAL write, carried onto every
   * cascaded audit row. Same reason `formula.pinned` gained it in #764: when an
   * unattributed write has to be traced, the instrument must exist on every
   * path, not on some of them.
   */
  ip?: string | null
  /** Coordinate keys already handled by the caller. */
  seed?: string[]
}): Promise<Array<{ productId?: string; fieldKey: string; scope: FormulaScope; value: unknown; error: string | null; sourceField: string }>> {
  const all = await prisma.cellFormula.findMany({ where: { productId: input.productId } })

  const done = new Set<string>(input.seed ?? [])
  const out: Array<{ productId?: string; fieldKey: string; scope: FormulaScope; value: unknown; error: string | null; sourceField: string }> = []
  const graph = formulaGraph(input.coordinate ? all.filter(row => row.scope === 'channel' && row.channel === input.coordinate!.channel && row.marketplace === input.coordinate!.marketplace && (row.channelConnectionId ?? '') === (input.coordinate!.channelConnectionId ?? '') && (row.aliasKey ?? '') === (input.coordinate!.aliasKey ?? '') && (!input.coordinate!.locale || !row.locale || row.locale === input.coordinate!.locale)) : all)
  const changed = new Set(input.changedFields.flatMap(field => [field, field.replace(/^attr_/, '')]))
  const changedByScope = new Map<string, Set<string>>()
  const overlays = new Map<string, Record<string, unknown>>()
  const contexts = new Map<string, Awaited<ReturnType<typeof loadContext>>>()
  const failed = new Set(all.filter(row => row.lastError).map(formulaCellKey))
  for (const row of graph.ordered) {
      const key = formulaCellKey(row)
      if (done.has(key)) continue
      const scopeKey = formulaScopeKey(row)
      const coord: CellCoordinate = {
        productId: row.productId, scope: row.scope as FormulaScope,
        channel: orNull(row.channel), marketplace: orNull(row.marketplace),
        channelConnectionId: row.channelConnectionId || null, aliasKey: row.aliasKey ?? '',
        // #732 — carry the STORED market, or a re-evaluation would check the
        // formula against a narrower universe than the save did and invent an
        // "unknown attribute" for a reference that was valid when written.
        locale: orNull(row.locale), market: row.market ?? null, fieldKey: row.fieldKey,
      }
      const contextKey = `${scopeKey}:${row.market ?? ''}`
      const ctx = contexts.get(contextKey) ?? await loadContext(row.productId, coord)
      contexts.set(contextKey, ctx)
      const moved = changedByScope.get(scopeKey) ?? new Set(changed)
      changedByScope.set(scopeKey, moved)
      for (const column of ctx.columnSet?.columns ?? []) {
        const routed = await columnFor({ ...coord, fieldKey: column.key }, ctx.columnSet)
        if (routed && changed.has(routed.writeField)) moved.add(column.key)
      }
      const trigger = row.dependsOn.find(d => moved.has(d))
      if (trigger === undefined) continue
      done.add(key)
      const overlay = overlays.get(scopeKey) ?? {}
      overlays.set(scopeKey, overlay)
      const failedSource = graph.dependencies(row).find(source => failed.has(formulaCellKey(source)))
      const graphError = graph.cycles.has(key) ? 'Circular reference. Remove the loop between these fields.'
        : failedSource ? `Could not update because ${failedSource.fieldKey} has a formula error. The previous value is kept.` : null
      // Source writes use storage names; expressions use the column keys shown in the sheet.
      const expressions =
        coord.scope === 'channel' && coord.channel && coord.marketplace
          ? (await getMappingForMarketplace(coord.channel, coord.marketplace)).expressions ?? {}
          : {}
      const field = await catalogueFieldFor(coord)
      const outcome = evaluateAgainstContext({ expr: row.expr, ctx, expressions, field, overlay })

      // #775 — a cascade writes through the same resolution as a direct save:
      // the routed name, and the same option check. A dependent cell that
      // recomputes to a value outside its list must not be written either.
      const depCol = await columnFor(coord as never, ctx.columnSet)
      const depChecked = outcome.error ? null : optionVerdict({ column: depCol, catalogueField: field, value: outcome.value })
      const depRefusal = depChecked && depChecked.ok === false ? depChecked : null
      const competingLocale = depCol && depCol.storage !== 'localizedContent' && all.some(other => other.id !== row.id && other.fieldKey === row.fieldKey && other.scope === row.scope && other.channel === row.channel && other.marketplace === row.marketplace && other.channelConnectionId === row.channelConnectionId && other.aliasKey === row.aliasKey)
      const canonicalChannelFormula = row.scope === 'channel' && depCol?.writeTarget === 'master'
      let depError = (canonicalChannelFormula ? 'This field belongs to Shared product. Move its formula there; the previous value is kept.' : null) ?? (competingLocale ? 'This shared field has competing formulas in multiple languages. Review and retain one expression.' : null) ?? graphError ?? (!depCol || depCol.editable === false || !writerAcceptsField(depCol.writeField) ? 'This field can no longer be edited in this scope.' : null) ?? (depRefusal ? depRefusal.error : outcome.error)
      const depValue = depChecked && depChecked.ok ? depChecked.value : outcome.value

      // #765 — the version BEFORE, from the context already loaded; no extra query.
      const versionBefore = (ctx.product as unknown as { version?: number } | null)?.version ?? null
      let versionAfter = versionBefore

      const updateFormula = () => prisma.cellFormula.update({ where: { id: row.id }, data: {
        lastError: depError, evaluatedAt: new Date(), dependsOn: outcome.dependsOn, updatedBy: input.updatedBy ?? null,
      } })
      if (!depError) {
        try {
          await writeValue(coord, depValue, depCol!, () => [updateFormula()])
          versionAfter = (await prisma.product.findUnique({ where: { id: row.productId }, select: { version: true } }))?.version ?? null
          if (versionAfter !== null) ctx.product.version = versionAfter
          failed.delete(key)
          overlay[row.fieldKey] = depValue
        } catch (error) { depError = error instanceof Error ? error.message : String(error) }
      }
      if (depError) { failed.add(key); await updateFormula() }

      // Owner design §8 — one row per cascaded re-evaluation, the same shape as
      // `formula.set` plus the source field.
      await auditLogService.write({
        userId: input.updatedBy ?? null,
        ip: input.ip ?? null,
        entityType: 'Product',
        entityId: row.productId,
        action: FORMULA_RECALC_ACTION,
        before: { version: versionBefore },
        after: { version: versionAfter },
        metadata: {
          scope: coord.scope,
          channelConnectionId: coord.channelConnectionId ?? null, aliasKey: coord.aliasKey ?? '',
          channel: orNull(row.channel),
          marketplace: orNull(row.marketplace),
          locale: orNull(row.locale),
          market: row.market ?? null,
          fieldKey: row.fieldKey,
          /** The field whose change triggered this re-evaluation. */
          sourceField: trigger,
          expr: row.expr,
          value: depError ? null : depValue,
          dependsOn: outcome.dependsOn,
          lastError: depError,
          refused: Boolean(depError),
          ...(depRefusal ? { allowedOptions: depRefusal.allowedOptions, actualValue: depRefusal.actualValue } : {}),
          // ⚠ For a CHANNEL write the ChannelListing's version moves, not the
          // Product's, so before/after are legitimately equal on those rows.
          versionOf: coord.scope === 'master' ? 'product' : 'channelListing',
        },
      })

      out.push({ fieldKey: row.fieldKey, scope: coord.scope, value: depError ? null : depValue, error: depError, sourceField: trigger })
      // Downstream fields must carry a visible error if an upstream calculation failed.
      moved.add(row.fieldKey)
      // Channel contexts read master values afresh after the master group finishes.
      if (row.scope === 'master') changed.add(row.fieldKey)
  }
  if (!input.coordinate && input.includeChildren !== false) {
    const children = await prisma.cellFormula.findMany({ where: { product: { parentId: input.productId } },
      select: { productId: true }, distinct: ['productId'] })
    for (const productId of new Set(children.map(row => row.productId))) {
      if (productId === input.productId) continue
      out.push(...(await reevaluateDependents({ ...input, productId, changedFields: [...changed], includeChildren: false })).map(row => ({ productId, ...row })))
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────────────

export async function listCellFormulas(productId: string): Promise<CellFormulaRow[]> {
  const rows = await prisma.cellFormula.findMany({
    where: { productId },
    orderBy: [{ scope: 'asc' }, { fieldKey: 'asc' }],
  })
  return rows.map(toRow)
}

/** For PES.5's contract: formulas keyed by the coordinate the sheet asks about. */
export async function cellFormulasForProducts(input: {
  productIds: string[]
  channelConnectionId?: string | null
  aliasKey?: string | null
  scope?: FormulaScope
  channel?: string | null
  marketplace?: string | null
  locale?: string | null
}): Promise<Record<string, Record<string, CellFormulaRow>>> {
  if (input.productIds.length === 0) return {}
  await assertFormulaListingScope(input)
  const rows = await prisma.cellFormula.findMany({
    where: {
      productId: { in: input.productIds },
      channelConnectionId: s(input.channelConnectionId), aliasKey: s(input.aliasKey),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.channel !== undefined ? { channel: s(input.channel) } : {}),
      ...(input.marketplace !== undefined ? { marketplace: s(input.marketplace) } : {}),

    },
  })
  const out: Record<string, Record<string, CellFormulaRow>> = {}
  for (const r of rows) {
    if (input.locale !== undefined && r.locale && r.locale.toLowerCase() !== s(input.locale).toLowerCase()) {
      const ctx = await loadContext(r.productId, { ...r, scope: r.scope as FormulaScope, locale: input.locale })
      const column = ctx.columnSet?.columns.find(c => c.key === r.fieldKey)
      if (!column || column.storage === 'localizedContent') continue
    }
    ;(out[r.productId] ??= {})[r.fieldKey] = toRow(r)
  }
  return out
}
