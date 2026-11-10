import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { ScanView } from '@nexus/factory-domain/product/techpack/contracts'
import { audienceOfLayout } from '@nexus/factory-domain/product/techpack/rules'
import { formatTechPackCode, readTechPackCode, scanVerdict, techPackCodeHex, type ScannedVersion, type ScanRevision } from '@nexus/factory-domain/product/techpack/scan'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../bom/store'

/**
 * The QR to the current version (B-W2b-230; PRD-138): GET /product/tech-packs/scan/:code (office, product.styles.view over
 * the style's company). The code under the QR (or the whole address it holds) names one stored version; the answer says
 * which version and revision the page is, and whether a newer one exists — a newer revision in force, or a newer version
 * of the same audience and language that says something else — in words. A code that names nothing the caller may see is
 * not found (the same answer as an unknown code).
 */

const notFound = () => new NotFoundError('No tech pack page has this code.')

export async function scanTechPack(caller: CommandCaller, raw: string): Promise<ScanView> {
  const context = contextOf(caller)
  const code = readTechPackCode(raw)
  if (code === null) throw notFound()
  const hex = techPackCodeHex(code)
  return caller.withClient(async (client) => {
    // The id's last group is the code (newest first when two share it).
    const found = await client.$queryRaw<{ id: string }[]>`SELECT id FROM "GeneratedDocument" WHERE kind = 'TECH_PACK' AND "recordType" = 'StyleRevision' AND right(id::text, 12) = ${hex} ORDER BY "createdAt" DESC LIMIT 1`
    const documentId = found[0]?.id
    if (!documentId) throw notFound()
    const printed = await client.generatedDocument.findUniqueOrThrow({ where: { id: documentId }, select: { id: true, recordId: true, version: true, layout: true, language: true, fingerprint: true, createdAt: true } })
    const revision = await client.styleRevision.findUnique({ where: { id: printed.recordId }, select: { id: true, styleId: true, revision: true, status: true } })
    const style = revision ? await client.style.findUnique({ where: { id: revision.styleId }, select: { id: true, code: true, companyId: true } }) : null
    if (!revision || !style || !can(actorOf(context), 'product.styles.view', style.companyId === null ? {} : { companyId: style.companyId })) throw notFound()
    const revisions = await client.styleRevision.findMany({ where: { styleId: style.id }, select: { id: true, revision: true, status: true } })
    const rows = await client.generatedDocument.findMany({
      where: { recordType: 'StyleRevision', recordId: { in: revisions.map((row) => row.id) }, kind: 'TECH_PACK' },
      select: { id: true, recordId: true, version: true, layout: true, language: true, fingerprint: true, createdAt: true },
    })
    const scanned = (row: (typeof rows)[number]): ScannedVersion => ({
      id: row.id,
      revisionId: row.recordId,
      version: row.version,
      audience: audienceOfLayout(row.layout),
      language: row.language,
      fingerprint: row.fingerprint,
      createdAt: toUtcIso(row.createdAt),
    })
    const page = scanned({ ...printed })
    const verdict = scanVerdict(page, revision as ScanRevision, rows.map(scanned), revisions as ScanRevision[])
    return {
      code: formatTechPackCode(code),
      state: verdict.state,
      words: verdict.words,
      printed: {
        styleId: style.id,
        styleCode: style.code,
        revisionId: revision.id,
        revision: revision.revision,
        revisionStatus: revision.status,
        version: printed.version,
        audience: page.audience,
        language: printed.language,
        createdAt: page.createdAt,
      },
      newer: verdict.newer ? { ...verdict.newer } : null,
    }
  })
}
