'use client'

/**
 * MS.4 — "set this column for every selected row".
 *
 * The master on this catalogue is nearly empty: five fields Amazon requires are absent across 251
 * rows, which is over a thousand edits one cell at a time. Selecting a family and setting
 * `country_of_origin` once is the difference between a sheet that demonstrates and a sheet that gets
 * used. It writes through the SAME endpoint a single cell uses, so there is no second write path to
 * keep honest.
 *
 * It reports THREE outcomes, never a single "done": updated, refused (the server said no, with its
 * reason) and skipped (the column does not apply to that row — a size on a parent is not an error,
 * it is a question that should not have been asked).
 */
import { useMemo, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'

import { Button, Input, Pill } from '@/design-system/primitives'
import { Listbox } from '@/design-system/components'

import type { SheetColumn, SheetRow } from './types'
import type { BulkSetResult } from './useMasterSheet'

export interface BulkSetControlProps {
  /** The rows currently ticked. */
  rows: SheetRow[]
  columns: SheetColumn[]
  applies: (row: SheetRow, column: SheetColumn) => boolean
  onApply: (column: SheetColumn, value: unknown) => Promise<BulkSetResult>
  onDone?: () => void
}

export function BulkSetControl({ rows, columns, applies, onApply, onDone }: BulkSetControlProps) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState<string>('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkSetResult | null>(null)

  // Only columns an operator can actually write, and only ones at least one selected row can hold.
  const options = useMemo(
    () =>
      columns
        .filter((c) => c.editable && c.defaultVisible && rows.some((r) => applies(r, c)))
        .map((c) => ({ value: c.key, label: c.requiredBy.length > 0 ? `${c.label} — required by ${c.requiredBy.join(', ')}` : c.label })),
    [columns, rows, applies],
  )
  const column = useMemo(() => columns.find((c) => c.key === key) ?? null, [columns, key])
  const willTouch = useMemo(() => (column ? rows.filter((r) => applies(r, column)).length : 0), [column, rows, applies])

  const run = async () => {
    if (!column) return
    setBusy(true)
    setResult(null)
    try {
      setResult(await onApply(column, value))
      onDone?.()
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)} title="Set one column across every selected row">
        Set for selection… <ChevronDown size={12} />
      </Button>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Listbox
        size="xs"
        options={options}
        value={key || undefined}
        onChange={(v) => { setKey(v); setResult(null) }}
        placeholder="Which column…"
        ariaLabel="Column to set"
      />
      {column && (
        column.options && column.options.length > 0 ? (
          <Listbox
            size="xs"
            options={column.options.map((o) => ({ value: o, label: column.optionLabels?.[o] ?? o }))}
            value={value || undefined}
            onChange={setValue}
            placeholder="Value…"
            ariaLabel="Value"
          />
        ) : (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={column.maxLength ? `Value (max ${column.maxLength})` : 'Value…'}
            aria-label="Value"
            style={{ width: 200 }}
          />
        )
      )}
      <Button size="sm" variant="primary" disabled={!column || busy || willTouch === 0} onClick={run}>
        {busy ? <Loader2 size={12} className="nds-spinner" /> : <Check size={12} />}
        {busy ? 'Setting…' : `Set ${willTouch} ${willTouch === 1 ? 'row' : 'rows'}`}
      </Button>
      <Button size="sm" variant="link" onClick={() => { setOpen(false); setResult(null); setKey(''); setValue('') }}>Cancel</Button>

      {result && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {result.error && <Pill tone="danger" size="sm">{result.error}</Pill>}
          {result.updated.length > 0 && <Pill tone="success" size="sm">{result.updated.length} set</Pill>}
          {result.refused.length > 0 && (
            <Pill tone="danger" size="sm" title={result.refused.slice(0, 5).map((r) => r.reason).join(' · ')}>
              {result.refused.length} refused
            </Pill>
          )}
          {result.skipped.length > 0 && (
            <Pill tone="neutral" size="sm" title={result.skipped.slice(0, 5).map((r) => r.reason).join(' · ')}>
              {result.skipped.length} not applicable
            </Pill>
          )}
        </span>
      )}
    </span>
  )
}
