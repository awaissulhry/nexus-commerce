/**
 * Step 3 (cases, Owner D2 = B; several case sizes per SKU, Owner 2026-10-08) — `PUT /api/stock/case-packs`: a SKU's case
 * sizes (units per case, case size and weight) and who preps and labels for FBA, for 1..200 SKUs at once. The Matrix Case
 * pop-up saves through it; a family's pop-up sends every variation's id in one call.
 *
 *   Body   { productIds: string[] (1..200), sizes?: [{ unitsPerCase, caseLengthCm, caseWidthCm, caseHeightCm,
 *            caseWeightKg }], fbaPrepOwner?, fbaLabelOwner?, openSealedCases?: boolean }
 *          `sizes` absent = each SKU keeps its sizes; present = each SKU's list becomes exactly this list, matched by
 *          units per case (the same units keep their sealed counts; a size left out is removed). In a size every value
 *          must be named: a number or null to clear it (units per case is required). An owner absent = keep; null =
 *          clear; 'AMAZON' | 'SELLER'. At least one of sizes / fbaPrepOwner / fbaLabelOwner.
 *   200    { ok, results: [{ productId, ok, noop?, opened?: [{ locationCode, unitsPerCase, cases }], error? }],
 *            warning: string | null }  (warning = Amazon EU box limit)
 *   400    { ok: false, code: 'MISSING_FIELDS' | 'TOO_MANY' | 'INVALID_PACK' | <CaseCountError code>, error }
 *   409    { ok: false, code: 'SEALED_CASES', error, sealed: [{ productId, sku, locationCode, unitsPerCase, cases }] } — a
 *          size with sealed cases in stock is removed; the same call with `openSealedCases: true` opens them (units
 *          unchanged).
 *
 * Permission: `/api/stock` writes → `inventory.adjust` (permissions-manifest.ts). Absolute values, so a double-click is
 * harmless (no COMMAND_SCOPES entry). The route parses and maps; `setCasePacks` (stock/stock-cases.service.ts) locks,
 * writes, audits and publishes `inventory.cases_changed`. Zero database calls here (check-route-prisma-ratchet).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { amazonBoxWarning, isCaseOwner, ownersProblem, sizesProblem, type CaseOwner, type CaseSizeValues } from '@nexus/shared/stock-cases'
import { CaseCountError, setCasePacks } from '../services/stock/stock-cases.service.js'

/** The most SKUs one save may name (a family's every size, with room). */
export const MAX_CASE_PACK_PRODUCTS = 200

const SIZE_KEYS = ['unitsPerCase', 'caseLengthCm', 'caseWidthCm', 'caseHeightCm', 'caseWeightKg'] as const

type Parsed =
  | { ok: true; productIds: string[]; sizes?: CaseSizeValues[]; fbaPrepOwner?: CaseOwner | null; fbaLabelOwner?: CaseOwner | null; openSealedCases: boolean }
  | { ok: false; code: string; error: string }

/** A size or count as sent: a number, a numeric string, or null (clears). Anything else reads NaN, which `sizesProblem` refuses. */
function numberOf(raw: unknown): number | null {
  if (raw === null) return null
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim())
  return Number.NaN
}

/** Parse and check the body. Pure: the same refusals the pop-up shows (`sizesProblem`, `ownersProblem`). */
export function parseCasePackBody(body: unknown): Parsed {
  const b = (body ?? {}) as Record<string, unknown>
  const ids = b.productIds
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
    return { ok: false, code: 'MISSING_FIELDS', error: '`productIds` must be a list of 1 or more product ids' }
  }
  const productIds = [...new Set((ids as string[]).map((id) => id.trim()))]
  if (productIds.length > MAX_CASE_PACK_PRODUCTS) {
    return { ok: false, code: 'TOO_MANY', error: `At most ${MAX_CASE_PACK_PRODUCTS} products per save` }
  }
  const named = (key: string) => key in b && b[key] !== undefined
  if (!named('sizes') && !named('fbaPrepOwner') && !named('fbaLabelOwner')) {
    return { ok: false, code: 'MISSING_FIELDS', error: 'Name the case sizes or an owner to save' }
  }
  let sizes: CaseSizeValues[] | undefined
  if (named('sizes')) {
    if (!Array.isArray(b.sizes)) return { ok: false, code: 'INVALID_PACK', error: '`sizes` must be a list' }
    sizes = []
    for (const raw of b.sizes as unknown[]) {
      const r = (raw ?? {}) as Record<string, unknown>
      const missing = SIZE_KEYS.filter((key) => !(key in r) || r[key] === undefined)
      if (missing.length > 0) {
        return { ok: false, code: 'MISSING_FIELDS', error: `Name every value of a case size (null clears it); missing: ${missing.join(', ')}` }
      }
      const unitsPerCase = numberOf(r.unitsPerCase)
      sizes.push({
        unitsPerCase: unitsPerCase === null ? Number.NaN : unitsPerCase,
        caseLengthCm: numberOf(r.caseLengthCm),
        caseWidthCm: numberOf(r.caseWidthCm),
        caseHeightCm: numberOf(r.caseHeightCm),
        caseWeightKg: numberOf(r.caseWeightKg),
      })
    }
  }
  const owner = (key: 'fbaPrepOwner' | 'fbaLabelOwner'): { value?: CaseOwner | null } | null => {
    if (!named(key)) return {}
    const raw = b[key]
    if (raw === null) return { value: null }
    return isCaseOwner(raw) ? { value: raw } : null
  }
  const prep = owner('fbaPrepOwner')
  const label = owner('fbaLabelOwner')
  const problem = (sizes ? sizesProblem(sizes) : null)
    ?? (prep === null ? ownersProblem({ fbaPrepOwner: b.fbaPrepOwner as CaseOwner }) : null)
    ?? (label === null ? ownersProblem({ fbaLabelOwner: b.fbaLabelOwner as CaseOwner }) : null)
  if (problem) return { ok: false, code: 'INVALID_PACK', error: problem }
  return {
    ok: true,
    productIds,
    ...(sizes ? { sizes } : {}),
    ...(prep && 'value' in prep ? { fbaPrepOwner: prep.value } : {}),
    ...(label && 'value' in label ? { fbaLabelOwner: label.value } : {}),
    openSealedCases: b.openSealedCases === true,
  }
}

/** The Amazon EU box limit, as one warning, for the first size over it. */
function boxWarning(sizes: readonly CaseSizeValues[] | undefined): string | null {
  for (const size of sizes ?? []) {
    const warning = amazonBoxWarning(size)
    if (warning) return warning
  }
  return null
}

/** Who saved it: the signed-in person's e-mail (or id), as the Matrix doors name the actor. */
function actorOf(req: FastifyRequest): string {
  return req.authUser?.email ?? req.authUser?.id ?? 'matrix-case-pack'
}

export default async function stockCasesRoutes(app: FastifyInstance) {
  app.put('/stock/case-packs', async (request, reply) => {
    const parsed = parseCasePackBody(request.body)
    if (!parsed.ok) return reply.code(400).send(parsed)
    try {
      const results = await setCasePacks({
        productIds: parsed.productIds,
        ...(parsed.sizes ? { sizes: parsed.sizes } : {}),
        ...('fbaPrepOwner' in parsed ? { fbaPrepOwner: parsed.fbaPrepOwner } : {}),
        ...('fbaLabelOwner' in parsed ? { fbaLabelOwner: parsed.fbaLabelOwner } : {}),
        openSealedCases: parsed.openSealedCases,
        actor: actorOf(request),
        userId: request.authUser?.id ?? null,
      })
      return { ok: results.every((r) => r.ok), results, warning: boxWarning(parsed.sizes) }
    } catch (error) {
      if (error instanceof CaseCountError) {
        if (error.code === 'SEALED_CASES') {
          return reply.code(409).send({ ok: false, code: error.code, error: error.message, sealed: Array.isArray(error.detail) ? error.detail : [] })
        }
        return reply.code(400).send({ ok: false, code: error.code, error: error.message })
      }
      request.log.error({ err: error }, '[stock/case-packs] save failed')
      return reply.code(500).send({ ok: false, code: 'FAILED', error: error instanceof Error ? error.message.slice(0, 400) : String(error) })
    }
  })
}
