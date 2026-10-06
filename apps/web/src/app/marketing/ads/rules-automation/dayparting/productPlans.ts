/**
 * OC (2026-10-06) — product rank plans, after the old Rank Control page.
 *
 * A product rank plan (`ProductRankPlan`) holds one hourly bid plan for a whole product family in one market. They
 * were made on the old ads console's Rank Control page, which the Owner retired: "I think we have the replacement" —
 * the hourly bid plans on this page. A plan made there may still be switched on, and the 15-minute hourly bid run
 * applies every switched-on plan, so this page keeps the two controls a person needs over one: the switch, and
 * putting Top-of-search back to the plan's baseline. Both call the plan routes that stayed for them.
 *
 * The words and the requests live here, pure, so the tests can hold the buttons to the routes.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import { getBackendUrl } from '@/lib/backend-url'
import { readWrite } from '../../_shared/adsWrite'

/** The fields of GET /api/advertising/rank-plans this page reads. */
export interface ProductRankPlan {
  id: string
  productId: string
  parentAsin: string | null
  marketplace: string
  enabled: boolean
  manualOnly: boolean
  pausedAt: string | null
  lastEvaluatedAt: string | null
  lastSummary?: unknown
}

export interface PlanRequest { method: 'PATCH' | 'POST'; path: string; body: Record<string, unknown> }

export const PLANS_PATH = '/api/advertising/rank-plans'

/** Switch a plan on or off: PATCH /api/advertising/rank-plans/:id { enabled }. Switching off stamps `pausedAt`. */
export const planSwitchRequest = (id: string, on: boolean): PlanRequest =>
  ({ method: 'PATCH', path: `${PLANS_PATH}/${encodeURIComponent(id)}`, body: { enabled: on } })

/** Put Top-of-search back to the plan's baseline on the campaigns it holds: POST /api/advertising/rank-plans/:id/revert. */
export const planRevertRequest = (id: string): PlanRequest =>
  ({ method: 'POST', path: `${PLANS_PATH}/${encodeURIComponent(id)}/revert`, body: {} })

export interface PlanAnswer { ok: boolean; reason: string | null; body: Record<string, unknown> | null }

/** Send one plan request and read its answer. Never throws. */
export async function sendPlanRequest(req: PlanRequest): Promise<PlanAnswer> {
  try {
    const r = await fetch(`${getBackendUrl()}${req.path}`, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) })
    const body = (await r.json().catch(() => null)) as Record<string, unknown> | null
    const read = readWrite(r.status, body)
    return { ok: read.ok, reason: read.reason, body }
  } catch {
    return { ok: false, reason: 'No answer from the server.', body: null }
  }
}

const day = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** The plan's name on screen: its family's parent ASIN (or Nexus product id) and market. */
export const planTitle = (p: ProductRankPlan): string => `${p.parentAsin ?? `Product ${p.productId}`} · ${p.marketplace}`

/** The blast-radius guard's reason, when it was the guard that switched the plan off. */
function guardReason(p: ProductRankPlan): string | null {
  const s = p.lastSummary as { autoPaused?: unknown; reason?: unknown } | null | undefined
  return !p.enabled && s?.autoPaused === true ? String(s.reason ?? 'the family resolved to more campaigns than its cap') : null
}

/** One line: is it on, what the run does with it, and when it last ran. */
export function planLine(p: ProductRankPlan): string {
  const state = p.enabled
    ? p.manualOnly
      ? 'On, but set to manual only: the hourly bid run reads it and writes nothing.'
      : 'On: the hourly bid run applies it every 15 minutes while that engine is switched on.'
    : `Off${p.pausedAt ? ` since ${day(p.pausedAt)}` : ''}: the hourly bid run leaves it alone.`
  const guard = guardReason(p)
  const ran = p.lastEvaluatedAt ? `Last run ${day(p.lastEvaluatedAt)}.` : 'Never run.'
  return [state, guard ? `The blast-radius guard switched it off: ${guard}.` : null, ran].filter(Boolean).join(' ')
}

/** What switching asks first. */
export function switchImpact(p: ProductRankPlan, on: boolean): ActionImpact {
  const name = planTitle(p)
  return on
    ? {
        level: 'confirm',
        title: `Switch on the product rank plan ${name}?`,
        consequences: [
          'The hourly bid run applies it from its next run (every 15 minutes while that engine is switched on): each hour, the placement %, Min-bid floor and base bid the plan holds, on every campaign of the family in this market.',
          'Its windows and targets cannot be edited any more (the old Rank Control page is gone). For a new plan, make an hourly bid plan on this page.',
          ...(guardReason(p) ? ['The blast-radius guard switched it off before. If the family still resolves to more campaigns than its cap, the guard switches it off again.'] : []),
        ],
        reach: 'channel',
        reversal: { verb: 'Switch it off again', fidelity: 'lossy' },
      }
    : {
        level: 'confirm',
        title: `Switch off the product rank plan ${name}?`,
        consequences: [
          'The hourly bid run stops applying it from its next run.',
          'Bids it floored come back by themselves on paused campaigns; a live campaign is listed on this page for you to give back.',
          'Placement % stays as it is now. "Put placement back" sets Top-of-search back to the plan\'s baseline.',
        ],
        reach: 'channel',
        reversal: { verb: 'Switch it on again', fidelity: 'exact' },
      }
}

/** What putting Top-of-search back asks first. */
export function revertImpact(p: ProductRankPlan): ActionImpact {
  return {
    level: 'confirm',
    title: `Put Top-of-search back on the campaigns of ${planTitle(p)}?`,
    consequences: [
      'Sets the Top-of-search placement % on every campaign this plan holds in this market to the plan\'s baseline (0% when it has none), on Amazon now.',
      ...(p.enabled ? ['The plan is switched on, so its next run sets the hour\'s placement % again. Switch it off first to keep the baseline.'] : []),
    ],
    reach: 'channel',
    reversal: { verb: 'Set the placement % again by hand', fidelity: 'lossy' },
    acknowledge: 'I understand the placement % changes on Amazon at once.',
  }
}

/** After a request, in words. */
export function planOutcome(p: ProductRankPlan, kind: 'on' | 'off' | 'revert', a: PlanAnswer): { tone: 'success' | 'warning'; text: string } {
  const name = planTitle(p)
  if (!a.ok) return { tone: 'warning', text: `Nothing changed on ${name}: ${a.reason ?? 'the server said no'}` }
  if (kind === 'revert') {
    const b = a.body ?? {}
    const n = Number(b.reverted ?? 0), of = Number(b.campaigns ?? 0), pct = Number(b.toPct ?? 0)
    return n === of
      ? { tone: 'success', text: `Top-of-search set to ${pct}% on ${n} campaign${n === 1 ? '' : 's'} of ${name}.` }
      : { tone: 'warning', text: `Top-of-search set to ${pct}% on ${n} of ${of} campaigns of ${name}. The others kept theirs: try again, or check them in the Ad Manager.` }
  }
  return { tone: 'success', text: kind === 'on' ? `${name} is switched on.` : `${name} is switched off.` }
}
