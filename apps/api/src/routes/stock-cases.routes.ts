/**
 * Step 3 (cases, Owner D2 = B) — `PUT /api/stock/case-packs`: one SKU's case pack (units per case, case size and weight,
 * who preps and labels for FBA), for 1..200 SKUs at once. The Matrix Case pop-up saves through it; a family's pop-up sends
 * every variation's id in one call.
 *
 *   Body   { productIds: string[] (1..200), unitsPerCase, caseLengthCm, caseWidthCm, caseHeightCm, caseWeightKg,
 *            fbaPrepOwner, fbaLabelOwner, openSealedCases?: boolean }
 *          Every value is ABSOLUTE and must be named: a number (owners 'AMAZON' | 'SELLER') or null to clear it. A missing
 *          key is refused rather than read as "clear", so an older page cannot wipe a value it did not show.
 *   200    { ok, results: [{ productId, ok, noop?, opened?, error? }], warning: string | null }  (warning = Amazon EU box limit)
 *   400    { ok: false, code: 'MISSING_FIELDS' | 'TOO_MANY' | 'INVALID_PACK' | <CaseCountError code>, error }
 *   409    { ok: false, code: 'SEALED_CASES', error, sealed: [{ productId, sku, locationCode, cases }] } — the units per case
 *          change while sealed cases are in stock; the same call with `openSealedCases: true` opens them (units unchanged).
 *
 * Permission: `/api/stock` writes → `inventory.adjust` (permissions-manifest.ts). Absolute values, so a double-click is
 * harmless (no COMMAND_SCOPES entry). The route parses and maps; `setCasePacks` (stock/stock-cases.service.ts) locks,
 * writes, audits and publishes `inventory.cases_changed`. Zero database calls here (check-route-prisma-ratchet).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { amazonBoxWarning, packProblem, type CasePackValues } from '@nexus/shared/stock-cases'
import { CaseCountError, setCasePacks } from '../services/stock/stock-cases.service.js'

/** The most SKUs one save may name (a family's every size, with room). */
export const MAX_CASE_PACK_PRODUCTS = 200

const VALUE_KEYS = ['unitsPerCase', 'caseLengthCm', 'caseWidthCm', 'caseHeightCm', 'caseWeightKg', 'fbaPrepOwner', 'fbaLabelOwner'] as const
const NUMBER_KEYS = ['unitsPerCase', 'caseLengthCm', 'caseWidthCm', 'caseHeightCm', 'caseWeightKg'] as const

type Parsed = { ok: true; productIds: string[]; values: CasePackValues; openSealedCases: boolean } | { ok: false; code: string; error: string }

/** A size or count as sent: a number, a numeric string, or null (clears). Anything else reads NaN, which `packProblem` refuses. */
function numberOf(raw: unknown): number | null {
  if (raw === null) return null
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim())
  return Number.NaN
}

/** Parse and check the body. Pure: the same refusals the pop-up shows (`packProblem`). */
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
  const missing = VALUE_KEYS.filter((key) => !(key in b) || b[key] === undefined)
  if (missing.length > 0) {
    return { ok: false, code: 'MISSING_FIELDS', error: `Name every value (null clears it); missing: ${missing.join(', ')}` }
  }
  const numbers = Object.fromEntries(NUMBER_KEYS.map((key) => [key, numberOf(b[key])])) as Record<(typeof NUMBER_KEYS)[number], number | null>
  const values: CasePackValues = {
    ...numbers,
    fbaPrepOwner: (b.fbaPrepOwner ?? null) as CasePackValues['fbaPrepOwner'],
    fbaLabelOwner: (b.fbaLabelOwner ?? null) as CasePackValues['fbaLabelOwner'],
  }
  const problem = packProblem(values)
  if (problem) return { ok: false, code: 'INVALID_PACK', error: problem }
  return { ok: true, productIds, values, openSealedCases: b.openSealedCases === true }
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
        values: parsed.values,
        openSealedCases: parsed.openSealedCases,
        actor: actorOf(request),
        userId: request.authUser?.id ?? null,
      })
      return { ok: results.every((r) => r.ok), results, warning: amazonBoxWarning(parsed.values) }
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
