'use client'

/**
 * PES.8 — the review surface: every AI draft in the current scope, with its diff and its decision.
 *
 * Layout §1 calls this a filtered view of the sheet, like missing-required, and that is where it
 * ends up: PES.1's View-bar chip opens it, PES.2's overlay tints the cells behind it. Neither is a
 * dependency of the review ITSELF, which is deliberate — the diff, the caps, the staleness and the
 * two decisions are the whole substance of the feature, and they are legible as a list whether or
 * not a grid is tinted underneath.
 *
 * Built from scratch on the DS (layout §2.10). No old surface is imported, reskinned or wrapped.
 *
 * The three honesty rules the layout asks for, made structural here rather than remembered:
 *  - a stale draft cannot be approved by the same control as a clean one; its button says what it
 *    would overwrite and shows the current value beside it,
 *  - a failed draft is shown with the cap it broke and offers NO approve control at all, because
 *    the server will refuse it — a button that cannot work is worse than none,
 *  - nothing is painted decided until the server says so; a refusal comes back as text on the row.
 */
import { useCallback, useState } from 'react'

import { Button } from '@/design-system/primitives/Button'
import { Spinner } from '@/design-system/primitives/Spinner'

import { overCapNote } from '../drawer/format'

import { displayValue, measure, splitViolations, type DraftColumnGroup } from './drafts'
import type { AiDraft } from './types'
import type { UseAiDraftsValue } from './useAiDrafts'
import styles from './ai-review.module.css'

export interface AiDraftReviewProps {
  /** The live hook value — the review does not fetch, so a host can share one load. */
  drafts: UseAiDraftsValue
  /** SKU by product id, so a row names the product an operator recognises. */
  skuById?: Record<string, string>
  /**
   * Called after an approve that actually wrote something.
   *
   * The host needs this: approving replays through `PATCH /api/products/bulk`, so the CELL now
   * holds a new value while the sheet is still showing the old one. This hook refreshes its own
   * drafts, but it has no way to refresh someone else's rows — and a sheet that keeps displaying
   * the pre-approval value is exactly the "displayed must round-trip" rule broken, in the one
   * moment an operator is watching for the change they just made.
   */
  onApplied?: (applied: number) => void
}

/**
 * Character / byte counts against the caps this draft was actually held to.
 *
 * Two DS.1 rules apply here (#440), and they interact:
 *
 * 1. **Exactly one surface names the cap's SOURCE per state.** The `cap from …` span is therefore
 *    gated on NOT being over: when a draft is over, the violation note below already says
 *    "— the Amazon · IT cap", and both rendering it put "Amazon · IT" on screen twice in the same
 *    row. That duplication was live, not hypothetical.
 *
 * 2. **An over-cap state must say so in WORDS, not by tint and weight alone.** Here it already
 *    does, in the violation note directly beneath — an over-cap value always carries an
 *    `over_max_length`/`over_max_bytes` violation at `severity: 'error'` (validate.ts), and the
 *    error note renders for exactly those. So importing `overCapNote` unconditionally would add a
 *    THIRD mention and break rule 1.
 *
 *    `hasErrorNote` closes the gap without the duplication: if that invariant is ever broken —
 *    a row seeded past the validator, a future path storing `capsUsed` without validating — the
 *    words appear here instead of the state being carried by colour alone. Belt and braces on an
 *    invariant that holds today and is not enforced by a type.
 */
function Measure({ draft, hasErrorNote }: { draft: AiDraft; hasErrorNote: boolean }) {
  const { chars, bytes } = measure(draft.draftValue)
  const caps = draft.capsUsed
  if (!caps?.maxLength && !caps?.maxBytes) {
    return <span>{chars} characters</span>
  }
  const overChars = caps.maxLength != null && chars > caps.maxLength
  const overBytes = caps.maxBytes != null && bytes > caps.maxBytes
  const over = overChars || overBytes
  return (
    <>
      {caps.maxLength != null && (
        <span className={overChars ? styles.metaOver : undefined}>
          {chars} / {caps.maxLength} characters
        </span>
      )}
      {caps.maxBytes != null && (
        <span className={overBytes ? styles.metaOver : undefined}>
          {bytes} / {caps.maxBytes} bytes
        </span>
      )}
      {!over && caps.capFrom && <span>cap from {caps.capFrom}</span>}
      {over && !hasErrorNote && (
        <span className={styles.metaOver}>{overCapNote(caps.capFrom).replace(/^ — /, '')}</span>
      )}
    </>
  )
}

function Value({ v, draft }: { v: unknown; draft?: boolean }) {
  const text = displayValue(v)
  if (text === '') {
    return <p className={`${styles.value} ${styles.valueEmpty}`}>(empty)</p>
  }
  return <p className={`${styles.value}${draft ? ` ${styles.valueDraft}` : ''}`}>{text}</p>
}

function DraftRow({
  draft,
  sku,
  busy,
  onApprove,
  onReject,
}: {
  draft: AiDraft
  sku?: string
  busy: boolean
  onApprove(ids: string[], allowStale: boolean): void
  onReject(ids: string[]): void
}) {
  const { errors, warnings } = splitViolations(draft.violations)
  const failed = draft.status === 'failed' || errors.length > 0
  const blocked = draft.unverified

  return (
    <div className={styles.row}>
      <div className={styles.side}>
        <span className={styles.sideLabel}>
          {draft.stale ? 'In the cell now' : 'Current'}
          {sku ? <span className={styles.sku}> · {sku}</span> : null}
        </span>
        <Value v={draft.stale ? draft.currentValue : draft.baseValue} />
        {draft.stale && (
          <p className={`${styles.note} ${styles.noteWarn}`}>
            This cell changed after the draft was written. The draft was generated against{' '}
            {displayValue(draft.baseValue) === '' ? 'an empty cell' : '"' + displayValue(draft.baseValue).slice(0, 80) + '"'}.
            Approving replaces what is there now.
          </p>
        )}
      </div>

      <div className={styles.side}>
        <span className={styles.sideLabel}>✦ AI draft</span>
        <Value v={draft.draftValue} draft />
        <div className={styles.meta}>
          <Measure draft={draft} hasErrorNote={errors.length > 0} />
          {draft.confidence && <span>{draft.confidence} confidence</span>}
        </div>
        {draft.rationale && <p className={styles.rationale}>{draft.rationale}</p>}
        {warnings.map((w, i) => (
          <p key={i} className={`${styles.note} ${styles.noteWarn}`}>
            {w.message}
          </p>
        ))}
        {errors.map((e, i) => (
          <p key={i} className={`${styles.note} ${styles.noteError}`}>
            {e.message} — the model wrote a value the channel will refuse, so it is not offered.
            Nothing was trimmed to make it fit.
          </p>
        ))}
        {draft.lastApplyError && (
          <p className={`${styles.note} ${styles.noteError}`}>
            Last attempt refused: {draft.lastApplyError}
          </p>
        )}
        {blocked && (
          <p className={`${styles.note} ${styles.noteError}`}>
            The listing alias this draft was written against no longer exists, so we cannot tell
            what the cell holds. Regenerate it against the current aliases.
          </p>
        )}
      </div>

      <div className={styles.rowActions}>
        {/* A failed or unverifiable draft gets no approve control: the server refuses both, and a
            button that cannot work is worse than an absent one. */}
        {!failed && !blocked && (
          <Button
            size="sm"
            variant={draft.stale ? 'secondary' : 'primary'}
            disabled={busy}
            onClick={() => onApprove([draft.id], draft.stale)}
          >
            {draft.stale ? 'Approve anyway' : 'Approve'}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReject([draft.id])}>
          Reject
        </Button>
      </div>
    </div>
  )
}

function ColumnGroup({
  group,
  skuById,
  busy,
  onApprove,
  onReject,
}: {
  group: DraftColumnGroup
  skuById?: Record<string, string>
  busy: boolean
  onApprove(ids: string[], allowStale: boolean): void
  onReject(ids: string[]): void
}) {
  const caps = group.caps
  return (
    <section className={styles.group}>
      <header className={styles.groupHead}>
        <div className={styles.groupName}>
          <span className={styles.groupKey}>{group.columnKey}</span>
          {caps && (caps.maxLength || caps.maxBytes) && (
            <span className={styles.groupCaps}>
              {caps.maxLength ? `${caps.maxLength} chars` : ''}
              {caps.maxLength && caps.maxBytes ? ' · ' : ''}
              {caps.maxBytes ? `${caps.maxBytes} bytes` : ''}
              {caps.capFrom ? ` · ${caps.capFrom}` : ''}
            </span>
          )}
          <span className={styles.groupCaps}>
            {group.drafts.length} drafted
            {group.staleCount > 0 ? ` · ${group.staleCount} stale` : ''}
            {group.failedCount > 0 ? ` · ${group.failedCount} over cap` : ''}
          </span>
        </div>
        <div className={styles.actions}>
          {/* Column-level approve sends ONLY the cleanly approvable ones. It never waives
              staleness in bulk — that decision is per cell, next to the value it would replace. */}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || group.approvable.length === 0}
            onClick={() => onApprove(group.approvable.map((d) => d.id), false)}
          >
            Approve {group.approvable.length}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || group.drafts.length === 0}
            onClick={() => onReject(group.drafts.map((d) => d.id))}
          >
            Reject all
          </Button>
        </div>
      </header>
      {group.drafts.map((d) => (
        <DraftRow
          key={d.id}
          draft={d}
          sku={skuById?.[d.productId]}
          busy={busy}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
    </section>
  )
}

export function AiDraftReview({ drafts, skuById, onApplied }: AiDraftReviewProps) {
  const { groups, counts, loading, error, deciding, approve, reject } = drafts
  const [outcome, setOutcome] = useState<string | null>(null)

  const onApprove = useCallback(
    (ids: string[], allowStale: boolean) => {
      setOutcome(null)
      void approve(ids, { allowStale }).then((res) => {
        // Report what the SERVER did, including partials — an approval of five that landed three
        // must not read as five.
        if (res.approved.length > 0) onApplied?.(res.approved.length)
        if (res.refused.length === 0) {
          setOutcome(`Applied ${res.approved.length} of ${ids.length}.`)
        } else {
          setOutcome(
            `Applied ${res.approved.length} of ${ids.length}. ${res.refused.length} refused: ${res.refused
              .map((r) => r.reason)
              .join('; ')}`,
          )
        }
      })
    },
    [approve],
  )

  const onReject = useCallback(
    (ids: string[]) => {
      setOutcome(null)
      void reject(ids).then((res) => setOutcome(`Rejected ${res.rejected}.`))
    },
    [reject],
  )

  if (error) {
    return (
      <div className={styles.errorBox}>
        Could not load AI drafts: {error}
        <br />
        This is a failure to read, not an absence of drafts — there may be drafts waiting.
      </div>
    )
  }

  if (loading && groups.length === 0) {
    return (
      <div className={styles.empty}>
        <Spinner />
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className={styles.empty}>
        No AI drafts in this scope.
        <br />
        Drafts land here for review before any of them touch the catalogue.
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <header className={styles.head}>
        <span className={styles.title}>
          <span className={styles.mark} aria-hidden="true">
            ✦
          </span>
          AI drafts
        </span>
        <span className={styles.counts}>
          <span>{counts.pending} awaiting review</span>
          {counts.stale > 0 && <span>· {counts.stale} stale</span>}
          {counts.failed > 0 && <span>· {counts.failed} over cap</span>}
          {deciding && <Spinner />}
        </span>
      </header>
      {outcome && <p className={`${styles.note} ${styles.noteMuted}`}>{outcome}</p>}
      {groups.map((g) => (
        <ColumnGroup
          key={g.columnKey}
          group={g}
          skuById={skuById}
          busy={deciding}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
    </div>
  )
}
