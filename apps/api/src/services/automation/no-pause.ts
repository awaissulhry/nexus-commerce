/**
 * R8 (MCP full control, part 06 §3) — the actions Claude's automation rules may never carry. Pure.
 *
 * Owner rule (memory feedback_no_pause_use_low_bids): a temporary stop is lower bids. A rule Claude saves may not pause,
 * archive, resume or enable anything, nor run the structural actions the plan names: the engines' own no-pause stays.
 * ADS AUTONOMY AA-W2-12/13 (Owner 2026-10-06) — a real pause, an enable or an archive is a request of its own (pause-ads,
 * enable-ads, archive-ads on Amazon), never a rule's action. The rule guard (R9) refuses them at save; a preview (R8)
 * already says a rule carrying one "would be refused when saved", and names the substitute. `pause_target` is the Owner's
 * own exception for HIS rules, not for Claude's.
 */

/** Refused for a rule Claude saves, each with why and what to use instead. */
const REFUSED: Record<string, { why: string; instead: string }> = {}
const add = (types: string[], why: string, instead: string) => { for (const t of types) REFUSED[t] = { why, instead } }

add(['pause_campaign', 'pause_ad_group', 'pause_target', 'pause_all_campaigns', 'pause_keyword', 'pause_ad', 'mkt_pause_campaign'],
  'it pauses — a rule never pauses (Owner rule: a temporary stop is lower bids)', 'lower_bid_to_floor (suppression at the floor bid), or a lower budget; a real pause is its own request (pause-ads on Amazon)')
add(['dayparting_apply', 'refresh_dayparting'], 'it pauses and re-enables campaigns on hour windows — status changes are never automated by Claude', 'a budget schedule, or lower bids in dead hours')
add(['enable_target', 'enable_campaign', 'enable_ad_group', 'resume_campaign', 'resume_target', 'mkt_resume_campaign', 'reactivate_ad'],
  'it switches an entity back on — a rule never does; that is a person\'s click or its own request', 'raise the bid back from the floor; enable-ads switches it back on at Amazon (what a Claude request paused; any other pause only with includePeoplesPauses and the approver\'s authenticator code)')
add(['archive_keyword'], 'it archives — for good, and a rule never does', 'lower_bid_to_floor; an archive meant for good is its own request (archive-ads on Amazon)')
add(['create_amazon_promotion', 'liquidate_aged_stock', 'reroute_marketplace_budget'], 'it is not in the actions Claude may automate', 'a change request a person approves')

export interface RefusedAction {
  type: string
  why: string
  instead: string
}

/** The actions of a rule (engine types, or a builder rule's produced types) that a Claude rule may not carry. */
export function refusedActionsOf(actionTypes: readonly string[]): RefusedAction[] {
  const seen = new Set<string>()
  const out: RefusedAction[] = []
  for (const type of actionTypes) {
    // Every pause_* is a pause, named or not.
    const rule = REFUSED[type] ?? (type.startsWith('pause_') ? REFUSED.pause_campaign : undefined)
    if (rule && !seen.has(type)) {
      seen.add(type)
      out.push({ type, ...rule })
    }
  }
  return out
}

/** The sentence a preview carries when a rule could not be saved by Claude. Null when nothing is refused. */
export function refusedWhenSaved(actionTypes: readonly string[]): { refusedWhenSaved: true; actions: RefusedAction[]; says: string } | null {
  const actions = refusedActionsOf(actionTypes)
  if (!actions.length) return null
  return {
    refusedWhenSaved: true,
    actions,
    says: `Claude could not save this rule: ${actions.map((a) => `${a.type} (${a.why}; use ${a.instead})`).join('; ')}.`,
  }
}
