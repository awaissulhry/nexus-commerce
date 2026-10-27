/**
 * Reviews › Requests › Package inserts — compliant Amazon in-box review cards (PDF), for the business the request runs
 * in. The card's name is THIS business's own name (business-identity.service.ts, as its e-mails carry it), never one
 * name for the whole deployment: business profiles share it, and a card with another business's name would go into the
 * box. A business with no identity for buyers is refused in words (nothing is printed).
 *
 *   GET  /api/review-inserts/count          how many products would print
 *   GET  /api/review-inserts/product/:id    one card (inline preview)
 *   POST /api/review-inserts/bulk           one card per product (download)
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
  const products = await prisma.product.findMany({
    where: { amazonAsin: { not: null }, deletedAt: null, ...(ids.length ? { id: { in: ids.slice(0, INSERTS_BULK_CAP) } } : {}) },
    select: { name: true, amazonAsin: true },
    orderBy: { name: 'asc' },
    take: INSERTS_BULK_CAP,
  })
  const pdf = await buildReviewInsertPdf({ brand, marketplace, products: products.map((p) => ({ name: p.name, asin: p.amazonAsin as string, marketplace })) })
  return { pdf, marketplace }
}
