'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Select, SegmentedControl } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { FormulaComposer, type FormulaCandidate, type FormulaFunctionDoc, type FormulaPreviewResponse } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { formulaOperationRequest as request, operationPending, mergeFormulaOperation, operationLabel, type FormulaOperation } from './formulaOperations'
import styles from './formulaBulk.module.css'
import { languageField } from './languages'
import { languageLabel } from '../scopes'

type PreviewRow = { productId: string; ok: boolean; before?: unknown; value?: unknown; expectedState?: string; error?: string; applied?: boolean; unknown?: boolean; undone?: boolean }
const products = (count: number) => `${count} ${count === 1 ? 'product' : 'products'}`
const display = (value: unknown) => value == null || value === '' ? 'Empty' : typeof value === 'object' ? JSON.stringify(value) : String(value)

export function FormulaBulkDialog({ rows, columns, coordinate, candidatesFor, functions, preview, onClose, onApplied }: {
  rows: Array<{ id: string; label: string }>
  columns: Array<{ locale?: string; key: string; label: string; kind?: string; editable?: boolean; formulaWritable?: boolean; writeTarget?: string }>
  coordinate: { scope: 'master' | 'channel'; market: string; locale: string; channel?: string; marketplace?: string; channelConnectionId?: string; aliasKey?: string }
  candidatesFor: (rowId: string, fieldKey?: string) => FormulaCandidate[]; functions: FormulaFunctionDoc[]
  preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>
  onClose: () => void; onApplied: () => void
}) {
  const fields = useMemo(() => columns.filter(c => c.editable !== false && c.formulaWritable !== false), [columns])
  const [fieldKey, setFieldKey] = useState(fields.find(c => c.key === 'manufacturer')?.key ?? fields.find(c => c.key === 'name')?.key ?? fields[0]?.key ?? '')
  const [text, setText] = useState('=')
  const [mode, setMode] = useState<'once' | 'linked'>('once')
  const [results, setResults] = useState<PreviewRow[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [operation, setOperation] = useState<FormulaOperation | null>(null)
  const retryInput = useRef<Record<string, unknown> | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [applied, setApplied] = useState(false)
  const working = useRef(false)
  const labels = useMemo(() => new Map(rows.map(row => [row.id, row.label])), [rows])
  const field = fields.find(c => c.key === fieldKey)
  const sample = rows[0]?.id ?? ''
  const destination = { ...coordinate, ...languageField(fieldKey, coordinate.locale) }
  const samplePreview = useCallback(async (expr: string, signal?: AbortSignal): Promise<FormulaPreviewResponse> => {
    if (mode === 'linked') return preview(sample, fieldKey, expr, signal)
    const response = await fetch(`${getBackendUrl()}/api/pim/formulas/bulk/preview`, {
      method: 'POST', credentials: 'include', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...destination, expr, mode, rows: [{ productId: sample }] }),
    })
    const body = await response.json()
    return response.ok ? body.rows[0] : { ok: false, error: body.error ?? 'Could not check this formula.' }
  }, [preview, sample, fieldKey, mode, coordinate.scope, coordinate.channel, coordinate.marketplace, coordinate.market, coordinate.locale, coordinate.channelConnectionId, coordinate.aliasKey])
  const invalidate = () => { setResults([]); setError(null); setApplied(false); setProgress('') }
  const accept = (response: FormulaOperation) => {
    if (!mounted.current) return
    setOperation(current => mergeFormulaOperation(current, response))
    setResults(current => current.map(row => {
      const result = response.rows.find(result => result.productId === row.productId)
      return result ? { ...row, ...result, applied: result.status === 'applied', undone: result.status === 'restored', unknown: false } : row
    }))
    setProgress(`${operationLabel(response.status)} · ${response.processed} of ${products(response.total)} checked.`)
  }
  const advance = async (first: FormulaOperation) => {
    let response = first
    accept(response)
    while (mounted.current && operationPending(response)) {
      response = await request(`${response.operationId}/continue`)
      accept(response)
    }
    if (mounted.current) accept(await request(response.operationId, undefined, 'GET'))
  }
  const run = async (action: 'preview' | 'apply') => {
    if (working.current) return
    working.current = true; setBusy(true); setError(null)
    try {
      if (action === 'preview') {
        const next: PreviewRow[] = []
        for (let start = 0; start < rows.length && mounted.current; start += 20) {
          setProgress(`Checking ${start + 1}–${Math.min(start + 20, rows.length)} of ${products(rows.length)}…`)
          const response = await request<{ rows: PreviewRow[] }>('preview', { ...destination, expr: text, mode,
            rows: rows.slice(start, start + 20).map(row => ({ productId: row.id })) })
          next.push(...response.rows)
          if (mounted.current) setResults([...next])
        }
        if (mounted.current) setProgress(`${next.filter(row => row.ok).length} of ${products(rows.length)} ready.`)
      } else {
        setApplied(true)
        const input = retryInput.current ?? { operationId: crypto.randomUUID(), ...destination, expr: text, mode,
          rows: results.filter(row => row.ok).map(row => ({ productId: row.productId, label: labels.get(row.productId), expectedState: row.expectedState, expectedValue: row.value })) }
        retryInput.current = input
        await advance(await request('apply', input))
        retryInput.current = null
      }
    } catch (e) {
      if (mounted.current) setError(action === 'apply' ? `Connection interrupted. Use Check and continue to recover the saved progress. ${e instanceof Error ? e.message : String(e)}` : e instanceof Error ? e.message : String(e))
    } finally { working.current = false; if (mounted.current) { setBusy(false); if (action === 'apply') onApplied() } }
  }
  const resume = async (undo = false) => {
    if (working.current) return
    if (!operation) { void run('apply'); return }
    working.current = true; setBusy(true); setError(null)
    try {
      await advance(await request(`${operation.operationId}/${undo ? 'undo' : 'continue'}`))
      retryInput.current = null
    } catch (e) { if (mounted.current) setError(`Connection interrupted. Check and continue is safe to retry. ${e instanceof Error ? e.message : String(e)}`) }
    finally { working.current = false; if (mounted.current) { setBusy(false); onApplied() } }
  }
  const valid = results.filter(row => row.ok && !row.undone).length
  return <Modal open readable onClose={onClose} title={`Apply a formula · ${rows.length} ${rows.length === 1 ? 'product' : 'products'}`} size="xl"
    subtitle="Preview changes. Resume and undo later in More → Formula history."
    footer={<>
      {operation && ['APPLYING', 'SUCCESS', 'PARTIAL'].includes(operation.status) && <Button disabled={busy} onClick={() => void resume(true)}>Undo applied changes</Button>}
      {applied && (retryInput.current || (operation && operationPending(operation))) && <Button disabled={busy} onClick={() => void resume()}>Check and continue</Button>}
      <Button onClick={onClose}>Close</Button>
      <Button disabled={busy || applied || !fieldKey || text.trim() === '='} onClick={() => void run('preview')}>Preview products</Button>
      <Button variant="primary" disabled={busy || !valid || applied || results.length !== rows.length} onClick={() => void run('apply')}>Apply to {products(valid)}</Button>
    </>}>
    <div className={styles.content}>
      <label className={styles.field}>Field to update<Select value={fieldKey} disabled={busy || applied} onChange={event => { setFieldKey(event.target.value); invalidate() }}>
        {fields.map(column => <option key={column.key} value={column.key}>{column.label}{column.locale ? ` · ${languageLabel(column.locale)}` : ''}</option>)}
      </Select></label>
      {coordinate.scope === 'channel' && field?.writeTarget === 'master' && <p>This is a shared product field. Changes appear across channels.</p>}
      <SegmentedControl wrap ariaLabel="How to apply the formula" value={mode} disabled={busy || applied} onChange={value => { setMode(value as 'once' | 'linked'); invalidate() }}
        options={[{ value: 'once', label: 'Apply values once' }, { value: 'linked', label: 'Keep linked with formulas' }]} />
      <p>{mode === 'once' ? 'Replaces these cells with calculated values. Existing formulas are removed.' : 'Stores a formula in each cell. Values follow changes to its source fields.'}</p>
      <FormulaComposer showModeHelp={false} text={text} onChange={value => { setText(value.startsWith('=') ? value : `=${value}`); invalidate() }}
        candidates={candidatesFor(sample, fieldKey).filter(candidate => mode === 'once' || candidate.kind !== 'field' || candidate.name !== destination.fieldKey)}
        functions={functions} preview={samplePreview} linked={mode === 'linked'} disabled={busy || applied} allowText={field?.kind !== 'number'}
        sourceLabel={coordinate.scope === 'channel' ? `${coordinate.channel} · ${coordinate.marketplace} · ${destination.locale}` : `Shared product · ${destination.locale}`} />
      {rows.length > 1 && <p className={styles.note}>The result above previews {labels.get(sample)}. Preview products checks every selected row.</p>}
      <div role="status" aria-live="polite">{progress}</div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {results.length > 0 && <DataGrid keyboardScroll ariaLabel="Formula changes" rows={results} rowKey={row => row.productId}
        columns={[
          { key: 'product', label: 'Product', width: 200, render: row => <span className={styles.cell}>{labels.get(row.productId)}</span> },
          { key: 'before', label: 'Before', width: 250, render: row => <span className={styles.cell}>{display(row.before)}</span> },
          { key: 'after', label: 'After', width: 250, render: row => <span className={styles.cell}>{row.undone ? display(row.before) : row.unknown ? 'Check result' : row.error ? 'Previous value kept' : display(row.value)}</span> },
          { key: 'status', label: 'Status', width: 150, render: row => <span className={styles.cell}>{row.undone ? 'Restored' : row.error ?? (row.applied ? 'Applied' : applied ? 'Not applied' : 'Ready')}</span> },
        ]} />}
    </div>
  </Modal>
}
