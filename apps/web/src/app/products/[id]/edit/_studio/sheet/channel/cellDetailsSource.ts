// Preserve the cell-details dialog wording during sheet consolidation.
import type { ValueSourceKind } from '@/design-system/components/SourceIndicator'
import type { CellProvenance } from '@/design-system/grid/renderers/provenance'
import type { StudioCellValue } from './types'
import { offerDraftCellWords, pendingPublishOf } from './offerDrafts'
import { MATRIX_CELL_COPY } from '@/design-system/grid/renderers/matrixCells'

export interface ValueSourceDescription {
  kind: ValueSourceKind
  label: string
  description: string
}

interface LegacyLanguageFacts {
  effectiveLocale?: string | null
  requestedLocale?: string | null
  needsTranslation?: boolean
  translationState?: string | null
}

/** The label of a listing's own stored text (not an operator pin, not Master). */
export const LISTING_VALUE_LABEL = 'Listing value'
/** P1 review (4) — an eBay item specific that is not a variation axis, on a variation row. */
export const LISTING_LEVEL_LABEL = 'eBay listing value — one for all variations'

/** Sources that follow somewhere else: drawn quieter so the cells that hold their own value stand out. Never hidden. */
export function isRoutineSource(kind: ValueSourceKind): boolean {
  return kind === 'master' || kind === 'linked' || kind === 'default' || kind === 'rule' || kind === 'missing'
}

/** What hovering the mark says: the source by name and why, or a formula refusal in the server's own words. */
export function sourceHoverText(source: ValueSourceDescription, description: string, refusedReason?: string | null): string {
  if (refusedReason) return refusedReason
  return [source.label, description].filter(Boolean).map(part => part.trim().replace(/\.+$/, '')).join('. ')
}

/** Explain the resolver's winner. A master-layer pin is not a listing override. */
export function describeValueSource(cell: StudioCellValue | undefined, provenance: CellProvenance, refusedReason?: string | null): ValueSourceDescription {
  const source = (kind: ValueSourceKind, label: string, description: string): ValueSourceDescription => ({ kind, label, description })
  if (provenance === 'refused') return source('warning', 'Formula needs attention', refusedReason ?? 'The formula could not produce a value')
  /* Amazon sheet gaps (D4=B, D7=A) — an offer change saved in Nexus that Publish sends: never drawn as a live value. The
     Shopify draft's mark (below), with the saved and live values, when, and a live change since; not sent = a warning. */
  const waiting = pendingPublishOf(cell)
  if (waiting) {
    const words = offerDraftCellWords(waiting)
    return source(words.notSent ? 'warning' : 'pending', words.label, words.description)
  }
  /* D9 = A — Amazon's last report says FBA while Nexus sends FBM: the Matrix's own words, as a warning (never hidden). */
  if (cell?.fulfilmentReported) return source('warning', MATRIX_CELL_COPY.reported(cell.fulfilmentReported),
    'Nexus sends FBM and keeps sending this listing\'s stock. Check the listing in Seller Central; the next pull from Amazon updates the report.')
  if (provenance === 'formula') return source('formula', 'Cell formula', 'Calculated by this cell’s formula; edit the formula to change how it works')
  if (provenance === 'ai' || provenance === 'aiStale') return source('ai', provenance === 'aiStale' ? 'Outdated AI draft' : 'AI draft', 'Review this suggestion before accepting it')
  if (!cell) return source('missing', 'No value', 'No source information is available')
  /* P1 review (4) — eBay takes one value per listing for an item specific that is not a variation axis: on a variation
     row the value is the LISTING's, not the row's, and a set or a clear here writes it for every variation. */
  const level = cell.mapped?.listingLevel
  if (level?.variation) return source('channel', LISTING_LEVEL_LABEL, [
    `eBay takes one value for the whole listing; this one comes from ${level.sku}`,
    'Setting or clearing it here sets it for every variation of this listing',
    level.ownValue !== undefined ? `This row also stores ${JSON.stringify(level.ownValue)}, which eBay does not receive` : null,
  ].filter(Boolean).join('. '))
  // Older sheet responses attached language facts to the mapping result. Keep their dialog
  // explanation while the current wire contract carries these facts on the cell itself.
  const mappedLocale = cell.mapped as (NonNullable<StudioCellValue['mapped']> & LegacyLanguageFacts) | null | undefined
  const localized: LegacyLanguageFacts = mappedLocale?.effectiveLocale ? mappedLocale : cell as StudioCellValue & LegacyLanguageFacts
  if (localized.needsTranslation || localized.translationState === 'fallback') return source('warning',
    localized.translationState === 'outdated' ? 'Outdated translation' : 'Language fallback',
    `Showing ${localized.effectiveLocale ?? 'source'} content. ${localized.requestedLocale ?? 'Selected language'} ${localized.translationState === 'outdated' ? 'needs review after a source change' : 'content is missing'}. This value does not count as translated content`)
  if (cell.nexusDraft) return source('override', 'Saved Nexus draft', 'Saved for this account, listing and field owner. Review synchronization to send these changes to Shopify')
  /* P1 (report 2 I-3) — an old listing text (the eBay title the listing was imported with). The mapping reads it
     through `title`, which made it say "Follows Shared" while 80 of 82 REGAL eBay IT titles differ from Master. */
  if (cell.source === 'channelSnapshot') return source('channel', LISTING_VALUE_LABEL,
    'This listing still holds its own text, not the Shared product’s. The next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now')
  if (localized.translationState === 'draft' || localized.translationState === 'reviewed') return source('master',
    localized.translationState === 'draft' ? 'Translation draft' : 'Reviewed translation',
    `${localized.effectiveLocale} content${localized.translationState === 'draft' ? ' is saved and awaiting review' : ' has been reviewed'}`)
  const mapped = cell.mapped
  if (mapped?.provenance === 'override' || (!mapped && ['channel', 'alias', 'aliasVariant'].includes(cell.layer) && cell.pinned && !cell.inherited)) {
    return source('override', 'Listing override', 'Stored for this SKU and listing on this channel and market; changes to the Shared product do not replace it')
  }
  if (mapped?.sourceOwner) return source('channel', mapped.sourceOwner.label, 'This attribute uses its own channel or listing value. A mapping from the Shared product is not required')
  if (mapped?.status === 'unmapped') return source('missing', 'No mapping', 'No rule connects this channel attribute to the Shared product; configure a mapping or enter a listing value')
  if (mapped?.provenance === 'default') return source('default', 'Channel default', 'Supplied by the channel’s category mapping or a configured default')
  if (mapped?.provenance === 'linked' || cell.linkGroupId || cell.layer === 'linked') return source('linked', 'Linked field', 'Follows a shared field link; its configured source determines the value')
  if (provenance === 'inheritedOverride') return source('linked', 'Inherited override', 'The server reports a value inherited from another listing layer')
  if (mapped) {
    if (mapped.supplyingRule) return source('rule', 'Shared rule', `Supplied by ${mapped.supplyingRule.name} · v${mapped.supplyingRule.version}. Editing this reusable rule can affect other matching products`)
    const path = mapped.legacySource === 'fallback' ? mapped.fallbackPath : mapped.sourcePath
    if (path && !mapped.usesExpression) {
      return source('master', 'Follows Shared', [
        `Uses the Shared product’s ${path}${mapped.legacySource === 'fallback' ? ' fallback' : ''} for this product and content language`,
        mapped.provenance === 'missing' ? 'The configured source currently produces no value' : null,
        mapped.appliedTransforms.length ? `Channel adjustments: ${mapped.appliedTransforms.join(', ')}` : null,
      ].filter(Boolean).join('. '))
    }
    return source('rule', 'Mapping rule', mapped.usesExpression
      ? 'Calculated by a channel mapping expression; its inputs determine whether Shared product changes affect it'
      : mapped.provenance === 'missing'
        ? 'A mapping exists, but it currently produces no value'
        : 'Supplied by the configured channel mapping')
  }
  if (['master', 'variant'].includes(cell.layer)) return source('master', cell.writeTarget === 'master' ? 'Shared value' : 'Follows Shared', cell.affectsAllChannels
    ? 'Shared product field; editing it affects every channel that follows it'
    : 'Uses the resolved Shared product value for this product and content language')
  return source(cell.value == null ? 'missing' : 'channel', cell.value == null ? 'No value' : 'Channel value', 'No Master source is reported for this cell')
}
