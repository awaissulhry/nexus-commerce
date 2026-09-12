'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { displayFormulaValue, formulaOperationRequest as request, mergeFormulaOperation, operationLabel, operationPending, rowStatusLabel, type FormulaOperation } from './formulaOperations'
import styles from './formulaBulk.module.css'

type Summary = Omit<FormulaOperation, 'rows'>
export function FormulaHistoryDialog({ familyProductId, coordinate, onClose, onApplied }: {
  familyProductId: string
  coordinate: { scope: 'master' | 'channel'; market: string; locale: string; channel?: string; marketplace?: string; channelConnectionId?: string; aliasKey?: string }
  onClose: () => void
  onApplied: () => void
}) {
  const [operations, setOperations] = useState<Summary[]>([])
  const [selected, setSelected] = useState<FormulaOperation | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const working = useRef(false)
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(null)
    try {
      const query = new URLSearchParams({ familyProductId, ...coordinate })
      const data = await request<{ operations: Summary[] }>(`?${query}`, undefined, 'GET', signal)
      if (mounted.current && !signal?.aborted) setOperations(data.operations)
    } catch (e) { if (mounted.current && !signal?.aborted) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current && !signal?.aborted) setLoading(false) }
  }, [familyProductId, coordinate.scope, coordinate.market, coordinate.locale, coordinate.channel, coordinate.marketplace, coordinate.channelConnectionId, coordinate.aliasKey])
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void load(controller.signal)
    return () => { mounted.current = false; controller.abort() }
  }, [load])
  const open = async (id: string) => {
    if (working.current) return
    working.current = true; setBusy(true); setError(null)
    try { const operation = await request(id, undefined, 'GET'); if (mounted.current) setSelected(operation) }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { working.current = false; if (mounted.current) setBusy(false) }
  }
  const advance = async (undo: boolean) => {
    if (!selected || working.current) return
    working.current = true; setBusy(true); setError(null)
    try {
      let operation = await request(`${selected.operationId}/${undo ? 'undo' : 'continue'}`)
      if (mounted.current) setSelected(current => mergeFormulaOperation(current, operation))
      while (mounted.current && operationPending(operation)) {
        operation = await request(`${operation.operationId}/continue`)
        if (mounted.current) setSelected(current => mergeFormulaOperation(current, operation))
      }
      if (mounted.current) { setSelected(await request(operation.operationId, undefined, 'GET')); await load() }
    } catch (e) { if (mounted.current) setError(`Progress is saved. You can safely retry this action. ${e instanceof Error ? e.message : String(e)}`) }
    finally { working.current = false; if (mounted.current) { setBusy(false); onApplied() } }
  }
  return <Modal open readable onClose={onClose} title="Formula history" size="xl"
    subtitle="Recent operations for this product and scope. Resume interrupted work or restore previous values."
    footer={<>
      {selected && ['APPLYING', 'SUCCESS', 'PARTIAL'].includes(selected.status) && <Button disabled={busy} onClick={() => void advance(true)}>Undo applied changes</Button>}
      {selected && operationPending(selected) && <Button disabled={busy} onClick={() => void advance(false)}>Check and continue</Button>}
      <Button onClick={onClose}>Close</Button>
    </>}>
    <div className={styles.content}>
      {error && <p role="alert" className={styles.error}>{error} <Button onClick={() => void load()}>Retry history</Button></p>}
      {loading ? <p role="status">Loading formula history…</p> : operations.length === 0 ? <p>No saved formula operations for this scope yet.</p> : <DataGrid keyboardScroll ariaLabel="Saved formula operations" rows={operations} rowKey={row => row.operationId} columns={[
        { key: 'date', label: 'Started', render: row => <Button disabled={busy} onClick={() => void open(row.operationId)}>{row.createdAt ? new Date(row.createdAt).toLocaleString() : 'View operation'}</Button> },
        { key: 'field', label: 'Field', render: row => <span className={styles.cell}>{row.fieldKey}</span> },
        { key: 'formula', label: 'Formula', render: row => <span className={styles.cell}>={row.expr}</span> },
        { key: 'status', label: 'Status', render: row => <span className={styles.cell}>{operationLabel(row.status)} · {row.processed}/{row.total}</span> },
      ]} />}
      {selected && <>
        <p role="status" aria-live="polite">{operationLabel(selected.status)} · {selected.processed} of {selected.total} {selected.total === 1 ? 'product' : 'products'} checked.</p>
        <DataGrid keyboardScroll ariaLabel="Saved formula results" rows={selected.rows} rowKey={row => row.productId} columns={[
          { key: 'product', label: 'Product', render: row => <span className={styles.cell}>{row.label ?? row.productId}</span> },
          { key: 'before', label: 'Before', render: row => <span className={styles.cell}>{displayFormulaValue(row.before)}</span> },
          { key: 'after', label: 'Saved result', render: row => <span className={styles.cell}>{row.status === 'applied' || row.status === 'restored' ? displayFormulaValue(row.value) : '—'}</span> },
          { key: 'status', label: 'Status', render: row => <span className={styles.cell}>{row.error ?? rowStatusLabel(row)}</span> },
        ]} />
      </>}
    </div>
  </Modal>
}
