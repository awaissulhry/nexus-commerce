'use client'

/**
 * Keyword Harvest page — the review dialogs of a harvest change (2026-10-11, re-audit N-M1 / N-S3): the DS
 * `ReviewChangesModal` (one summary, one table in Keywords / Negatives tabs, a counted button, Done with Undo) and the
 * DS code dialog when an approve needs the approver's authenticator code. The Terms view AND the rule modal's Waiting
 * tab render THIS, fed by the same hook (`useTermsReview`) and the same task (`waitingDecision`), so a waiting request
 * reads, holds and decides the same everywhere.
 *
 *   const r = useTermsReview({ after: reload })
 *   r.ask({ kind: 'approve', ...waitingDecision('approve', ticked, allRows) })
 *   <ReviewDialogs {...r} />
 *
 * Rows: on a wide screen Where (the place as links, one line) · What · Now · New · Note; on a phone a full-screen sheet
 * whose rows put the place under the term and leave the note out (like the Harvest window's review). Nothing wraps in
 * Now / New.
 */
import { useNarrow, EntityLinks, EntityPath, type EntityLinkComponent, type ModalProps } from '@/design-system/components'
import { ReviewChangesModal, StepUpModal, type ReviewPanelChange } from '@/design-system/patterns'
import Link from '@/lib/workspaces/Link'
import type { DecideChange } from './termsModel'
import type { useTermsReview } from './useTermsReview'
import styles from './terms.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const STEP_NOUN = { one: 'place', many: 'places' }

type ReviewApi = ReturnType<typeof useTermsReview>

const isDecide = (c: ReviewPanelChange): c is DecideChange & ReviewPanelChange => Array.isArray((c as { place?: unknown }).place)

/** A decision's row as the review draws it: the place as links (N-S3); on a phone under the term. */
export function decideRowView(c: ReviewPanelChange, narrow: boolean): ReviewPanelChange {
  if (!isDecide(c)) return c
  // Wide: one line, the path's middle cut when it must. Phone: every step a link, wrapping — never cut (final pass).
  const place = narrow
    ? <span className={styles.placeLines}>{c.place.filter((r): r is NonNullable<typeof r> => !!r).map((r, i) => (
      <span key={`${r.id}-${i}`} className={styles.placeWrap}>{i > 0 && <span aria-hidden> › </span>}<EntityLinks items={[r]} noun={STEP_NOUN} linkAs={WorkspaceLink} /></span>
    ))}</span>
    : <span className={styles.where}><EntityPath items={c.place} linkAs={WorkspaceLink} label="Where" /></span>
  const now = <span className={styles.nowrap}>{c.now}</span>
  const next = <span className={styles.nowrap}>{c.next}</span>
  return narrow
    ? { id: c.id, group: c.group, what: <span className={styles.two}><span>{c.term}</span><span className={styles.sub}>{place}</span></span>, now, next }
    : { id: c.id, group: c.group, where: place, what: <span className={styles.nowrap}>{c.term}</span>, now, next, note: c.note }
}

export function ReviewDialogs({ review, save, close, undoSaved, stepUp, submitCode, cancelCode, returnFocusTo }: Pick<ReviewApi, 'review' | 'save' | 'close' | 'undoSaved' | 'stepUp' | 'submitCode' | 'cancelCode'> & {
  returnFocusTo?: ModalProps['returnFocusTo']
}) {
  const narrow = useNarrow()
  return (
    <>
      {review && (
        <ReviewChangesModal
          open
          size={narrow ? 'detail' : 'xl'}
          onClose={close}
          title={review.title}
          changes={review.changes.map((c) => decideRowView(c, narrow))}
          groups={review.groups}
          doneLine={review.doneLine}
          state={review.state}
          summary={review.summary}
          saveLabel={review.saveLabel}
          doneVerb={review.doneVerb}
          onSave={() => void save()}
          onUndo={review.state.phase === 'done' && review.undo ? () => void undoSaved() : undefined}
          undoing={review.undoing}
          returnFocusTo={returnFocusTo}
        />
      )}
      {stepUp && (
        <StepUpModal
          open
          title="Authenticator code"
          sentence={stepUp.sentence}
          busy={stepUp.busy}
          error={stepUp.error}
          confirmLabel="Approve"
          onSubmit={(code) => void submitCode(code)}
          onClose={() => void cancelCode()}
        />
      )}
    </>
  )
}
