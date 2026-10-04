/**
 * Cell details for ONE channel cell: what the shared window (`CellDetailsDialog`, opened by `useSheetControl`) shows.
 *
 * 2026-10-04 (shared Cell details) — moved as is out of the channel adapter's `openCellDetails`, so the window, its menu
 * item and its ⋯ item can belong to the shared control while the channel keeps its own words. Its output is pinned by
 * golden cases taken from the adapter before the move (`channelCellDetails.vitest.test.ts`).
 *
 * The verdict is the ONE the cell's mark and tint draw (`channelCellProvenance`); this function only words it. The
 * action is the cell menu's own (Owner 2026-10-04): a reset where one exists (`channelResetOffer`), or a pin on a plain
 * inherited value — judged by what the value IS underneath (`cellDetailsActionKind`), never by an attention or pending
 * mark on top of it. Each action runs a real writer the adapter hands in: the control's reset or the channel pin/reset.
 */
import { composeCellTooltip, longTextTooltipLine, saveNote, shapeTooltipLine, type CellSaveTracker } from '@/design-system/grid'
import { destinationLabel as publishDestinationLabel } from '@/app/products/_publication/dialog/outcome'
import { cellDetailsValue, type CellDetailsContent } from '../cellDetails'
import { channelValidation } from '../master/channelColumns'
import { referenceTooltip } from '../referenceLabels'
import { channelResetOffer, type ResetTarget } from '../sheetReset'
import { cellDetailsActionKind, describeValueSource } from './cellDetailsSource'
import { channelCellDrawsRequired, channelCellProvenance } from './channelCellProvenance'
import { OFFER_DRAFT_COPY, pendingPublishOf } from './offerDrafts'
import { cascadeIntent, cascadeOf, type CascadeIntent } from './provenance'
import { cellHoverNote, offersCascade } from './rows'
import type { ChannelSheetRow, SheetColumn, StudioCellValue } from './types'
import { resetActionWords } from './value-source'

/** What the channel scope knows beyond the row and the column. */
export interface ChannelCellDetailsContext {
  /** The scope maps only product-level fields (`meta.mapping.productLevelOnly`). */
  productLevelOnly: boolean
  /** The scope's label (`scope.label`, e.g. "Amazon · IT"), for the cell's hover note. */
  scopeLabel: string
  channel: string
  marketplace: string
  /** The formula's last refusal for this cell, or null. */
  refusedReasonFor: (rowId: string, colKey: string) => string | null
  /** The cell's stored formula, or null. */
  exprFor: (rowId: string, colKey: string) => string | null
  /** The cell's last save (its refusal or warning). */
  tracker: Pick<CellSaveTracker, 'get'>
  aliasLabel: (aliasId: string | null) => string
  /** The cell menu's reset (`useSheetControl().reset`). */
  reset: (targets: ResetTarget[]) => Promise<void>
  /** The channel pin / reset, with its whole-list review (`onCascade`). */
  cascade: (row: ChannelSheetRow, cell: StudioCellValue, intent: CascadeIntent) => Promise<void>
}

export function channelCellDetails(row: ChannelSheetRow, column: SheetColumn, ctx: ChannelCellDetailsContext): CellDetailsContent {
  const cell = row.values[column.key]
  const value = cell?.value
  const formulaReason = ctx.refusedReasonFor(row.rowId, column.key)
  /* The ONE channel verdict the cell's mark and tint draw (`channelCellProvenance`); Cell details only words it. */
  const drawsRequired = channelCellDrawsRequired(column, row, cell)
  const verdict = { productLevelOnly: ctx.productLevelOnly, refusedReason: formulaReason, drawsRequired, shape: column.shape }
  const member = channelCellProvenance(cell, verdict)
  const source = describeValueSource(cell, member, formulaReason, drawsRequired)
  const layer = cascadeOf(cell, row.rowKind)
  /* P1 — a reset is offered wherever one exists (the cell menu's rule, `channelResetOffer`): formula, translation and
     AI cells included. A pin is offered only on a plain inherited value — judged by what the value IS underneath
     (`cellDetailsActionKind`), never by an attention or pending mark on top of it (2026-10-04). */
  const reset = channelResetOffer(row, column.key, !!formulaReason || !!ctx.exprFor(row.rowId, column.key))
  const intent = cell && offersCascade(cell) && cell.editable && layer !== 'unset' && (reset || !['formula', 'warning', 'ai'].includes(cellDetailsActionKind(cell, verdict)))
    ? cascadeIntent(layer, row.rowKind, value ?? null) : null
  const action: CellDetailsContent['action'] = reset && pendingPublishOf(cell)
    ? { label: reset.label, description: OFFER_DRAFT_COPY.resetDetail(publishDestinationLabel(ctx.channel, ctx.marketplace)),
      run: () => void ctx.reset([{ rowId: row.rowId, colId: column.key, intent: 'reset', formula: reset.formula }]) }
    : intent && cell ? {
      label: intent.action === 'pin' ? 'Keep as listing override' : reset?.formula ? reset.label : resetActionWords(cell, { sku: row.sku, listing: ctx.aliasLabel(row.aliasId) }).label,
      description: intent.action === 'pin'
        ? `Keep the current value for ${row.sku} · ${ctx.aliasLabel(row.aliasId)} on this channel and market.`
        : `${reset?.formula ? 'Remove this cell’s formula (its last value is kept), then: ' : ''}${resetActionWords(cell, { sku: row.sku, listing: ctx.aliasLabel(row.aliasId) }).description}`,
      run: () => {
        if (intent.action === 'reset' && reset?.formula) void ctx.reset([{ rowId: row.rowId, colId: column.key, intent: reset.intent, formula: true }])
        else void ctx.cascade(row, cell, intent)
      },
    } : undefined
  return {
    title: `${column.label}: ${row.sku}`,
    value: cellDetailsValue(value),
    notes: composeCellTooltip(saveNote(ctx.tracker.get(row.rowId, column.key)), channelValidation(column).validate(value, row, column.key).message,
      cell?.mapped?.errors.join('\n'), cell?.mapped?.warnings.join('\n'), `${source.label}. ${source.description}`,
      column.kind === 'longtext' ? longTextTooltipLine(value, column) : null, shapeTooltipLine(column, value), referenceTooltip(value, column.optionLabels),
      cellHoverNote(cell, ctx.scopeLabel), column.helpText),
    action,
  }
}
