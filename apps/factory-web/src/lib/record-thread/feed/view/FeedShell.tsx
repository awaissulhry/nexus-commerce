'use client'

import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
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
