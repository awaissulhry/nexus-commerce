/**
 * Reviews › Requests › Package inserts — compliant Amazon in-box review cards (PDF), for the business the request runs
 * in. The card's name is THIS business's own name (business-identity.service.ts, as its e-mails carry it), never one
 * name for the whole deployment: business profiles share it, and a card with another business's name would go into the
 * box. A business with no identity for buyers is refused in words (nothing is printed).
 *
 *   GET  /api/review-inserts/count          how many products would print
 *   GET  /api/review-inserts/products       the families to pick from, each with its ASIN and the cards it prints
 *   GET  /api/review-inserts/product/:id    one card (inline preview)
 *   POST /api/review-inserts/bulk           one card per product (download)
 *
 * A family prints one card per product of it with an ASIN — the family itself and each variation — the same cards
 * "Every product with an ASIN" prints for it, so the rows add up to that total (live audit A05: the picker read the
 * catalogue list, whose rows never carry an ASIN, and showed "no ASIN — no card" for every family).
 *
 * The routes (routes/review-inserts.routes.ts) hold no database call.
 */
import prisma from '../../db.js'
import { resolveBusinessIdentity } from '../business-identity.service.js'
import { buildReviewInsertPdf } from './review-insert-pdf.service.js'

const INSERTS_BULK_CAP = 500

/** A refusal in words, with the status the route answers. */
export class InsertsRefusal extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

/** The market a card is printed for ("IT" when none is given). */
export function insertMarket(value: unknown): string {
  const code = String(value ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) ? code : 'IT'
}

/** The name the cards carry: this business's own. */
async function cardBrand(): Promise<string> {
  const found = await resolveBusinessIdentity()
  if (found.ok === false) throw new InsertsRefusal(409, found.reason)
  return found.identity.brandName
}

export async function insertsCount(): Promise<{ count: number; cap: number }> {
  const count = await prisma.product.count({ where: { amazonAsin: { not: null }, deletedAt: null } })
  return { count, cap: INSERTS_BULK_CAP }
}

export interface InsertFamily {
  id: string
  name: string
  sku: string
  /** The family's own ASIN, else its first variation's (the one its preview card shows); null when none has one. */
  asin: string | null
  /** Variations under it; 0 for a single product. */
  childCount: number
  /** Cards it prints: itself and each variation with an ASIN. */
  cards: number
}

const FAMILIES_PAGE = 200

/** The cards of one family (pure): its own ASIN and each variation's. */
export function familyCards(row: { amazonAsin: string | null; children: ReadonlyArray<{ amazonAsin: string | null }> }): { asin: string | null; cards: number } {
  const own = row.amazonAsin?.trim() || null
  const kids = row.children.map((c) => c.amazonAsin?.trim() || null).filter((a): a is string => !!a)
  return { asin: own ?? kids[0] ?? null, cards: (own ? 1 : 0) + kids.length }
}

/** GET /api/review-inserts/products — the families (top-level products), A–Z, searched by name or SKU. */
export async function insertFamilies(query: { search?: unknown; limit?: unknown } = {}): Promise<{ products: InsertFamily[]; total: number }> {
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : ''
  const limit = Math.min(Math.max(Number(query.limit) || FAMILIES_PAGE, 1), FAMILIES_PAGE)
  const where = {
    parentId: null,
    deletedAt: null,
    ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { sku: { contains: search, mode: 'insensitive' as const } }] } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: { id: true, name: true, sku: true, amazonAsin: true, children: { where: { deletedAt: null }, select: { amazonAsin: true } } },
      orderBy: { name: 'asc' },
      take: limit,
    }),
    prisma.product.count({ where }),
  ])
  return {
    products: rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku, childCount: r.children.length, ...familyCards(r) })),
    total,
  }
}

export async function oneInsertPdf(productId: string, marketRaw: unknown): Promise<Buffer> {
  const marketplace = insertMarket(marketRaw)
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { name: true, amazonAsin: true } })
  if (!product) throw new InsertsRefusal(404, 'Product not found')
  if (!product.amazonAsin) throw new InsertsRefusal(422, 'This product has no Amazon ASIN, so its card has no review link')
  return buildReviewInsertPdf({ brand: await cardBrand(), marketplace, products: [{ name: product.name, asin: product.amazonAsin, marketplace }] })
}

export async function bulkInsertsPdf(body: { marketplace?: unknown; productIds?: unknown }): Promise<{ pdf: Buffer; marketplace: string }> {
  const marketplace = insertMarket(body.marketplace)
  const ids = Array.isArray(body.productIds) ? body.productIds.filter((v): v is string => typeof v === 'string' && !!v.trim()) : []
  const brand = await cardBrand()
  // A picked family prints its own card and each variation's, as "every product" does for it.
  const picked = ids.slice(0, INSERTS_BULK_CAP)
  const products = await prisma.product.findMany({
    where: { amazonAsin: { not: null }, deletedAt: null, ...(picked.length ? { OR: [{ id: { in: picked } }, { parentId: { in: picked } }] } : {}) },
    select: { name: true, amazonAsin: true },
    orderBy: { name: 'asc' },
    take: INSERTS_BULK_CAP,
  })
  const pdf = await buildReviewInsertPdf({ brand, marketplace, products: products.map((p) => ({ name: p.name, asin: p.amazonAsin as string, marketplace })) })
  return { pdf, marketplace }
}
