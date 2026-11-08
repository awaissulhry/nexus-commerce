'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { EmptyState, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantityText } from '../../../_shared/model'
import type { Cutboard } from '../api'
import { boardTiles, cutOrderHref, materialText, oneUnit, pctWords, progressPhrase, signedPct, workOrderCuttingHref, CUTBOARD_NAMESPACE, type Phrase } from '../model'
import type { CuttingRead } from '../use-cutting-room'
import '../cutting-room.css'

/** Floor now's Cutting room (SCR-073 fn-cutting): one board per site of the scope; the panel fetches nothing. */
export interface CuttingRoomModel {
  readonly prefix: string
  readonly read: CuttingRead
  /** Production › Cutting room › Cutting, when built and the person may open it (null: no link drawn). */
  readonly cuttingHref: string | null
}

export interface CuttingRoomActions {
  onRetry?: () => void
}

const TONE_ACCENT = { neutral: undefined, warning: 'var(--nds-warning)', danger: 'var(--nds-danger)' } as const

/**
 * SCR-073 fn-cutting — Cutting room (B-W2b-130; design production.floor "Cutting room": "Cut orders waiting, in progress, cut vs
 * plan today, hides used and yield today (MES-163); no cutter names"; MetricStrip + small list; → Cutting). Per site: the tiles
 * (waiting, cutting now, cut against plan today, hides used, yield, fabric used, late), the leather of each area unit when there
 * are several, and the open cut orders, cutting first (a number opens the cut order, a work order its Cutting tab). Totals per cut
 * order, lay, hide and site only: nobody who spread, cut or counted (Statuto dei Lavoratori art. 4).
 */
export function CuttingRoomPanel({ model, actions }: { model: CuttingRoomModel; actions?: CuttingRoomActions }) {
  const t = useT(CUTBOARD_NAMESPACE)
  const tp = useT('production')
  const boards = model.read.value
  return (
    <section className="fw-cr" aria-labelledby="fw-cr-title" id="fn-cutting">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2" id="fw-cr-title">
          {t('board.title')}
        </h2>
        <span className="fw-cr-head-right">
          <span className="fw-pr-hint">{t('board.privacy')}</span>
          {model.cuttingHref && (
            <Link className="fw-pr-link fw-cr-go" href={model.cuttingHref}>
              {t('board.openCutting')} <ArrowRight size={14} aria-hidden />
            </Link>
          )}
        </span>
      </div>
      {model.read.problem ? (
        <EmptyState title={t('board.failed')} description={tp(model.read.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('board.retry')}</Button>} />
      ) : !boards ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('board.loading')}
        </p>
      ) : boards.length === 0 ? (
        <p className="fw-pr-hint">{t('board.noSite')}</p>
      ) : (
        boards.map((board) => <SiteBoard key={board.site.id} board={board} prefix={model.prefix} showSite={boards.length > 1} cuttingHref={model.cuttingHref} />)
      )}
    </section>
  )
}

function SiteBoard({ board, prefix, showSite, cuttingHref }: { board: Cutboard; prefix: string; showSite: boolean; cuttingHref: string | null }) {
  const t = useT(CUTBOARD_NAMESPACE)
  const locale = useLocale()
  const say = (words: Phrase | null) => (words ? t(words.key, words.params) : undefined)
  const tiles = boardTiles(board, locale)
  const several = oneUnit(board.leather) === null && board.leather.length > 1
  const open = board.orders.length + board.more
  return (
    <div className="fw-cr-site" aria-label={showSite ? t('board.siteLabel', { site: `${board.site.code} · ${board.site.name}` }) : undefined}>
      {showSite && <h3 className="fw-pr-h3">{`${board.site.code} · ${board.site.name}`}</h3>}
      <span className="fw-pr-hint" role="status">
        {t(board.day === board.today ? 'board.asOfToday' : 'board.asOfDay', { time: formatTime(board.asOf, { locale }), day: formatDate(`${board.day}T12:00:00Z`, { locale }) })}
      </span>
      <MetricStrip
        minTileWidth={170}
        metrics={tiles.map((tile) => ({
          label: t(tile.label.key, tile.label.params),
          value: tile.value,
          hint: say(tile.hint),
          ...(TONE_ACCENT[tile.tone] ? { accent: TONE_ACCENT[tile.tone] } : {}),
        }))}
      />
      {several && (
        <ul className="fw-cr-units" aria-label={t('board.unitsLabel')}>
          {board.leather.map((row) => (
            <li key={row.uom}>
              {t('board.unitRow', {
                uom: row.uom,
                count: row.hides,
                area: quantityText(row.used, locale),
                yield: pctWords(row.yieldPct, locale),
                variance: signedPct(row.variancePct, locale),
              })}
            </li>
          ))}
        </ul>
      )}
      {board.lays.waitingFabric > 0 && <p className="fw-pr-hint">{t('board.waitingFabric', { count: board.lays.waitingFabric })}</p>}
      {open === 0 ? (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.emptyBody')}
          action={
            cuttingHref ? (
              <Button size="sm" asChild>
                <Link href={cuttingHref}>{t('list.emptyAction')}</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <SummaryTable
            label={t('list.label')}
            stackOnPhone
            columns={[t('col.cutOrder'), t('col.material'), t('col.garments'), t('col.progress'), t('col.due'), t('col.workOrders')]}
            widths={['16%', '22%', '10%', '18%', '14%', undefined]}
            align={[undefined, undefined, 'right', undefined, undefined, undefined]}
            rows={board.orders.map((row) => {
              const progress = progressPhrase(row)
              return {
                id: row.id,
                cells: [
                  <Link key="n" className="fw-pr-link" href={cutOrderHref(prefix, row)}>
                    {row.number}
                  </Link>,
                  <span key="m" className="fw-pr-cell">
                    <span className="fw-pr-ellipsis">{materialText(row)}</span>
                    <span className="nds-summary-sub">{t(`kind.${row.kind}`)}</span>
                  </span>,
                  String(row.garments),
                  <span key="p" className="fw-pr-inline">
                    <Tag tone={row.status === 'IN_PROGRESS' ? 'info' : 'neutral'}>{t(`status.${row.status}`)}</Tag>
                    {progress.key !== `status.${row.status}` && <span>{t(progress.key, progress.params)}</span>}
                  </span>,
                  <span key="d" className="fw-pr-inline">
                    {row.dueDate ? formatDate(`${row.dueDate}T12:00:00Z`, { locale }) : t('row.noDue')}
                    {row.late && <Tag tone="danger">{t('row.late')}</Tag>}
                  </span>,
                  <span key="w" className="fw-cr-wos">
                    {row.workOrders.map((workOrder) => (
                      <Link key={workOrder.id} className="fw-pr-link" href={workOrderCuttingHref(prefix, workOrder.id)}>
                        {workOrder.number}
                      </Link>
                    ))}
                  </span>,
                ],
              }
            })}
          />
          {board.more > 0 && (
            <p className="fw-pr-hint">
              {cuttingHref ? (
                <Link className="fw-pr-link" href={cuttingHref}>
                  {t('list.more', { count: board.more })}
                </Link>
              ) : (
                t('list.moreNoPage', { count: board.more })
              )}
            </p>
          )}
        </>
      )}
    </div>
  )
}
