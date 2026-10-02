/**
 * MCP full control P5 — what the business keeps beside its catalog, read: the image library (photos, videos and
 * documents, with folders and tags), the saved views of its grids (and their alerts), and the history of its jobs
 * (imports, exports, bulk changes, catalog transfers). Plan section 09 §4.
 *
 * Read only and low risk: they read this business's own rows (row-level security and the workspace client) and call
 * no marketplace. What a person keeps for themselves stays theirs: saved views are the caller's own plus those shared
 * with the business, and imports are the caller's own, as Nexus shows them. A file's link, a job's download and a
 * view's raw grid state are never handed out; a deleted product's photos are left out of the library.
 */

import { z } from 'zod'
import type { BulkActionJob, ExportJob, ImportJob, Prisma } from '@prisma/client'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
} from '../../../lib/pagination/cursor.js'
import { listAssetFolders, listAssetLibrary, listAssetTags, VALID_ASSET_TYPES } from '../../assets/asset-library.service.js'
import { bulkActorNames } from '../../bulk-action-actor.js'
import type { ImportWizardService } from '../../import-wizard.service.js'
import type { AgentTool } from '../tool-types.js'
import { capped, personName, safeText, safeTextOrNull, safeValue } from './claude-safe.js'
import { listScope, listTool, newestFirstAfter, newestFirstPage, pageInMemory, pageSize } from './list-page.js'

const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)

const paging = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
    .describe(`rows per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
    .describe('nextCursor from the previous page, with the same arguments; omit it for the first page'),
}

// ── image-library ─────────────────────────────────────────────────────────────────────────────────────

const ASSET_TYPES = [...VALID_ASSET_TYPES] as [string, ...string[]]
/** The library merges two tables newest first and reads at most this many rows of each (asset-library.service.ts). */
const LIBRARY_WINDOW = 1000

const imageLibrary: AgentTool = {
  name: 'image-library',
  title: 'Image library',
  category: 'catalog',
  description:
    'The business\'s image library (photos, videos, documents and 3D files) together with the product photos, newest '
    + 'first: label, type, size and dimensions, where it is used (how many products, or the product a photo belongs '
    + 'to), and whether its upload check found a problem. Filter by type, folder, tags, used or unused, or a search; '
    + 'the first page also lists the folders and the tags in use. Photos of deleted products are left out. Read only: '
    + 'organising the library is a separate, approved change. Pages with a cursor.',
  input: z.object({
    type: z.preprocess(lower, z.enum(ASSET_TYPES)).optional().describe(`only this type: ${ASSET_TYPES.join(', ')}`),
    folderId: z.string().trim().min(1).max(64).optional().describe('only this folder (its id from a previous answer), or "unfiled" for files in no folder'),
    tagIds: z.array(z.string().trim().min(1).max(64)).min(1).max(20).optional().describe('only files carrying ALL of these tags (ids from a previous answer)'),
    usage: z.preprocess(lower, z.enum(['in_use', 'orphaned'])).optional().describe('in_use: used by a product; orphaned: used by none'),
    search: z.string().trim().min(1).max(100).optional().describe('text in the label, file name, caption, alt text, or the product\'s name or SKU'),
    ...paging,
  }),
  requires: [F.assetsManage],
  riskTier: 'low',
  readOnly: true,
  async handler(args) {
    return listTool('image-library', async () => {
      const size = pageSize(args.limit as number | undefined)
      const scope = listScope('image-library', args)
      const position = decodeCursor(scope, args.cursor as string | undefined)
      const page = position ? Number(position.values[0]) : 1
      if (position && (!Number.isInteger(page) || page < 2)) throw new InvalidCursorError()
      const library = await listAssetLibrary(
        {
          type: args.type as string | undefined,
          folderId: args.folderId as string | undefined,
          tagIds: (args.tagIds as string[] | undefined)?.join(','),
          usage: args.usage as string | undefined,
          search: args.search as string | undefined,
          page: String(page),
          pageSize: String(size),
        },
        { liveProductsOnly: true },
      )
      const reachable = page * size < LIBRARY_WINDOW
      const nextCursor = library.hasMore && reachable ? encodeCursor(scope, { values: [page + 1], id: 'page' }) : null
      const items = library.items.map((item) => ({
        id: item.id,
        source: item.source === 'digital_asset' ? 'library' : 'product photo',
        label: safeText(item.label, 160),
        type: item.type,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        width: item.width,
        height: item.height,
        ...(item.durationSeconds != null ? { durationSeconds: item.durationSeconds } : {}),
        usedBy: item.usageCount,
        ...(item.productSku ? { productSku: item.productSku, productName: safeTextOrNull(item.productName, 120), role: item.role } : {}),
        uploadCheckWarnings: item.hasQualityWarnings,
        url: item.url,
        createdAt: item.createdAt,
      }))
      let overview = {}
      if (page === 1) {
        const [{ folders }, { tags }] = await Promise.all([listAssetFolders(), listAssetTags()])
        const folderList = capped(folders.map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId, files: folder._count.assets })), 30)
        const tagList = capped(tags.filter((tag) => tag._count.assets > 0).map((tag) => ({ id: tag.id, name: tag.name, files: tag._count.assets })), 30)
        overview = {
          folders: folderList.items,
          ...(folderList.more ? { moreFolders: folderList.more } : {}),
          tags: tagList.items,
          ...(tagList.more ? { moreTags: tagList.more } : {}),
        }
      }
      return {
        ok: true,
        data: {
          items,
          nextCursor,
          total: library.total,
          ...(library.hasMore && !reachable
            ? { hint: `${library.total} files match; only the newest ${LIBRARY_WINDOW} can be paged. Narrow with type, folderId, tagIds or search.` }
            : nextCursor ? { hint: `${library.total} files match. To go on, call again with cursor set to nextCursor (same arguments).` } : {}),
          ...overview,
        },
      }
    })
  },
}

// ── saved-views ───────────────────────────────────────────────────────────────────────────────────────

/** The owner of the shared templates that predate per-person views (saved-views/persistence.service.ts). */
const LEGACY_OWNER = 'default-user'
/** A grid's working layout ("Current layout") is a person's screen state, not a view anyone named. */
const WORKING_SURFACE: Prisma.SavedViewWhereInput[] = [
  { NOT: { surface: { startsWith: 'product-edit:layout:' } } },
  { NOT: { surface: 'products-next:layout' } },
]
/** Surfaces whose views hold product filters (search, status, channel, …) rather than a grid's columns. */
const FILTER_SURFACES = new Set(['products', 'outbound.pending'])

/** What a view filters on or shows: the filters of a filter view; the column count of a grid layout. */
function viewContent(surface: string, filters: unknown): Record<string, unknown> {
  if (FILTER_SURFACES.has(surface)) return { filters: safeValue(filters) }
  const record = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>
  const layout = (record.page as Record<string, unknown> | undefined)?.columnLayout as Record<string, unknown> | undefined
  const columns = Array.isArray(record.columns) ? record.columns : Array.isArray(layout?.columns) ? layout!.columns as unknown[] : null
  return columns ? { columns: columns.length } : {}
}

const savedViews: AgentTool = {
  name: 'saved-views',
  title: 'Saved views',
  category: 'catalog',
  description:
    'The saved views of the grids (products, the product sheet, outbound orders, …): your own, and those shared with '
    + 'the business by a teammate (named) — each with what it filters on (or how many columns it shows), whether it '
    + 'is a default, and your alerts on it (threshold, last count, last fired). A products view\'s id can be handed '
    + 'to product-search as savedViewId. Read only: saving views and alerts is a separate, approved change. Pages '
    + 'with a cursor.',
  input: z.object({
    surface: z.string().trim().min(1).max(250).optional().describe('only the views of this grid, e.g. products or outbound.pending'),
    ...paging,
  }),
  requires: [F.productsView],
  riskTier: 'low',
  readOnly: true,
  async handler(args, ctx) {
    return listTool('saved-views', async () => {
      const me = ctx.userId ?? null
      const surface = args.surface as string | undefined
      const views = await prisma.savedView.findMany({
        where: {
          AND: [
            ...WORKING_SURFACE,
            ...(surface ? [{ surface }] : []),
            ...(me ? [{ OR: [{ userId: me }, { userId: LEGACY_OWNER }, { shared: true }] }] : []),
          ],
        },
        take: 2000,
        select: { id: true, userId: true, surface: true, name: true, filters: true, isDefault: true, shared: true, defaultProductTypes: true, updatedAt: true },
      })
      const page = pageInMemory(views, (view) => `${view.surface.slice(0, 200)}\u0001${view.name.toLowerCase().slice(0, 200)}\u0001${view.id}`, args, listScope('saved-views', args))
      const others = [...new Set(page.items.filter((view) => view.userId !== me && view.userId !== LEGACY_OWNER).map((view) => view.userId))]
      const [people, alerts] = await Promise.all([
        others.length ? prisma.userProfile.findMany({ where: { id: { in: others } }, select: { id: true, displayName: true } }) : [],
        page.items.length
          ? prisma.savedViewAlert.findMany({
              where: { savedViewId: { in: page.items.map((view) => view.id) }, ...(me ? { userId: me } : {}) },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { savedViewId: true, name: true, isActive: true, comparison: true, threshold: true, lastCount: true, lastCheckedAt: true, lastFiredAt: true, cooldownMinutes: true },
            })
          : [],
      ])
      const names = new Map<string, string>(people.map((person): [string, string] => [person.id, personName(person.displayName)]))
      return {
        ok: true,
        data: {
          ...page,
          items: page.items.map((view) => {
            const owned = me === null || view.userId === me
            const legacy = view.userId === LEGACY_OWNER
            const mine = alerts.filter((alert) => alert.savedViewId === view.id)
            return {
              id: view.id,
              name: view.name,
              surface: view.surface,
              owned,
              ...(!owned ? { sharedBy: legacy ? 'a shared template' : names.get(view.userId) ?? personName(null) } : {}),
              sharedWithBusiness: view.shared,
              isDefault: owned && view.isDefault,
              ...(view.defaultProductTypes.length ? { defaultForProductTypes: view.defaultProductTypes } : {}),
              ...viewContent(view.surface, view.filters),
              updatedAt: iso(view.updatedAt),
              alerts: mine.slice(0, 10).map((alert) => ({
                name: alert.name,
                active: alert.isActive,
                when: alert.comparison,
                threshold: Number(alert.threshold),
                lastCount: alert.lastCount,
                lastCheckedAt: iso(alert.lastCheckedAt),
                lastFiredAt: iso(alert.lastFiredAt),
                cooldownMinutes: alert.cooldownMinutes,
              })),
            }
          }),
        },
      }
    })
  },
}

/**
 * MCP full control P5 — a saved view a caller may apply (product-search `savedViewId`): their own, a shared template,
 * or one a teammate shared with the business — in this business only (row-level security). Null when none is.
 */
export async function visibleSavedView(id: string, userId: string | null | undefined) {
  return prisma.savedView.findFirst({
    where: { id, ...(userId ? { OR: [{ userId }, { userId: LEGACY_OWNER }, { shared: true }] } : {}) },
    select: { id: true, name: true, surface: true, filters: true },
  })
}

// ── job-history ───────────────────────────────────────────────────────────────────────────────────────

const JOB_KINDS = ['import', 'export', 'bulk', 'transfer'] as const
type JobKind = (typeof JOB_KINDS)[number]
/** The import wizard's own kinds; a catalog transfer (Catalog import) is `transfer`. */
const IMPORT_KINDS = ['product', 'channelListing', 'inventory']
/** listJobs' status words (bulk-action.service.ts): 'active' = not finished yet, 'terminal' = finished in any way. */
const BULK_STATUS_ALIASES: Record<string, string[]> = {
  active: ['PENDING', 'QUEUED', 'IN_PROGRESS', 'CANCELLING'],
  terminal: ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'],
}
/**
 * The kind a catalog transfer (Catalog import) stores on its ImportJob: pim/catalog-transfer-jobs.ts TRANSFER_JOB_KIND,
 * written out here because importing that module brings the field catalogue and every channel's account services into
 * whatever loads the tool registry. platform-library.tools.vitest.test.ts holds the two equal.
 */
export const TRANSFER_JOB_KIND = 'catalog-transfer-v2'
const JOB_NOT_FOUND = 'Job not found'
const ITEMS_SHOWN = 20

const importView = (job: ImportJob) => ({
  id: job.id,
  name: job.jobName,
  file: safeTextOrNull(job.filename, 160),
  fileKind: job.fileKind,
  ...(job.targetEntity !== TRANSFER_JOB_KIND ? { entity: job.targetEntity } : {}),
  // Where the file came from; never the address itself (a link can carry a password or a token).
  source: job.source,
  status: job.status,
  rows: { total: job.totalRows, succeeded: job.successRows, failed: job.failedRows, skipped: job.skippedRows },
  error: safeTextOrNull(job.errorSummary),
  createdAt: iso(job.createdAt),
  completedAt: iso(job.completedAt),
})

const exportView = (job: ExportJob) => ({
  id: job.id,
  name: job.jobName,
  format: job.format,
  entity: job.targetEntity,
  status: job.status,
  rows: job.rowCount,
  bytes: job.bytes,
  error: safeTextOrNull(job.errorMessage),
  createdAt: iso(job.createdAt),
  completedAt: iso(job.completedAt),
})

/** A person's name for each job actor; never an e-mail (bulkActorNames falls back to one). */
async function actorNames(actors: Array<string | null>): Promise<Map<string, string>> {
  const names = await bulkActorNames(prisma, actors)
  for (const [actor, name] of names) if (name.includes('@')) names.set(actor, personName(null))
  return names
}

const bulkView = (job: BulkActionJob, names: Map<string, string>) => ({
  id: job.id,
  name: job.jobName,
  action: job.actionType,
  channel: job.channel,
  status: job.status,
  items: { total: job.totalItems, processed: job.processedItems, failed: job.failedItems, skipped: job.skippedItems },
  progressPercent: job.progressPercent,
  canRollBack: job.isRollbackable && !job.rollbackJobId,
  ...(job.rollbackJobId ? { rolledBackBy: job.rollbackJobId } : {}),
  lastError: safeTextOrNull(job.lastError),
  by: job.createdBy ? names.get(job.createdBy) ?? null : null,
  createdAt: iso(job.createdAt),
  completedAt: iso(job.completedAt),
})

let wizard: ImportWizardService | null = null
/** The import wizard, loaded on first use (it brings the catalog transfer and every channel's specs). */
async function importWizard(): Promise<ImportWizardService> {
  if (!wizard) wizard = new (await import('../../import-wizard.service.js')).ImportWizardService(prisma)
  return wizard
}

async function oneJob(kind: JobKind, jobId: string, me: string | null) {
  if (kind === 'import' || kind === 'transfer') {
    const job = await (await importWizard()).get(jobId, me ?? undefined)
    if (!job || (kind === 'transfer') !== (job.targetEntity === TRANSFER_JOB_KIND)) return null
    const rows = await (await importWizard()).listRows(job.id, { limit: ITEMS_SHOWN })
    return {
      job: importView(job),
      firstRows: rows.map((row) => {
        const values = (row.parsedValues ?? {}) as Record<string, unknown>
        return { row: row.rowIndex, status: row.status, sku: typeof values.sku === 'string' ? values.sku : null, error: safeTextOrNull(row.errorMessage) }
      }),
    }
  }
  if (kind === 'export') {
    const job = await prisma.exportJob.findUnique({ where: { id: jobId } })
    if (!job) return null
    const columns = Array.isArray(job.columns) ? (job.columns as Array<Record<string, unknown>>) : []
    return {
      job: {
        ...exportView(job),
        columns: columns.slice(0, 40).map((column) => String(column?.label ?? column?.id ?? '?')),
        ...(columns.length > 40 ? { moreColumns: columns.length - 40 } : {}),
        filters: safeValue(job.filters),
      },
    }
  }
  const job = await prisma.bulkActionJob.findUnique({ where: { id: jobId } })
  if (!job) return null
  // Loaded here, not at the top: the bulk service brings the outbound sync and every channel's account services, which
  // nothing that only loads the tool registry (the approval inbox, its tests) may pull in.
  const { bulkJobItems } = await import('../../bulk/bulk-history.service.js')
  const [names, items] = await Promise.all([actorNames([job.createdBy]), bulkJobItems(job.id, { limit: ITEMS_SHOWN })])
  return {
    job: { ...bulkView(job, names), change: safeValue(job.actionPayload) },
    firstItems: items.map((item) => ({ sku: item.sku, listing: item.channelLabel, status: item.status, error: safeTextOrNull(item.errorMessage) })),
  }
}

const jobHistory: AgentTool = {
  name: 'job-history',
  title: 'Job history',
  category: 'catalog',
  description:
    'The history of the business\'s jobs, newest first, one kind at a time: import (your file imports), transfer '
    + '(your Catalog imports with their review), export (files exported), bulk (bulk changes: what, how many items, '
    + 'failures, who ran it, whether it can be rolled back). Name a jobId for that job and its first rows or items. '
    + 'Read only: running, retrying or rolling back a job is a separate, approved change. Pages with a cursor.',
  input: z.object({
    kind: z.preprocess(lower, z.enum(JOB_KINDS)).describe(`which jobs: ${JOB_KINDS.join(', ')}`),
    jobId: z.string().trim().min(1).max(64).optional().describe('one job by its id (from a previous answer): the job and its first rows or items'),
    status: z.string().trim().min(1).max(40).optional()
      .describe('only jobs in this status, e.g. COMPLETED or FAILED (bulk also: active, terminal)'),
    ...paging,
  }),
  requires: [F.productsView],
  riskTier: 'low',
  readOnly: true,
  async handler(args, ctx) {
    return listTool('job-history', async () => {
      const kind = args.kind as JobKind
      const me = ctx.userId ?? null
      const jobId = args.jobId as string | undefined
      if (jobId) {
        const one = await oneJob(kind, jobId, me)
        return one ? { ok: true, data: { kind, ...one } } : { ok: false, error: JOB_NOT_FOUND }
      }
      const size = pageSize(args.limit as number | undefined)
      const scope = listScope('job-history', args)
      const after = newestFirstAfter(scope, args.cursor)
      const status = args.status as string | undefined
      const order = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
      if (kind === 'import' || kind === 'transfer') {
        const rows = await prisma.importJob.findMany({
          where: {
            AND: [
              { targetEntity: kind === 'transfer' ? TRANSFER_JOB_KIND : { in: IMPORT_KINDS } },
              // A person's imports are their own in Nexus (import-wizard.routes.ts reads them by creator).
              ...(me ? [{ createdBy: me }] : []),
              ...(status ? [{ status }] : []),
              after,
            ],
          },
          orderBy: order,
          take: size + 1,
        })
        return { ok: true, data: { kind, ...newestFirstPage(rows, size, scope, importView) } }
      }
      if (kind === 'export') {
        const rows = await prisma.exportJob.findMany({ where: { AND: [...(status ? [{ status }] : []), after] }, orderBy: order, take: size + 1 })
        return { ok: true, data: { kind, ...newestFirstPage(rows, size, scope, exportView) } }
      }
      const statuses = status ? BULK_STATUS_ALIASES[status.toLowerCase()] ?? [status] : null
      const rows = await prisma.bulkActionJob.findMany({
        where: { AND: [...(statuses ? [{ status: { in: statuses } }] : []), after] },
        orderBy: order,
        take: size + 1,
      })
      const names = await actorNames(rows.map((row) => row.createdBy))
      return { ok: true, data: { kind, ...newestFirstPage(rows, size, scope, (row) => bulkView(row, names)) } }
    })
  },
}

export const PLATFORM_LIBRARY_TOOLS: AgentTool[] = [imageLibrary, savedViews, jobHistory]
