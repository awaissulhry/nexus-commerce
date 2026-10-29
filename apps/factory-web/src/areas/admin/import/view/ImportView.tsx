'use client'

import { useEffect, useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleX, FileSpreadsheet, Upload } from 'lucide-react'
import { Card, EmptyState, Modal } from '@nexus/ui/components'
import { IdentityCell, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { bulkHeld, leftCounts } from '../../kit/bulk-model'
import { BulkReach, useKeysHelp, useLatest, useSelection } from '../../kit/list'
import { AdminPageMessages } from '../../kit/messages'
import { PageNotice } from '../../kit/parts'
import { adminHref } from '../../shared/model'
import { BulkButton, FrameState, ListState, NoAccess, PageHead } from '../../shared/view/parts'
import type { ImportJob, ImportStatus } from '../api'
import { cancelReach, lastImportOf, leftToApply, phaseOf, templateHref, type ImportRights, type ImportViewModel } from '../model'
import { ImportWizard, useImporterWords, type WizardActions } from './ImportWizard'
import '../../shared/admin.css'
import '../import.css'

export type { ImportViewModel } from '../model'

export interface ImportActions extends WizardActions {
  /** Open the wizard for a new upload (an importer chosen, or the picker). */
  onNew?: (importerKey: string | null) => void
  onRetry?: () => void
  onApplyAgain?: (job: ImportJob) => void
  /** Enter on a job: reopen it in the wizard. */
  onOpenJob?: (job: ImportJob) => void
  /** The jobs ticked in Recent imports. */
  onSelect?: (ids: string[]) => void
  /** Opens (ids) or closes (null) the "Cancel N imports" confirm. */
  onCancelMany?: (ids: readonly string[] | null) => void
  /** Cancels these jobs, one call each; one notice says what was done. */
  onCancelManyGo?: (jobs: readonly ImportJob[]) => Promise<void> | void
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
 * sheet (upload → check → apply → result; nothing is written before Apply). Recent imports lists every job in the
 * Office's list frame (Owner rule 2026-10-29): a row reopens it (`?job=<id>`), a failed apply can be applied again, and
 * jobs nothing was written from yet can be cancelled several at once. Fetches nothing (ImportPage.tsx reads the API).
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

/** What an import's rows came to: written, skipped and refused once applied; new, changed, unchanged and refused once checked. */
export function rowsWords(t: (key: string, params?: Record<string, string | number>) => string, job: ImportJob): string {
  const phase = phaseOf(job)
  if (phase === 'applied' || phase === 'applyFailed' || (phase === 'cancelled' && job.appliedCount > 0)) return t('imp.recent.rowsApplied', { applied: job.appliedCount, skipped: job.skippedCount, refused: job.errorCount })
  if (job.plannedAt) return t('imp.recent.rowsPlanned', { create: job.createCount, update: job.updateCount, unchanged: job.unchangedCount, refused: job.errorCount })
  return '—'
}

/** A job in Recent imports: what it loads (a link that reopens it), and "Apply again" when its apply stopped. */
export function JobCell({ job, href, canApply, onApplyAgain }: { job: ImportJob; href: string; canApply: boolean; onApplyAgain?: (job: ImportJob) => void }) {
  const t = useT('admin-import')
  const words = useImporterWords()
  const name = words.name(job.importerKey, job.importerLabel)
  return (
    <IdentityCell
      noImage
      title={name}
      titleAttr={name}
      href={href}
      sub={
        phaseOf(job) === 'applyFailed' && canApply ? (
          <Button size="xs" onClick={() => onApplyAgain?.(job)} heldReason={leftToApply(job) === 0 ? t('imp.held.nothing') : null}>
            {t('imp.recent.applyAgain')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** Recent imports' columns (one job per row, newest first). */
export function useJobColumns(model: Pick<ImportViewModel, 'prefix' | 'companies' | 'people'> & { can: Pick<ImportRights, 'apply'> }, onApplyAgain?: (job: ImportJob) => void): ColDef<ImportJob>[] {
  const t = useT('admin-import')
  const locale = useLocale()
  const { prefix, companies, people } = model
  const canApply = model.can.apply
  const latest = useLatest(onApplyAgain)
  return useMemo<ColDef<ImportJob>[]>(() => {
    const base = adminHref(prefix, '/import')
    const applyAgain = (job: ImportJob) => latest.current?.(job)
    const company = (id: string | null) => (id ? (companies.find((item) => item.id === id)?.name ?? '—') : t('imp.everyCompany'))
    return [
      {
        colId: 'importer',
        headerName: t('imp.col.importer'),
        flex: 1.4,
        minWidth: 170,
        cellRenderer: ({ data }: ICellRendererParams<ImportJob>) => (data ? <JobCell job={data} href={`${base}?job=${encodeURIComponent(data.id)}`} canApply={canApply} onApplyAgain={applyAgain} /> : null),
      },
      { colId: 'file', headerName: t('imp.col.file'), flex: 1.5, minWidth: 170, cellClass: 'fw-adm-code', valueGetter: ({ data }) => data?.fileName ?? '', tooltipValueGetter: ({ value }) => value as string },
      { colId: 'company', headerName: t('imp.col.company'), flex: 1.2, minWidth: 140, valueGetter: ({ data }) => (data ? company(data.companyId) : '') },
      { colId: 'state', headerName: t('imp.col.state'), flex: 1, minWidth: 160, cellRenderer: ({ data }: ICellRendererParams<ImportJob>) => (data ? <JobState job={data} /> : null) },
      { colId: 'rows', headerName: t('imp.col.rows'), flex: 2, minWidth: 260, valueGetter: ({ data }) => (data ? rowsWords(t, data) : ''), tooltipValueGetter: ({ value }) => value as string },
      { colId: 'who', headerName: t('imp.col.who'), flex: 1, minWidth: 120, valueGetter: ({ data }) => (data ? ((data.createdById ? people[data.createdById] : null) ?? '—') : '') },
      { colId: 'when', headerName: t('imp.col.when'), flex: 1, minWidth: 150, valueGetter: ({ data }) => (data ? formatDateTime(data.createdAt, { locale }) : '') },
    ]
  }, [t, locale, prefix, companies, people, canApply, latest])
}

/** The page's own key, listed in the list's footer icon. */
function usePageKeys(): ListKey[] {
  const t = useT('admin-import')
  return [{ keys: ['c'], does: t('imp.keys.new') }]
}

function Imports({ model, actions }: { model: ImportViewModel; actions?: ImportActions }) {
  const t = useT('admin-import')
  const locale = useLocale()
  const words = useImporterWords()
  const base = adminHref(model.prefix, '/import')
  const jobs = model.jobs.items
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, (jobs ?? []).map((job) => job.id))
  const columns = useJobColumns(model, actions?.onApplyAgain)
  const own = usePageKeys()
  const { onHelp, help } = useKeysHelp(own, true)

  // c: import a sheet (when nothing has the focus and no dialog is open), as the design's keyboard says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.wizard || model.cancelMany || !model.can.run) return
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
  const reach = cancelReach((jobs ?? []).filter((job) => selected.includes(job.id)))
  const cancelHeld = bulkHeld(reach, model.can.run, { right: 'imp.held.noRunRight', none: 'imp.bulk.none' })
  const nameOf = (id: string) => (jobs ?? []).find((job) => job.id === id)?.fileName ?? id
  const state: ReactNode = model.jobs.problem ? (
    <FrameState problem={model.jobs.problem} onRetry={actions?.onRetry} />
  ) : jobs && jobs.length === 0 ? (
    <EmptyState icon={<Upload size={24} aria-hidden />} title={t('imp.recent.emptyTitle')} description={t('imp.recent.emptyBody')} />
  ) : undefined

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
      <PageNotice namespace="admin-import" notice={model.notice} onDismiss={actions?.onDismissNotice} nameOf={nameOf} />

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
        <ListFrame<ImportJob>
          label={t('imp.recent.title')}
          rows={model.jobs.problem ? [] : jobs}
          rowId={(job) => job.id}
          columns={columns}
          count={jobs ? t('imp.recent.count', { count: jobs.length }) : '—'}
          selection={{
            selected,
            onChange,
            actions: (
              <BulkButton
                icon={<CircleX size={13} aria-hidden />}
                label={reach.applies.length > 0 ? t('imp.bulk.cancel', { count: reach.applies.length }) : t('imp.bulk.cancelNone')}
                held={cancelHeld ? t(cancelHeld) : null}
                tone="danger-outline"
                onClick={() => actions?.onCancelMany?.(selected)}
              />
            ),
          }}
          keys={own}
          onHelp={onHelp}
          onOpen={(job) => actions?.onOpenJob?.(job)}
          state={state}
        />
        {help}
      </section>

      <ImportWizard model={model.wizard} importers={importers ?? []} companies={model.companies} can={model.can} actions={actions} />
      <CancelManyModal model={model} actions={actions} />
    </div>
  )
}

/** "Cancel N imports" (bulk; each job is one `POST /imports/:id/cancel` with its version): what it applies to and what it leaves out. */
function CancelManyModal({ model, actions }: { model: ImportViewModel; actions?: ImportActions }) {
  const t = useT('admin-import')
  const ta = useT('admin')
  const words = useImporterWords()
  const ids = model.cancelMany ?? null
  if (!ids) return null
  const chosen = ids.flatMap((id) => (model.jobs.items ?? []).filter((job) => job.id === id))
  const reach = cancelReach(chosen)
  const count = reach.applies.length
  const held = bulkHeld(reach, model.can.run, { right: 'imp.held.noRunRight', none: 'imp.bulk.none' })
  const close = () => actions?.onCancelMany?.(null)
  return (
    <Modal
      open
      onClose={close}
      title={t('imp.bulk.title', { count })}
      size="md"
      busy={model.bulkBusy}
      footer={
        <>
          <Button onClick={close}>{t('imp.bulk.keep')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : model.bulkBusy ? ta('common.saving') : null} onClick={() => void actions?.onCancelManyGo?.(reach.applies)}>
            {t('imp.bulk.go', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        <p className="fw-adm-intro">{t('imp.bulk.body')}</p>
        <BulkReach
          label={t('imp.bulk.listLabel')}
          names={reach.applies.map((job) => `${words.name(job.importerKey, job.importerLabel)} — ${job.fileName}`)}
          left={leftCounts(reach).map((entry) => ({ ...entry, words: t(entry.why, { count: entry.count }) }))}
        />
      </div>
    </Modal>
  )
}
