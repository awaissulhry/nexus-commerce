/**
 * Every sentence the shared-products screens show about a share, a group, a run or a product.
 *
 * One place, so the three tabs and the copy drawer can never describe the same thing two ways
 * (plan §7.1 rule 4). Words are written for a person who has never seen the schema: no field keys,
 * no status enums, no ids.
 */
import type { CopyRunSummary, ProductOutcome, RunState, Selection, Share } from './sharingApi'

/** What each field group carries (apps/api/src/services/assortment/field-groups.ts). */
export const FIELD_GROUP_WORDS: Record<string, { label: string; description: string }> = {
  identity: { label: 'Identifiers', description: 'SKU, GTIN, EAN, UPC, brand and manufacturer' },
  content: { label: 'Titles and descriptions', description: 'Title, description, bullet points and keywords in the main language' },
  attributes: { label: 'Attributes and categories', description: 'Product type, category attributes and categories' },
  translations: { label: 'Translations', description: 'Titles and descriptions in other languages' },
  media: { label: 'Images', description: 'Copied into this business’s own image storage' },
  physical: { label: 'Weight and dimensions', description: 'Weight, length, width, height and their units' },
  compliance: { label: 'Compliance', description: 'HS code, country of origin, safety and conformity details' },
  structure: { label: 'Family and variations', description: 'Product family, and which products are variations of which' },
  price: { label: 'Prices', description: 'Base, minimum, maximum and business prices' },
  status: { label: 'Active or draft', description: 'Whether each product is active, draft or inactive' },
}

/** The API's own order, so a list of groups always reads the same way. */
export const FIELD_GROUP_ORDER = ['identity', 'content', 'attributes', 'translations', 'media', 'physical', 'compliance', 'structure', 'price', 'status'] as const
/** Offered unless the owner changes it; prices and status are each business's own decision. */
export const DEFAULT_FIELD_GROUPS: readonly string[] = ['identity', 'content', 'attributes', 'translations', 'media', 'physical', 'compliance', 'structure']

export function groupsSentence(groups: readonly string[]): string {
  const labels = FIELD_GROUP_ORDER.filter((group) => groups.includes(group)).map((group) => FIELD_GROUP_WORDS[group].label)
  return labels.length ? labels.join(' · ') : 'Nothing'
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function dateWords(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}

/** " on 17 Sept 2026", or nothing when the date is not recorded — never "on ." */
function on(value: string | null | undefined): string {
  return value ? ` on ${dateWords(value)}` : ''
}

export function selectionWords(selection: Selection, members: number): string {
  return selection === 'list'
    ? `Products you choose · ${count(members, 'product')}`
    : `Every product except the ones you exclude · ${count(members, 'excluded product')}`
}

export type ShareSide = 'owner' | 'follower'
export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral'

/** The status as the business in front of the screen should read it. */
export function statusWords(share: Share, side: ShareSide): { label: string; tone: Tone; detail: string } {
  const other = side === 'owner' ? share.workspaceName : share.ownerWorkspaceName
  switch (share.status) {
    case 'pending':
      return side === 'owner'
        ? { label: 'Waiting for an answer', tone: 'info', detail: `Offered${on(share.createdAt)}. An owner of ${other} must accept.` }
        : { label: 'Offer to review', tone: 'info', detail: `Offered by ${other}${on(share.createdAt)}.` }
    case 'active':
      return { label: 'Active', tone: 'success', detail: `Accepted${on(share.respondedAt)}.` }
    case 'paused':
      return side === 'owner'
        ? { label: 'Paused', tone: 'warning', detail: `You paused it${on(share.pausedAt)}.` }
        : { label: 'Paused', tone: 'warning', detail: `Paused by ${other}${on(share.pausedAt)}. You can copy again when they resume.` }
    case 'declined':
      return side === 'owner'
        ? { label: 'Declined', tone: 'neutral', detail: `${other} declined${on(share.endedAt ?? share.respondedAt)}.` }
        : { label: 'Declined', tone: 'neutral', detail: `You declined${on(share.endedAt ?? share.respondedAt)}.` }
    case 'revoked': {
      const byOwner = share.endedBySide === 'owner'
      const who = side === 'owner' ? (byOwner ? 'You' : other) : (byOwner ? other : 'You')
      const how = byOwner ? (share.respondedAt ? 'ended' : 'withdrew') : 'left'
      return { label: 'Ended', tone: 'neutral', detail: `${who} ${how} this share${on(share.endedAt)}.` }
    }
  }
}

export function runStateWords(state: RunState): { label: string; tone: Tone } {
  switch (state) {
    case 'preparing': return { label: 'Preparing the review', tone: 'info' }
    case 'reviewing': return { label: 'Waiting for your field review', tone: 'info' }
    case 'finishing': return { label: 'Linking products', tone: 'info' }
    case 'done': return { label: 'Copied', tone: 'success' }
    case 'partial': return { label: 'Copied with problems', tone: 'warning' }
    case 'failed': return { label: 'Could not start', tone: 'danger' }
    case 'abandoned': return { label: 'Stopped', tone: 'neutral' }
  }
}

/** One line for a finished run; nothing is said about counts a run never produced. */
export function runResultWords(run: Pick<CopyRunSummary, 'state' | 'products' | 'skipped' | 'counts' | 'error'>): string {
  const c = run.counts
  if (!c) return run.state === 'failed' || run.state === 'abandoned' ? (run.error ?? 'No products were copied.') : `${count(run.products, 'product')} in review`
  const parts = [`${count(c.linked + c.alreadyLinked, 'product')} linked`]
  if (c.imagesCopied + c.imagesAddressed) parts.push(`${count(c.imagesCopied + c.imagesAddressed, 'image')} added`)
  const problems = c.notSaved + c.linkRefused + c.managedFailed + c.imagesFailed
  if (problems) parts.push(`${count(problems, 'problem')}`)
  if (run.skipped) parts.push(`${count(run.skipped, 'product')} skipped`)
  return parts.join(' · ')
}

/**
 * Which products a copy takes, before it is confirmed: the API's rule (copy-run.service.ts planProducts).
 * A new product is copied; an existing SKU only when linked; a variation only with its main product.
 */
export function plannedCopy(products: ProductOutcome[], choices: Record<string, 'link' | 'skip'>) {
  const outcome = new Map(products.map((p) => [p.sku, p]))
  const included = new Set<string>()
  const skippedByParent = new Set<string>()
  for (const p of products) {
    if (p.parentSku && !included.has(p.parentSku) && outcome.get(p.parentSku)?.kind !== 'linked') { skippedByParent.add(p.sku); continue }
    if (p.kind === 'new' || (p.kind === 'match' && choices[p.sku] === 'link')) included.add(p.sku)
  }
  return { included: included.size, includedSkus: included, skippedByParent }
}

export function outcomeWords(outcome: ProductOutcome): string {
  switch (outcome.kind) {
    case 'new': return 'Created in this business'
    case 'match': return `This business already has this SKU (${outcome.followerName})`
    case 'linked': return 'Already linked'
    case 'blocked': return outcome.reason
  }
}

const ATTRIBUTE_TYPE_WORDS: Record<string, string> = {
  text: 'short text', textarea: 'long text', number: 'number', boolean: 'yes or no', select: 'one choice from a list',
  multiselect: 'several choices from a list', date: 'date', reference: 'reference', asset: 'file',
}
export function attributeTypeWords(type: string): string {
  return ATTRIBUTE_TYPE_WORDS[type] ?? 'another kind of value'
}

/** Why a field is not copied: a group that was not offered, or a field that is never shared. */
export function excludedWords(entry: { group: string | null; reason: string | null }): string {
  if (entry.group) return `${FIELD_GROUP_WORDS[entry.group]?.label ?? 'This kind of detail'} was not shared`
  const reason = entry.reason ?? 'not shared'
  return reason.charAt(0).toUpperCase() + reason.slice(1)
}

/** "1 video, 3D model or document is" / "2 videos, 3D models or documents are". */
export function otherMediaWords(n: number): string {
  return n === 1 ? '1 video, 3D model or document is' : `${n.toLocaleString()} videos, 3D models or documents are`
}

export function bytesWords(bytes: number | null): string {
  if (bytes === null) return 'size unknown'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`
  return `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
}
