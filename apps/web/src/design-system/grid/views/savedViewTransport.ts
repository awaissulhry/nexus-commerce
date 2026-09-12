import { isColumnsViewPayload, type ColumnsViewPayload } from './viewPayload'

export interface StoredSheetLayout<T = ColumnsViewPayload> {
  id: string
  name: string
  updatedAt: string
  filters: T
}

export interface WorkingLayoutWrite<T = unknown> {
  surface: string
  filters: T
  expectedUpdatedAt: string | null
}

export async function savedViewRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'include', cache: 'no-store' })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body?.error ?? body?.message ?? `Request failed (${response.status})`
    throw Object.assign(new Error(String(message)), { status: response.status })
  }
  return body as T
}

function isStoredLayout(value: unknown): value is StoredSheetLayout<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<StoredSheetLayout<unknown>>
  return typeof record.id === 'string' && record.id.length > 0 && typeof record.name === 'string' &&
    typeof record.updatedAt === 'string' && record.updatedAt.length > 0 && 'filters' in record
}

export async function loadWorkingLayout<T = ColumnsViewPayload>(
  baseUrl: string, surface: string, validate?: (value: unknown) => value is T,
): Promise<StoredSheetLayout<T> | null> {
  const body = await savedViewRequest<unknown>(`${baseUrl}/api/saved-views?surface=${encodeURIComponent(surface)}`)
  const items = body && typeof body === 'object' && !Array.isArray(body) ? (body as { items?: unknown }).items : undefined
  if (!Array.isArray(items) || !items.every(isStoredLayout)) {
    throw new Error('The saved layout list could not be read. The saved layout has been kept unchanged.')
  }
  const records = items.filter((v) => v.name === 'Current layout')
  if (records.length > 1) throw new Error('More than one current layout was returned. The saved layouts have been kept unchanged.')
  const record = records[0]
  if (!record) return null
  if (!(validate ?? isColumnsViewPayload)(record.filters)) {
    throw new Error('The saved layout has an unsupported format. It has been kept unchanged.')
  }
  // The caller's validator owns its payload type; existing sheet callers use the default validator.
  return record as StoredSheetLayout<T>
}

export async function saveWorkingLayout<T = ColumnsViewPayload>(
  baseUrl: string, surface: string, filters: T, previous: StoredSheetLayout<T> | null,
): Promise<StoredSheetLayout<T>> {
  const saved = await savedViewRequest<unknown>(`${baseUrl}/api/saved-views${previous ? `/${encodeURIComponent(previous.id)}` : ''}`, {
    method: previous ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Current layout', surface, filters, expectedUpdatedAt: previous?.updatedAt ?? null }),
  })
  if (!isStoredLayout(saved) || saved.name !== 'Current layout') {
    throw new Error('The server did not return a saved layout acknowledgement. Reload the saved layout before retrying.')
  }
  return saved as StoredSheetLayout<T>
}
