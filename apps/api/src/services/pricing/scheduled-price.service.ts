/**
 * MCP full control 08 S5 — the scheduled change reads, out of the routes, so the pricing pages and Claude's pricing tools read the same
 * thing. Each function is the body of its route, moved as it was (pricing-read.vitest.test.ts holds the routes'
 * answers): the route keeps its error handling and returns what the function returns.
 *
 *   listScheduledChanges   GET /api/products/:id/scheduled-changes
 *   createScheduledChange  POST /api/products/:id/scheduled-changes      (08 S12)
 *   cancelScheduledChange  POST /api/products/scheduled-changes/:id/cancel — one step: PENDING → CANCELLED or a refusal
 *   resolveUnknownChange   POST /api/products/scheduled-changes/:id/resolve — a change whose run died (UNKNOWN): applied or retry
 * A refusal is a ScheduledChangeError carrying the status and the sentence the route answers with.
 */
import prisma from '../../db.js'

/** GET /api/products/:id/scheduled-changes — a product's scheduled changes (price and status), soonest first, 100 at most. */
export async function listScheduledChanges(productId: string) {
  return prisma.scheduledProductChange.findMany({
    where: { productId },
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  })
}

// ── 08 S12 — the writes ─────────────────────────────────────────────────────────────────────────────────

export class ScheduledChangeError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'ScheduledChangeError'
  }
}

/** A product change for later: a STATUS (ACTIVE, DRAFT, INACTIVE) or a master PRICE (basePrice or adjustPercent). */
export async function createScheduledChange(productId: string, body: { kind?: string; payload?: Record<string, unknown>; scheduledFor?: string }, createdBy: string | null) {
  const kind = body.kind
  const payload = body.payload
  const scheduledForRaw = body.scheduledFor

  if (kind !== 'STATUS' && kind !== 'PRICE') throw new ScheduledChangeError(400, 'kind must be STATUS or PRICE')
  if (!payload || typeof payload !== 'object') throw new ScheduledChangeError(400, 'payload (object) required')
  if (!scheduledForRaw) throw new ScheduledChangeError(400, 'scheduledFor (ISO timestamp) required')
  const scheduledFor = new Date(scheduledForRaw)
  if (Number.isNaN(scheduledFor.getTime())) throw new ScheduledChangeError(400, `scheduledFor not a valid date: ${scheduledForRaw}`)
  if (scheduledFor.getTime() <= Date.now()) {
    throw new ScheduledChangeError(400, 'scheduledFor must be in the future (use the live PATCH endpoint to apply now)')
  }

  // Validate payload shape per kind so we surface garbage at submit
  // time instead of cron-time.
  if (kind === 'STATUS') {
    const status = (payload as any).status
    if (!['ACTIVE', 'DRAFT', 'INACTIVE'].includes(status)) {
      throw new ScheduledChangeError(400, 'STATUS payload.status must be ACTIVE | DRAFT | INACTIVE')
    }
  } else if (kind === 'PRICE') {
    const { basePrice, adjustPercent } = payload as any
    const hasAbsolute =
      typeof basePrice === 'number' &&
      Number.isFinite(basePrice) &&
      basePrice >= 0
    const hasRelative =
      typeof adjustPercent === 'number' && Number.isFinite(adjustPercent)
    if (!hasAbsolute && !hasRelative) {
      throw new ScheduledChangeError(400, 'PRICE payload requires basePrice (number >= 0) or adjustPercent (number)')
    }
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, deletedAt: true },
  })
  if (!product || product.deletedAt) throw new ScheduledChangeError(404, 'product not found or soft-deleted')

  return prisma.scheduledProductChange.create({
    data: {
      productId,
      kind,
      payload: payload as any,
      scheduledFor,
      createdBy,
    },
  })
}

/**
 * Cancel a PENDING change in one step (PENDING → CANCELLED, compare-and-set). The scheduled-changes job claims a row
 * the same way before it runs it (PENDING → APPLYING), so exactly one of them wins: a change that is cancelled never
 * runs, and a change that is running is not reported as cancelled.
 */
export async function cancelScheduledChange(id: string) {
  const claimed = await prisma.scheduledProductChange.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED' } })
  const row = await prisma.scheduledProductChange.findUnique({ where: { id } })
  if (!row) throw new ScheduledChangeError(404, 'not found')
  if (claimed.count === 0) throw new ScheduledChangeError(409, `cannot cancel — current status is ${row.status}`)
  return row
}

/**
 * A change whose run died while applying it (UNKNOWN, marked by the scheduled-changes sweep): a person says what
 * happened after checking the price. `applied` closes it; `retry` puts it back to PENDING, and the next sweep runs it.
 * One compare-and-set step from UNKNOWN, so two answers cannot both land.
 */
export async function resolveUnknownChange(id: string, outcome: string, actor: string | null) {
  if (outcome !== 'applied' && outcome !== 'retry') throw new ScheduledChangeError(400, 'outcome must be applied or retry')
  const data = outcome === 'applied'
    ? { status: 'APPLIED', appliedAt: new Date(), error: `Outcome was unknown; marked applied by ${actor ?? 'a person'} after a check.` }
    : { status: 'PENDING', error: null }
  const claimed = await prisma.scheduledProductChange.updateMany({ where: { id, status: 'UNKNOWN' }, data })
  const row = await prisma.scheduledProductChange.findUnique({ where: { id } })
  if (!row) throw new ScheduledChangeError(404, 'not found')
  if (claimed.count === 0) throw new ScheduledChangeError(409, `nothing to resolve — current status is ${row.status}`)
  return row
}

