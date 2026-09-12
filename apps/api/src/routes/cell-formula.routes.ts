import { applyFormulaBatch, previewFormulaBatch, undoFormulaBatch, continueFormulaBatch, readFormulaOperation, listFormulaOperations, type FormulaBatchInput } from '../services/pim/mapping/formula-bulk.service.js'
import { withFormulaWrite, formulaRequestHeaders, registerFormulaRequestContext, type FormulaWriteContext } from '../services/pim/mapping/formula-write-context.js'
import { captureDatabaseContext } from '../lib/database-context.js'
/**
 * PES.6 wave-4 (D16) — cell formulas, master field rules, and the one-row preview.
 *
 * Design: `docs/2026-09-02-wave4-design.md` §1 + §1.6(A)–(G).
 *
 *   POST   /pim/formulas/preview                       ← the cell editor's live line (zero-DB core)
 *   GET    /pim/formulas/product/:productId
 *   PUT    /pim/formulas/product/:productId            set a cell formula (evaluate + write value)
 *   DELETE /pim/formulas/product/:productId            pin a literal over it (audited, restorable)
 *   POST   /pim/formulas/restore                       re-create from a `formula.pinned` audit row
 *   GET/PUT/DELETE /pim/formulas/master[...]           master field rules + revisions
 *   GET    /pim/formulas/master/evaluate/:productId    read-time evaluation for one product
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  setCellFormula, setCellLiteral, previewCellFormula, pinOverFormula, restoreCellFormula, listCellFormulas,
  cellFormulasForProducts, assertFormulaListingScope, type FormulaScope,
} from '../services/pim/mapping/cell-formula.service.js'
import {
  listMasterRules, upsertMasterRule, removeMasterRule, listMasterRuleRevisions,
  evaluateMasterRulesForProduct,
} from '../services/pim/mapping/master-rule.service.js'
import { validateExpr, EXPR_FUNCTIONS, EXPR_REFERENCE_HELP } from '../services/pim/mapping/expr.js'
import { setFormulaFieldWriter } from '../services/pim/mapping/cell-formula.service.js'

/** Callers may send what the operator typed. `=` is the cell's mode switch, and also a real
 *  equality operator — so it is stripped HERE too, not only in the browser (§1.6(B)). */
function stripLeadingEquals(raw: string): string {
  const t = (raw ?? '').trim()
  return t.startsWith('=') ? t.slice(1).trim() : t
}

const bad = (reply: any, e: unknown) =>
  reply.status(400).send({ error: e instanceof Error ? e.message : String(e) })

const cellFormulaRoutes: FastifyPluginAsync = async (fastify) => {
  await registerFormulaRequestContext(fastify, {})
  // ── POST /pim/formulas/preview ──────────────────────────────────
  // Preview uses the same resolver and field validation as saving; dry-run writes nothing.
  fastify.post<{
    Body: {
      productId?: string
      aliasKey?: string | null
      channelConnectionId?: string | null
      expr?: string
      scope?: FormulaScope
      channel?: string | null
      marketplace?: string | null
      /**
       * #729 — the SHEET's market, which decides the column key set a `$ref`
       * may name. Measured: GALE-JACKET master exposes 40 column keys on IT and
       * 35 on DE (the five eBay columns differ by connected channel), so
       * resolving without it would let the editor accept a ref the sheet does
       * not offer, or reject one it does. `marketplace` is accepted as a
       * fallback because a channel scope supplies it naturally.
       */
      market?: string | null
      locale?: string | null
      fieldKey?: string
    }
  }>('/pim/formulas/preview', async (request, reply) => {
    const b = request.body ?? {}
    if (!b.productId || !b.fieldKey) {
      return reply.status(400).send({ error: 'productId and fieldKey are required' })
    }
    try { await assertFormulaListingScope(b) } catch (e) { return bad(reply, e) }
    const expr = stripLeadingEquals(b.expr ?? '')
    if (!expr) return reply.send({ ok: false, error: 'The formula is empty.', value: null, dependsOn: [], warnings: [] })

    const syntax = validateExpr(expr)
    if (syntax) {
      return reply.send({
        ok: false,
        error: `${syntax.message} (at character ${syntax.pos + 1})`,
        errorPos: syntax.pos,
        value: null, dependsOn: [], warnings: [],
      })
    }

    try {
      return reply.send(await previewCellFormula({ productId: b.productId, fieldKey: b.fieldKey, expr,
        scope: b.scope ?? (b.channel ? 'channel' : 'master'), channel: b.channel, marketplace: b.marketplace,
        market: b.market ?? b.marketplace, locale: b.locale, channelConnectionId: b.channelConnectionId, aliasKey: b.aliasKey }))
    } catch (e) { return bad(reply, e) }
  })

  // ── GET /pim/formulas/functions ─────────────────────────────────
  // §1.6(I) — the editor must be able to say what `$key` reads, not only what the functions do.
  // #775 — a formula writes through the ORDINARY cell writer, reached the way
  // the studio import already reaches it. Registered here because this is where
  // the Fastify instance lives; the service holds no route knowledge.
  //
  // Everything the bulk PATCH enforces therefore applies to a formula for free:
  // the 38-field master allow-list, `attr_*` with its registry check and
  // marketplace context, the mapped channel columns, the CAS, the audit row and
  // the BulkOperation. None of it is reimplemented here and none of it can drift.
  setFormulaFieldWriter(async ({ productId, writeField, localizedField, value, scope, channel, marketplace, market, locale, channelConnectionId, aliasKey, atomic, expectedVersion, dryRun, updatedBy }) => {
    const mkt = marketplace ?? market ?? null
    const context: FormulaWriteContext = { productId, writeField, operations: atomic, run: captureDatabaseContext(), userId: updatedBy }
    const res = await withFormulaWrite(context, token => fastify.inject({
      method: 'PATCH',
      url: localizedField ? `/api/products/${encodeURIComponent(productId)}/global` : '/api/products/bulk',
      // The bulk route recalculates dependent formulas after every write it
      // commits. This write IS that recalculation's own write, so it must not
      // start another walk: a nested pass would begin with an empty visited-set
      // and recurse until the stack gave out. An EXPLICIT header, set by this
      // one caller, rather than the route inferring "this looks like a cascade"
      // from the payload — an inference would silently start skipping real
      // operator writes the day the payload shape changed.
      headers: { ...formulaRequestHeaders(), 'x-nexus-formula-cascade': '1', 'x-nexus-formula-write': token },
      payload: localizedField ? { expectedVersion, dryRun, patch: { [locale || 'it']: { [localizedField]: value } } } : {
        expectedVersion,
        dryRun,
        changes: [
          {
            id: productId,
            field: writeField,
            value,
            ...(scope === 'channel' ? { target: 'channel' } : {}),
          },
        ],
        ...(mkt
          ? {
              marketplaceContexts: [
                scope === 'channel' && channel
                  ? { channel, marketplace: mkt, locale, ...(channelConnectionId ? { accountId: channelConnectionId } : {}), aliasKey: aliasKey ?? '' }
                  : { marketplace: mkt, locale },
              ],
            }
          : {}),
      },
    }))
    const body = res.json() as { error?: string; details?: string[]; errors?: Array<{ error?: string }>; updated?: number; unchanged?: number }
    const first = body?.errors?.[0]?.error ?? body?.details?.[0]
    if (res.statusCode !== 200 || first) {
      // The writer's own sentence, verbatim — it is the one the operator would
      // have seen typing the value by hand, which is the point of the rule.
      return { ok: false, error: first ?? body.error ?? `write refused (HTTP ${res.statusCode})` }
    }
    return { ok: true, atomicResults: context.results }
  })

  fastify.get('/pim/formulas/functions', async (_req, reply) =>
    reply.send({ functions: EXPR_FUNCTIONS, references: EXPR_REFERENCE_HELP }),
  )

  // ── Cell formulas ───────────────────────────────────────────────
  fastify.get<{ Params: { productId: string } }>(
    '/pim/formulas/product/:productId',
    async (request, reply) => reply.send({ formulas: await listCellFormulas(request.params.productId) }),
  )

  fastify.post<{
    Body: { channelConnectionId?: string | null; aliasKey?: string | null; productIds?: string[]; scope?: FormulaScope; channel?: string | null; marketplace?: string | null; locale?: string | null; market?: string | null }
  }>('/pim/formulas/batch', async (request, reply) => {
    const ids = request.body?.productIds ?? []
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ error: 'productIds (non-empty array) is required' })
    }
    if (ids.length > 250) return reply.status(400).send({ error: `productIds is capped at 250 (got ${ids.length})` })
    return reply.send({
      formulas: await cellFormulasForProducts({
        productIds: ids, scope: request.body?.scope,
        channel: request.body?.channel, marketplace: request.body?.marketplace,
        locale: request.body?.locale, channelConnectionId: request.body?.channelConnectionId, aliasKey: request.body?.aliasKey,
      }),
    })
  })

  fastify.put<{
    Params: { productId: string }
    Body: {
      aliasKey?: string | null; channelConnectionId?: string | null
      fieldKey?: string; expr?: string; scope?: FormulaScope
      channel?: string | null; marketplace?: string | null; locale?: string | null
      /** #732 — the sheet's market, so a saved MASTER formula is checked against
       *  the same column key set the editor previewed it against. */
      market?: string | null
      expectedState?: string
    }
  }>('/pim/formulas/product/:productId', async (request, reply) => {
    const b = request.body ?? {}
    if (!b.fieldKey || !b.expr) return reply.status(400).send({ error: 'fieldKey and expr are required' })
    try {
      const result = await setCellFormula({
        productId: request.params.productId, aliasKey: b.aliasKey, channelConnectionId: b.channelConnectionId,
        scope: b.scope ?? (b.channel ? 'channel' : 'master'),
        channel: b.channel, marketplace: b.marketplace, locale: b.locale,
        market: b.market ?? b.marketplace ?? null,
        ip: request.ip ?? null,
        fieldKey: b.fieldKey,
        expr: stripLeadingEquals(b.expr),
        expectedState: b.expectedState,
        updatedBy: ((request as any).authUser?.id ?? (request as any).user?.id) ?? null,
      })
      // #775 — an explicit verdict. The row IS stored (the never-revert rule, so
      // the operator can correct it in place), so the status stays 200 and `ok`
      // carries the evaluation's outcome. Before this a failed save answered in
      // a shape with no way to say so, and the cell rendered it as saved.
      return reply.send({ ok: !result.error, ...result })
    } catch (e) {
      return bad(reply, e)
    }
  })

  fastify.put<{ Params: { productId: string }; Body: {
    channelConnectionId?: string | null; aliasKey?: string | null;
    fieldKey: string; value: unknown; scope?: FormulaScope; channel?: string; marketplace?: string;
    market?: string; locale?: string; expectedState?: string
  } }>('/pim/formulas/product/:productId/value', async (request, reply) => {
    const b = request.body
    if (!b?.fieldKey || !Object.prototype.hasOwnProperty.call(b, 'value')) return reply.code(400).send({ error: 'fieldKey and value are required' })
    try { return reply.send(await setCellLiteral({ ...b, productId: request.params.productId,
      scope: b.scope ?? (b.channel ? 'channel' : 'master'), updatedBy: ((request as any).authUser?.id ?? (request as any).user?.id), ip: request.ip })) }
    catch (e) { return bad(reply, e) }
  })

  for (const action of ['preview', 'apply'] as const) {
    fastify.post<{ Body: FormulaBatchInput }>(`/pim/formulas/bulk/${action}`, async (request, reply) => {
      const body = request.body
      if (!body || typeof body.expr !== 'string' || !body.fieldKey || !Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 1000 ||
        (body.operationId !== undefined && (typeof body.operationId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.operationId))) || body.rows.some(row => !row || typeof row.productId !== 'string') || !['once', 'linked'].includes(body.mode) || !['master', 'channel'].includes(body.scope)) {
        return reply.code(400).send({ error: 'Choose a field, formula, mode and between 1 and 1000 products.' })
      }
      if (new Set(body.rows.map(row => row.productId)).size !== body.rows.length) return reply.code(400).send({ error: 'Each product may appear only once.' })
      const input = { ...body, expr: stripLeadingEquals(body.expr), updatedBy: ((request as any).authUser?.id ?? (request as any).user?.id) ?? null, ip: request.ip }
      try { return reply.send(await (action === 'preview' ? previewFormulaBatch(input) : applyFormulaBatch(input))) }
      catch (e) { return bad(reply, e) }
    })
  }
  fastify.get<{ Querystring: { channelConnectionId?: string; aliasKey?: string; familyProductId: string; scope: string; channel?: string; marketplace?: string; market?: string; locale?: string } }>('/pim/formulas/bulk', async (request, reply) => {
    if (!request.query.familyProductId || !['master', 'channel'].includes(request.query.scope)) return reply.code(400).send({ error: 'Product and scope are required.' })
    try { return reply.send(await listFormulaOperations({ ...request.query, updatedBy: (request as any).authUser?.id ?? (request as any).user?.id })) }
    catch (e) { return bad(reply, e) }
  })
  fastify.get<{ Params: { operationId: string } }>('/pim/formulas/bulk/:operationId', async (request, reply) => {
    try { return reply.send(await readFormulaOperation(request.params.operationId, { updatedBy: (request as any).authUser?.id ?? (request as any).user?.id })) }
    catch (e) { return bad(reply, e) }
  })
  fastify.post<{ Params: { operationId: string } }>('/pim/formulas/bulk/:operationId/continue', async (request, reply) => {
    try { return reply.send(await continueFormulaBatch(request.params.operationId, { updatedBy: (request as any).authUser?.id ?? (request as any).user?.id, ip: request.ip })) }
    catch (e) { return bad(reply, e) }
  })
  fastify.post<{ Params: { operationId: string } }>('/pim/formulas/bulk/:operationId/undo', async (request, reply) => {
    try { return reply.send(await undoFormulaBatch(request.params.operationId, { updatedBy: ((request as any).authUser?.id ?? (request as any).user?.id), ip: request.ip })) }
    catch (e) { return bad(reply, e) }
  })

  // Pin a literal over a formula: the row goes, the VALUE stays, an audit row keeps it restorable.
  fastify.delete<{
    Params: { productId: string }
    Querystring: { fieldKey?: string; scope?: FormulaScope; channel?: string; marketplace?: string; locale?: string; aliasKey?: string; channelConnectionId?: string }
  }>('/pim/formulas/product/:productId', async (request, reply) => {
    const q = request.query
    if (!q.fieldKey) return reply.status(400).send({ error: 'fieldKey is required' })
    try {
      const scope = q.scope ?? (q.channel ? 'channel' : 'master')
      const r = await pinOverFormula({
        productId: request.params.productId, aliasKey: q.aliasKey, channelConnectionId: q.channelConnectionId,
        scope,
        channel: q.channel, marketplace: q.marketplace, locale: q.locale,
        fieldKey: q.fieldKey,
        userId: ((request as any).authUser?.id ?? (request as any).user?.id) ?? null,
        ip: request.ip ?? null,
      })
      if (r.pinned) return reply.send(r)

      // #763 — a DELETE that deleted nothing must not answer 200. It did, and a
      // probe logged the status and moved on with the formula still stored.
      const coordinate = {
        fieldKey: q.fieldKey, scope,
        channel: q.channel ?? null, marketplace: q.marketplace ?? null, locale: q.locale ?? null,
      }
      if (r.reason === 'coordinate_mismatch') {
        // The field HAS a formula, addressed differently — name the part that
        // is missing rather than reporting a bare "not found", because the
        // caller is one query parameter away and cannot see which.
        const locales = [...new Set((r.storedAt ?? []).map((x) => x.locale))]
        return reply.status(400).send({
          error:
            `No formula at this coordinate. A formula IS stored on "${q.fieldKey}" for this scope at locale ` +
            `${locales.map((l) => JSON.stringify(l || '')).join(' / ')} — send the locale the row was stored with.`,
          coordinate,
          storedAt: r.storedAt ?? [],
        })
      }
      return reply.status(404).send({
        error: `No formula stored at this coordinate to pin over.`,
        coordinate,
      })
    } catch (e) {
      return bad(reply, e)
    }
  })

  fastify.post<{ Body: { auditLogId?: string } }>('/pim/formulas/restore', async (request, reply) => {
    if (!request.body?.auditLogId) return reply.status(400).send({ error: 'auditLogId is required' })
    try {
      return reply.send(await restoreCellFormula({
        auditLogId: request.body.auditLogId,
        userId: ((request as any).authUser?.id ?? (request as any).user?.id) ?? null,
      }))
    } catch (e) {
      return bad(reply, e)
    }
  })

  // ── Master field rules ──────────────────────────────────────────
  fastify.get<{ Querystring: { productType?: string } }>('/pim/formulas/master', async (request, reply) =>
    reply.send({ rules: await listMasterRules(request.query.productType) }),
  )

  fastify.put<{ Body: { fieldKey?: string; expr?: string; productType?: string | null; reason?: string } }>(
    '/pim/formulas/master',
    async (request, reply) => {
      const b = request.body ?? {}
      if (!b.fieldKey || !b.expr) return reply.status(400).send({ error: 'fieldKey and expr are required' })
      try {
        return reply.send({
          ok: true,
          rule: await upsertMasterRule({
            fieldKey: b.fieldKey, expr: stripLeadingEquals(b.expr),
            productType: b.productType, reason: b.reason,
            updatedBy: ((request as any).authUser?.id ?? (request as any).user?.id) ?? null,
          }),
        })
      } catch (e) {
        return bad(reply, e)
      }
    },
  )

  fastify.delete<{ Querystring: { fieldKey?: string; productType?: string } }>(
    '/pim/formulas/master',
    async (request, reply) => {
      if (!request.query.fieldKey) return reply.status(400).send({ error: 'fieldKey is required' })
      return reply.send(await removeMasterRule({
        fieldKey: request.query.fieldKey,
        productType: request.query.productType,
        updatedBy: ((request as any).authUser?.id ?? (request as any).user?.id) ?? null,
      }))
    },
  )

  fastify.get<{ Querystring: { fieldKey?: string; productType?: string } }>(
    '/pim/formulas/master/revisions',
    async (request, reply) => {
      if (!request.query.fieldKey) return reply.status(400).send({ error: 'fieldKey is required' })
      return reply.send({
        revisions: await listMasterRuleRevisions(request.query.fieldKey, request.query.productType),
      })
    },
  )

  fastify.get<{ Params: { productId: string }; Querystring: { locale?: string; fieldKeys?: string } }>(
    '/pim/formulas/master/evaluate/:productId',
    async (request, reply) => {
      try {
        return reply.send({
          values: await evaluateMasterRulesForProduct({
            productId: request.params.productId,
            locale: request.query.locale,
            fieldKeys: request.query.fieldKeys?.split(',').map((s) => s.trim()).filter(Boolean),
          }),
        })
      } catch (e) {
        return bad(reply, e)
      }
    },
  )
}

export default cellFormulaRoutes
