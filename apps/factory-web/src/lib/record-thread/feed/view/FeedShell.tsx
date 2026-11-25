'use client'

import type { ReactNode } from 'react'
import { ChevronDown, MailOpen } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import type { Locale } from '../../../i18n/locales'
import type { Translate } from '../../../i18n/messages'
import { useT } from '../../../i18n/provider'
import { dayWord } from '../../parts/time'
import type { FeedShellHandles, FeedShellModel } from '../use-feed-shell'
import '../../parts/parts.css'
import '../feed.css'

/**
 * pt-w1 W1.3 (lane pt-, S4; ONE SHARED THREAD): the list both doors draw — moved out of the office Feed as it was: the host's top line
 * (the office's offline banner), ONE scrolling column (role feed: `.fw-rt-feed`, the list a jump scrolls) with the top sentinel, the older
 * page's pill or its Retry, the host's rows and its end lines (or its empty state instead); the floating day; the round down button with
 * the count of what arrived below; what a screen reader hears. Its behaviour is `useFeedShell`; the host draws each row.
 */
export function FeedShell({
  shell,
  model,
  top,
  empty,
  rows,
  end,
}: {
  shell: FeedShellHandles
  model: Pick<FeedShellModel, 'more' | 'older'>
  /** Above the list (the office: no network, since when). */
  top?: ReactNode
  /** Drawn in the list instead of the rows (no messages and nothing else): no sentinel. */
  empty?: ReactNode
  /** The host's rows, oldest first. */
  rows: ReactNode
  /** The host's lines at the end, where new messages arrive. */
  end?: ReactNode
}): ReactNode {
  const t = useT('record-thread-feed')
  return (
    <div className="fw-rt-feedwrap">
      {top}
      <div ref={shell.feedRef} className="fw-rt-feed" role="feed" tabIndex={0} aria-label={t('feed.label')} aria-busy={model.older === 'loading'} onScroll={shell.onScroll} onKeyDown={shell.onKeyDown}>
        {empty ? (
          empty
        ) : (
          <>
            <div ref={shell.topRef} className="fw-rt-sentinel" aria-hidden="true" />
            {model.more && model.older === 'loading' && (
              <div className="fw-rt-pillrow" role="status">
                <span className="fw-rt-pill">{t('older.loading')}</span>
              </div>
            )}
            {model.more && model.older === 'failed' && (
              <p className="fw-rt-older-failed" role="alert">
                <span>{t('older.failed')}</span>
                <Button size="sm" onClick={shell.retryOlder}>
                  {t('older.retry')}
                </Button>
              </p>
            )}
            {rows}
            {end}
          </>
        )}
      </div>
      {shell.floatDay && (
        <p className={`fw-rt-float${shell.floatDay.on ? ' is-on' : ''}`} aria-hidden="true">
          <span className="fw-rt-pill is-day">{shell.floatDay.text}</span>
        </p>
      )}
      {(shell.scrolledUp || shell.newCount > 0) && (
        <button type="button" className="fw-rt-down" aria-label={t('down.label')} onClick={shell.toBottom}>
          <ChevronDown size={20} aria-hidden />
          {shell.newCount > 0 && <span className="fw-rt-down-n">{shell.newCount > 999 ? '999+' : shell.newCount}</span>}
        </button>
      )}
      <p className="fw-rt-sr" aria-live="polite">
        {shell.announce}
      </p>
    </div>
  )
}

// ── pt-w2 W2.2 (lane pt-, S4): the rows that are not a message, the same in both doors (moved out of Feed as they were) ─────────────

/** A day's words: Today, Yesterday, the weekday inside 7 days, then the date (parts/time). */
export function dayText(day: string, today: string, locale: Locale, t: Translate): string {
  const word = dayWord(day, today, locale)
  return word.kind === 'date' ? word.text : t(`day.${word.kind}`)
}

/** tw- W1.1 (S12): the day pill says the day; no time-zone tooltip per day. */
export function DayRow({ words }: { words: string }): ReactNode {
  return (
    <div className="fw-rt-pillrow is-day" data-day={words}>
      <span className="fw-rt-pill is-day">{words}</span>
    </div>
  )
}

/** B-TH-229 / tw- W1.3 (P12): ONE band above the first new message; 200+ says so; its count also rides on the down button. */
export function UnreadRow({ count, t }: { count: number; t: Translate }): ReactNode {
  const words = count > 200 ? t('unread.lineMany') : t('unread.line', { count })
  return (
    <div className="fw-rt-unread" data-feed-new="" role="separator" aria-label={words}>
      <span className="fw-rt-pill is-unread">{words}</span>
    </div>
  )
}

/** The first read: skeleton bubbles, the list's own words for a screen reader (moved out of Feed as it was). */
export function FeedLoading(): ReactNode {
  const t = useT('record-thread-feed')
  return (
    <div className="fw-rt-feedwrap">
      <div className="fw-rt-state" aria-busy="true">
        <p className="fw-rt-sr" role="status">
          {t('state.loading')}
        </p>
        {[0, 1, 2].map((index) => (
          <div key={index} className="fw-rt-skel-card" aria-hidden="true">
            <span className="fw-rt-skel-row">
              <Skeleton width={24} height={24} radius="50%" />
              <Skeleton width={index === 1 ? 140 : 110} height={12} />
            </span>
            <Skeleton height={10} />
            <Skeleton width="70%" height={10} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** The read failed: said in the list's words, with Try again when the host can read again (moved out of Feed as it was). */
export function FeedFailed({ onRetry }: { onRetry?: (() => void) | undefined }): ReactNode {
  const t = useT('record-thread-feed')
  return (
    <div className="fw-rt-feedwrap">
      <div className="fw-rt-state is-center">
        <Banner tone="danger" title={t('state.error')} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('state.tryAgain')}</Button> : undefined}>
          {t('state.errorBody')}
        </Banner>
      </div>
    </div>
  )
}

/** No message yet (moved out of Feed as it was). */
export function FeedEmpty(): ReactNode {
  const t = useT('record-thread-feed')
  return (
    <div className="fw-rt-empty">
      {/* tw- fx2 (walk G-15; 10-design § 14): ONE line, "No messages yet" — the box below says how to write. */}
      <EmptyState icon={<MailOpen size={22} aria-hidden />} title={t('state.empty')} />
    </div>
  )
}
