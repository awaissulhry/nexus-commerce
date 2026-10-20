/**
 * Sponsored Display extras (P3c) — the advertiser's brand-safety deny list: the websites and apps where none of its
 * Sponsored Display ads may show, through sd-answer.ts `sdCall` (the channel gateway). Checked against Amazon's Sponsored
 * Display 3.0 OpenAPI (tag "Brand Safety List", read 2026-10-20) and its brand-safety guide:
 *
 *   ONE list per advertiser (the Amazon Ads profile): every SD campaign of the account in that market follows it.
 *   Available to sellers and vendors in Amazon Brand Registry in US, CA, UK, DE, ES, FR, IT, NL, BR, MX and UAE.
 *
 *   GET    /sd/brandSafety/deny?startIndex&count (≤ 1000)   { pagination { total, limit, offset }, domains: [{ domainId,
 *          name, type WEBSITE | APP, state ENABLED | ARCHIVED, createdAt, lastModified }] } — a change shows within 15 min
 *   POST   /sd/brandSafety/deny  { domains: [≤ 10,000 { name, type }] } → 202 { requestId } (asynchronous)
 *   DELETE /sd/brandSafety/deny  → 202 { requestId }: archives EVERY domain on the list (several hours). Amazon has no
 *          way to remove one domain: "delete the list and re-upload the list" (the guide).
 *   GET    /sd/brandSafety/status                 { requestStatusList: [{ requestId, timestamp, status, statusDetails }] } (90 days)
 *   GET    /sd/brandSafety/{requestId}/status     { requestStatus: { requestId, timestamp, status IN_PROGRESS | COMPLETED | FAILURE, statusDetails } }
 *   GET    /sd/brandSafety/{requestId}/results?startIndex&count  { results: [{ status SUCCESS | FAILURE, details, domainId, name }] }
 *          — only once COMPLETED, and only for an add (POST)
 *   A website is a domain (example.com also blocks its sub-domains), ASCII only; an app is an Android package id
 *   (com.example.app) or an iOS id (digits). No single web page.
 */
import type { ClientContext } from '../ads-api-client.js'
import { SdAmazonError, sdCall, seg } from './sd-answer.js'

const JSON_TYPE = 'application/json'
const call = <T>(ctx: ClientContext, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
  sdCall<T>({ profileId: ctx.profileId, region: ctx.region, method, path, ...(body !== undefined ? { body, contentType: JSON_TYPE } : {}), acceptHeader: JSON_TYPE })

/** Amazon's largest page of the deny list and of a request's results. */
export const SD_DENY_PAGE = 1000

type SdDenyType = 'WEBSITE' | 'APP'
export interface SdDenyDomain { domainId: string | null; name: string; type: string | null; state: string | null; createdAt: string | null }
export interface SdBrandSafetyRequest { requestId: string; at: string | null; status: string | null; details: string | null }

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const notUnderstood = (what: string) => new SdAmazonError(`Amazon's answer about ${what} was not understood, so Nexus cannot say what it holds.`)

/** One page of the deny list, and how many it holds in all. */
export async function listSdDenyList(ctx: ClientContext, opts: { startIndex?: number; count?: number } = {}): Promise<{ total: number | null; domains: SdDenyDomain[] }> {
  const answer = obj(await call<unknown>(ctx, 'GET', `/sd/brandSafety/deny?startIndex=${opts.startIndex ?? 0}&count=${opts.count ?? SD_DENY_PAGE}`))
  if (!Array.isArray(answer.domains)) throw notUnderstood('its brand-safety deny list')
  const total = obj(answer.pagination).total
  return {
    total: typeof total === 'number' && Number.isFinite(total) ? total : null,
    domains: answer.domains.map((raw) => {
      const d = obj(raw)
      return { domainId: text(d.domainId), name: text(d.name) ?? '?', type: text(d.type), state: text(d.state), createdAt: text(d.createdAt) }
    }),
  }
}

/** Domains and apps added to the list. Amazon answers with the request's id; the list shows them within 15 minutes. */
export async function addSdDenyDomains(ctx: ClientContext, domains: ReadonlyArray<{ name: string; type: SdDenyType }>): Promise<{ requestId: string }> {
  const requestId = text(obj(await call<unknown>(ctx, 'POST', '/sd/brandSafety/deny', { domains: domains.map((d) => ({ name: d.name, type: d.type })) })).requestId)
  if (!requestId) throw notUnderstood('the domains added (no request id)')
  return { requestId }
}

/** EVERY domain and app on the list archived (Amazon has no single remove). Amazon answers with the request's id. */
export async function clearSdDenyList(ctx: ClientContext): Promise<{ requestId: string }> {
  const requestId = text(obj(await call<unknown>(ctx, 'DELETE', '/sd/brandSafety/deny')).requestId)
  if (!requestId) throw notUnderstood('the list cleared (no request id)')
  return { requestId }
}

const requestOf = (raw: unknown): SdBrandSafetyRequest => {
  const r = obj(raw)
  return { requestId: text(r.requestId) ?? '?', at: text(r.timestamp), status: text(r.status), details: text(r.statusDetails) }
}

/** Every change of the list asked in the last 90 days, with its status. */
export async function sdBrandSafetyRequests(ctx: ClientContext): Promise<SdBrandSafetyRequest[]> {
  const list = obj(await call<unknown>(ctx, 'GET', '/sd/brandSafety/status')).requestStatusList
  if (!Array.isArray(list)) throw notUnderstood('the changes of its deny list')
  return list.map(requestOf)
}

/** One change of the list: its status. */
export async function sdBrandSafetyRequest(ctx: ClientContext, requestId: string): Promise<SdBrandSafetyRequest> {
  const answer = obj(await call<unknown>(ctx, 'GET', `/sd/brandSafety/${seg(requestId)}/status`))
  const status = answer.requestStatus ?? (answer.status ? answer : null)
  if (!status) throw notUnderstood(`request ${requestId}`)
  return { ...requestOf(status), requestId: text(obj(status).requestId) ?? requestId }
}

/** What an add did to each domain (SUCCESS or FAILURE, in Amazon's words), once it is COMPLETED. */
export async function sdBrandSafetyResults(ctx: ClientContext, requestId: string, opts: { startIndex?: number; count?: number } = {}): Promise<Array<{ name: string; status: string | null; details: string | null }>> {
  const list = obj(await call<unknown>(ctx, 'GET', `/sd/brandSafety/${seg(requestId)}/results?startIndex=${opts.startIndex ?? 0}&count=${opts.count ?? SD_DENY_PAGE}`)).results
  if (!Array.isArray(list)) throw notUnderstood(`the results of request ${requestId}`)
  return list.map((raw) => ({ name: text(obj(raw).name) ?? '?', status: text(obj(raw).status), details: text(obj(raw).details) }))
}
