/**
 * Reviews Insights › Fit by size — the reads behind the pure review-fit.ts, for the Themes fit table
 * (`GET /api/reviews/insights/themes` → `fit`) and the product pop-up (`GET /api/reviews/insights/products/:id` → `fit`).
 *
 * In the scope (channel, market) and the period:
 *   reviews  visible rows (fixtures never count) on a product, read by the AI with the fit theme or not read yet; a
 *            review on the family itself (no size) takes the size of its order's line in that family when the order
 *            has exactly one such size, else it names no size;
 *   returns  return lines on a product with a reason, not rejected; the reason (and, for "does not fit", the buyer's
 *            comment) gives the way.
 * Sizes come from each variant's own size axis. Nothing here writes. The same reads feed the size-guide fixes
 * (`fitFindingsFor`, review-size-guide.service.ts): every family, not only the table's first FIT_FAMILY_LIMIT.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { visibleReviewWhere } from './review-visibility.js'
import { variantWords } from './review-inbox-query.js'
import type { InsightScope } from './review-insights-math.js'
import {
  buildFitTable, buildProductFit, fitDirectionOfReview, fitFindings, returnFitDirection, sizeKey, sizeOfVariant,
  type FitFamilyInfo, type FitFinding, type FitSignal, type FitTable, type ProductFit,
} from './review-fit.js'

type FitProductRow = { id: string; sku: string; name: string; parentId: string | null; variantAttributes: unknown; categoryAttributes: unknown }

const PRODUCT_SELECT = { id: true, sku: true, name: true, parentId: true, variantAttributes: true, categoryAttributes: true } as const

/** A family with the sizes it sells: its variants' sizes (a product on its own: its own size, if it has one). */
function familyInfo(head: FitProductRow, members: readonly FitProductRow[]): FitFamilyInfo {
  const all = members.length ? members : [head]
  // The label reads the same store as the size: `categoryAttributes.variations` first, then `variantAttributes`.
  const variations = (p: FitProductRow) => (p.categoryAttributes as { variations?: unknown } | null)?.variations
  const variants = all.map((p) => ({ id: p.id, label: variantWords(variations(p)) ?? variantWords(p.variantAttributes) ?? sizeOfVariant(p) ?? p.sku, size: sizeOfVariant(p) }))
  const sizes = [...new Map(variants.filter((v) => v.size).map((v) => [sizeKey(v.size!), v.size!])).values()]
  return { id: head.id, name: head.name, sku: head.sku, sizes, variants }
}

interface Gathered {
  signals: FitSignal[]
  unclear: Map<string, number>
  families: Map<string, FitFamilyInfo>
}

/** The family a product belongs to: its parent when the parent is known, else itself. */
const familyOf = (p: FitProductRow, products: ReadonlyMap<string, FitProductRow>) => (p.parentId && products.has(p.parentId) ? p.parentId : p.id)

async function gatherFit(input: { scope: InsightScope; from: Date; now: Date; productIds?: readonly string[] }): Promise<Gathered> {
  const { scope, from, now } = input
  const only = input.productIds ? [...new Set(input.productIds)] : null
  const productWhere = only ? { in: only } : { not: null }
  const scoped: Prisma.ReviewWhereInput = {
    ...(scope.channel ? { channel: scope.channel } : {}),
    ...(scope.market ? { marketplace: scope.market } : {}),
  }
  const [reviews, returnItems] = await Promise.all([
    prisma.review.findMany({
      where: visibleReviewWhere({
        ...scoped,
        productId: productWhere,
        postedAt: { gte: from, lte: now },
        // The AI read it with the fit theme, or it has not been read yet (the phrases alone decide).
        OR: [{ sentiment: { is: null } }, { sentiment: { categories: { has: 'FIT_SIZING' } } }],
      }),
      select: { id: true, productId: true, orderId: true, title: true, body: true, bodyEnglish: true, sentiment: { select: { categories: true } } },
    }),
    prisma.returnItem.findMany({
      where: {
        productId: productWhere,
        return: {
          createdAt: { gte: from, lte: now },
          reason: { not: null },
          status: { not: 'REJECTED' },
          ...(scope.channel ? { channel: scope.channel } : {}),
          ...(scope.market ? { marketplace: scope.market } : {}),
        },
      },
      select: { productId: true, returnId: true, return: { select: { reason: true, notes: true } } },
    }),
  ])

  const reviewSignals = reviews
    .map((r) => ({ r, direction: fitDirectionOfReview({ title: r.title, body: r.body, bodyEnglish: r.bodyEnglish, categories: r.sentiment?.categories ?? null }) }))
    .filter((x): x is { r: (typeof reviews)[number]; direction: NonNullable<typeof x.direction> } => x.direction != null)
  const returnSignals: Array<{ productId: string; returnId: string; direction: 'small' | 'large' | 'unclear' }> = []
  const seenReturn = new Set<string>()
  for (const item of returnItems) {
    if (!item.productId) continue
    const key = `${item.returnId}|${item.productId}`
    if (seenReturn.has(key)) continue
    const direction = returnFitDirection(item.return.reason, item.return.notes)
    if (!direction) continue
    seenReturn.add(key)
    returnSignals.push({ productId: item.productId, returnId: item.returnId, direction })
  }

  // Products, their families, and every variant of those families (the sizes a family sells).
  const ids = new Set<string>([...reviewSignals.map((x) => x.r.productId!), ...returnSignals.map((x) => x.productId)])
  const products = new Map<string, FitProductRow>()
  const load = async (wanted: string[]) => {
    const missing = wanted.filter((id) => !products.has(id))
    if (!missing.length) return
    const rows = await prisma.product.findMany({ where: { id: { in: missing }, deletedAt: null }, select: PRODUCT_SELECT })
    for (const p of rows) products.set(p.id, p)
  }
  await load([...ids])
  await load([...new Set([...products.values()].map((p) => p.parentId).filter((id): id is string => !!id))])
  const familyIds = new Set([...ids].filter((id) => products.has(id)).map((id) => familyOf(products.get(id)!, products)))
  const children = familyIds.size
    ? await prisma.product.findMany({ where: { parentId: { in: [...familyIds] }, deletedAt: null }, select: PRODUCT_SELECT })
    : []
  for (const c of children) products.set(c.id, c)

  // A review on a product with no size: the size of its order's line in the same family, when there is exactly one.
  const sizeless = reviewSignals.filter((x) => {
    const p = products.get(x.r.productId!)
    return p && x.r.orderId && !sizeOfVariant(p)
  })
  const orderSize = new Map<string, { productId: string; size: string }>()
  if (sizeless.length) {
    const lines = await prisma.orderItem.findMany({
      where: { orderId: { in: [...new Set(sizeless.map((x) => x.r.orderId!))] }, productId: { not: null } },
      select: { orderId: true, productId: true },
    })
    await load([...new Set(lines.map((l) => l.productId!))])
    for (const x of sizeless) {
      const family = familyOf(products.get(x.r.productId!)!, products)
      const sized = lines
        .filter((l) => l.orderId === x.r.orderId)
        .map((l) => products.get(l.productId!))
        .filter((p): p is FitProductRow => !!p && familyOf(p, products) === family && !!sizeOfVariant(p))
      const sizes = new Set(sized.map((p) => sizeKey(sizeOfVariant(p)!)))
      if (sizes.size === 1) orderSize.set(x.r.id, { productId: sized[0].id, size: sizeOfVariant(sized[0])! })
    }
  }

  const signals: FitSignal[] = []
  const unclear = new Map<string, number>()
  for (const x of reviewSignals) {
    const p = products.get(x.r.productId!)
    if (!p) continue
    const fromOrder = orderSize.get(x.r.id)
    signals.push({ familyId: familyOf(p, products), productId: fromOrder?.productId ?? p.id, size: fromOrder?.size ?? sizeOfVariant(p), direction: x.direction, source: 'review' })
  }
  for (const x of returnSignals) {
    const p = products.get(x.productId)
    if (!p) continue
    const familyId = familyOf(p, products)
    if (x.direction === 'unclear') unclear.set(familyId, (unclear.get(familyId) ?? 0) + 1)
    else signals.push({ familyId, productId: p.id, size: sizeOfVariant(p), direction: x.direction, source: 'return' })
  }

  const families = new Map<string, FitFamilyInfo>()
  for (const id of new Set([...signals.map((s) => s.familyId), ...unclear.keys()])) {
    const head = products.get(id)
    if (head) families.set(id, familyInfo(head, [...products.values()].filter((p) => p.parentId === id)))
  }
  return { signals, unclear, families }
}

/** The Themes fit table for the scope and period. */
export async function fitTable(input: { scope: InsightScope; from: Date; now: Date }): Promise<FitTable> {
  const g = await gatherFit(input)
  const unclearReturns = [...g.unclear.values()].reduce((n, v) => n + v, 0)
  return buildFitTable({ signals: g.signals, families: g.families, unclearReturns })
}

/** Every family whose sizes run small or large in the scope and period (the size-guide fixes), by the same rule. */
export async function fitFindingsFor(input: { scope: InsightScope; from: Date; now: Date }): Promise<FitFinding[]> {
  const g = await gatherFit(input)
  return fitFindings({ signals: g.signals, families: g.families })
}

/**
 * One product's family fit for the pop-up: per size and per variant. The family is the product's parent (a variant),
 * or the product itself (a family, or a product on its own).
 */
export async function productFit(input: { familyId: string; familyIds: readonly string[]; scope: InsightScope; from: Date; now: Date }): Promise<ProductFit | null> {
  const g = await gatherFit({ scope: input.scope, from: input.from, now: input.now, productIds: input.familyIds })
  let family = g.families.get(input.familyId)
  if (!family) {
    // No signal at all: still list the sizes the family sells, each "too few".
    const rows = await prisma.product.findMany({ where: { OR: [{ id: input.familyId }, { parentId: input.familyId }], deletedAt: null }, select: PRODUCT_SELECT })
    const head = rows.find((p) => p.id === input.familyId)
    if (!head) return null
    family = familyInfo(head, rows.filter((p) => p.parentId === input.familyId))
  }
  return buildProductFit({ signals: g.signals, family, unclearReturns: g.unclear.get(input.familyId) ?? 0 })
}
