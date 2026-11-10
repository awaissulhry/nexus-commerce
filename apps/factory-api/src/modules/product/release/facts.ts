import type { FactoryClient } from '@nexus/factory-db'
import { CERTIFIED_CATEGORIES, type PpeCategory } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { can, holds, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { releaseRefusal as changeOrderRefusal, type ChangeEffect } from '@nexus/factory-domain/product/changes/rules'
import { checkedCells, coverageCell, type CoverageCell } from '@nexus/factory-domain/product/compliance/rules'
import { isGoverned, pendingOf } from '@nexus/factory-domain/product/minutes/rules'
import type { GateCertificate, GateDrift, GateFacts, GateLine, GateStep } from '@nexus/factory-domain/product/release/gate'
import {
  inScope,
  orderedScope,
  sameScope,
  scopeProblems,
  scopeWords,
  waitingWords,
  widenProblems,
  type ReleaseScope,
  type ScopeProblem,
  type ScopeStyle,
} from '@nexus/factory-domain/product/release/scope'
import { effectiveType, missingAttributes, REQUIRABLE_ATTRIBUTES, TYPE_LIMITS, type TypeRow } from '@nexus/factory-domain/product/types/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import { gateRequestFor } from '../../compliance/certificates/gate'
import { readColourways, type BomStyleRow, type RevisionRow } from '../bom/store'
import { checkViewOf, loadStructure } from '../bom-structure/check'
import { MINUTES_OPERATION_COLUMNS, readVersionsOf, smvOnDay, storedMinutesOf } from '../minutes/store'

/**
 * What the release gate reads (B-W2b-231), with one client: a request's for the Release modal and the styles list, the
 * release command's transaction for the release itself (W1's product/bom revisions.ts releaseRevision, after its locks), so
 * the checklist and the release see the same rows. Everything else is the pure factory-domain product/release gate.
 *
 *   BOM, ROUTING, MATERIALS  B-W2b-223's loadStructure + checkViewOf (W1's release check and the structure's)
 *   SMV                      B-W2b-215's versions per operation (readVersionsOf, smvOnDay) on the day
 *   PRICES                   whether each line's material has a standard cost (never the figure)
 *   LABEL                    the revision's garment label template
 *   CERTIFICATE              B-W1-12's gate request once, then B-W1-20's coverageCell per colourway × size the release takes
 *   MEASUREMENTS             the revision's measurement spec (B-W2b-224) that is not archived
 *   ATTRIBUTES               the product type's chain (B-W2b-221) and the style's values
 *   CHANGE_ORDERS            the style's live change orders (B-W2b-226) and change-order rules' releaseRefusal
 *   SCOPE                    StyleRevision.releasedColourwayIds / releasedSizes (B-W2b-212), or the scope asked
 *   DRIFT                    the counts on the revision that becomes obsolete, only those the reader may see
 */

export type Reader = FactoryClient | CommandTx

/** The release scope and the score a revision holds (B-W2b-212's columns; W1's revision read does not name them). */
export async function readScopeRow(db: Reader, revisionId: string): Promise<{ scope: ReleaseScope; completenessPct: string | null }> {
  const row = await db.styleRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { releasedColourwayIds: true, releasedSizes: true, completenessPct: true } })
  return {
    scope: { colourwayIds: [...row.releasedColourwayIds], sizes: [...row.releasedSizes] },
    completenessPct: row.completenessPct === null ? null : decimalText(row.completenessPct.toString()),
  }
}

export interface LoadedGate {
  readonly facts: GateFacts
  readonly colourways: readonly { readonly id: string; readonly code: string; readonly name: string; readonly status: 'ACTIVE' | 'ARCHIVED' }[]
  readonly sizeLabels: ReadonlyMap<string, string>
  readonly scopeStyle: ScopeStyle
  /** What the revision holds: planned on a draft, released on a frozen revision. */
  readonly planned: ReleaseScope
  /** What this gate was asked about. */
  readonly asked: ReleaseScope
}

export interface GateOptions {
  /** A scope to preview (left out: what the revision holds). */
  readonly asked?: ReleaseScope | undefined
  readonly today: BusinessDate
  /** Whose counts the DRIFT item and the effects show (null: none read, as in the release command). */
  readonly actor: Actor | null
}

const NOT_PPE = 'Not PPE: no certificate is needed.'
const CATEGORY_I = 'Category I PPE is self-certified: no notified body certificate is needed.'

/** The problems of a scope asked of a revision: a draft's whole scope; a frozen revision's later release (only what it adds). */
export function problemsOf(revision: { readonly revision: number; readonly status: string }, planned: ReleaseScope, asked: ReleaseScope, style: ScopeStyle): ScopeProblem[] {
  if (revision.status === 'DRAFT') return scopeProblems(asked, style)
  if (sameScope(planned, asked)) return []
  // What it is released for already stays (an archived colourway in it is not refused again); what it adds is checked.
  const added = scopeProblems(asked, style).filter((problem) => (problem.colourwayId === null || !planned.colourwayIds.includes(problem.colourwayId)) && (problem.size === null || !planned.sizes.includes(problem.size)))
  return [...added, ...widenProblems(planned, asked, style, revision.revision)]
}

export async function loadGate(db: Reader, style: BomStyleRow, revision: RevisionRow, options: GateOptions): Promise<LoadedGate> {
  const draft = revision.status === 'DRAFT'
  const held = await readScopeRow(db, revision.id)
  const colourways = await readColourways(db, style.id)
  const sizes = await db.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, label: true } })
  const scopeStyle: ScopeStyle = { colourways: colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, status: colourway.status })), sizes: style.sizes }
  const planned = orderedScope(held.scope, scopeStyle)
  const asked = orderedScope(options.asked ?? planned, scopeStyle)
  const problems = problemsOf(revision, planned, asked, scopeStyle)
  const details = await db.style.findUniqueOrThrow({ where: { id: style.id }, select: { ppeCategory: true, productTypeProfileId: true } })

  const certificate = await certificateOf(db, style, details.ppeCategory as PpeCategory, colourways, asked, options.today)
  const scope = { asked, problems, words: scopeWords(asked, scopeStyle), waiting: waitingWords(asked, scopeStyle), style: scopeStyle }
  const base = {
    revision: { revision: revision.revision, status: revision.status },
    styleStatus: style.status,
    certificate,
    scope,
    storedCompletenessPct: held.completenessPct,
  }
  const loadedBase = { colourways, sizeLabels: new Map(sizes.map((size) => [size.code, size.label ?? size.code])), scopeStyle, planned, asked }
  if (!draft) {
    const frozen: GateFacts = {
      ...base,
      check: null,
      steps: [],
      lines: [],
      label: { named: false, template: null },
      spec: null,
      attributes: { typeCode: null, required: 0, missing: [] },
      changeOrders: { proposing: null, others: [] },
      drift: null,
    }
    return { facts: frozen, ...loadedBase }
  }

  // THE BOM check (B-W2b-223), with the lines, materials and steps it read.
  const structure = await loadStructure(db, style, revision)
  const check = checkViewOf(structure)
  const recordOf = new Map(structure.records.map((record) => [record.id, record]))
  const costed = await standardCostKnown(db, structure.bom.lines.map((line) => line.itemId))
  const lines: GateLine[] = structure.bom.lines.map((line) => ({
    lineId: line.id,
    seq: line.seq,
    itemId: line.itemId,
    code: structure.bom.materials.get(line.itemId)?.code ?? line.itemId,
    approval: structure.extras.get(line.itemId)?.approval ?? 'PENDING',
    customerSupplied: (recordOf.get(line.id)?.customerSuppliedByPartyId ?? null) !== null,
    hasStandardCost: costed.has(line.itemId),
  }))
  const steps = await stepsOf(db, structure.bom.steps, options.today)
  const label = revision.labelTemplateId === null ? null : await db.labelTemplate.findUnique({ where: { id: revision.labelTemplateId }, select: { id: true, code: true, revision: true, status: true } })
  const spec = await db.measurementSpec.findFirst({ where: { revisionId: revision.id, status: { in: ['DRAFT', 'APPROVED'] } }, select: { id: true, status: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })
  const facts: GateFacts = {
    ...base,
    check: { blockers: check.blockers, warnings: check.warnings },
    steps,
    lines,
    label: { named: revision.labelTemplateId !== null, template: label },
    spec,
    attributes: await attributesOf(db, style.id, details.productTypeProfileId),
    changeOrders: await changeOrdersOf(db, style.id, revision.id, options.today),
    drift: await driftOf(db, style, revision, options.actor),
  }
  return { facts, ...loadedBase }
}

// ---- the parts ------------------------------------------------------------------------------------------------------------------

/** The materials (of these) that have a standard cost: only whether one exists is read, never the figure. */
async function standardCostKnown(db: Reader, itemIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return new Set()
  const rows = await db.item.findMany({ where: { id: { in: ids }, standardCost: { not: null } }, select: { id: true } })
  return new Set(rows.map((row) => row.id))
}

async function stepsOf(db: Reader, steps: readonly { readonly id: string; readonly seq: number; readonly code: string; readonly name: string; readonly operationId: string; readonly standardMinutes: string }[], today: BusinessDate): Promise<GateStep[]> {
  if (steps.length === 0) return []
  const operationIds = [...new Set(steps.map((step) => step.operationId))]
  const operations = new Map((await db.operation.findMany({ where: { id: { in: operationIds } }, select: MINUTES_OPERATION_COLUMNS })).map((row) => [row.id, row]))
  const versionsOf = await readVersionsOf(db, operationIds)
  return steps.map((step) => {
    const versions = versionsOf.get(step.operationId) ?? []
    const operation = operations.get(step.operationId)
    const library = operation ? smvOnDay(storedMinutesOf(operation), versions, today) : { standardMinutes: step.standardMinutes, version: null }
    const waiting = pendingOf(versions)
    return {
      stepId: step.id,
      seq: step.seq,
      code: step.code,
      name: step.name,
      operationId: step.operationId,
      standardMinutes: step.standardMinutes,
      governed: isGoverned(versions),
      library: { standardMinutes: library.standardMinutes, versionNumber: library.version?.number ?? null },
      waiting: waiting ? { number: waiting.number, standardMinutes: waiting.standardMinutes } : null,
    }
  })
}

/**
 * The certificate coverage of the cells the release takes (PRD-190: "certificate coverage for every switched-on colourway ×
 * size"): the active colourways × sizes of the range in the scope, the switched-on ones (an ACTIVE SKU) when the style has
 * any on, every one otherwise (B-W1-20's checkedCells), each answered by B-W1-12's gate on the day.
 */
async function certificateOf(db: Reader, style: BomStyleRow, ppeCategory: PpeCategory, colourways: readonly { id: string; code: string; status: string }[], scope: ReleaseScope, today: BusinessDate): Promise<GateCertificate> {
  if (!CERTIFIED_CATEGORIES.includes(ppeCategory)) return { required: false, notRequiredMessage: ppeCategory === 'NOT_PPE' ? NOT_PPE : CATEGORY_I, cells: [] }
  const active = colourways.filter((colourway) => colourway.status === 'ACTIVE')
  const grid = active.flatMap((colourway) => style.sizes.filter((size) => inScope(scope, colourway.id, size)).map((size) => ({ colourway, size })))
  if (grid.length === 0) return { required: true, notRequiredMessage: null, cells: [] }
  const variants = await db.variant.findMany({ where: { styleId: style.id, status: 'ACTIVE' }, select: { colourwayId: true, size: true } })
  const offered = new Set(variants.map((variant) => `${variant.colourwayId}|${variant.size}`))
  const { request } = await gateRequestFor(db, { styleId: style.id, colourwayId: grid[0]!.colourway.id, size: grid[0]!.size }, today)
  if (!('size' in request)) throw new Error('unreachable: a size gate request')
  const cells: CoverageCell[] = grid.map(({ colourway, size }) => coverageCell(request, { colourwayId: colourway.id, colourwayCode: colourway.code, size, offered: offered.has(`${colourway.id}|${size}`) }))
  return {
    required: true,
    notRequiredMessage: null,
    cells: checkedCells(cells).map((entry) => ({ colourwayId: entry.colourwayId, size: entry.size, label: entry.label, status: entry.status, message: entry.message })),
  }
}

const TYPE_ROW = {
  id: true,
  code: true,
  name: true,
  productType: true,
  parentId: true,
  requiredAttributes: true,
  defaultSizeScaleId: true,
  labelTemplateId: true,
  measurementTemplateId: true,
  defaultPpeCategory: true,
  defaultPpeStandard: true,
  defaultPpeClass: true,
} as const
const STYLE_VALUES = Object.fromEntries(REQUIRABLE_ATTRIBUTES.map((field) => [field, true])) as { [Field in (typeof REQUIRABLE_ATTRIBUTES)[number]]: true }

/** The attributes the style's product type requires (with what it inherits) and those the style leaves empty (B-W2b-221). */
async function attributesOf(db: Reader, styleId: string, typeId: string | null): Promise<GateFacts['attributes']> {
  if (typeId === null) return { typeCode: null, required: 0, missing: [] }
  const chain: TypeRow[] = []
  let next: string | null = typeId
  while (next !== null && chain.length < TYPE_LIMITS.depth && !chain.some((row) => row.id === next)) {
    const row: TypeRow | null = await db.productTypeProfile.findUnique({ where: { id: next }, select: TYPE_ROW })
    if (!row) break
    chain.push(row)
    next = row.parentId
  }
  if (chain.length === 0) return { typeCode: null, required: 0, missing: [] }
  const required = effectiveType(chain).requiredAttributes
  const values = await db.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_VALUES })
  const missing = missingAttributes({ ...values, netMassKg: values.netMassKg === null ? null : values.netMassKg.toString() }, required)
  return { typeCode: chain[0]!.code, required: required.length, missing }
}

const LIVE_ORDERS = ['DRAFT', 'SUBMITTED', 'APPROVED'] as const

/** The style's live change orders: the one that proposes this draft (with why it refuses the release now) and the others. */
async function changeOrdersOf(db: Reader, styleId: string, revisionId: string, today: BusinessDate): Promise<GateFacts['changeOrders']> {
  const orders = await db.changeOrder.findMany({
    where: { styleId, status: { in: [...LIVE_ORDERS] } },
    select: { id: true, number: true, status: true, toRevisionId: true, effect: true, effectiveDate: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (orders.length === 0) return { proposing: null, others: [] }
  const ids = [...new Set(orders.map((order) => order.toRevisionId).filter((id): id is string => id !== null))]
  const numbers = new Map((ids.length === 0 ? [] : await db.styleRevision.findMany({ where: { id: { in: ids } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision]))
  const ref = (order: (typeof orders)[number]) => ({ id: order.id, number: order.number, status: order.status, toRevision: order.toRevisionId === null ? null : (numbers.get(order.toRevisionId) ?? null) })
  const own = orders.find((order) => order.toRevisionId === revisionId) ?? null
  const refusal = own
    ? changeOrderRefusal({ number: own.number, status: own.status, effect: own.effect as ChangeEffect, effectiveDate: own.effectiveDate === null ? null : own.effectiveDate.toISOString().slice(0, 10) }, today)
    : null
  return {
    proposing: own ? { ...ref(own), refusal: refusal ? { code: refusal.code === 'NOT_YET_EFFECTIVE' ? 'NOT_YET_EFFECTIVE' : 'NOT_APPROVED', message: refusal.message } : null } : null,
    others: orders.filter((order) => order !== own).map(ref),
  }
}

const OPEN_QUOTES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] as const
const OPEN_ORDERS = ['CONFIRMED', 'IN_PRODUCTION', 'READY'] as const
const QUOTES_VIEW = 'quotes.view' as Permission
const ORDERS_VIEW = 'orders.view' as Permission
const WORKORDERS_VIEW = 'workorders.view' as Permission

/**
 * What stays on the revision that becomes obsolete (B-W2b-220's drift, as counts): work orders in progress and drafts, open
 * quotes (their current version) and open orders (a line's own revision, else its quote line's). Each kind only when the
 * reader holds its view permission, and only the records it reaches; null otherwise. Nothing on a first release.
 */
async function driftOf(db: Reader, style: BomStyleRow, revision: RevisionRow, actor: Actor | null): Promise<GateDrift | null> {
  const previous = await db.styleRevision.findFirst({ where: { styleId: style.id, status: 'RELEASED', id: { not: revision.id } }, select: { id: true, revision: true } })
  if (!previous) return null
  if (!actor) return { previous: previous.revision, workOrdersInProgress: null, draftWorkOrders: null, openQuotes: null, openOrders: null }

  let workOrdersInProgress: number | null = null
  let draftWorkOrders: number | null = null
  if (holds(actor, WORKORDERS_VIEW)) {
    const rows = await db.workOrder.findMany({ where: { styleRevisionId: previous.id, status: { notIn: ['CLOSED', 'CANCELLED'] } }, select: { status: true, companyId: true, siteId: true } })
    const seen = rows.filter((row) => can(actor, WORKORDERS_VIEW, { companyId: row.companyId, siteId: row.siteId }))
    draftWorkOrders = seen.filter((row) => row.status === 'DRAFT').length
    workOrdersInProgress = seen.length - draftWorkOrders
  }

  let openQuotes: number | null = null
  if (holds(actor, QUOTES_VIEW)) {
    const lines = await db.quoteLine.findMany({ where: { styleId: style.id, styleRevisionId: previous.id }, select: { versionId: true } })
    const versions = lines.length === 0 ? [] : await db.quoteVersion.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.versionId))] } }, select: { quoteId: true, revision: true } })
    const quotes = versions.length === 0 ? [] : await db.quote.findMany({ where: { id: { in: [...new Set(versions.map((version) => version.quoteId))] }, status: { in: [...OPEN_QUOTES] } }, select: { id: true, companyId: true, partyId: true, currentRevision: true } })
    openQuotes = quotes.filter((quote) => versions.some((version) => version.quoteId === quote.id && version.revision === quote.currentRevision) && can(actor, QUOTES_VIEW, { companyId: quote.companyId, partyId: quote.partyId })).length
  }

  let openOrders: number | null = null
  if (holds(actor, ORDERS_VIEW)) {
    const lines = await db.salesOrderLine.findMany({ where: { styleId: style.id }, select: { orderId: true, styleRevisionId: true, quoteLineId: true, quantity: true, closedShortQuantity: true } })
    const quoteLineIds = [...new Set(lines.filter((line) => line.styleRevisionId === null && line.quoteLineId !== null).map((line) => line.quoteLineId!))]
    const quoted = new Map((quoteLineIds.length === 0 ? [] : await db.quoteLine.findMany({ where: { id: { in: quoteLineIds } }, select: { id: true, styleRevisionId: true } })).map((row) => [row.id, row.styleRevisionId]))
    const onPrevious = lines.filter((line) => (line.styleRevisionId ?? (line.quoteLineId ? (quoted.get(line.quoteLineId) ?? null) : null)) === previous.id && !(line.closedShortQuantity !== null && line.closedShortQuantity >= line.quantity))
    const orders = onPrevious.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: [...new Set(onPrevious.map((line) => line.orderId))] }, status: { in: [...OPEN_ORDERS] } }, select: { companyId: true, partyId: true } })
    openOrders = orders.filter((order) => can(actor, ORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId })).length
  }
  return { previous: previous.revision, workOrdersInProgress, draftWorkOrders, openQuotes, openOrders }
}

