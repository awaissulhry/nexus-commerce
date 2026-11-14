import { z } from 'zod'
import { componentsView, type ComponentsView } from '@nexus/factory-domain/costing/sheet-components/contracts'
import { goalSeekView } from '@nexus/factory-domain/costing/goal-seek/contracts'
import { bySizeView } from '@nexus/factory-domain/costing/size-weights/contracts'
import { compareView, versionAnswer, versionRecordView, versionsView } from '@nexus/factory-domain/costing/sheet-versions/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * Every call the style's Cost tab makes for the cost sheets of B-W2b-418 … B-W2b-423 (B-W2b-430), each answer checked
 * against the API's own contract (factory-domain costing/*): the versions of a style and one version with its lines, a new
 * version (from the components or a copy), the target kept on a draft, a draft removed, sent for approval, approved through
 * the approval engine, taken back, two versions compared, the goal-seek, the cost by size with its suggested surcharges
 * (applied as the style's own surcharge, sales' route), the live components of a revision, the open seasons. Money fields
 * are dropped by the API for a caller without their grain (cost, price, margin); the API's English words are not drawn.
 */

const enc = encodeURIComponent

export type VersionsView = z.infer<typeof versionsView>
export type VersionRow = VersionsView['versions'][number]
export type VersionRecord = z.infer<typeof versionRecordView>
export type CompareView = z.infer<typeof compareView>
export type GoalSeekView = z.infer<typeof goalSeekView>
export type BySizeView = z.infer<typeof bySizeView>
export type { ComponentsView }

/** The style's versions for one company (a style of every company: the company the page works in). */
export function listVersions(api: ApiClient, styleId: string, companyId: string | null, signal?: AbortSignal): Promise<VersionsView> {
  return api.get('/costing/cost-sheets', { query: { styleId, companyId: companyId ?? undefined }, schema: versionsView, signal })
}

export function readVersion(api: ApiClient, sheetId: string, signal?: AbortSignal): Promise<VersionRecord> {
  return api.get(`/costing/cost-sheets/${enc(sheetId)}`, { schema: versionRecordView, signal })
}

export interface NewVersionInput {
  styleId: string
  from: 'COMPONENTS' | 'COPY'
  revisionId?: string
  companyId?: string
  seasonId?: string | null
  basedOnId?: string
  baseSize?: string
  targetPrice?: string
  targetMarginPct?: string
  piecesPerCarton?: number
  note?: string
  colourwayId?: string
  leaveOutMissing?: boolean
}

export async function createVersion(api: ApiClient, body: NewVersionInput, idempotencyKey: string): Promise<VersionRow> {
  return (await api.post('/costing/cost-sheets', { body, schema: versionAnswer, idempotencyKey })).sheet
}

export async function keepTarget(api: ApiClient, sheet: Pick<VersionRow, 'id' | 'version'>, target: { targetPrice?: string | null; targetMarginPct?: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<VersionRow> {
  return (await api.request('PATCH', `/costing/cost-sheets/${enc(sheet.id)}`, { body: { version: sheet.version, ...target }, schema: versionAnswer, idempotencyKey })).sheet
}

export async function removeVersion(api: ApiClient, sheet: Pick<VersionRow, 'id' | 'version'>): Promise<void> {
  await api.request('DELETE', `/costing/cost-sheets/${enc(sheet.id)}`, { query: { version: sheet.version }, schema: z.object({ id: z.string(), removed: z.boolean() }), idempotencyKey: newIdempotencyKey() })
}

export async function submitVersion(api: ApiClient, sheet: Pick<VersionRow, 'id' | 'version'>, input: { note?: string; coveredByTyped?: boolean }, idempotencyKey: string): Promise<void> {
  await api.post(`/costing/cost-sheets/${enc(sheet.id)}/submit`, { body: { version: sheet.version, ...input }, idempotencyKey })
}

export async function takeBack(api: ApiClient, sheet: Pick<VersionRow, 'id' | 'version'>, reason: string, idempotencyKey: string): Promise<VersionRow> {
  return (await api.post(`/costing/cost-sheets/${enc(sheet.id)}/take-back`, { body: { version: sheet.version, reason }, schema: versionAnswer, idempotencyKey })).sheet
}

/** The approval engine's request behind a version (only what the Cost tab needs: who asked, whether I may decide). */
const taskSchema = z.object({
  task: z.object({
    id: z.string(),
    status: z.string(),
    version: z.number().int(),
    requester: z.object({ me: z.boolean() }),
    approve: z.object({ allowed: z.boolean() }),
  }),
})
export type ApprovalTask = z.infer<typeof taskSchema>['task']

export async function readTask(api: ApiClient, taskId: string, signal?: AbortSignal): Promise<ApprovalTask> {
  return (await api.get(`/approvals/tasks/${enc(taskId)}`, { schema: taskSchema, signal })).task
}

/** Approve and lock = the engine's yes on the version's request (the person who asked, or who made the version, is refused). */
export async function approveTask(api: ApiClient, task: Pick<ApprovalTask, 'id' | 'version'>, comment: string | null, idempotencyKey: string): Promise<void> {
  await api.post(`/approvals/tasks/${enc(task.id)}/approve`, { body: { version: task.version, comment: comment?.trim() || null }, idempotencyKey })
}

export function compareVersions(api: ApiClient, a: string, b: string, signal?: AbortSignal): Promise<CompareView> {
  return api.get('/costing/cost-sheets/compare', { query: { a, b }, schema: compareView, signal })
}

export interface GoalQuery {
  targetPrice?: string
  targetMarginPct?: string
  basis?: 'WEIGHTED' | 'BASE_SIZE' | 'SIZE'
  size?: string
}

export function goalSeek(api: ApiClient, sheetId: string, query: GoalQuery, signal?: AbortSignal): Promise<GoalSeekView> {
  return api.get(`/costing/cost-sheets/${enc(sheetId)}/goal-seek`, { query: { ...query }, schema: goalSeekView, signal })
}

export function readBySize(api: ApiClient, sheetId: string, signal?: AbortSignal): Promise<BySizeView> {
  return api.get(`/costing/cost-sheets/${enc(sheetId)}/by-size`, { schema: bySizeView, signal })
}

/** The style's own surcharge for one size (sales' route, pricelists.manage and the price grain); other sizes are left as they are. */
export async function setSurcharge(api: ApiClient, styleId: string, row: { size: string; amount: string; currency: string }): Promise<void> {
  await api.request('PUT', `/sales/styles/${enc(styleId)}/size-surcharges`, { body: { surcharges: [{ size: row.size, amount: row.amount, currency: row.currency, pct: null }] }, idempotencyKey: newIdempotencyKey() })
}

export function readComponents(api: ApiClient, input: { styleId: string; revisionId: string; companyId?: string | null; colourwayId?: string | null; piecesPerCarton?: number | null }, signal?: AbortSignal): Promise<ComponentsView> {
  return api.get(`/costing/styles/${enc(input.styleId)}/revisions/${enc(input.revisionId)}/components`, {
    query: { companyId: input.companyId ?? undefined, colourwayId: input.colourwayId ?? undefined, piecesPerCarton: input.piecesPerCarton ?? undefined },
    schema: componentsView,
    signal,
  })
}

const seasonSchema = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), status: z.string() })
export type SeasonOption = z.infer<typeof seasonSchema>

/** The company's open seasons (a new version's season). */
export async function openSeasons(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<SeasonOption[]> {
  return (await api.get('/sales/seasons', { query: { companyId, status: 'OPEN' }, schema: z.object({ seasons: z.array(seasonSchema) }), signal })).seasons
}
