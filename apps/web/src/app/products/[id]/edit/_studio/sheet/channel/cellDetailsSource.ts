// Preserve the cell-details dialog wording during sheet consolidation.
import type { ValueSourceKind } from '@/design-system/components/SourceIndicator'
import type { CellProvenance } from '@/design-system/grid/renderers/provenance'
import type { StudioCellValue } from './types'

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

/** Explain the resolver's winner. A master-layer pin is not a listing override. */
export function describeValueSource(cell: StudioCellValue | undefined, provenance: CellProvenance, refusedReason?: string | null): ValueSourceDescription {
  const source = (kind: ValueSourceKind, label: string, description: string): ValueSourceDescription => ({ kind, label, description })
  if (provenance === 'refused') return source('warning', 'Formula needs attention', refusedReason ?? 'The formula could not produce a value')
  if (provenance === 'formula') return source('formula', 'Cell formula', 'Calculated by this cell’s formula; edit the formula to change how it works')
  if (provenance === 'ai' || provenance === 'aiStale') return source('ai', provenance === 'aiStale' ? 'Outdated AI draft' : 'AI draft', 'Review this suggestion before accepting it')
  if (!cell) return source('missing', 'No value', 'No source information is available')
  // Older sheet responses attached language facts to the mapping result. Keep their dialog
  // explanation while the current wire contract carries these facts on the cell itself.
  const mappedLocale = cell.mapped as (NonNullable<StudioCellValue['mapped']> & LegacyLanguageFacts) | null | undefined
  const localized: LegacyLanguageFacts = mappedLocale?.effectiveLocale ? mappedLocale : cell as StudioCellValue & LegacyLanguageFacts
  if (localized.needsTranslation || localized.translationState === 'fallback') return source('warning',
    localized.translationState === 'outdated' ? 'Outdated translation' : 'Language fallback',
    `Showing ${localized.effectiveLocale ?? 'source'} content. ${localized.requestedLocale ?? 'Selected language'} ${localized.translationState === 'outdated' ? 'needs review after a source change' : 'content is missing'}. This value does not count as translated content`)
  if (cell.nexusDraft) return source('override', 'Saved Nexus draft', 'Saved for this account, listing and field owner. Review synchronization to send these changes to Shopify')
  if (localized.translationState === 'draft' || localized.translationState === 'reviewed') return source('master',
    localized.translationState === 'draft' ? 'Translation draft' : 'Reviewed translation',
    `${localized.effectiveLocale} content${localized.translationState === 'draft' ? ' is saved and awaiting review' : ' has been reviewed'}`)
  const mapped = cell.mapped
  if (mapped?.provenance === 'override' || (!mapped && ['channel', 'alias', 'aliasVariant'].includes(cell.layer) && cell.pinned && !cell.inherited)) {
    return source('override', 'Listing override', 'Stored for this SKU and listing on this channel and market; changes to Master do not replace it')
  }
  if (mapped?.sourceOwner) return source('channel', mapped.sourceOwner.label, 'This attribute uses its own channel or listing value. A Master mapping is not required')
  if (mapped?.status === 'unmapped') return source('missing', 'No mapping', 'No rule connects this channel attribute to Master; configure a mapping or enter a listing value')
  if (mapped?.provenance === 'default') return source('default', 'Channel default', 'Supplied by the channel’s category mapping or a configured default')
  if (mapped?.provenance === 'linked' || cell.linkGroupId || cell.layer === 'linked') return source('linked', 'Linked field', 'Follows a shared field link; its configured source determines the value')
  if (provenance === 'inheritedOverride') return source('linked', 'Inherited override', 'The server reports a value inherited from another listing layer')
  if (mapped) {
    if (mapped.supplyingRule) return source('rule', 'Shared rule', `Supplied by ${mapped.supplyingRule.name} · v${mapped.supplyingRule.version}. Editing this reusable rule can affect other matching products`)
    const path = mapped.legacySource === 'fallback' ? mapped.fallbackPath : mapped.sourcePath
    if (path && !mapped.usesExpression) {
      return source('master', 'Follows Master', [
        `Uses Master’s ${path}${mapped.legacySource === 'fallback' ? ' fallback' : ''} for this product and content language`,
        mapped.provenance === 'missing' ? 'The configured source currently produces no value' : null,
        mapped.appliedTransforms.length ? `Channel adjustments: ${mapped.appliedTransforms.join(', ')}` : null,
      ].filter(Boolean).join('. '))
    }
    return source('rule', 'Mapping rule', mapped.usesExpression
      ? 'Calculated by a channel mapping expression; its inputs determine whether Master changes affect it'
      : mapped.provenance === 'missing'
        ? 'A mapping exists, but it currently produces no value'
        : 'Supplied by the configured channel mapping')
  }
  if (['master', 'variant'].includes(cell.layer)) return source('master', cell.writeTarget === 'master' ? 'Master value' : 'Follows Master', cell.affectsAllChannels
    ? 'Shared Master field; editing it affects every channel that follows it'
    : 'Uses the resolved Master value for this product and content language')
  return source(cell.value == null ? 'missing' : 'channel', cell.value == null ? 'No value' : 'Channel value', 'No Master source is reported for this cell')
}
