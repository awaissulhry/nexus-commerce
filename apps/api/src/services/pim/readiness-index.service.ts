import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { beforeDatabaseCommit, inDatabaseTransaction } from '../../lib/database-context.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { withCachedSchemas } from './cached-schema-context.js'
// LX.F2 R-LX-17 — the ONE resolver, the same function the catalogue projection calls.
import { resolveContent } from './content-resolver.js'
import { marketLanguages } from './market-languages.js'
import { coordinatesFor, VARIATION_THEME_KEY } from './sheet-columns.service.js'
// VT.1b — the provenance mapper and the cell type live with the resolver; this file only reads them.
import { variationSourceFor, type VariationThemeCell } from './variation-rules.service.js'
import { readinessLanguages, readinessCoordinateKey, readinessFromSheet, type ReadinessCoordinate } from './readiness-model.js'

type ReadinessScope = { channel: string; market: string; accountId: string | null }

/** One family refresh per outer write, after cascades/formulas and before commit. */
export async function produceReadiness(productId: string, scope?: ReadinessScope) {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { id: true, parentId: true } })
  const rootId = product.parentId ?? product.id
  await beforeDatabaseCommit(`readiness:${rootId}${scope ? `:${JSON.stringify(scope)}` : ''}`, () => reconcileFamilyReadiness(rootId, scope))
}

/** The only materializer. Schema misses are honest absent rows; persistence failures roll back. */
export async function reconcileFamilyReadiness(productId: string, scope?: ReadinessScope): Promise<number> {
  return inDatabaseTransaction(prisma, () => withCachedSchemas(async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { id: true, parentId: true } })
    const rootId = product.parentId ?? product.id
    const [products, markets, accounts] = await Promise.all([
      // LX.F2 R-LX-17 — `translations` + `parent.translations` are loaded HERE, once per family, because the sort
      // projection below must come from the SAME `resolveContent()` call the catalogue's own projection makes
      // (`catalog-language.ts` `catalogLanguageValues`). Deriving it from the sheet cell instead would be a second
      // answer to "what does this cell say", and the two would drift the first time either changed.
      prisma.product.findMany({ where: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null },
        select: { id: true, parentId: true, name: true, description: true, bulletPoints: true, keywords: true, categoryAttributes: true, localizedContent: true,
          translations: true, parent: { select: { id: true, name: true, description: true, bulletPoints: true, keywords: true, categoryAttributes: true, localizedContent: true, translations: true } } } }),
      prisma.marketplace.findMany({ where: { isActive: true }, orderBy: [{ channel: 'asc' }, { code: 'asc' }] }),
      prisma.channelConnection.findMany({ where: { isActive: true }, select: { id: true, channelType: true, accountLabel: true, displayName: true } }),
    ])
    const languages = readinessLanguages(markets)
    const destinations: Array<{ coordinate: ReadinessCoordinate; language: string; label: string }> = languages.map(language => ({
      coordinate: { channel: null, market: null, accountId: null, aliasId: null }, language, label: 'Shared product',
    }))
    for (const market of markets) {
      const coordinate = coordinatesFor(market.code, [market])[0]
      if (!coordinate) continue
      const owners = accounts.filter(a => a.channelType === market.channel)
      for (const accountId of owners.length ? owners.map(a => a.id) : [null]) for (const language of marketLanguages(market.channel, market.code, [market])) {
        destinations.push({ coordinate: { channel: market.channel, market: market.code, accountId, aliasId: null }, language, label: `${coordinate.label}${owners.length > 1 ? ` · ${owners.find(a => a.id === accountId)?.accountLabel ?? owners.find(a => a.id === accountId)?.displayName ?? 'Connected account'}` : ''}` })
      }
    }
    const computedAt = new Date()
    /**
     * LX.F2 R-LX-17 — the SORT KEY for `title@<lang>` / `description@<lang>`, from the one resolver.
     * 🔴 It is a sort key, never a content read: nothing may serve these columns as a value. `null` (an
     * unresolvable field, or a language this product has nothing for) stays null so it sorts LAST rather
     * than first, and a description is cut to 512 characters — a sort key's business, not a content
     * decision, and enough that two rows only tie when their first 512 characters are identical.
     */
    const SORT_DESCRIPTION_CHARS = 512
    const sortProjection = (productId: string, language: string) => {
      const product = products.find(row => row.id === productId)
      if (!product) return { sortTitle: null, sortDescription: null }
      const text = (field: 'title' | 'description') => {
        const value = resolveContent({ product: product as never, parent: (product.parent ?? undefined) as never, field, address: { requested: language } }).value
        return typeof value === 'string' && value.length ? value : null
      }
      const description = text('description')
      return { sortTitle: text('title'), sortDescription: description ? description.slice(0, SORT_DESCRIPTION_CHARS) : null }
    }
    const rows: Prisma.ReadinessIndexCreateManyInput[] = []
    for (const { coordinate, language, label } of destinations) {
      // A listing edit cannot change shared content or another account/market.
      // Rebuilding every destination here made imports exceed their transaction deadline.
      if (scope && (coordinate.channel !== scope.channel || coordinate.market !== scope.market || coordinate.accountId !== scope.accountId)) continue
      let sheet: Awaited<ReturnType<typeof getStudioSheet>> | undefined
      let unavailable: string | undefined
      try {
        if (coordinate.channel && !coordinate.accountId) throw new Error('No active account for this destination.')
        sheet = await getStudioSheet({ productId: rootId, scope: coordinate.channel ? 'channel' : 'master', channel: coordinate.channel ?? undefined,
          market: coordinate.market ?? markets.find(m => m.code !== 'GLOBAL')?.code ?? 'IT', locale: language,
          accountId: coordinate.accountId ?? undefined, includeMapping: !!coordinate.channel })
      } catch (error) {
        // Business/schema availability is a readable state. Never swallow database failures.
        if (error instanceof TypeError || error instanceof ReferenceError || (error as { code?: string }).code?.startsWith('P')) throw error
        unavailable = error instanceof Error ? error.message : 'Requirements could not be checked.'
      }
      if (!sheet) {
        for (const product of products) rows.push({ productId: product.id, ...coordinate, coordinateKey: readinessCoordinateKey(coordinate), language, label,
          pct: null, state: 'absent', requiredFilled: 0, requiredTotal: 0, missing: [], note: unavailable, mappingRules: null,
          // R-LX-17 — the sort key does not depend on the sheet, so an unavailable destination still sorts.
          ...sortProjection(product.id, language), computedAt })
        continue
      }
      const market = markets.find(m => m.channel === coordinate.channel && m.code === coordinate.market)
      const mapping = market?.schemaMapping as { fields?: Record<string, unknown>; byProductType?: Record<string, Record<string, unknown>> } | null
      for (const row of sheet.rows) {
        const c = { ...coordinate, aliasId: row.aliasId }
        const summary = readinessFromSheet({ ...sheet, rows: [row], aliases: sheet.aliases.filter(a => a.id === row.aliasId) }, coordinate.channel ? new Set([
          ...Object.keys(mapping?.fields ?? {}), ...Object.keys(mapping?.byProductType?.[row.productType ?? ''] ?? {}),
        ]).size : null)
        // LX.F P2-14 — `kind` carries the FACT beside the sentence. Two readers
        // (the SQL filter and the fallback@<lang> projection) matched the prose
        // with `LIKE '%; showing % fallback.'` and `/; showing .+ fallback\.$/`,
        // which disagree on an empty language segment and both go false the day
        // the wording changes. They read this key now.
        const missing = row.readiness.issues.map(issue => ({ productId: row.id, field: issue.key,
          label: issue.label, reason: issue.message, ...(issue.kind ? { kind: issue.kind } : {}) }))
        // VT.1b (VT.4's request) — the variation-rule PROVENANCE for this coordinate, from the cell the sheet already
        // computed. It is the one thing `missing[].kind` cannot express: a CORRECT mapping raises no readiness item, so
        // `derived` / `rule` / `overridden` are invisible to the filter without a column. `unset` and `collides` stay in
        // `missing[].kind` — one fact, one home. `null` = NOT COMPUTED (a child row has no projection of its own), and it
        // must never be read as `derived`.
        const variationSource = variationSourceFor(
          row.values?.[VARIATION_THEME_KEY]?.value as VariationThemeCell | null | undefined,
        )
        rows.push({ productId: row.id, ...c, coordinateKey: readinessCoordinateKey(c), language, label: row.aliasId ? `${label} · ${sheet.aliases.find(a => a.id === row.aliasId)?.label ?? 'Listing customization'}` : label,
          pct: summary.pct, state: summary.state, requiredFilled: summary.required.filled, requiredTotal: summary.required.total,
          missing, note: summary.note, mappingRules: summary.mappingRules, variationSource,
          ...sortProjection(row.id, language), computedAt })
      }
    }
    // Only the derived index is replaced; content, versions and legacy bags are untouched.
    await prisma.readinessIndex.deleteMany({ where: { productId: { in: products.map(p => p.id) }, ...(scope ? { channel: scope.channel, market: scope.market, accountId: scope.accountId } : {}) } })
    if (rows.length) await prisma.readinessIndex.createMany({ data: rows })
    return rows.length
  }))
}
