'use client'

import { Printer } from 'lucide-react'
import { EmptyState, KeyValue } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { gridCopyOf } from '../../../../lib/jobs/grid'
import type { Job } from '../api'
import { operationGrid } from '../model'
import { useJobWords } from '../words'
import '../jobs.css'

/**
 * The job sheet for the bench (design portal.supplier.jobs tab:job-sheet "Job sheet PDF — printed for the bench"): the job
 * on one sheet of paper — who sends it, the operations with their pieces per size, the style, the kit we sent with our
 * DDT, the day it is due back, our notes —, opened in a new tab and printed by the browser (or saved as a PDF). Never a
 * price (C2). The print hides everything but the sheet.
 */
export interface SheetViewModel {
  state: 'loading' | 'error' | 'ready'
  job: Job | null
}

export function SheetView({ model, onRetry }: { model: SheetViewModel; onRetry?: () => void }) {
  const { t, day, quantity, locale } = useJobWords()
  if (model.state === 'loading') return <Skeleton height={320} />
  if (model.state === 'error' || !model.job) return <EmptyState title={t('record.failed')} action={<Button onClick={() => onRetry?.()}>{t('state.retry')}</Button>} />
  const job = model.job
  const pieces = job.operations.reduce((sum, operation) => sum + operation.pieces, 0)
  return (
    <div className="fw-pjob">
      <div className="fw-pjob-actions fw-pjob-noprint">
        <Button variant="primary" onClick={() => window.print()}>
          <Printer size={16} aria-hidden /> {t('sheet.print')}
        </Button>
      </div>
      <article className="fw-pjob-sheet" aria-label={t('sheet.title', { number: job.number })}>
        <header className="fw-pjob-sheet-head">
          <h1 className="fw-pjob-h1">{t('sheet.title', { number: job.number })}</h1>
          <p className="fw-pjob-sub">{t('sheet.from', { company: job.from.companyName })}</p>
        </header>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('facts.style'), value: `${job.workOrder.style.code} · ${job.workOrder.style.name}` },
            { label: t('facts.workOrder'), value: job.workOrder.number },
            { label: t('facts.pieces'), value: String(pieces) },
            { label: t('facts.kit'), value: job.kit.sentOn.length > 0 ? job.kit.sentOn.map((date) => day(date)).join(', ') : t('facts.kitNotYet') },
            { label: t('facts.dueBack'), value: job.expectedBackDate ? day(job.expectedBackDate) : t('facts.noDay') },
            ...(job.note ? [{ label: t('facts.instructions'), value: job.note }] : []),
          ]}
        />
        {job.operations.map((operation) => {
          const grid = operationGrid(operation)
          return (
            <section key={operation.id} className="fw-pjob-operation">
              <h2 className="fw-pjob-h3">{t('sheet.operation', { seq: operation.seq, name: operation.name || operation.code, count: operation.pieces })}</h2>
              {operation.note ? <p className="fw-pjob-hint">{operation.note}</p> : null}
              {operation.sizes.length > 0 ? <SizeGridView colours={grid.colours} sizes={grid.sizes} value={grid.pieces} locale={INTL_LOCALE[locale]} copy={gridCopyOf(t)} caption={t('grid.captionOf', { operation: operation.name || operation.code })} /> : null}
            </section>
          )
        })}
        {job.kit.lines.length > 0 ? (
          <section className="fw-pjob-operation">
            <h2 className="fw-pjob-h3">{t('kit.title')}</h2>
            <ul className="fw-pjob-plain-list">
              {job.kit.lines.map((line) => (
                <li key={line.id}>
                  {t('kit.line', { seq: line.seq })} · {line.item.code} {line.item.name} {line.colour ? `· ${line.colour}` : ''} · {quantity(line.quantity, line.uom)}
                  {line.ddt ? ` · ${t('kit.ddt', { number: line.ddt.number })}` : ''}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {job.bundles.length > 0 ? (
          <section className="fw-pjob-operation">
            <h2 className="fw-pjob-h3">{t('kit.bundles')}</h2>
            <ul className="fw-pjob-plain-list">
              {job.bundles.map((bundle) => (
                <li key={bundle.id}>
                  {bundle.code} · {bundle.colourway} {bundle.size} · {t('card.pieces', { count: bundle.quantity })}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className="fw-pjob-hint">{t('noPrices')}</p>
      </article>
    </div>
  )
}
