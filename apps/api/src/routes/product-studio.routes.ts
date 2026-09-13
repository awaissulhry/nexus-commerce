import type {} from '@fastify/multipart'
import { InformationLocaleError } from '../services/pim/information-locale.js'
import { getInformationSheet } from '../services/pim/information-sheet.js'
/**
 * PES.5 — the Product Edit Studio's read endpoints (+ alias CRUD).
 *
 * `docs/pes5-phase0-backend.md` §3. Mounted under `/api`, so every route here
 * sits beneath `/api/products` and inherits RBAC from the prefix rule already in
 * `lib/auth/permissions-manifest.ts` (`RW(productsView, productsEdit,
 * pfx('/api/products'))`): a GET maps to products:view, a POST/PATCH/DELETE to
 * products:edit. No new permission wiring — and a route that fell outside that
 * prefix would be invisible to RBAC, which is why they all stay under it.
 *
 * The catalogue-wide master sheet (`products-sheet.routes.ts`, MS.1/2/5) is NOT
 * touched: its contracts are consumed by a shipped surface and stay
 * byte-identical.
 *
 * WRITES for cell edits are deliberately absent. Autosave keeps going through
 * `PATCH /api/products/bulk` (expectedVersion, 409 on conflict) — one write path
 * for the sheet, the studio and bulk-ops alike.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { resolveWorkspaceDestination, resolveWorkspaceListing, WorkspaceScopeError } from '../services/pim/workspace-destination.js'
import { AmbiguousConnectionError, NoConnectionError } from '../services/connection-resolver.service.js'

import { getSheetColumns, UnknownMarketError } from '../services/pim/sheet-columns.service.js'
import {
  getStudioSheet,
  ScopeNotAvailableError,
  UnknownProductError,
  type StudioScopeKind,
} from '../services/pim/studio-sheet.service.js'
import { getProductReadiness } from '../services/pim/scope-readiness.service.js'
import { getRestorePoints } from '../services/pim/restore-points.service.js'
import { getCellHistory } from '../services/pim/cell-history.service.js'
import { getProductSyncQueue, type SyncQueueFilter } from '../services/pim/sync-queue.service.js'
import {
  captureSnapshot,
  listSnapshots,
  restoreToDraft,
  SnapshotCoordinateMismatchError,
  SnapshotNotFoundError,
} from '../services/pim/listing-snapshot.service.js'
import {
  AliasCreationBlockedError,
  AliasNotFoundError,
  AliasScopeMismatchError,
  archiveAlias,
  createAlias,
  updateAlias,
} from '../services/pim/listing-alias.service.js'
import { ProductRelationshipError } from '../services/pim/product-relationship.service.js'

/** One error mapper so every route reports the same failure the same way. */
function sendError(reply: any, err: unknown, log: any, context: Record<string, unknown>) {
  if (err instanceof ProductRelationshipError) return reply.code(err.statusCode).send({ error: err.code, message: err.message })
  if (err instanceof WorkspaceScopeError) return reply.code(err.statusCode).send({ error: err.code, message: err.message })
  if (err instanceof AmbiguousConnectionError || err instanceof NoConnectionError)
    return reply.code(err.statusCode).send({ error: err.code, message: err.message })
  if (err instanceof UnknownProductError) return reply.code(404).send({ error: err.code, message: err.message })
  if (err instanceof AliasNotFoundError) return reply.code(404).send({ error: err.code, message: err.message })
  if (err instanceof AliasScopeMismatchError) return reply.code(409).send({ error: err.code, message: err.message })
  if (err instanceof SnapshotNotFoundError) return reply.code(404).send({ error: err.code, message: err.message })
  // 409, not 400: the request is well-formed, the WORLD moved — the listing was
  // re-pointed since capture. Naming that beats a validation-shaped error.
  if (err instanceof SnapshotCoordinateMismatchError)
    return reply.code(409).send({ error: err.code, message: err.message, snapshotCoordinate: err.snapshotCoord, targetCoordinate: err.targetCoord })
  if (err instanceof UnknownMarketError) return reply.code(400).send({ error: err.code, message: err.message, knownMarkets: err.known })
  if (err instanceof InformationLocaleError) return reply.code(400).send({ error: err.code, message: err.message })
  if (err instanceof ScopeNotAvailableError) return reply.code(400).send({ error: err.code, message: err.message, availableChannels: err.available })
  // 409, not 500: the request is well-formed and will succeed once PES.5-ii has
  // shipped. A 500 would read as a defect rather than a sequencing state.
  if (err instanceof AliasCreationBlockedError) return reply.code(409).send({ error: err.code, message: err.message })
  // VP.2 — the Variants page's four routes carry their own status and code on the error itself, so a new
  // refusal does not need a new branch here. Duck-typed rather than `instanceof` because those services are
  // loaded by dynamic import inside the handlers: an `instanceof` against a top-level import would pull the
  // whole projection module into every studio request just to classify an error that usually is not thrown.
  {
    const e = err as { statusCode?: unknown; code?: unknown; message?: unknown; collisions?: unknown; detail?: unknown }
    if (typeof e?.statusCode === 'number' && typeof e?.code === 'string' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({
        error: e.code,
        message: String(e.message ?? ''),
        ...(e.collisions ? { collisions: e.collisions } : {}),
        ...(e.detail && typeof e.detail === 'object' ? (e.detail as Record<string, unknown>) : {}),
      })
    }
  }
  log.error({ err, ...context }, '[studio] request failed')
  return reply.code(500).send({ error: 'studio_request_failed', message: err instanceof Error ? err.message : String(err) })
}

/**
 * `market` vs `marketplace` has now cost one lane real debugging time (PES.3,
 * 2026-09-01). These routes SELECT a market (`?market=IT`); only the history
 * route FILTERS by a coordinate's `marketplace`. When a caller sends the wrong
 * one, say so instead of returning a bare "market is required" that reads as
 * "you sent nothing" — an error that names the mistake is the cheapest possible
 * fix (reference_disabled_control_cannot_explain).
 */
function missingMarket(reply: any, q: Record<string, unknown>) {
  if (q.marketplace !== undefined) {
    return reply.code(400).send({
      error: 'market is required',
      message: `This route takes ?market=, not ?marketplace= — you sent marketplace=${String(q.marketplace)}. (The RESPONSE's scope.marketplace is a different thing: the resolved coordinate.)`,
      hint: `?market=${String(q.marketplace).toUpperCase()}`,
    })
  }
  return reply.code(400).send({ error: 'market is required', hint: 'e.g. ?market=IT' })
}

const productStudioRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { id: string } }>('/products/:id/studio-publication/preview', async (request, reply) => {
    try {
      const { publicationScope } = await import('../services/pim/studio-publication-plan.js')
      const { previewStudioPublication } = await import('../services/pim/studio-publication.service.js')
      return await previewStudioPublication(request.params.id, publicationScope(request.body), request.authUser?.id ?? null)
    } catch (error) { return sendError(reply, error, request.log, { productId: request.params.id }) }
  })
  fastify.post<{ Params: { id: string; reviewId: string } }>('/products/:id/studio-publication/:reviewId/submit', async (request, reply) => {
    try {
      const { submitStudioPublication } = await import('../services/pim/studio-publication.service.js')
      return await submitStudioPublication(request.params.id, request.params.reviewId, request.body, request.authUser?.id ?? null)
    } catch (error) { return sendError(reply, error, request.log, { productId: request.params.id }) }
  })
  fastify.get<{ Params: { id: string; reviewId: string } }>('/products/:id/studio-publication/:reviewId', async (request, reply) => {
    try {
      const { studioPublicationResult } = await import('../services/pim/studio-publication.service.js')
      reply.header('Cache-Control', 'no-store')
      return await studioPublicationResult(request.params.id, request.params.reviewId, request.authUser?.id ?? null)
    } catch (error) { return sendError(reply, error, request.log, { productId: request.params.id }) }
  })
  await (await import('./variant-transfer.routes.js')).registerVariantTransfer(fastify)
  for (const view of ['activity', 'performance'] as const) {
    fastify.get(`/products/:id/studio/${view}`, async (request, reply) => {
      const { id } = request.params as { id: string }
      const q = request.query as Record<string, string | undefined>
      const input = { productId: id, channel: q.channel ?? '', marketplace: q.market ?? '', accountId: q.accountId,
        listingId: q.listingId, aliasKey: q.aliasKey, scope: q.scope, cursor: q.cursor, days: Math.min(90, Math.max(7, Number(q.days) || 30)) }
      try {
        const { getWorkspaceActivity, getWorkspacePerformance } = await import('../services/pim/workspace-observations.js')
        return await (view === 'activity' ? getWorkspaceActivity(input) : getWorkspacePerformance(input))
      } catch (err) { return sendError(reply, err, request.log, { id, view }) }
    })
  }
  fastify.get('/products/:id/studio/destination', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, string | undefined>
    try {
      return await resolveWorkspaceDestination({ productId: id, channel: q.channel ?? '', marketplace: q.market ?? '',
        accountId: q.accountId, listingId: q.listingId, aliasKey: q.aliasKey })
    } catch (err) { return sendError(reply, err, request.log, { id }) }
  })
  fastify.get('/products/:id/studio/variation-axes', async (request, reply) => {
    const { getFamilyVariationAxes } = await import('../services/pim/family-variation-axes.js')
    const { id } = request.params as { id: string }
    const { market } = request.query as { market?: string }
    if (!market) return reply.code(400).send({ error: 'market is required' })
    try { return await getFamilyVariationAxes(id, market) }
    catch (error) { return sendError(reply, error, request.log, { id }) }
  })
  fastify.patch('/products/:id/studio/variation-axes', async (request, reply) => {
    const { validAxisChange, updateFamilyVariationAxes } = await import('../services/pim/family-variation-axes.js')
    const { id } = request.params as { id: string }
    if (!validAxisChange(request.body)) return reply.code(400).send({ error: 'Supply a family version, unique axes, reviewed childIds and market.' })
    try { return await updateFamilyVariationAxes(id, request.body) }
    catch (error) { return sendError(reply, error, request.log, { id }) }
  })
  // ── VP.2 — the Variants page (spec §5, contract `docs/vp2-contracts.md`) ──
  //
  // Four routes, all under `/api/products`, so RBAC is inherited exactly as every other studio route's is:
  // a GET is products:view, a PATCH/POST is products:edit. Nothing new is wired, and a route that fell
  // outside that prefix would be invisible to RBAC — which is why they all stay under it.
  fastify.get('/products/:id/studio/family', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    const market = String(q.market ?? '').trim().toUpperCase()
    if (!market) return missingMarket(reply, q)
    try {
      const { getFamilyRead } = await import('../services/pim/family-projection.service.js')
      const result = await getFamilyRead(id, market, q.locale ? String(q.locale) : undefined)
      reply.header('Server-Timing', `family;dur=${result.meta.tookMs}`)
      return result
    } catch (err) { return sendError(reply, err, request.log, { id, market }) }
  })

  /**
   * The projection of ONE family onto ONE coordinate. `channel` and `market` are both required: a projection
   * with no channel is the family read, and answering it here would give a caller a plausible payload for a
   * question they did not ask — the same silent-fallback failure #573 closed on the sheet.
   */
  const projectionInput = (id: string, q: Record<string, unknown>) => ({
    productId: id,
    channel: String(q.channel ?? '').trim().toUpperCase(),
    market: String(q.market ?? '').trim().toUpperCase(),
    locale: q.locale === undefined ? undefined : String(q.locale),
    accountId: q.accountId === undefined ? undefined : String(q.accountId),
    aliasKey: q.aliasKey === undefined ? undefined : String(q.aliasKey),
  })

  const requireCoordinate = (reply: FastifyReply, q: Record<string, unknown>) => {
    if (!String(q.market ?? '').trim()) { missingMarket(reply, q); return false }
    if (!String(q.channel ?? '').trim()) {
      reply.code(400).send({ error: 'channel is required', message: 'A projection is one channel on one market.', hint: 'e.g. &channel=EBAY&market=IT' })
      return false
    }
    return true
  }

  fastify.get('/products/:id/studio/projection', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    if (!requireCoordinate(reply, q)) return reply
    try {
      const { getProjectionRead } = await import('../services/pim/family-projection.service.js')
      const result = await getProjectionRead(projectionInput(id, q))
      reply.header('Server-Timing', `projection;dur=${result.meta.tookMs}`)
      return result
    } catch (err) { return sendError(reply, err, request.log, { id }) }
  })

  fastify.patch('/products/:id/studio/projection', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    if (!requireCoordinate(reply, q)) return reply
    const body = (request.body ?? {}) as { expectedVersion?: unknown; mapping?: unknown; theme?: unknown; presentationOrder?: unknown; reset?: unknown }
    if (!Number.isSafeInteger(body.expectedVersion)) {
      return reply.code(400).send({ error: 'bad_projection_request', message: 'An observed listing version is required.' })
    }
    if (body.mapping !== undefined && !Array.isArray(body.mapping)) {
      return reply.code(400).send({ error: 'bad_projection_request', message: 'mapping must be the WHOLE list of mapped axes — an axis left out of it is unmapped.' })
    }
    // VT.1 — `reset: true` is the ONLY accepted value. `false` would be a second way to say "do nothing", and a
    // caller that sent it would reasonably expect the override to survive; naming the refusal is cheaper than
    // guessing which of the two they meant (`docs/vt1-contracts.md` §3.3).
    if (body.reset !== undefined && body.reset !== true) {
      return reply.code(400).send({ error: 'bad_projection_request', message: 'reset must be true. Omit it to keep this coordinate\'s override.' })
    }
    try {
      const { writeProjectionMapping } = await import('../services/pim/family-projection.service.js')
      return await writeProjectionMapping({
        ...projectionInput(id, q),
        expectedVersion: body.expectedVersion as number,
        ...(body.mapping !== undefined ? { mapping: body.mapping as Array<{ axisKey: string; target: string; order?: number }> } : {}),
        ...(body.theme !== undefined ? { theme: body.theme === null ? null : String(body.theme) } : {}),
        ...(body.reset === true ? { reset: true } : {}),
        ...(body.presentationOrder !== undefined ? { presentationOrder: body.presentationOrder as import('../services/pim/family-projection.service.js').MappingWriteInput['presentationOrder'] } : {}),
        userId: (request as typeof request & { authUser?: { id: string } }).authUser?.id ?? null,
      })
    } catch (err) { return sendError(reply, err, request.log, { id }) }
  })

  /**
   * Include / exclude. A LOCAL-RECORD write: it calls no marketplace and enqueues no sync row. The full
   * consumer enumeration behind that claim is in `docs/pes-claims.md` under VP.2.
   */
  fastify.patch('/products/:id/studio/projection/children', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    if (!requireCoordinate(reply, q)) return reply
    const body = (request.body ?? {}) as { expectedVersion?: unknown; changes?: unknown }
    if (!Number.isSafeInteger(body.expectedVersion)) {
      return reply.code(400).send({ error: 'bad_projection_request', message: 'An observed listing version is required.' })
    }
    if (!Array.isArray(body.changes)) {
      return reply.code(400).send({ error: 'bad_projection_request', message: 'changes must be a list of { id, included }.' })
    }
    try {
      const { writeProjectionInclusion } = await import('../services/pim/family-projection.service.js')
      return await writeProjectionInclusion({
        ...projectionInput(id, q),
        expectedVersion: body.expectedVersion as number,
        changes: body.changes as Array<{ id: string; included: boolean }>,
      })
    } catch (err) { return sendError(reply, err, request.log, { id }) }
  })

  /**
   * VT.4 — the DRY-RUN theme-change plan (D-VT6 / VX D8, `docs/2026-09-12-variation-projection-design.md` §9).
   *
   * 🔴 `dryRun: true` is the ONLY accepted value, and there is no executor behind this route. It is a POST and
   * not a GET because the plan is computed FOR a proposed change the client states in the body (the target
   * theme or axis set) and is CAS-checked against the version the operator saw — a GET with that in the query
   * would be cacheable and would read as a resource. It writes nothing: no listing row, no queue row, no
   * provider call. Compare `family/generate` below, which takes `dryRun: false` as a real commit; this one
   * refuses it by name so a client that copied that shape cannot execute anything.
   *
   * Additive: no existing handler is touched, and the refusals ride on the same duck-typed `sendError` mapper.
   */
  fastify.post('/products/:id/studio/projection/theme-change', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    if (!requireCoordinate(reply, q)) return reply
    const body = (request.body ?? {}) as { expectedVersion?: unknown; kind?: unknown; theme?: unknown; mapping?: unknown; dryRun?: unknown; reset?: unknown }
    if (body.dryRun !== true) {
      return reply.code(400).send({
        error: 'bad_projection_request',
        message: 'dryRun must be true. There is no live theme-change executor in this programme — the plan is what this endpoint returns.',
      })
    }
    if (!Number.isSafeInteger(body.expectedVersion)) {
      return reply.code(400).send({ error: 'bad_projection_request', message: 'An observed listing version is required.' })
    }
    if (body.mapping !== undefined && !Array.isArray(body.mapping)) {
      return reply.code(400).send({ error: 'bad_projection_request', message: 'mapping must be the WHOLE list of mapped axes — an axis left out of it is unmapped.' })
    }
    try {
      const { buildThemeChangePlan } = await import('../services/pim/theme-change.service.js')
      const plan = await buildThemeChangePlan({
        ...projectionInput(id, q),
        expectedVersion: body.expectedVersion as number,
        dryRun: true,
        ...(body.kind !== undefined ? { kind: String(body.kind) } : {}),
        ...(body.reset === true ? { reset: true } : {}),
        ...(body.theme !== undefined ? { theme: body.theme === null ? null : String(body.theme) } : {}),
        ...(body.mapping !== undefined ? { mapping: body.mapping as Array<{ axisKey: string; target: string; order?: number }> } : {}),
      })
      reply.header('Server-Timing', `theme-change;dur=${plan.meta.tookMs}`)
      return plan
    } catch (err) { return sendError(reply, err, request.log, { id }) }
  })

  /**
   * Generate combinations. `dryRun: true` answers the modal's summary box; `dryRun: false` commits the SAME
   * plan. The flag is required rather than defaulted — a create that happened because a client forgot a field
   * is the one mistake this endpoint must not make.
   */
  fastify.post('/products/:id/studio/family/generate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.dryRun !== 'boolean') {
      return reply.code(400).send({ error: 'bad_generate_request', message: 'dryRun must be true or false. Preview a plan before creating it.' })
    }
    if (!Number.isSafeInteger(body.version)) {
      return reply.code(400).send({ error: 'bad_generate_request', message: 'A family version is required.' })
    }
    try {
      const { generateCombinations } = await import('../services/pim/family-generate.service.js')
      return await generateCombinations({
        productId: id,
        version: body.version as number,
        axisValues: (body.axisValues ?? {}) as Record<string, string[]>,
        skuPattern: String(body.skuPattern ?? ''),
        valueCodes: body.valueCodes as Record<string, Record<string, string>> | undefined,
        previewToken: typeof body.previewToken === 'string' ? body.previewToken : undefined,
        copyFrom: 'nearest-sibling',
        dryRun: body.dryRun as boolean,
      })
    } catch (err) { return sendError(reply, err, request.log, { id }) }
  })

  fastify.get('/products/:id/studio/classification', async (request, reply) => {
    const { getProductClassification } = await import('../services/pim/product-classification.js')
    const data = await getProductClassification((request.params as { id: string }).id)
    return data ?? reply.code(404).send({ error: 'Product not found' })
  })
  fastify.patch('/products/:id/studio/classification', async (request, reply) => {
    const { validClassificationChange, updateProductClassification } = await import('../services/pim/product-classification.js')
    if (!validClassificationChange(request.body)) return reply.code(400).send({ error: 'Supply version, familyId, categoryIds and a primaryId in that set' })
    const result = await updateProductClassification((request.params as { id: string }).id, request.body)
    return reply.code(result.status).send(result)
  })
  /**
   * #573 — ONE scope validator, used by `/studio/columns` AND `/studio/sheet`.
   *
   * They disagreed: `sheet` refused `scope=AMAZON` with 400 while `columns`
   * returned 200 and a MASTER payload, ignoring `scope` entirely — so
   * `scope=channel` without a channel also silently returned master. A
   * comparison of the two endpoints' payloads would have shown master against
   * master and read as agreement; the stricter endpoint is the only reason
   * UX.1's mistake surfaced at all.
   *
   * A silent fallback to master is the worst available answer here, because
   * master is a plausible-looking payload: nothing about it says "this is not
   * what you asked for".
   */
  // NOTE the shape: a nullable `error` rather than a discriminated union on
  // `ok`. This package compiles with `strictNullChecks` off, which stops TS
  // narrowing `{ok:true}|{ok:false}` through `if (!sc.ok)` — the union would
  // read correctly and not compile.
  const resolveScope = (
    q: Record<string, unknown>,
  ): { error: { status: number; body: object } | null; scope: StudioScopeKind; channel?: string } => {
    const rawScope = q.scope === undefined ? undefined : String(q.scope).trim().toLowerCase()
    const channel = q.channel ? String(q.channel).trim().toUpperCase() : undefined
    if (rawScope !== undefined && rawScope !== 'master' && rawScope !== 'channel') {
      return { error: { status: 400, body: { error: 'bad_scope', message: 'scope must be "master" or "channel"', received: q.scope } }, scope: 'master' }
    }
    if (rawScope === 'channel' && !channel) {
      return { error: { status: 400, body: { error: 'bad_scope', message: 'channel is required when scope=channel', hint: 'e.g. &channel=EBAY' } }, scope: 'master' }
    }
    if (channel && rawScope === undefined) {
      return {
        scope: 'master',
        error: { status: 400, body: {
          error: 'ambiguous_scope',
          message: 'channel was given without scope. Add scope=channel to read that channel, or drop channel to read master.',
          missing: 'scope',
          received: { scope: null, channel: q.channel ?? null },
        } },
      }
    }
    return { error: null, scope: (rawScope ?? 'master') as StudioScopeKind, ...(channel ? { channel } : {}) }
  }

  /**
   * #483 — refuse an ambiguous coordinate instead of guessing at it.
   *
   * `?channel=AMAZON` with no `scope` used to mean two different things on two
   * endpoints of the same contract: `/studio/sheet` returned the MASTER sheet
   * (silently ignoring the channel — PES.3 read `writeVerb: "master"` off it and
   * nearly filed a false finding), while `/studio/columns` inferred
   * `scope=channel` and answered for Amazon. Same query, two answers.
   *
   * A caller who names a channel has said what they want; guessing either way
   * hands them a plausible wrong answer, which is worse than an error. Same
   * class as the `market=` case #331 closed.
   */
  const ambiguousScope = (reply: FastifyReply, q: Record<string, unknown>) =>
    reply.code(400).send({
      error: 'ambiguous_scope',
      message: 'channel was given without scope. Add scope=channel to read that channel, or drop channel to read master.',
      missing: 'scope',
      received: { scope: q.scope ?? null, channel: q.channel ?? null },
    })

  /** The column set for one family in one scope. */
  fastify.get('/products/:id/studio/columns', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    const market = String(q.market ?? '').trim().toUpperCase()
    if (!market) return missingMarket(reply, q)
    const sc = resolveScope(q)
    if (sc.error) return reply.code(sc.error.status).send(sc.error.body)
    const { scope, channel } = sc

    try {
      // Routed through the sheet read so the columns a caller is given are
      // exactly the columns the rows are built from. Deriving them separately is
      // how a grid ends up with a column its rows never fill.
      const sheet = await getInformationSheet({ productId: id, scope, market, channel, accountId: q.accountId ? String(q.accountId) : undefined, locale: q.locale ? String(q.locale) : undefined })
      return {
        scope: sheet.scope,
        family: sheet.family,
        columns: sheet.columns,
        // AM.1 — the channel's own column groups in display order, and what each spec covered.
        groups: sheet.groups,
        coverage: sheet.meta.coverage,
        schemaMissing: sheet.meta.schemaMissing,
        schemaAge: sheet.meta.schemaAge,
        droppedKeys: sheet.meta.droppedKeys,
        availableMarkets: sheet.meta.availableMarkets,
      }
    } catch (err) {
      return sendError(reply, err, request.log, { id, market, channel })
    }
  })

  /** One family, one scope: rows + alias groups + per-cell provenance. */
  fastify.get('/products/:id/studio/sheet', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    const market = String(q.market ?? '').trim().toUpperCase()
    if (!market) return missingMarket(reply, q)

    const sc = resolveScope(q)
    if (sc.error) return reply.code(sc.error.status).send(sc.error.body)
    const rawScope = sc.scope
    const channel = sc.channel

    try {
      const result = await getInformationSheet({
        accountId: q.accountId ? String(q.accountId) : undefined,
        productId: id,
        scope: rawScope,
        market,
        channel,
        locale: q.locale ? String(q.locale) : undefined,
        locales: q.locales !== undefined ? String(q.locales).split(',').filter(Boolean) : undefined,
      })
      // The read reports its own duration, so a slow scope is visible rather
      // than being felt as "the grid is laggy".
      reply.header('Server-Timing', `studio;dur=${result.meta.tookMs}`)
      return result
    } catch (err) {
      return sendError(reply, err, request.log, { id, market, scope: rawScope, channel })
    }
  })

  /**
   * Readiness for EVERY scope in one call — the scope bar's whole chip row.
   * Shape specified by PES.1 and adopted verbatim, including `pct: null` + a
   * `note` whenever it cannot be computed.
   */
  fastify.get('/products/:id/readiness', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    const market = String(q.market ?? '').trim().toUpperCase()
    if (!market) return missingMarket(reply, q)

    try {
      const t0 = Date.now()
      const channel = q.channel ? String(q.channel).toUpperCase() : undefined
      const accountId = q.accountId ? String(q.accountId) : undefined
      if (accountId && !channel) return reply.code(400).send({ error: 'channel is required when accountId is provided' })
      const result = await getProductReadiness({ productId: id, market, channel, accountId, ...(q.locale ? { locale: String(q.locale) } : {}), ...(q.workspace === '1' ? { selectedOnly: true } : {}), ...(q.listingId ? { listingId: String(q.listingId) } : {}) })
      reply.header('Server-Timing', `readiness;dur=${Date.now() - t0}`)
      return result
    } catch (err) {
      return sendError(reply, err, request.log, { id, market })
    }
  })

  /** Per-cell history for the drawer. Carries its own coverage statement. */
  fastify.get('/products/:id/studio/history', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    try {
      return await getCellHistory({
        productId: id,
        accountId: q.accountId === undefined ? undefined : String(q.accountId),
        listingId: q.listingId === undefined ? undefined : String(q.listingId),
        aliasKey: q.aliasKey === undefined ? undefined : String(q.aliasKey),
        fieldKey: q.fieldKey ? String(q.fieldKey) : undefined,
        locale: q.locale ? String(q.locale) : undefined,
        channel: q.channel ? String(q.channel).toUpperCase() : undefined,
        marketplace: q.marketplace ? String(q.marketplace).toUpperCase() : undefined,
        aliasId: q.aliasId ? String(q.aliasId) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      })
    } catch (err) {
      return sendError(reply, err, request.log, { id })
    }
  })



  /**
   * The Errors & Sync console's queue view for one product family.
   *
   * `syncedAt` is in every row deliberately: it is the only thing separating
   * "old" from "STUCK". Measured on prod, a stuck filter written as
   * `createdAt < now-24h` matches 36,844 rows; with `syncedAt IS NULL` and a
   * runnable status it matches 0. Do not re-derive stuck client-side.
   */
  // ── D15 — import: the diff token IS the job ───────────────────────
  /**
   * `POST …/import/diff` — multipart CSV in, the ratified diff envelope out.
   *
   * The CSV is parsed HERE, beside the exporter, so the label-row/key-row
   * convention (D15.2) lives in one place. Asking the client to parse it would
   * put the header contract in two implementations that must agree forever.
   *
   * ⚠ Replaces an earlier `dry-run` I built to my own reading of D15.13/14
   * rather than to the ratified envelope. The substantive miss was `columns[]`:
   * D15.14.3 rules that the CLIENT renders labels from the columns contract's
   * `optionLabels` — a ruling I argued for — and without that array it cannot,
   * so `country_of_origin` would diff as `PK → IT` instead of
   * `Pakistan → Italy`. Shipping the ruling without the field that makes it
   * possible is the same failure as a contract that names a layer it does not
   * carry.
   */
  fastify.post('/products/:id/import/diff', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const parts: Record<string, string> = {}
      let csv = ''
      let filename = 'import.csv'
      const mp = request as unknown as { parts?: () => AsyncIterable<Record<string, unknown>> }
      if (typeof mp.parts !== 'function') {
        return reply.code(400).send({ error: 'bad_request', message: 'multipart/form-data with a CSV file is required' })
      }
      for await (const part of mp.parts()) {
        if (part.type === 'file') {
          filename = String(part.filename ?? filename)
          csv = (await (part as { toBuffer: () => Promise<Buffer> }).toBuffer()).toString('utf8')
        } else {
          parts[String(part.fieldname)] = String((part as { value?: unknown }).value ?? '')
        }
      }
      if (!csv.trim()) return reply.code(400).send({ error: 'bad_request', message: 'the uploaded file is empty' })

      const market = String(parts.market ?? '').trim().toUpperCase()
      if (!market) return missingMarket(reply, parts)
      const sc = resolveScope(parts)
      if (sc.error) return reply.code(sc.error.status).send(sc.error.body)
      if (sc.scope === 'channel') return reply.code(409).send({ error: 'account_identity_required', message: 'Channel table files omit account identity and override state. Use an editable export from /products/catalog-transfer.' })
      // Only the two ruled options; anything else is refused rather than
      // defaulted, because a blank-cell policy the operator did not choose
      // silently clears data.
      const raw = parts.blankCells ?? 'ignore'
      if (raw !== 'ignore' && raw !== 'clear') {
        return reply.code(400).send({ error: 'bad_request', message: 'blankCells must be "ignore" or "clear"' })
      }
      const blankCells = raw as 'ignore' | 'clear'

      const { parse } = await import('csv-parse/sync')
      const grid = parse(csv, { skip_empty_lines: true, relax_column_count: true }) as string[][]
      if (grid.length < 2) {
        return reply.code(400).send({ error: 'bad_request', message: 'the file needs a key row and at least one data row' })
      }
      // D15.2 — row 1 is the human label row and is IGNORED on the way in; row 2
      // is the machine key row. A file that carries only keys still works: if
      // row 1 parses as keys and row 2 does not, treat row 1 as the key row.
      const { parseHeader } = await import('../services/pim/import-diff.service.js')
      const looksLikeKeys = (r: string[]) => r.some((h) => h === 'sku') && r.filter((h) => parseHeader(h)).length > 1
      const keyRowIndex = looksLikeKeys(grid[1] ?? []) ? 1 : 0
      const headerRow = grid[keyRowIndex]
      if (headerRow.some(h => parseHeader(h)?.scope.kind === 'channel')) return reply.code(409).send({ error: 'account_identity_required', message: 'Channel table columns cannot be imported under an inferred account. Use /products/catalog-transfer.' })
      const rows = grid.slice(keyRowIndex + 1).map((line) => {
        const o: Record<string, string> = {}
        headerRow.forEach((h, i) => { o[h] = line[i] ?? '' })
        return o
      })

      const { computeImportDiff } = await import('../services/pim/import-diff.service.js')
      const { storePreview } = await import('../services/pim/import-jobs.service.js')
      const diff = await computeImportDiff({
        productId: id, market, headerRow, rows, blankPolicy: blankCells,
        // The label row names an informational (empty-key) column in the drawer; a key-only file has none.
        labelRow: keyRowIndex === 1 ? grid[0] : undefined,
        // Item 8 — the write path's OWN verdicts, reached in-process. One
        // validator, three surfaces (D15.4): the diff, the paste gate and the
        // write all refuse the same value for the same stated reason, because
        // they are the same code.
        validateBatch: async (candidates) => {
          const refusals = new Map<string, string>()
          const groups = new Map<string, typeof candidates>()
          for (const c of candidates) {
            const k = `${c.scope.kind}:${c.scope.channel ?? ''}:${c.scope.marketplace ?? ''}:${c.scope.locale ?? ''}`
            groups.set(k, [...(groups.get(k) ?? []), c])
          }
          for (const group of groups.values()) {
            const gs = group[0].scope
            const res = await fastify.inject({
              method: 'PATCH', url: '/api/products/bulk',
              payload: {
                dryRun: true,
                // The WRITE field (`attr_x`), never the sheet key — the write path only knows the
                // sheet key for the core fields; it answers with the field it was told.
                changes: group.map((c) => ({
                  id: c.productId, field: c.writeField, value: c.value, contentAddress: c.contentAddress,
                  ...(gs.kind === 'channel' ? { target: 'channel' } : {}),
                })),
                ...(gs.kind === 'channel' && gs.channel && gs.marketplace
                  ? { marketplaceContexts: [{ channel: gs.channel, marketplace: gs.marketplace, locale: gs.locale ?? undefined, aliasKey: '' }] }
                  : { marketplaceContexts: [{ marketplace: market, locale: gs.locale ?? undefined }] }),
              },
            })
            const body = res.json() as { errors?: { id: string; field: string; error: string }[] }
            for (const e of body.errors ?? []) refusals.set(`${e.id}:${e.field}@${gs.locale ?? ''}`, e.error)
          }
          return refusals
        },
      })

      // The sheet's own columns contract, so the client renders labels and
      // closed-list values from ONE source (D15.14.3) rather than re-deriving.
      const sheet = await getStudioSheet({
        productId: id, scope: sc.scope, market,
        ...(sc.channel ? { channel: sc.channel } : {}),
      })

      const actor = (request as { authUser?: { id?: string } }).authUser?.id ?? null
      const { jobId, expiresAt } = await storePreview({
        cells: diff.cells, counts: diff.counts, productId: id,
        filename, userId: actor, blankPolicy: blankCells,
        // #600(2) — the coordinate is stored WITH the diff, so apply needs no
        // query and cannot be pointed at a different scope than the preview.
        scope: { kind: sheet.scope.kind, channel: sheet.scope.channel, marketplace: sheet.scope.marketplace, locale: sheet.scope.locale },
        market,
      })

      // Nested rows keyed by column — the ratified shape. Identity travels as
      // COMPONENTS and is composed client-side (D15.13.3).
      const byRow = new Map<string, { productId: string; aliasKey: string; aliasResolved: boolean; sku: string | null; cells: Record<string, unknown> }>()
      for (const c of diff.cells) {
        let r = byRow.get(c.rowId)
        if (!r) {
          const sheetRow = sheet.rows.find((x) => x.id === c.rowId)
          r = { productId: c.rowId, aliasKey: c.aliasKey, aliasResolved: c.aliasResolved, sku: sheetRow?.sku ?? null, cells: {} }
          byRow.set(c.rowId, r)
        }
        r.cells[c.fieldKey] = { verdict: c.verdict, pins: c.pins, before: c.before, after: c.after, ...(c.reason ? { reason: c.reason } : {}) }
      }

      return {
        jobId,
        file: { name: filename, rows: rows.length, columns: headerRow.length },
        scope: sheet.scope,
        columns: sheet.columns,
        rows: [...byRow.values()],
        counts: diff.counts,
        blankCells,
        // The web mirror (`_studio/import/contract.ts` `ImportUnmatchedColumn`) reads OBJECTS —
        // `{ header, key, reason }` — and this sent bare strings, which rendered as "undefined —
        // undefined" on the one path that would show them. The label row names the column for a
        // human; the key is what the file actually said.
        unmatchedColumns: diff.unknownColumns.map((key) => {
          const idx = headerRow.indexOf(key)
          const header = keyRowIndex === 1 && idx >= 0 ? (grid[0][idx]?.trim() || key) : key
          return { header, key, reason: `No column with this key on ${sheet.scope.label}` }
        }),
        ignoredColumns: diff.ignoredColumns,
        unmatchedRows: diff.unmatchedRows,
        expiresAt: expiresAt.toISOString(),
        coverageNote:
          'Only columns this scope declares are diffed; anything else is listed in unmatchedColumns and never applied. ' +
          'Counts are server-stated and cover every cell in the file — they are not derived from the rows shown.',
      }
    } catch (err) {
      return sendError(reply, err, request.log, { id })
    }
  })

  /** Poll. `state` is whatever the record says — never inferred by the client. */
  fastify.get('/products/:id/import/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string }
    try {
      const { readJob } = await import('../services/pim/import-jobs.service.js')
      const loaded = await readJob(jobId)
      if (!loaded) return reply.code(404).send({ error: 'not_found', message: `No studio import job ${jobId}` })
      const { job, cells } = loaded
      const { toWireState } = await import('../services/pim/import-jobs.service.js')
      return {
        // #600(4) — the DB's enum is ours; the wire speaks lowercase, mapped in
        // one place so a client never has to know both vocabularies.
        jobId: job.id, state: toWireState(job.status), processed: job.processed ?? 0, total: job.total ?? cells.length,
        // #614 — the poll must carry `phase` too. Apply and revert both return
        // it; the poll built its own object and dropped it, so a panel that
        // polls (rather than reading the apply/revert response) would show
        // "partial" with nothing to say partial at — the exact gap `phase`
        // exists to close, reopened one handler over.
        ...(loaded.phase ? { phase: loaded.phase } : {}),
        outcomes: loaded.outcomes,
        ...(job.expiresAt ? { expiresAt: job.expiresAt.toISOString() } : {}),
      }
    } catch (err) {
      return sendError(reply, err, request.log, { jobId })
    }
  })

  /** Cancel an unapplied preview. The sweep covers the tab that never closes. */
  fastify.post('/products/:id/import/jobs/:jobId/cancel', async (request, reply) => {
    const { jobId } = request.params as { jobId: string }
    try {
      const { cancelJob } = await import('../services/pim/import-jobs.service.js')
      return { jobId, cancelled: await cancelJob(jobId) }
    } catch (err) {
      return sendError(reply, err, request.log, { jobId })
    }
  })

  /**
   * Apply the STORED diff. No file, no mode — both were inputs to the preview.
   *
   * The writer is the ordinary bulk PATCH, reached in-process: one write path,
   * so validation, the cap guard, CAS and the audit trail all apply exactly as
   * they do to a typed edit. Re-implementing the write here would be the second
   * path this contract exists to avoid.
   */
  /**
   * Apply the STORED diff. **No file, no mode, and no query** (#600.2).
   *
   * The coordinate comes from the job, not the URL. A `?market=` on apply could
   * name a different scope than the operator previewed — the same reason the
   * diff itself is stored rather than recomputed — and it is what turned a
   * recoverable mistake into a permanently `RUNNING` job.
   *
   * The writer is the ordinary bulk PATCH, reached in-process: one write path,
   * so validation, the cap guard, CAS and the audit trail all apply exactly as
   * they do to a typed edit.
   */
  const jobWriters = (
    id: string,
    storedScope: { kind: string; channel: string | null; marketplace: string | null; locale?: string | null } | null,
    storedMarket: string | null,
  ) => {
    const sheets = new Map<string, Awaited<ReturnType<typeof getStudioSheet>>>()
    const loadSheet = async (locale = storedScope?.locale ?? undefined) => {
      const cached = sheets.get(locale ?? '')
      if (cached) return cached
      // The MARKET, not the coordinate's marketplace: a master scope has no
      // marketplace at all, so reading the market off `scope` yields '' and the
      // rebuild throws `unknown_market` — which is exactly the failure that
      // stranded a job, reappearing one layer in.
      const market = storedMarket ?? storedScope?.marketplace ?? ''
      if (!market) {
        throw new Error('This job has no stored market — it predates the stored-coordinate contract and cannot be applied.')
      }
      const sheet = await getStudioSheet({
        productId: id,
        locale,
        scope: (storedScope?.kind ?? 'master') as StudioScopeKind,
        market,
        ...(storedScope?.channel ? { channel: storedScope.channel } : {}),
      })
      sheets.set(locale ?? '', sheet)
      return sheet
    }
    return {
      // Runs BEFORE the job is marked RUNNING (#600.1).
      preflight: async () => { await loadSheet() },
      currentOf: async (cell: { productId: string; fieldKey: string; scope?: { locale?: string | null } }) => {
        const sh = await loadSheet(cell.scope?.locale ?? undefined)
        return sh.rows.find((r) => r.id === cell.productId)?.values?.[cell.fieldKey]?.value ?? null
      },
      writeCells: async (cells: { productId: string; fieldKey: string; writeField?: string; after: unknown; contentAddress?: import('@nexus/shared/content-language').ContentAddress; scope: { kind: string; channel: string | null; marketplace: string | null; locale?: string | null } }[]) => {
        const errors: { productId: string; fieldKey: string; error: string }[] = []
        // The write path is told the WRITE field and answers with it; the outcome names the SHEET key.
        const sentField = (c: { fieldKey: string; writeField?: string }) => c.writeField ?? c.fieldKey
        let applied = 0
        const groups = new Map<string, typeof cells>()
        for (const c of cells) {
          const k = `${c.scope.kind}:${c.scope.channel ?? ''}:${c.scope.marketplace ?? ''}:${c.scope.locale ?? ''}`
          groups.set(k, [...(groups.get(k) ?? []), c])
        }
        for (const group of groups.values()) {
          const sc = group[0].scope
          const res = await fastify.inject({
            method: 'PATCH', url: '/api/products/bulk',
            payload: {
              changes: group.map((c) => ({
                id: c.productId, field: sentField(c), value: c.after, contentAddress: c.contentAddress,
                ...(sc.kind === 'channel' ? { target: 'channel' } : {}),
              })),
              ...(sc.kind === 'channel' && sc.channel && sc.marketplace
                ? { marketplaceContexts: [{ channel: sc.channel, marketplace: sc.marketplace, locale: sc.locale ?? undefined, aliasKey: '' }] }
                : { marketplaceContexts: [{ marketplace: storedMarket ?? sc.marketplace, locale: sc.locale ?? undefined }] }),
            },
          })
          const body = res.json() as { updated?: number; errors?: { id: string; field: string; error: string }[] }
          applied += body.updated ?? 0
          const sheetKeyOf = new Map(group.map((c) => [`${c.productId}:${sentField(c)}`, c.fieldKey]))
          for (const e of body.errors ?? []) {
            const fieldKey = sheetKeyOf.get(`${e.id}:${e.field}`)
              ?? group.find((c) => c.productId === e.id && sentField(c).replace(/\[\d+\]$/, '') === e.field)?.fieldKey
              ?? e.field
            errors.push({ productId: e.id, fieldKey, error: e.error })
          }
          if (res.statusCode !== 200 && (body.errors ?? []).length === 0) {
            for (const c of group) errors.push({ productId: c.productId, fieldKey: c.fieldKey, error: `write failed (${res.statusCode})` })
          }
        }
        return { applied, errors }
      },
    }
  }

  const jobStateReply = (result: { state: string }) => ({ ...result, state: String(result.state).toLowerCase() })

  fastify.post('/products/:id/import/jobs/:jobId/apply', async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string }
    try {
      const { applyStoredJob, readJob, JobNotApplicableError } = await import('../services/pim/import-jobs.service.js')
      const loaded = await readJob(jobId)
      if (!loaded) return reply.code(404).send({ error: 'not_found', message: `No studio import job ${jobId}` })
      if (loaded.scope?.kind === 'channel' || loaded.cells.some(c => c.scope.kind === 'channel')) return reply.code(409).send({ error: 'account_identity_required', message: 'This legacy channel job has no account identity. Review explicit corrections through /products/catalog-transfer.' })
      const w = jobWriters(id, loaded.scope, loaded.market)
      return jobStateReply(await applyStoredJob({ jobId, ...w }))
    } catch (err) {
      const { JobNotApplicableError: JNA } = await import('../services/pim/import-jobs.service.js')
      if (err instanceof JNA) {
        return reply.code(409).send({ error: err.code, message: err.message, jobId, state: String(err.state).toLowerCase() })
      }
      return sendError(reply, err, request.log, { id, jobId })
    }
  })

  /**
   * #600(3) / D15.6 — revert an applied import.
   *
   * Per-cell CAS on the stored `after`: a cell edited since the import is
   * SKIPPED and recorded, never overwritten. A revert that discards someone's
   * later work without saying so is the failure an operator is least equipped
   * to notice, because the value simply looks older than they remember.
   */
  fastify.post('/products/:id/import/jobs/:jobId/revert', async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string }
    try {
      const { revertStoredJob, readJob, JobNotApplicableError } = await import('../services/pim/import-jobs.service.js')
      const loaded = await readJob(jobId)
      if (!loaded) return reply.code(404).send({ error: 'not_found', message: `No studio import job ${jobId}` })
      if (loaded.scope?.kind === 'channel' || loaded.cells.some(c => c.scope.kind === 'channel')) return reply.code(409).send({ error: 'account_identity_required', message: 'This legacy channel job has no account identity. Review explicit corrections through /products/catalog-transfer.' })
      const w = jobWriters(id, loaded.scope, loaded.market)
      return jobStateReply(await revertStoredJob({ jobId, currentOf: w.currentOf, writeCells: w.writeCells }))
    } catch (err) {
      const { JobNotApplicableError: JNA } = await import('../services/pim/import-jobs.service.js')
      if (err instanceof JNA) {
        return reply.code(409).send({ error: err.code, message: err.message, jobId, state: String(err.state).toLowerCase() })
      }
      return sendError(reply, err, request.log, { id, jobId })
    }
  })

  /**
   * D14.2 — remove ONE override key from a listing's `overrideData`.
   *
   * SC.1 had to delete W2's key with raw SQL because no API path existed: the
   * write path can SET an override and nothing could un-set one. A layer you can
   * write and cannot clear is a one-way door — the operator's only escape was a
   * DBA.
   *
   * CAS on the listing version, and the version bumps like any other
   * ChannelListing write (#542.3), so a client holding a stale token is refused
   * rather than silently clearing a key someone else has since changed.
   */
  fastify.delete('/products/:id/overrides/:fieldKey', async (request, reply) => {
    const { id, fieldKey } = request.params as { id: string; fieldKey: string }
    const q = request.query as Record<string, string | undefined>
    const expectedVersion = Number(q.expectedVersion)
    if (q.expectedVersion === undefined || !q.expectedVersion.trim() || !Number.isInteger(expectedVersion) || expectedVersion < 0)
      return reply.code(400).send({ error: 'An observed listing version is required.' })
    try {
      const destination = await resolveWorkspaceDestination({ productId: id, channel: q.channel ?? '', marketplace: q.market ?? q.marketplace ?? '', accountId: q.accountId, listingId: q.listingId, aliasKey: q.aliasKey ?? (q.listingId ? undefined : '') })
      const sheet = await getStudioSheet({ productId: id, scope: 'channel', channel: destination.channel, market: destination.marketplace, accountId: destination.accountId })
      const row = sheet.rows.find(row => row.id === id && (row.aliasId ?? '') === (destination.aliasKey ?? ''))
      const cell = row?.values[fieldKey] ?? Object.values(row?.values ?? {}).find(cell => cell.writeField === fieldKey)
      if (!cell?.editable || cell.writeTarget !== 'channelListing' || !cell.writeField)
        return reply.code(400).send({ error: 'This field is not an editable listing override. Use its owning editor.' })
      const result = await fastify.inject({ method: 'PATCH', url: '/api/products/bulk',
        headers: { ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}), ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) },
        payload: { expectedVersion, changes: [{ id, field: cell.writeField, value: null, intent: 'reset', target: 'channel' }],
          marketplaceContexts: [{ channel: destination.channel, marketplace: destination.marketplace, accountId: destination.accountId, aliasKey: destination.aliasKey ?? '' }] } })
      return reply.code(result.statusCode).send(result.json())
    } catch (err) { return sendError(reply, err, request.log, { id, fieldKey }) }
  })

  /**
   * #364 — the moments this record can actually be restored TO, newest first.
   *
   * Offered instead of a free timestamp: picking a moment where nothing changed
   * returns a no-op the operator cannot tell from a success. Each point says
   * which fields changed AND which of them `POST /restore` will actually write,
   * because that endpoint accepts master scalar columns only.
   */
  fastify.get('/products/:id/restore-points', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    try {
      return await getRestorePoints({ productId: id, limit: q.limit ? Number(q.limit) : undefined })
    } catch (err) {
      return sendError(reply, err, request.log, { id })
    }
  })

  fastify.get('/products/:id/sync-queue', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, unknown>
    const raw = String(q.filter ?? 'all').toLowerCase()
    if (!['all', 'dead', 'retrying', 'stuck'].includes(raw)) {
      return reply.code(400).send({ error: 'filter must be all | dead | retrying | stuck' })
    }
    try {
      return await getProductSyncQueue({
        productId: id,
        channel: q.channel ? String(q.channel).toUpperCase() : undefined,
        marketplace: q.market ? String(q.market).toUpperCase() : q.marketplace ? String(q.marketplace).toUpperCase() : undefined,
        accountId: q.accountId === undefined ? undefined : String(q.accountId),
        listingId: q.listingId === undefined ? undefined : String(q.listingId),
        filter: raw as SyncQueueFilter,
        limit: q.limit ? Number(q.limit) : undefined,
      })
    } catch (err) {
      return sendError(reply, err, request.log, { id, filter: raw })
    }
  })

  // ── Publish snapshots + restore-to-draft (D1 wave-1) ──────────────
  /**
   * The snapshots taken for one listing, newest first. Payloads are NOT
   * returned — a list of twenty full flat-file payloads is megabytes for a
   * panel that only renders when/why/who. `sizeBytes` carries the weight.
   */
  fastify.get('/products/:id/listings/:listingId/snapshots', async (request, reply) => {
    const { id, listingId } = request.params as { id: string; listingId: string }
    const q = request.query as Record<string, unknown>
    try {
      const destination = await resolveWorkspaceListing(id, listingId, q.accountId === undefined ? undefined : String(q.accountId))
      return { snapshots: await listSnapshots(listingId, q.limit ? Number(q.limit) : undefined, { productId: id, accountId: destination.accountId }) }
    } catch (err) {
      return sendError(reply, err, request.log, { listingId })
    }
  })

  /** An operator checkpoint. Publish-time capture is the publish path's job. */
  fastify.post('/products/:id/listings/:listingId/snapshots', async (request, reply) => {
    const { id, listingId } = request.params as { id: string; listingId: string }
    const body = (request.body ?? {}) as { label?: unknown; accountId?: string }
    try {
      const actor = (request as { authUser?: { id?: string } }).authUser?.id ?? null
      await resolveWorkspaceListing(id, listingId, body.accountId)
      const snap = await captureSnapshot({
        channelListingId: listingId,
        reason: 'manual',
        label: body.label ? String(body.label) : undefined,
        capturedBy: actor,
      })
      return reply.code(201).send({ id: snap.id, createdAt: snap.createdAt })
    } catch (err) {
      return sendError(reply, err, request.log, { listingId })
    }
  })

  /**
   * Restore a snapshot as a DRAFT. Writes the captured values back and sets
   * `isPublished = false` — the marketplace is NOT touched, and publishing the
   * restored state is a separate, explicitly gated action.
   *
   * The current state is auto-snapshotted first, so this is itself undoable;
   * `undoSnapshotId` in the response is that snapshot.
   */
  fastify.post('/products/:id/listings/:listingId/snapshots/:snapshotId/restore', async (request, reply) => {
    const { id, listingId, snapshotId } = request.params as { id: string; listingId: string; snapshotId: string }
    const body = (request.body ?? {}) as { accountId?: string; expectedVersion?: number }
    try {
      const actor = (request as { authUser?: { id?: string } }).authUser?.id ?? null
      const destination = await resolveWorkspaceListing(id, listingId, body.accountId)
      return await restoreToDraft({ snapshotId, restoredBy: actor, productId: id, listingId, accountId: destination.accountId, expectedVersion: body.expectedVersion })
    } catch (err) {
      return sendError(reply, err, request.log, { snapshotId })
    }
  })

  // ── Alias CRUD ────────────────────────────────────────────────────
  fastify.post('/products/:id/aliases', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { channel?: unknown; marketplace?: unknown; label?: unknown; accountId?: unknown }
    const channel = String(body.channel ?? '').trim().toUpperCase()
    const marketplace = String(body.marketplace ?? '').trim().toUpperCase()
    if (body.accountId !== undefined && (typeof body.accountId !== 'string' || !body.accountId.trim()))
      return reply.code(400).send({ error: 'accountId must identify a connected account when supplied' })
    if (!channel || !marketplace) {
      return reply.code(400).send({ error: 'channel and marketplace are required', hint: 'e.g. { channel: "EBAY", marketplace: "IT" }' })
    }
    try {
      const actor = (request as { authUser?: { id?: string } }).authUser?.id ?? null
      const alias = await createAlias({ productId: id, channel, marketplace, accountId: body.accountId ? String(body.accountId) : undefined, label: body.label ? String(body.label) : undefined, createdBy: actor })
      return reply.code(201).send(alias)
    } catch (err) {
      return sendError(reply, err, request.log, { id, channel, marketplace })
    }
  })

  fastify.patch('/products/:id/aliases/:aliasId', async (request, reply) => {
    const { id, aliasId } = request.params as { id: string; aliasId: string }
    const body = (request.body ?? {}) as { label?: unknown; position?: unknown; accountId?: unknown }
    if (body.accountId !== undefined && (typeof body.accountId !== 'string' || !body.accountId.trim()))
      return reply.code(400).send({ error: 'accountId must identify a connected account when supplied' })
    try {
      return await updateAlias(aliasId, {
        label: body.label !== undefined ? String(body.label) : undefined,
        position: body.position !== undefined ? Number(body.position) : undefined,
      }, { productId: id, accountId: body.accountId as string | undefined })
    } catch (err) {
      return sendError(reply, err, request.log, { id, aliasId })
    }
  })

  /**
   * ARCHIVE, not delete. These rows mirror listings that may still be live on
   * the marketplace; dropping the local record loses the only thing that knows
   * about them. A hard delete is a separate, explicit decision.
   */
  fastify.delete('/products/:id/aliases/:aliasId', async (request, reply) => {
    const { id, aliasId } = request.params as { id: string; aliasId: string }
    const q = request.query as { accountId?: unknown }
    if (q.accountId !== undefined && (typeof q.accountId !== 'string' || !q.accountId.trim()))
      return reply.code(400).send({ error: 'accountId must identify a connected account when supplied' })
    try {
      const alias = await archiveAlias(aliasId, { productId: id, accountId: q.accountId as string | undefined })
      return { archived: true, alias }
    } catch (err) {
      return sendError(reply, err, request.log, { id, aliasId })
    }
  })
}

export default productStudioRoutes
