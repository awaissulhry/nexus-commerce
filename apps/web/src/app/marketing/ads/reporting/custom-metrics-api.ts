/** RPT.12 — client contract for operator-defined metrics. */
import { getBackendUrl } from '@/lib/backend-url'
import type { ColumnFormat } from './report-api'

export interface CustomMetric {
  id: string
  reportId: string
  name: string
  formula: string
  format: ColumnFormat
  betterWhen: 'higher' | 'lower' | null
  description: string | null
  brokenReason: string | null
  usedMetrics: string[]
  createdAt: string
  updatedAt: string
}

const base = () => `${getBackendUrl()}/api/advertising/reporting/custom-metrics`

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

export const listCustomMetrics = (reportId: string) =>
  call<{ items: CustomMetric[] }>(`${base()}?reportId=${encodeURIComponent(reportId)}`).then((r) => r.items)

export const createCustomMetric = (input: Record<string, unknown>) =>
  call<CustomMetric>(base(), { method: 'POST', body: JSON.stringify(input) })

export const deleteCustomMetric = (id: string) =>
  call<{ ok: boolean }>(`${base()}/${id}`, { method: 'DELETE' })

export const previewFormula = (reportId: string, formula: string) =>
  call<{ ok: boolean; error: string | null; usedMetrics: string[] }>(
    `${base()}/preview?reportId=${encodeURIComponent(reportId)}&formula=${encodeURIComponent(formula)}`,
  )
