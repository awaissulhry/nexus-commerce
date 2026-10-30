'use client'

import { Printer } from 'lucide-react'
import { Banner, Card, KeyValue, SummaryTable } from '@nexus/ui/components'
import { QrCode } from '@nexus/ui/components/QrCode/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { JobRecord } from '../../../_shared/api'
import { assigneeWords, labelOf, personWords, TIME_ZONE } from '../../../_shared/model'
import { PlantMessages, useWords } from '../../../_shared/parts'

/** SCR-149-sheet — a maintenance job on paper for the technician: one view model, nothing fetched. */
export interface JobSheetModel {
  readonly person: string
  readonly at: string
  /** The job's address the QR opens on a phone (the Office record). */
  readonly address: string
  readonly job: { readonly value: JobRecord | null; readonly problem: string | null }
}

/**
 * Plant › a maintenance job › Job sheet (design plant.jobs/tab:job-sheet "Job sheet (PDF)"): the number, the machine and
 * where it stands, the problem and the requests behind it, the priority, the technician and the due time, an empty box for
 * what was done and the machine's state after, and a QR that opens the job on a phone. Printed from the browser (it saves
 * it as a PDF; the API has no job-sheet layout yet). A floor technician is named here as on the record.
 */
export function JobSheetView({ model }: { model: JobSheetModel }) {
  return (
    <PlantMessages>
      <JobSheet model={model} />
    </PlantMessages>
  )
}

function JobSheet({ model }: { model: JobSheetModel }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const value = model.job.value
  const job = value?.job ?? null
  return (
    <article className="fw-pl-print">
      <header className="fw-pl-print-head">
        <h1 className="fw-pl-print-title">{job ? t('sheet.title', { number: job.number, machine: job.machine.assetNumber }) : t('sheet.titleLoading')}</h1>
        <p className="fw-pl-hint">{t('print.meta', { at: formatDateTime(model.at, place), person: model.person })}</p>
        <Button className="fw-pl-print-button" variant="secondary" onClick={() => window.print()} heldReason={job ? null : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {model.job.problem ? (
        <Banner tone="danger" title={t('record.failed')}>
          {t(model.job.problem)}
        </Banner>
      ) : !value || !job ? (
        <p className="fw-pl-hint" role="status">
          <Spinner size={14} /> {t('record.loading')}
        </p>
      ) : (
        <>
          <div className="fw-pl-sheet">
            <Card padded>
              <KeyValue
                dense
                labelCase="sentence"
                columns={2}
                items={[
                  { label: t('col.machine'), value: `${job.machine.assetNumber} · ${labelOf(job.machine.class, locale)}` },
                  { label: t('detail.place'), value: [value.card.machine.siteCode, job.machine.line?.code, job.machine.station ? `${job.machine.station.code} · ${job.machine.station.name}` : null].filter(Boolean).join(' · ') || '—' },
                  { label: t('field.type'), value: t(`jobType.${job.type}`) },
                  { label: t('field.priority'), value: t(`priority.${job.priority}`) },
                  { label: t('field.assignee'), value: assigneeWords(t, job) },
                  { label: t('field.due'), value: job.dueAt ? formatDateTime(job.dueAt, place) : t('record.noDue') },
                  { label: t('col.state'), value: t(`jobStatus.${job.status}`) },
                  { label: t('record.made'), value: formatDate(job.createdAt, place) },
                ]}
              />
            </Card>
            <QrCode value={model.address} label={t('sheet.qr', { number: job.number })} size={140} labels={{ copy: t('sheet.copy'), copied: t('sheet.copied'), copyFailed: t('sheet.copyFailed'), loading: t('record.loading'), tooLong: t('sheet.tooLong') }} />
          </div>
          <Card padded>
            <div className="fw-pl-stack tight">
              <h2 className="fw-pl-h3">{t('record.problem')}</h2>
              <p className="fw-pl-text">{job.problem}</p>
              {job.machine.locked && <p className="fw-pl-text fw-pl-danger">{t('sheet.locked')}</p>}
            </div>
          </Card>
          {value.requests.length > 0 && (
            <SummaryTable
              label={t('record.requests', { count: value.requests.length })}
              columns={[t('detail.reportedAt'), t('col.symptom'), t('col.reporter')]}
              rows={value.requests.map((request) => ({
                id: request.id,
                cells: [formatDateTime(request.reportedAt, place), [request.symptom ? labelOf(request.symptom, locale) : null, request.description].filter(Boolean).join(' — ') || '—', personWords(t, request.reportedBy)],
              }))}
            />
          )}
          <Card padded>
            <div className="fw-pl-stack">
              <h2 className="fw-pl-h3">{t('handBack.workDone')}</h2>
              <p className="fw-pl-hint">{t('sheet.writeHere')}</p>
              <p className="fw-pl-hint">{t('sheet.after')}</p>
              <p className="fw-pl-hint">{t('sheet.signature')}</p>
            </div>
          </Card>
        </>
      )}
    </article>
  )
}
