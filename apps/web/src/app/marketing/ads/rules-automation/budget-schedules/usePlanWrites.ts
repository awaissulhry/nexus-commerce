'use client'

/**
 * ⛔ PARKED 2026-08-18 (U8) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the plan write hook.
 * Why it left: the Budget Schedules tab is now Helium 10's shape — the hourly-performance card over
 *   the schedules grid, and nothing else (`BudgetSchedulesTabClient.tsx`; study
 *   `docs/2026-08-16-ra-h10-reference-study.md` §3.7, §7.9).
 * Candidate home: travels with PlanEditor.
 *
 * ⚠ Nothing here was changed and no endpoint was retired — `/budget-manager*`, `/budget-binding`
 * and `/budget-schedules*` are all still served. The file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BSP.1 — the write layer. This page's first, and it arms a live engine.
 *
 * ── Three rules, all of them consequences of what is downstream ────────────────────────────────
 *
 * 1. 🔴 **No optimistic UI.** Every other surface in this product may guess; this one may not.
 *    `ad-budget-enforce` and the rule evaluator already disagree about this account's budgets 41%
 *    of the time — 937 of 2,304 consecutive audit writes start from a value the previous write did
 *    not leave behind (study §3). A third writer that painted a value it had not yet confirmed
 *    would be indefensible. The input holds the operator's text; the READOUT only ever shows what
 *    the server has confirmed.
 *
 * 2. 🔴 **A refusal is not a failure.** A 4xx is the server declining a value it understood; a 5xx
 *    or a thrown fetch is the system failing. `POST /plans` answers 400 when neither `id` nor
 *    `marketplace + month` is present. Rendering that as "broke" is exactly the lie that makes a
 *    working product look catastrophic — the same class as the 7,738 cap refusals counted as
 *    failures account-wide.
 *
 * 3. **A failed write keeps the operator's input and does not close the rail.** BSP.0 removed this
 *    precise defect from the schedules grid (`DELETE … .catch(() => {})` then removing the row
 *    anyway). Re-introducing it one session later would be absurd.
 *
 * On success the caller re-fetches `GET /advertising/budget-manager` so the band, the rail and the
 * chart move together off ONE payload. They cannot disagree, because there is only one of them.
 */

import { useCallback, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import type { UpsertPlanBody, WriteOutcome } from './slot-contract'

/** Anything the server said, preferred over anything we could invent. */
async function messageFrom(r: Response): Promise<string> {
  try {
    const j = await r.json()
    const m = j?.error ?? j?.message ?? j?.detail
    if (typeof m === 'string' && m.trim()) return m
  } catch { /* not JSON — fall through to the status line */ }
  return `The server answered ${r.status}.`
}

/**
 * Classify by status, not by guesswork.
 *   4xx → refused   (understood, declined)
 *   5xx → broke     (failed)
 *   throw → broke   (never reached the server)
 */
async function send(url: string, init: RequestInit): Promise<WriteOutcome> {
  let r: Response
  try {
    r = await fetch(url, init)
  } catch (e) {
    return { state: 'broke', message: `The request did not reach the server (${(e as Error).message}).` }
  }
  if (r.ok) return { state: 'saved', at: Date.now() }
  const message = await messageFrom(r)
  return r.status >= 400 && r.status < 500 ? { state: 'refused', message } : { state: 'broke', message }
}

export function usePlanWrites(onSaved: () => void) {
  const [outcome, setOutcome] = useState<WriteOutcome>({ state: 'idle' })
  const busy = outcome.state === 'saving'

  const run = useCallback(async (fn: () => Promise<WriteOutcome>) => {
    setOutcome({ state: 'saving' })
    const res = await fn()
    setOutcome(res)
    // Re-read only on success. A refused or broken write must not repaint the rail with a value the
    // operator did not get, and must not clear the input they are about to correct.
    if (res.state === 'saved') onSaved()
    return res
  }, [onSaved])

  /** Idempotent by `(marketplace, month, tag=null)`: sending it twice updates, never duplicates. */
  const savePlan = useCallback((body: UpsertPlanBody) => run(() => send(
    `${getBackendUrl()}/api/advertising/budget-manager/plans`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )), [run])

  const deletePlan = useCallback((id: string) => run(() => send(
    `${getBackendUrl()}/api/advertising/budget-manager/plans/${id}`,
    { method: 'DELETE' },
  )), [run])

  const setCampaignLimit = useCallback((body: {
    marketplace: string; month: string; campaignId: string; minCents: number | null; maxCents: number | null
  }) => run(() => send(
    `${getBackendUrl()}/api/advertising/budget-manager/campaign-limit`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )), [run])

  /** Clear the banner when the operator edits again, so a stale "saved" never sits under new input. */
  const reset = useCallback(() => setOutcome({ state: 'idle' }), [])

  return { outcome, busy, savePlan, deletePlan, setCampaignLimit, reset }
}
