'use client'

import { ArrowLeft } from 'lucide-react'
import { Banner, Disclosure, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import { INPUT_COUNTS, type RunLog } from '../api'
import { DEPTH_NAMESPACE, LOG_MAIN_COUNTS, logCounts, type DepthActions, type DepthModel } from '../model'

/**
 * Run history › a run's log (design planning.mrp pop:run-log "Per run: inputs snapshot and warnings", W2b; PLN-095 on
 * GET /planning/runs/:runId/log): what the run read (its day and zone, every level or one, the size-run rule, and each
 * count), its warnings by kind, the proposals it made (lines to buy or make, planned work and subcontract orders) and its
 * action messages. A run from before the log says its inputs were not recorded. Our words from the numbers; no money,
 * no person.
 */
export function RunLogPanel({ model, actions, timeZone }: { model: DepthModel; actions?: DepthActions; timeZone?: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const open = model.log
  if (!open) return null
  const loaded = open.log
  return (
    <div className="fw-mrd-stack" aria-live="polite">
      <div className="fw-mrd-head">
        <Button size="sm" variant="quiet" onClick={() => actions?.onLog?.(null)}>
          <ArrowLeft size={13} aria-hidden /> {t('log.back')}
        </Button>
      </div>
      {loaded.status === 'loading' ? (
        <p className="fw-mrd-hint" role="status">
          <Spinner size={14} /> {t('log.reading')}
        </p>
      ) : loaded.status === 'ready' ? (
        <LogBody log={loaded.value} timeZone={timeZone} />
      ) : (
        <EmptyState title={t('log.failed')} description={t(loaded.status === 'error' ? loaded.problem : loaded.status === 'not_found' ? 'problem.gone' : 'problem.noRead')} action={<Button size="sm" onClick={() => actions?.onLog?.(open.runId)}>{t('retry')}</Button>} />
      )}
    </div>
  )
}

function LogBody({ log, timeZone }: { log: RunLog; timeZone?: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const tb = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone }
  const day = (value: string) => formatDate(dayAt(value), place)
  const inputs = log.inputs
  const counts = logCounts(log)
  const rest = INPUT_COUNTS.filter((key) => !(LOG_MAIN_COUNTS as readonly string[]).includes(key))
  return (
    <div className="fw-mrd-stack">
      <h3 className="fw-mrd-h3">{t('log.title', { time: formatDateTime(log.run.startedAt, place), trigger: tb(`plan.trigger.${log.run.trigger}`) })}</h3>
      {inputs ? (
        <>
          <KeyValue
            dense
            columns={3}
            labelCase="sentence"
            items={[
              { label: t('log.runDay'), value: t('log.runDayValue', { day: day(inputs.runDate), zone: inputs.timezone }) },
              { label: t('log.explosionLabel'), value: t(`log.explosion.${inputs.explosion}`, { count: inputs.passes }) },
              { label: t('log.sizeRun'), value: inputs.sizeRunRule === 'SIZE_GROUPS' ? t('log.sizeGroups', { count: inputs.sizeGroups }) : t('log.oneGrid') },
              ...LOG_MAIN_COUNTS.map((key) => ({ label: t(`log.count.${key}`), value: String(inputs.counts[key]) })),
            ]}
          />
          <Disclosure summary={t('log.everyCount')}>
            <KeyValue dense columns={3} labelCase="sentence" items={rest.map((key) => ({ label: t(`log.count.${key}`), value: String(inputs.counts[key]) }))} />
          </Disclosure>
        </>
      ) : (
        <Banner tone="info" title={t('log.notRecorded')} />
      )}
      <div className="fw-mrd-cols">
        <div className="fw-mrd-stack">
          <h3 className="fw-mrd-h3">{t('log.warnings', { count: log.warningCounts.reduce((sum, entry) => sum + entry.count, 0) })}</h3>
          {log.warningCounts.length === 0 ? (
            <p className="fw-mrd-hint">{t('log.noWarnings')}</p>
          ) : (
            <ul className="fw-mrd-list">
              {log.warningCounts.map((entry) => (
                <li key={entry.code}>{tb(`plan.warning.${entry.code}`, { count: entry.count })}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="fw-mrd-stack">
          <h3 className="fw-mrd-h3">{t('log.proposed')}</h3>
          <ul className="fw-mrd-list">
            <li>{t('log.proposedBuy', { count: counts.buy })}</li>
            <li>{t('log.proposedMake', { count: counts.make })}</li>
            <li>{t('log.proposedPlanned', { count: counts.plannedMake })}</li>
            <li>{t('log.proposedSubcontract', { count: counts.plannedSubcontract })}</li>
            <li>{t('log.messages', { open: log.actionMessages.open, done: log.actionMessages.done, ignored: log.actionMessages.ignored })}</li>
          </ul>
        </div>
      </div>
      {log.proposals.requirements.length > 0 && (
        <SummaryTable
          label={t('log.linesTable')}
          density="compact"
          stackOnPhone
          columns={[t('log.col.action'), t('log.col.material'), t('log.col.short'), t('log.col.need'), t('log.col.decision')]}
          align={['left', 'left', 'right', 'left', 'left']}
          rows={log.proposals.requirements.map((line) => ({
            id: line.id,
            cells: [
              tb(`plan.action.${line.action}`),
              [line.item.code, line.colour?.code].filter(Boolean).join(' '),
              `${quantity(line.netQuantity, locale, 4)} ${tb(`uom.${line.uom}`)}`,
              day(line.needDate),
              <span key="decision" className="fw-mrd-inline">
                <span>{t(`log.decision.${line.decision}`)}</span>
                {line.firm && <Pill tone="info">{t('state.firm')}</Pill>}
                {line.orderSpecific && <Pill tone="neutral">{t('log.forOrder', { number: line.orderSpecific.orderNumber, line: line.orderSpecific.lineSeq })}</Pill>}
              </span>,
            ],
          }))}
        />
      )}
      {log.proposals.plannedOrders.length > 0 && (
        <SummaryTable
          label={t('log.plannedTable')}
          density="compact"
          stackOnPhone
          columns={[t('log.col.kind'), t('log.col.style'), t('log.col.pieces'), t('log.col.dates'), t('log.col.state')]}
          align={['left', 'left', 'right', 'left', 'left']}
          rows={log.proposals.plannedOrders.map((row) => ({
            id: row.id,
            cells: [
              t(`kind.${row.kind}`),
              row.label,
              String(row.quantity),
              t('log.dates', { start: day(row.startDate), due: day(row.dueDate), need: day(row.needDate) }),
              <span key="state" className="fw-mrd-inline">
                <span>{t(`log.status.${row.status}`)}</span>
                {row.firm && <Pill tone="info">{t('state.firm')}</Pill>}
                {row.protectedFields.length > 0 && <Pill tone="warning">{t('state.protected', { count: row.protectedFields.length })}</Pill>}
              </span>,
            ],
          }))}
        />
      )}
    </div>
  )
}
