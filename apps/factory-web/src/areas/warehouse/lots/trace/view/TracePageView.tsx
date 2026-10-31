'use client'

import Link from 'next/link'
import { FileX, GitBranch } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { PickerReason } from '../../../../_shared/reasons/api'
import type { StockCan } from '../../../../_shared/stock/model'
import { NoAccess } from '../../../../_shared/stock/parts'
import type { Direction, StartKind, Trace } from '../../../stock/daily/api'
import type { Loaded } from '../../shared/model'
import { LotsMessages, useWords } from '../../shared/parts'
import type { TraceFindModel } from '../model'
import { TraceDialog, type TraceFindActions } from '../TraceDialog'
import { TraceTree } from '../TraceTree'

/** SCR-201-trace — the trace of any record (a hide, a bundle, a work order, a garment, a shipment): one view model. */
export interface TracePageModel {
  prefix: string
  can: StockCan
  /** What the address names; null: nothing traceable in it. */
  start: { kind: StartKind; id: string; direction: Direction } | null
  trace: Loaded<Trace>
  holdReasons: readonly PickerReason[]
  asOf: string | null
  timeZone: string
  find: TraceFindModel | null
  /** Design cases: "Show only affected customers" on. */
  affectedOnly?: boolean
}

export interface TracePageActions {
  onRetry?: () => void
  onDirection?: (direction: Direction) => void
  onTraceAnother?: () => void
  find?: TraceFindActions
}

/**
 * Warehouse › Lots & traceability › Trace (SCR-201-trace; design warehouse.lots lt-trace: "the kind is recognised and the
 * trace opens on that node"): a record that is not a lot traced both ways (or one way), in the same tree as the lot
 * record's Trace tab — the levels with counts, the gaps in words, Came from and Went to, "Show only affected customers".
 * The band: back to Lots & traceability, what is traced, when it was read, the direction, and Trace another code….
 */
export function TracePageView({ model, actions }: { model: TracePageModel; actions?: TracePageActions }) {
  return (
    <LotsMessages>
      <TraceBody model={model} actions={actions} />
    </LotsMessages>
  )
}

function TraceBody({ model, actions }: { model: TracePageModel; actions?: TracePageActions }) {
  const t = useWords()
  const locale = useLocale()
  const back = <Link href={`${model.prefix}/warehouse/lots`}>{t('lt.back')}</Link>
  if (!model.can.stockView) {
    return (
      <div className="fw-st">
        <NoAccess permission="inventory.stock.view" />
      </div>
    )
  }
  const trace = model.trace.status === 'ready' ? model.trace.value : null
  const title = trace ? t('lt.tracePage.title', { kind: t(`lt.find.kind.${trace.start.kind}`), code: trace.start.code }) : model.trace.status === 'loading' && model.start ? <Skeleton width={260} height={22} /> : t('lt.tracePage.name')
  const another = (
    <Button size="sm" variant="primary" onClick={() => actions?.onTraceAnother?.()}>
      <GitBranch size={14} aria-hidden /> {t('lt.find.open')}
    </Button>
  )
  return (
    <div className="fw-st">
      <div className="fw-wl-band">
        <DetailHeader
          backAsChild
          backLabel={back}
          title={title}
          actions={
            <span className="fw-st-actions">
              {model.start && (
                <Select size="sm" aria-label={t('lt.tracePage.direction')} value={model.start.direction} onChange={(event) => actions?.onDirection?.(event.target.value as Direction)}>
                  {(['BOTH', 'BACKWARD', 'FORWARD'] as const).map((direction) => (
                    <option key={direction} value={direction}>
                      {t(`lt.tracePage.directions.${direction}`)}
                    </option>
                  ))}
                </Select>
              )}
              {another}
            </span>
          }
        />
        <div className="fw-wl-meta">
          <span className="fw-wl-hint">{t('lt.tracePage.hint')}</span>
          {trace && (
            <span className="fw-wl-status" role="status">
              {t('lt.tracePage.read', { time: formatTime(trace.asOf, { locale, timeZone: model.timeZone }) })}
            </span>
          )}
        </div>
      </div>
      {!model.start ? (
        <Card padded>
          <EmptyState icon={<FileX size={24} aria-hidden />} title={t('lt.tracePage.nothing')} description={t('lt.tracePage.nothingBody')} action={another} />
        </Card>
      ) : model.trace.status === 'loading' ? (
        <Card padded aria-busy="true">
          <p className="fw-wl-hint" role="status">
            <Spinner size={14} /> {t('lt.tracePage.loading')}
          </p>
        </Card>
      ) : model.trace.status === 'not_found' ? (
        <Card padded>
          <EmptyState icon={<FileX size={24} aria-hidden />} title={t('lt.tracePage.notFound')} description={t('lt.tracePage.notFoundBody')} action={another} />
        </Card>
      ) : model.trace.status === 'forbidden' ? (
        <NoAccess permission="inventory.stock.view" />
      ) : model.trace.status === 'error' ? (
        <Card padded>
          <EmptyState
            title={t('lt.tree.failed')}
            description={t(`stock:${model.trace.problem}`)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('rec.retry')}
              </Button>
            }
          />
        </Card>
      ) : trace ? (
        <Card padded>
          <TraceTree trace={trace} prefix={model.prefix} holdReasons={model.holdReasons} affectedOnly={model.affectedOnly} />
        </Card>
      ) : null}
      {model.find && <TraceDialog model={model.find} actions={actions?.find} />}
    </div>
  )
}
