import type { Prisma } from '@prisma/client'
import { TRANSFER_CHANNELS, transferCategoryField, transferIsStore, type ProductTransferBoundary } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { fingerprint, MANAGED_FIELDS, managedChannelField, transferContracts } from './catalog-transfer-plan.js'
import { TransferConflict } from './catalog-transfer.service.js'
import { mapSourceTable, validateSourceMapping, type SourceTable } from './catalog-source-mapping.js'
import { readSourceFile } from './catalog-source-file.js'
import { stageTransferJob, TRANSFER_BATCH, TRANSFER_JOB_KIND } from './catalog-transfer-jobs.js'
import { productTransferOptions } from './catalog-product-transfer.js'
import { jsonRecord } from './channel-value-mutation.js'
import { resolveCategoriesForProducts } from './mapping/category-mapping.service.js'

const INPUT_KIND = 'catalog-source-input-v1'
export const PRESET_KIND = 'catalog-source-v1'
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue
interface InputSummary { headers: string[]; total: number; hash: string; expiresAt: string; url?: string }

export async function inspectCatalogSource(buffer: Buffer, filename: string, userId: string | null, url?: string) {
  const table = await readSourceFile(buffer, filename)
  const summary: InputSummary = { headers: table.headers, total: table.records.length, hash: fingerprint(buffer.toString('base64')), expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), url }
  const job = await prisma.importJob.create({ data: { jobName: filename, filename, fileKind: filename.split('.').pop() ?? 'csv', source: url ? 'url' : 'upload', sourceUrl: url,
    targetEntity: INPUT_KIND, status: 'STAGING', totalRows: table.records.length, createdBy: userId, planToken: summary.hash, planSummary: json(summary) } })
  for (let i = 0; i < table.records.length; i += TRANSFER_BATCH) await prisma.importJobRow.create({ data: { jobId: job.id, rowIndex: i + 1, parsedValues: json(table.records.slice(i, i + TRANSFER_BATCH)) } })
  await prisma.importJob.update({ where: { id: job.id }, data: { status: 'SOURCE_READY' } })
  return { sourceId: job.id, filename, ...summary, sample: table.records.slice(0, 5) }
}

export async function previewCatalogSource(input: { sourceId: string; inputHash: string; mapping: unknown; userId: string | null; presetId?: string; presetVersion?: string; scheduleId?: string; boundary?: ProductTransferBoundary }) {
  const mapping = validateSourceMapping(input.mapping)
  if (input.boundary && mapping.mode !== 'update') throw new Error('Product editor source imports update existing records only')
  const source = await prisma.importJob.findFirst({ where: { id: input.sourceId, createdBy: input.userId, targetEntity: INPUT_KIND, status: 'SOURCE_READY' } })
  if (!source) throw new TransferConflict('Source upload is unavailable; upload it again')
  const summary = source.planSummary as unknown as InputSummary
  if (!input.inputHash || source.planToken !== input.inputHash || Date.parse(summary.expiresAt) <= Date.now()) throw new TransferConflict('Source upload changed or expired; upload it again')
  if (input.presetId) {
    const preset = await readSourcePreset(input.presetId, input.userId)
    if (!preset || preset.updatedAt.toISOString() !== input.presetVersion) throw new TransferConflict('The saved mapping changed; select it again')
  }
  const preset = input.presetId ? await readSourcePreset(input.presetId, input.userId) : null
  const table: SourceTable = { headers: summary.headers, records: [] }
  let cursor = 0
  while (true) {
    const page = await prisma.importJobRow.findMany({ where: { jobId: source.id, rowIndex: { gt: cursor } }, orderBy: { rowIndex: 'asc' }, take: 10 })
    if (!page.length) break
    for (const shard of page) table.records.push(...shard.parsedValues as unknown as SourceTable['records'])
    cursor = page[page.length - 1].rowIndex
  }
  if (table.records.length !== summary.total) throw new TransferConflict('Source staging is incomplete')
  const mapped = mapSourceTable(table, mapping)
  for (const row of [...mapped.rows, ...mapped.issues, ...mapped.exclusions]) row.source = { ...row.source, file: source.filename ?? source.jobName }
  return stageTransferJob({ ...mapped, boundary: input.boundary, mapping, mode: mapping.mode, market: mapping.market, filename: source.filename ?? source.jobName, userId: input.userId,
    source: { url: summary.url, presetId: input.presetId, presetVersion: preset ? fingerprint([preset.columnMapping, preset.sourceUrl]) : undefined, scheduleId: input.scheduleId } })
}

/** ScheduledImport already persists a source definition. Disabled upload definitions are reusable mappings. */
export async function listSourcePresets(userId: string | null, page = 1) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Use a positive preset page')
  const where = { createdBy: userId, targetEntity: PRESET_KIND }
  const [total, presets] = await Promise.all([prisma.scheduledImport.count({ where }), prisma.scheduledImport.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50 })])
  return { total, page, pageSize: 50, presets }
}
export async function listSourceHistory(userId: string | null, page = 1) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Use a positive history page')
  const where = { createdBy: userId, targetEntity: { in: [TRANSFER_JOB_KIND, 'product', 'channelListing', 'inventory'] } }
  const [total, jobs] = await Promise.all([prisma.importJob.count({ where }), prisma.importJob.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 50, take: 50,
    select: { id: true, jobName: true, targetEntity: true, status: true, totalRows: true, successRows: true, failedRows: true, createdAt: true, scheduleId: true } })])
  return { total, page, pageSize: 50, jobs }
}
export async function readSourcePreset(id: string, userId: string | null) {
  return prisma.scheduledImport.findFirst({ where: { id, createdBy: userId, targetEntity: PRESET_KIND } })
}
export async function saveSourcePreset(input: { id?: string; version?: string; name: string; mapping: unknown; userId: string | null }) {
  const mapping = validateSourceMapping(input.mapping)
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Name the source mapping using at most 120 characters')
  if (!input.id) return prisma.scheduledImport.create({ data: { name: input.name.trim(), source: 'upload', sourceUrl: '', targetEntity: PRESET_KIND, columnMapping: json(mapping), enabled: false, createdBy: input.userId } })
  if (!input.version || !Number.isFinite(Date.parse(input.version))) throw new TransferConflict('Supply the saved mapping version')
  const changed = await prisma.scheduledImport.updateMany({ where: { id: input.id, createdBy: input.userId, targetEntity: PRESET_KIND, updatedAt: new Date(input.version) }, data: { name: input.name.trim(), columnMapping: json(mapping) } })
  if (!changed.count) throw new TransferConflict('The saved mapping changed; reload it before saving')
  return readSourcePreset(input.id, input.userId)
}
export async function deleteSourcePreset(id: string, version: string, userId: string | null) {
  if (!version || !Number.isFinite(Date.parse(version))) throw new TransferConflict('Supply the saved mapping version')
  const result = await prisma.scheduledImport.deleteMany({ where: { id, createdBy: userId, targetEntity: PRESET_KIND, updatedAt: new Date(version), enabled: false } })
  if (!result.count) throw new TransferConflict('The mapping changed or its schedule is enabled; reload it before deleting')
}

export async function sourceMappingFields(input: { market: string; familyId?: string; channel?: string; marketplace?: string; category?: string; productId?: string; listingId?: string }) {
  if (!/^(?:[A-Z]{2}|GLOBAL)$/.test(input.market)) throw new Error('Choose the attribute dictionary marketplace')
  if (input.productId && input.listingId) {
    const options = await productTransferOptions(input.productId)
    const destination = options.listings.find(l => l.id === input.listingId)
    if (!destination) throw new Error('Choose an existing listing for this product group')
    const listing = await prisma.channelListing.findUnique({ where: { id: destination.id }, select: { platformAttributes: true } })
    const categoryKey = transferCategoryField(destination.channel)
    const stored = jsonRecord(listing?.platformAttributes)[categoryKey]
    const category = stored || (await resolveCategoriesForProducts({ productIds: [destination.productId], channel: destination.channel, marketplace: destination.marketplace }))[destination.productId]?.channelCategoryId
    if (!category && !transferIsStore(destination.channel)) throw new Error('Choose this listing’s category in the product editor before mapping its attributes')
    input = { ...input, channel: destination.channel, marketplace: destination.marketplace, category: String(category ?? '') }
  }
  const contracts = transferContracts(input.market)
  if (input.channel) {
    if (!TRANSFER_CHANNELS.includes(input.channel) || !/^(?:[A-Z]{2}|GLOBAL)$/.test(input.marketplace ?? '') || !transferIsStore(input.channel) && !input.category) throw new Error('Choose a channel, marketplace and category')
    const schema = await contracts.channel(input.channel, input.marketplace!, input.category ?? '')
    const categoryKey = transferCategoryField(input.channel)
    return { fields: [{ key: categoryKey, label: 'Listing category', entity: 'Listings', kind: input.channel === 'ETSY' ? 'number' : 'text', shape: 'scalar' },
      ...schema.fields.filter(f => f.fieldKey !== categoryKey && !managedChannelField(f)).map(f => ({ key: f.fieldKey, label: f.label, entity: 'Overrides', kind: f.kind, shape: f.shape, editable: f.editable }))] }
  }
  const columns = await contracts.master(input.familyId || null)
  return { fields: [...columns.filter(c => c.editable && !MANAGED_FIELDS.has(c.key)).map(c => ({ key: c.key, label: c.label, entity: 'Products', kind: c.kind, shape: c.shape })),
    ...['family', 'parentSku', 'categoryIds', 'primaryCategoryId'].map(key => ({ key, label: key, entity: 'Products', kind: 'text', shape: key === 'categoryIds' ? 'list' : 'scalar' }))] }
}
