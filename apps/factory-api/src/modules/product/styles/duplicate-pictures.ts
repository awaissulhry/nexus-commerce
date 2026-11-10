import { newId } from '@nexus/factory-domain/core/ids'
import { calloutsOf, picturesToCopy, type SourcePicture } from '@nexus/factory-domain/product/images/rules'
import { command, type CommandCaller } from '../../../core/command'
import { prepareFileCopy, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { guardWords, PICTURE_COLUMNS } from '../images/store'

/**
 * Duplicate a style copies its pictures (B-W2b-236, SY3:01; B-W2a-09's PICTURES part, held "W2b" until now). Run by
 * duplicate.ts right after the copy's own command, when PICTURES was picked:
 *
 *   which      the source's own pictures, the copied colourways' (on the copy's colourway of the same code) and the source
 *              revision's (on the copy's revision 1, else on the copy itself); pictures of an archived colourway or of another
 *              revision stay behind (`left`, said in the copy's notes) — factory-domain product/images picturesToCopy
 *   files      a picture names a file of its own style (B-W2b-206's StyleImage_guard), so each file is copied in the store
 *              first (files platform prepareFileCopy: read, its SHA-256 checked, put under a new key, OUTSIDE a transaction),
 *              then ONE command records the copies (each naming its source: sourceFileId) and the picture rows, the main
 *              one kept main; audit per picture; event `style.pictures_changed` COPIED
 *   repeat     a copy that already has pictures gets none again (the Duplicate's Idempotency-Key answers the same copy: its
 *              pictures are not copied twice); a file the store cannot give is left behind and counted
 *
 * The copy itself is already made when this runs: a picture copy that fails leaves a copy without (some) pictures, said in
 * its notes, never a half-made style.
 */

export interface PictureCopyTarget {
  readonly sourceStyleId: string
  readonly copyStyleId: string
  readonly copyCode: string
  readonly companyId: string | null
  /** The revision the copy took its parts from (null: none). */
  readonly sourceRevisionId: string | null
  /** The copy's revision 1 (null: no BOM, routing or label was copied). */
  readonly copyRevisionId: string | null
}

export interface PictureCopyOutcome {
  readonly copied: number
  readonly left: number
}

export async function copyPicturesOfCopy(request: CommandCaller, target: PictureCopyTarget, idempotencyKey?: string): Promise<PictureCopyOutcome> {
  const read = await request.withClient(async (client) => {
    const already = await client.styleImage.count({ where: { styleId: target.copyStyleId } })
    if (already > 0) return null
    const rows = await client.styleImage.findMany({ where: { styleId: target.sourceStyleId }, select: PICTURE_COLUMNS })
    const source = await client.colourway.findMany({ where: { styleId: target.sourceStyleId }, select: { id: true, code: true } })
    const copy = await client.colourway.findMany({ where: { styleId: target.copyStyleId }, select: { id: true, code: true } })
    return { rows, source, copy }
  })
  if (!read) return { copied: await request.withClient((client) => client.styleImage.count({ where: { styleId: target.copyStyleId } })), left: 0 }
  const byCode = new Map(read.copy.map((row) => [row.code, row.id]))
  const colourwayMap = new Map(read.source.flatMap((row) => (byCode.has(row.code) ? [[row.id, byCode.get(row.code)!] as const] : [])))
  const pictures: SourcePicture[] = read.rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    isMain: row.isMain,
    createdAt: row.createdAt.toISOString(),
    kind: row.kind,
    revisionId: row.revisionId,
    colourwayId: row.colourwayId,
    fileId: row.fileId,
    caption: row.caption,
    callouts: calloutsOf(row.callouts),
  }))
  const plan = picturesToCopy(pictures, colourwayMap, target.sourceRevisionId, target.copyRevisionId)
  if (plan.copied.length === 0) return { copied: 0, left: plan.left }

  // The files first, in the store, outside any transaction (a file the store cannot give is left behind).
  const prepared: { picture: (typeof plan.copied)[number]; file: PreparedGeneratedFile }[] = []
  let failed = 0
  for (const picture of plan.copied) {
    try {
      prepared.push({ picture, file: await prepareFileCopy(processFiles(), request, picture.source.fileId, { companyId: target.companyId, recordType: 'Style', recordId: target.copyStyleId }) })
    } catch {
      failed++
    }
  }
  if (prepared.length === 0) return { copied: 0, left: plan.left + failed }
  const hasMain = prepared.some((entry) => entry.picture.isMain)

  try {
    const { result } = await command(
      request,
      { name: 'product.pictures.copy', idempotencyKey: idempotencyKey ? `${idempotencyKey}:pictures` : undefined, input: { ...target, pictures: prepared.map((entry) => entry.picture.source.id) } },
      async (tools) => {
        const { tx, now } = tools
        if ((await tx.styleImage.count({ where: { styleId: target.copyStyleId } })) > 0) return { ids: [] as string[] }
        const ids: string[] = []
        for (const [seq, entry] of prepared.entries()) {
          const file = await recordGeneratedFile(tools, entry.file)
          const id = newId()
          const isMain = hasMain ? entry.picture.isMain : seq === 0
          const callouts = entry.picture.source.callouts.map((callout) => ({ ...callout }))
          await tx.styleImage.create({
            data: {
              id,
              styleId: target.copyStyleId,
              revisionId: entry.picture.revisionId,
              colourwayId: entry.picture.colourwayId,
              fileId: file.id,
              kind: entry.picture.source.kind,
              seq,
              isMain,
              caption: entry.picture.source.caption,
              ...(callouts.length > 0 ? { callouts } : {}),
              createdAt: now,
              updatedAt: now,
              createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
            },
            select: { id: true },
          })
          tools.audit({
            recordType: 'StyleImage',
            recordId: id,
            companyId: target.companyId,
            after: { styleId: target.copyStyleId, kind: entry.picture.source.kind, fileId: file.id, copiedFrom: { pictureId: entry.picture.source.id, fileId: entry.picture.source.fileId }, seq, isMain },
          })
          ids.push(id)
        }
        tools.emit({ type: 'style.pictures_changed', subject: target.copyStyleId, companyId: target.companyId, payload: { styleId: target.copyStyleId, code: target.copyCode, change: 'COPIED', pictureIds: ids } })
        return { ids }
      },
    )
    return { copied: result.ids.length, left: plan.left + failed }
  } catch (error) {
    // The copy stands without its pictures (said in its notes); a database refusal is never a 500 here.
    if (guardWords(error)) return { copied: 0, left: plan.left + plan.copied.length }
    throw error
  }
}
