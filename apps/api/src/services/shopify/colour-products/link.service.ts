/**
 * Link (docs/studies/shopify-linked-variations-PLAN.md §3.5 LINK, PR 4): the ONLY writer of the two grouping fields of a
 * family's colour products — the colour name (`custom.variation_value`) and the colour list (`custom.variation_products`:
 * every colour product of the group, itself included, in colour order; the same list on each). The Product family tab,
 * the sheet cells and the family automation refuse both fields while colour products manage the family
 * (`colourGroupingIssue`, linked-products.service.ts).
 *
 * The group: every colour of the plan in the family's colour order, each with its confirmed product; then each confirmed
 * colour the family no longer has — it stays listed (D2 b: Shopify hides it once it is archived) and keeps its name.
 * Nothing is written until every colour of the plan is confirmed, so a live list never gets shorter by mistake. One colour:
 * no list (a picker with one colour is useless); a list left from a larger group is deleted, the name stays.
 *
 * One read of both fields on every member first (a deleted member stops the run and is named). Then only what differs is
 * written — names before lists, at most 25 fields per call, each call all or nothing, compare-and-set on the values just
 * read (`applyLinkedBatch`). Last, one read-back of the whole group, and `linkVerifiedAt` ("Linked ✓"). Whatever Shopify
 * held when the run read it is overwritten: Nexus owns these fields (§3.3). A change made between that read and the write
 * stops the run; the next run repairs it.
 */
import prisma from '../../../db.js'
import { IMPACT_LINKED_SHOWN_LIMIT, SHOPIFY_LINKED_LIST_LIMIT } from '@nexus/shared/shopify-colour-products'
import { shopifyValuesEqual, type ShopifyFieldEdit, type ShopifyFieldDefinition, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyAdmin, type ShopifyGraphql } from '../admin-client.js'
import { contentDestination, object, type ContentScope } from '../content-workspace.service.js'
import { applyLinkedBatch, LINKED_KEY } from '../linked-products.service.js'
import { getShopifyPublishMode } from '../../shopify-publish-gate.service.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import type { ColourProductSettings } from './settings.js'
import { colourProductsView, planFor, rowsWhere, type Destination } from './find.service.js'

const VALUE_TYPE = 'single_line_text_field', LIST_TYPE = 'list.product_reference'
/** `metafieldsSet` takes at most 25 fields per call; a 26th is refused (development store, 2026-09-30). */
const BATCH = 25

const LINK_READ = `query NexusColourLinkRead($ids:[ID!]!,$vns:String!,$vkey:String!,$lns:String!,$lkey:String!) {
  nodes(ids:$ids) { ... on Product { id title value: metafield(namespace:$vns,key:$vkey) { value type compareDigest } list: metafield(namespace:$lns,key:$lkey) { value type compareDigest } } }
  valueDefinition: metafieldDefinitions(ownerType:PRODUCT,namespace:$vns,key:$vkey,first:1) { nodes { id name type { name } } }
  listDefinition: metafieldDefinitions(ownerType:PRODUCT,namespace:$lns,key:$lkey,first:1) { nodes { id name type { name } } } }`

type Field = ColourProductSettings['valueField']
type Row = Awaited<ReturnType<typeof planFor>>['rows'][number]
interface Member { row: Row & { shopifyProductId: string }; name: string; colourName: string | null }
interface Remote { value: string | null; type: string; compareDigest: string | null }
/** One field as Nexus wants it on one member; `next` null = deleted. */
interface Wanted { member: Member; field: Field; type: string; next: string | null; isList: boolean }

const address = (f: Field) => `${f.namespace}.${f.key}`

/** Writes the colour names and colour lists of the family's colour products on one store and alias, and reads them back. */
export async function linkColourProducts(productId: string, scope: ContentScope) {
  if (getShopifyPublishMode() !== 'live') throw new WorkspaceScopeError('Shopify writes are switched off on this server. Nothing was changed.', 409)
  const destination = await contentDestination(productId, scope)
  const { rows, settings, plan } = await planFor(destination)
  let members: Member[] = []
  try {
    if (!settings.enabled) throw new WorkspaceScopeError('Switch on colour products for this Shopify store first. Nothing was changed.', 409)
    if (plan.mode !== 'colour-products' || !plan.splitAxis) throw new WorkspaceScopeError('This family has no colour to show as separate Shopify products. Nothing was changed.', 422)
    if (await hasProductFamilyLinks(destination)) throw new WorkspaceScopeError('This family has links in Product family. Remove them there first; then colour products link it. Nothing was changed.', 409)
    const confirmed = (r: Row | undefined): r is Member['row'] => r?.state === 'LINKED' && !!r.shopifyProductId
    const rowOf = new Map(rows.map(r => [r.valueKey, r]))
    const problems = plan.issues.filter(i => i.severity === 'error').map(i => i.message)
    for (const p of plan.products) if (!confirmed(rowOf.get(p.key))) problems.push(`"${p.nexusValue}" has no confirmed Shopify product yet. Confirm it first.`)
    if (problems.length) throw new WorkspaceScopeError(`${[...new Set(problems)].join(' ')} Nothing was changed.`, 409)
    const inPlan = new Set(plan.products.map(p => p.key))
    members = [
      ...plan.products.map(p => ({ row: rowOf.get(p.key) as Member['row'], name: p.nexusValue, colourName: p.colourName })),
      ...rows.filter(r => !inPlan.has(r.valueKey)).filter(confirmed).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(row => ({ row, name: row.colourName ?? row.valueKey, colourName: null })),
    ]
    if (members.length > SHOPIFY_LINKED_LIST_LIMIT) throw new WorkspaceScopeError(`Shopify can group at most ${SHOPIFY_LINKED_LIST_LIMIT} products; this family has ${members.length} colour products. Nothing was changed.`, 409)
    const warnings = members.length > IMPACT_LINKED_SHOWN_LIMIT ? [`The theme shows at most ${IMPACT_LINKED_SHOWN_LIMIT} colours; this group has ${members.length}. The rest are grouped but not shown.`] : []
    const grouped = members.length >= 2
    if (!members.length) return { ...await colourProductsView(destination, plan, settings), link: { grouped, members: 0, written: 0, cleared: 0, warnings, verifiedAt: null } }

    const { graphql } = await shopifyAdmin(destination.accountId)
    const list = JSON.stringify(members.map(m => m.row.shopifyProductId))
    const wanted: Wanted[] = members.flatMap(member => grouped
      ? [...(member.colourName === null ? [] : [{ member, field: settings.valueField, type: VALUE_TYPE, next: member.colourName, isList: false }]), { member, field: settings.listField, type: LIST_TYPE, next: list, isList: true }]
      : [{ member, field: settings.listField, type: LIST_TYPE, next: null, isList: true }])
    const { remote, schema } = await readGroup(graphql, settings, members)
    const edits: ShopifyFieldEdit[] = []
    for (const w of [...wanted.filter(w => !w.isList), ...wanted.filter(w => w.isList)]) {
      const current = remote.get(w.member.row.shopifyProductId)!.fields[w.isList ? 1 : 0], label = `"${remote.get(w.member.row.shopifyProductId)!.title}" (${w.member.name})`
      if (current && current.type !== w.type) throw new WorkspaceScopeError(`${label}: Shopify holds ${address(w.field)} as ${current.type}, not ${w.type}. Nothing was changed.`, 422)
      if (shopifyValuesEqual(w.type, current?.value ?? null, w.next)) continue
      edits.push({ ownerId: w.member.row.shopifyProductId, namespace: w.field.namespace, key: w.field.key, type: w.type, value: current?.value ?? null, compareDigest: current?.compareDigest ?? null, nextValue: w.next, ownerLabel: label })
    }

    for (let offset = 0; offset < edits.length; offset += BATCH) {
      try {
        await applyLinkedBatch(graphql, edits.slice(offset, offset + BATCH), schema)
      } catch (error) {
        const words = error instanceof Error ? error.message : String(error)
        const done = offset ? ` The first ${offset} of ${edits.length} fields are written.` : ''
        throw new WorkspaceScopeError(`${words.trim().replace(/([^.!?])$/, '$1.')}${done} Run the link again: it writes only what is still missing.`,
          error instanceof WorkspaceScopeError && error.statusCode === 409 ? 409 : 502)
      }
    }
    if (edits.length) {
      const back = (await readGroup(graphql, settings, members)).remote
      const wrong = [...new Set(wanted.filter(w => !shopifyValuesEqual(w.type, back.get(w.member.row.shopifyProductId)!.fields[w.isList ? 1 : 0]?.value ?? null, w.next)).map(w => `"${w.member.name}"`))]
      if (wrong.length) throw new WorkspaceScopeError(`Shopify read back other colour fields for ${wrong.join(', ')}. Run the link again.`, 502)
    }
    const verifiedAt = new Date(), inGroup = new Set(members.map(m => m.row.id))
    await stampVerified(destination, members, verifiedAt)
    // A colour that left the group (not confirmed any more) keeps no "Linked ✓" from an earlier run.
    await stampVerified(destination, rows.filter(r => !inGroup.has(r.id) && r.linkVerifiedAt), null)
    return { ...await colourProductsView(destination, plan, settings),
      link: { grouped, members: members.length, written: edits.filter(e => e.nextValue !== null).length, cleared: edits.filter(e => e.nextValue === null).length, warnings, verifiedAt: verifiedAt.toISOString() } }
  } catch (error) {
    // A run that does not end verified leaves no "Linked ✓" behind on any confirmed colour of this family.
    await stampVerified(destination, rows.filter(r => r.state === 'LINKED'), null)
    throw error
  }
}

/** Both fields on every member, and the two definitions (their Shopify names word Shopify's refusals). */
async function readGroup(graphql: ShopifyGraphql, settings: ColourProductSettings, members: readonly Member[]) {
  const data = await graphql(LINK_READ, { ids: members.map(m => m.row.shopifyProductId), vns: settings.valueField.namespace, vkey: settings.valueField.key, lns: settings.listField.namespace, lkey: settings.listField.key })
  const nodes = new Map<string, any>((data.nodes ?? []).filter((n: any) => n?.id).map((n: any) => [n.id, n]))
  const gone = members.filter(m => !nodes.has(m.row.shopifyProductId))
  if (gone.length) throw new WorkspaceScopeError(`${gone.map(m => `The Shopify product of "${m.name}" no longer exists.`).join(' ')} Nothing was changed.`, 409)
  const definitions: ShopifyFieldDefinition[] = []
  for (const [field, type, node] of [[settings.valueField, VALUE_TYPE, data.valueDefinition], [settings.listField, LIST_TYPE, data.listDefinition]] as const) {
    const definition = node?.nodes?.[0]
    if (definition?.type?.name !== type) throw new WorkspaceScopeError(definition
      ? `The Shopify product field ${address(field)} is ${definition.type?.name}; colour products need ${type}. Nothing was changed.`
      : `The Shopify store has no product field ${address(field)} (${type}). Create it in Shopify (Settings → Custom data → Products) first. Nothing was changed.`, 422)
    definitions.push({ id: definition.id, name: definition.name, description: null, namespace: field.namespace, key: field.key, ownerType: 'PRODUCT', type, validations: [], access: { admin: null, storefront: null } })
  }
  const remote = new Map(members.map(m => {
    const node = nodes.get(m.row.shopifyProductId)
    return [m.row.shopifyProductId, { title: node.title as string, fields: [node.value ?? null, node.list ?? null] as [Remote | null, Remote | null] }]
  }))
  // Only these two fields are written, and neither is limited to a category: no other part of the store schema is needed.
  const schema: ShopifyStoreSchema = { definitions, metaobjectDefinitions: [], types: [], locales: [], revision: '' }
  return { remote, schema }
}

/** A Product family relationship on the family: the manual way of linking separate products (the empty record is not one). */
async function hasProductFamilyLinks(d: Destination) {
  const listing = await prisma.channelListing.findFirst({ where: { productId: d.familyId, channel: 'SHOPIFY', channelConnectionId: d.accountId, marketplace: d.marketplace, aliasKey: d.aliasKey ?? '' },
    select: { platformAttributes: true } })
  return !!object(object(listing?.platformAttributes)[LINKED_KEY]).relationship
}

function stampVerified(d: Destination, rows: ReadonlyArray<{ id: string } | { row: { id: string } }>, at: Date | null) {
  const ids = rows.map(r => 'row' in r ? r.row.id : r.id)
  return ids.length ? prisma.shopifyColourProduct.updateMany({ where: { ...rowsWhere(d), id: { in: ids } }, data: { linkVerifiedAt: at } }) : null
}
