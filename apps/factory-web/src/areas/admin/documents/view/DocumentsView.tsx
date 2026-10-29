'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleOff, ExternalLink, FileText, Hash, Lock } from 'lucide-react'
import { Banner, Card, Disclosure, EmptyState, Field, KeyValue, Modal } from '@nexus/ui/components'
import { IdentityCell, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Input, Pill, SegmentedControl, Select, Tag, Textarea, TokenChip } from '@nexus/ui/primitives'
import { DOCUMENT_KINDS } from '@nexus/factory-domain/numbering/kinds'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { bulkHeld, leftCounts } from '../../kit/bulk-model'
import { BulkButton, BulkReach, ListProblem, useKeysHelp, useSelection } from '../../kit/list'
import { AdminPageMessages } from '../../kit/messages'
import { adminHref } from '../../shared/model'
import { dash, PageHead, StepUp } from '../../shared/view/parts'
import { PageNotice, useWords } from '../../kit/parts'
import { DOCUMENT_LANGUAGES, DOCUMENT_TYPES, sampleHref, type Allocation, type DocumentType, type Series } from '../api'
import {
  chipsPattern,
  closeReach,
  draftPattern,
  draftPreview,
  draftProblems,
  fiscalRows,
  hasIssued,
  hasOtherActive,
  kindKey,
  leftWithout,
  newDraft,
  newSeriesHeld,
  patternChips,
  periodOf,
  preview,
  proofWords,
  sampleCompany,
  SEPARATORS,
  seriesRows,
  skippedWords,
  startEditable,
  withKind,
  YEAR_TOKENS,
  type CompanyOption,
  type DocumentsDialog,
  type DocumentsView as ViewName,
  type DocumentsViewModel,
  type SeriesDraft,
} from '../model'
import '../documents.css'

export type { DocumentsViewModel } from '../model'

export interface DocumentsActions {
  onView?: (view: ViewName) => void
  onCompany?: (companyId: string) => void
  onDialog?: (dialog: DocumentsDialog | null) => void
  onCreate?: (draft: SeriesDraft) => Promise<void> | void
  onSetStart?: (series: Series, startValue: number) => Promise<void> | void
  onAdvance?: (series: Series, input: { pastValue: number; reason: string; lastIssuedDate?: string }) => Promise<void> | void
  onCloseSeries?: (series: Series, reason: string) => Promise<void> | void
  /** The series ticked in the Numbers list. */
  onSelect?: (ids: string[]) => void
  /** Opens (ids) or closes (null) the "Close N series" confirm. */
  onCloseMany?: (seriesIds: readonly string[] | null) => void
  /** Closes the active series of the confirm, one call each; one notice says what was done. */
  onCloseManyGo?: (series: readonly Series[], reason: string) => Promise<void> | void
  onDismissNotice?: () => void
  onRetry?: () => void
  onRetryProof?: (seriesId: string) => void
  onSubmitStepUp?: (code: string) => void
  onCancelStepUp?: () => void
}

/**
 * SCR-014 — Admin › Documents & numbering (design 02 admin.documents; PLT-122, PLT-123, PLT-124): Numbers (each series
 * with its next number as it will print, its pattern as chips, whether it restarts every year, the fiscal lock; a row
 * opens the series; tick series to close several at once) and the Fiscal check (proof that invoices and DDTs have no
 * gaps), Documents (the fixed layouts, each previewed with the company's legal data in a new tab). Both lists are the
 * Office's list frame (Owner rule 2026-10-29); their keys — 1 / 2 switch the list, c adds a series — sit in the
 * frame's footer icon. Fetches nothing (DocumentsPage.tsx reads the API).
 */
export function DocumentsView({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  return (
    <AdminPageMessages namespace="admin-documents">
      <Documents model={model} actions={actions} />
    </AdminPageMessages>
  )
}

function useListKeys(model: DocumentsViewModel, actions?: DocumentsActions) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || model.closeMany) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="dialog"]'))) return
      if (event.key === '1') actions?.onView?.('numbers')
      else if (event.key === '2') actions?.onView?.('documents')
      else if (event.key === 'c' && !newSeriesHeld(model)) actions?.onDialog?.({ kind: 'new' })
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model, actions])
}

/** The page's own keys, listed in each list's footer icon (never above the table). */
function usePageKeys(): ListKey[] {
  const t = useT('admin-documents')
  return [
    { keys: ['1'], does: t('docs.keys.numbers') },
    { keys: ['2'], does: t('docs.keys.documents') },
    { keys: ['c'], does: t('docs.keys.newSeries') },
  ]
}

function Documents({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const ta = useT('admin')
  useListKeys(model, actions)
  const held = newSeriesHeld(model)
  const all = model.series.items ?? []
  const nameOf = (id: string) => {
    const series = all.find((row) => row.id === id)
    return series ? seriesName(t, series) : id
  }
  return (
    <div className="fw-adm fw-adm-docs">
      <PageHead
        intro={t('docs.intro')}
        asOf={model.asOf}
        actions={
          <>
            <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.({ kind: 'new' })}>
              {t('docs.new')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => actions?.onView?.('documents')}>
              {t('docs.preview')}
            </Button>
          </>
        }
      />
      <PageNotice namespace="admin-documents" notice={model.notice} onDismiss={actions?.onDismissNotice} nameOf={nameOf} />
      {model.view === 'numbers' ? <Numbers model={model} actions={actions} /> : <Layouts model={model} actions={actions} />}
      <p className="fw-adm-hint">{t('docs.later')}</p>
      <NewSeriesModal model={model} actions={actions} />
      <SeriesModal model={model} actions={actions} />
      <CloseSeriesModal model={model} actions={actions} />
      <CloseManyModal model={model} actions={actions} />
      <NumbersModal model={model} actions={actions} />
      <StepUp model={model.stepUp} onSubmit={actions?.onSubmitStepUp} onClose={actions?.onCancelStepUp} confirmLabel={ta('stepUp.confirm')} />
    </div>
  )
}

/** The frame's tools on both lists: which list, and which company. */
function ListTools({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const companies = (model.companies.items ?? []).filter((company) => company.status === 'ACTIVE')
  return (
    <>
      <SegmentedControl
        ariaLabel={t('docs.views.label')}
        size="sm"
        value={model.view}
        onChange={(value) => actions?.onView?.(value as ViewName)}
        options={[
          { value: 'numbers', label: t('docs.views.numbers') },
          { value: 'documents', label: t('docs.views.documents') },
        ]}
      />
      {companies.length > 1 && (
        <Select size="sm" aria-label={t('docs.company.label')} value={model.companyId} onChange={(event) => actions?.onCompany?.(event.target.value)}>
          <option value="all">{t('docs.company.all')}</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.legalName}
            </option>
          ))}
        </Select>
      )}
    </>
  )
}

/** The pattern as chips: fixed text, the year, the counter with its digits. */
export function PatternChips({ pattern, year }: { pattern: string; year?: number | null }) {
  const t = useT('admin-documents')
  const chips = patternChips(pattern)
  if (!chips) return <code className="fw-adm-code">{pattern}</code>
  const yearWords = (digits: 4 | 2) =>
    year ? t('docs.pattern.yearOf', { year: digits === 4 ? String(year) : String(year % 100).padStart(2, '0') }) : t(digits === 4 ? 'docs.pattern.year4' : 'docs.pattern.year2')
  return (
    <span className="fw-adm-docs-chips" aria-label={t('docs.pattern.aria', { pattern })}>
      {chips.map((chip, index) =>
        chip.kind === 'text' ? (
          <code key={index} className="fw-adm-code">
            {chip.text}
          </code>
        ) : (
          <TokenChip key={index}>{chip.kind === 'year' ? yearWords(chip.digits) : t('docs.pattern.counter', { count: chip.digits })}</TokenChip>
        ),
      )}
    </span>
  )
}

function companyName(model: Pick<DocumentsViewModel, 'companies'>, companyId: string) {
  return (model.companies.items ?? []).find((company) => company.id === companyId)?.legalName ?? null
}

/** "Invoice 2026 · MAIN": a series by its document, period and code. */
export function seriesName(t: (key: string) => string, series: Pick<Series, 'kind' | 'year' | 'scopeKey' | 'code'>): string {
  return `${t(kindKey(series.kind))} ${periodOf(series) ?? ''} · ${series.code}`.replace(/\s+·/, ' ·')
}

/** `?series=<id>` (or another dialog) on this page's address, keeping the list and the company. */
export function dialogHref(model: Pick<DocumentsViewModel, 'prefix' | 'view' | 'companyId'>, key: 'series' | 'numbers', id: string) {
  const query = new URLSearchParams()
  if (model.view !== 'numbers') query.set('view', model.view)
  if (model.companyId !== 'all') query.set('company', model.companyId)
  query.set(key, id)
  return `${adminHref(model.prefix, '/documents')}?${query.toString()}`
}

/** A series in the list: its document and period (a link to the series), its code and the fiscal lock. */
export function SeriesCell({ model, series }: { model: Pick<DocumentsViewModel, 'prefix' | 'view' | 'companyId'>; series: Series }) {
  const t = useT('admin-documents')
  const title = `${t(kindKey(series.kind))} ${periodOf(series) ?? ''}`.trim()
  return (
    <IdentityCell
      noImage
      title={title}
      titleAttr={title}
      href={dialogHref(model, 'series', series.id)}
      sub={
        <>
          <Tag>{t('docs.code', { code: series.code })}</Tag>
          {series.fiscal && (
            <Tag tone="info">
              <Lock size={11} aria-hidden /> {t('docs.fiscal.tag')}
            </Tag>
          )}
        </>
      }
    />
  )
}

/** The next number as it will print, or "Closed". */
export function NextCell({ series }: { series: Series }) {
  const t = useT('admin-documents')
  return series.status === 'CLOSED' ? <span className="fw-adm-hint">{t('docs.next.closed')}</span> : <code className="fw-adm-code">{dash(series.nextNumber)}</code>
}

/** The Numbers list's columns (one series per row); the company has a column while every company is listed. */
export function useSeriesColumns(model: Pick<DocumentsViewModel, 'prefix' | 'view' | 'companyId' | 'companies'>): ColDef<Series>[] {
  const t = useT('admin-documents')
  const locale = useLocale()
  const { prefix, view, companyId, companies } = model
  return useMemo<ColDef<Series>[]>(() => {
    const at = { prefix, view, companyId }
    return [
      { colId: 'document', headerName: t('docs.col.document'), flex: 1.6, minWidth: 165, cellRenderer: ({ data }: ICellRendererParams<Series>) => (data ? <SeriesCell model={at} series={data} /> : null) },
      ...(companyId === 'all'
        ? [{ colId: 'company', headerName: t('docs.company.label'), flex: 1.2, minWidth: 140, valueGetter: ({ data }: { data?: Series }) => (data ? (companyName({ companies }, data.companyId) ?? '—') : '') } satisfies ColDef<Series>]
        : []),
      { colId: 'next', headerName: t('docs.col.next'), flex: 1.3, minWidth: 160, cellRenderer: ({ data }: ICellRendererParams<Series>) => (data ? <NextCell series={data} /> : null) },
      { colId: 'pattern', headerName: t('docs.col.pattern'), flex: 2, minWidth: 275, cellRenderer: ({ data }: ICellRendererParams<Series>) => (data ? <PatternChips pattern={data.pattern} year={data.year} /> : null) },
      { colId: 'restarts', headerName: t('docs.col.restarts'), flex: 0.8, minWidth: 115, valueGetter: ({ data }) => (data ? t(data.reset === 'YEARLY' ? 'docs.reset.YEARLY' : 'docs.reset.NEVER') : '') },
      { colId: 'started', headerName: t('docs.col.started'), flex: 0.7, minWidth: 115, valueGetter: ({ data }) => (data ? String(data.startValue) : '') },
      { colId: 'lastIssued', headerName: t('docs.col.lastIssued'), flex: 1, minWidth: 150, valueGetter: ({ data }) => (data ? (data.lastIssuedDate ? formatDate(data.lastIssuedDate, { locale }) : t('docs.never')) : '') },
      {
        colId: 'state',
        headerName: t('docs.col.state'),
        flex: 0.7,
        minWidth: 95,
        cellRenderer: ({ data }: ICellRendererParams<Series>) =>
          data ? (
            <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`docs.status.${data.status}`)}</Pill>
          ) : null,
      },
    ]
  }, [t, locale, prefix, view, companyId, companies])
}

function Numbers({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const items = model.series.items
  const rows = useMemo(() => (items ? seriesRows(items, model.companyId, model.companies.items ?? []) : []), [items, model.companyId, model.companies.items])
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, rows.map((row) => row.id))
  const columns = useSeriesColumns(model)
  const own = usePageKeys()
  const { onHelp, help } = useKeysHelp(own, true)
  const reach = closeReach(rows.filter((row) => selected.includes(row.id)))
  const closeHeld = bulkHeld(reach, model.can.manage, { right: 'docs.held.manage', none: 'docs.bulk.none' })
  const held = newSeriesHeld(model)
  const state: ReactNode = model.series.problem ? (
    <ListProblem problem={model.series.problem} onRetry={actions?.onRetry} />
  ) : items && rows.length === 0 ? (
    <EmptyState
      icon={<Hash size={24} aria-hidden />}
      title={t('docs.empty.title')}
      description={t('docs.empty.body')}
      action={
        <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.({ kind: 'new' })}>
          {t('docs.new')}
        </Button>
      }
    />
  ) : undefined
  const fiscal = fiscalRows(rows)
  return (
    <div className="fw-adm-stack">
      <ListFrame<Series>
        label={t('docs.table.label')}
        rows={model.series.problem ? [] : items === null ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t('docs.count', { count: rows.length }) : '—'}
        tools={<ListTools model={model} actions={actions} />}
        selection={{
          selected,
          onChange,
          actions: (
            <BulkButton
              icon={<CircleOff size={13} aria-hidden />}
              label={reach.applies.length > 0 ? t('docs.bulk.close', { count: reach.applies.length }) : t('docs.bulk.closeNone')}
              held={closeHeld ? t(closeHeld) : null}
              variant="danger-outline"
              onClick={() => actions?.onCloseMany?.(selected)}
            />
          ),
        }}
        keys={own}
        onHelp={onHelp}
        onOpen={(row) => actions?.onDialog?.({ kind: 'series', seriesId: row.id })}
        state={state}
      />
      {items && rows.length > 0 && <FiscalCheck model={model} rows={fiscal} actions={actions} />}
      {help}
    </div>
  )
}

function FiscalCheck({ model, rows, actions }: { model: DocumentsViewModel; rows: readonly Series[]; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const ta = useT('admin')
  return (
    <Card padded>
      <div className="fw-adm-docs-fiscal">
        <div className="fw-adm-head-text">
          <h2 className="fw-adm-docs-h2">{t('docs.fiscal.title')}</h2>
          <p className="fw-adm-intro">{t('docs.fiscal.intro')}</p>
        </div>
        {rows.length === 0 ? (
          <p className="fw-adm-hint">{t('docs.fiscal.noSeries')}</p>
        ) : (
          <ul className="fw-adm-list">
            {rows.map((series) => {
              const read = model.proofs[series.id]
              const words = proofWords(series, read)
              return (
                <li key={series.id} className="fw-adm-docs-proof">
                  <span className="fw-adm-cell">
                    <span className="fw-adm-name">
                      {t(kindKey(series.kind))} {periodOf(series) ?? ''} · {t('docs.code', { code: series.code })}
                    </span>
                    {model.companyId === 'all' && <span className="fw-adm-hint">{dash(companyName(model, series.companyId))}</span>}
                  </span>
                  <span className="fw-adm-docs-proof-words" role="status">
                    <Pill tone={words.tone}>{t(`docs.fiscal.state.${words.tone}`)}</Pill> {t(words.key, words.params)}
                  </span>
                  <span className="fw-adm-actions">
                    {read?.state === 'failed' && (
                      <Button size="sm" variant="quiet" onClick={() => actions?.onRetryProof?.(series.id)}>
                        {ta('common.retry')}
                      </Button>
                    )}
                    {hasIssued(series) && (
                      <Link
                        className="fw-adm-docs-link"
                        href={dialogHref(model, 'numbers', series.id)}
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                          event.preventDefault()
                          actions?.onDialog?.({ kind: 'numbers', seriesId: series.id })
                        }}
                      >
                        {t('docs.fiscal.numbers')}
                      </Link>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}

/** A layout's previews: one link per language (a PDF in a new tab), held while the company's legal data is missing. */
export function PreviewCell({ company, type }: { company: CompanyOption; type: DocumentType }) {
  const t = useT('admin-documents')
  return (
    <span className="fw-adm-actions">
      {DOCUMENT_LANGUAGES.map((language) =>
        company.legalReady ? (
          <a key={language} className="fw-adm-docs-link" href={sampleHref(company.id, type, language)} target="_blank" rel="noopener noreferrer">
            {t(`docs.layouts.previewIn.${language}`)} <ExternalLink size={12} aria-hidden />
            <span className="fw-adm-sr">{t('docs.layouts.newTab')}</span>
          </a>
        ) : (
          <Button key={language} size="sm" variant="quiet" heldReason={t('docs.layouts.heldLegal')}>
            {t(`docs.layouts.previewIn.${language}`)}
          </Button>
        ),
      )}
    </span>
  )
}

/** The layouts list's columns (one fixed layout per row, previewed with `company`'s data). */
export function useLayoutColumns(company: CompanyOption | null): ColDef<DocumentType>[] {
  const t = useT('admin-documents')
  return useMemo<ColDef<DocumentType>[]>(
    () => [
      { colId: 'document', headerName: t('docs.layouts.col.document'), flex: 1.2, minWidth: 180, cellClass: 'fw-adm-name', valueGetter: ({ data }) => (data ? t(`docs.type.${data}`) : '') },
      { colId: 'layout', headerName: t('docs.layouts.col.layout'), flex: 1.6, minWidth: 220, cellClass: 'fw-adm-hint', valueGetter: () => t('docs.layouts.fixed') },
      {
        colId: 'preview',
        headerName: t('docs.layouts.col.preview'),
        flex: 1.2,
        minWidth: 220,
        cellRenderer: ({ data }: ICellRendererParams<DocumentType>) => (data && company ? <PreviewCell company={company} type={data} /> : null),
      },
    ],
    [t, company],
  )
}

function Layouts({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const company = sampleCompany(model)
  const columns = useLayoutColumns(company)
  const own = usePageKeys()
  const { onHelp, help } = useKeysHelp(own, false)
  const state: ReactNode = !model.can.documents ? (
    <EmptyState icon={<FileText size={24} aria-hidden />} title={t('docs.layouts.noRightTitle')} description={t('docs.layouts.noRight')} />
  ) : model.companies.problem ? (
    <ListProblem problem={model.companies.problem} onRetry={actions?.onRetry} />
  ) : model.companies.items !== null && !company ? (
    <EmptyState title={t('docs.layouts.noCompanyTitle')} description={t('docs.layouts.noCompany')} />
  ) : undefined
  return (
    <div className="fw-adm-stack">
      {model.can.documents && company && !company.legalReady && (
        <Banner
          tone="warning"
          title={t('docs.layouts.notReady', { name: company.legalName, count: company.legalMissing })}
          action={
            <Link className="fw-adm-docs-link" href={adminHref(model.prefix, `/companies/${company.id}?tab=legal`)}>
              {t('docs.layouts.fixLegal')}
            </Link>
          }
        />
      )}
      {model.can.documents && company && <p className="fw-adm-hint">{t('docs.layouts.with', { name: company.legalName })}</p>}
      <ListFrame<DocumentType>
        label={t('docs.layouts.label')}
        rows={state ? [] : model.companies.items === null ? null : DOCUMENT_TYPES}
        rowId={(type) => type}
        columns={columns}
        count={t('docs.layouts.count', { count: DOCUMENT_TYPES.length })}
        tools={<ListTools model={model} actions={actions} />}
        keys={own}
        onHelp={onHelp}
        state={state}
      />
      {help}
    </div>
  )
}

// ---- dialogs ----

function NewSeriesModal({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const words = useWords('admin-documents')
  const ta = useT('admin')
  const dialog = model.dialog?.kind === 'new' ? model.dialog : null
  const companies = (model.companies.items ?? []).filter((company) => company.status === 'ACTIVE')
  const firstCompany = model.companyId !== 'all' ? model.companyId : (companies[0]?.id ?? '')
  const [draft, setDraft] = useState<SeriesDraft>(() => dialog?.draft ?? newDraft(firstCompany))
  const [tried, setTried] = useState(dialog?.tried ?? false)
  const open = !!dialog
  useEffect(() => {
    if (open) {
      setDraft(dialog?.draft ?? newDraft(firstCompany))
      setTried(dialog?.tried ?? false)
    }
    // A new dialog starts a new draft; the draft itself is this dialog's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  if (!dialog) return null
  const problems = draftProblems(draft)
  const count = Object.keys(problems).length
  const shown = (field: keyof typeof problems) => (tried && problems[field] ? t(problems[field]!) : undefined)
  const first = draftPreview(draft)
  const set = (patch: Partial<SeriesDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const submit = () => {
    setTried(true)
    if (count === 0) void actions?.onCreate?.(draft)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('docs.newDialog.title')}
      subtitle={t('docs.newDialog.subtitle')}
      size="lg"
      busy={model.busy}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{ta('common.cancel')}</Button>
          <Button variant="primary" heldReason={tried && count > 0 ? ta('form.fixFirst', { count }) : model.busy ? ta('common.saving') : null} onClick={submit}>
            {t('docs.newDialog.create')}
          </Button>
        </>
      }
    >
      <form
        className="fw-adm-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      >
        {model.dialogProblem && <Banner tone="danger" title={words(model.dialogProblem)} />}
        <div className="fw-adm-form">
          <Field label={t('docs.field.company')} required error={shown('companyId')}>
            <Select autoFocus value={draft.companyId} onChange={(event) => set({ companyId: event.target.value })}>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.legalName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('docs.field.kind')} required>
            <Select value={draft.kind} onChange={(event) => setDraft(withKind(draft, event.target.value as SeriesDraft['kind'], 2026))}>
              {DOCUMENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(kindKey(kind))}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('docs.field.code')} hint={t('docs.field.codeHint')} required error={shown('code')}>
            <Input value={draft.code} onChange={(event) => set({ code: event.target.value.toUpperCase() })} maxLength={16} />
          </Field>
          <Field label={t('docs.field.reset')} required>
            <Select
              value={draft.reset}
              onChange={(event) => {
                const reset = event.target.value as SeriesDraft['reset']
                set({ reset, yearToken: reset === 'YEARLY' ? 'YYYY' : 'none' })
              }}
            >
              <option value="YEARLY">{t('docs.reset.YEARLY')}</option>
              <option value="NEVER">{t('docs.reset.NEVER')}</option>
            </Select>
          </Field>
          {draft.reset === 'YEARLY' && (
            <Field label={t('docs.field.year')} hint={t('docs.field.yearHint')} required error={shown('year')}>
              <Input inputMode="numeric" value={draft.year} onChange={(event) => set({ year: event.target.value })} maxLength={4} />
            </Field>
          )}
          <Field label={t('docs.field.start')} hint={t('docs.field.startHint')} required error={shown('start')}>
            <Input inputMode="numeric" value={draft.start} onChange={(event) => set({ start: event.target.value })} maxLength={10} />
          </Field>
        </div>
        <fieldset className="fw-adm-docs-builder">
          <legend className="fw-adm-name">{t('docs.field.pattern')}</legend>
          {draft.typed ? (
            <Field label={t('docs.field.typed')} hint={t('docs.field.typedHint')} error={shown('pattern')}>
              <Input className="fw-adm-code" value={draft.pattern} onChange={(event) => set({ pattern: event.target.value })} maxLength={40} />
            </Field>
          ) : (
            <div className="fw-adm-form">
              <Field label={t('docs.field.prefix')} error={shown('pattern')}>
                <Input value={draft.prefix} onChange={(event) => set({ prefix: event.target.value })} maxLength={12} />
              </Field>
              <Field label={t('docs.field.separator')}>
                <Select value={draft.separator} onChange={(event) => set({ separator: event.target.value })}>
                  {SEPARATORS.map((separator) => (
                    <option key={separator || 'none'} value={separator}>
                      {separator === '' ? t('docs.separator.none') : separator}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.reset === 'YEARLY' && (
                <Field label={t('docs.field.yearToken')}>
                  <Select value={draft.yearToken} onChange={(event) => set({ yearToken: event.target.value as SeriesDraft['yearToken'] })}>
                    {YEAR_TOKENS.map((token) => (
                      <option key={token} value={token}>
                        {t(`docs.yearToken.${token}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label={t('docs.field.digits')} error={shown('digits')}>
                <Input inputMode="numeric" value={draft.digits} onChange={(event) => set({ digits: event.target.value })} maxLength={2} />
              </Field>
            </div>
          )}
          <div className="fw-adm-docs-preview" role="status" aria-live="polite">
            <PatternChips pattern={draftPattern(draft)} year={draft.reset === 'YEARLY' ? Number.parseInt(draft.year, 10) || null : null} />
            <span>
              {t('docs.newDialog.first')} <strong className="fw-adm-code">{first ?? '—'}</strong>
            </span>
          </div>
          <span className="fw-adm-actions">
            <Button
            size="sm"
            variant="quiet"
            onClick={() => set(draft.typed ? { typed: false } : { typed: true, pattern: chipsPattern(draft) })}
          >
            {t(draft.typed ? 'docs.newDialog.useChips' : 'docs.newDialog.typeIt')}
          </Button>
          </span>
        </fieldset>
        {(draft.kind === 'INVOICE' || draft.kind === 'DDT' || draft.kind === 'DEPOSIT_INVOICE' || draft.kind === 'CREDIT_NOTE') && (
          <Banner tone="info" title={t('docs.newDialog.fiscal')} />
        )}
      </form>
    </Modal>
  )
}

function SeriesModal({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const words = useWords('admin-documents')
  const ta = useT('admin')
  const locale = useLocale()
  const dialog = model.dialog?.kind === 'series' ? model.dialog : null
  const series = dialog ? (model.series.items ?? []).find((row) => row.id === dialog.seriesId) : undefined
  const [start, setStart] = useState('')
  const [past, setPast] = useState('')
  const [pastDate, setPastDate] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (series) {
      setStart(String(series.startValue))
      setPast('')
      setPastDate('')
      setReason('')
    }
  }, [series])
  if (!dialog) return null
  if (!series) {
    return (
      <Modal open onClose={() => actions?.onDialog?.(null)} title={t('docs.seriesDialog.missing')} size="sm" footer={<Button onClick={() => actions?.onDialog?.(null)}>{ta('common.close')}</Button>}>
        <p className="fw-adm-intro">{ta('problem.notFound')}</p>
      </Modal>
    )
  }
  const editable = startEditable(series)
  const startValue = /^\d{1,10}$/.test(start.trim()) ? Number.parseInt(start, 10) : null
  const startPreview = startValue && startValue >= 1 ? preview(series.pattern, startValue, series.year) : null
  const pastValue = /^\d{1,10}$/.test(past.trim()) ? Number.parseInt(past, 10) : null
  const pastHeld = !model.can.manage ? t('docs.held.manage') : pastValue === null || pastValue < series.nextValue ? t('docs.advance.heldValue', { next: series.nextValue }) : reason.trim().length < 3 ? t('docs.advance.heldReason') : null
  const startHeld = !model.can.manage ? t('docs.held.manage') : startValue === null || startValue < 1 ? t('docs.form.start') : startValue === series.startValue ? t('docs.start.same') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('docs.seriesDialog.title', { kind: t(kindKey(series.kind)), period: periodOf(series) ?? t('docs.reset.NEVER') })}
      subtitle={dash(companyName(model, series.companyId))}
      size="lg"
      busy={model.busy}
      footer={
        <>
          {series.status === 'ACTIVE' && (
            <Button variant="danger" heldReason={model.can.manage ? null : t('docs.held.manage')} onClick={() => actions?.onDialog?.({ kind: 'close', seriesId: series.id })}>
              {t('docs.close.open')}
            </Button>
          )}
          <Button onClick={() => actions?.onDialog?.(null)}>{ta('common.close')}</Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={words(model.dialogProblem)} />}
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('docs.col.next'), value: series.status === 'CLOSED' ? t('docs.next.closed') : <code className="fw-adm-code">{dash(series.nextNumber)}</code> },
            { label: t('docs.col.pattern'), value: <PatternChips pattern={series.pattern} year={series.year} /> },
            { label: t('docs.col.restarts'), value: t(`docs.reset.${series.reset}`) },
            { label: t('docs.field.code'), value: series.code },
            { label: t('docs.col.started'), value: String(series.startValue) },
            { label: t('docs.col.lastIssued'), value: series.lastIssuedDate ? formatDate(series.lastIssuedDate, { locale }) : t('docs.never') },
            { label: t('docs.col.state'), value: t(`docs.status.${series.status}`) },
            { label: t('docs.seriesDialog.changed'), value: formatDateTime(series.updatedAt, { locale }) },
          ]}
        />
        {series.fiscal ? (
          <Banner tone="info" title={t('docs.seriesDialog.fiscal')}>{t('docs.seriesDialog.fiscalBody')}</Banner>
        ) : (
          <p className="fw-adm-hint">{t('docs.seriesDialog.notFiscal')}</p>
        )}
        {hasIssued(series) ? (
          <p className="fw-adm-hint">
            <Lock size={12} aria-hidden /> {t('docs.seriesDialog.fixed', { count: series.nextValue - series.startValue })}{' '}
            <Link className="fw-adm-docs-link" href={dialogHref(model, 'numbers', series.id)} onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              actions?.onDialog?.({ kind: 'numbers', seriesId: series.id })
            }}>
              {t('docs.fiscal.numbers')}
            </Link>
          </p>
        ) : null}
        {editable && (
          <section className="fw-adm-docs-section" aria-labelledby="docs-start">
            <h3 id="docs-start" className="fw-adm-name">
              {t('docs.start.title')}
            </h3>
            <p className="fw-adm-hint">{t('docs.start.body')}</p>
            <div className="fw-adm-docs-inline">
              <Field label={t('docs.field.start')}>
                <Input inputMode="numeric" value={start} onChange={(event) => setStart(event.target.value)} maxLength={10} />
              </Field>
              <span className="fw-adm-hint">
                {t('docs.newDialog.first')} <strong className="fw-adm-code">{startPreview ?? '—'}</strong>
              </span>
              <Button size="sm" variant="primary" heldReason={startHeld ?? (model.busy ? ta('common.saving') : null)} onClick={() => startValue && void actions?.onSetStart?.(series, startValue)}>
                {t('docs.start.save')}
              </Button>
            </div>
          </section>
        )}
        {series.status === 'ACTIVE' && (
          <Disclosure summary={t('docs.advance.title')} open={dialog.section === 'advance' || undefined}>
            <div className="fw-adm-modal-body">
              <p className="fw-adm-hint">{t('docs.advance.body', { next: series.nextNumber ?? String(series.nextValue) })}</p>
              <div className="fw-adm-form">
                <Field label={t('docs.advance.past')} hint={t('docs.advance.pastHint')}>
                  <Input inputMode="numeric" value={past} onChange={(event) => setPast(event.target.value)} maxLength={10} />
                </Field>
                <Field label={t('docs.advance.date')} hint={t('docs.advance.dateHint')}>
                  <Input type="date" value={pastDate} onChange={(event) => setPastDate(event.target.value)} />
                </Field>
                <Field label={t('docs.advance.reason')} className="fw-adm-form-wide">
                  <Textarea rows={2} limit={500} value={reason} onChange={(event) => setReason(event.target.value)} />
                </Field>
              </div>
              <span className="fw-adm-actions">
                <Button
                  size="sm"
                  heldReason={pastHeld ?? (model.busy ? ta('common.saving') : null)}
                  onClick={() => pastValue && void actions?.onAdvance?.(series, { pastValue, reason: reason.trim(), ...(pastDate ? { lastIssuedDate: pastDate } : {}) })}
                >
                  {t('docs.advance.go')}
                </Button>
              </span>
            </div>
          </Disclosure>
        )}
      </div>
    </Modal>
  )
}

function CloseSeriesModal({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const words = useWords('admin-documents')
  const ta = useT('admin')
  const [reason, setReason] = useState('')
  const dialog = model.dialog?.kind === 'close' ? model.dialog : null
  const series = dialog ? (model.series.items ?? []).find((row) => row.id === dialog.seriesId) : undefined
  useEffect(() => setReason(''), [dialog?.seriesId])
  if (!dialog || !series) return null
  const alone = !hasOtherActive(series, model.series.items ?? [])
  const name = `${t(kindKey(series.kind))} ${periodOf(series) ?? ''} · ${series.code}`.trim()
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.({ kind: 'series', seriesId: series.id })}
      title={t('docs.close.title', { name })}
      size="sm"
      busy={model.busy}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.({ kind: 'series', seriesId: series.id })}>{ta('common.cancel')}</Button>
          <Button variant="danger" heldReason={model.can.manage ? (model.busy ? ta('common.saving') : null) : t('docs.held.manage')} onClick={() => void actions?.onCloseSeries?.(series, reason.trim())}>
            {t('docs.close.go')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={words(model.dialogProblem)} />}
        <ul className="fw-adm-docs-consequences">
          <li>{t('docs.close.noMore')}</li>
          <li>{t('docs.close.stay')}</li>
          <li>{t('docs.close.final')}</li>
        </ul>
        {alone && <Banner tone="warning" title={t('docs.close.alone', { kind: t(kindKey(series.kind)) })} />}
        <Field label={ta('common.reason')} hint={ta('common.reasonHint')}>
          <Textarea rows={2} limit={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** A record type in words; a type without words of its own is shown as the API names it. */

/**
 * "Close N series" (bulk; each series is one `POST /numbering/series/:id/close` with its version): the same consequences
 * as closing one, the series it applies to, the selected ones it leaves out and why, and — for each company and
 * document that would be left without an active series — the warning before the click.
 */
function CloseManyModal({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const words = useWords('admin-documents')
  const ta = useT('admin')
  const [reason, setReason] = useState('')
  const ids = model.closeMany ?? null
  const key = ids?.join('|') ?? ''
  useEffect(() => setReason(''), [key])
  if (!ids) return null
  const all = model.series.items ?? []
  const chosen = ids.flatMap((id) => all.filter((row) => row.id === id))
  const reach = closeReach(chosen)
  const alone = leftWithout(reach.applies, all)
  const count = reach.applies.length
  const held = bulkHeld(reach, model.can.manage, { right: 'docs.held.manage', none: 'docs.bulk.none' })
  const close = () => actions?.onCloseMany?.(null)
  return (
    <Modal
      open
      onClose={close}
      title={t('docs.bulk.title', { count })}
      size="md"
      busy={model.busy}
      footer={
        <>
          <Button onClick={close}>{ta('common.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : model.busy ? ta('common.saving') : null} onClick={() => void actions?.onCloseManyGo?.(reach.applies, reason.trim())}>
            {t('docs.bulk.go', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={words(model.dialogProblem)} />}
        <BulkReach
          label={t('docs.bulk.listLabel')}
          names={reach.applies.map((series) => {
            const company = model.companyId === 'all' ? companyName(model, series.companyId) : null
            return company ? `${seriesName(t, series)} — ${company}` : seriesName(t, series)
          })}
          left={leftCounts(reach).map((entry) => ({ ...entry, words: t(entry.why, { count: entry.count }) }))}
        />
        <ul className="fw-adm-docs-consequences">
          <li>{t('docs.bulk.noMore')}</li>
          <li>{t('docs.bulk.stay')}</li>
          <li>{t('docs.close.final')}</li>
        </ul>
        {alone.map((entry) => (
          <Banner key={`${entry.companyId}-${entry.kind}`} tone="warning" title={t('docs.bulk.alone', { company: companyName(model, entry.companyId) ?? '—', kind: t(kindKey(entry.kind)) })} />
        ))}
        <Field label={ta('common.reason')} hint={t('docs.bulk.reasonHint')}>
          <Textarea rows={2} limit={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** A record type in words; a type without words of its own is shown as the API names it. */
function recordWord(t: (key: string) => string, recordType: string): string {
  const key = `docs.record.${recordType}`
  const words = t(key)
  return words === key ? recordType : words
}

/** The "numbers issued" list's columns (one number per row, newest first). */
export function useNumberColumns(): ColDef<Allocation>[] {
  const t = useT('admin-documents')
  const locale = useLocale()
  return useMemo<ColDef<Allocation>[]>(
    () => [
      { colId: 'number', headerName: t('docs.numbers.col.number'), flex: 1.2, minWidth: 160, cellClass: 'fw-adm-code', valueGetter: ({ data }) => data?.formatted ?? '' },
      { colId: 'date', headerName: t('docs.numbers.col.date'), flex: 1, minWidth: 130, valueGetter: ({ data }) => (data ? formatDate(data.documentDate, { locale }) : '') },
      { colId: 'record', headerName: t('docs.numbers.col.record'), flex: 1, minWidth: 120, valueGetter: ({ data }) => (data ? recordWord(t, data.recordType) : '') },
      { colId: 'who', headerName: t('docs.numbers.col.who'), flex: 1, minWidth: 140, valueGetter: ({ data }) => (data ? (data.allocatedByName ?? t('docs.numbers.system')) : '') },
      { colId: 'when', headerName: t('docs.numbers.col.when'), flex: 1.2, minWidth: 170, valueGetter: ({ data }) => (data ? formatDateTime(data.allocatedAt, { locale }) : '') },
    ],
    [t, locale],
  )
}

function NumbersModal({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  const t = useT('admin-documents')
  const ta = useT('admin')
  const columns = useNumberColumns()
  const { onHelp, help } = useKeysHelp([], false)
  const dialog = model.dialog?.kind === 'numbers' ? model.dialog : null
  const all = model.series.items ?? []
  const series = dialog ? all.find((row) => row.id === dialog.seriesId) : undefined
  if (!dialog) return null
  const nav = fiscalRows(seriesRows(all, model.companyId, model.companies.items ?? [])).filter(hasIssued)
  const numbers = model.numbers?.seriesId === dialog.seriesId ? model.numbers : null
  const read = numbers?.read
  const proof = numbers?.proof ?? null
  const items = read?.items ?? null
  const title = series ? t('docs.numbers.title', { kind: t(kindKey(series.kind)), period: periodOf(series) ?? '' }) : t('docs.seriesDialog.missing')
  return (
    <DetailModal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={title}
      subtitle={series ? dash(companyName(model, series.companyId)) : undefined}
      loading={!!read && read.items === null && !read.problem}
      error={read?.problem ? ta(read.problem) : undefined}
      onRetry={read?.problem ? () => actions?.onDialog?.({ kind: 'numbers', seriesId: dialog.seriesId }) : undefined}
      nav={nav.length > 1 && nav.some((row) => row.id === dialog.seriesId) ? { ids: nav.map((row) => row.id), current: dialog.seriesId, onGo: (id) => actions?.onDialog?.({ kind: 'numbers', seriesId: id }), noun: t('docs.numbers.noun') } : undefined}
    >
      <div className="fw-adm-modal-body">
        {proof && series && proof.skipped.length > 0 ? (
          <Banner tone="warning" title={t('docs.numbers.skippedTitle', { ranges: skippedWords(proof) })}>{t('docs.numbers.skippedBody')}</Banner>
        ) : proof && series && proof.count > 0 ? (
          <Banner tone="success" title={t('docs.fiscal.noGaps', { first: proof.firstFormatted ?? '', last: proof.lastFormatted ?? '', count: proof.count })} />
        ) : null}
        {items && (
          <ListFrame<Allocation>
            label={t('docs.numbers.label')}
            rows={items}
            rowId={(item) => item.formatted}
            columns={columns}
            count={proof ? t('docs.numbers.shown', { shown: items.length, count: proof.count }) : t('docs.numbers.count', { count: items.length })}
            onHelp={onHelp}
            rowKind="text"
            state={items.length === 0 ? <EmptyState title={t('docs.numbers.emptyTitle')} description={t('docs.numbers.empty')} /> : undefined}
          />
        )}
        {help}
      </div>
    </DetailModal>
  )
}
