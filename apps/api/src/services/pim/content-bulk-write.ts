import { currentFormulaWrite } from './mapping/formula-write-context.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { contentAddress, type ContentAddress } from '@nexus/shared/content-language'
import prisma from '../../db.js'
import { afterDatabaseCommit, inDatabaseTransaction } from '../../lib/database-context.js'
import { contentField, coordinateMatches, resolveContent } from './content-resolver.js'
import { contentListing } from './content-read.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { normalizeLanguage } from './content-language.js'
import { marketLanguages } from './market-languages.js'
import { resolveWriteRouting } from './studio-sheet.service.js'
import { coerceForShape, parseSlotField, withSlotValue } from './sheet-values.js'
import { writeContent } from './content-write.js'
import type { SheetColumn } from './sheet-columns.service.js'
import type { ProductBulkInput, ProductBulkContext } from '../products/bulk-edit.service.js'

type Change = ProductBulkInput['changes'][number]
const addressKey = (value: unknown, label: string) => {
  const address = contentAddress(value, label)
  return JSON.stringify(address.tier === 'source' ? ['source'] : address.tier === 'language' ? ['language', address.language]
    : ['pin', address.language, address.coordinate.channel, address.coordinate.market, address.coordinate.accountId ?? '', address.coordinate.aliasId ?? ''])
}
export interface ContentEdit { change: Change; column: SheetColumn }
export async function applyContentBulk(input: ProductBulkInput, context: ProductBulkContext, edits: ContentEdit[], facts: () => Promise<any>) {
  const errors: Array<{ id: string; field: string; error: string }> = []
  const plans: Array<{ edit: ContentEdit; address: ContentAddress; value: unknown; field: string; slot?: number; baseValue: unknown; listingId?: string; ownerVersion: number }> = []
  const contexts = input.marketplaceContexts ?? (input.marketplaceContext ? [input.marketplaceContext] : [])
  for (const edit of edits) {
    const { change, column } = edit
    try {
      const address = contentAddress(change.contentAddress, column.label)
      const scope = contexts[0], requested = normalizeLanguage(scope?.locale ?? (address.tier === 'source' ? PRIMARY_CONTENT_LOCALE : address.language))
      const field = contentField(column.slot?.of ?? column.key)
      const slot = parseSlotField(change.field)?.index ?? column.slot?.index
      if (change.intent === 'reset' && slot) throw new Error(`${column.label}: reset the whole list to preserve other slot overrides.`)
      const siblings = edits.filter(other => other !== edit && other.change.id === change.id
        && contentField(other.column.slot?.of ?? other.column.key) === field
        && addressKey(other.change.contentAddress, other.column.label) === addressKey(address, column.label))
      if (siblings.some(other => change.intent === 'reset' || other.change.intent === 'reset')) {
        throw new Error(`${column.label}: reset and edit this field separately.`)
      }
      if (contexts.length > 1) throw new Error(`${column.label} needs one language and coordinate per write.`)
      if (address.tier === 'source' ? requested !== PRIMARY_CONTENT_LOCALE : address.language !== requested) throw new Error(`${column.label} needs the ${requested} content address shown by the sheet.`)
      if (!column.editable) throw new Error(column.helpText || `${column.label} is read-only.`)
      const product = await prisma.product.findUniqueOrThrow({ where: { id: change.id }, include: { translations: true, parent: { include: { translations: true } } } })
      const coordinate = scope?.channel ? { channel: scope.channel, market: scope.marketplace, ...(scope.accountId ? { accountId: scope.accountId } : {}), ...('aliasKey' in scope && typeof scope.aliasKey === 'string' && scope.aliasKey ? { aliasId: scope.aliasKey } : {}) } : undefined
      let listing: any = null, listingVersion: number | undefined
      if (coordinate) {
        const listings = await prisma.channelListing.findMany({ where: { productId: product.id, channel: coordinate.channel, marketplace: coordinate.market,
          ...(coordinate.accountId ? { channelConnectionId: coordinate.accountId } : {}), aliasKey: coordinate.aliasId ?? '' }, include: { translations: true } })
        if (listings.length !== 1) throw new Error(`${column.label} needs one existing listing and account.`)
        listingVersion = listings[0].version
        listing = contentListing(product, listings[0], coordinate, await marketLanguages(coordinate.channel, coordinate.market))
      }
      const resolved = resolveContent({ product: product as any, parent: product.parent as any, listing, field, localizableKeys: [field], address: { requested, ...(coordinate ? { coordinate } : {}) } })
      const routing = resolveWriteRouting(column, coordinate ?? null, coordinate?.aliasId ?? null, { requested, primary: PRIMARY_CONTENT_LOCALE,
        resolved: { ...resolved, follows: resolved.tier === 'pin' ? resolved.follows ?? false : true }, market: coordinate?.market, accountId: coordinate?.accountId })
      if (address.tier === 'pin' && (!coordinate || !coordinateMatches(address.coordinate, coordinate))) throw new Error(`${column.label} needs the listing coordinate shown by the sheet.`)
      if (coordinate && change.contentAcknowledged !== true && (routing.contentAddress === null || address.tier !== 'pin')) {
        // LX.F P2-12 — the `!` here was safe only because `studio-sheet.service.ts:1418`
        // synthesises an address for the legacy-branch case three files away, so a
        // caller reading THIS file could not see why it could not throw a TypeError.
        // Fail closed with the column named, exactly as every other refusal does.
        const acknowledgement = routing.contentAcknowledgement
        if (!acknowledgement) throw new Error(`${column.label} has no shared/pin choice on this coordinate; reload the sheet before saving it.`)
        throw new Error(`${column.label} needs a choice: ${acknowledgement.shared.label} or ${acknowledgement.pin.label}.`)
      }
      const checked = coerceForShape({ ...column, shape: slot ? 'scalar' : column.shape }, change.value)
      if (checked.ok === false) throw new Error(checked.error)
      const value = checked.value
      plans.push({ edit, address, value, field, slot, baseValue: resolved.value, listingId: listing?.id, ownerVersion: address.tier === 'pin' ? listingVersion! : product.version })
    } catch (error) { errors.push({ id: change.id, field: change.field, error: error instanceof Error ? error.message : String(error) }) }
  }
  if (errors.length) return { success: false, updated: 0, errors }
  if (input.dryRun) return { success: true, dryRun: true, updated: 0, validated: plans.length, errors: [] }
  return inDatabaseTransaction(prisma, async () => {
    const groups = new Map<string, typeof plans>()
    for (const plan of plans) { const key = `${plan.edit.change.id}:${JSON.stringify(plan.address)}`; groups.set(key, [...(groups.get(key) ?? []), plan]) }
    const ownerVersions = new Map<string, number>()
    let currentVersion: number | undefined, versionOf: 'product' | 'channelListing' = 'product'
    for (const group of groups.values()) {
      const first = group[0], change = first.edit.change
      const values: Record<string, unknown> = {}
      for (const plan of group.filter(p => p.edit.change.intent !== 'reset')) values[plan.field] = plan.slot ? withSlotValue(values[plan.field] ?? plan.baseValue, plan.slot, plan.value) : plan.value
      const reset = group.filter(p => p.edit.change.intent === 'reset').map(p => p.field)
      const ownerKey = first.address.tier === 'pin' ? `listing:${first.listingId}` : `product:${change.id}`
      await writeContent({ productId: change.id, address: first.address, values, reset, label: first.edit.column.label, state: change.contentState,
        expectedVersion: ownerVersions.get(ownerKey) ?? input.expectedVersion ?? first.ownerVersion, expectedContentVersion: change.contentVersion, userId: context.userId, ip: context.ip ?? undefined })
      versionOf = first.address.tier === 'pin' ? 'channelListing' : 'product'
      const owner = versionOf === 'channelListing' ? await prisma.channelListing.findUniqueOrThrow({ where: { id: first.listingId! }, select: { version: true } }) : await prisma.product.findUniqueOrThrow({ where: { id: change.id }, select: { version: true } })
      currentVersion = owner.version
      ownerVersions.set(ownerKey, owner.version)
    }
    const formulaWrite = currentFormulaWrite(context.formulaWriteToken)
    if (formulaWrite) {
      if (edits.length !== 1 || edits[0].change.id !== formulaWrite.productId || edits[0].change.field !== formulaWrite.writeField) throw new Error('Formula transaction does not match its value write.')
      formulaWrite.results = []
      for (const operation of formulaWrite.operations?.() ?? []) formulaWrite.results.push(await operation)
    }
    const rest = await facts()
    if (!context.formulaCascade) {
      const { reevaluateDependents } = await import('./mapping/cell-formula.service.js')
      for (const group of groups.values()) {
        const first = group[0], address = first.address
        await reevaluateDependents({ productId: first.edit.change.id, changedFields: group.map(plan => plan.edit.change.field), updatedBy: context.userId,
          ...(address.tier === 'pin' ? { coordinate: { channel: address.coordinate.channel, marketplace: address.coordinate.market, channelConnectionId: address.coordinate.accountId, aliasKey: address.coordinate.aliasId, locale: address.language } } : {}) })
      }
    }
    const ids = [...new Set(edits.map(edit => edit.change.id))]
    await afterDatabaseCommit(`product-cache:${ids.slice().sort().join(',')}`, () => productReadCacheService.refreshMany(ids))
    return { ...rest, success: true, updated: plans.length + (rest.updated ?? 0), currentVersion: rest.currentVersion ?? currentVersion, versionOf: rest.versionOf ?? versionOf, errors: rest.errors ?? [] }
  })
}
