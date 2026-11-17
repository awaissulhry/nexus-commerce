'use client'

import { ArrowRight, Inbox, ShoppingBag, Timer } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { LiveState, Loaded } from '../../model'
import { countText, type IncomingLineId, type IncomingToday } from '../model'
import '../../today.css'
import '../incoming.css'

const LINE_ICON: Readonly<Record<IncomingLineId, typeof Inbox>> = { NEW: Inbox, CATALOGUE_ORDERS: ShoppingBag, WAITING_US: Timer }

/**
 * B-TH-239 — Today › Incoming (design home.today `incoming`, picture 17; O-HOME-TODAY.incoming-F01 / F03): "New incoming requests ·
 * 5 · Open", "Catalogue orders to decide · 2", "Waiting on us over a working day · 3" — each the number Sales › Incoming's tile shows
 * (one read), each line a real link to Incoming at that tile. Offline: the last numbers with their as-of (the band says offline). It
 * draws ONE state; Today's container reads it (the design index passes it).
 */
export function IncomingSection({ state, now, live, onRetry }: { state: Loaded<IncomingToday>; now: number; live: LiveState; onRetry?: () => void }) {
  const t = useT('home')
  return (
    <section className="fw-today-section" aria-labelledby="fw-today-incoming">
      <div className="fw-today-head">
        <h2 id="fw-today-incoming" className="fw-today-h">
          {t('today.incoming.title')}
        </h2>
        {state.status === 'ready' && (
          <>
            <span className="fw-today-muted">{t(live === 'offline' ? 'today.incoming.offline' : 'today.incoming.sameAsIncoming')}</span>
            <AsOf at={state.data.asOf} now={now} />
          </>
        )}
      </div>
      {state.status === 'loading' ? (
        <div className="fw-today-incoming" aria-busy="true">
          <p className="fw-today-muted" role="status">
            {t('today.incoming.loading')}
          </p>
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : state.status === 'error' ? (
        <Banner tone="danger" title={t('today.incoming.error')} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('today.retry')}</Button> : undefined}>
          {t(state.problem)}
        </Banner>
      ) : (
        <ul className="fw-today-incoming" aria-label={t('today.incoming.title')}>
          {state.data.lines.map((line) => {
            const Icon = LINE_ICON[line.id]
            const count = countText(line)
            return (
              <li key={line.id}>
                <a className="fw-today-incoming-row" href={line.href} title={t(line.hint)} aria-label={t('today.incoming.lineLabel', { what: t(line.label), count })}>
                  <Icon size={16} className="fw-today-incoming-icon" aria-hidden />
                  <span className="fw-today-incoming-label">{t(line.label)}</span>
                  <span className={line.count !== null && line.count > 0 ? 'fw-today-incoming-count is-some' : 'fw-today-incoming-count'}>{count}</span>
                  <span className="fw-today-incoming-open">
                    {t('today.incoming.open')} <ArrowRight size={12} aria-hidden />
                  </span>
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
