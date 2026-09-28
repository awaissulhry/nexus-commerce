/**
 * Sharing studio step 2 — every sentence the "Other businesses" page says, in one place and pure, so it is tested
 * and the page never words the same fact two ways. Dates and counts use the Settings › Shared products words.
 */
import type { ValueSourceKind } from '@/design-system/components'
import type { ActionImpact } from '@/design-system/grid'
import { count, dateWords, type Tone } from '@/app/settings/sharing/words'
import type { AssortmentPlace, FollowedLink, ProductSharing, ShareCopy, SharedField } from './sharingApi'

export { count, dateWords }

/** The name the page uses for the other business, never an empty string. */
export const businessName = (name: string | null | undefined) => name?.trim() || 'the other business'

/** One followed field's source, as the design system's value-source mark says it. */
export function fieldSource(field: Pick<SharedField, 'state'>, business: string | null): { kind: ValueSourceKind; label: string; description: string } {
  const from = businessName(business)
  return field.state === 'follow'
    ? { kind: 'linked', label: `Follows ${from}`, description: `A change made in ${from} arrives here by itself.` }
    : { kind: 'override', label: 'Own value', description: `This business changed it, so a change made in ${from} does not replace it.` }
}

/** A field's name with its language, when it is a translation: "Title · DE". */
export function fieldName(field: Pick<SharedField, 'label' | 'locale'>): string {
  return field.locale ? `${field.label} · ${field.locale.toUpperCase()}` : field.label
}

/** The link's facts for the page's summary. */
export function followingFacts(link: FollowedLink, fields: SharedField[]): Array<{ label: string; value: string; hint?: string }> {
  const kept = fields.filter((f) => f.state === 'override').length
  return [
    { label: 'Follows', value: businessName(link.sourceBusiness) },
    { label: 'How it was linked', value: link.linkedBy === 'matched' ? 'A product of this business, linked by its SKU' : 'Copied from the other business' },
    { label: 'Last updated from there', value: link.lastSyncedAt ? dateWords(link.lastSyncedAt) : 'Not yet' },
    { label: 'Fields', value: `${count(fields.length - kept, 'field')} ${fields.length - kept === 1 ? 'follows' : 'follow'}`, hint: kept ? `${count(kept, 'field')} ${kept === 1 ? 'keeps' : 'keep'} this business’s own value` : undefined },
  ]
}

/**
 * The field list, compact: the fields this business keeps are always shown; the (often hundreds of) fields that follow
 * are one button away.
 */
export function fieldListWords(kept: number, followed: number, business: string | null, open: boolean): { keptTitle: string | null; none: string | null; toggle: string | null } {
  const from = businessName(business)
  return {
    keptTitle: kept ? `Kept here: ${count(kept, 'field')} with this business’s own value` : null,
    none: kept ? null : followed ? `Every field follows ${from}.` : `No field is recorded yet. The first update from ${from} records them.`,
    // Short: a button label does not wrap, and it must fit a phone. The business is named just above it.
    toggle: followed ? `${open ? 'Hide' : 'Show'} ${count(followed, 'followed field')}` : null,
  }
}

/** The link stopped: what the page says instead of the fields. */
export function detachedWords(link: FollowedLink): { title: string; body: string } {
  const from = businessName(link.sourceBusiness)
  return {
    title: `This product stopped following ${from}`,
    body: `${link.detachedReason ? `Why: ${link.detachedReason}. ` : ''}It is this business’s own product now and keeps every value it had. Nothing was deleted and no listing ended.`,
  }
}

/** An owner's product: what one other business does with it. */
export function copyWords(copy: ShareCopy): { label: string; tone: Tone; hint: string | null } {
  if (copy.copy === 'following') {
    const problem = copy.heldSku ? `SKU change to ${copy.heldSku} waits there.` : copy.lastSyncError ? 'Some changes could not be applied there.' : null
    return { label: 'Follows this product', tone: problem ? 'warning' : 'success', hint: problem ?? (copy.lastSyncedAt ? `Updated ${dateWords(copy.lastSyncedAt)}` : 'Not updated yet') }
  }
  if (copy.copy === 'detached') return { label: 'Stopped following', tone: 'neutral', hint: copy.detachedReason ? `Why: ${copy.detachedReason}` : null }
  return copy.shareStatus === 'pending'
    ? { label: 'Offer not answered yet', tone: 'info', hint: `An owner of ${copy.businessName} must accept the offer, then copy the products.` }
    : { label: 'Not copied yet', tone: 'info', hint: `${copy.businessName} gets it with its next copy of shared products.` }
}

/** The share's state, in the page's words. */
export function shareStateWords(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'pending': return { label: 'Offered', tone: 'info' }
    case 'active': return { label: 'Active', tone: 'success' }
    case 'paused': return { label: 'Paused', tone: 'warning' }
    default: return { label: status.charAt(0).toUpperCase() + status.slice(1), tone: 'neutral' }
  }
}

/** Whether an assortment holds the product, in words — a variation is held through its main product. */
export function holdsWords(place: AssortmentPlace, product: ProductSharing['product']): string {
  const through = product.isVariation ? ` (with its main product ${product.rootSku})` : ''
  if (place.selection === 'all') return place.holds ? `Yes: it holds every product${through}` : 'No: left out of “every product”'
  return place.holds ? `Yes${through}` : 'No'
}

/** The button that changes it. */
export function placeActionLabel(place: AssortmentPlace): string {
  if (place.selection === 'all') return place.holds ? 'Leave out' : 'Put back'
  return place.holds ? 'Take out' : 'Add'
}

/**
 * Taking the product out of an assortment that is offered to other businesses: they stop following it. The DS confirm
 * lists exactly who, and what they keep. Null when nobody is offered the assortment (nothing to confirm).
 */
export function takeOutImpact(place: AssortmentPlace, product: ProductSharing['product'], copies: ShareCopy[]): ActionImpact | null {
  const affected = copies.filter((c) => c.assortmentId === place.id)
  if (!affected.length) return null
  const sku = product.isVariation ? product.rootSku : product.sku
  return {
    level: 'confirm',
    reach: 'local',
    reversal: { verb: `Put it back in ${place.name}; each business then links it again with its next copy`, fidelity: 'lossy' },
    subject: { kind: 'sku', value: sku },
    title: `Take ${sku} out of ${place.name}?`,
    consequences: [
      ...affected.map((c) => c.copy === 'following'
        ? `${c.businessName} stops following it. Its copy stays there as its own product, with every value it has now.`
        : `${c.businessName} will not get it with its next copy.`),
      'Nothing is deleted, and no listing ends, in any business.',
      ...(product.isVariation ? [`${sku} is the main product: its variations go with it.`] : []),
    ],
  }
}

/** Where this product's stock comes from. */
export function stockWords(source: ProductSharing['stock']['source']): string {
  return source.kind === 'own'
    ? 'Sells from this business’s own stock.'
    : `${source.products > 1 ? `${source.products} variations sell` : 'Sells'} from ${source.lenderName}’s shared stock: ${source.available.toLocaleString()} available there.`
}
