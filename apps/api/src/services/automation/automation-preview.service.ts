/**
 * R8 (MCP full control, part 06 §3) — what an automation would do now, writing nothing.
 *
 * Per kind (each adapter's `runPreview`, in its own context's directory):
 *   · a DRAFT before it is saved — an Amazon ads rule in the rule builder's shape (budget, bid, placement, share of
 *     voice, keyword tracker; the builder's own preview dispatch, previewAdsRuleDraft), an eBay ads rule (previewRule)
 *   · a SAVED row — an ads rule against the contexts its trigger builds now (simulateOneRule); a marketing,
 *     replenishment, listing or bulk rule against its trigger's contexts or a context given (evaluateRule through the
 *     R3 path); a repricing rule's own price pick; auto-bid's bids; this month's budget enforcement; a pool's next
 *     rebalance; rank-defend and top-of-search as dry runs; a coverage set's next run; an autopilot plan's backtest
 * and says "no preview", with why, for every kind that has none (its run is real, it calls the AI, it reads a
 * marketplace, it is FBA …).
 *
 * Writes nothing: every saved rule runs through `evaluateRule({ noPersist })` — no run row, no counter, no suggestion,
 * no refusal record, no "rule fired" event, no notification (R8: `notify` / `alert_operator` report whom they would
 * reach) and always a dry run; the engines run their own no-write modes (automation-preview.vitest.test.ts counts every
 * table a preview could touch, before and after).
 *
 * Never pause: a rule carrying a pause (or another action Claude may not automate) previews as it would run, and says
 * it would be refused when saved, naming the substitute (no-pause.ts).
 */
import { refusedWhenSaved } from './no-pause.js'
import type { AutomationAdapter, PreviewInput } from './automation-levels.js'

export type PreviewAnswer =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }

const WROTE_NOTHING = 'Nothing was written: no run row, no counter, no proposal, no notification, nothing sent to a channel.'

export async function previewAutomation(adapter: AutomationAdapter, input: PreviewInput): Promise<PreviewAnswer> {
  const automation = { id: adapter.id, key: adapter.key, name: adapter.name }
  if (adapter.preview === 'none' || !adapter.runPreview) {
    return { ok: true, data: { automation, preview: null, says: `No preview for ${adapter.name}: ${adapter.previewNote}` } }
  }
  if (input.draft && adapter.preview !== 'draft-and-saved') {
    return { ok: false, error: `${adapter.name} cannot preview a draft: ${adapter.previewNote}` }
  }
  const outcome = await adapter.runPreview(input)
  if ('refused' in outcome) {
    return { ok: false, error: outcome.notFound ? `${adapter.name} has no row ${input.rowId} in this business (not found).` : `${adapter.name}: ${outcome.refused}` }
  }
  const refusal = refusedWhenSaved(outcome.actionTypes ?? [])
  return {
    ok: true,
    data: {
      automation,
      kind: outcome.kind,
      row: outcome.subject,
      preview: outcome.result,
      ...(refusal ? { wouldBeRefusedWhenSaved: refusal } : {}),
      wroteNothing: WROTE_NOTHING,
      notes: outcome.notes ?? [],
    },
  }
}
