import { z } from 'zod'
import { businessDate, id, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { UOMS } from '../../product/units/units'
import { DOCUMENT_TYPES, ENTRY_EVENTS, type EntryEvent } from '../ledger/contracts'
import type { EntryDraft } from '../ledger/entries'

/**
 * B-W2b-F46 — costs that arrived after a work order's close, pure. The close freezes the actual: the database takes no cost
 * entry on a CLOSED work order but a reversal (factory-db …_cost_actuals_w2b_guards, B-W2b-376, never weakened). A source
 * event of the work order that reaches the ledger after the close (a late scan, a return, a workshop's fee, a receipt)
 * therefore cannot post: the worker's handler and the nightly catch-up leave it waiting (no failure, no retry), and the reads
 * say it here, in words, until someone reopens the work order — the close after the reopen posts them first (B-W2b-411).
 *
 *   rule     no stored flag (no schema change): computed on read, the same rule the catch-up posts by — what the work order's
 *            sources lack on its ledger (the costing module's dry plan), limited to a CLOSED work order
 *   count    one per source (a stock move, a scan, a rework, a subcontract order…), its overhead and the reversals riding
 *            with it inside the same source
 *   amounts  money.cost only (dropped for a caller without the cost grain); the words never carry a figure of money
 */

/** What one source records, in words (the API's; the screens say their own from the event code). */
export const AFTER_CLOSE_EVENT_WORDS: Readonly<Record<EntryEvent, string>> = Object.freeze({
  ISSUE: 'Issued to the work order',
  RETURN: 'Returned to stock',
  STOCK_SCRAP: 'Scrapped from stock',
  LABOUR: 'Labour reported',
  SCAN_SCRAP: 'Garments scrapped at an operation',
  REWORK_SCRAP: 'Garments scrapped in a rework',
  COMPLETION: 'Received into finished goods',
  OVERHEAD: 'Overhead',
  SUBCONTRACT: "A workshop's fee",
  ADJUSTMENT: 'An adjustment',
  VARIANCE: 'A variance',
  CLOSE: 'A closing entry',
  REVERSAL: 'A reversal',
})

/** The panel's sentence: how many costs wait for a reopen (none: "Nothing arrived after the close."). */
export function afterCloseWords(count: number): string {
  if (count <= 0) return 'Nothing arrived after the close.'
  return count === 1 ? '1 cost arrived after the close — reopen the work order to post it.' : `${count} costs arrived after the close — reopen the work order to post them.`
}

/** One source's line in words, without a figure of money: what it records, its document, what and how much, its day. */
export function afterCloseLineWords(line: {
  readonly event: EntryEvent
  readonly label: string | null
  readonly item: { readonly code: string; readonly baseUom: string } | null
  readonly quantity: string | null
  readonly minutes: string | null
  readonly day: string
}): string {
  const amountless = (value: string) => value.replace(/^-/, '')
  const what = line.minutes !== null && line.event === 'LABOUR' ? `${amountless(line.minutes)} standard minutes` : line.item && line.quantity !== null ? `${amountless(line.quantity)} ${line.item.baseUom} of ${line.item.code}` : line.item ? line.item.code : null
  return `${AFTER_CLOSE_EVENT_WORDS[line.event]}${line.label ? ` (${line.label})` : ''}${what ? `: ${what}` : ''}, on ${line.day}.`
}

export type AfterCloseSourceType = (typeof DOCUMENT_TYPES)[number]

export interface AfterCloseSource {
  readonly sourceType: AfterCloseSourceType
  readonly sourceId: string
  /** The entries it would post, in the plan's order (the source's own entry first, its overhead after). */
  readonly drafts: readonly EntryDraft[]
}

/**
 * The plan's entries per source event: a stock move, a rework, a scan, a subcontract order, a supplier invoice line; an
 * overhead (or the reversal of one) goes with the entry it was applied on; anything else stands on its own.
 */
export function afterCloseSources(drafts: readonly EntryDraft[]): AfterCloseSource[] {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]))
  const byReversed = new Map(drafts.filter((draft) => draft.reversalOfId !== null).map((draft) => [draft.reversalOfId!, draft]))
  const sourceOf = (draft: EntryDraft, depth = 0): { sourceType: AfterCloseSourceType; sourceId: string } => {
    if (draft.sourceType === 'ReworkOrder' && draft.sourceId) return { sourceType: 'ReworkOrder', sourceId: draft.sourceId }
    if (draft.stockMoveId) return { sourceType: 'StockMove', sourceId: draft.stockMoveId }
    if (draft.operationScanId) return { sourceType: 'OperationScan', sourceId: draft.operationScanId }
    if (draft.subcontractOrderId) return { sourceType: 'SubcontractOrder', sourceId: draft.subcontractOrderId }
    if (draft.supplierInvoiceLineId) return { sourceType: 'SupplierInvoiceLine', sourceId: draft.supplierInvoiceLineId }
    if (draft.sourceType === 'WorkOrderCostEntry' && draft.sourceId && depth < 4) {
      // An overhead names the entry it was applied on (a draft of this plan); its reversal names the entry reversed.
      const parent = byId.get(draft.sourceId) ?? byReversed.get(draft.sourceId)
      if (parent && parent.id !== draft.id) return sourceOf(parent, depth + 1)
    }
    return { sourceType: 'WorkOrderCostEntry', sourceId: draft.reversalOfId ?? draft.id }
  }
  const groups = new Map<string, { sourceType: AfterCloseSourceType; sourceId: string; drafts: EntryDraft[] }>()
  for (const draft of drafts) {
    const source = sourceOf(draft)
    const key = `${source.sourceType}:${source.sourceId}`
    const group = groups.get(key) ?? { ...source, drafts: [] }
    group.drafts.push(draft)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** The entry a source's line is named after: its first own entry (not the overhead applied with it). */
export const mainDraftOf = (source: AfterCloseSource): EntryDraft => source.drafts.find((draft) => draft.kind !== 'OVERHEAD') ?? source.drafts[0]!

const itemRef = output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) })

export const afterCloseLineView = output({
  sourceType: z.enum(DOCUMENT_TYPES),
  sourceId: id(),
  /** What its first own entry records, in the ledger's words (the screens' words come from this code). */
  event: z.enum(ENTRY_EVENTS),
  occurredAt: instant(),
  /** The Europe/Rome day. */
  day: businessDate(),
  /** Its document: a stock move by its reason, reference and lot; a scan by its bundle and operation; a rework; a subcontract order. */
  label: z.string().nullable(),
  item: itemRef.nullable(),
  /** Base units, signed as the amount. */
  quantity: z.string().nullable(),
  /** LABOUR: standard minutes. */
  minutes: z.string().nullable(),
  /** The entries it would post (its overhead included). */
  entries: z.number().int(),
  /** What it would put on the work order (+) or take off it (−), its overhead included: money.cost, minor units. */
  amount: money.cost(z.number().int()),
  /** In words, without a figure of money. */
  words: z.string(),
})
export type AfterCloseLineView = z.infer<typeof afterCloseLineView>

/** On a CLOSED work order (null on any other): the costs that wait for a reopen. */
export const afterCloseView = output({
  /** Sources that wait (one line each). */
  count: z.number().int(),
  lines: z.array(afterCloseLineView),
  /** afterCloseWords(count). */
  words: z.string(),
})
export type AfterCloseView = z.infer<typeof afterCloseView>
