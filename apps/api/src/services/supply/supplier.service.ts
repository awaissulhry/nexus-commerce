/**
 * MCP full control 08 S4 — the supplier reads, out of the routes, so the purchasing pages and Claude's supply tools read the same
 * thing. Each function is the body of its route, moved as it was (supply-read.vitest.test.ts holds the routes'
 * answers): the route keeps its status codes and error handling, and returns what the function returns.
 *
 *   listSuppliers  GET /api/fulfillment/suppliers      the suppliers with product and PO counts
 *   readSupplier   GET /api/fulfillment/suppliers/:id  one supplier (null: not found)
 * And the write helpers the supplier routes and Claude's upsert-supplier share (08 S9): the supplier field allow-list
 * (never the auto-PO opt-in), the supplier-product sanitizer, and the primary-supplier wiring.
 */
import prisma from '../../db.js'
import { PO_SECRET_OMIT } from './po-secrets.js'

/** Query of GET /api/fulfillment/suppliers: search, activeOnly. */
export async function listSuppliers(q: Record<string, any>) {
  const where: any = {}
  if (q.search?.trim()) where.name = { contains: q.search.trim(), mode: 'insensitive' }
  if (q.activeOnly === 'true') where.isActive = true
  const items = await prisma.supplier.findMany({
    where,
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true, purchaseOrders: true } } },
  })
  return { items, total: items.length }
}

export async function readSupplier(id: string) {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: {
      products: { include: { } as any },
      purchaseOrders: { take: 20, orderBy: { createdAt: 'desc' }, omit: PO_SECRET_OMIT },
      contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }, // PD.2
    },
  })
  if (!supplier) return null
  return supplier
}

// ── 08 S9 — the write helpers, moved out of routes/fulfillment.routes.ts as they were ────────────────────

// PD.2 — the supplier fields a person edits, parsed one way for create and edit. Never the auto-PO opt-in
// (`autoTrigger*`, section 06), never the nightly lead-time statistics.
export function supplierFields(body: Record<string, any>): Record<string, any> {
  const ALLOWED = [
    'name', 'contactName', 'email', 'phone', 'addressLine1', 'city',
    'postalCode', 'country', 'taxId', 'paymentTerms', 'defaultCurrency',
    'leadTimeDays', 'isActive', 'notes',
    // S2 — supplier-level production/shipping defaults (nullable ints).
    'productionTimeDays', 'productionUnitsPerDay', 'shippingTimeDays',
  ] as const
  const NULLABLE_INTS = new Set(['productionTimeDays', 'productionUnitsPerDay', 'shippingTimeDays'])
  const data: Record<string, any> = {}
  for (const k of ALLOWED) {
    if (!(k in body)) continue
    if (NULLABLE_INTS.has(k)) {
      data[k] = body[k] === null || body[k] === '' ? null : Math.max(0, Math.round(Number(body[k])) || 0)
    } else {
      data[k] = k === 'leadTimeDays'
        ? Math.max(0, Number(body[k]) || 0)
        : k === 'isActive'
          ? !!body[k]
          : (body[k] === '' ? null : body[k])
    }
  }
  return data
}

// Whitelist + validate a SupplierProduct payload. Accepts cost as either
// costCents (int) or costEur (human-friendly decimal). Returns the
// sanitized partial or an { error } string.
export function sanitizeSupplierProductInput(
  body: any,
): { data: Record<string, any> } | { error: string } {
  const data: Record<string, any> = {}
  if (body.supplierSku !== undefined)
    data.supplierSku = body.supplierSku ? String(body.supplierSku).trim() : null
  if (body.costEur !== undefined && body.costEur !== null && body.costEur !== '') {
    const eur = Number(body.costEur)
    if (!Number.isFinite(eur) || eur < 0) return { error: 'costEur must be a non-negative number' }
    data.costCents = Math.round(eur * 100)
  } else if (body.costCents !== undefined) {
    if (body.costCents === null) data.costCents = null
    else {
      const c = Number(body.costCents)
      if (!Number.isInteger(c) || c < 0) return { error: 'costCents must be a non-negative integer' }
      data.costCents = c
    }
  }
  if (body.currencyCode !== undefined) {
    const cc = String(body.currencyCode || 'EUR').trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(cc)) return { error: 'currencyCode must be a 3-letter ISO code' }
    data.currencyCode = cc
  }
  if (body.moq !== undefined) {
    const m = Number(body.moq)
    if (!Number.isInteger(m) || m < 1) return { error: 'moq must be an integer >= 1' }
    data.moq = m
  }
  if (body.casePack !== undefined) {
    if (body.casePack === null || body.casePack === '') data.casePack = null
    else {
      const cp = Number(body.casePack)
      if (!Number.isInteger(cp) || cp < 1) return { error: 'casePack must be an integer >= 1' }
      data.casePack = cp
    }
  }
  if (body.leadTimeDaysOverride !== undefined) {
    if (body.leadTimeDaysOverride === null || body.leadTimeDaysOverride === '')
      data.leadTimeDaysOverride = null
    else {
      const lt = Number(body.leadTimeDaysOverride)
      if (!Number.isInteger(lt) || lt < 0) return { error: 'leadTimeDaysOverride must be an integer >= 0' }
      data.leadTimeDaysOverride = lt
    }
  }
  if (body.isPrimary !== undefined) data.isPrimary = !!body.isPrimary
  // PD.1 — factory-facing naming (per-supplier default).
  for (const k of ['factoryName', 'factorySize', 'factorySpec'] as const) {
    if (body[k] !== undefined) data[k] = body[k] ? String(body[k]).trim() : null
  }
  // S2 — per-product production + shipping time overrides (nullable ints >= 0).
  for (const k of [
    'productionTimeDaysOverride',
    'productionUnitsPerDayOverride',
    'shippingTimeDaysOverride',
  ] as const) {
    if (body[k] === undefined) continue
    if (body[k] === null || body[k] === '') {
      data[k] = null
    } else {
      const n = Number(body[k])
      if (!Number.isInteger(n) || n < 0) return { error: `${k} must be an integer >= 0` }
      data[k] = n
    }
  }
  return { data }
}

// When a supplier becomes a product's primary: clear other primaries for
// that product and point the ReplenishmentRule.preferredSupplierId at it
// so the cost flows into the replenishment math. Runs inside the caller's
// transaction client.
export async function wirePrimarySupplier(
  tx: any,
  productId: string,
  supplierId: string,
): Promise<void> {
  await tx.supplierProduct.updateMany({
    where: { productId, supplierId: { not: supplierId }, isPrimary: true },
    data: { isPrimary: false },
  })
  await tx.replenishmentRule.upsert({
    where: { productId },
    create: { productId, preferredSupplierId: supplierId },
    update: { preferredSupplierId: supplierId },
  })
}
