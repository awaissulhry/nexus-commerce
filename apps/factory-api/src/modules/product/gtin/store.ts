import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ALLOCATION_REFUSAL_WORDS, allocationRefusal, gtinOf, rangeLeft, rangeUsed } from '@nexus/factory-domain/product/gtin/rules'
import type { RangeView } from '@nexus/factory-domain/product/gtin/contracts'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { readFactoryVariables } from '../../../env'
import { contextOf } from '../styles/store'

/**
 * GTINs in depth, the shared parts (B-W2b-227; PRD-006): the range rows and their view, the cells of a style whose garments
 * have shipped (their GTIN never changes: B-W2b-206's Variant_gtin_guard, said here in words first), the GATE-SPEND check
 * of this environment, and the database's GTIN refusals turned into words when a write reaches them anyway.
 */

type Reader = FactoryClient | CommandTx

export const RANGE_COLUMNS = {
  id: true,
  companyId: true,
  name: true,
  gs1Prefix: true,
  firstReference: true,
  lastReference: true,
  nextReference: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.GtinRangeSelect
export type RangeRow = Prisma.GtinRangeGetPayload<{ select: typeof RANGE_COLUMNS }>

export function rangeViewOf(row: RangeRow): RangeView {
  const left = rangeLeft(row)
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    gs1Prefix: row.gs1Prefix,
    firstReference: row.firstReference,
    lastReference: row.lastReference,
    nextReference: row.nextReference,
    left,
    used: rangeUsed(row),
    nextGtin: left > 0 && /^[0-9]{4,12}$/.test(row.gs1Prefix) ? gtinOf(row.gs1Prefix, row.nextReference) : null,
    status: row.status,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** A range the caller may see (product.styles.view over its company); else not found. */
export async function readRange(caller: CommandCaller, rangeId: string): Promise<RangeRow> {
  const context = contextOf(caller)
  if (!isUuid(rangeId)) throw new NotFoundError('GTIN range not found.')
  const row = await caller.withClient((client) => client.gtinRange.findUnique({ where: { id: rangeId }, select: RANGE_COLUMNS }))
  if (!row || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('GTIN range not found.')
  return row
}

/** The cells (`colourwayId|size`) of a style whose garments have shipped: their SKU's GTIN stays (the database's own rule). */
export async function shippedCells(db: Reader, styleId: string): Promise<Set<string>> {
  const lines = await db.shipmentLine.findMany({ where: { workOrderSize: { styleId }, shipment: { shippedAt: { not: null } } }, select: { workOrderSizeId: true }, distinct: ['workOrderSizeId'] })
  if (lines.length === 0) return new Set()
  const sizes = await db.workOrderSize.findMany({ where: { id: { in: lines.map((line) => line.workOrderSizeId) } }, select: { colourwayId: true, size: true } })
  return new Set(sizes.map((row) => `${row.colourwayId}|${row.size}`))
}

/** The words of a shipped SKU whose GTIN would change. */
export const shippedGtinWords = (sku: string, gtin: string): string => `SKU ${sku} keeps its GTIN ${gtin}: garments with it have shipped, and a GTIN is never given to anything else.`

let environment: string | undefined

/** This process's environment (FACTORY_ENV; unknown: production, the strictest). */
function environmentNow(): string {
  if (environment === undefined) {
    try {
      environment = readFactoryVariables().FACTORY_ENV ?? 'production'
    } catch {
      environment = 'production'
    }
  }
  return environment
}

/** Whether GTINs may be given from a range here now (GATE-SPEND: the Owner's word; local and test runs: made-up ranges). */
export function allocationGate(): { open: boolean; refusal: 'GATE_SPEND' | null; message: string | null } {
  const refusal = allocationRefusal(environmentNow())
  return { open: refusal === null, refusal, message: refusal === null ? null : ALLOCATION_REFUSAL_WORDS[refusal] }
}

/**
 * The database's GTIN and range refusals (Variant_gtin_guard, GtinRange_guard: 'product: …' check violations) in words
 * when a write reached them without the command's own check: a 409, never a 500.
 */
export async function gtinGuarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('product: ')) {
      const words = cause.originalMessage.slice('product: '.length)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
    }
    throw error
  }
}
