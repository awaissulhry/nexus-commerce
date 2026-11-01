'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Banner, Field, KeyValue, MetricStrip, Stepper, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { FileDropzone, JobProgress, Modal } from '../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { IMPORT_MAX_BYTES, NUMBER_FORMATS, type ImportJob, type Importer, type ImportRow } from '../api'
import {
  applicable,
  applyHeld,
  hasOwnWords,
  importerStem,
  issueGroups,
  keyText,
  layoutOf,
  leftToApply,
  mayCancel,
  NUMBER_SAMPLES,
  phaseOf,
  refusedRowsHref,
  rowChanges,
  stepOf,
  templateHref,
  uploadProblems,
  WIZARD_STEPS,
  type ImportRights,
  type UploadDraft,
  type WizardModel,
} from '../model'

/**
 * The import wizard (design 02 admin.import `wizard`; 00 §3.13; a local stand-in for DS gap D14 ImportFlow built from
 * Modal, Stepper, FileDropzone, JobProgress, KeyValue and SummaryTable): 1 Upload → 2 Check (the dry run: nothing is
 * written) → 3 Apply → 4 Result. The job lives on the server, so closing keeps it (Recent imports reopens it). The
 * API's own sentences (a refused row's reason, a file problem) are shown as data, quoted, under a sentence of ours.
 */

export interface WizardActions {
  onClose?: () => void
  onDraft?: (patch: Partial<UploadDraft>) => void
  onFile?: (file: File | null) => void
  onStart?: () => void
  onApply?: () => void
  onCancelAsk?: (open: boolean) => void
  onCancelConfirm?: () => void
  onRestart?: () => void
}

export function useImporterWords() {
  const t = useT('admin-import')
  return {
    name: (key: string, label?: string | null) => (hasOwnWords(key) ? t(`${importerStem(key)}.name`) : (label ?? key)),
    fills: (key: string, description?: string | null) => (hasOwnWords(key) ? t(`${importerStem(key)}.fills`) : (description ?? '')),
  }
}

const sizeText = (bytes: number, locale: 'it' | 'en') =>
  bytes >= 1_048_576 ? `${formatNumber(bytes / 1_048_576, locale, { maximumFractionDigits: 1 })} MB` : `${formatNumber(Math.max(1, Math.round(bytes / 1024)), locale)} KB`

/** An API sentence shown as data (a quote in the page's mono style), never as our words. */
function Said({ children }: { children: ReactNode }) {
  return <q className="fw-adm-imp-said">{children}</q>
}

export interface WizardProps {
  model: WizardModel | null
  importers: readonly Importer[]
  companies: ReadonlyArray<{ id: string; name: string }>
  can: ImportRights
  actions?: WizardActions
}

interface WizardParts {
  title: string
  subtitle: string
  footer: ReactNode
  body: ReactNode
  confirm: { title: string; footer: ReactNode; body: ReactNode } | null
}

/** The wizard in a centred dialog (full sheet on a phone); the cancel confirm in its own small one. */
export function ImportWizard(props: WizardProps) {
  const parts = useWizardParts(props)
  if (!parts || !props.model) return null
  const { model, actions } = props
  return (
    <>
      <Modal open={!parts.confirm} onClose={() => actions?.onClose?.()} title={parts.title} subtitle={parts.subtitle} size="xxl" busy={model.busy} footer={parts.footer}>
        {parts.body}
      </Modal>
      <Modal open={!!parts.confirm} onClose={() => actions?.onCancelAsk?.(false)} title={parts.confirm?.title ?? ''} size="sm" busy={model.busy} footer={parts.confirm?.footer}>
        {parts.confirm?.body}
      </Modal>
    </>
  )
}

/**
 * The same wizard drawn in place, without the dialog (the dialog opens only in a browser, after hydration): what the
 * tests read to check every step's words in both languages.
 */
export function ImportWizardInline(props: WizardProps) {
  const parts = useWizardParts(props)
  if (!parts) return null
  const shown = parts.confirm ?? parts
  return (
    <section aria-label={shown.title}>
      <h2>{shown.title}</h2>
      {shown.body}
      <div>{shown.footer}</div>
    </section>
  )
}

function useWizardParts({ model, importers, companies, can, actions }: WizardProps): WizardParts | null {
  const t = useT('admin-import')
  const ta = useT('admin')
  const words = useImporterWords()
  const [tried, setTried] = useState(false)
  useEffect(() => setTried(false), [model?.job?.id])
  const job = model?.job ?? null
  const phase = job ? phaseOf(job) : null
  const held = job ? applyHeld(job, can, model?.busy) : null

  // ⌘Enter: the step's primary (upload and check; apply).
  useEffect(() => {
    if (!model || model.confirmCancel) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
      event.preventDefault()
      if (!job) {
        setTried(true)
        if (Object.keys(uploadProblems(model.draft)).length === 0 && !model.busy) actions?.onStart?.()
      } else if ((phase === 'planned' || phase === 'applyFailed') && !held) actions?.onApply?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model) return null
  const draft = model.draft
  const importerKey = job?.importerKey ?? draft.importerKey
  const importer = importers.find((item) => item.key === importerKey)
  const title = importerKey ? t('imp.wizard.titleOf', { name: words.name(importerKey, importer?.label ?? job?.importerLabel) }) : t('imp.wizard.title')
  const step = stepOf(job)
  const problems = uploadProblems(draft)
  const ready = Object.keys(problems).length === 0
  const start = () => {
    setTried(true)
    if (ready && !model.busy) actions?.onStart?.()
  }
  const cancelButton =
    job && mayCancel(job) && can.run ? (
      <Button variant="danger-outline" onClick={() => actions?.onCancelAsk?.(true)} heldReason={model.busy ? ta('common.saving') : null}>
        {t('imp.wizard.cancelImport')}
      </Button>
    ) : null

  let footer: ReactNode
  if (!job) {
    footer = (
      <>
        <Button onClick={() => actions?.onClose?.()}>{ta('common.cancel')}</Button>
        <Button
          variant="primary"
          onClick={start}
          heldReason={!can.run ? t('imp.held.noRunRight') : tried && !ready ? t('imp.held.fixFirst', { count: Object.keys(problems).length }) : model.busy ? t('imp.wizard.uploading') : null}
        >
          {t('imp.wizard.start')}
        </Button>
      </>
    )
  } else if (phase === 'planned' || phase === 'applyFailed') {
    const count = phase === 'applyFailed' ? leftToApply(job) : applicable(job)
    footer = (
      <>
        {cancelButton}
        <Button onClick={() => actions?.onClose?.()}>{t('imp.wizard.later')}</Button>
        <Button variant="primary" onClick={() => actions?.onApply?.()} heldReason={held ? t(held) : null}>
          {phase === 'applyFailed' ? t('imp.wizard.applyAgain', { count }) : t('imp.wizard.apply', { count })}
        </Button>
      </>
    )
  } else if (phase === 'planFailed') {
    footer = (
      <>
        <Button onClick={() => actions?.onClose?.()}>{ta('common.close')}</Button>
        <Button variant="primary" onClick={() => actions?.onRestart?.()} heldReason={!can.run ? t('imp.held.noRunRight') : null}>
          {t('imp.wizard.restart')}
        </Button>
      </>
    )
  } else if (phase === 'reading' || phase === 'applying') {
    footer = (
      <>
        {phase === 'reading' && cancelButton}
        <Button onClick={() => actions?.onClose?.()}>{t('imp.wizard.leave')}</Button>
      </>
    )
  } else {
    footer = (
      <Button variant="primary" onClick={() => actions?.onClose?.()}>
        {ta('common.done')}
      </Button>
    )
  }

  return {
    title,
    subtitle: job ? job.fileName : t('imp.wizard.subtitle'),
    footer,
    body: (
      <div className="fw-adm-modal-body fw-adm-imp-wizard">
        <Stepper steps={WIZARD_STEPS.map((key) => ({ key, label: t(`imp.step.${key}`) }))} current={WIZARD_STEPS.indexOf(step)} />
        {model.problem && <Banner tone="danger" title={model.problem.startsWith('imp.') ? t(model.problem) : ta(model.problem)} />}
        {!job ? (
          <UploadStep draft={draft} importers={importers} companies={companies} tried={tried} problems={problems} can={can} actions={actions} onSubmit={start} />
        ) : phase === 'reading' ? (
          <JobProgress label={t('imp.reading.label')} detail={t('imp.reading.detail', { file: job.fileName })} startedAt={new Date(job.createdAt).getTime()} note={t('imp.reading.note')} />
        ) : phase === 'planFailed' ? (
          <PlanFailed job={job} />
        ) : phase === 'planned' ? (
          <Checked job={job} model={model} />
        ) : phase === 'applying' ? (
          <>
            <JobProgress
              label={t('imp.applying.label', { count: applicable(job) })}
              value={job.appliedCount + job.skippedCount}
              max={Math.max(1, applicable(job))}
              detail={t('imp.applying.detail', { done: job.appliedCount + job.skippedCount, total: applicable(job) })}
              startedAt={job.applyRequestedAt ? new Date(job.applyRequestedAt).getTime() : undefined}
              note={t('imp.applying.note')}
            />
          </>
        ) : phase === 'applyFailed' ? (
          <>
            <Banner tone="danger" title={t('imp.applyFailed.title')}>
              <p className="fw-adm-imp-p">{t('imp.applyFailed.body', { written: job.appliedCount, left: leftToApply(job) })}</p>
              {job.error && (
                <p className="fw-adm-imp-p">
                  {t('imp.saidLead')} <Said>{job.error}</Said>
                </p>
              )}
            </Banner>
            <Checked job={job} model={model} />
          </>
        ) : phase === 'cancelled' ? (
          <Banner tone="neutral" title={t('imp.cancelled.title')}>
            <p className="fw-adm-imp-p">{job.appliedCount > 0 ? t('imp.cancelled.someWritten', { count: job.appliedCount }) : t('imp.cancelled.nothing')}</p>
          </Banner>
        ) : (
          <Result job={job} model={model} />
        )}
      </div>
    ),
    confirm: model.confirmCancel
      ? {
          title: t('imp.cancel.title'),
          footer: (
            <>
              <Button onClick={() => actions?.onCancelAsk?.(false)}>{t('imp.cancel.keep')}</Button>
              <Button variant="danger" onClick={() => actions?.onCancelConfirm?.()} heldReason={model.busy ? ta('common.saving') : null}>
                {t('imp.cancel.go')}
              </Button>
            </>
          ),
          body: (
            <div className="fw-adm-modal-body">
              <p className="fw-adm-intro">{t('imp.cancel.body')}</p>
              {job && job.appliedCount > 0 && <p className="fw-adm-intro">{t('imp.cancel.kept', { count: job.appliedCount })}</p>}
            </div>
          ),
        }
      : null,
  }
}

function UploadStep({
  draft,
  importers,
  companies,
  tried,
  problems,
  can,
  actions,
  onSubmit,
}: {
  draft: UploadDraft
  importers: readonly Importer[]
  companies: ReadonlyArray<{ id: string; name: string }>
  tried: boolean
  problems: ReturnType<typeof uploadProblems>
  can: ImportRights
  actions?: WizardActions
  onSubmit: () => void
}) {
  const t = useT('admin-import')
  const locale = useLocale()
  const words = useImporterWords()
  const template = draft.importerKey ? templateHref(draft.importerKey, 'xlsx', draft.numberFormat) : null
  const templateCsv = draft.importerKey ? templateHref(draft.importerKey, 'csv', draft.numberFormat) : null
  const show = (field: keyof typeof problems) => (tried && problems[field] ? t(problems[field]!) : undefined)
  return (
    <form
      className="fw-adm-modal-body"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {!can.run && <Banner tone="info" title={t('imp.held.noRunRight')} />}
      <p className="fw-adm-intro">{t('imp.upload.intro')}</p>
      <div className="fw-adm-form">
        <Field label={t('imp.field.importer')} required error={show('importerKey')}>
          <Select value={draft.importerKey} onChange={(event) => actions?.onDraft?.({ importerKey: event.target.value })}>
            <option value="">{t('imp.field.importerPick')}</option>
            {importers.map((importer) => (
              <option key={importer.key} value={importer.key}>
                {words.name(importer.key, importer.label)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('imp.field.company')} required hint={t('imp.field.companyHint')} error={show('companyId')}>
          <Select value={draft.companyId} onChange={(event) => actions?.onDraft?.({ companyId: event.target.value })}>
            <option value="">{t('imp.field.companyPick')}</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {draft.importerKey && <p className="fw-adm-hint">{words.fills(draft.importerKey, importers.find((item) => item.key === draft.importerKey)?.description)}</p>}
      {template && templateCsv && (
        <p className="fw-adm-hint fw-adm-imp-links">
          <span>{t('imp.upload.template')}</span>
          <a className="fw-adm-link" href={template} download>
            {t('imp.template.xlsx')}
          </a>
          <a className="fw-adm-link" href={templateCsv} download>
            {t('imp.template.csv')}
          </a>
        </p>
      )}
      {draft.importerKey === 'inventory.opening' && <p className="fw-adm-hint">{t('imp.upload.openingReports')}</p>}
      <fieldset className="fw-adm-imp-formats">
        <legend className="fw-adm-imp-legend">{t('imp.field.numbers')}</legend>
        {NUMBER_FORMATS.map((format) => (
          <RadioCard
            key={format}
            name="imp-number-format"
            value={format}
            checked={draft.numberFormat === format}
            selected={draft.numberFormat === format}
            onChange={() => actions?.onDraft?.({ numberFormat: format })}
            title={t(`imp.numbers.${format}`)}
            description={t('imp.numbers.sample', { sample: NUMBER_SAMPLES[format] })}
          />
        ))}
      </fieldset>
      <Field label={t('imp.field.file')} required hint={t('imp.field.fileHint')} error={show('file')}>
        <FileDropzone accept=".csv,.xlsx" maxBytes={IMPORT_MAX_BYTES} onFiles={(files) => actions?.onFile?.(files[0] ?? null)} disabled={!can.run} hint={t('imp.field.dropHint')} />
      </Field>
      {draft.file && (
        <p className="fw-adm-imp-file" role="status">
          <Tag tone="info">{draft.file.name.toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV'}</Tag>
          <span className="fw-adm-code">{draft.file.name}</span>
          <span className="fw-adm-hint">{sizeText(draft.file.size, locale)}</span>
          <Button size="xs" variant="quiet" onClick={() => actions?.onFile?.(null)}>
            {t('imp.upload.remove')}
          </Button>
        </p>
      )}
      {draft.file?.name.toLowerCase().endsWith('.xlsx') && (
        <Field label={t('imp.field.sheet')} hint={t('imp.field.sheetHint')}>
          <Input value={draft.sheetName} onChange={(event) => actions?.onDraft?.({ sheetName: event.target.value })} />
        </Field>
      )}
      <p className="fw-adm-hint">{t('imp.upload.safe')}</p>
    </form>
  )
}

function Counts({ job }: { job: ImportJob }) {
  const t = useT('admin-import')
  return (
    <MetricStrip
      minTileWidth={130}
      metrics={[
        { label: t('imp.count.create'), value: String(job.createCount), hint: t('imp.count.createHint') },
        { label: t('imp.count.update'), value: String(job.updateCount), hint: t('imp.count.updateHint') },
        { label: t('imp.count.unchanged'), value: String(job.unchangedCount), hint: t('imp.count.unchangedHint') },
        { label: t('imp.count.error'), value: String(job.errorCount), hint: t('imp.count.errorHint') },
      ]}
    />
  )
}

function RowsState({ rows, children }: { rows: WizardModel['refused']; children: ReactNode }) {
  const ta = useT('admin')
  if (rows.problem) return <Banner tone="warning" title={ta(rows.problem)} />
  if (rows.items === null)
    return (
      <div className="fw-adm-skeleton" aria-busy="true">
        <Skeleton height={20} />
        <Skeleton height={20} />
      </div>
    )
  return <>{children}</>
}

/** The dry run: counts, the columns read, the refused rows with their reasons, the changes. Nothing written yet. */
function Checked({ job, model }: { job: ImportJob; model: WizardModel }) {
  const t = useT('admin-import')
  const layout = layoutOf(job)
  const refused = model.refused.items ?? []
  const changes = model.changes.items ?? []
  return (
    <div className="fw-adm-modal-body">
      <Counts job={job} />
      <p className="fw-adm-intro">{phaseOf(job) === 'planned' ? t('imp.checked.nothingYet') : t('imp.checked.again')}</p>
      {layout && (
        <section className="fw-adm-imp-section" aria-label={t('imp.checked.columns')}>
          <h3 className="fw-adm-imp-h3">{t('imp.checked.columns')}</h3>
          <p className="fw-adm-hint">{t('imp.checked.columnsRead', { count: layout.columns.length, sheet: layout.sheet ?? layout.format.toUpperCase() })}</p>
          <span className="fw-adm-tags">
            {layout.columns.map((item) => (
              <Tag key={item.index} tone="success">
                {item.header}
              </Tag>
            ))}
          </span>
          {layout.ignored.length > 0 && (
            <>
              <p className="fw-adm-hint">{t('imp.checked.ignored', { count: layout.ignored.length })}</p>
              <ul className="fw-adm-list">
                {layout.ignored.map((item) => (
                  <li key={item.index} className="fw-adm-imp-p">
                    <Tag>{item.header || '—'}</Tag> <Said>{item.reason}</Said>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {job.errorCount > 0 && (
        <section className="fw-adm-imp-section" aria-label={t('imp.checked.refused')}>
          <h3 className="fw-adm-imp-h3">{t('imp.checked.refusedCount', { count: job.errorCount })}</h3>
          <p className="fw-adm-hint fw-adm-imp-links">
            <span>{t('imp.checked.refusedHint')}</span>
            <a className="fw-adm-link" href={refusedRowsHref(job.id)} download>
              {t('imp.download.refused')}
            </a>
          </p>
          <RowsState rows={model.refused}>
            <div className="fw-adm-table">
              <SummaryTable
                label={t('imp.checked.refused')}
                columns={[t('imp.col.row'), t('imp.col.key'), t('imp.col.column'), t('imp.col.reason')]}
                widths={['8%', '18%', '20%', '54%']}
                align={['left', 'left', 'left', 'left']}
                density="roomy"
                stackOnPhone
                rows={refused.flatMap((row) =>
                  (row.errors && row.errors.length > 0 ? row.errors : [{ message: '' }]).map((error, index) => ({
                    id: `${row.rowNumber}-${index}`,
                    cells: [
                      String(row.rowNumber),
                      keyText(row.key),
                      'column' in error && error.column ? layout?.columns.find((item) => item.column === error.column)?.header ?? error.column : '—',
                      error.message ? <Said key="said">{error.message}</Said> : '—',
                    ],
                  })),
                )}
              />
            </div>
            {job.errorCount > refused.length && <p className="fw-adm-hint">{t('imp.checked.moreRefused', { count: job.errorCount - refused.length })}</p>}
          </RowsState>
        </section>
      )}
      {applicable(job) > 0 && (
        <section className="fw-adm-imp-section" aria-label={t('imp.checked.changes')}>
          <h3 className="fw-adm-imp-h3">{t('imp.checked.changesCount', { count: applicable(job) })}</h3>
          <RowsState rows={model.changes}>
            <div className="fw-adm-table">
              <SummaryTable
                label={t('imp.checked.changes')}
                columns={[t('imp.col.row'), t('imp.col.key'), t('imp.col.what'), t('imp.col.values')]}
                widths={['8%', '18%', '12%', '62%']}
                align={['left', 'left', 'left', 'left']}
                density="roomy"
                stackOnPhone
                rows={changes.map((row) => ({
                  id: String(row.rowNumber),
                  cells: [
                    String(row.rowNumber),
                    keyText(row.key),
                    <Pill key="what" tone={row.action === 'CREATE' ? 'success' : 'info'}>
                      {t(`imp.action.${row.action}`)}
                    </Pill>,
                    <span key="values" className="fw-adm-imp-changes">
                      {rowChanges(row, layout).map((change) => (
                        <span key={change.column} className="fw-adm-imp-change">
                          <span className="fw-adm-imp-col">{change.header}</span>{' '}
                          {change.before !== null && (
                            <>
                              <s className="fw-adm-imp-before">{change.before}</s> →{' '}
                            </>
                          )}
                          <span>{change.after}</span>
                        </span>
                      ))}
                    </span>,
                  ],
                }))}
              />
            </div>
            {applicable(job) > changes.length && <p className="fw-adm-hint">{t('imp.checked.moreChanges', { count: applicable(job) - changes.length })}</p>}
          </RowsState>
        </section>
      )}
      {applicable(job) === 0 && job.errorCount === 0 && <Banner tone="info" title={t('imp.checked.allSame')} />}
    </div>
  )
}

function PlanFailed({ job }: { job: ImportJob }) {
  const t = useT('admin-import')
  const groups = issueGroups(job)
  const layout = layoutOf(job)
  return (
    <div className="fw-adm-modal-body">
      <Banner tone="warning" title={t('imp.planFailed.title')}>
        <p className="fw-adm-imp-p">{t('imp.planFailed.body')}</p>
      </Banner>
      {groups.money.length > 0 && (
        <Banner tone="info" title={t('imp.planFailed.money', { columns: groups.money.map((column) => layout?.columns.find((item) => item.column === column)?.header ?? column).join(', ') })} />
      )}
      {(groups.other.length > 0 || job.error) && (
        <section className="fw-adm-imp-section" aria-label={t('imp.planFailed.said')}>
          <h3 className="fw-adm-imp-h3">{t('imp.planFailed.said')}</h3>
          <ul className="fw-adm-list">
            {job.error && groups.other.length === 0 && (
              <li className="fw-adm-imp-p">
                <Said>{job.error}</Said>
              </li>
            )}
            {groups.other.map((item, index) => (
              <li key={`${item.path}-${index}`} className="fw-adm-imp-p">
                <Said>{item.message}</Said>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Result({ job, model }: { job: ImportJob; model: WizardModel }) {
  const t = useT('admin-import')
  const skipped = model.skipped.items ?? []
  return (
    <div className="fw-adm-modal-body">
      <Banner tone={job.skippedCount > 0 ? 'warning' : 'success'} title={t('imp.result.title', { count: job.appliedCount })} />
      <KeyValue
        columns={3}
        phoneColumns={2}
        labelCase="sentence"
        items={[
          { label: t('imp.result.applied'), value: String(job.appliedCount) },
          { label: t('imp.result.skipped'), value: String(job.skippedCount), hint: t('imp.result.skippedHint') },
          { label: t('imp.result.refused'), value: String(job.errorCount) },
        ]}
      />
      {job.errorCount > 0 && (
        <p className="fw-adm-hint fw-adm-imp-links">
          <span>{t('imp.result.refusedHint')}</span>
          <a className="fw-adm-link" href={refusedRowsHref(job.id)} download>
            {t('imp.download.refused')}
          </a>
        </p>
      )}
      {job.skippedCount > 0 && (
        <section className="fw-adm-imp-section" aria-label={t('imp.result.skippedRows')}>
          <h3 className="fw-adm-imp-h3">{t('imp.result.skippedRows')}</h3>
          <RowsState rows={model.skipped}>
            <ul className="fw-adm-list">
              {skipped.map((row: ImportRow) => (
                <li key={row.rowNumber} className="fw-adm-imp-p">
                  <Tag>{t('imp.result.rowN', { row: row.rowNumber })}</Tag> <span className="fw-adm-code">{keyText(row.key)}</span> {row.note ? <Said>{row.note}</Said> : t('imp.result.changedSince')}
                </li>
              ))}
            </ul>
          </RowsState>
        </section>
      )}
    </div>
  )
}
