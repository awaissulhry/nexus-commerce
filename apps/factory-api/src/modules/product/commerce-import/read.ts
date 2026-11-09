import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { COMMERCE_IMPORTER_KEY } from '@nexus/factory-domain/product/commerce-import/importer'
import { commerceImportInfo, type CommerceImportView, type StartedStylesView } from '@nexus/factory-domain/product/commerce-import/source'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, STYLE_SCOPE } from '../styles/store'

/**
 * The Commerce import's reads (B-W2b-209):
 *
 *   commerceImport   where a style can start from: the export file (on) and the live read (OFF, waiting for the Owner's
 *                    word: factory-domain ./source). A constant answer: nothing here asks Commerce anything.
 *   startedStyles    the styles an import job of Commerce families wrote, for the result step: the job's APPLIED rows
 *                    name their records (the family's own row its style, a SKU row its SKU), so the styles are those
 *                    records' styles. The job is seen as the imports routes see it (imports.view and product.styles.view
 *                    over its company, else not found); each style only when the caller may see it (scopeWhere),
 *                    the others counted, never named. `started`: the style was made by the job's apply (made at or after
 *                    the apply was asked for), else the job added colours, sizes and SKUs to a style that was there.
 */

export function commerceImport(): CommerceImportView {
  return commerceImportInfo()
}

export async function startedStyles(caller: CommandCaller, jobId: string): Promise<StartedStylesView> {
  const actor = actorOf(contextOf(caller))
  if (!isUuid(jobId)) throw new NotFoundError('Import not found.')
  return caller.withClient(async (client) => {
    const job = await client.importJob.findUnique({ where: { id: jobId }, select: { id: true, importerKey: true, status: true, companyId: true, applyRequestedAt: true } })
    const scope = { companyId: job?.companyId ?? null }
    if (!job || job.importerKey !== COMMERCE_IMPORTER_KEY || !can(actor, 'imports.view', scope) || !can(actor, PRODUCT_STYLES_VIEW, scope)) throw new NotFoundError('Import not found.')
    const records = (await client.importRow.findMany({ where: { jobId, outcome: 'APPLIED', recordId: { not: null } }, select: { recordId: true } })).map((row) => row.recordId!)
    if (records.length === 0) return { jobId, status: job.status, styles: [], hidden: 0 }
    const variants = await client.variant.findMany({ where: { id: { in: records } }, select: { styleId: true } })
    const skus = new Map<string, number>()
    for (const variant of variants) skus.set(variant.styleId, (skus.get(variant.styleId) ?? 0) + 1)
    // A record that is no SKU is a family's own row: its style.
    const ids = [...new Set([...variants.map((variant) => variant.styleId), ...records])]
    const written = await client.style.findMany({ where: { id: { in: ids } }, select: { id: true } })
    const visible = await client.style.findMany({
      where: { AND: [{ id: { in: written.map((row) => row.id) } }, scopeWhere(actor, PRODUCT_STYLES_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput] },
      select: { id: true, code: true, name: true, status: true, lifecycle: true, createdAt: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    })
    return {
      jobId,
      status: job.status,
      styles: visible.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        lifecycle: row.lifecycle,
        started: job.applyRequestedAt !== null && row.createdAt.getTime() >= job.applyRequestedAt.getTime(),
        skus: skus.get(row.id) ?? 0,
      })),
      hidden: written.length - visible.length,
    }
  })
}
