'use client'

import Link from 'next/link'
import { Newspaper } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { statusKey } from '../../../../../search/model'
import { NS } from '../../../model'
import { RECORD_NS, type NewsLine } from '../../model'

/**
 * B-TH-249 (PROJ.linked-F08, B-TH-072) — "News of linked records": the linked records' status moves and decisions, merged when read
 * (asked only, never in the thread's default feed; never copied into the project's thread). One line per record per day: the record
 * as a real link, its move in words (the search's status words; a code without words shows no status), who moved it (an office
 * person) and the day, "+N more that day". Only records the reader may open come back from the API (W38). Never a value.
 */
export interface LinkedNewsModel {
  /** The person asked for the news (until then only the button). */
  readonly asked: boolean
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** Each line with its record's address in this Office (company prefix included). */
  readonly lines: readonly (NewsLine & { readonly href: string })[]
  readonly more: boolean
  readonly moreBusy: boolean
  /** A key of the shared catalogue. */
  readonly problem: string | null
}

export interface LinkedNewsActions {
  onAsk?: () => void
  onMore?: () => void
  onRetry?: () => void
  onHide?: () => void
}

export function LinkedNewsCard({ model, actions }: { model: LinkedNewsModel; actions?: LinkedNewsActions }) {
  const t = useT(RECORD_NS)
  const shared = useT(NS)
  const words = useT('search')
  const locale = useLocale()
  const status = (code: string | null): string | null => {
    const key = statusKey(code)
    return key ? words(key) : null
  }
  const move = (line: NewsLine): string => {
    const from = status(line.from)
    const to = status(line.to)
    if (from && to) return t('news.move', { from, to })
    if (to) return t('news.moveTo', { to })
    if (line.from === null && line.to === null) return t('news.decision')
    return t('news.changed')
  }
  return (
    <Card
      className="fw-prjr-section"
      header={t('news.title')}
      headingLevel={2}
      headerAction={
        model.asked ? (
          <Button size="sm" variant="quiet" onClick={() => actions?.onHide?.()}>
            {t('news.hide')}
          </Button>
        ) : undefined
      }
    >
      <div className="fw-prjr-section-body">
        {!model.asked ? (
          <>
            <p className="fw-prjr-hint">{t('news.intro')}</p>
            <span>
              <Button size="sm" onClick={() => actions?.onAsk?.()}>
                <Newspaper size={14} aria-hidden /> {t('news.ask')}
              </Button>
            </span>
          </>
        ) : model.status === 'loading' ? (
          <>
            <Skeleton height={18} />
            <Skeleton height={18} />
          </>
        ) : model.status === 'error' ? (
          <Banner
            tone="danger"
            title={shared(model.problem ?? 'problem.unavailable')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {shared('common.retry')}
              </Button>
            }
          />
        ) : model.lines.length === 0 ? (
          <p className="fw-prjr-hint">{t('news.none')}</p>
        ) : (
          <>
            <ul className="fw-prjr-list">
              {model.lines.map((line) => (
                <li key={line.id} className="fw-prjr-item">
                  <span className="fw-prjr-item-main">
                    <Link href={line.href}>{line.label}</Link>
                    <span className="fw-prjr-item-meta">
                      {move(line)}
                      {line.actor ? ` · ${t('news.by', { name: line.actor })}` : ''}
                      {line.more > 0 ? ` · ${t('news.more', { count: line.more })}` : ''}
                    </span>
                  </span>
                  <span className="fw-prjr-item-side fw-prjr-item-meta">
                    <time dateTime={line.at}>{formatDate(line.at, { locale })}</time>
                  </span>
                </li>
              ))}
            </ul>
            {model.more && (
              <span>
                <Button size="sm" variant="quiet" heldReason={model.moreBusy ? shared('common.working') : null} onClick={() => actions?.onMore?.()}>
                  {t('news.showMore')}
                </Button>
              </span>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
