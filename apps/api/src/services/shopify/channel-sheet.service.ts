import { informationRestriction, applyInformationCells } from '@nexus/shared/shopify-information-editing'
import { active, projectShopifyChannelSheet, shopifyCellToken } from './channel-sheet-projection.js'
import { z } from 'zod'
import prisma from '../../db.js'
import { informationRegistry, informationSheetValue, informationPendingValue, informationStoredValue, mediaOrderEditSchema, nativeSchemaError,
  type InformationField, type InformationRow, type InformationSnapshot, type ShopifySheetWrite } from '@nexus/shared/shopify-information'
import { shopifyLinkedDraftSchema, type ShopifyLinkedDraft, type ShopifyLinkedWorkspace, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { StudioSheet, StudioRow } from '../pim/studio-sheet.service.js'
import { getStudioSheet } from '../pim/studio-sheet.service.js'
import { readShopifyMappingSchema } from '../pim/channel-specs/shopify.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { contentDestination, object, PUBLISH_KEY, type ContentScope } from './content-workspace.service.js'
import { shopifyAdmin } from './admin-client.js'
import { readInformation } from './information-gateway.js'
import { AUTOMATION_KEY, LINKED_KEY, getLinkedWorkspace, linkedState, linkedTransaction, writeLinkedState } from './linked-products.service.js'

export async function enrichShopifyChannelSheet(page: StudioSheet): Promise<StudioSheet> {
  if (page.scope.channel !== 'SHOPIFY' || !page.scope.connectionId) return page
  const accountId = page.scope.connectionId
  const schema = await readShopifyMappingSchema(accountId)
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: page.rows.map(r => r.id) }, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: accountId }, select: { id: true, productId: true, externalListingId: true, platformAttributes: true, aliasKey: true } })
  const result = { ...page, rows: [...page.rows] }
  for (const alias of page.aliases) {
    const owned = listings.filter(l => l.aliasKey === (alias.id ?? ''))
    const root = owned.find(l => l.productId === page.family.id) ?? owned[0]
    if (!root) continue
    const scope = { accountId, listingId: root.id, market: 'GLOBAL' as const, locale: page.scope.locale }
    const workspace = await getLinkedWorkspace(page.family.id, scope)
    const ids = workspace.draft.members.length ? workspace.draft.members.map(m => m.id) : workspace.suggestedProductIds
    if (!ids.length) continue
    const { graphql } = await shopifyAdmin(accountId)
    const snapshot = await readInformation(graphql, ids, schema, page.scope.locale)
    const rows = projectShopifyChannelSheet(page, workspace, snapshot, schema, owned, alias.id)
    result.rows = [...result.rows.filter(r => r.aliasId !== alias.id), ...rows]
  }
  result.aliases = result.aliases.map(alias => {
    const rows = result.rows.filter(row => row.aliasId === alias.id), issues = rows.flatMap(row => row.readiness.issues)
    const required = rows.reduce((sum, row) => ({ filled: sum.filled + row.completeness.required.filled, total: sum.total + row.completeness.required.total }), { filled: 0, total: 0 })
    const errors = issues.filter(issue => issue.severity === 'error').length
    const head = rows.find(row => row.id === page.family.id) ?? rows[0]
    return { ...alias, isPublished: head?.listing?.isPublished ?? alias.isPublished, listingStatus: head?.listing?.listingStatus ?? alias.listingStatus, readiness: { percent: required.total ? Math.round(100 * required.filled / required.total) : null, errors, warnings: issues.length - errors,
      rowsMissingRequired: rows.filter(row => row.completeness.required.missing.length).length,
      state: errors ? 'errors' as const : issues.length ? 'missing' as const : 'ready' as const } }
  })
  // Column capability is shared by the chooser; per-owner capability remains on each cell.
  result.columns = result.columns.map(column => column.shopifyField ? { ...column, editable: result.rows.some(r => r.values[column.key]?.editable), writable: result.rows.some(r => r.values[column.key]?.writable) } : column)
  const cells = result.rows.flatMap(r => Object.values(r.values))
  result.counts = { ...result.counts, total: cells.length, filled: cells.filter(c => c.value !== null).length, empty: cells.filter(c => c.value === null).length, notWritable: cells.filter(c => !c.writable).length, pinned: cells.filter(c => c.pinned).length }
  return result
}

export const shopifySheetChangesSchema = z.object({ cells: z.array(z.object({ contentAddress: z.unknown().optional(), colId: z.string().min(1), ownerId: z.string().min(1), fieldId: z.string().min(1), token: z.string().min(1), baseline: z.string().nullable(), value: z.string().nullable(), intent: z.enum(['set', 'pin', 'reset', 'reset-list']) })).min(1).max(1000) }).strict().superRefine((input, ctx) => {
  const columns = new Set<string>(), addresses = new Map<string, string>()
  input.cells.forEach((cell, index) => {
    const address = JSON.stringify([cell.ownerId, cell.fieldId]), intent = JSON.stringify([cell.intent, cell.value])
    if (columns.has(cell.colId) || addresses.has(address) && addresses.get(address) !== intent) ctx.addIssue({ code: 'custom', path: ['cells', index], message: 'This batch contains conflicting edits for the same cell. Apply those changes separately.' })
    columns.add(cell.colId); addresses.set(address, intent)
  })
})
export async function saveShopifySheetCells(productId: string, scope: ContentScope & { locale?: string }, body: unknown, actorUserId: string | null) {
  const input = shopifySheetChangesSchema.parse(body), destination = await contentDestination(productId, scope)
  const observed = await getLinkedWorkspace(productId, scope), schema = await readShopifyMappingSchema(destination.accountId, true)
  const ids = observed.draft.members.length ? observed.draft.members.map(m => m.id) : observed.suggestedProductIds
  const { graphql } = await shopifyAdmin(destination.accountId)
  const snapshot = await readInformation(graphql, ids, schema, scope.locale), fields = informationRegistry(schema)
  const applyValue = (draft: ShopifyLinkedDraft, row: InformationRow, field: InformationField, value: string | null) => {
    const next = applyInformationCells(draft, [{ row, field, value }], snapshot.rows, false)
    const edit = next.nativeEdits?.find(e => e.ownerId === row.id && (row.locale ? e.translation?.locale === row.locale && e.translation.fieldId === field.id : e.field === field.id))
    const error = edit && nativeSchemaError(schema, edit)
    if (error) throw new Error(error)
    return next
  }
  // Resolve reset from the authoritative common mapping, never from client-supplied text.
  const resetValues = new Map<string, string | null>()
  if (input.cells.some(c => c.intent === 'reset' || c.intent === 'reset-list')) {
    const page = await getStudioSheet({ productId, scope: 'channel', channel: 'SHOPIFY', market: 'GLOBAL', accountId: destination.accountId, locale: scope.locale, includeMapping: true })
    const listings = await prisma.channelListing.findMany({ where: { productId: { in: page.rows.map(r => r.id) }, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '' } })
    const projected = projectShopifyChannelSheet(page, observed, snapshot, schema, listings, destination.aliasKey || null)
    for (const change of input.cells.filter(c => c.intent === 'reset' || c.intent === 'reset-list')) {
      const row = projected.find(r => r.values[change.colId]?.shopifyWrite?.ownerId === change.ownerId)
      const base = row && page.rows.find(r => r.id === row.id && r.aliasId === row.aliasId)?.values[change.colId]
      if (!base) continue
      const field = fields.find(f => f.id === change.fieldId)!
      if (!field) continue
      const raw = field.id !== 'inventory' && base.mapped?.status === 'mapped' && base.mapped.sourceOwner?.kind !== 'listing' ? informationSheetValue(field, base.mapped.value) : informationStoredValue(snapshot.rows.find(r => r.id === change.ownerId)!, field)
      resetValues.set(change.colId, raw == null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw))
    }
  }
  return linkedTransaction(async tx => {
    const current = await linkedState(tx, destination)
    if (object(current.pa?.[PUBLISH_KEY]).status === 'PUBLISHING') throw new WorkspaceScopeError('A Shopify publication is running. Reconcile its status before editing.')
    if (active(current.workspace)) throw new WorkspaceScopeError('Resume or reconcile the pending synchronization before editing.')
    if (JSON.stringify(current.workspace.suggestedProductIds) !== JSON.stringify(observed.suggestedProductIds) || JSON.stringify(current.draft.members) !== JSON.stringify(observed.draft.members)) throw new WorkspaceScopeError('The listing identities changed. Reload before editing.')
    let draft = structuredClone(current.draft)
    const cells: Record<string, { ok: boolean; reason?: string; shopifyWrite?: ShopifySheetWrite }> = Object.create(null)
    for (const change of input.cells) {
      try {
        const row = snapshot.rows.find(r => r.id === change.ownerId), field = fields.find(f => f.id === change.fieldId)
        if (!row || !field) throw new Error('This owner or field no longer belongs to the selected listing. Reload the sheet.')
        // LX.F F-LX-1 (third instance) — the ContentAddress gate was unconditional, one line
        // ABOVE the rule that refuses every content field on this path. So it could only ever
        // fire for a field this path REFUSES anyway, or wrongly for a metafield/native field
        // that carries no content at all (measured: a `custom.flag` boolean write answered
        // "Custom product needs a ContentAddress before it can be saved."). The content
        // refusal below is the one rule that belongs here, and it names the writer to use.
        if (['title', 'description', 'bodyHtml', 'descriptionHtml'].includes(field.id)) throw new Error(`${field.label} must be saved through the sheet's content address writer.`)
        if (change.token !== shopifyCellToken(current.workspace, row.id, field, row.locale)) throw new Error('Another editor changed this draft cell. Your input is retained; review the saved value before retrying.')
        const reason = informationRestriction(row, field, draft, false)
        if (reason) throw new Error(reason)
        if (informationPendingValue(row, field, current.draft) === undefined && informationStoredValue(row, field) !== change.baseline) throw new Error('Shopify changed this value since it was read. Your input is retained; reload to review it.')
        if (change.intent === 'reset' || change.intent === 'reset-list') {
          if (!resetValues.has(change.colId)) throw new Error('The inherited source is unavailable. Reload the sheet before resetting this cell.')
          draft = applyValue(draft, row, field, resetValues.get(change.colId)!)
        } else if (field.id === 'media') {
          const edit = mediaOrderEditSchema.parse(JSON.parse(change.value ?? 'null'))
          const first = current.draft.mediaEdits?.find(e => e.productId === row.id)
          if (edit.productId !== row.id || JSON.stringify(edit.value) !== JSON.stringify(first?.value ?? row.media.map(m => m.id))) throw new Error('The gallery identity or baseline changed. Reopen the media editor.')
          draft.mediaEdits = [...(draft.mediaEdits ?? []).filter(e => e.productId !== row.id), edit]
          if (!draft.members.length) { draft.informationOnly = true; draft.members = snapshot.rows.filter(r => r.kind === 'PRODUCT').map(r => ({ id: r.id, title: r.title, handle: r.handle, image: r.image })) }
        } else {
          if (field.currency && change.value !== null && JSON.parse(change.value).currency_code !== field.currency) throw new Error(`Use this store’s ${field.currency} currency.`)
          draft = applyValue(draft, row, field, change.value)
        }
        // Inventory is a live operational quantity, not a persistent content override.
        // Its durable pending adjustment is cleared only after exact location readback.
        if (field.id !== 'media' && field.id !== 'inventory') {
          draft.sheetValues = (draft.sheetValues ?? []).filter(v => !(v.ownerId === row.id && v.fieldId === field.id && v.locale === (row.locale ?? '')))
          const inherited = change.intent === 'reset' || change.intent === 'reset-list'
          draft.sheetValues.push({ ownerId: row.id, fieldId: field.id, type: field.type, locale: row.locale ?? '', value: inherited ? resetValues.get(change.colId)! : change.value, ...(inherited ? { inherited: true as const } : {}) })
        }
        cells[change.colId] = { ok: true }
      } catch (e) { cells[change.colId] = { ok: false, reason: e instanceof Error ? e.message : 'This edit could not be saved.' } }
    }
    if (Object.values(cells).some(c => c.ok)) {
      draft = shopifyLinkedDraftSchema.parse(draft)
      await writeLinkedState(tx, destination, current, { [LINKED_KEY]: draft, [AUTOMATION_KEY]: { ...current.workspace.automation, mode: 'PAUSED', status: 'IDLE', message: 'Information draft changed. Review before synchronizing.' } })
    }
    const saved = await linkedState(tx, destination)
    if (Object.values(cells).some(c => c.ok)) await tx.auditLog.create({ data: { userId: actorUserId, entityType: 'ChannelListing', entityId: saved.listing!.id, action: 'shopify.draft.cells.saved', before: current.draft as any, after: draft as any, metadata: { source: 'channel-sheet', accountId: destination.accountId, aliasKey: destination.aliasKey ?? '', locale: scope.locale ?? '' } } })
    const attributedListings = Object.values(cells).some(c => c.ok) ? await tx.channelListing.findMany({ where: { channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '', product: { OR: [{ id: destination.familyId }, { parentId: destination.familyId }] } }, select: { productId: true, externalListingId: true, platformAttributes: true } }) : []
    for (const change of input.cells) if (cells[change.colId].ok) {
      const row = snapshot.rows.find(r => r.id === change.ownerId)!, field = fields.find(f => f.id === change.fieldId)!
      const numericId = (id: unknown) => typeof id === 'string' ? id.split('/').at(-1) : null
      const owners = attributedListings.filter(listing => row.kind === 'PRODUCT' ? numericId(listing.externalListingId) === numericId(row.id) : numericId(object(listing.platformAttributes).variantId) === numericId(row.id))
      const owner = owners.find(listing => listing.productId === destination.familyId) ?? (owners.length === 1 ? owners[0] : undefined)
      if (owner) {
        const previous = current.draft.sheetValues?.find(v => v.ownerId === row.id && v.fieldId === field.id && v.locale === (row.locale ?? ''))
        const next = draft.sheetValues?.find(v => v.ownerId === row.id && v.fieldId === field.id && v.locale === (row.locale ?? ''))
        await tx.auditLog.create({ data: { userId: actorUserId, entityType: 'Product', entityId: owner.productId, action: 'update',
          before: { field: change.colId, value: previous ? previous.value : informationPendingValue(row, field, current.draft) ?? change.baseline },
          after: { field: change.colId, value: next ? next.value : change.value },
          metadata: { layer: 'channel', source: 'manual', channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: destination.accountId, accountId: destination.accountId, aliasKey: destination.aliasKey ?? '', locale: scope.locale ?? '', ownerId: row.id, providerFieldId: field.id, deliveryState: 'nexusDraft', beforeSource: previous ? 'nexusDraft' : 'providerBaseline' } } })
      }
      cells[change.colId].shopifyWrite = { ownerId: row.id, fieldId: field.id, token: shopifyCellToken(saved.workspace, row.id, field, row.locale), baseline: informationStoredValue(row, field) }
    }
    return { ok: Object.values(cells).every(c => c.ok), cells, listing: saved.listing ? { id: saved.listing.id, version: saved.listing.version } : null }
  })
}
