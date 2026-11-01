'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, Pencil } from 'lucide-react'
import { Banner, Field, Menu, type DateFieldLabels, type ModalLabels } from '@nexus/ui/components'
import type { ReviewChangesLabels } from '@nexus/ui/patterns'
import { SelectionLabel, type ColDef } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Select } from '@nexus/ui/primitives'
import { DateField, Modal, ReviewChangesModal } from '../../lib/i18n/ds-parts'
import type { ExportFormat } from '@nexus/factory-domain/views/exports'
import { applyRowsOf, previewCounts, undoRowsOf, type BulkPreviewRow, type BulkResult, type BulkValue } from '@nexus/factory-domain/views/bulk/rules'
import { formatDate, formatNumber } from '../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../lib/i18n/locales'
import { ExportJobDialog } from '../tools/dialogs'
import { exportColumnsOf, isActiveJob } from '../tools/model'
import { problemOf, type ExportJob, type ListToolsTransport, type ToolsProblem } from '../tools/transport'
import { bulkHeldKey, conflictsOf, exportSelectedHeldKey, refusalKey, resultsByLine, reviewLinesOf, typedValue, valueProblemKey, valueText, type ListEdit, type ListEditField } from './model'

/**
 * Bulk edit with preview (B-W2b-13; PLT-182; design shell.lists pop:bulk-edit "Edit 12 work orders — fields to change
 * (only fields every selected row allows), then ReviewChangesModal with old → new per row and refusals per row",
 * sec:selection-row "→ ReviewChangesModal (old → new per row, conflicts) → Done with Undo") and the selection row's
 * Export N through the shared export engine (the W2a gap Z16:02). Both act on the rows the person selected:
 *
 *   Edit N    the fields of the list's edit (held with the reason where a selected row keeps one) → the review reads each
 *             row as it is now (old → new, the rows that already hold the value, the refusals, and the values someone
 *             changed since the list was read as conflicts) → Save writes each row through its own command with the
 *             version reviewed → Done counts what was saved, Undo puts back what changed.
 *   Export N  this view's columns, only the selected rows, as CSV or Excel: the export job's dialog follows it.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface BulkWords {
  review: ReviewChangesLabels
  doneVerb: string
  modal: ModalLabels
  dateField: DateFieldLabels
}

export interface BulkEditProps<T> {
  rows: readonly T[]
  rowId: (row: T) => string
  edit: ListEdit<T>
  columns: readonly ColDef<T>[]
  transport: ListToolsTransport
  listKey: string
  locale: Locale
  t: Translate
  words: BulkWords
  onClose: () => void
  /** Done: the selection is cleared (the list keeps its rows: each save went through onSaved). */
  onDone: () => void
  /** Design cases: the fields chosen and the step the dialog opens at. */
  start?: { values?: Record<string, BulkValue>; review?: boolean }
}

type ReviewState =
  | { phase: 'reading' }
  | { phase: 'failed'; error: string }
  | { phase: 'ready'; conflicts?: { label: string; was: string; now: string }[] }
  | { phase: 'saving'; done?: number }
  | { phase: 'done'; results: Record<string, { ok: boolean; words: string; verb?: string }> }

const headerOf = <T,>(columns: readonly ColDef<T>[], id: string): string | null => {
  const column = columns.find((entry) => (entry.colId ?? entry.field) === id)
  return typeof column?.headerName === 'string' ? column.headerName : null
}

/** "Edit N" in the selection row: held with the reason over the limit or without the right. */
export function BulkEditButton({ count, held, noun, t, onOpen }: { count: number; held: string | null; noun: { one: string; other: string }; t: Translate; onOpen: () => void }) {
  const limit = bulkHeldKey(count, held)
  const words = t('bulk.edit', { count, noun: count === 1 ? noun.one : noun.other })
  return (
    <Button size="sm" aria-label={words} heldReason={held ?? (limit ? t(limit.key, limit.params) : null)} onClick={onOpen}>
      <Pencil size={13} aria-hidden /> <SelectionLabel>{words}</SelectionLabel>
    </Button>
  )
}

export function BulkEditFlow<T>({ rows, rowId, edit, columns, transport, listKey, locale, t, words, onClose, onDone, start }: BulkEditProps<T>) {
  const ids = useMemo(() => rows.map(rowId), [rows, rowId])
  const noun = rows.length === 1 ? edit.bulk?.noun.one ?? '' : edit.bulk?.noun.other ?? ''
  const fields = Object.entries(edit.fields) as [string, ListEditField<T>][]
  const labelOf = (id: string) => edit.fields[id]?.label ?? headerOf(columns, id) ?? id
  const [chosen, setChosen] = useState<Record<string, boolean>>(() => Object.fromEntries(Object.keys(start?.values ?? {}).map((id) => [id, true])))
  const [values, setValues] = useState<Record<string, BulkValue>>(() => ({ ...(start?.values ?? {}) }))
  const [step, setStep] = useState<'form' | 'review'>(start?.review ? 'review' : 'form')
  const [preview, setPreview] = useState<readonly BulkPreviewRow[] | null>(null)
  const [state, setState] = useState<ReviewState>({ phase: 'reading' })
  const [results, setResults] = useState<readonly BulkResult[] | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState(false)
  const shown = useMemo(() => new Map(rows.map((row) => [rowId(row), row])), [rows, rowId])
  const day = (iso: string) => formatDate(`${iso}T12:00:00Z`, { locale })
  const number = (value: number) => formatNumber(value, locale)

  // Fields a selected row keeps (a closed record): held, with how many and why (never hidden).
  const heldOf = (field: ListEditField<T>): string | null => {
    const reasons = rows.map((row) => field.held?.(row) ?? null).filter((reason): reason is string => reason !== null)
    return reasons.length === 0 ? null : t('bulk.fieldHeld', { count: reasons.length, reason: reasons[0]! })
  }
  const changes = useMemo(() => Object.fromEntries(Object.entries(values).filter(([id]) => chosen[id])), [values, chosen])
  const problems = Object.entries(changes).flatMap(([id, value]) => {
    const spec = edit.fields[id]
    const key = spec ? valueProblemKey(spec, value) : null
    return key && spec ? [{ id, words: t(key, { min: spec.min ?? 0, max: spec.max ?? 0 }) }] : []
  })
  const formHeld = Object.keys(changes).length === 0 ? t('bulk.heldNoField') : problems.length > 0 ? t('bulk.heldProblem') : null

  const read = () => {
    setState({ phase: 'reading' })
    transport
      .bulkPreview({ listKey, ids, changes })
      .then((answer) => {
        setPreview(answer)
        const conflicts = conflictsOf(answer, shown, edit.fields).map((conflict) => {
          const spec = edit.fields[conflict.field]!
          return { label: `${conflict.label} · ${labelOf(conflict.field)}`, was: valueText(spec, conflict.was, day, number), now: valueText(spec, conflict.now, day, number) }
        })
        setState({ phase: 'ready', ...(conflicts.length ? { conflicts } : {}) })
      })
      .catch((error: unknown) => setState({ phase: 'failed', error: t(`tools.problem.${problemOf(error)}`) }))
  }
  const started = useRef(false)
  useEffect(() => {
    if (step === 'review' && !started.current) {
      started.current = true
      read()
    }
  })

  if (step === 'form') {
    return (
      <Modal
        open
        onClose={onClose}
        title={t('bulk.title', { count: rows.length, noun })}
        subtitle={t('bulk.subtitle')}
        size="md"
        labels={words.modal}
        footer={
          <>
            <span className="grow" />
            <Button onClick={onClose}>{t('bulk.cancel')}</Button>
            <Button variant="primary" heldReason={formHeld} onClick={() => setStep('review')}>
              {t('bulk.review', { count: rows.length })}
            </Button>
          </>
        }
      >
        <div
          className="fw-list-bulk"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !formHeld) {
              event.preventDefault()
              setStep('review')
            }
          }}
        >
          {fields.map(([id, field]) => {
            const held = heldOf(field)
            const on = !!chosen[id] && !held
            const label = labelOf(id)
            const problem = problems.find((entry) => entry.id === id)?.words ?? null
            return (
              <div key={id} className="fw-list-bulk-field">
                <Checkbox
                  checked={on}
                  disabled={held !== null}
                  aria-describedby={held ? `fw-bulk-held-${id}` : undefined}
                  onChange={(event) => setChosen((current) => ({ ...current, [id]: event.target.checked }))}
                  label={t('bulk.change', { field: label })}
                />
                {held && (
                  <p className="fw-list-bulk-held" id={`fw-bulk-held-${id}`}>
                    {held}
                  </p>
                )}
                {on && (
                  <Field label={t('bulk.newValue', { field: label })} error={problem} hint={field.nullable ? t('bulk.emptyHint') : undefined}>
                    {editorOf(field, values[id] ?? null, (next) => setValues((current) => ({ ...current, [id]: next })), locale, words.dateField, t)}
                  </Field>
                )}
              </div>
            )
          })}
        </div>
      </Modal>
    )
  }

  const lines = preview ? reviewLinesOf(preview) : []
  const counts = preview ? previewCounts(preview) : { changing: 0, unchanged: 0, refused: 0 }
  const refused = (preview ?? []).filter((row) => row.refusal !== null)
  const nameOf = (row: BulkPreviewRow) => row.label || (shown.get(row.id) ? edit.labelOf(shown.get(row.id)!) : row.id)
  const reviewChanges = lines.map((line) => {
    const spec = edit.fields[line.field]!
    return { id: line.id, where: line.label || nameOf({ id: line.rowId } as BulkPreviewRow), what: labelOf(line.field), now: valueText(spec, line.now, day, number), next: valueText(spec, line.next, day, number) }
  })
  const lead: ReactNode =
    refused.length > 0 || counts.unchanged > 0 ? (
      <div className="fw-list-bulk-lead">
        {counts.unchanged > 0 && <p className="fw-list-bulk-note">{t('bulk.unchanged', { count: counts.unchanged })}</p>}
        {refused.length > 0 && (
          <>
            <p className="fw-list-bulk-note">{t('bulk.refusedTitle', { count: refused.length })}</p>
            <ul className="fw-list-bulk-refused">
              {refused.map((row) => (
                <li key={row.id}>
                  <b>{nameOf(row)}</b> — {t(refusalKey(row.refusal!))}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    ) : undefined

  const wordsOf = (result: BulkResult, verb: 'saved' | 'undone') =>
    result.ok ? { ok: true, words: verb === 'undone' ? t('bulk.resultUndone') : t('bulk.resultSaved'), ...(verb === 'undone' ? { verb: t('bulk.verbUndone') } : {}) } : { ok: false, words: t(refusalKey(result.refusal ?? { code: 'failed' })), ...(verb === 'undone' ? { verb: t('bulk.verbUndone') } : {}) }
  const doneWith = (answer: readonly BulkResult[], verb: 'saved' | 'undone') => {
    const byLine = resultsByLine(lines, answer)
    setState({ phase: 'done', results: Object.fromEntries([...byLine].map(([id, result]) => [id, wordsOf(result, verb)])) })
  }

  const save = () => {
    if (!preview) return
    setState({ phase: 'saving' })
    transport
      .bulkApply({ listKey, rows: applyRowsOf(preview) }, transport.newKey())
      .then((answer) => {
        for (const result of answer) if (result.ok) edit.onSaved(result.id, result.after, result.version)
        setResults(answer)
        doneWith(answer, 'saved')
      })
      .catch((error: unknown) => setState({ phase: 'failed', error: t(`tools.problem.${problemOf(error)}`) }))
  }
  const undo = () => {
    if (!results) return
    const back = undoRowsOf(results)
    if (back.length === 0) return
    setUndoing(true)
    transport
      .bulkApply({ listKey, rows: back, undo: true }, transport.newKey())
      .then((answer) => {
        for (const result of answer) if (result.ok) edit.onSaved(result.id, result.after, result.version)
        setUndone(true)
        doneWith(answer, 'undone')
      })
      .catch((error: unknown) => setState({ phase: 'failed', error: t(`tools.problem.${problemOf(error)}`) }))
      .finally(() => setUndoing(false))
  }
  const finish = () => {
    onDone()
    onClose()
  }
  const canUndo = !!results && !undone && undoRowsOf(results).length > 0

  return (
    <ReviewChangesModal
      open
      onClose={state.phase === 'done' ? finish : onClose}
      changes={reviewChanges}
      state={state}
      title={t('bulk.reviewTitle', { count: rows.length, noun })}
      summary={t('bulk.summary')}
      metrics={preview ? [{ label: t('bulk.metric.changing'), value: String(counts.changing) }, { label: t('bulk.metric.unchanged'), value: String(counts.unchanged) }, { label: t('bulk.metric.refused'), value: String(counts.refused) }] : undefined}
      saveLabel={t('bulk.save', { count: counts.changing, noun: counts.changing === 1 ? edit.bulk?.noun.one ?? '' : edit.bulk?.noun.other ?? '' })}
      onSave={save}
      onRetry={read}
      {...(canUndo ? { onUndo: undo } : {})}
      undoing={undoing}
      onDone={finish}
      doneVerb={words.doneVerb}
      lead={lead}
      labels={words.review}
    />
  )
}

/** The value editor of one field in the bulk edit (DS controls; a day through the DS DateField). */
function editorOf<T>(field: ListEditField<T>, value: BulkValue, onChange: (value: BulkValue) => void, locale: Locale, dateWords: DateFieldLabels, t: Translate): ReactNode {
  switch (field.kind) {
    case 'date':
      return <DateField value={typeof value === 'string' ? value : ''} onChange={(next) => onChange(next || null)} clearable={field.nullable} locale={INTL_LOCALE[locale]} labels={dateWords} />
    case 'integer':
      return <Input size="sm" type="number" step={1} {...(field.min !== undefined ? { min: field.min } : {})} {...(field.max !== undefined ? { max: field.max } : {})} value={value === null ? '' : String(value)} onChange={(event) => onChange(typedValue(field, event.target.value))} />
    case 'choice':
      return (
        <Select size="sm" value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">{t('bulk.choose')}</option>
          {(field.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {field.choiceLabels?.[choice] ?? choice}
            </option>
          ))}
        </Select>
      )
    default:
      return <Input size="sm" value={typeof value === 'string' ? value : ''} maxLength={field.maxLength} onChange={(event) => onChange(typedValue(field, event.target.value))} />
  }
}

export interface ExportSelectedProps<T> {
  ids: readonly string[]
  columns: readonly ColDef<T>[]
  formats: readonly ExportFormat[]
  transport: ListToolsTransport
  listKey: string
  title: string
  t: Translate
  onReceipt: (message: string, tone?: 'success' | 'danger') => void
}

/** "Export N" in the selection row (Z16:02): this view's columns, the selected rows only, through the export engine. */
export function ExportSelected<T>({ ids, columns, formats, transport, listKey, title, t, onReceipt }: ExportSelectedProps<T>) {
  const [job, setJob] = useState<ExportJob | null>(null)
  const [problem, setProblem] = useState<ToolsProblem | null>(null)
  const polls = useRef(0)
  const held = exportSelectedHeldKey(ids.length)
  const label = t('exportSelected.label', { count: ids.length })

  useEffect(() => {
    if (!job || !isActiveJob(job.status)) return
    const timer = setTimeout(
      () => {
        polls.current++
        transport
          .readExport(job.id)
          .then(setJob)
          .catch((error: unknown) => setProblem(problemOf(error)))
      },
      polls.current < 10 ? 1000 : 2000,
    )
    return () => clearTimeout(timer)
  }, [job, transport])

  const start = (format: ExportFormat) => {
    transport
      .startExport({ listKey, format, query: transport.query, columns: exportColumnsOf(columns as never), title, ids: [...ids] }, transport.newKey())
      .then((next) => {
        polls.current = 0
        setProblem(null)
        setJob(next)
      })
      .catch((error: unknown) => onReceipt(t(`tools.problem.${problemOf(error)}`), 'danger'))
  }
  const usable = formats.filter((format) => format !== 'XLSX_REIMPORT')
  return (
    <>
      {held ? (
        <Button size="sm" aria-label={label} heldReason={t(held.key, held.params)}>
          <Download size={13} aria-hidden /> <SelectionLabel>{label}</SelectionLabel>
        </Button>
      ) : (
        <Menu
          label={
            <>
              <Download size={13} aria-hidden /> <SelectionLabel>{label}</SelectionLabel>
            </>
          }
          items={usable.map((format) => ({ id: `x-${format}`, label: t(`exportSelected.as.${format}`), onSelect: () => start(format) }))}
          triggerProps={{ className: 'nds-btn sm', 'aria-label': label }}
        />
      )}
      {job && (
        <ExportJobDialog
          job={job}
          problem={problem}
          onDownload={() => void transport.download(job).catch((error: unknown) => setProblem(problemOf(error)))}
          onAgain={() => start(job.format)}
          onClose={() => {
            setJob(null)
            setProblem(null)
          }}
        />
      )}
      {problem && !job && <Banner tone="danger" title={t(`tools.problem.${problem}`)} />}
    </>
  )
}
