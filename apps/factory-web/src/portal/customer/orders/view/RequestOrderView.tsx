'use client'

import { useRef, type ReactNode } from 'react'
import { AlertCircle, Clock, FileText } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Fact, FactCols, Headline, Overview, OverviewCard } from '../../../../lib/record-overview/Overview'
import { TabLink } from '../../../../lib/tab-link/TabLink'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useActiveTabInView } from '../../../shell/view/active-tab'
import { usePageWords } from '../page-words'
import { quietLineOf, type RequestFrame, type RequestTab, type requestFilesOf } from '../request-record'
import '../orders.css'

/**
 * owb-po5.2 (lead settle 2) — a Draft or Sent order (a request) in the order's frame: the band is the frame's (the page fills it), this
 * view draws the SAME tab row as an order — Overview · Lines · Money (price grain only) · Shipments · Files — and each tab:
 *   Overview   Where your order is (draft / sent, the next step) · Asks & changes ("All changes" opens the ONE log) · Order facts
 *   Lines      round 1: where its lines change (the order window while a draft; "Take it back to change it" once sent) — owb-po6.1
 *              draws the ONE lines table here
 *   Money, Shipments   ONE quiet line before the factory confirms ("Money starts when the factory confirms the order.")
 *   Files      the order's files by kind (a mockup, a size file, another file), names only
 * Never an office series (no number before Confirm), never a worker, never a price without the grain.
 */

export interface RequestOrderViewModel {
  state: 'loading' | 'error' | 'ready'
  frame: RequestFrame | null
  tab: RequestTab
  /** `/p/<party>/orders/requests/<id>` — the tabs' address. */
  href: string
  files: ReturnType<typeof requestFilesOf>
  /** A just-done act or a refusal, in our words. */
  notice: { tone: 'success' | 'warning' | 'danger'; text: string } | null
  /** While a draft: the order window's address (its lines change there). */
  draftHref: string | null
  /** owb-po6.1: the ONE lines table (the page builds it); absent: round 1's line. */
  lines?: ReactNode
}

export interface RequestOrderActions {
  onRetry?: () => void
  onChanges?: () => void
  onDismissNotice?: () => void
}

function RequestTabs({ label, tabs, active }: { label: string; tabs: TabItem[]; active: string }) {
  const root = useRef<HTMLDivElement>(null)
  useActiveTabInView(root, `${active}:${tabs.length}`)
  return (
    <div ref={root} className="fw-pord-tabs">
      <Tabs ariaLabel={label} tabs={tabs} active={active} size="sm" overflow="scroll" linkAs={TabLink} />
    </div>
  )
}

export function RequestOrderView({ model, actions }: { model: RequestOrderViewModel; actions?: RequestOrderActions }) {
  const t = usePageWords()
  const locale = useLocale()
  if (model.state === 'loading') return <div className="fw-pord" aria-busy="true" />
  if (model.state === 'error' || !model.frame) {
    return (
      <div className="fw-pord">
        <EmptyState icon={<AlertCircle size={24} aria-hidden />} title={t('request.failed')} description={t('request.failedBody')} action={<Button onClick={() => actions?.onRetry?.()}>{t('request.retry')}</Button>} />
      </div>
    )
  }
  const frame = model.frame
  const tabHref = (tab: RequestTab) => `${model.href}?tab=${tab}`
  const tabs: TabItem[] = [
    { id: 'overview', label: t('tabs.overview'), href: tabHref('overview') },
    { id: 'lines', label: t('tabs.lines'), count: frame.lines, href: tabHref('lines') },
    ...(frame.seesPrices ? [{ id: 'money', label: t('tabs.money'), href: tabHref('money') }] : []),
    { id: 'shipments', label: t('tabs.shipments'), count: 0, href: tabHref('shipments') },
    { id: 'files', label: t('tabs.files'), count: model.files.reduce((sum, group) => sum + group.files.length, 0), href: tabHref('files') },
  ]
  const day = (iso: string | null) => (iso ? formatDate(iso, { locale }) : t('facts.none'))
  const quiet = quietLineOf(model.tab)
  const draft = frame.status === 'DRAFT'
  // The overview kit loads its own words for its cards: every word is ours, made here.
  const where = draft ? t('request.where.draft') : t('request.where.sent')
  const next = draft ? t('request.next.draft') : t('request.next.sent')
  const facts = [
    { id: 'subject', label: t('facts.subject'), value: frame.subject ?? t('facts.none') },
    { id: 'ref', label: t('facts.ref'), value: frame.customerRef ?? t('facts.none') },
    { id: 'wanted', label: t('facts.wanted'), value: day(frame.wanted) },
    { id: 'lines', label: t('facts.lines'), value: t('facts.linesPieces', { lines: frame.lines, pieces: frame.pieces }) },
    ...(frame.sentAt ? [{ id: 'sent', label: t('facts.sent'), value: day(frame.sentAt) }] : []),
  ]
  return (
    <div className="fw-pord">
      <RequestTabs label={t('tabs.label')} tabs={tabs} active={model.tab} />
      {model.notice ? (
        <Banner
          tone={model.notice.tone}
          title={model.notice.text}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('notice.hide')}
            </Button>
          }
        />
      ) : null}
      {model.tab === 'overview' ? (
        <Overview>
          <OverviewCard title={t('where.title')} lead>
            <Headline sentence={where} quiet={next} />
          </OverviewCard>
          <OverviewCard
            title={t('asks.title')}
            aside={
              <Button size="sm" variant="quiet" onClick={() => actions?.onChanges?.()}>
                <Clock size={14} aria-hidden /> {t('asks.all')}
              </Button>
            }
          >
            <p className="fw-pord-quiet">{t('asks.none')}</p>
          </OverviewCard>
          <OverviewCard title={t('facts.title')}>
            <FactCols>
              {facts.map((fact) => (
                <Fact key={fact.id} label={fact.label} value={fact.value} door={null} />
              ))}
            </FactCols>
          </OverviewCard>
        </Overview>
      ) : null}
      {model.tab === 'lines'
        ? (model.lines ?? (
            <Card padded>
              <p className="fw-pord-quiet">{draft ? t('request.lines.draft') : t('request.lines.sent')}</p>
              {draft && model.draftHref ? (
                <Button asChild size="sm">
                  <a href={model.draftHref}>{t('request.lines.open')}</a>
                </Button>
              ) : null}
            </Card>
          ))
        : null}
      {quiet ? (
        <Card padded>
          <p className="fw-pord-quiet">{t(quiet)}</p>
        </Card>
      ) : null}
      {model.tab === 'files' ? (
        model.files.length > 0 ? (
          <Card padded>
            {model.files.map((group) => (
              <section key={group.kind} className="fw-pord-section" aria-label={t(`files.kind.${group.kind}`)}>
                <h3 className="fw-pord-h3">{t(`files.kind.${group.kind}`)}</h3>
                <ul className="fw-pord-files">
                  {group.files.map((file) => (
                    <li key={file.id}>
                      <FileText size={14} aria-hidden /> {file.name ?? t('files.locked')}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </Card>
        ) : (
          <Card padded>
            <p className="fw-pord-quiet">{t('files.none')}</p>
          </Card>
        )
      ) : null}
    </div>
  )
}
