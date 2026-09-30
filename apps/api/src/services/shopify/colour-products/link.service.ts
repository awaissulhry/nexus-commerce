/**
 * Link (docs/studies/shopify-linked-variations-PLAN.md §3.5 LINK, PR 4): the ONLY writer of the two grouping fields of a
 * family's colour products — the colour name (`custom.variation_value`) and the colour list (`custom.variation_products`:
 * every colour product of the group, itself included, in colour order; the same list on each). Other paths refuse both
 * fields (`colourGroupingIssue`, linked-state-guard.ts).
 *
 * The group: every colour of the plan in the family's colour order, each with its confirmed product; then each confirmed
 * colour the family no longer has — it stays listed (D2 b: Shopify hides it once it is archived) and keeps its name.
 * Nothing is written until every colour of the plan is confirmed, so a live list never gets shorter by mistake. One colour:
 * no list; a list left from a larger group is deleted, the name stays.
 *
 * One read of both fields on every member, then only what differs — names before lists, at most 25 fields per call, each
 * call all or nothing, compare-and-set on the values just read (`applyLinkedBatch`) — then one read-back of the whole
 * group and `linkVerifiedAt` ("Linked ✓"). Nexus owns these fields (§3.3): what Shopify held when the run read it is
 * overwritten; a change made between that read and the write stops the run, and the next run repairs it.
 */
import prisma from '../../../db.js'
import { requireWorkspace } from '../../../lib/workspace-context.js'
import { IMPACT_LINKED_SHOWN_LIMIT, SHOPIFY_LINKED_LIST_LIMIT } from '@nexus/shared/shopify-colour-products'
import { definitionAddress, shopifyValuesEqual, validateShopifyField, type ShopifyFieldEdit, type ShopifyFieldDefinition, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyAdmin, type ShopifyGraphql } from '../admin-client.js'
import { contentDestination, object, type ContentScope } from '../content-workspace.service.js'
import { applyLinkedBatch, LINKED_KEY } from '../linked-products.service.js'
import { getShopifyPublishMode } from '../../shopify-publish-gate.service.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import type { ColourProductSettings } from './settings.js'
import { colourProductsView, planFor, rowsWhere, type Destination } from './find.service.js'
import { commitColourSyncChange, guardedColourGraphql, withColourSyncLock } from './sync-work.js'

const VALUE_TYPE = 'single_line_text_field', LIST_TYPE = 'list.product_reference'
/** `metafieldsSet` takes at most 25 fields per call; a 26th is refused (development store, 2026-09-30). */
const BATCH = 25

const LINK_READ = `query NexusColourLinkRead($ids:[ID!]!,$vns:String!,$vkey:String!,$lns:String!,$lkey:String!) {
  nodes(ids:$ids) { ... on Product { id title value: metafield(namespace:$vns,key:$vkey) { value type compareDigest } list: metafield(namespace:$lns,key:$lkey) { value type compareDigest } } }
  valueDefinition: metafieldDefinitions(ownerType:PRODUCT,namespace:$vns,key:$vkey,first:1) { nodes { id name type { name } validations { name value } } }
  listDefinition: metafieldDefinitions(ownerType:PRODUCT,namespace:$lns,key:$lkey,first:1) { nodes { id name type { name } validations { name value } } } }`

type Row = Awaited<ReturnType<typeof planFor>>['rows'][number]
interface Member { row: Row & { shopifyProductId: string }; name: string; colourName: string | null }
interface Remote { value: string | null; type: string; compareDigest: string | null }
/** One field as Nexus wants it on one member; `next` null = deleted. `slot`: where the link read returns it. */
interface Wanted { member: Member; slot: 'value' | 'list'; next: string | null }

const fold = (text: string) => text.trim().toLocaleLowerCase('en')

/** Writes the colour names and colour lists of the family's colour products on one store and alias, and reads them back. */
export async function linkColourProducts(productId: string, scope: ContentScope) {
  if (getShopifyPublishMode() !== 'live') throw new WorkspaceScopeError('Shopify writes are switched off on this server. Nothing was changed.', 409)
  const destination = await contentDestination(productId, scope)
  return withColourSyncLock(destination, () => linkDestination(destination))
}

async function linkDestination(destination: Destination) {
  const { rows, settings, plan } = await planFor(destination)
  // No "Linked ✓" until this run ends verified; a colour that left the group loses it too.
  await prisma.shopifyColourProduct.updateMany({ where: { ...rowsWhere(destination), linkVerifiedAt: { not: null } }, data: { linkVerifiedAt: null } })
  if (!settings.enabled) throw new WorkspaceScopeError('Switch on colour products for this Shopify store first. Nothing was changed.', 409)
  if (plan.mode !== 'colour-products' || !plan.splitAxis) throw new WorkspaceScopeError('This family has no colour to show as separate Shopify products. Nothing was changed.', 422)
  if (await hasProductFamilyLinks(destination)) throw new WorkspaceScopeError('This family has links in Product family. Remove them there first; then colour products link it. Nothing was changed.', 409)
  const confirmed = (r: Row | undefined): r is Member['row'] => r?.state === 'LINKED' && !!r.shopifyProductId
  const rowOf = new Map(rows.map(r => [r.valueKey, r]))
  const problems = plan.issues.filter(i => i.severity === 'error').map(i => i.message)
  for (const p of plan.products) if (!confirmed(rowOf.get(p.key))) problems.push(`"${p.nexusValue}" has no confirmed Shopify product yet. Confirm it first.`)
  if (problems.length) throw new WorkspaceScopeError(`${[...new Set(problems)].join(' ')} Nothing was changed.`, 409)
  const inPlan = new Set(plan.products.map(p => p.key))
  const members: Member[] = [
    ...plan.products.map(p => ({ row: rowOf.get(p.key) as Member['row'], name: p.nexusValue, colourName: p.colourName })),
    ...rows.filter(r => !inPlan.has(r.valueKey)).filter(confirmed).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(row => ({ row, name: row.colourName ?? row.valueKey, colourName: null })),
  ]
  if (members.length > SHOPIFY_LINKED_LIST_LIMIT) throw new WorkspaceScopeError(`Shopify can group at most ${SHOPIFY_LINKED_LIST_LIMIT} products; this family has ${members.length} colour products. Nothing was changed.`, 409)
  const warnings = members.length > IMPACT_LINKED_SHOWN_LIMIT ? [`The theme shows at most ${IMPACT_LINKED_SHOWN_LIMIT} colours; this group has ${members.length}. The rest are grouped but not shown.`] : []
  const grouped = members.length >= 2
  const detached = rows.filter(r => r.state === 'NOT_FOUND' && r.shopifyProductId && !inPlan.has(r.valueKey))
  if (!members.length && !detached.length) return { ...await colourProductsView(destination, plan, settings), link: { grouped, members: 0, written: 0, cleared: 0, warnings, verifiedAt: null } }

  const graphql = guardedColourGraphql((await shopifyAdmin(destination.accountId)).graphql)
  const list = JSON.stringify(members.map(m => m.row.shopifyProductId))
  const wanted: Wanted[] = [
    ...(grouped ? members.filter(m => m.colourName !== null).map(member => ({ member, slot: 'value' as const, next: member.colourName })) : []),
    ...members.map(member => ({ member, slot: 'list' as const, next: grouped ? list : null })),
  ]
  const { nodes, definitions, schema } = await readGroup(graphql, settings, members, 'Nothing was changed.')
  if (grouped) {
    // A colour the family no longer has keeps its Shopify name: no two swatches of the group may read the same.
    const shown = members.map(m => ({ m, name: m.colourName ?? nodes.get(m.row.shopifyProductId)!.value?.value ?? '' })).filter(s => s.name.trim())
    const same = shown.filter(s => shown.some(o => o !== s && fold(o.name) === fold(s.name)))
    if (same.length) throw new WorkspaceScopeError(`${same.map(s => `"${s.m.name}"`).join(', ')} would all be called "${same[0].name}" on Shopify. Give each colour its own name. Nothing was changed.`, 409)
  }
  const edits: ShopifyFieldEdit[] = []
  // Explicitly detached colours keep their address until this writer clears their old list.
  // A proposal or a foreign product is never treated as an adopted colour.
  for (const row of detached) {
    const remote = (await graphql(`query NexusColourDetachedLink($id:ID!,$ns:String!,$key:String!) { product(id:$id) {
      identity:metafield(namespace:"nexus",key:"family_id") { value } list:metafield(namespace:$ns,key:$key) { value type compareDigest }
    } }`, { id: row.shopifyProductId, ns: settings.listField.namespace, key: settings.listField.key })).product
    if (remote === null) continue
    if (remote?.identity?.value !== `${requireWorkspace().workspaceId}:${destination.familyId}:c:${row.id}`)
      throw new WorkspaceScopeError('A detached colour no longer has its confirmed Nexus identity. Review it before clearing its list.')
    if (remote.list) edits.push({ ownerId: row.shopifyProductId!, ...settings.listField, type: remote.list.type,
      value: remote.list.value, compareDigest: remote.list.compareDigest, nextValue: null, ownerLabel: row.colourName ?? row.valueKey })
  }
  for (const w of wanted) {
    const node = nodes.get(w.member.row.shopifyProductId)!, current = node[w.slot], definition = definitions[w.slot], label = `"${node.title}" (${w.member.name})`
    if (current && current.type !== definition.type) throw new WorkspaceScopeError(`${label}: Shopify holds ${definitionAddress(definition)} as ${current.type}, not ${definition.type}. Nothing was changed.`, 422)
    if (shopifyValuesEqual(definition.type, current?.value ?? null, w.next)) continue
    const invalid = validateShopifyField(definition, w.next)
    if (invalid) throw new WorkspaceScopeError(`${label}: ${definition.name} — ${invalid} Nothing was changed.`, 422)
    edits.push({ ownerId: w.member.row.shopifyProductId, namespace: definition.namespace, key: definition.key, type: definition.type, value: current?.value ?? null,
      compareDigest: current?.compareDigest ?? null, nextValue: w.next, ownerLabel: label })
  }

  for (let offset = 0; offset < edits.length; offset += BATCH) {
    try {
      await applyLinkedBatch(graphql, edits.slice(offset, offset + BATCH), schema)
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error)
      const done = offset ? ` The first ${offset} of ${edits.length} fields are written.` : ''
      throw new WorkspaceScopeError(`${words.trim().replace(/([^.!?])$/, '$1.')}${done} Run the link again: it writes only what is still missing.`, error instanceof WorkspaceScopeError ? error.statusCode : 502)
    }
  }
  if (edits.length) {
    const back = (await readGroup(graphql, settings, members, 'Run the link again.')).nodes
    const wrong = [...new Set(wanted.filter(w => !shopifyValuesEqual(definitions[w.slot].type, back.get(w.member.row.shopifyProductId)![w.slot]?.value ?? null, w.next)).map(w => `"${w.member.name}"`))]
    if (wrong.length) throw new WorkspaceScopeError(`Shopify read back other colour fields for ${wrong.join(', ')}. Run the link again.`, 502)
  }
  const verifiedAt = new Date()
  await commitColourSyncChange(async tx => {
    if (detached.length) await tx.shopifyColourProduct.updateMany({ where: { ...rowsWhere(destination), id: { in: detached.map(r => r.id) }, state: 'NOT_FOUND' }, data: { shopifyProductId: null } })
    await tx.shopifyColourProduct.updateMany({ where: { ...rowsWhere(destination), id: { in: members.map(m => m.row.id) } }, data: { linkVerifiedAt: verifiedAt } })
    if (edits.length) await tx.productEvent.create({ data: { aggregateId: destination.familyId, aggregateType: 'Product', eventType: 'PRODUCT_UPDATED',
      data: { shopifyColourLinks: 'Repaired', fields: edits.length }, metadata: { source: 'SYSTEM', writer: 'shopify-colour-link', channel: 'SHOPIFY', marketplace: destination.marketplace, accountId: destination.accountId, aliasKey: destination.aliasKey ?? '' } } })
  })
  return { ...await colourProductsView(destination, plan, settings),
    link: { grouped, members: members.length, written: edits.filter(e => e.nextValue !== null).length, cleared: edits.filter(e => e.nextValue === null).length, warnings, verifiedAt: members.length ? verifiedAt.toISOString() : null } }
}

/**
 * Both fields on every member, and the two definitions (their rules check the values; their names word Shopify's
 * refusals). `ending`: how a refusal ends — before the first write nothing was changed; after it, the run is repeated.
 */
async function readGroup(graphql: ShopifyGraphql, settings: ColourProductSettings, members: readonly Member[], ending: string) {
  const data = await graphql(LINK_READ, { ids: members.map(m => m.row.shopifyProductId), vns: settings.valueField.namespace, vkey: settings.valueField.key, lns: settings.listField.namespace, lkey: settings.listField.key })
  const nodes = new Map<string, { title: string; value: Remote | null; list: Remote | null }>((data.nodes ?? []).filter((n: any) => n?.id).map((n: any) => [n.id, n]))
  const gone = members.filter(m => !nodes.has(m.row.shopifyProductId))
  if (gone.length) throw new WorkspaceScopeError(`${gone.map(m => `The Shopify product of "${m.name}" no longer exists.`).join(' ')} ${ending}`, 409)
  const definition = (field: ColourProductSettings['valueField'], type: string, node: any): ShopifyFieldDefinition => {
    const found = node?.nodes?.[0]
    if (found?.type?.name !== type) throw new WorkspaceScopeError(found
      ? `The Shopify product field ${definitionAddress(field)} is ${found.type?.name}; colour products need ${type}. ${ending}`
      : `The Shopify store has no product field ${definitionAddress(field)} (${type}). Create it in Shopify (Settings → Custom data → Products) first. ${ending}`, 422)
    return { id: found.id, name: found.name, description: null, namespace: field.namespace, key: field.key, ownerType: 'PRODUCT', type, validations: found.validations ?? [], access: { admin: null, storefront: null } }
  }
  const definitions = { value: definition(settings.valueField, VALUE_TYPE, data.valueDefinition), list: definition(settings.listField, LIST_TYPE, data.listDefinition) }
  // Only these two fields are written, and neither is limited to a category: no other part of the store schema is needed.
  const schema: ShopifyStoreSchema = { definitions: [definitions.value, definitions.list], metaobjectDefinitions: [], types: [], locales: [], revision: '' }
  return { nodes, definitions, schema }
}

/** A Product family relationship on the family: the manual way of linking separate products (the empty record is not one). */
async function hasProductFamilyLinks(d: Destination) {
  const listing = await prisma.channelListing.findFirst({ where: { productId: d.familyId, channel: 'SHOPIFY', channelConnectionId: d.accountId, marketplace: d.marketplace, aliasKey: d.aliasKey ?? '' },
    select: { platformAttributes: true } })
  return !!object(object(listing?.platformAttributes)[LINKED_KEY]).relationship
}
