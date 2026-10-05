import { informationRestriction, applyInformationCells, informationSharingRule, informationSharedValue, informationSharingFacts } from '@nexus/shared/shopify-information-editing'
import { active, projectShopifyChannelSheet, shopifyCellToken, withShopifyCreateStatus } from './channel-sheet-projection.js'
import { shopifyCreateChoiceOf } from './create-status.js'
import { readListingDeletions } from '../listings/listing-deletions.js'
import { z } from 'zod'
import prisma from '../../db.js'
import { informationRegistry, informationSheetValue, informationPendingValue, informationStoredValue, mediaOrderEditSchema, nativeSchemaError, nativeWriteValue,
  type InformationField, type InformationRow, type InformationSnapshot, type ShopifySheetWrite } from '@nexus/shared/shopify-information'
import { shopifyLinkedDraftSchema, shopifyReferenceError, shopifyTaxonomyCategories, validateShopifyField, type ShopifyLinkedDraft, type ShopifyLinkedWorkspace, type ShopifyReference, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { StudioSheet, StudioRow } from '../pim/studio-sheet.service.js'
import { getStudioSheet } from '../pim/studio-sheet.service.js'
import { readShopifyDisplaySchema, readShopifyMappingSchema } from '../pim/channel-specs/shopify.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { contentDestination, object, PUBLISH_KEY, type ContentScope } from './content-workspace.service.js'
import { shopifyAdmin } from './admin-client.js'
import { readInformation } from './information-gateway.js'
import { AUTOMATION_KEY, LINKED_KEY, getLinkedWorkspace, linkedState, linkedTransaction, writeLinkedState } from './linked-products.service.js'
import { readTaxonomyAttributeValues, resolveLinkedReferenceNames } from './linked-products-gateway.js'
import { matchesRootCreationProof, recordRootCreationProof, type RootProofScope } from './channel-sheet-root-proof.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'

export async function enrichShopifyChannelSheet(page: StudioSheet): Promise<StudioSheet> {
  if (page.scope.channel !== 'SHOPIFY' || !page.scope.connectionId) return page
  const accountId = page.scope.connectionId
  // Display only: the last known field list now, a refresh behind it (a cold read took 34 s, 2026-09-24).
  const schema = await readShopifyDisplaySchema(accountId)
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: page.rows.map(r => r.id) }, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: accountId },
    select: { id: true, productId: true, externalListingId: true, platformAttributes: true, aliasKey: true, channel: true, marketplace: true, listingStatus: true, isPublished: true,
      sellingTarget: true, sellingTargetAt: true, publishAction: true, publishActionAt: true } })
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
  // Wave 2 D4 (Owner decision 9) — rows not on Shopify yet: "Shopify status" is read-only and shows what Publish creates,
  // the Status column's choice (`create-status.ts`), so the sheet, Publish and the Media tab follow one rule.
  const products = [...new Map(page.rows.map(row => [row.id, { id: row.id, parentId: row.parentId ?? null }])).values()]
  const deletions = await readListingDeletions(listings.map(listing => ({ ...listing, channel: 'SHOPIFY', marketplace: 'GLOBAL' })))
  for (const alias of page.aliases) {
    const choice = shopifyCreateChoiceOf({ familyId: page.family.id, aliasKey: alias.id ?? '', products, listings: listings.filter(l => l.aliasKey === (alias.id ?? '')), deletions })
    result.rows = withShopifyCreateStatus(result.rows, page.columns, alias.id, choice.onShopify ? null : choice)
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

/**
 * One request of Shopify draft cells (at most 1,000). `receiptKey` is optional client correlation only — never authority
 * or an idempotency promise: it names a cell's answer when one physical column holds several owners. Old callers send
 * none and keep their `colId`-keyed answers. Effective keys (receiptKey, else colId) must be unique, so two owners in one
 * column get distinct outcomes; a duplicate is refused before anything is written. `operationId` is the stable id of the
 * whole sheet action (a Set column over several requests), used only for the root-creation proof (`channel-sheet-root-proof.ts`).
 */
export const shopifySheetChangesSchema = z.object({ operationId: z.string().min(1).max(128).optional(),
  cells: z.array(z.object({ contentAddress: z.unknown().optional(), colId: z.string().min(1), receiptKey: z.string().min(1).max(200).optional(), ownerId: z.string().min(1), fieldId: z.string().min(1), token: z.string().min(1), baseline: z.string().nullable(), value: z.string().nullable(), intent: z.enum(['set', 'pin', 'reset', 'reset-list']) })).min(1).max(1000) }).strict().superRefine((input, ctx) => {
  const receipts = new Set<string>(), addresses = new Map<string, string>()
  input.cells.forEach((cell, index) => {
    const receipt = shopifyReceiptKey(cell), address = JSON.stringify([cell.ownerId, cell.fieldId]), intent = JSON.stringify([cell.intent, cell.value])
    if (addresses.has(address) && addresses.get(address) !== intent) ctx.addIssue({ code: 'custom', path: ['cells', index], message: 'This batch contains conflicting edits for the same cell. Apply those changes separately.' })
    else if (receipts.has(receipt)) ctx.addIssue({ code: 'custom', path: ['cells', index], message: 'This batch contains conflicting cell receipts. Apply those changes separately.' })
    receipts.add(receipt); addresses.set(address, intent)
  })
})
/** The key a cell's answer is reported under: its receipt key, else its column (the old single-row wire). */
export const shopifyReceiptKey = (cell: { colId: string; receiptKey?: string }) => cell.receiptKey ?? cell.colId
export async function saveShopifySheetCells(productId: string, scope: ContentScope & { locale?: string }, body: unknown, actorUserId: string | null) {
  const input = shopifySheetChangesSchema.parse(body)
  /* The primary listing's alias is '' on `aliasKey` but NULL on the `aliasId` foreign key. A destination resolved from a
     listing reports '' — which `writeLinkedState` would write as `aliasId: ''` when it creates a missing family root, and
     the foreign key refuses it. Normalize it here: every read below already treats null as ''. */
  const resolved = await contentDestination(productId, scope), destination = { ...resolved, aliasKey: resolved.aliasKey || null }
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
  // LB-D2 (Owner, 2026-09-28; docs/shopify-metafields/PLAN-2026-09-28.md §12): a pasted or imported reference is checked
  // against the store at the draft save — its entry kind, its file kind, and that it still exists — not first at publish.
  // Names come through the display cache (10 minutes), so a value picked in the pop-up costs no extra read. Read here,
  // before the transaction: no Shopify call runs inside it.
  const referenceRefusals = new Map<string, string>()
  const referenceCells = input.cells.flatMap(change => {
    const def = fields.find(f => f.id === change.fieldId)?.definition
    if (!def || !def.type.includes('_reference') || change.value === null || change.intent === 'reset' || change.intent === 'reset-list' || validateShopifyField(def, change.value)) return []
    const ids: string[] = def.type.startsWith('list.') ? JSON.parse(change.value) : [change.value]
    return ids.length ? [{ change, def, ids }] : []
  })
  if (referenceCells.length) {
    const ids = [...new Set(referenceCells.flatMap(cell => cell.ids))], refs = new Map<string, ShopifyReference>()
    try {
      for (let i = 0; i < ids.length; i += 100) for (const ref of await resolveLinkedReferenceNames(graphql, destination.accountId, ids.slice(i, i + 100))) refs.set(ref.id, ref)
      for (const { change, def, ids: cellIds } of referenceCells) {
        const problem = shopifyReferenceError(def, cellIds.map(id => refs.get(id) ?? { available: false }), schema)
        if (problem) { referenceRefusals.set(shopifyReceiptKey(change), problem); continue }
        /* A taxonomy value must be a value of the field's attribute (B2, G12) — checked against Shopify's list when a
           category tells which list; otherwise Shopify's own check on publish decides. */
        const handle = def.validations.find(v => v.name === 'product_taxonomy_attribute_handle')?.value
        const categories = handle ? shopifyTaxonomyCategories(def, schema) : []
        if (handle && categories.length) {
          const { attribute, values } = await readTaxonomyAttributeValues(graphql, handle, categories)
          if (attribute && cellIds.some(id => !values.some(v => v.id === id))) referenceRefusals.set(shopifyReceiptKey(change), `Choose a ${def.name} value from Shopify’s list.`)
        }
      }
    } catch {
      /* The check could not run (a timeout, a rate limit, an incomplete answer): only the reference cells are refused —
         an unchecked reference never reaches the draft — and every other cell of the batch still saves. */
      for (const { change } of referenceCells) referenceRefusals.set(shopifyReceiptKey(change), 'Shopify could not be reached to check this value. Try again.')
    }
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
      resetValues.set(shopifyReceiptKey(change), raw == null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw))
    }
  }
  const aliasKey = destination.aliasKey ?? ''
  return linkedTransaction(async tx => {
    const current = await linkedState(tx, destination)
    if (object(current.pa?.[PUBLISH_KEY]).status === 'PUBLISHING') throw new WorkspaceScopeError('A Shopify publication is running. Reconcile its status before editing.')
    /* Root-creation proof (channel-sheet-root-proof.ts): a later request of the SAME action may present a token minted
       while the family root was absent. Only if this exact action created this exact root is that token compared — with
       the root shown as absent — against the CURRENT cell state. Every other token is strict. */
    const proofScope: RootProofScope | null = input.operationId ? { workspaceId: workspaceIdForQuery(), accountId: destination.accountId, familyId: destination.familyId,
      market: destination.marketplace, aliasKey, actorUserId, operationId: input.operationId } : null
    let createdByThisAction: Promise<boolean> | undefined
    const continuesAbsentRoot = async (token: string, row: InformationRow, field: InformationField) => {
      if (!proofScope || !current.listing) return false
      createdByThisAction ??= matchesRootCreationProof(tx, proofScope, { id: current.listing.id, createdAt: current.listing.createdAt })
      const absent = { ...current.workspace, destination: { ...current.workspace.destination, listingId: null } }
      return await createdByThisAction && token === shopifyCellToken(absent, row.id, field, row.locale, aliasKey)
    }
    if (active(current.workspace)) throw new WorkspaceScopeError('Resume or reconcile the pending synchronization before editing.')
    if (JSON.stringify(current.workspace.suggestedProductIds) !== JSON.stringify(observed.suggestedProductIds) || JSON.stringify(current.draft.members) !== JSON.stringify(observed.draft.members)) throw new WorkspaceScopeError('The listing identities changed. Reload before editing.')
    let draft = structuredClone(current.draft)
    const cells: Record<string, { ok: boolean; reason?: string; shopifyWrite?: ShopifySheetWrite }> = Object.create(null)
    for (const change of input.cells) {
      const receipt = shopifyReceiptKey(change)
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
        if (change.token !== shopifyCellToken(current.workspace, row.id, field, row.locale, aliasKey) && !await continuesAbsentRoot(change.token, row, field)) throw new Error('Another editor changed this draft cell. Your input is retained; review the saved value before retrying.')
        const reason = informationRestriction(row, field, draft, false)
        if (reason) throw new Error(reason)
        // Wave 2 D3 — a cleared theme template is '' (the store's default template, as Shopify reads it), never null.
        const written = field.definition || row.locale ? change.value : nativeWriteValue(field.id, change.value)
        const referenceRefusal = referenceRefusals.get(receipt)
        if (referenceRefusal) {
          /* Same form as every other draft-save refusal (`applyInformationCells`): "<owner> / <field>: <sentence>". */
          const ownerLabel = row.kind === 'PRODUCT' ? row.title : `${snapshot.rows.find(r => r.id === row.productId)?.title ?? row.handle} / ${row.title}`
          throw new Error(`${ownerLabel} / ${field.label}: ${referenceRefusal}`)
        }
        if (informationPendingValue(row, field, current.draft) === undefined && informationStoredValue(row, field) !== change.baseline) throw new Error('Shopify changed this value since it was read. Your input is retained; reload to review it.')
        const rule = !row.locale ? informationSharingRule(row, field, draft) : undefined
        const sharedReset = (change.intent === 'reset' || change.intent === 'reset-list') && rule && rule.sourceProductId !== row.id
        if (sharedReset) {
          const next = structuredClone(draft), ownRule = informationSharingRule(row, field, next)!
          ownRule.excludedProductIds = ownRule.excludedProductIds.filter(id => id !== row.id)
          const observedField = row.fields.find(f => f.namespace === ownRule.namespace && f.key === ownRule.key)
            ?? { ownerId: row.id, namespace: ownRule.namespace, key: ownRule.key, type: field.type, value: null, compareDigest: null }
          ownRule.baseline = [...ownRule.baseline.filter(f => f.ownerId !== row.id), { ...observedField, value: observedField.value ?? null, compareDigest: observedField.compareDigest ?? null }]
          next.edits = next.edits.filter(edit => !(edit.ownerId === row.id && edit.namespace === ownRule.namespace && edit.key === ownRule.key))
          next.sheetValues = next.sheetValues?.filter(v => !(v.ownerId === row.id && v.fieldId === field.id && v.locale === ''))
          informationSharedValue(row, field, next, snapshot.rows) // Refuse a missing source before adopting any change.
          draft = next
        } else if (change.intent === 'reset' || change.intent === 'reset-list') {
          if (!resetValues.has(receipt)) throw new Error('The inherited source is unavailable. Reload the sheet before resetting this cell.')
          draft = applyValue(draft, row, field, resetValues.get(receipt)!)
        } else if (field.id === 'media') {
          const edit = mediaOrderEditSchema.parse(JSON.parse(change.value ?? 'null'))
          const first = current.draft.mediaEdits?.find(e => e.productId === row.id)
          if (edit.productId !== row.id || JSON.stringify(edit.value) !== JSON.stringify(first?.value ?? row.media.map(m => m.id))) throw new Error('The gallery identity or baseline changed. Reopen the media editor.')
          draft.mediaEdits = [...(draft.mediaEdits ?? []).filter(e => e.productId !== row.id), edit]
          if (!draft.members.length) { draft.informationOnly = true; draft.members = snapshot.rows.filter(r => r.kind === 'PRODUCT').map(r => ({ id: r.id, title: r.title, handle: r.handle, image: r.image })) }
        } else {
          if (field.currency && change.value !== null && JSON.parse(change.value).currency_code !== field.currency) throw new Error(`Use this store’s ${field.currency} currency.`)
          draft = applyValue(draft, row, field, written)
        }
        // Inventory is a live operational quantity, not a persistent content override.
        // Its durable pending adjustment is cleared only after exact location readback.
        if (field.id !== 'media' && field.id !== 'inventory') {
          draft.sheetValues = (draft.sheetValues ?? []).filter(v => !(v.ownerId === row.id && v.fieldId === field.id && v.locale === (row.locale ?? '')))
          const inherited = change.intent === 'reset' || change.intent === 'reset-list'
          if (!sharedReset) draft.sheetValues.push({ ownerId: row.id, fieldId: field.id, type: field.type, locale: row.locale ?? '', value: inherited ? resetValues.get(receipt)! : written, ...(inherited ? { inherited: true as const } : {}) })
        }
        cells[receipt] = { ok: true }
      } catch (e) { cells[receipt] = { ok: false, reason: e instanceof Error ? e.message : 'This edit could not be saved.' } }
    }
    if (Object.values(cells).some(c => c.ok)) {
      draft = shopifyLinkedDraftSchema.parse(draft)
      await writeLinkedState(tx, destination, current, { [LINKED_KEY]: draft, [AUTOMATION_KEY]: { ...current.workspace.automation, mode: 'PAUSED', status: 'IDLE', message: 'Information draft changed. Review before synchronizing.' } })
    }
    const saved = await linkedState(tx, destination)
    // Same transaction as the root's creation: a failure after this point rolls back root, proof and audit together.
    if (proofScope && !current.listing && saved.listing && Object.values(cells).some(c => c.ok)) await recordRootCreationProof(tx, proofScope, null, { id: saved.listing.id, createdAt: saved.listing.createdAt })
    if (Object.values(cells).some(c => c.ok)) await tx.auditLog.create({ data: { userId: actorUserId, entityType: 'ChannelListing', entityId: saved.listing!.id, action: 'shopify.draft.cells.saved', before: current.draft as any, after: draft as any, metadata: { source: 'channel-sheet', accountId: destination.accountId, aliasKey: destination.aliasKey ?? '', locale: scope.locale ?? '' } } })
    const attributedListings = Object.values(cells).some(c => c.ok) ? await tx.channelListing.findMany({ where: { channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '', product: { OR: [{ id: destination.familyId }, { parentId: destination.familyId }] } }, select: { productId: true, externalListingId: true, platformAttributes: true } }) : []
    for (const change of input.cells) if (cells[shopifyReceiptKey(change)].ok) {
      const row = snapshot.rows.find(r => r.id === change.ownerId)!, field = fields.find(f => f.id === change.fieldId)!
      const numericId = (id: unknown) => typeof id === 'string' ? id.split('/').at(-1) : null
      const owners = attributedListings.filter(listing => row.kind === 'PRODUCT' ? numericId(listing.externalListingId) === numericId(row.id) : numericId(object(listing.platformAttributes).variantId) === numericId(row.id))
      const owner = owners.find(listing => listing.productId === destination.familyId) ?? (owners.length === 1 ? owners[0] : undefined)
      if (owner) {
        const previous = current.draft.sheetValues?.find(v => v.ownerId === row.id && v.fieldId === field.id && v.locale === (row.locale ?? ''))
        const next = draft.sheetValues?.find(v => v.ownerId === row.id && v.fieldId === field.id && v.locale === (row.locale ?? ''))
        const beforeShared = informationSharedValue(row, field, current.draft, snapshot.rows), afterShared = informationSharedValue(row, field, draft, snapshot.rows)
        await tx.auditLog.create({ data: { userId: actorUserId, entityType: 'Product', entityId: owner.productId, action: 'update',
          before: { field: change.colId, value: beforeShared ? beforeShared.value : previous ? previous.value : informationPendingValue(row, field, current.draft) ?? change.baseline },
          after: { field: change.colId, value: afterShared ? afterShared.value : next ? next.value : change.value },
          metadata: { layer: 'channel', source: 'manual', channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: destination.accountId, accountId: destination.accountId, aliasKey: destination.aliasKey ?? '', locale: scope.locale ?? '', ownerId: row.id, providerFieldId: field.id, deliveryState: 'nexusDraft', beforeSource: beforeShared ? 'sharedField' : previous ? 'nexusDraft' : 'providerBaseline', afterSource: afterShared ? 'sharedField' : next ? 'nexusDraft' : 'providerBaseline' } } })
      }
      cells[shopifyReceiptKey(change)].shopifyWrite = { ownerId: row.id, fieldId: field.id, token: shopifyCellToken(saved.workspace, row.id, field, row.locale, aliasKey), baseline: informationStoredValue(row, field),
        sharing: informationSharingFacts(row, field, draft) }
    }
    return { ok: Object.values(cells).every(c => c.ok), cells, listing: saved.listing ? { id: saved.listing.id, version: saved.listing.version } : null }
  })
}
