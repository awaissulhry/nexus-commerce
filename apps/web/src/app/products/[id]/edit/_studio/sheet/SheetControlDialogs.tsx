'use client'

/**
 * P1 — full control: the two questions the sheet asks before a bulk change (both sheets, `useSheetControl`).
 *
 *  - Delete on cells: "Clear" (an empty value of the cell's own, which hides what it inherits) or "Reset to inherited"
 *    (drop the cell's own value). Asked ONCE for the whole selection — AG used to store a blank silently.
 *  - "Set every row…" from a column's header menu: one value for the whole column, sent as ONE save.
 */
import { useEffect, useState } from 'react'
import { Field, Listbox, Modal, OptionList } from '@/design-system/components'
import { SELECT_CLEAR_LABEL } from '@/design-system/grid'
import { Button, Input, TagInput, Textarea } from '@/design-system/primitives'
import { clearChoiceWords, setColumnWords, type ClearChoice, type SetColumnFacts } from './sheetReset'
export type { SetColumnFacts } from './sheetReset'

export interface ClearChoiceRequest {
  subject: string
  clearable: number
  resettable: number
}

export function ClearOrResetDialog({ request, onChoose }: { request: ClearChoiceRequest | null; onChoose: (choice: ClearChoice | null) => void }) {
  if (!request) return null
  const words = clearChoiceWords(request)
  return (
    <Modal open size="sm" title={words.title} onClose={() => onChoose(null)} footer={<>
      {/* The Modal focuses `data-autofocus` on open. */}
      <Button size="sm" variant="secondary" data-autofocus={words.focus === 'cancel' || undefined} onClick={() => onChoose(null)}>Cancel</Button>
      <Button size="sm" variant={request.resettable ? 'secondary' : 'primary'} disabled={!request.clearable} onClick={() => onChoose('clear')}>{words.clearLabel}</Button>
      <Button size="sm" variant="primary" disabled={!request.resettable} data-autofocus={words.focus === 'reset' || undefined} onClick={() => onChoose('reset')}>{words.resetLabel}</Button>
    </>}>
      <div className="ps-dialog-body">
        <p>{words.clear}</p>
        <p>{words.reset}</p>
      </div>
    </Modal>
  )
}

export interface SetColumnRequest {
  column: SetColumnFacts
  /** Rows the value lands on (the rows shown, whose cell can be edited). */
  rows: number
  /** Rows shown whose cell is locked; they keep their value. */
  locked: number
}

type Draft = string | string[]

/** The value, as a paste would read it: the host runs the column's own parser on it (`useSheetControl`). */
export function SetColumnDialog({ request, onApply, onClose }: { request: SetColumnRequest | null; onApply: (raw: Draft | null) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>('')
  const [own, setOwn] = useState('')
  useEffect(() => { setDraft(request?.column.shape === 'list' ? [] : ''); setOwn('') }, [request])
  if (!request) return null
  const { column, rows, locked } = request
  const options = (column.options ?? []).map(value => ({ value, label: column.optionLabels?.[value] ?? value }))
  const list = column.shape === 'list'
  const choice = !list && (column.kind === 'select' || column.kind === 'boolean') && options.length > 0
  const value: Draft | null = choice && own.trim() ? own.trim() : Array.isArray(draft) ? (draft.length ? draft : null) : draft.trim() === '' ? null : draft
  const control = list
    ? options.length
      // An open list takes a value outside it, through the same `Add "…"` row as the cell's editor (audit B12).
      ? <OptionList options={options} value={Array.isArray(draft) ? draft : []} onChange={setDraft} searchable selectAll={false} allowCustom={column.mode === 'open'} />
      : <TagInput value={Array.isArray(draft) ? draft : []} onChange={setDraft} aria-label={column.label} placeholder="Add a value… (, adds)" />
    : choice
      ? <Listbox options={options} value={typeof draft === 'string' ? draft : ''} onChange={setDraft} searchable emptyLabel={SELECT_CLEAR_LABEL} ariaLabel={column.label} width="100%" />
      : column.kind === 'longtext'
        ? <Textarea value={typeof draft === 'string' ? draft : ''} onChange={e => setDraft(e.target.value)} rows={4} />
        : <Input value={typeof draft === 'string' ? draft : ''} onChange={e => setDraft(e.target.value)} inputMode={column.kind === 'number' ? 'decimal' : undefined} />
  const words = setColumnWords({ label: column.label, rows, locked }, value === null)
  return (
    <Modal open size="md" readable title={words.title} onClose={onClose} footer={<>
      <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
      <Button size="sm" variant="primary" disabled={rows === 0} onClick={() => onApply(value)}>{words.confirm}</Button>
    </>}>
      <div className="ps-dialog-body">
        <p>{words.lead}</p>
        <Field label={column.label} hint={list ? 'Leave it empty to clear every row.' : 'Leave it empty to clear every row. A value outside the list is kept and flagged, as a paste is.'}>{control}</Field>
        {choice && column.mode === 'open' && (
          <Field label="Or your own value" hint={`${column.label} takes a value that is not in the list.`}>
            <Input value={own} onChange={e => setOwn(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
