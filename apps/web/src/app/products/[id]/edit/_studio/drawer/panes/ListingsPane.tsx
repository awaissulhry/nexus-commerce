'use client'

/**
 * PES.4.7 — what THIS scope's channel currently thinks the record is.
 *
 * Read-only, and that is a decision rather than an omission. Publishing stays explicit and
 * preflight-first (MS.5): a "Publish" button inside a record drawer is exactly how a preview-only
 * channel gets published by reflex. The pane says what the state IS — live or not, what it last
 * sent, what would be refused now — and hands off to the publish flow that already knows how to ask.
 *
 * 🔴 ONE listing, not a map. `StudioRow` (studio-sheet.service.ts:138) carries `listing` and
 * `readiness` SINGULAR, because the studio sheet is loaded FOR one scope. This pane used to
 * iterate a `listings` map keyed by coordinate — a shape only the catalogue-wide read has, which
 * this lane had mirrored by mistake. The master scope has no listing at all, and says so rather
 * than rendering an empty card that looks like a broken one.
 *
 * Every fact comes from the row object the sheet already holds. No second fetch, so this pane and
 * the sheet's readiness chip cannot disagree.
 */

import { AlertTriangle, CheckCircle2, CircleDashed, ExternalLink } from 'lucide-react'
import { Pill } from '@/design-system/primitives/Pill'
import { readinessMeta } from '../readinessMeta'
import { listingUrl } from '../listingUrl'
import { ago, when } from '../format'
import type { DrawerScope, SheetRow } from '../types'
import type { ReactNode } from 'react'
import styles from '../drawer.module.css'

function money(v: number | null): string {
  return v == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(v)
}

export function ListingsPane({
  row,
  scope,
  actions,
}: {
  row: SheetRow
  scope: DrawerScope
  /** The registry's verbs for this row, already adapted. The pane declares none of its own. */
  actions?: ReactNode
}) {
  const listing = row.listing
  const readiness = row.readiness
  /**
   * 🔴 NOT `?? 'unlisted'`. That invented a state the server never reported — "Not listed" is a
   * claim about the channel, and absent readiness means we do not know, which is a different thing
   * and the one an operator would act on differently. Same class as the `?? 'DRAFT'` fix
   * (#235/#236), and this lane wrote it while enforcing the rule elsewhere: `offerActive` right
   * below already renders "not reported" for exactly this reason.
   */
  const state = readiness?.state ?? null
  // Tone and label from ONE source across the studio (spec §3). The drawer does not get to decide
  // that "errors" is red here while the sheet's chip calls it something else.
  const meta = state ? readinessMeta(state, 'row') : null

  const errors = readiness?.issues?.filter((i) => i.severity === 'error') ?? []
  const warns = readiness?.issues?.filter((i) => i.severity === 'warn') ?? []
  const label = scope.label ?? (scope.kind === 'master' ? 'Master' : [scope.channel, scope.marketplace].filter(Boolean).join(' · '))
  const ref = listing?.externalListingId ?? readiness?.ref ?? null
  const url = listingUrl(scope.channel, scope.marketplace, ref)

  if (scope.kind === 'master' && !listing) {
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <CircleDashed size={14} className={styles.noteIcon} aria-hidden />
        <span>
          Master is the stored truth, not a channel — it has no listing of its own. Switch the scope bar to a channel
          to see what that channel holds.
        </span>
      </div>
    )
  }

  return (
    <section className={styles.lCard}>
      <div className={styles.lHead}>
        <span className={styles.lName}>
          {state === 'live' || state === 'ready' ? (
            <CheckCircle2 size={13} aria-hidden />
          ) : state === 'errors' ? (
            <AlertTriangle size={13} aria-hidden />
          ) : (
            <CircleDashed size={13} aria-hidden />
          )}
          {label}
        </span>
        {meta ? (
          <Pill tone={meta.tone} title={meta.hint}>
            {meta.label}
          </Pill>
        ) : (
          <span className={styles.absent} title="The sheet read reported no readiness for this coordinate.">
            readiness not reported
          </span>
        )}
      </div>

      <dl className={styles.lFacts}>
        <div className={styles.lFact}>
          <dt>Status</dt>
          <dd>{listing?.listingStatus ?? <span className={styles.absent}>no listing row</span>}</dd>
        </div>
        {/* Two different facts, shown as two (ruling #115.2). Collapsing them into one
            "active?" row would say a paused offer is unpublished, or a published-but-paused
            listing is live — and an operator acts differently on each. */}
        <div className={styles.lFact}>
          <dt>Pushed to channel</dt>
          <dd>
            {listing == null ? (
              '—'
            ) : listing.isPublished ? (
              'yes'
            ) : (
              <span title="The marketplace keeps serving what it last received until someone publishes.">
                no — not being pushed
              </span>
            )}
          </dd>
        </div>
        <div className={styles.lFact}>
          <dt>Offer</dt>
          <dd>
            {listing == null || listing.offerActive === undefined ? (
              <span className={styles.absent}>not reported</span>
            ) : listing.offerActive ? (
              'selling'
            ) : (
              <span title="The listing still exists on the marketplace; its buy box is suppressed.">
                paused
              </span>
            )}
          </dd>
        </div>
        <div className={styles.lFact}>
          <dt>Price</dt>
          <dd>{money(listing?.price ?? null)}</dd>
        </div>
        <div className={styles.lFact}>
          {/* Per-channel, never summed — a quantity added across channels is an oversell. */}
          <dt>Quantity (this channel)</dt>
          <dd>{listing?.quantity ?? '—'}</dd>
        </div>
        <div className={styles.lFact}>
          <dt>Channel reference</dt>
          {/* 🔴 ONE render of the id. It used to print here AND again below beside an ExternalLink
              icon that was a plain <div> — so the pane showed the same id twice and the half that
              looked clickable was the half that did nothing (SR.1, #327.8). The icon now belongs
              to the link, and the link only exists when the URL is actually known. */}
          <dd className={styles.lRef}>
            {ref ? (
              url ? (
                <a href={url} target="_blank" rel="noreferrer noopener" className={styles.lRefLink}>
                  {ref} <ExternalLink size={11} aria-hidden />
                </a>
              ) : (
                ref
              )
            ) : (
              <span className={styles.absent}>none yet</span>
            )}
          </dd>
        </div>
        <div className={styles.lFact}>
          {/* When a sync last RAN — NOT a check against the channel, which nothing does yet. */}
          <dt>Last synced</dt>
          <dd>
            {/* 🔴 Three states, not two (#338). `undefined` = the projection has not shipped the
                field, `null` = it shipped and this listing has never synced, a timestamp = when.
                Collapsing the first two would print "Never synced" for a listing nobody has asked
                about yet — the same undefined-vs-null distinction `previousWasRecorded()` makes.
                And "Never synced" is NOT softened: on prod today most listings are null and none
                has synced in seven days. That is true of our records, and a live listing saying so
                is the point of the row. */}
            {listing?.lastSyncedAt === undefined ? (
              <span className={styles.absent}>not reported</span>
            ) : listing.lastSyncedAt === null ? (
              <span className={styles.absent}>Never synced</span>
            ) : (
              <time dateTime={listing.lastSyncedAt} title={when(listing.lastSyncedAt)}>
                {ago(listing.lastSyncedAt)}
              </time>
            )}
          </dd>
        </div>
      </dl>

      {errors.length > 0 && (
        <ul className={styles.lErrors}>
          {errors.map((i) => (
            <li key={`e-${i.key}`}>
              <strong>{i.label}:</strong> {i.message}
            </li>
          ))}
        </ul>
      )}
      {warns.length > 0 && (
        <ul
          className={styles.lErrors}
          style={{ background: 'var(--nds-warning-soft)', color: 'var(--nds-warning-text)' }}
        >
          {warns.map((i) => (
            <li key={`w-${i.key}`}>
              <strong>{i.label}:</strong> {i.message}
            </li>
          ))}
        </ul>
      )}

      {/* Verbs live here because a channel action is about THIS listing — and they are mirrored
          from the registry, never declared by this pane (ruling #110). */}
      {actions}
    </section>
  )
}
