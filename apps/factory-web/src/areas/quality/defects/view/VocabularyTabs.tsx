'use client'

import { useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, RotateCcw, Sparkles, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Kbd, Pill, Select, TagGlyph, Toggle } from '@nexus/ui/primitives'
import { CellSaveMark, Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { Cause, Causes, Grade, Grades, HideDefect } from '../api'
import { markKey, type Mark, type ReadOf } from '../model'
import { deleteCauseHeld, PROCESSES, typedGradeCode, type NewCauseDraft, type NewGradeDraft, type VocabularyField } from '../vocabulary'
import { typedCode } from '../model'

/**
 * B-W2b-118: the W2b tabs of Defects & dispositions (design quality.defects df-causes, df-grades) on B-W2b-90's routes
 * (Severity, df-severity, is ../severity/view/SeverityWordsView.tsx since B-W2b-213: the tenant's words). Causes: the cause codes in the ONE list frame, words autosaved
 * per cell (Italian, English and every other floor language of the sites), the process fixed, retire / restore N, delete an
 * unused code, the starter set. Leather grades: the grades with their usable share (autosaved), retire / restore N, the
 * starter A–D; then the hide defects (the defect library's LEATHER codes for incoming and cutting), edited in the Defects
 * tab's drawer. Fetches nothing.
 */

export const VOCAB_NAMESPACE = 'defects-vocab'

/** A cell's mark: saving / unknown (the DS CellSaveMark), refused ("!" with its reason in words); nothing once saved. */
function VocabMark({ mark }: { mark: Mark | undefined }) {
  const t = useT(VOCAB_NAMESPACE)
  if (!mark || mark.state === 'saved') return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'problem.failed')
    return (
      <span className="fw-df-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

const cellKeys = () => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key.length === 1 && event.key !== ' '
}

function ReadFailed({ problem, onRetry }: { problem: string; onRetry?: () => void }) {
  const t = useT(VOCAB_NAMESPACE)
  return (
    <EmptyState
      title={t('read.failed')}
      description={t(problem)}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    />
  )
}

// ---- shared columns of a word list ------------------------------------------------------------------------------------------

interface WordsRow {
  readonly id: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly active: boolean
  readonly usedCount: number
  readonly missingLanguages: readonly string[]
}

function wordColumns<T extends WordsRow>(t: (key: string, params?: Record<string, string | number>) => string, languages: readonly string[], can: boolean, latest: { current: { marks: Readonly<Record<string, Mark>>; onCell?: (row: T, field: VocabularyField, value: unknown) => void } }): ColDef<T>[] {
  const mark = (id: string, field: string) => latest.current.marks[markKey(id, field)]
  const words = (field: 'labelIt' | 'labelEn' | `lang:${string}`, header: string): ColDef<T> => {
    const valueOf = (row: T) => (field === 'labelIt' ? row.labelIt : field === 'labelEn' ? row.labelEn : (row.labelI18n[field.slice(5)] ?? ''))
    return {
      colId: field,
      headerName: header,
      minWidth: 150,
      flex: 1.2,
      valueGetter: (params) => (params.data ? valueOf(params.data) : ''),
      ...(can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 80 } } : {}),
      cellRenderer: ({ data }: ICellRendererParams<T>) => {
        if (!data) return null
        const text = valueOf(data)
        const missing = field.startsWith('lang:') && !text
        return (
          <span className="fw-df-cell-row">
            <span className={missing ? 'fw-df-sub' : 'fw-df-words'}>{missing ? t('words.missing') : text}</span>
            <VocabMark mark={mark(data.id, field)} />
          </span>
        )
      },
      suppressKeyboardEvent: cellKeys(),
      valueSetter: (params) => {
        if (params.data) latest.current.onCell?.(params.data, field, params.newValue)
        return false
      },
    }
  }
  return [words('labelIt', t('col.it')), words('labelEn', t('col.en')), ...languages.map((language) => words(`lang:${language}`, t('col.language', { language: language.toUpperCase() })))]
}

function statusColumn<T extends WordsRow>(t: (key: string, params?: Record<string, string | number>) => string, can: boolean, latest: { current: { marks: Readonly<Record<string, Mark>>; onCell?: (row: T, field: VocabularyField, value: unknown) => void } }): ColDef<T> {
  return {
    colId: 'active',
    headerName: t('col.status'),
    minWidth: 150,
    flex: 0.8,
    cellRenderer: ({ data }: ICellRendererParams<T>) =>
      data ? (
        <span className="fw-df-cell-row">
          {can && <Toggle size="xs" checked={data.active} aria-label={t(data.active ? 'status.retireOf' : 'status.restoreOf', { code: data.code })} onChange={(next) => latest.current.onCell?.(data, 'active', next)} />}
          {data.active ? <span>{t('status.active')}</span> : <Pill tone="neutral">{t('status.retired')}</Pill>}
          <VocabMark mark={latest.current.marks[markKey(data.id, 'active')]} />
        </span>
      ) : null,
  }
}

const usedColumn = <T extends WordsRow>(t: (key: string, params?: Record<string, string | number>) => string): ColDef<T> => ({
  colId: 'used',
  headerName: t('col.used'),
  minWidth: 130,
  flex: 0.7,
  cellRenderer: ({ data }: ICellRendererParams<T>) => (data ? <span className={data.usedCount === 0 ? 'fw-df-sub' : undefined}>{data.usedCount === 0 ? t('used.none') : t('used.records', { count: data.usedCount })}</span> : null),
})

function MissingWords({ notes }: { notes: readonly { language: string; count: number }[] }) {
  const t = useT(VOCAB_NAMESPACE)
  if (notes.length === 0) return null
  return (
    <Banner tone="info" title={t('words.missingTitle')}>
      {notes.map((note) => t('words.missingIn', { language: note.language.toUpperCase(), count: note.count })).join(' · ')}
    </Banner>
  )
}

// ---- Causes -------------------------------------------------------------------------------------------------------------

export interface WordListActions<T> {
  onCell?: (row: T, field: VocabularyField, value: unknown) => void
  onSelect?: (ids: readonly string[]) => void
  onBulkActive?: (active: boolean) => void
  onExport?: (ids: readonly string[]) => void
  onStarter?: () => void
  onNew?: () => void
  onDelete?: (id: string) => void
  onKeys?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
}

function bulkButtons(t: (key: string, params?: Record<string, string | number>) => string, rows: readonly WordsRow[], selected: readonly string[], can: boolean, busy: boolean, actions: { onBulkActive?: (active: boolean) => void; onExport?: (ids: readonly string[]) => void } | undefined): ReactNode {
  const picked = rows.filter((row) => selected.includes(row.id))
  const held = (active: boolean): string | null => (!can ? t('held.noManage') : busy ? t('held.busy') : picked.length === 0 ? t('held.pickRows') : !picked.some((row) => row.active !== active) ? t(active ? 'held.allActive' : 'held.allRetired') : null)
  const count = selected.length
  return (
    <>
      <Button size="sm" heldReason={held(false)} onClick={() => actions?.onBulkActive?.(false)} aria-label={t('bulk.retire', { count })}>
        <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.retire', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={held(true)} onClick={() => actions?.onBulkActive?.(true)} aria-label={t('bulk.restore', { count })}>
        <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('bulk.restore', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(selected)} aria-label={t('bulk.export', { count })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
      </Button>
    </>
  )
}

export function CausesTab({ read, marks, selected, busy, updates, notes, actions }: { read: ReadOf<Causes>; marks: Readonly<Record<string, Mark>>; selected: readonly string[]; busy: boolean; updates: number; notes: readonly { language: string; count: number }[]; actions?: WordListActions<Cause> }) {
  const t = useT(VOCAB_NAMESPACE)
  const locale = useLocale()
  const value = read.value
  const can = value?.canManage ?? false
  const latest = useRef({ marks, onCell: actions?.onCell, actions })
  latest.current = { marks, onCell: actions?.onCell, actions }
  const marksKey = JSON.stringify(marks)
  const languages = value?.languages ?? []
  const columns = useMemo<ColDef<Cause>[]>(
    () => [
      {
        colId: 'code',
        headerName: t('col.code'),
        minWidth: 150,
        flex: 0.9,
        cellRenderer: ({ data }: ICellRendererParams<Cause>) =>
          data ? (
            <span className="fw-df-cell">
              <span className="fw-df-name is-static">{data.code}</span>
              <span className="fw-df-sub">{t('causes.fixed')}</span>
            </span>
          ) : null,
      },
      ...wordColumns<Cause>(t, languages, can, latest),
      { colId: 'process', headerName: t('col.process'), minWidth: 140, flex: 0.9, cellRenderer: ({ data }: ICellRendererParams<Cause>) => (data ? <Pill tone="neutral">{locale === 'it' ? data.processWords.it : data.processWords.en}</Pill> : null) },
      usedColumn<Cause>(t),
      statusColumn<Cause>(t, can, latest),
      {
        colId: 'actions',
        headerName: t('col.actions'),
        width: 72,
        minWidth: 72,
        suppressHeaderMenuButton: true,
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<Cause>) => {
          if (!data) return null
          const held = deleteCauseHeld(data, can)
          const items: MenuItemDef[] = [
            { id: 'active', label: t(data.active ? 'row.retire' : 'row.restore'), disabled: !can, description: can ? undefined : t('held.noManage'), onSelect: () => latest.current.onCell?.(data, 'active', !data.active) },
            { id: 'delete', label: t('row.delete'), disabled: !!held, description: held ? t(held.key, held.params) : undefined, onSelect: () => latest.current.actions?.onDelete?.(data.id) },
            { id: 'sep', separator: true },
            { id: 'copy', label: t('row.copyCode'), onSelect: () => void navigator.clipboard?.writeText(data.code) },
          ]
          return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { code: data.code }) }} items={items} />
        },
      },
    ],
    [t, locale, can, languages.join(','), marksKey],
  )
  const state: ReactNode = read.problem ? (
    <ReadFailed problem={read.problem} onRetry={actions?.onRetry} />
  ) : value && value.causes.length === 0 ? (
    <EmptyState
      title={t('causes.empty.title')}
      description={t('causes.empty.body', { count: value.starterMissing.length })}
      action={
        <span className="fw-df-actions">
          <Button size="sm" variant="primary" heldReason={can ? null : t('held.noManage')} onClick={() => actions?.onStarter?.()}>
            <Sparkles size={13} aria-hidden /> {t('starter.addCauses', { count: value.starterMissing.length })}
          </Button>
          <Button size="sm" heldReason={can ? null : t('held.noManage')} onClick={() => actions?.onNew?.()}>
            {t('causes.add')}
          </Button>
        </span>
      }
    />
  ) : undefined
  const keys: ListKey[] = [{ keys: ['c'], does: t('keys.addCause') }]
  return (
    <div className="fw-df-vocab">
      {value && value.starterMissing.length > 0 && value.causes.length > 0 && (
        <Banner
          tone="info"
          title={t('starter.causesTitle', { count: value.starterMissing.length })}
          action={
            <Button size="sm" heldReason={!can ? t('held.noManage') : busy ? t('held.busy') : null} onClick={() => actions?.onStarter?.()}>
              <Sparkles size={13} aria-hidden /> {t('starter.addCauses', { count: value.starterMissing.length })}
            </Button>
          }
        >
          {value.starterMissing.join(' · ')}
        </Banner>
      )}
      <MissingWords notes={notes} />
      <ListFrame<Cause>
        label={t('causes.table')}
        title={t('causes.title')}
        listKey="quality.defects.causes"
        rows={read.problem ? [] : value ? value.causes : null}
        rowId={(row) => row.id}
        columns={columns}
        count={!value ? t('common.loading') : t('causes.count', { count: value.causes.length })}
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkButtons(t, value?.causes ?? [], selected, can, busy, actions) }}
        updates={updates > 0 ? { count: updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={keys}
        onHelp={() => actions?.onKeys?.()}
        state={state}
      />
      <p className="fw-df-sub">{t('causes.footnote')}</p>
    </div>
  )
}

// ---- Leather grades and hide defects ------------------------------------------------------------------------------------

/** The usable share's cell: typed as a percent ("72,5"), saved on Enter or when the field is left. */
function ShareField({ row, label, onSave }: { row: Grade; label: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(row.usableShare)
  return (
    <Input
      size="sm"
      inputMode="decimal"
      className="fw-df-amount"
      aria-label={label}
      value={text}
      onFocus={() => setText(row.usableShare)}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') onSave(text)
        if (event.key === 'Escape') setText(row.usableShare)
      }}
      onBlur={() => text !== row.usableShare && onSave(text)}
    />
  )
}

export function GradesTab({ read, marks, selected, busy, updates, notes, prefix, actions }: { read: ReadOf<Grades>; marks: Readonly<Record<string, Mark>>; selected: readonly string[]; busy: boolean; updates: number; notes: readonly { language: string; count: number }[]; prefix: string; actions?: WordListActions<Grade> }) {
  const t = useT(VOCAB_NAMESPACE)
  const locale = useLocale()
  const value = read.value
  const can = value?.canManage ?? false
  const latest = useRef({ marks, onCell: actions?.onCell, actions })
  latest.current = { marks, onCell: actions?.onCell, actions }
  const marksKey = JSON.stringify(marks)
  const languages = value?.languages ?? []
  const columns = useMemo<ColDef<Grade>[]>(
    () => [
      {
        colId: 'code',
        headerName: t('col.grade'),
        minWidth: 110,
        flex: 0.6,
        cellRenderer: ({ data }: ICellRendererParams<Grade>) =>
          data ? (
            <span className="fw-df-cell">
              <span className="fw-df-name is-static">{data.code}</span>
              <span className="fw-df-sub">{t('grades.fixed')}</span>
            </span>
          ) : null,
      },
      ...wordColumns<Grade>(t, languages, can, latest),
      {
        colId: 'usableShare',
        headerName: t('col.usableShare'),
        minWidth: 160,
        flex: 0.9,
        suppressKeyboardEvent: () => true,
        cellRenderer: ({ data }: ICellRendererParams<Grade>) =>
          data ? (
            <span className="fw-df-cell-row">
              {can ? <ShareField row={data} label={t('grades.shareOf', { code: data.code })} onSave={(text) => latest.current.onCell?.(data, 'usableShare', text)} /> : <span>{data.usableShare}</span>}
              <span className="fw-df-sub">%</span>
              <VocabMark mark={latest.current.marks[markKey(data.id, 'usableShare')]} />
            </span>
          ) : null,
      },
      usedColumn<Grade>(t),
      statusColumn<Grade>(t, can, latest),
      {
        colId: 'actions',
        headerName: t('col.actions'),
        width: 72,
        minWidth: 72,
        suppressHeaderMenuButton: true,
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<Grade>) => {
          if (!data) return null
          const items: MenuItemDef[] = [
            { id: 'active', label: t(data.active ? 'row.retire' : 'row.restore'), disabled: !can, description: can ? t('grades.neverDeleted') : t('held.noManage'), onSelect: () => latest.current.onCell?.(data, 'active', !data.active) },
            { id: 'sep', separator: true },
            { id: 'copy', label: t('row.copyCode'), onSelect: () => void navigator.clipboard?.writeText(data.code) },
          ]
          return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { code: data.code }) }} items={items} />
        },
      },
    ],
    [t, locale, can, languages.join(','), marksKey],
  )
  const hideColumns = useMemo<ColDef<HideDefect>[]>(
    () => [
      {
        colId: 'code',
        headerName: t('col.code'),
        minWidth: 190,
        flex: 1.1,
        cellRenderer: ({ data }: ICellRendererParams<HideDefect>) =>
          data ? (
            <span className="fw-df-code">
              <TagGlyph icon={data.icon} color={data.colour} size={16} />
              <span className="fw-df-name is-static">{data.code}</span>
            </span>
          ) : null,
      },
      { colId: 'words', headerName: t('col.words'), minWidth: 200, flex: 1.6, valueGetter: (params) => (params.data ? (locale === 'it' ? params.data.labelIt : params.data.labelEn) : '') },
      { colId: 'severity', headerName: t('col.severity'), minWidth: 120, flex: 0.7, cellRenderer: ({ data }: ICellRendererParams<HideDefect>) => (data ? <Pill tone={data.severity === 'CRITICAL' ? 'danger' : data.severity === 'MAJOR' ? 'warning' : 'neutral'}>{t(`class.${data.severity}`)}</Pill> : null) },
      { colId: 'stages', headerName: t('col.stages'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.stages.length === 0 ? t('stages.every') : params.data.stages.map((stage) => t(`stage.${stage}`)).join(' · ')) : '') },
      { colId: 'active', headerName: t('col.status'), minWidth: 120, flex: 0.7, cellRenderer: ({ data }: ICellRendererParams<HideDefect>) => (data ? data.active ? <span>{t('status.active')}</span> : <Pill tone="neutral">{t('status.retired')}</Pill> : null) },
      {
        colId: 'open',
        headerName: t('col.actions'),
        minWidth: 150,
        flex: 0.8,
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<HideDefect>) => (data ? <Link href={`${prefix}/quality/defects?open=${encodeURIComponent(data.id)}`}>{t('hide.open')}</Link> : null),
      },
    ],
    [t, locale, prefix],
  )
  const state: ReactNode = read.problem ? (
    <ReadFailed problem={read.problem} onRetry={actions?.onRetry} />
  ) : value && value.grades.length === 0 ? (
    <EmptyState
      title={t('grades.empty.title')}
      description={t('grades.empty.body')}
      action={
        <span className="fw-df-actions">
          <Button size="sm" variant="primary" heldReason={can ? null : t('held.noManage')} onClick={() => actions?.onStarter?.()}>
            <Sparkles size={13} aria-hidden /> {t('starter.addGrades')}
          </Button>
          <Button size="sm" heldReason={can ? null : t('held.noManage')} onClick={() => actions?.onNew?.()}>
            {t('grades.add')}
          </Button>
        </span>
      }
    />
  ) : undefined
  const keys: ListKey[] = [{ keys: ['c'], does: t('keys.addGrade') }]
  return (
    <div className="fw-df-vocab">
      {value && value.starterMissing.length > 0 && value.grades.length > 0 && (
        <Banner
          tone="info"
          title={t('starter.gradesTitle', { count: value.starterMissing.length })}
          action={
            <Button size="sm" heldReason={!can ? t('held.noManage') : busy ? t('held.busy') : null} onClick={() => actions?.onStarter?.()}>
              <Sparkles size={13} aria-hidden /> {t('starter.addGrades')}
            </Button>
          }
        >
          {value.starterMissing.join(' · ')}
        </Banner>
      )}
      <MissingWords notes={notes} />
      <ListFrame<Grade>
        label={t('grades.table')}
        title={t('grades.title')}
        listKey="quality.defects.grades"
        rows={read.problem ? [] : value ? value.grades : null}
        rowId={(row) => row.id}
        columns={columns}
        count={!value ? t('common.loading') : t('grades.count', { count: value.grades.length })}
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkButtons(t, value?.grades ?? [], selected, can, busy, actions) }}
        updates={updates > 0 ? { count: updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={keys}
        onHelp={() => actions?.onKeys?.()}
        state={state}
      />
      <p className="fw-df-sub">{t('grades.footnote')}</p>
      <h2 className="fw-df-vocab-title">{t('hide.title')}</h2>
      <p className="fw-df-sub">{value?.hideCategory ? t('hide.intro', { category: value.hideCategory.code }) : t('hide.noCategory')}</p>
      <ListFrame<HideDefect>
        label={t('hide.table')}
        title={t('hide.title')}
        listKey="quality.defects.hide-defects"
        rows={read.problem ? [] : value ? value.hideDefects : null}
        rowId={(row) => row.id}
        columns={hideColumns}
        count={!value ? t('common.loading') : t('hide.count', { count: value.hideDefects.length })}
        state={value && value.hideDefects.length === 0 ? <EmptyState title={t('hide.empty.title')} description={t('hide.empty.body')} /> : undefined}
      />
    </div>
  )
}

// ---- dialogs ---------------------------------------------------------------------------------------------------------------

function DialogFooter({ busy, held, primary, onCreate, onClose }: { busy: boolean; held: string | null; primary: string; onCreate: () => void; onClose: () => void }) {
  const t = useT(VOCAB_NAMESPACE)
  return (
    <span className="fw-df-actions">
      <Button variant="secondary" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      <Button variant="primary" heldReason={busy ? t('held.busy') : held} onClick={onCreate}>
        {primary} <Kbd>⌘↵</Kbd>
      </Button>
    </span>
  )
}

export function NewCauseDialog({ open, draft, problems, problem, shown, busy, onDraft, onCreate, onClose }: { open: boolean; draft: NewCauseDraft; problems: Readonly<Record<string, string>>; problem: string | null; shown: boolean; busy: boolean; onDraft: (draft: NewCauseDraft) => void; onCreate: () => void; onClose: () => void }) {
  const t = useT(VOCAB_NAMESPACE)
  const locale = useLocale()
  if (!open) return null
  const at = (field: string) => (shown && problems[field] ? t(problems[field]!) : undefined)
  const first = Object.values(problems)[0]
  return (
    <Modal open onClose={onClose} size="md" title={t('causes.newTitle')} footer={<DialogFooter busy={busy} held={first ? t(first) : null} primary={t('causes.add')} onCreate={onCreate} onClose={onClose} />}>
      <div className="fw-df-vocab-stack" onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === 'Enter' && onCreate()}>
        <Field label={t('col.code')} hint={t('causes.codeHint')} error={at('code')} required>
          <Input size="sm" value={draft.code} autoFocus onChange={(event) => onDraft({ ...draft, code: typedCode(event.target.value) })} />
        </Field>
        <Field label={t('col.process')} hint={t('causes.processHint')} error={at('process')} required>
          <Select size="sm" value={draft.process ?? ''} onChange={(event) => onDraft({ ...draft, process: (event.target.value || null) as NewCauseDraft['process'] })}>
            <option value="">{t('causes.pickProcess')}</option>
            {PROCESSES.map((process) => (
              <option key={process} value={process}>
                {t(`process.${process}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('col.it')} error={at('labelIt')} required>
          <Input size="sm" value={draft.labelIt} lang="it" onChange={(event) => onDraft({ ...draft, labelIt: event.target.value })} />
        </Field>
        <Field label={t('col.en')} error={at('labelEn')} required>
          <Input size="sm" value={draft.labelEn} lang="en" onChange={(event) => onDraft({ ...draft, labelEn: event.target.value })} />
        </Field>
        <p className="fw-df-sub">{t('causes.otherLanguages', { language: locale.toUpperCase() })}</p>
        {problem && <Banner tone="danger" title={t(problem)} />}
      </div>
    </Modal>
  )
}

export function NewGradeDialog({ open, draft, problems, problem, shown, busy, onDraft, onCreate, onClose }: { open: boolean; draft: NewGradeDraft; problems: Readonly<Record<string, string>>; problem: string | null; shown: boolean; busy: boolean; onDraft: (draft: NewGradeDraft) => void; onCreate: () => void; onClose: () => void }) {
  const t = useT(VOCAB_NAMESPACE)
  if (!open) return null
  const at = (field: string) => (shown && problems[field] ? t(problems[field]!) : undefined)
  const first = Object.values(problems)[0]
  return (
    <Modal open onClose={onClose} size="md" title={t('grades.newTitle')} footer={<DialogFooter busy={busy} held={first ? t(first) : null} primary={t('grades.add')} onCreate={onCreate} onClose={onClose} />}>
      <div className="fw-df-vocab-stack" onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === 'Enter' && onCreate()}>
        <Field label={t('col.grade')} hint={t('grades.codeHint')} error={at('code')} required>
          <Input size="sm" value={draft.code} autoFocus onChange={(event) => onDraft({ ...draft, code: typedGradeCode(event.target.value) })} />
        </Field>
        <Field label={t('col.it')} error={at('labelIt')} required>
          <Input size="sm" value={draft.labelIt} lang="it" onChange={(event) => onDraft({ ...draft, labelIt: event.target.value })} />
        </Field>
        <Field label={t('col.en')} error={at('labelEn')} required>
          <Input size="sm" value={draft.labelEn} lang="en" onChange={(event) => onDraft({ ...draft, labelEn: event.target.value })} />
        </Field>
        <Field label={t('col.usableShare')} hint={t('grades.shareHint')} error={at('usableShare')} required>
          <Input size="sm" value={draft.usableShare} inputMode="decimal" onChange={(event) => onDraft({ ...draft, usableShare: event.target.value })} />
        </Field>
        {problem && <Banner tone="danger" title={t(problem)} />}
      </div>
    </Modal>
  )
}

export function DeleteCauseDialog({ open, cause, busy, onConfirm, onClose }: { open: boolean; cause: Cause | null; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const t = useT(VOCAB_NAMESPACE)
  if (!open || !cause) return null
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('causes.deleteTitle', { code: cause.code })}
      footer={
        <span className="fw-df-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={onConfirm}>
            {t('row.delete')}
          </Button>
        </span>
      }
    >
      <p>{t('causes.deleteBody')}</p>
    </Modal>
  )
}
