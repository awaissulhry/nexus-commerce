/**
 * Cell details' WORDS for a channel cell: its source by name and the fuller explanation.
 *
 * 2026-10-04 (channel cell marks) — it no longer decides the source. It takes the member the cell's mark draws
 * (`channelCellProvenance`) and switches on it FIRST, so Cell details and the mark can never disagree: a cell drawn
 * with no mark is explained as following the Shared product or holding a channel-only value, a cell drawn ✎ as a
 * listing override, and so on. Before, this function was a second verdict, and the two disagreed.
 */
import type { ValueSourceKind } from '@/design-system/components/SourceIndicator'
import { provenanceLabel, provenanceTooltip, type CellProvenance } from '@/design-system/grid/renderers/provenance'
import { MATRIX_CELL_COPY } from '@/design-system/grid/renderers/matrixCells'
import { languageLabel } from '../../scopes'
import type { StudioCellValue } from './types'
import { offerDraftCellWords, pendingPublishOf } from './offerDrafts'
import { fallbackLanguage, languageTextName } from '../languages'
import { attentionCause, channelCellProvenance, contentTransformsOf, mappingErrorWords, SHOPIFY_DRAFT_WORDS, type ChannelCellVerdictOptions } from './channelCellProvenance'

export interface ValueSourceDescription {
  kind: ValueSourceKind
  label: string
  description: string
}

/**
 * Explain the cell's member in Cell details' fuller words. `member` is `channelCellProvenance`'s verdict for the same
 * cell, and `drawsRequired` the same flag it was given — so an `attention` cell is explained by the cause that raised it.
 *
 * 🔴 The LABEL of every marked member is the mark's own label (`provenanceLabel`), so Cell details and the mark name the
 * same thing in the same words; the description is the fuller explanation. Only a cell with no mark (`own`) has labels
 * of its own ("Follows Shared", "Shared value", a channel-only field's owner, …).
 */
export function describeValueSource(cell: StudioCellValue | undefined, member: CellProvenance, refusedReason?: string | null, drawsRequired = false): ValueSourceDescription {
  const source = (kind: ValueSourceKind, label: string, description: string): ValueSourceDescription => ({ kind, label, description })
  const marked = (kind: ValueSourceKind, description: string) => source(kind, provenanceLabel(member), description)
  const waiting = pendingPublishOf(cell)
  switch (member) {
    case 'refused':
      return marked('warning', refusedReason ?? cell?.provenance?.from ?? 'The formula could not produce a value')
    case 'attention':
      switch (attentionCause(cell, drawsRequired)) {
        /* Amazon sheet gaps (D7=A) — a saved offer change that Publish will NOT send (a restock date that has passed). */
        case 'notSent': {
          const words = offerDraftCellWords(waiting!)
          return marked('warning', `${words.label}. ${words.description}`)
        }
        /* D9 = A — Amazon's last report says FBA while Nexus sends FBM: the Matrix's own words, as a warning (never hidden). */
        case 'reported': return marked('warning', `${MATRIX_CELL_COPY.reported(cell!.fulfilmentReported!)}. `
          + 'Nexus sends FBM and keeps sending this listing\'s stock. Check the listing in Seller Central; the next pull from Amazon updates the report.')
        case 'mapping': {
          const words = mappingErrorWords(cell, drawsRequired)!
          return marked('warning', `${words.label}: ${words.description}`)
        }
        case 'divergence': return marked('warning', `Publishes another value: ${cell!.divergence!.note}`)
        default: return marked('warning', provenanceTooltip('attention', null))
      }
    case 'pending':
      /* Amazon sheet gaps (D4=B) — an offer change saved in Nexus that Publish sends: never drawn as a live value. A Shopify
         edit Shopify does not have yet waits for Review synchronization. */
      return marked('pending', waiting ? offerDraftCellWords(waiting).description : SHOPIFY_DRAFT_WORDS)
    case 'ai':
      return marked('ai', 'Translated by machine and not reviewed yet. Review it before it counts as confirmed')
    case 'aiStale':
      return marked('ai', 'Translated by machine from an older Shared text: the Shared product changed after it was written. Translate it again or review it')
    case 'outdated':
      return marked('warning', provenanceTooltip('outdated', null))
    case 'formula':
      return marked('formula', 'Calculated by this cell’s formula; edit the formula to change how it works')
    case 'listingLevel': {
      /* P1 review (4) — eBay takes one value per listing for an item specific that is not a variation axis: on a
         variation row the value is the LISTING's, not the row's, and a set or a clear here writes it for every variation. */
      const level = cell?.mapped?.listingLevel
      return marked('channel', [
        `eBay takes one value for the whole listing; this one comes from ${level?.sku ?? 'the listing'}`,
        'Setting or clearing it here sets it for every variation of this listing',
        level?.ownValue !== undefined ? `This row also stores ${JSON.stringify(level.ownValue)}, which eBay does not receive` : null,
      ].filter(Boolean).join('. '))
    }
    case 'listingValue':
      /* P1 (report 2 I-3) — an old listing text (the eBay title the listing was imported with). The mapping reads it
         through `title`, which made it say "Follows Shared" while 80 of 82 REGAL eBay IT titles differ from the Shared product. */
      return marked('channel',
        'This listing still holds its own text, not the Shared product’s. The next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now')
    case 'mapped':
    case 'mappedShared': {
      const mapped = cell?.mapped
      const scope = member === 'mappedShared' ? '. Every listing of this product shares this value, so editing one changes all of them' : ''
      if (mapped?.supplyingRule) return marked('rule', `Supplied by the reusable rule ${mapped.supplyingRule.name} · v${mapped.supplyingRule.version}. Editing this reusable rule can affect other matching products${scope}`)
      if (mapped?.provenance === 'default') return marked('default', `Supplied by the channel’s category mapping or a configured default${scope}`)
      const changed = contentTransformsOf(mapped).filter(transform => transform !== 'expr')
      return marked('rule', (mapped?.usesExpression
        ? 'Calculated by a channel mapping expression; its inputs decide whether changes to the Shared product reach it'
        : changed.length && mapped?.sourcePath?.trim()
          ? `Built by the channel mapping from the Shared product’s ${mapped.sourcePath.trim()}, changed by ${changed.join(', ')}, so it differs from the Shared product`
          : 'Supplied by the configured channel mapping') + scope)
    }
    case 'inheritedOverride':
      return marked('linked', 'This row shows the value its listing holds, which differs from the Shared product. Resetting returns it to that listing’s value, not to the Shared product')
    case 'inherited': {
      const shown = fallbackLanguage(cell)
      if (shown) {
        const wanted = cell?.requested ? languageLabel(cell.requested) : 'this language'
        return source('warning', provenanceLabel(member), `Showing ${languageTextName(shown)}: there is no ${wanted} text yet. This value does not count as translated content`)
      }
      return marked('linked', 'Follows a linked field; its source decides the value')
    }
    case 'pinned':
      // Shopify: a value Nexus holds for this listing — true whether or not synchronization has sent it yet.
      if (cell?.nexusDraft) return marked('override', 'Saved in Nexus for this Shopify listing. Changes to the Shared product do not replace it')
      return marked('override', 'Stored for this SKU and listing on this channel and market; changes to the Shared product do not replace it')
    case 'own':
    default:
      return ownSource(cell, source)
  }
}

/**
 * The source kind Cell details' ACTIONS follow (Keep as listing override, Reset): what the value IS underneath —
 * inherited, pinned, a formula, … — never the `attention` or `pending` mark laid on top of it. An inherited cell with a
 * mapping error still offers "Keep as listing override"; Cell details still shows the attention sentence (2026-10-04).
 * `options` are the ones the cell's own verdict was given.
 */
export function cellDetailsActionKind(cell: StudioCellValue | undefined, options: ChannelCellVerdictOptions = {}): ValueSourceKind {
  /* Kept from before the marks work, on purpose: an offer change Publish will NOT send, and a listing Amazon reports as
     FBA (the FBA boundary — Nexus never overwrites what Amazon fulfils), offer no Keep / Reset here; only the draft's
     own reset stays (`useChannelSheetAdapter`). A mapping error or a divergence leaves the underlying actions in place. */
  const cause = attentionCause(cell, options.drawsRequired)
  if (cause === 'notSent' || cause === 'reported') return 'warning'
  return describeValueSource(cell, channelCellProvenance(cell, { ...options, underlying: true }), options.refusedReason, options.drawsRequired).kind
}

/** A cell with no mark: it follows the Shared product, holds a channel-only value, or holds nothing. */
function ownSource(cell: StudioCellValue | undefined, source: (kind: ValueSourceKind, label: string, description: string) => ValueSourceDescription): ValueSourceDescription {
  if (!cell) return source('missing', 'No value', 'No source information is available')
  // A translation of the Shared product (the content resolver's `language` tier).
  if (cell.tier === 'language' && cell.translation && cell.language) return source('master',
    cell.translation.reviewedAt ? 'Reviewed translation' : 'Translation',
    `The Shared product’s ${languageLabel(cell.language)} text${cell.translation.reviewedAt ? ', reviewed' : ''}`)
  const mapped = cell.mapped
  if (mapped?.sourceOwner) return source('channel', mapped.sourceOwner.label, 'This attribute uses its own channel or listing value. A mapping from the Shared product is not required')
  if (mapped?.status === 'unmapped') return source('missing', 'No mapping', 'No rule connects this channel attribute to the Shared product; configure a mapping or enter a listing value')
  if (mapped) {
    const path = mapped.legacySource === 'fallback' ? mapped.fallbackPath : mapped.sourcePath
    if (path) {
      return source('master', 'Follows Shared', [
        `Uses the Shared product’s ${path}${mapped.legacySource === 'fallback' ? ' fallback' : ''} for this product and content language`,
        mapped.provenance === 'missing' ? 'The configured source currently produces no value' : null,
        mapped.appliedTransforms.length ? `Channel adjustments: ${mapped.appliedTransforms.join(', ')}` : null,
      ].filter(Boolean).join('. '))
    }
    if (mapped.provenance === 'missing') return source('missing', 'No value', 'A mapping exists, but it currently produces no value')
  }
  if (['master', 'variant'].includes(cell.layer) || mapped) return source('master', cell.writeTarget === 'master' ? 'Shared value' : 'Follows Shared', cell.affectsAllChannels
    ? 'Shared product field; editing it affects every channel that follows it'
    : 'Uses the resolved Shared product value for this product and content language')
  return source(cell.value == null ? 'missing' : 'channel', cell.value == null ? 'No value' : 'Channel value', 'The Shared product does not supply this value; it is stored for this channel')
}
