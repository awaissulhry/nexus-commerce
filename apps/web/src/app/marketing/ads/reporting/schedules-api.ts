/** RPT.6 — client contract for scheduled report delivery. */
import { getBackendUrl } from '@/lib/backend-url'

export const WINDOW_MODES = [
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'prevWeek', label: 'Previous week (Mon–Sun)' },
  { value: 'prevMonth', label: 'Previous calendar month' },
  { value: 'monthToDate', label: 'Month to date' },
  { value: 'saved', label: 'Fixed dates from the saved report' },
] as const

export interface Schedule {
  id: string
  savedReportId: string
  savedReportName: string
  reportId: string
  recipients: string
  format: string
  windowMode: string
  frequency: string
  hourLocal: number
  dayOfWeek: number | null
  dayOfMonth: number | null
  isActive: boolean
  lastSentAt: string | null
  lastStatus: string | null
  lastDelivery: {
    status: string; rows: number; staleNote: string | null; error: string | null; createdAt: string
  } | null
}

export interface Delivery {
  id: string
  status: string
  rows: number
  format: string
  recipients: string
  fileName: string | null
  fileBytes: number | null
  windowFrom: string | null
  windowTo: string | null
  staleNote: string | null
  error: string | null
  durationMs: number | null
  createdAt: string
}

export interface RunResult {
  status: 'SENT' | 'DRY_RUN' | 'FAILED'
  rows: number
  fileName: string | null
  staleNote: string | null
  error: string | null
}

const base = () => `${getBackendUrl()}/api/advertising/reporting/schedules`

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

export const listSchedules = () => call<{ items: Schedule[] }>(base()).then((r) => r.items)
export const listDeliveries = (id: string) =>
  call<{ items: Delivery[] }>(`${base()}/${id}/deliveries`).then((r) => r.items)
export const createSchedule = (input: Record<string, unknown>) =>
  call<Schedule>(base(), { method: 'POST', body: JSON.stringify(input) })
export const deleteSchedule = (id: string) =>
  call<{ ok: boolean }>(`${base()}/${id}`, { method: 'DELETE' })
export const runScheduleNow = (id: string) =>
  call<RunResult>(`${base()}/${id}/run`, { method: 'POST' })
