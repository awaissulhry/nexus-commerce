/**
 * Keyword Harvest page, Terms view (lane TERMS, 2026-10-11). The page's [Terms | Rules | Sources] switch mounts it:
 *
 *   <TermsView market={market} show={tile} onTotals={setTermsTotals} viewSwitch={switch} />
 *
 * The ONE review of waiting harvest requests (re-audit N-M1), for the rule modal's Waiting tab too — the same hook, the
 * same task (stale asks: Approve leaves them out and says how many; Reject takes them), the same dialogs:
 *
 *   const rows = (await readCandidates({ market, state: ['WAITING'] })).rows.filter((r) => r.waiting?.tool === `rule:${ruleId}`)
 *   const review = useTermsReview({ after: reload })
 *   review.ask({ kind: 'approve', ...waitingDecision('approve', ticked, rows) })   // or 'reject'
 *   <ReviewDialogs {...review} returnFocusTo={…} />
 *
 * `approveHeld(row)` / `decideHeld(row)` say why a row's Approve / Reject is held (a stale ask: Approve held with its
 * reason, Reject offered); `decideButtonWords(kind, rows)` counts requests the same way ("Approve 2 requests · 3 terms").
 */
export { TermsView } from './TermsView'
export { approveHeld, decideButtonWords, decideHeld, isTermsShow, statusOf, waitingDecision } from './termsModel'
export { useTermsReview } from './useTermsReview'
export { ReviewDialogs } from './ReviewDialogs'
