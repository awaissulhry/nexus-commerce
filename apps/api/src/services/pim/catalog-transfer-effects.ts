import { projectContentWrites } from './catalog-transfer-content.js'
import { normalizeLanguage } from './content-language.js'
import { resolveContent, translationMissing } from './content-resolver.js'
import { contentListing, contentWireValue } from './content-read.js'
import prisma from '../../db.js'
import { resolveAttributes, type ProductLike } from './attribute-resolver.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'
import { projectCellValue } from './sheet-values.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { marketLanguages } from './market-languages.js'
import type { TransferContext, TransferContracts, TransferPlan, TransferTarget } from './catalog-transfer-plan.js'

/** Resolve the planner's in-memory patches through the same read rules used by the sheets. */
export async function enrichTransferEffects(jobId: string, plan: TransferPlan, context: TransferContext, contracts: TransferContracts, market: string) {
  const changed = plan.targets.filter(t => t.cells.some(c => c.verdict === 'changed'))
  if (!changed.length) return
  const products = [...context.products.values()]
  const earlier = await prisma.importJobRow.findMany({ where: { jobId, targetId: { in: products.map(p => JSON.stringify(['Products', p.sku])) }, status: 'REVIEWED' }, select: { parsedValues: true } })
  const sharedTargets = [...earlier.flatMap(r => {
    const target = (r.parsedValues as unknown as { target?: TransferTarget }).target
    return target ? [target] : []
  }), ...plan.targets.filter(t => t.identity.entity === 'Products')]
  const patches = Object.fromEntries(sharedTargets.flatMap(t => t.before ? [[String(t.before.id), t.patch]] : []))
  const beforeById = new Map(products.map(p => [p.id, p]))
  const afterById = new Map(products.map(p => [p.id, projectContentWrites({ ...p, ...patches[p.id] }, sharedTargets.filter(t => t.before?.id === p.id).flatMap(t => t.contentWrites ?? []))]))
  const groups = new Map<string, TransferTarget[]>()
  for (const target of changed) {
    const id = target.identity, product = context.products.get(id.sku)
    if (!product) continue
    if (id.entity !== 'Products') {
      const key = JSON.stringify([id.channel, id.accountId, id.marketplace, id.aliasKey])
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(target)
      continue
    }
    const columns = await contracts.master(product.familyId, product)
    const cache = new Map<string, ReturnType<typeof resolveAttributes>>()
    for (const cell of target.cells.filter(c => c.verdict === 'changed')) {
      const column = columns.find(c => c.key === cell.field || c.key === 'name' && cell.field === 'title')
      if (!column) continue
      cell.label = column.label
      for (const side of ['Before', 'After'] as const) {
        const state = side === 'Before' ? cell.beforeState : cell.afterState
        const stored = side === 'Before' ? cell.before : cell.after
        const graph = side === 'Before' ? beforeById : afterById
        const current = graph.get(product.id)!, parent = current.parentId ? graph.get(current.parentId) ?? null : null
        const locale = normalizeLanguage(cell.locale || PRIMARY_CONTENT_LOCALE)
        const key = JSON.stringify([side, locale])
        if (!cache.has(key)) cache.set(key, resolveAttributes({ product: current as unknown as ProductLike, parent: parent as unknown as ProductLike | null, locale, localizableKeys: columns.filter(c => c.storage === 'localizedContent').map(c => c.key) }))
        const hit = cache.get(key)![cell.field === 'name' ? 'title' : cell.field]
        const value = state === 'stored' ? stored : hit?.value ?? null
        cell[`effective${side}`] = { value: contentWireValue(projectCellValue(column, value), column.slot ? undefined : column.shape), source: cell.locale && state !== 'stored' && hit?.language && translationMissing(hit, locale) ? `${locale} translation missing; showing ${hit.language} source` : state === 'stored' ? cell.locale ? `Stored ${cell.locale} content` : 'Shared product value'
          : hit?.inheritedFrom && parent && hit.inheritedFrom.startsWith(parent.id) ? `Inherited from ${parent.sku}` : hit ? `Inherited · ${hit.source}` : 'No inherited value' }
      }
    }
  }
  for (const targets of groups.values()) {
    const id = targets[0].identity
    for (const target of targets) {
      const contentCells = target.cells.filter(c => c.verdict === 'changed' && target.contentFields?.[c.field])
      if (!contentCells.length) continue
      const languages = await marketLanguages(id.channel, id.marketplace)
      const coordinate = { channel: id.channel, market: id.marketplace, accountId: id.accountId, ...(id.aliasKey ? { aliasId: id.aliasKey } : {}) }
      const product = context.products.get(target.identity.sku)!
      for (const side of ['Before', 'After'] as const) {
        const graph = side === 'Before' ? beforeById : afterById
        const owner = graph.get(product.id)!, parent = owner.parentId ? graph.get(owner.parentId) ?? owner.parent : null
        const listing = side === 'Before' ? target.before : projectContentWrites({ ...target.before, ...target.patch }, target.contentWrites ?? [])
        for (const cell of contentCells) {
          const resolved = resolveContent({ product: owner as any, parent: parent as any, listing: contentListing(owner, listing, coordinate, languages), field: target.contentFields![cell.field], localizableKeys: Object.values(target.contentFields ?? {}), address: { requested: normalizeLanguage(cell.locale || languages[0]), coordinate } })
          cell[`effective${side}`] = { value: resolved.value, source: `${resolved.language} · ${resolved.tier}${resolved.language !== (cell.locale || languages[0]) ? ' fallback' : ''}` }
        }
      }
    }
    const productIds = targets.map(t => context.products.get(t.identity.sku)!.id)
    const fieldKeys = [...new Set(targets.flatMap(t => t.cells.filter(c => c.verdict === 'changed' && !t.contentFields?.[c.field] && !['productType', 'categoryId'].includes(c.field)).map(c => c.field)))]
    if (!fieldKeys.length) continue
    const input = { channel: id.channel, channelConnectionId: id.accountId, marketplace: id.marketplace, aliasKey: id.aliasKey, productIds, fieldKeys, includeCatalogue: false }
    try {
      const before = await resolveBatch(input)
      const after = await resolveBatch({ ...input, productChangesByProduct: patches, listingChangesByProduct: Object.fromEntries(targets.map(t => [context.products.get(t.identity.sku)!.id, t.patch])) })
      const beforeByProduct = new Map(before.products.map(p => [p.productId, p])), afterByProduct = new Map(after.products.map(p => [p.productId, p]))
      for (const target of targets) for (const cell of target.cells.filter(c => c.verdict === 'changed' && !target.contentFields?.[c.field])) {
        const productId = context.products.get(target.identity.sku)!.id
        for (const [side, result] of [['Before', beforeByProduct.get(productId)], ['After', afterByProduct.get(productId)]] as const) {
          const hit = result?.cells[cell.field] ?? Object.values(result?.cells ?? {}).find(c => c.fieldKey === cell.field)
          if (!hit) continue
          cell.label = hit.label ?? cell.label
          const sources: Record<string, string> = { override: 'Listing override', missing: 'No resolved value', fallback: 'Inherited product value', catalogRule: 'Channel mapping rule', linked: 'Linked product value', default: 'Configured default', locked: 'Locked listing value' }
          cell[`effective${side}` as 'effectiveBefore' | 'effectiveAfter'] = { value: hit.value ?? null, source: sources[hit.provenance ?? ''] ?? 'Resolved product value' }
        }
      }
    } catch {
      plan.warnings.push(`${id.channel} ${id.marketplace}: effective values could not be resolved for this review. Stored changes remain visible; check the updated grid before publishing.`)
    }
  }
}
