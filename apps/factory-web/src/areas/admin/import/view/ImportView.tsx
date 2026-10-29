'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { FileSpreadsheet, Upload } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { AdminPageMessages } from '../../kit/messages'
import { adminHref, pageOf } from '../../shared/model'
import { dash, ListState, ListTable, NoAccess, PageHead } from '../../shared/view/parts'
import type { ImportJob, ImportStatus } from '../api'
import { lastImportOf, leftToApply, phaseOf, templateHref, type ImportViewModel } from '../model'
import { ImportWizard, useImporterWords, type WizardActions } from './ImportWizard'
import '../../shared/admin.css'
import '../import.css'

export type { ImportViewModel } from '../model'

export interface ImportActions extends WizardActions {
  /** Open the wizard for a new upload (an importer chosen, or the picker). */
  onNew?: (importerKey: string | null) => void
  onRetry?: () => void
  onApplyAgain?: (job: ImportJob) => void
  onDismissNotice?: () => void
}

const STATUS_TONE: Readonly<Record<ImportStatus, 'info' | 'success' | 'danger' | 'neutral' | 'warning'>> = {
  UPLOADED: 'info',
  PLANNED: 'warning',
  APPLYING: 'info',
  APPLIED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
}

/**
 * SCR-017 — Admin › Import & export (design 02 admin.import, W0): start from the thing — one card per importer this
 * person may use, in plain words, with its last import and its template where one exists — then one wizard for every
 * sheet (upload → check → apply → result; nothing is written before Apply). Recent imports lists every job; a row
 * reopens it (`?job=<id>`), a failed apply can be applied again. Fetches nothing (ImportPage.tsx reads the API).
 */
export function ImportView({ model, actions }: { model: ImportViewModel; actions?: ImportActions }) {
  return (
    <AdminPageMessages namespace="admin-import">
      <Imports model={model} actions={actions} />
    </AdminPageMessages>
  )
}

export function JobState({ job }: { job: ImportJob }) {
  const t = useT('admin-import')
  return <Pill tone={STATUS_TONE[job.status]}>{t(`imp.state.${phaseOf(job)}`)}</Pill>
}

function Imports({ model, actions }: { model: ImportViewModel; actions?: ImportActions }) {
  const t = useT('admin-import')
  const ta = useT('admin')
  const locale = useLocale()
  const words = useImporterWords()
  const base = adminHref(model.prefix, '/import')

  // c: import a sheet (when nothing has the focus and no dialog is open), as the design's keyboard says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.wizard || !model.can.run) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key !== 'c') return
      event.preventDefault()
      actions?.onNew?.(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.can.view) {
    return (
      <div className="fw-adm">
        <NoAccess need="perm.imports_view" />
      </div>
    )
  }

  const importers = model.importers.items
  const jobs = model.jobs.items
  const company = (id: string | null) => (id ? (model.companies.find((item) => item.id === id)?.name ?? null) : t('imp.everyCompany'))
  const paged = pageOf(jobs ?? [], 1)

  return (
    <div className="fw-adm">
      <PageHead
        intro={t('imp.intro')}
        asOf={model.asOf}
        actions={
          <Button variant="primary" size="sm" onClick={() => actions?.onNew?.(null)} heldReason={!model.can.run ? t('imp.held.noRunRight') : importers && importers.length === 0 ? t('imp.held.noImporter') : null}>
            <Upload size={14} aria-hidden /> {t('imp.new')}
          </Button>
        }
      />
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.key.startsWith('imp.') ? t(model.notice.key, model.notice.params) : ta(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {ta('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <section className="fw-adm-imp-section" aria-labelledby="imp-what">
        <h2 id="imp-what" className="fw-adm-imp-h2">
          {t('imp.what.title')}
        </h2>
        {model.importers.problem || importers === null ? (
          <ListState problem={model.importers.problem} loading={importers === null} onRetry={actions?.onRetry} rows={3} />
        ) : importers.length === 0 ? (
          <ListState loading={false} empty={{ icon: <FileSpreadsheet size={24} aria-hidden />, title: t('imp.what.noneTitle'), body: t('imp.what.noneBody') }} />
        ) : (
          <div className="fw-adm-imp-cards">
            {importers.map((importer) => {
              const last = jobs ? lastImportOf(jobs, importer.key) : null
              const xlsx = templateHref(importer.key, 'xlsx', locale)
              const csv = templateHref(importer.key, 'csv', locale)
              return (
                <Card key={importer.key} header={words.name(importer.key, importer.label)} headingLevel={3} className="fw-adm-imp-card">
                  <div className="fw-adm-imp-card-body">
                    <p className="fw-adm-intro">{words.fills(importer.key, importer.description)}</p>
                    <p className="fw-adm-hint">
                      {jobs === null
                        ? t('imp.what.lastUnknown')
                        : last
                          ? t('imp.what.last', { when: formatDateTime(last.createdAt, { locale }), state: t(`imp.state.${phaseOf(last)}`) })
                          : t('imp.what.never')}
                    </p>
                    <div className="fw-adm-actions">
                      {model.can.run ? (
                        <Button asChild size="sm">
                          <Link href={`${base}?importer=${encodeURIComponent(importer.key)}`}>{t('imp.what.start')}</Link>
                        </Button>
                      ) : (
                        <Button size="sm" heldReason={t('imp.held.noRunRight')}>
                          {t('imp.what.start')}
                        </Button>
                      )}
                      {xlsx && csv && (
                        <span className="fw-adm-imp-links">
                          <a className="fw-adm-link" href={xlsx} download>
                            {t('imp.template.xlsx')}
                          </a>
                          <a className="fw-adm-link" href={csv} download>
                            {t('imp.template.csv')}
                          </a>
                        </span>
                      )}
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
        <p className="fw-adm-hint">{t('imp.what.later')}</p>
      </section>

      <section className="fw-adm-imp-section" aria-labelledby="imp-recent">
        <h2 id="imp-recent" className="fw-adm-imp-h2">
          {t('imp.recent.title')}
        </h2>
        {model.jobs.problem || jobs === null ? (
          <ListState problem={model.jobs.problem} loading={jobs === null} onRetry={actions?.onRetry} />
        ) : jobs.length === 0 ? (
          <Card padded>
            <EmptyState icon={<Upload size={24} aria-hidden />} title={t('imp.recent.emptyTitle')} description={t('imp.recent.emptyBody')} />
          </Card>
        ) : (
          <ListTable
            label={t('imp.recent.title')}
            columns={[t('imp.col.importer'), t('imp.col.file'), t('imp.col.company'), t('imp.col.state'), t('imp.col.rows'), t('imp.col.who'), t('imp.col.when')]}
            widths={['16%', '18%', '14%', '12%', '20%', '10%', '10%']}
            page={paged.page}
            pageCount={paged.pageCount}
            count={ta('list.count', { shown: paged.rows.length, total: jobs.length })}
            rows={paged.rows.map((job) => {
              const phase = phaseOf(job)
              return {
                id: job.id,
                cells: [
                  <span key="importer" className="fw-adm-cell">
                    <Link className="fw-adm-name" href={`${base}?job=${encodeURIComponent(job.id)}`}>
                      {words.name(job.importerKey, job.importerLabel)}
                    </Link>
                    {phase === 'applyFailed' && model.can.apply && (
                      <Button size="xs" onClick={() => actions?.onApplyAgain?.(job)} heldReason={leftToApply(job) === 0 ? t('imp.held.nothing') : null}>
                        {t('imp.recent.applyAgain')}
                      </Button>
                    )}
                  </span>,
                  <span key="file" className="fw-adm-code fw-adm-imp-filename">
                    {job.fileName}
                  </span>,
                  dash(company(job.companyId)),
                  <JobState key="state" job={job} />,
                  <span key="rows" className="fw-adm-imp-rows">
                    {phase === 'applied' || phase === 'applyFailed' || (phase === 'cancelled' && job.appliedCount > 0)
                      ? t('imp.recent.rowsApplied', { applied: job.appliedCount, skipped: job.skippedCount, refused: job.errorCount })
                      : job.plannedAt
                        ? t('imp.recent.rowsPlanned', { create: job.createCount, update: job.updateCount, unchanged: job.unchangedCount, refused: job.errorCount })
                        : '—'}
                  </span>,
                  dash(job.createdById ? model.people[job.createdById] : null),
                  formatDateTime(job.createdAt, { locale }),
                ],
              }
            })}
          />
        )}
      </section>

      <ImportWizard model={model.wizard} importers={importers ?? []} companies={model.companies} can={model.can} actions={actions} />
    </div>
  )
}
