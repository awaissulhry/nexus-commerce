/**
 * Reviews › Requests — the addresses of the Requests pages themselves (Queue, Rules, one rule, Timing), all built in
 * this PR. The Requests pages link to each other through these. Links from OTHER areas still go through
 * `_lib/reviewsLinks.ts` (`requestsHref`, `ruleHref`), which the coordinator points here when this PR is folded.
 * Workspace-free: render them with `Link` from `@/lib/workspaces/Link`, which adds the business.
 */
export const REQUESTS_PATH = '/marketing/reviews/requests'
export const RULES_PATH = '/marketing/reviews/requests/rules'
export const NEW_RULE_ID = 'new'
export const TIMING_PATH = '/marketing/reviews/requests/timing'

/** One rule's editor; `new` opens an empty one. */
export function rulePath(id: string): string {
  return `${RULES_PATH}/${encodeURIComponent(id)}`
}

/** The Timing page, optionally scrolled to "Send hour by weekday". */
export function timingPath(section?: 'send-hours'): string {
  return section ? `${TIMING_PATH}?section=${section}` : TIMING_PATH
}
