'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { money, quantity } from '../../../_shared/stock/model'
import { amountText, groupHref, groupLabel, neighbourOf, orderHref } from '../model'
import { Failed, Shape } from './SpendPanel'
import type { ReportsActions, ReportsModel } from './types'

/**
 * POs behind this bar (design purchasing.reports pop drill, a detail modal from a bar: "The PO lines that make the number"; keys
 * J / K): the group's figures, then every purchase order line counted in it — the order (its page), the line, the day it was
 * placed, production or sample order, the material, the quantity and, with the cost grain, its spend (a line closed short says it
 * counts what came). J / K (and the buttons) open the next and the previous bar. The primary is the group's own page where one
 * shows these lines (the supplier, the material); otherwise it is held with its reason (no list filters by category, company or
 * month yet). Export writes the lines as a CSV file.
 */
export function DrillDialog({ model, actions }: { model: ReportsModel; actions?: ReportsActions | undefined }) {
  const t = useT('purchasing-reports')
  const wr = useT('warehouse-reports')
  const stock = useT('stock')
  const locale = useLocale()
  const drill = model.drill
  if (!drill) return null
  const by = model.address.by
  const groups = model.spend.status === 'ready' ? model.spend.value.groups : []
  const group = groups.find((entry) => entry.key === drill.key)
  const answer = drill.read.status === 'ready' ? drill.read.value : null
  const name = groupLabel(group ?? { key: drill.key, code: answer?.code ?? null, name: answer?.name ?? drill.key }, by, { category: (kind) => wr(`type.${kind}`), locale })
  const cost = model.can.cost && (answer?.sight.values ?? true)
  const next = neighbourOf(groups, drill.key, 1)
  const previous = neighbourOf(groups, drill.key, -1)
  const home = groupHref(model.prefix, by, drill.key)
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select')) return
    if ((event.key === 'j' || event.key === 'J') && next) {
      event.preventDefault()
      actions?.onDrill?.(next)
    } else if ((event.key === 'k' || event.key === 'K') && previous) {
      event.preventDefault()
      actions?.onDrill?.(previous)
    }
  }
  const header = [t('drill.col.order'), t('drill.col.line'), t('drill.col.placed'), t('drill.col.kind'), t('drill.col.supplier'), t('drill.col.material'), t('drill.col.colour'), t('drill.col.quantity'), t('drill.col.unit'), ...(cost ? [t('drill.col.spend')] : [])]
  const footer = (
    <>
      <Button size="sm" onClick={() => previous && actions?.onDrill?.(previous)} heldReason={previous ? null : t('drill.first')} aria-keyshortcuts="k">
        <ChevronLeft size={14} aria-hidden /> {t('drill.previous')}
      </Button>
      <Button size="sm" onClick={() => next && actions?.onDrill?.(next)} heldReason={next ? null : t('drill.last')} aria-keyshortcuts="j">
        {t('drill.next')} <ChevronRight size={14} aria-hidden />
      </Button>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onDrillExport?.(header, { kind: (kind) => t(`kind.${kind}`), locale, cost })} heldReason={answer && answer.lines.length > 0 ? null : t('drill.exportHeld')}>
        <Download size={14} aria-hidden /> {t('drill.export')}
      </Button>
      {home ? (
        <Button size="sm" variant="primary" asChild>
          <Link href={home}>{t(`drill.open.${by}`)}</Link>
        </Button>
      ) : (
        <Button size="sm" variant="primary" heldReason={t('drill.openHeld')}>
          {t('drill.openList')}
        </Button>
      )}
    </>
  )
  return (
    <Modal open onClose={() => actions?.onDrill?.(null)} title={t('drill.title', { name })} subtitle={t('drill.subtitle', { from: day(model.range.from), to: day(model.range.to) })} size="xxl" footer={footer}>
      <div className="fw-pr-drill" onKeyDown={onKeyDown}>
        {drill.read.status === 'loading' || drill.read.status === 'idle' ? <Shape chart={false} /> : null}
        {drill.read.status === 'error' ? <Failed title={t('drill.failed')} problem={drill.read.problem} onRetry={actions?.onDrillRetry} /> : null}
        {answer ? (
          <>
            <KeyValue
              columns={3}
              items={[
                ...(cost
                  ? [
                      { label: t('spend.kv.production'), value: amountText(answer.figures, 'production', locale) },
                      { label: t('spend.kv.samples'), value: amountText(answer.figures, 'samples', locale), hint: t('spend.kv.samplesHint') },
                    ]
                  : []),
                { label: t('spend.kv.orders'), value: String(answer.figures.orders), hint: t('spend.kv.lines', { count: answer.figures.lines }) },
              ]}
            />
            {answer.lines.length === 0 ? (
              <EmptyState title={t('drill.empty')} description={t('drill.emptyHint')} />
            ) : (
              <SummaryTable
                label={t('drill.tableLabel', { name })}
                stackOnPhone
                columns={[t('drill.col.order'), t('drill.col.placed'), t('drill.col.kind'), ...(by === 'supplier' ? [] : [t('drill.col.supplier')]), t('drill.col.material'), t('drill.col.quantity'), ...(cost ? [t('drill.col.spend')] : [])]}
                align={[undefined, undefined, undefined, ...(by === 'supplier' ? [] : [undefined]), undefined, 'right', ...(cost ? (['right'] as const) : [])]}
                widths={['18%']}
                rows={answer.lines.map((line) => ({
                  id: line.lineId,
                  cells: [
                    <span key="o" className="fw-pr-cell">
                      <Link className="fw-pr-link" href={orderHref(model.prefix, line.purchaseOrderId, line.number)}>
                        {t('late.line', { number: line.number, seq: line.seq })}
                      </Link>
                      <span className="fw-pr-muted">{t(`status.${line.status}`)}</span>
                    </span>,
                    day(line.placedOn),
                    <Tag key="k" tone={line.kind === 'samples' ? 'info' : 'neutral'}>
                      {t(`kind.${line.kind}`)}
                    </Tag>,
                    ...(by === 'supplier' ? [] : [`${line.supplier.code} · ${line.supplier.name}`]),
                    <span key="m" className="fw-pr-cell">
                      <span>{`${line.item.code} · ${line.item.name}`}</span>
                      {line.colour ? <span className="fw-pr-muted">{line.colour.name}</span> : null}
                    </span>,
                    <span key="q" className="fw-pr-cell">
                      <span>{`${quantity(line.quantity, locale)} ${stock(`uom.${line.uom}`)}`}</span>
                      {line.ended === 'CLOSED_SHORT' ? <span className="fw-pr-muted">{t('drill.closedShort')}</span> : null}
                    </span>,
                    ...(cost ? [money(line.spend ?? null, line.currency, locale)] : []),
                  ],
                }))}
              />
            )}
            <p className="fw-pr-muted">{[answer.more > 0 ? t('drill.more', { count: answer.more }) : null, t('drill.keys'), cost ? null : t('spend.noCost')].filter(Boolean).join(' ')}</p>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
