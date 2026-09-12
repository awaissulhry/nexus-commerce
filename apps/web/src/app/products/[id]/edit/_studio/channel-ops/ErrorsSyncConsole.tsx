'use client'

/**
 * PES.3 — the Errors & Sync console (Owner-approved, ruling #127).
 *
 * A studio TAB on a channel scope, not a page and not a drawer pane. The drawer shows THIS
 * product's problems; a console does triage across many — and the queue is 37,846 rows deep, so
 * triage is the only useful shape.
 *
 * ── Two rules that are the whole point (rulings #130/#131) ──────────────────────────────────────
 * 1. **`stuck: 0` renders EMPTY.** Zero is the true answer right now, and the temptation is to
 *    reach for a looser filter so the pane has something to show. PES.5 quantified what that costs:
 *    "stuck" written naively as age-only reports 441 for GALE-JACKET alone and 36,844 table-wide,
 *    against 0 for the honest definition. A console an operator stops believing is worse than an
 *    empty one.
 * 2. **The coverage note always renders.** 86% of the queue (32,665 rows) is attached to no product
 *    at all and can never appear in a product-scoped view. An empty panel is precisely the shape
 *    that reads as reassurance, so the pane states what it cannot see.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, FilterChip } from '@/design-system/primitives'
import { PressableRow } from '@/design-system/components/PressableRow'
import { getBackendUrl } from '@/lib/backend-url'

import {
  DORMANT_SOURCES,
  gateNote,
  groupIsQuiet,
  groupReason,
  groupVerdict,
  jumpTargetOf,
  groupByCause,
  modeForChannel,
  summarise,
  type PublishReadiness,
  type SyncFilter,
  type SyncQueuePage,
} from './syncQueue'

import styles from './errors-sync.module.css'

export interface ErrorsSyncConsoleProps {
  productId: string
  accountId?: string
  listingId?: string
  channel: string
  marketplace: string
  scopeLabel: string
  /**
   * Take the operator from a problem to the row. `rowId` is null when the alias could not be
   * resolved (45 of 441 rows) — those still reach the sheet, and the control says which it is doing
   * rather than promising a precision it does not have.
   */
  onJumpToRow?: (rowId: string | null) => void
}

/**
 * What the true total is a total OF. "269 dead" and "269 queued writes" are different claims, and
 * the summary line names the one the filter actually counted.
 */
const FILTER_NOUN: Record<SyncFilter | 'all', string> = {
  dead: 'dead writes',
  retrying: 'retrying writes',
  stuck: 'stuck writes',
  all: 'queued writes',
}

/**
 * `9 Jun 2026`, never `09/06/2026`.
 *
 * A numeric date is 9 June to a British reader and 6 September to an American one — and on this
 * console the second reads as a FUTURE date, which looks like corrupt data rather than an
 * ambiguity. Writing the month costs three characters and removes the question.
 */
function formatSince(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const FILTERS: Array<{ id: SyncFilter | 'all'; label: string }> = [
  { id: 'dead', label: 'Dead' },
  { id: 'retrying', label: 'Retrying' },
  { id: 'stuck', label: 'Stuck' },
  { id: 'all', label: 'All' },
]

export function ErrorsSyncConsole({
  productId,
  accountId,
  listingId,
  channel,
  marketplace,
  scopeLabel,
  onJumpToRow,
}: ErrorsSyncConsoleProps) {
  const [filter, setFilter] = useState<SyncFilter | 'all'>('dead')
  const [page, setPage] = useState<SyncQueuePage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [readiness, setReadiness] = useState<PublishReadiness | null>(null)
  /**
   * 🔴 Separate from `readiness` itself, because `null` now means two different things downstream.
   *
   * `gateNote(null, …)` warns that the gate is not described — correct once the response has
   * ARRIVED and did not describe this channel (WooCommerce, Etsy), and wrong while the request is
   * still in flight, where it would flash "we cannot vouch" at every operator on every load.
   * "Not yet asked" is not "asked and not answered", and one `null` cannot carry both.
   */
  const [readinessSettled, setReadinessSettled] = useState(false)

  /**
   * The publish gate, read from the server rather than assumed.
   *
   * Separate from the queue fetch and deliberately not blocking it: if this read fails the console
   * still works, it just cannot say anything about the gate — which is the correct degradation,
   * because a missing answer must not become a confident one.
   */
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/listings/publish-readiness`, { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled) {
          setReadiness((body as PublishReadiness) ?? null)
          setReadinessSettled(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReadiness(null)
          setReadinessSettled(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPage(null)
    setOpen(new Set())
    setError(null)
    // 200 is the server's maximum (`sync-queue.service.ts`: `Math.min(200, …)`); asking for more
    // returns 200. Grouping over the widest page the server allows is the most this console can do
    // without a server-side rollup — it does not make the page a total, which is why the summary
    // line says which it is.
    const params = new URLSearchParams({ channel, market: marketplace, filter, limit: '200' })
    if (accountId !== undefined) params.set('accountId', accountId)
    if (listingId !== undefined) params.set('listingId', listingId)
    fetch(`${getBackendUrl()}/api/products/${productId}/sync-queue?${params}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
        return body as SyncQueuePage
      })
      .then((body) => {
        if (!cancelled) setPage(body)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPage(null)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId, channel, marketplace, accountId, listingId, filter])

  const causes = useMemo(() => (page ? groupByCause(page.rows) : []), [page])
  const gate = readinessSettled ? gateNote(modeForChannel(readiness, channel), scopeLabel) : null

  const toggle = useCallback((cause: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(cause)) next.delete(cause)
      else next.add(cause)
      return next
    })
  }, [])

  return (
    <div className={styles.console}>
      <header className={styles.head}>
        <span className={styles.scope}>{scopeLabel}</span>
        <span className={styles.summary}>
          {page
            ? page.counts.all === 0 ? 'No attributed queue entries were found in this scope.' : summarise(page.causes, page.causesTotal, FILTER_NOUN[filter])
            : loading
              ? 'Reading the queue…'
              : '—'}
        </span>
      </header>

      <div className={styles.filters}>
        {/* The DS FilterChip, as on the sheet toolbar (CT.1). These were a clickable Pill, and
            `.nds-pill.btn { font: inherit }` handed them the page's 16px / 400 type — the Owner's
            "dead, retrying, stuck … not aligned with the design system" (2026-09-04). */}
        {FILTERS.map((f) => (
          <FilterChip
            key={f.id}
            size="md"
            pressed={f.id === filter}
            count={page ? page.counts[f.id === 'all' ? 'all' : f.id].toLocaleString('en-GB') : undefined}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </FilterChip>
        ))}
      </div>

      {/*
        🔴 Above the groups, not in the footer, and rendered whether or not there are rows.
        An operator looking at 36 dead writes will reach for Retry; while the mode is `gated` the
        same helper that failed them refuses the retry too (outbound-sync.service.ts:1209), and 368
        rows in the queue are already that exact refusal. This sentence is what stops the next hour
        being spent on a button that cannot work.
      */}
      {/* The ROW LIST is still capped at 200 (`limit=200` is the server maximum), so it says so —
          the cause line above is now authoritative and this one is not. Two different scopes, and
          conflating them is what made "50 writes" read as a total. */}
      {page && page.rows.length < page.causesTotal && (
        <p className={styles.pageNote}>
          Showing the {page.rows.length.toLocaleString('en-GB')} most recent of{' '}
          {page.causesTotal.toLocaleString('en-GB')} — the cause totals above cover all of them.
        </p>
      )}

      {gate && <div className={styles.gate}>{gate}</div>}

      {error && (
        <div className={styles.notice}>
          <strong>Could not read the sync queue.</strong> {error}
        </div>
      )}

      {!error && !loading && causes.length === 0 && (
        /**
         * Empty, and saying so plainly rather than reaching for a filter that would produce
         * something to display. `stuck: 0` is the TRUE answer on this coordinate today.
         */
        <div className={styles.empty}>
          No attributed {filter === 'all' ? 'queued' : filter} entries for this product on {scopeLabel}.
        </div>
      )}

      {causes.map((c) => {
        const isOpen = open.has(c.cause)
        return (
          <section key={c.cause} className={styles.cause}>
            {/* DS `Button`, not a hand-rolled native button element (#601) — spelled out rather than
                written as the literal tag, which the ratchet would count from this comment.
                `block` is documented for exactly this —
                "a section header that IS the disclosure" — and `quiet` inherits the surface's
                colour instead of declaring one. The module class keeps the gap, padding and weight
                the DS base would otherwise impose; see `.causeHead` in the stylesheet. */}
            {/*
              A DISCLOSURE ROW, not a button (CT.1, 2026-09-04). This was a `Button block quiet`
              restyled by a module class into a 34px / 12px / 400 row — a control the census could
              only read as a button off every tier. The DS `PressableRow` is the primitive for "a
              row that IS the disclosure": the label is the real button, the counts and the verdict
              are its body, `expanded` carries `aria-expanded`. The record drawer's group rows are
              the same component, so the two disclosure rows in this studio now agree.
            */}
            <PressableRow
              className={styles.causeHead}
              expanded={isOpen}
              onClick={() => toggle(c.cause)}
              label={
                <span className={styles.causeLabel}>
                  <span className={styles.chevron}>{isOpen ? '▾' : '▸'}</span>
                  <span className={styles.causeName}>{c.cause}</span>
                </span>
              }
            >
              {/*
                🔴 The PRODUCT figure is gone, not qualified. It was distinct products within the
                returned page — 18 among 50 of 269 — and a count over a sample cannot be made honest
                by wording, only by a server-side rollup. The write count stays because the summary
                line above now states plainly that the grouping was over a page.
              */}
              <span className={styles.causeCount}>
                {c.rows.length.toLocaleString('en-GB')} {c.rows.length === 1 ? 'write' : 'writes'}
              </span>
              {/* `09/06/2026` is 9 June to a British reader and 6 September to an American one, and
                  the second is in the future — which reads as a bug in the data. Write the month. */}
              <span className={styles.causeSince}>since {formatSince(c.since)}</span>
              {/* The lifecycle codes, shown but never used as the group's name: "MAX_RETRIES_EXCEEDED"
                  says the queue gave up, not what went wrong (see OUTCOME_CODES). */}
              {c.codes.length > 0 && <span className={styles.causeCodes}>{c.codes.join(' · ')}</span>}
              {/*
                🔴 Tone follows the VERDICT, not the cause. A throttle that heals itself must not
                carry the weight of a refusal — but a throttle that DIED mid-defer is a write that
                never reached the channel, and toning that quiet is a false reassurance. All 377
                circuit-open rows in this database are dead with retries exhausted.
              */}
              <span
                className={`${styles.reason} ${groupIsQuiet(c) ? styles.reason_quiet : styles.reason_needsYou}`}
              >
                {groupReason(c)}
                {!groupIsQuiet(c) && c.rows.every((r) => !r.reasonWillRetry) ? ' · will not retry' : ''}
              </span>
            </PressableRow>

            {/* The server's verdict, in full, under the bucket label. One sentence per group. */}
            {groupVerdict(c) && <p className={styles.verdict}>{groupVerdict(c)}</p>}

            {isOpen && (
              <ul className={styles.rows}>
                {c.rows.slice(0, 50).map((r) => (
                  <li key={r.id} className={styles.row}>
                    <span className={styles.rowSku} title={r.sku ?? undefined}>{r.sku ?? '—'}</span>
                    <span className={styles.rowType}>{r.syncType}</span>
                    <span className={styles.rowRef}>{r.externalListingId ?? '—'}</span>
                    <span className={styles.rowAge}>{new Date(r.createdAt).toLocaleDateString('en-GB')}</span>
                    <span className={styles.rowRetry}>
                      {r.retryCount}/{r.maxRetries}
                    </span>
                    {/* The message VERBATIM. The group name above is a normalised bucket label with
                        its numbers redacted — necessary to group at all, but it means the status
                        code and the retry timer only survive here. `title` carries the untruncated
                        text; nothing an operator needs is lost to the grouping. */}
                    <span className={styles.rowMessage} title={r.errorMessage ?? undefined}>
                      {r.errorMessage ?? '—'}
                    </span>
                    {r.productId && onJumpToRow ? (
                      /* Two labels, each true: "Go to row" only when the alias resolved and the
                         jump really lands on that row, "Open sheet" for the ~10% where it cannot.
                         One label covering both would overpromise on exactly the rows an operator
                         would most resent being misled about. */
                      <Button
                        variant="link"
                        size="xs"
                        title={jumpTargetOf(r) ? `Row ${jumpTargetOf(r)}` : 'The alias for this write is unknown, so there is no specific row to open'}
                        onClick={() => onJumpToRow(jumpTargetOf(r))}
                      >
                        {jumpTargetOf(r) ? 'Go to row' : 'Open sheet'}
                      </Button>
                    ) : (
                      <span className={styles.rowNoJump} title="This queued write is not attached to a product, so there is no row to open.">
                        no row
                      </span>
                    )}
                  </li>
                ))}
                {c.rows.length > 50 && (
                  <li className={styles.more}>
                    {(c.rows.length - 50).toLocaleString('en-GB')} more with this cause — the count above is the whole group.
                  </li>
                )}
              </ul>
            )}
          </section>
        )
      })}

      <footer className={styles.foot}>
        {/* ALWAYS rendered, never conditional on there being rows. This is the sentence that stops
            an empty console being read as "nothing is wrong". */}
        {page?.scope.coverageNote && <p className={styles.coverage}>{page.scope.coverageNote}</p>}
        <p className={styles.dormant}>
          Not shown here:{' '}
          {DORMANT_SOURCES.map((d) => d.label).join(', ')} — nothing recorded on this coordinate yet.
        </p>
      </footer>
    </div>
  )
}
