import { z } from 'zod'
import { guestOverviewAnswer, guestPeriodAnswer, type GuestOverviewAnswer, type GuestPeriodAnswer, type GuestZipBody } from '@nexus/factory-domain/accounting/guest/contracts'
import type { ApiClient } from '../../../lib/api/client'
import { storeUrl } from '../../../record-panels/store'

/**
 * The accountant's room on B-W2b-201's API (the portal's own session; files only): the overview, a period, one file's
 * 60-second link (the API logs the download first), a zip the API writes for the whole period, its XML or the files chosen
 * (logged too). The shapes are factory-domain's contracts.
 */

export type Overview = GuestOverviewAnswer
export type PeriodRead = GuestPeriodAnswer

export const fetchOverview = (api: ApiClient, signal?: AbortSignal): Promise<Overview> => api.get('/portal/accounting', { schema: guestOverviewAnswer, signal })

export const fetchPeriod = (api: ApiClient, period: string, signal?: AbortSignal): Promise<PeriodRead> =>
  api.get(`/portal/accounting/periods/${encodeURIComponent(period)}`, { schema: guestPeriodAnswer, signal })

const fileLinkAnswer = z.object({
  file: z.object({ id: z.string(), name: z.string() }),
  download: z.object({ method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
})

/** One file: the API records the download, then answers a link that lives 60 seconds. */
export const fileLink = (api: ApiClient, fileId: string, period: string, idempotencyKey: string) =>
  api.post(`/portal/accounting/files/${encodeURIComponent(fileId)}/download`, { body: { period }, idempotencyKey, schema: fileLinkAnswer })

/** A zip the API writes now (never stored); the download is recorded. */
export const zipBytes = (api: ApiClient, body: GuestZipBody): Promise<Uint8Array> => api.bytes('/portal/accounting/zip', { method: 'POST', body })

/** Saves bytes or opens a presigned link as a file on this device (an anchor clicked once). */
export function saveAs(source: { readonly bytes: Uint8Array; readonly type: string } | { readonly url: string }, name: string): void {
  const href = 'url' in source ? storeUrl(source.url) : URL.createObjectURL(new Blob([source.bytes as BlobPart], { type: source.type }))
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  if (!('url' in source)) setTimeout(() => URL.revokeObjectURL(href), 30_000)
}
