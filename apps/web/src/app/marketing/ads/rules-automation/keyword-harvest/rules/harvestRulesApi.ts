/**
 * Keyword Harvest page, Rules view (2026-10-11, lane HRULES) — the calls the view makes beyond the shared harvest client
 * (`../_shared/harvestApi.ts`): a rule's mode and its exact Undo, and the Undo of one harvest. A rule's asks are
 * decided with the Terms view's own review (`../terms`). Every write
 * happens only after the person saved it in the review; every refusal comes back in the server's own words.
 */
import { getBackendUrl } from '@/lib/backend-url'
import type { BidMode } from '../../bid/rules/bidRulesModel'
import { decideWaiting, refusalOf, undoHarvests } from '../_shared/harvestApi'
import { undoModeBody, type Belt, type ModeBefore } from './harvestRuleChanges'
import { plainApproveError } from './harvestRulesModel'

export type Done = { ok: true; words?: string } | { ok: false; words: string }

/** POST /rules/mode's answer for one rule (HCORE): `before` = its mode, Manual/Automate and harvest Auto mark before. */
type ModeResult = { id: string; ok: boolean; mode?: string; belt?: Belt | null; marked?: boolean; before?: ModeBefore; error?: string }

/**
 * POST /api/advertising/harvest/rules/mode — the ONLY write of a mode change (release review RS3): the route sets a builder
 * rule's Manual/Automate itself, and puts it back when the level is refused. An Undo sends `before` back unchanged.
 */
async function sendMode(body: Record<string, unknown>, id: string): Promise<{ ok: true; result: ModeResult } | { ok: false; words: string }> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/harvest/rules/mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => null) as { results?: ModeResult[] } | null
    if (!r.ok) return { ok: false, words: refusalOf(r.status, j) }
    const result = j?.results?.find((x) => x.id === id)
    return result?.ok ? { ok: true, result } : { ok: false, words: result?.error ?? 'Not changed' }
  } catch (e) {
    return { ok: false, words: `No answer: ${(e as Error).message}` }
  }
}

/** One harvest rule to `next`: one request. Hands back what it was (`before`), so an Undo can put back exactly that. */
export async function saveHarvestMode(id: string, next: BidMode): Promise<Done & { before?: ModeBefore }> {
  const out = await sendMode({ ids: [id], mode: next }, id)
  return out.ok ? { ok: true, ...(out.result.before ? { before: out.result.before } : {}) } : out
}

/**
 * The Undo of a mode change or of an archive (delta review D1): `before` sent back UNCHANGED — its mode, its own
 * Manual/Automate and its harvest Auto mark — in one request, so nothing comes back acting alone that did not before.
 * No `before`: no exact way back, nothing is sent.
 */
export async function restoreHarvestMode(id: string, before: ModeBefore | null | undefined): Promise<Done> {
  const body = undoModeBody(id, before)
  if (!body) return { ok: false, words: 'What it was is not known: set its mode again' }
  const out = await sendMode(body, id)
  return out.ok ? { ok: true } : out
}

/**
 * Undo of one harvest: ONE request (lift its blocks, then pause its keyword — never archive), approved by this person in
 * the same click. A request whose approval was refused is rejected, never left waiting.
 */
export async function undoOneHarvest(harvestId: string): Promise<Done> {
  const out = await undoHarvests({ harvestIds: [harvestId], approve: true, why: 'undone from the Keyword Harvest page' })
  if (!out.ok) return { ok: false, words: out.words }
  const a = out.data
  if (a.approve && !a.approve.ok) {
    await decideWaiting([{ approvalId: a.changeSetId, decide: 'reject' }], 'not approved on the page')
    return { ok: false, words: plainApproveError(a.approve) }
  }
  return { ok: true, words: a.status === 'runs_by_rule' ? 'Undo runs by rule' : a.status === 'scheduled' ? 'Undo approved' : 'Undo asked' }
}
