import { currentFormulaWrite } from './mapping/formula-write-context.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { contentAddress, type ContentAddress } from '@nexus/shared/content-language'
import prisma from '../../db.js'
import { activeDatabaseTransaction, afterDatabaseCommit, inDatabaseTransaction } from '../../lib/database-context.js'
import { contentField, coordinateMatches, resolveContent } from './content-resolver.js'
import { contentListing } from './content-read.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { normalizeLanguage } from './content-language.js'
import { marketLanguages } from './market-languages.js'
import { resolveWriteRouting } from './studio-sheet.service.js'
import { checkForStorage, parseSlotField, withSlotValue } from './sheet-values.js'
import { writeContent } from './content-write.js'
import { DraftListingError, ensureDraftListings } from './draft-listing.service.js'
import type { SheetColumn } from './sheet-columns.service.js'
import type { ProductBulkInput, ProductBulkContext } from '../products/bulk-edit.service.js'

type Change = ProductBulkInput['changes'][number]
const addressKey = (value: unknown, label: string) => {
  const address = contentAddress(value, label)
  return JSON.stringify(address.tier === 'source' ? ['source'] : address.tier === 'language' ? ['language', address.language]
    : ['pin', address.language, address.coordinate.channel, address.coordinate.market, address.coordinate.accountId ?? '', address.coordinate.aliasId ?? ''])
}
export interface ContentEdit { change: Change; column: SheetColumn }
export async function applyContentBulk(input: ProductBulkInput, context: ProductBulkContext, edits: ContentEdit[], facts: () => Promise<any>,
  priorErrors: Array<{ id: string; field: string; error: string }> = [], priorWarnings: Array<{ id: string; field: string; warning: string }> = []) {
  const errors: Array<{ id: string; field: string; error: string }> = [...priorErrors]
  /** P1 (`value-verdict.ts`) — a stored value with a problem (a title over the channel's limit), and its reason. */
  const warnings: Array<{ id: string; field: string; warning: string }> = [...priorWarnings]
  const withWarnings = (rest: { warnings?: typeof warnings }) => { const all = [...warnings, ...(rest.warnings ?? [])]; return all.length ? { warnings: all } : {} }
  // `draft`: a PIN on a coordinate where the product has no listing yet — its draft is started when the write runs.
  const plans: Array<{ edit: ContentEdit; address: ContentAddress; value: unknown; field: string; slot?: number; baseValue: unknown; listingId?: string; ownerVersion: number; draft?: true }> = []
  const contexts = input.marketplaceContexts ?? (input.marketplaceContext ? [input.marketplaceContext] : [])
  const { ProductBulkError } = await import('../products/bulk-edit.service.js')
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
      // Product-sheet create path, step 3 — only a PIN is the listing's own content. A shared or language-tier write from
      // a channel scope never touches the listing, so it needs none (it resolves from the shared tiers). A pin on the
      // primary listing of a coordinate with no row starts that draft when the write runs (`ensureDraftListings`);
      // version 0 means "I saw no listing", so it is a conflict against a listing that exists.
      let listing: any = null, listingVersion: number | undefined, draft = false
      if (coordinate && address.tier === 'pin') {
        const listings = await prisma.channelListing.findMany({ where: { productId: product.id, channel: coordinate.channel, marketplace: coordinate.market,
          ...(coordinate.accountId ? { channelConnectionId: coordinate.accountId } : {}), aliasKey: coordinate.aliasId ?? '' }, include: { translations: true } })
        if (listings.length === 1 && input.expectedVersion === 0) throw new ProductBulkError(409, { code: 'VERSION_CONFLICT',
          error: 'Another change landed first on this listing — refresh the scope to pick up the latest version.', expectedVersion: 0, currentVersion: listings[0].version, listingId: listings[0].id, versionOf: 'channelListing' })
        draft = listings.length === 0 && !coordinate.aliasId
        if (listings.length !== 1 && !draft) throw new Error(`${column.label} needs one existing listing and account.`)
        if (!draft) {
          listingVersion = listings[0].version
          listing = contentListing(product, listings[0], coordinate, await marketLanguages(coordinate.channel, coordinate.market))
        }
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
      // P1 — only what the field's type cannot hold is refused; a length or a list problem is stored and flagged.
      const checked = checkForStorage({ ...column, shape: slot ? 'scalar' : column.shape }, change.value)
      if (checked.ok === false) throw new Error(checked.error)
      const value = checked.value
      for (const found of checked.findings) warnings.push({ id: change.id, field: change.field, warning: found.message })
      plans.push({ edit, address, value, field, slot, baseValue: resolved.value, listingId: listing?.id, ownerVersion: address.tier === 'pin' ? listingVersion! : product.version, ...(draft ? { draft: true as const } : {}) })
    } catch (error) {
      if (error instanceof ProductBulkError) throw error
      errors.push({ id: change.id, field: change.field, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // R-60 — per row only on the sheet's opt-in (never inside a formula write, which is one value by construction).
  const perRow = context.contentPerRow === true && !currentFormulaWrite(context.formulaWriteToken)
  if (errors.length && !perRow) return { success: false, updated: 0, errors }
  if (perRow && !plans.length) {
    if (input.dryRun) return { success: false, dryRun: true, updated: 0, validated: 0, errors }
    const rest = await inDatabaseTransaction(prisma, () => facts())
    const updated = rest.updated ?? 0
    return { ...rest, success: updated > 0, updated, errors: [...errors, ...(rest.errors ?? [])], ...withWarnings(rest) }
  }
  if (input.dryRun) return { success: true, dryRun: true, updated: 0, validated: plans.length, errors: perRow ? errors : [], ...withWarnings({}) }
  return inDatabaseTransaction(prisma, async () => {
    const groups = new Map<string, typeof plans>()
    for (const plan of plans) { const key = `${plan.edit.change.id}:${JSON.stringify(plan.address)}`; groups.set(key, [...(groups.get(key) ?? []), plan]) }
    const ownerVersions = new Map<string, number>()
    const createdListings: Array<{ productId: string; listingId: string }> = []
    const refused = new Set<typeof plans>()
    let currentVersion: number | undefined, versionOf: 'product' | 'channelListing' = 'product'
    // The content row each write moved (a pin's listing translation, a shared language's product translation) and the
    // version it holds now: every cell on that row carries it as its token, so the sheet's NEXT edit there chains without
    // waiting for a read (the P3 commit sweep, 2026-09-30: a second bullet save was refused as "changed").
    const contentVersions: Array<{ id: string; tier: 'pin' | 'language'; language: string; version: number }> = []
    for (const group of groups.values()) {
      const first = group[0], change = first.edit.change
      if (first.draft && !first.listingId) {
        // The pin's listing does not exist yet: start its draft (the family's parent and variants) in this transaction.
        const c = (first.address as Extract<ContentAddress, { tier: 'pin' }>).coordinate
        try {
          const ensured = await ensureDraftListings(activeDatabaseTransaction()!, { channel: c.channel, market: c.market, accountId: c.accountId ?? null, productIds: [change.id], family: true })
          for (const row of ensured) if (row.created) createdListings.push({ productId: row.productId, listingId: row.id })
          const own = ensured.find(row => row.productId === change.id)!
          ownerVersions.set(`listing:${own.id}`, own.version)
          for (const plan of group) plan.listingId = own.id
        } catch (error) {
          // No account, an inactive market: that row's own refusal, never a 500 (all-or-nothing callers fail whole).
          if (!(error instanceof DraftListingError) || error.code === 'COORDINATE_TAKEN' || !perRow) throw error
          for (const plan of group) errors.push({ id: plan.edit.change.id, field: plan.edit.change.field, error: error.message })
          refused.add(group)
          continue
        }
      }
      const values: Record<string, unknown> = {}
      for (const plan of group.filter(p => p.edit.change.intent !== 'reset')) values[plan.field] = plan.slot ? withSlotValue(values[plan.field] ?? plan.baseValue, plan.slot, plan.value) : plan.value
      const reset = group.filter(p => p.edit.change.intent === 'reset').map(p => p.field)
      const ownerKey = first.address.tier === 'pin' ? `listing:${first.listingId}` : `product:${change.id}`
      const written = await writeContent({ productId: change.id, address: first.address, values, reset, label: first.edit.column.label, state: change.contentState,
        expectedVersion: ownerVersions.get(ownerKey) ?? input.expectedVersion ?? first.ownerVersion, expectedContentVersion: change.contentVersion, userId: context.userId, ip: context.ip ?? undefined })
      const writtenVersion = (written as { version?: unknown } | null)?.version
      if (first.address.tier !== 'source' && typeof writtenVersion === 'number') contentVersions.push({ id: change.id, tier: first.address.tier, language: first.address.language, version: writtenVersion })
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
        if (refused.has(group)) continue
        const first = group[0], address = first.address
        await reevaluateDependents({ productId: first.edit.change.id, changedFields: group.map(plan => plan.edit.change.field), updatedBy: context.userId,
          ...(address.tier === 'pin' ? { coordinate: { channel: address.coordinate.channel, marketplace: address.coordinate.market, channelConnectionId: address.coordinate.accountId, aliasKey: address.coordinate.aliasId, locale: address.language } } : {}) })
      }
    }
    const ids = [...new Set([...edits.map(edit => edit.change.id), ...createdListings.map(row => row.productId)])]
    await afterDatabaseCommit(`product-cache:${ids.slice().sort().join(',')}`, () => productReadCacheService.refreshMany(ids))
    // The drafts this save started, with the version each holds now, so the sheet adopts them at once.
    const created = createdListings.length ? await prisma.channelListing.findMany({ where: { id: { in: createdListings.map(row => row.listingId) } }, select: { id: true, version: true } }) : []
    const createdOut = [...createdListings.map(row => ({ ...row, version: created.find(r => r.id === row.listingId)?.version ?? null })), ...(rest.createdListings ?? [])]
    const skipped = [...refused].reduce((n, group) => n + group.length, 0)
    return { ...rest, success: true, updated: plans.length - skipped + (rest.updated ?? 0), ...(createdOut.length ? { createdListings: createdOut } : {}),
      ...(contentVersions.length ? { contentVersions } : {}),
      currentVersion: rest.currentVersion ?? currentVersion, versionOf: rest.versionOf ?? versionOf, errors: perRow ? [...errors, ...(rest.errors ?? [])] : rest.errors ?? [], ...withWarnings(rest) }
  })
}
