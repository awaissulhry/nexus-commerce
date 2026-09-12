import { readPresentationDescription } from '../services/ebay-presentation-publication.service.js'
import { presentationDestination } from '../services/ebay-presentation-order.service.js'
import { MappingConflict } from '../services/pim/mapping/revision-token.js'
import { resolveBatch } from '../services/pim/mapping/resolve-batch.service.js'
import { resolveChannelConnectionId } from '../services/connection-resolver.service.js'
/**
 * ED.1/ED.2 — eBay description-theme CRUD + preview.
 *
 * Themes wrap the per-market body copy at push time (see
 * services/ebay-description-theme.service.ts). Preview renders exactly what a
 * push would send for a product × market, without touching eBay or the DB.
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import {
  listThemes,
  resolveFamilyRootId,
  setDefaultTheme,
  renderListingDescriptionSafe,
  galleryHashOfRows,
  evaluateDescriptionStaleness,
  resolveDescriptionMode,
} from '../services/ebay-description-theme.service.js'


export default async function ebayDescriptionThemesRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { productId: string; marketplace: string; accountId: string; aliasKey?: string } }>('/ebay/presentation-description', async request => {
    if (!request.query.accountId?.trim()) throw new MappingConflict('Choose an explicit account for the product preview')
    return readPresentationDescription(request.query)
  })
  // ── List (seeds the built-in starters on first call) ─────────────────────
  fastify.get<{ Querystring: { view?: string } }>('/ebay/description-themes', async (request, reply) => {
    if (request.query.view === 'options') {
      // Grid lookups need identity/state only. Reading names must not seed or update templates.
      const themes = await prisma.ebayDescriptionTheme.findMany({
        select: { id: true, name: true, active: true, isDefault: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      })
      return reply.send({ themes })
    }
    const themes = await listThemes(prisma)
    return reply.send({ themes })
  })

  // ── Usage — READ-ONLY counts of eBay listings per assigned theme (ED v2 P3) ─
  // Assignment lives in ChannelListing.platformAttributes.descriptionThemeId:
  // '' / absent → the default theme wraps it, 'none' → raw body on purpose,
  // any other string → that theme id. The column is untyped JSON, so grouping
  // happens in JS — the whole eBay listing set is small enough to scan on a
  // modal open. No eBay calls, no writes.
  //
  // DS-0 — optional ?marketplace= narrows to that market's region AND counts
  // by FAMILY ROOT (child listings don't inflate counts; the root's own row
  // wins because assignment lives on the family parent's CL). Absent param =
  // exactly the legacy all-listings behaviour.
  fastify.get<{ Querystring: { marketplace?: string; accountId?: string; aliasKey?: string; productId?: string } }>(
    '/ebay/description-themes/usage',
    async (request, reply) => {
      const marketplace = request.query.marketplace?.trim().toUpperCase() || undefined
      if (request.query.accountId !== undefined || request.query.aliasKey !== undefined || request.query.productId) {
        if (!marketplace) return reply.code(400).send({ error: 'Choose a market for destination usage' })
        const connectionId = await resolveChannelConnectionId('EBAY', request.query.accountId)
        const aliasKey = request.query.aliasKey ?? ''
        if (aliasKey && !request.query.productId) return reply.code(400).send({ error: 'Choose the product for this alternate listing' })
        const destination = request.query.productId ? await presentationDestination({ ...request.query, productId: request.query.productId, marketplace }) : null
        const roots = await prisma.channelListing.findMany({ where: { channel: 'EBAY', marketplace, channelConnectionId: connectionId, aliasKey, ...(destination ? { productId: destination.productId } : { product: { parentId: null, deletedAt: null } }) }, select: { productId: true } })
        const byThemeId: Record<string, number> = {}; let defaults = 0, raw = 0
        for (let offset = 0; offset < roots.length; offset += 100) {
          const resolved = await resolveBatch({ channel: 'EBAY', marketplace, channelConnectionId: connectionId, aliasKey, productIds: roots.slice(offset, offset + 100).map(r => r.productId), fieldKeys: ['descriptionThemeId'], includeCatalogue: false })
          for (const product of resolved.products) {
            const cell = product.cells.descriptionThemeId
            if (cell?.errors.length) return reply.code(409).send({ error: cell.errors.join('; ') })
            const id = cell?.value
            if (id === 'none') raw++; else if (typeof id === 'string' && id) byThemeId[id] = (byThemeId[id] ?? 0) + 1; else defaults++
          }
        }
        return { total: roots.length, default: defaults, raw, byThemeId, scope: destination ? 'selected listing' : 'selected account and market' }
      }

      const countAssignments = (attrsList: Iterable<Record<string, unknown>>) => {
        const byThemeId: Record<string, number> = {}
        let usingDefault = 0
        let raw = 0
        let total = 0
        for (const attrs of attrsList) {
          total += 1
          const v = typeof attrs.descriptionThemeId === 'string' ? attrs.descriptionThemeId : ''
          if (v === '') usingDefault += 1
          else if (v === 'none') raw += 1
          else byThemeId[v] = (byThemeId[v] ?? 0) + 1
        }
        return { total, default: usingDefault, raw, byThemeId }
      }

      if (!marketplace) {
        // Legacy: every eBay listing row, all markets, no root-resolve.
        const listings = await prisma.channelListing.findMany({
          where: { channel: 'EBAY' },
          select: { platformAttributes: true },
        })
        return reply.send(
          countAssignments(listings.map((l) => (l.platformAttributes ?? {}) as Record<string, unknown>)),
        )
      }

      const region = marketplace === 'UK' ? 'GB' : marketplace
      const listings = await prisma.channelListing.findMany({
        where: { channel: 'EBAY', region },
        select: { productId: true, platformAttributes: true },
      })

      // Batch FAMILY-ROOT resolve (same walk as the staleness endpoint, ≤3 hops).
      const parentOf = new Map<string, string | null>()
      let frontier = [...new Set(listings.map((l) => l.productId))]
      for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
        const prods = await prisma.product.findMany({
          where: { id: { in: frontier } },
          select: { id: true, parentId: true },
        })
        for (const p of prods) parentOf.set(p.id, p.parentId)
        frontier = [...new Set(
          prods
            .map((p) => p.parentId)
            .filter((pid): pid is string => !!pid && !parentOf.has(pid)),
        )]
      }
      const rootOf = (id: string): string => {
        let cur = id
        for (let hop = 0; hop < 3; hop++) {
          const up = parentOf.get(cur)
          if (!up) break
          cur = up
        }
        return cur
      }

      // ONE entry per family root: the root's own listing row wins (that is
      // the row the renderer reads the assignment from); a child row only
      // stands in when the root has no row for this market.
      const attrsByRoot = new Map<string, Record<string, unknown>>()
      for (const l of listings) {
        const root = rootOf(l.productId)
        if (l.productId === root || !attrsByRoot.has(root)) {
          attrsByRoot.set(root, (l.platformAttributes ?? {}) as Record<string, unknown>)
        }
      }
      return reply.send({ marketplace, ...countAssignments(attrsByRoot.values()) })
    },
  )

  // ── ED v2 P5 — description STALENESS, read-only (operator decision D8) ────
  // eBay HTML is static: a push renders theme+curation ONCE and the live
  // description never follows later edits. This endpoint compares each family's
  // descriptionPush stamp (written on successful deliveries) against the
  // CURRENT curated gallery + assigned theme version, so the modal can show a
  // stale badge with one-click re-push. Batch DB reads only — no eBay calls,
  // no writes, never an automatic re-push.
  fastify.get<{ Querystring: { productIds?: string; marketplace?: string; accountId?: string; aliasKey?: string } }>(
    '/ebay/description-themes/staleness',
    async (request, reply) => {
      const idsRaw = (request.query.productIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (idsRaw.length === 0) {
        return reply.code(400).send({ error: 'productIds required (comma-separated product ids)' })
      }
      const MAX_IDS = 200
      const ids = [...new Set(idsRaw)].slice(0, MAX_IDS)
      const marketplace = (request.query.marketplace ?? 'IT').toUpperCase()
      if (request.query.accountId !== undefined || request.query.aliasKey !== undefined) {
        const products = []
        for (const productId of ids) {
          const result = await readPresentationDescription({ productId, marketplace, accountId: request.query.accountId, aliasKey: request.query.aliasKey })
          const { html: _html, ...status } = result
          products.push(status)
        }
        return { marketplace, products }
      }
      const region = marketplace === 'UK' ? 'GB' : marketplace

      // Resolve each requested id to its FAMILY ROOT (stamps live on the
      // parent's ChannelListing) — batch walk, ≤3 hops like the push service.
      const parentOf = new Map<string, string | null>()
      let frontier = ids
      for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
        const prods = await prisma.product.findMany({
          where: { id: { in: frontier } },
          select: { id: true, parentId: true },
        })
        for (const p of prods) parentOf.set(p.id, p.parentId)
        frontier = [...new Set(
          prods
            .map((p) => p.parentId)
            .filter((pid): pid is string => !!pid && !parentOf.has(pid)),
        )]
      }
      const rootOf = (id: string): string => {
        let cur = id
        for (let hop = 0; hop < 3; hop++) {
          const up = parentOf.get(cur)
          if (!up) break
          cur = up
        }
        return cur
      }
      const roots = [...new Set(ids.map(rootOf))]

      const [listings, imageRows, themes] = await Promise.all([
        prisma.channelListing.findMany({
          where: { productId: { in: roots }, channel: 'EBAY', region },
          select: { productId: true, platformAttributes: true },
        }),
        prisma.listingImage.findMany({
          where: { productId: { in: roots }, platform: 'EBAY', mediaType: 'IMAGE' },
          select: { productId: true, variantGroupKey: true, variantGroupValue: true, url: true, position: true, publishStatus: true },
        }),
        prisma.ebayDescriptionTheme.findMany({
          select: { id: true, name: true, version: true, active: true, isDefault: true },
        }),
      ])

      const clByProduct = new Map<string, Record<string, unknown>>()
      for (const l of listings) {
        if (!clByProduct.has(l.productId)) {
          clByProduct.set(l.productId, (l.platformAttributes ?? {}) as Record<string, unknown>)
        }
      }
      const rowsByProduct = new Map<string, typeof imageRows>()
      for (const r of imageRows) {
        if (!rowsByProduct.has(r.productId)) rowsByProduct.set(r.productId, [])
        rowsByProduct.get(r.productId)!.push(r)
      }

      // Mirror of renderListingDescriptionSafe's theme resolution (incl. D7:
      // deleted/inactive assignment falls back to the active default).
      const defaultTheme = themes.find((t) => t.isDefault && t.active) ?? null
      const currentThemeFor = (attrs: Record<string, unknown>) => {
        const v = typeof attrs.descriptionThemeId === 'string' ? attrs.descriptionThemeId : ''
        if (v === 'none') return null
        const picked = v ? themes.find((t) => t.id === v) : undefined
        return picked && picked.active ? picked : defaultTheme
      }

      const products = ids.map((productId) => {
        const root = rootOf(productId)
        const attrs = clByProduct.get(root)
        const rows = rowsByProduct.get(root) ?? []
        const result = evaluateDescriptionStaleness({
          hasListing: !!attrs,
          stamp: attrs?.descriptionPush,
          currentGalleryHash: galleryHashOfRows(rows),
          currentTheme: attrs ? currentThemeFor(attrs) : null,
          hasDraftImageRows: rows.some((r) => r.publishStatus === 'DRAFT'),
        })
        return { productId, rootProductId: root, ...result }
      })

      return reply.send({ marketplace, products })
    },
  )

  fastify.post<{ Body: { name?: string; html?: string; notes?: string } }>(
    '/ebay/description-themes',
    async (request, reply) => {
      const { name, html, notes } = request.body ?? {}
      if (!name?.trim() || !html?.trim()) {
        return reply.code(400).send({ error: 'name and html are required' })
      }
      try {
        const theme = await prisma.ebayDescriptionTheme.create({
          data: { name: name.trim(), html, notes: notes ?? null },
        })
        return reply.send({ theme })
      } catch (err: any) {
        if (err?.code === 'P2002') return reply.code(409).send({ error: `A theme named "${name.trim()}" already exists` })
        throw err
      }
    },
  )

  fastify.put<{ Params: { id: string }; Body: { name?: string; html?: string; notes?: string; active?: boolean; expectedVersion?: number } }>(
    '/ebay/description-themes/:id',
    async (request, reply) => {
      const { id } = request.params
      const { name, html, notes, active, expectedVersion } = request.body ?? {}
      const existing = await prisma.ebayDescriptionTheme.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Theme not found' })
      // DS-0 — optimistic concurrency (opt-in): a stale editor's save loses
      // loudly instead of silently clobbering. Absent = legacy last-write-wins.
      if (typeof expectedVersion === 'number' && expectedVersion !== existing.version) {
        return reply
          .code(409)
          .send({ error: 'version conflict — theme was modified elsewhere', currentVersion: existing.version })
      }
      const theme = await prisma.ebayDescriptionTheme.update({
        where: { id, version: existing.version },
        data: {
          ...(name?.trim() ? { name: name.trim() } : {}),
          ...(typeof html === 'string' && html.trim() ? { html } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(typeof active === 'boolean' ? { active } : {}),
          version: { increment: 1 },
        },
      }).catch((error: { code?: string }) => {
        if (error.code === 'P2025') throw new MappingConflict('This theme changed while saving. Reload its current version before editing.')
        throw error
      })
      return reply.send({ theme })
    },
  )

  fastify.delete<{ Params: { id: string } }>('/ebay/description-themes/:id', async (request, reply) => {
    const existing = await prisma.ebayDescriptionTheme.findUnique({ where: { id: request.params.id } })
    if (!existing) return reply.code(404).send({ error: 'Theme not found' })
    if (existing.builtIn) {
      return reply.code(400).send({ error: 'Built-in starter themes can be edited or deactivated, not deleted' })
    }
    await prisma.ebayDescriptionTheme.delete({ where: { id: request.params.id } })
    // Listings referencing it by id simply fall back to the default at render.
    return reply.send({ ok: true })
  })

  fastify.post<{ Params: { id: string } }>('/ebay/description-themes/:id/default', async (request, reply) => {
    const id = request.params.id === 'none' ? null : request.params.id
    if (id) {
      const existing = await prisma.ebayDescriptionTheme.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Theme not found' })
    }
    await setDefaultTheme(prisma, id)
    return reply.send({ ok: true })
  })

  // ── Preview — render exactly what a push would send (no eBay, no writes) ──
  fastify.post<{
    Body: {
      productId?: string
      marketplace?: string
      sku?: string
      mode?: 'single' | 'group'
      body?: string
      title?: string
      themeId?: string
      /** ED.4 — preview an UNSAVED theme draft (rendered, never persisted). */
      themeHtml?: string
      accountId?: string
      aliasKey?: string
    }
  }>('/ebay/description-preview', async (request, reply) => {
    const { productId, marketplace = 'IT', sku, mode, body, title, themeId, themeHtml, accountId, aliasKey = '' } = request.body ?? {}
    if (!productId) return reply.code(400).send({ error: 'productId required' })
    // DS-0 — a child-row seed previews its FAMILY (per-market content, theme
    // assignment and galleries all live on the root's listing row, which is
    // exactly what a push renders). Root products resolve to themselves.
    const rootProductId = await resolveFamilyRootId(prisma, productId)
    if (accountId !== undefined && (typeof accountId !== 'string' || !accountId.trim())) return reply.code(400).send({ error: 'Choose a nonempty account ID' })
    if (typeof aliasKey !== 'string') return reply.code(400).send({ error: 'Invalid listing alias' })
    const connectionId = await resolveChannelConnectionId('EBAY', accountId)
    if (aliasKey) {
      const alias = await prisma.productListingAlias.findFirst({ where: { id: aliasKey, productId: rootProductId, channel: 'EBAY', marketplace: marketplace.toUpperCase(), channelConnectionId: connectionId, status: 'ACTIVE' }, select: { id: true } })
      if (!alias) return reply.code(400).send({ error: 'The listing alias does not belong to this product and destination' })
    }
    // DS-6 — when the caller doesn't force a mode, derive it the way the PUSH
    // service does. The old `= 'group'` default made the Studio preview a
    // standalone product with per-colour gallery sections that its push would
    // never send — a preview that lies about what goes live is worse than no
    // preview. resolveDescriptionMode is now that ONE shared derivation (it
    // also scores pool shells as 'group'; counting children alone hid the
    // Colori section on every adopted/shared-pool listing).
    const resolvedMode: 'single' | 'group' = mode ?? (await resolveDescriptionMode(prisma, rootProductId, undefined, { channelConnectionId: connectionId, aliasKey, marketplace: marketplace.toUpperCase() }))
    const resolved = await resolveBatch({ channel: 'EBAY', marketplace: marketplace.toUpperCase(), productIds: [rootProductId],
      channelConnectionId: connectionId, aliasKey, fieldKeys: ['description', 'title'], includeCatalogue: false })
    const cells = resolved.products[0]?.cells
    const contentErrors = [body === undefined && cells?.description, title === undefined && cells?.title].flatMap(cell => cell ? cell.errors : [])
    if (contentErrors.length) return reply.code(422).send({ error: contentErrors.join('; ') })
    const resolvedBody = body ?? String(cells?.description?.value ?? '')
    const result = await renderListingDescriptionSafe(prisma, {
      productId: rootProductId,
      channelConnectionId: connectionId, aliasKey,
      marketplace,
      mode: resolvedMode,
      sku,
      body: resolvedBody,
      title: title ?? (cells?.title?.value == null ? undefined : String(cells.title.value)),
      themeIdOverride: themeId,
      themeHtmlOverride: themeHtml,
    })
    // DS-0 — an empty per-market body is a WARNING, never an error: the theme
    // shell still renders so the operator sees the truth of what a push would
    // send (the push itself refuses empty bodies — see the push service).
    if (!resolvedBody.trim()) {
      result.warnings.push(`body: empty — no ${marketplace.toUpperCase()} listing content for this product`)
    }
    return reply.send(result)
  })
}
