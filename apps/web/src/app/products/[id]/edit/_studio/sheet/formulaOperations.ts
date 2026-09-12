import { getBackendUrl } from '@/lib/backend-url'
export type FormulaOperationRow = { productId: string; label?: string; ok: boolean; status: 'pending' | 'applied' | 'failed' | 'restored' | 'undo-refused' | 'not-applied'; before?: unknown; value?: unknown; error?: string }
export type FormulaOperation = { operationId: string; status: string; processed: number; total: number; createdAt?: string; fieldKey?: string; expr?: string; mode?: string; rows: FormulaOperationRow[] }
export const operationPending = (operation: Pick<FormulaOperation, 'status'>) => ['APPLYING', 'UNDOING'].includes(operation.status)
export const operationLabel = (status: string) => ({ APPLYING: 'Application in progress', SUCCESS: 'Applied', PARTIAL: 'Partly applied', FAILED: 'No changes applied', UNDOING: 'Undo in progress', UNDONE: 'Restored', UNDO_PARTIAL: 'Some newer changes were kept' }[status] ?? status)
export const rowStatusLabel = (row: FormulaOperationRow) => ({ pending: 'Waiting', applied: 'Applied', failed: 'Previous value kept', restored: 'Restored', 'undo-refused': 'Newer value kept', 'not-applied': 'Not applied' }[row.status])
export const displayFormulaValue = (value: unknown) => value == null || value === '' ? 'Empty' : typeof value === 'object' ? JSON.stringify(value) : String(value)
export async function formulaOperationRequest<T = FormulaOperation>(path: string, body?: unknown, method: 'POST' | 'GET' = 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${getBackendUrl()}/api/pim/formulas/bulk${path ? `${path.startsWith('?') ? '' : '/'}${path}` : ''}`, {
    method, credentials: 'include', signal, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'The operation could not be completed.')
  return result
}
export function mergeFormulaOperation(current: FormulaOperation | null, next: FormulaOperation): FormulaOperation {
  if (!current || current.operationId !== next.operationId) return next
  const rows = new Map(current.rows.map(row => [row.productId, row]))
  for (const row of next.rows) rows.set(row.productId, { ...rows.get(row.productId), ...row })
  return { ...current, ...next, rows: [...rows.values()] }
}
