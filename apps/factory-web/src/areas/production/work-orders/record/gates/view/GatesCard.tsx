'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag, type Tone } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { gateRowsOf, waitingGates, type GateState } from '../model'
import type { GatesPart } from '../use-gates'

const NS = 'planning-milestones'
const STATE_TONE: Readonly<Record<GateState, Tone>> = { DONE: 'success', WAITING: 'warning', STARTED_BEFORE: 'info', TO_COME: 'neutral' }

/**
 * F-PR-05a — Gates & readiness on the work order's Overview (06-tree A.4 O-WO-gates): the gates of its order(s) with their state,
 * planner, target, the day passed and how late (Time & action's own words), each gate a door to it in Planning › Time & action; under
 * them the material readiness line (the page passes it) with a door to the Materials tab. Drawn only with planning.view.
 */
export function GatesCard({ part, prefix, readiness, materialsHref, onRetry }: { part: GatesPart; prefix: string; readiness: ReactNode; materialsHref: string; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[NS]}>
      <Gates part={part} prefix={prefix} readiness={readiness} materialsHref={materialsHref} onRetry={onRetry} />
    </WithMessages>
  )
}

function Gates({ part, prefix, readiness, materialsHref, onRetry }: { part: GatesPart; prefix: string; readiness: ReactNode; materialsHref: string; onRetry?: () => void }) {
  const t = useT('production')
  const tm = useT(NS)
  const locale = useLocale()
  const day = (value: string | null) => (value ? formatDate(`${value}T12:00:00Z`, { locale }) : '—')
  const rows = part.value ? gateRowsOf(part.value, prefix) : null
  const waiting = rows ? waitingGates(rows) : 0
  const many = rows ? new Set(rows.map((row) => row.orderNumber)).size > 1 : false
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('gates.title')}</h2>
        {rows && rows.length > 0 && <Tag tone={waiting > 0 ? 'warning' : 'success'}>{waiting > 0 ? t('gates.waiting', { count: waiting }) : t('gates.allPassed')}</Tag>}
      </div>
      {part.problem ? (
        <EmptyState
          title={t('gates.failed')}
          description={t(part.problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      ) : !rows ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('gates.loading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="fw-pr-hint">{t('gates.none')}</p>
      ) : (
        <SummaryTable
          label={t('gates.title')}
          stackOnPhone
          columns={[t('gates.gate'), tm('col.state'), tm('col.owner'), tm('col.target'), tm('col.actual'), tm('col.late')]}
          rows={rows.map((row) => ({
            id: row.id,
            cells: [
              <Link key="gate" className="fw-pr-link" href={row.href}>
                {many ? `${row.orderNumber} · ` : ''}
                {row.kind === 'OTHER' && row.label ? row.label : tm(`kind.${row.kind}`)}
              </Link>,
              <Pill key="state" tone={STATE_TONE[row.state]}>
                {tm(`state.${row.state}`)}
              </Pill>,
              row.owner ?? '—',
              day(row.target),
              day(row.actual),
              row.late === null || row.late <= 0 ? tm('late.onTime') : row.state === 'DONE' ? tm('late.doneLate', { count: row.late }) : tm('late.late', { count: row.late }),
            ],
          }))}
        />
      )}
      {readiness}
      <p className="fw-pr-hint">
        <Link className="fw-pr-link" href={materialsHref}>
          {t('gates.materials')}
        </Link>
      </p>
    </Card>
  )
}
