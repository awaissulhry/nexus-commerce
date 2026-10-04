import { createHash } from 'node:crypto'
import type { StudioPublishChange, StudioPublishFieldWrite, StudioPublishValue } from '@nexus/shared/studio-publication'
import { AmazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { getAmazonRegion } from '../../lib/amazon-sp-client.js'
import { amazonRootPatch, type AttributePatch } from '../amazon/mapping-payload.js'
import { compareAmazonAttributes, compareAmazonContent, CONTENT_ROOTS, OUT_OF_SCOPE_ROOTS, STRUCTURE_ROOTS, leaves } from '../channel-drift/amazon-content-compare.js'
import { loadAmazonSpec } from './channel-specs/index.js'
import type { ChannelSpec } from './channel-specs/types.js'
import { attributeDeleteValue, attributeSelectorKeys } from './mapping/schema-requirements.js'
import { planPublicationChanges, publicationChangeId, selectPublicationChanges, type PublicationChangeInput } from './studio-publication-changes.js'
import type { AmazonPublication } from './studio-publication-amazon.js'
import type { PublicationFacts } from './studio-publication-plan.js'
import { languageTag } from './market-languages.js'
import { amazonOfferLines, compileAmazonOffer, isOfferLaneRoot, withOfferDisplay, type AmazonOfferJournal, type AmazonOfferPlan } from './studio-publication-amazon-offer.js'

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const known = (value: unknown): StudioPublishValue => ({ state: 'value', value })
const absent: StudioPublishValue = { state: 'absent' }
const unknown = (reason: string): StudioPublishValue => ({ state: 'unknown', reason })
const contentOnly = (attributes: Record<string, unknown>) => Object.fromEntries(Object.entries(attributes).filter(([root]) => !OUT_OF_SCOPE_ROOTS.has(root)))
type Message = AmazonPublication['feed']['messages'][number]
type ProductPlan = { productId: string; sku: string; newListing: boolean; patches: Record<string, AttributePatch>;
  content: Record<string, { root: string; tag: string; deletion?: AttributePatch }>;
  contentRoots: Record<string, { remote: Record<string, unknown>[]; replacement: AttributePatch }>; offer?: AmazonOfferPlan }
export interface AmazonChangePlan {
  kind: 'amazon-changes'
  changes: StudioPublishChange[]
  remoteRevision: string
  publication: AmazonPublication
  products: ProductPlan[]
}

/** Language instances are independent accepted baselines, even when Amazon requires one full-root replacement. */
export const amazonContentField = (root: string, marketplaceId: string, tag: string) => `${root}:${JSON.stringify([marketplaceId, tag])}`
function contentCoordinate(field: string) {
  const root = CONTENT_ROOTS.find(root => field.startsWith(`${root}:`))
  if (!root) return null
  try {
    const tuple: unknown = JSON.parse(field.slice(root.length + 1))
    return Array.isArray(tuple) && tuple.length === 2 && tuple.every(value => typeof value === 'string') ? { root, market: tuple[0] as string, tag: tuple[1] as string } : null
  } catch { return null }
}

function currentRoots(message: Message): Record<string, StudioPublishValue> {
  const values: Record<string, StudioPublishValue> = Object.fromEntries(Object.entries(message.attributes ?? {}).map(([root, value]) => [root, known(value)]))
  for (const patch of message.patches ?? []) {
    const root = /^\/attributes\/([^/]+)$/.exec(patch.path)?.[1]
    if (!root || !['replace', 'delete'].includes(patch.op)) throw new Error(`${message.sku}: an unsupported attribute patch cannot be reviewed.`)
    values[root] = patch.op === 'delete' ? absent : known(patch.value)
  }
  return values
}

function entries(value: unknown, root: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error(`Cannot safely change ${root}: its attribute instances are unavailable.`)
  return value as Record<string, unknown>[]
}

function contentGroups(root: string, value: unknown, marketplaceId: string, allowOtherMarkets = false) {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const entry of entries(value, root)) {
    if (typeof entry.language_tag !== 'string' || !/^[a-z]{2,3}_[A-Z]{2}$/.test(entry.language_tag)) throw new Error(`Cannot safely preserve ${root}: its language_tag selector is missing or invalid.`)
    if (entry.marketplace_id && entry.marketplace_id !== marketplaceId) {
      if (allowOtherMarkets) continue
      throw new Error(`Cannot change ${root}: an intended instance belongs to another marketplace.`)
    }
    const list = groups.get(entry.language_tag) ?? []; list.push(entry); groups.set(entry.language_tag, list)
  }
  return groups
}

function contentInputs(root: string, local: StudioPublishValue, legacy: StudioPublishValue, scoped: Map<string, StudioPublishValue>, clear: unknown,
  remote: unknown, spec: ChannelSpec, marketplaceId: string, product: ProductPlan, refusal?: string): PublicationChangeInput[] {
  let desired = new Map<string, Record<string, unknown>[]>(), previous = new Map<string, Record<string, unknown>[]>()
  let observed = new Map<string, Record<string, unknown>[]>(), cleared = new Map<string, Record<string, unknown>[]>()
  let blocked = refusal
  try { if (local.state === 'value') desired = contentGroups(root, local.value, marketplaceId) } catch (error) { blocked = String((error as Error).message) }
  try { if (legacy.state === 'value') previous = contentGroups(root, legacy.value, marketplaceId, true) } catch (error) { blocked = String((error as Error).message) }
  try { if (clear !== undefined) cleared = contentGroups(root, clear, marketplaceId) } catch (error) { blocked = String((error as Error).message) }
  try { if (remote !== undefined) observed = contentGroups(root, remote, marketplaceId, true) } catch (error) { blocked = String((error as Error).message) }
  if (!spec.validationSchema || spec.absent || !Object.prototype.hasOwnProperty.call(object(spec.validationSchema.properties), root)) blocked = `Cannot safely change ${root}: the category schema is unavailable.`
  if (spec.fields.some(field => field.attribute === root && !field.editable)) blocked = `${root} cannot be edited on an existing Amazon listing.`
  const tags = new Set([...desired.keys(), ...previous.keys(), ...cleared.keys()])
  for (const field of scoped.keys()) { const coordinate = contentCoordinate(field); if (coordinate?.root === root && coordinate.market === marketplaceId) tags.add(coordinate.tag) }
  if (!tags.size) return [{ productId: product.productId, sku: product.sku, field: root, label: root,
    current: unknown(blocked ?? `${root} is omitted; no language-specific intent was prepared.`), lastAccepted: legacy, channel: unknown(blocked ?? 'The content language is unavailable.'), refusal: blocked ?? 'A content language is required.' }]
  product.contentRoots[root] = { remote: Array.isArray(remote) ? clone(remote) : [], replacement: amazonRootPatch(spec, root, []) }
  return [...tags].sort().map(tag => {
    const field = amazonContentField(root, marketplaceId, tag)
    const current = desired.has(tag) ? known(desired.get(tag)) : cleared.has(tag) ? absent : unknown(`${root} ${tag} is omitted; no explicit clear was prepared.`)
    const lastAccepted = scoped.get(field) ?? (previous.has(tag) ? known(previous.get(tag)) : unknown('No accepted publish record for this language.'))
    const channel = blocked ? unknown(blocked) : observed.has(tag) ? known(observed.get(tag)) : absent
    const metadata: ProductPlan['content'][string] = { root, tag }
    let fieldRefusal = blocked
    if (!blocked && current.state === 'absent' && channel.state === 'value') {
      try {
        if (!attributeSelectorKeys(spec, root).includes('language_tag')) throw new Error(`Cannot clear ${root} ${tag}: the category has no language_tag selector to isolate this language.`)
        metadata.deletion = amazonRootPatch(spec, root, undefined, (observed.get(tag) ?? []).map(entry => ({ ...entry, marketplace_id: entry.marketplace_id ?? marketplaceId })))
      }
      catch (error) { fieldRefusal = (error as Error).message }
    }
    product.content[field] = metadata
    return { productId: product.productId, sku: product.sku, field, label: `${root} · ${tag}`, current, lastAccepted, channel,
      ...(fieldRefusal ? { refusal: fieldRefusal } : {}), currentMatchesChannel: providerEqual(root, current, channel, marketplaceId), acceptedMatchesChannel: providerEqual(root, lastAccepted, channel, marketplaceId) }
  })
}

/** Only an authored, mapped, non-fallback blank is a language-specific content clear. */
function contentClears(facts: PublicationFacts, productId: string, spec: ChannelSpec, marketplaceId: string) {
  const clears: Record<string, Record<string, unknown>[]> = {}
  for (const batch of facts.resolved ?? []) {
    if (!facts.languages?.includes(batch.locale)) continue
    const cells = batch.products.find(product => product.productId === productId)?.cells ?? {}
    for (const root of CONTENT_ROOTS) {
      const authoredBlank = spec.fields.filter(field => field.attribute === root).some(field => {
        const cell = cells[field.key]
        return cell?.status === 'mapped' && cell.provenance === 'override' && cell.needsTranslation === false
          && (!cell.requestedLocale || cell.requestedLocale === batch.locale)
          && (cell.value === null || cell.value === '' || (Array.isArray(cell.value) && cell.value.length === 0))
      })
      if (authoredBlank) (clears[root] ??= []).push({ marketplace_id: marketplaceId, language_tag: languageTag(batch.locale, facts.scope.marketplace) })
    }
  }
  return clears
}

/** Keep other selector instances in full-root replaces. Delete payloads identify the actual observed instances. */
function rootPatch(spec: ChannelSpec, root: string, current: StudioPublishValue, baseline: StudioPublishValue, remote: unknown, market: string, explicitDelete?: unknown) {
  if (!spec.validationSchema || spec.absent || !Object.prototype.hasOwnProperty.call(object(spec.validationSchema.properties), root)) throw new Error(`Cannot safely change ${root}: the category schema is unavailable.`)
  if (current.state === 'unknown') throw new Error(current.reason)
  const desired = current.state === 'value' ? entries(current.value, root) : []
  const prior = baseline.state === 'value' ? entries(baseline.value, root) : []
  const theirs = remote === undefined ? [] : entries(remote, root)
  // Previously sent languages are comparison evidence, not permission to clear an omitted language.
  let owned = [...desired, ...(explicitDelete === undefined ? [] : entries(explicitDelete, root))]
  if (!owned.length) owned = entries(attributeDeleteValue(spec, root), root)
  const selectors = attributeSelectorKeys(spec, root).filter(key => key !== 'value')
  // Language instances must never be guessed from a schema default when Amazon omitted their identity.
  if ([...owned, ...theirs].some(entry => entry.language_tag !== undefined) && !selectors.includes('language_tag')) selectors.push('language_tag')
  const identity = (entry: Record<string, unknown>) => canonical(selectors.map(key => {
    const value = entry[key] ?? (key === 'marketplace_id' ? market : undefined)
    if (value === undefined || value === null || value === '') throw new Error(`Cannot safely preserve ${root}: its ${key} selector is missing.`)
    return value
  }))
  const ownedKeys = new Set(owned.map(identity))
  const selected = theirs.filter(entry => ownedKeys.has(identity(entry)))
  const preserved = theirs.filter(entry => !ownedKeys.has(identity(entry)))
  const channel = selected.length ? known(selected) : absent
  const accepted = prior.filter(entry => ownedKeys.has(identity(entry)))
  const patch = current.state === 'value' ? amazonRootPatch(spec, root, [...desired, ...preserved])
    : selected.length ? amazonRootPatch(spec, root, undefined, selected.map(entry => ({ ...entry, ...(selectors.includes('marketplace_id') && entry.marketplace_id === undefined ? { marketplace_id: market } : {}) }))) : null
  return { channel, patch, baseline: baseline.state === 'value' ? accepted.length ? known(accepted) : absent : baseline }
}

function providerEqual(root: string, ours: StudioPublishValue, theirs: StudioPublishValue, marketplaceId: string): boolean | undefined {
  if (ours.state === 'unknown' || theirs.state === 'unknown') return undefined
  if (ours.state !== theirs.state) return false
  if (ours.state === 'absent' || theirs.state === 'absent') return true
  const mine = ours.value as Record<string, unknown>[], remote = theirs.value as Record<string, unknown>[]
  if (mine.length !== remote.length) return false
  if ((CONTENT_ROOTS as readonly string[]).includes(root)) {
    const tags = [...new Set(mine.map(entry => entry.language_tag).filter((tag): tag is string => typeof tag === 'string'))]
    const compared = compareAmazonContent({ [root]: mine as any }, { [root]: remote }, { marketplaceId, tags })
    return tags.length ? compared.compared.length === tags.length && !compared.differing.length : canonical(leaves(mine)) === canonical(leaves(remote))
  }
  if (STRUCTURE_ROOTS.has(root)) return canonical(leaves(mine)) === canonical(leaves(remote))
  const compared = compareAmazonAttributes({ [root]: mine }, { [root]: remote })
  return compared.compared.includes(root) && !compared.differing.length
}

/** Five concurrent reads; each group of up to21 products gets a finite 9.5-second family budget. */
export async function prepareAmazonChanges(facts: PublicationFacts, publication: AmazonPublication, baselineValues: Map<string, StudioPublishValue>): Promise<AmazonChangePlan> {
  const prepared = clone(publication)
  const previouslyPublished = new Set([...baselineValues.keys()].map(key => (JSON.parse(key) as [string, string])[0]))
  const client = prepared.products.length ? new AmazonSpApiClient({ id: facts.scope.accountId, region: await getAmazonRegion(facts.scope.accountId) }) : null
  const schemaPromises = new Map<string, Promise<ChannelSpec>>()
  const products: ProductPlan[] = [], inputs: PublicationChangeInput[][] = [], observations: unknown[] = []
  const readBudgetMs = 9_500 * Math.max(1, Math.ceil(prepared.products.length / 21))
  const deadline = Date.now() + readBudgetMs
  const timeoutMessage = `The live content read exceeded the ${readBudgetMs / 1_000}-second review budget.`
  let next = 0
  async function worker() {
    while (next < prepared.products.length) {
      const index = next++, product = prepared.products[index]
      const messages = prepared.feed.messages.filter(message => message.sku === product.sku)
      if (messages.length !== 1 || !facts.products.some(p => p.id === product.productId)) throw new Error(`${product.sku}: the prepared product identity is ambiguous.`)
      const message = messages[0], current = currentRoots(message)
      const newListing = !facts.listings.find(listing => listing.productId === product.productId)?.externalListingId && !previouslyPublished.has(product.productId)
      const meta: ProductPlan = { ...product, newListing, patches: {}, content: {}, contentRoots: {} }
      products[index] = meta; inputs[index] = []
      if (newListing && (message.operationType !== 'UPDATE' || !message.attributes)) throw new Error(`${product.sku}: a new listing requires its complete UPDATE.`)
      if (!newListing && !schemaPromises.has(message.productType)) schemaPromises.set(message.productType, loadAmazonSpec(facts.scope.marketplace, message.productType, facts.scope.accountId))
      const spec = newListing ? null : await schemaPromises.get(message.productType)!
      const clearSelectors = spec ? contentClears(facts, product.productId, spec, prepared.marketplaceId) : {}
      for (const [root, selectors] of Object.entries(clearSelectors)) {
        const desired = current[root]?.state === 'value' ? entries((current[root] as { state: 'value'; value: unknown }).value, root)
          .filter(entry => !selectors.some(selector => entry.language_tag === selector.language_tag && (!entry.marketplace_id || entry.marketplace_id === selector.marketplace_id))) : []
        current[root] = desired.length ? known(desired) : absent
      }
      let raw: Record<string, any> = {}, readError: string | null = null, confirmedAbsent = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(timeoutMessage)
        const response = await Promise.race([client!.getListingsItem({ sellerId: prepared.sellerId, sku: product.sku, marketplaceId: prepared.marketplaceId, includedData: ['summaries', 'attributes'] }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(timeoutMessage)), remaining) })])
        if (!response.success) throw new Error(response.error ?? 'Amazon could not read this listing.')
        // The client produces this exact no-body result only for HTTP 404. A failed or empty 200 is not absence.
        confirmedAbsent = response.sku === product.sku && response.asin === null && response.status === null && response.rawResponse === undefined && response.error === undefined
        raw = object(response.rawResponse)
        if (typeof raw.sku === 'string' && raw.sku !== product.sku) throw new Error('Amazon returned another seller SKU; this listing could not be compared.')
        if (!(newListing && confirmedAbsent) && (!raw.attributes || typeof raw.attributes !== 'object' || Array.isArray(raw.attributes))) throw new Error('Amazon did not return listing attributes.')
      } catch (error) { readError = error instanceof Error ? error.message : String(error) }
      finally { if (timer) clearTimeout(timer) }
      if (newListing) {
        const refusal = readError ?? (confirmedAbsent ? null : 'This seller SKU already exists on Amazon. Link the existing listing before publishing; a full UPDATE was refused.')
        observations[index] = { sku: product.sku, newListing: true, confirmedAbsent, error: refusal }
        inputs[index].push({ ...product, field: '$create', label: 'Create complete listing', current: known(message), lastAccepted: unknown('No accepted publish record'),
          channel: confirmedAbsent && !readError ? absent : unknown(refusal!), newListing: confirmedAbsent && !readError, ...(refusal ? { refusal } : {}) })
        continue
      }
      const productType = Array.isArray(raw.summaries) ? raw.summaries.find((summary: any) => summary.marketplaceId === prepared.marketplaceId)?.productType : undefined
      const refusal = readError ?? (!productType ? 'Amazon did not confirm the selected marketplace and product type.' : productType !== message.productType ? `Amazon product type ${productType} differs from prepared product type ${message.productType}. Reconcile it before publishing.` : null)
      observations[index] = { sku: product.sku, productType: productType ?? null, attributes: readError ? null : contentOnly(object(raw.attributes)), error: refusal }
      const roots = new Set(Object.keys(current))
      const scoped = new Map<string, StudioPublishValue>()
      for (const key of baselineValues.keys()) {
        const coordinate: unknown = JSON.parse(key)
        if (Array.isArray(coordinate) && coordinate[0] === product.productId && typeof coordinate[1] === 'string') {
          const content = contentCoordinate(coordinate[1])
          if (content && content.market !== prepared.marketplaceId) continue
          roots.add(content?.root ?? coordinate[1]); scoped.set(coordinate[1], baselineValues.get(key)!)
        }
      }
      // Amazon sheet gaps — the offer roots are the offer lane's (below); `list_price` is a root line like any other.
      for (const root of [...roots].sort().filter(root => !isOfferLaneRoot(root) && root !== '$create')) {
        const local = Object.prototype.hasOwnProperty.call(current, root) ? current[root] : unknown(`${root} is omitted by the content builder; no explicit clear was prepared.`)
        const baseline = baselineValues.get(publicationChangeId(product.productId, root)) ?? unknown('No accepted publish record')
        const clear = clearSelectors[root] ?? message.patches?.find(patch => patch.op === 'delete' && patch.path === `/attributes/${root}`)?.value
        if ((CONTENT_ROOTS as readonly string[]).includes(root)) {
          inputs[index].push(...contentInputs(root, local, baseline, scoped, clear, object(raw.attributes)[root], spec, prepared.marketplaceId, meta, refusal ?? undefined))
          continue
        }
        let channel = unknown(refusal ?? 'The attribute could not be compared.'), comparisonBaseline = baseline, blocked = refusal ?? undefined
        try {
          if (!blocked) {
            const built = rootPatch(spec, root, local, baseline, object(raw.attributes)[root], prepared.marketplaceId,
              clear)
            channel = built.channel
            comparisonBaseline = built.baseline
            if (built.patch) meta.patches[root] = built.patch
            if (spec.fields.filter(field => field.attribute === root).some(field => !field.editable)) blocked = `${root} cannot be edited on an existing Amazon listing.`
          }
        } catch (error) { blocked = error instanceof Error ? error.message : String(error) }
        inputs[index].push({ ...product, field: root, label: spec.fields.find(field => field.attribute === root)?.englishLabel ?? root,
          current: local, lastAccepted: baseline, channel, ...(blocked ? { refusal: blocked } : {}),
          currentMatchesChannel: providerEqual(root, local, channel, prepared.marketplaceId), acceptedMatchesChannel: providerEqual(root, comparisonBaseline, channel, prepared.marketplaceId) })
      }
      inputs[index].push(...await amazonOfferLines(facts, meta, { marketplaceId: prepared.marketplaceId, remote: refusal ? null : object(raw.attributes), refusal: refusal ?? undefined }))
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, prepared.products.length) }, () => worker()))
  return { kind: 'amazon-changes', publication: prepared, products, changes: withOfferDisplay(planPublicationChanges(inputs.flat()), products), remoteRevision: createHash('sha256').update(canonical(observations)).digest('hex') }
}

/** Compile only the selected reviewed fields; companions preserved in a patch never become intentional writes. */
export function compileAmazonChanges(plan: AmazonChangePlan, selectedIds: string[]): AmazonPublication {
  const selected = selectPublicationChanges(plan.changes, selectedIds)
  const messages: Message[] = [], products: AmazonPublication['products'] = [], fieldWrites: Record<string, StudioPublishFieldWrite[]> = {}
  const offers: Record<string, AmazonOfferJournal> = {}
  for (const product of plan.products) {
    const changes = selected.filter(change => change.productId === product.productId)
    if (!changes.length) continue
    const message = plan.publication.feed.messages.find(message => message.sku === product.sku)!
    if (product.newListing) {
      if (changes.length !== 1 || changes[0].field !== '$create') throw new Error(`${product.sku}: select the complete new listing.`)
      messages.push({ ...clone(message), messageId: messages.length + 1 })
      fieldWrites[product.productId] = Object.entries(message.attributes ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap<StudioPublishFieldWrite>(([root, value]) => (CONTENT_ROOTS as readonly string[]).includes(root)
        ? [...contentGroups(root, value, plan.publication.marketplaceId)].map(([tag, instances]) => ({ field: amazonContentField(root, plan.publication.marketplaceId, tag), value: { state: 'value' as const, value: clone(instances) } }))
        : [{ field: root, value: { state: 'value' as const, value: clone(value) } }])
    } else {
      const patches = changes.filter(change => !product.content[change.field] && !product.offer?.lines[change.field]).map(change => {
        if (!product.patches[change.field]) throw new Error(`${change.field}: no safe reviewed Amazon patch exists.`)
        return clone(product.patches[change.field])
      })
      const contentRoots = new Set(changes.flatMap(change => product.content[change.field] ? [product.content[change.field].root] : []))
      for (const root of contentRoots) {
        const selected = changes.filter(change => product.content[change.field]?.root === root)
        const tags = new Set(selected.map(change => product.content[change.field].tag))
        const desired = selected.flatMap(change => change.current.state === 'value' ? entries(change.current.value, root) : [])
        const saved = product.contentRoots[root]
        if (desired.length) {
          const preserved = saved.remote.filter(entry => entry.marketplace_id && entry.marketplace_id !== plan.publication.marketplaceId || !tags.has(String(entry.language_tag)))
          patches.push({ ...clone(saved.replacement), value: clone([...desired, ...preserved]) })
        } else {
          const deletions = selected.map(change => product.content[change.field].deletion)
          if (deletions.some(deletion => !deletion || !Array.isArray(deletion.value))) throw new Error(`${root}: no safe language-specific delete was reviewed.`)
          patches.push({ ...clone(deletions[0]!), value: deletions.flatMap(deletion => clone(deletion!.value as unknown[])) })
        }
      }
      // Amazon sheet gaps — the selected offer leaves: one whole-root replace per root, and the journal's record of them.
      const offerFields = changes.filter(change => product.offer?.lines[change.field]).map(change => change.field)
      if (offerFields.length) {
        const compiled = compileAmazonOffer(product.offer!, offerFields, product.sku)
        patches.push(...compiled.patches)
        offers[product.productId] = compiled.offer
      }
      messages.push({ messageId: messages.length + 1, sku: product.sku, operationType: 'PATCH', productType: message.productType, patches })
      fieldWrites[product.productId] = changes.map(change => {
        if (change.current.state === 'unknown') throw new Error(`${change.field}: the intended value is unknown.`)
        return { field: change.field, value: clone(change.current) }
      })
    }
    products.push({ productId: product.productId, sku: product.sku })
  }
  return { kind: 'amazon', sellerId: plan.publication.sellerId, marketplaceId: plan.publication.marketplaceId, products,
    feed: { header: clone(plan.publication.feed.header), messages }, fieldWrites, ...(Object.keys(offers).length ? { offers } : {}) }
}
