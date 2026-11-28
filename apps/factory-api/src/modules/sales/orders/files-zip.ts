import type { FastifyReply, FastifyRequest } from 'fastify'
import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { command } from '../../../core/command'
import { storeCall, systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { writeZip, type ZipEntry } from '../../accounting/guest/zip'
import { officeContextOf } from './access'
import { readOfficeOrderFiles, type OrderFile } from './order-files'

/**
 * owb-of1 step 5 (order workflow, plan.md § 5o/§ 5p "Download all = ONE zip of what the reader may open"; settle L5: the repository's
 * own zip writer, accounting/guest/zip.ts `writeZip`, no new package; capped like the privacy package): POST
 * /sales/orders/:orderId/files/zip — the order's files as ONE zip, made of exactly the walled set the Files tab lists to this reader
 * (./order-files.ts `readOfficeOrderFiles`, the same read): a priced file for a reader without the price grain and body data for a
 * reader without sales.measurements.view are never in it — they are counted, never named, in the header `x-left-out` (the tab's
 * "you cannot open" line: leftOut + measurementsLeftOut + pricedLeftOut). Body data a reader of measurements may open is put in and
 * named on the audit row, as each opening is recorded (order-files-open.ts). A file the store no longer gives as kept is left out
 * and counted in `x-missing`. One audit row `orders.files.zip` ("downloaded N files"). More than 200 files or 25 MiB: 409 in words,
 * nothing read. The zip itself answers (an attachment, stored nowhere); a refusal is the usual JSON error.
 */

export const ORDER_ZIP_LIMITS = Object.freeze({ zipBytes: 25 * 1024 * 1024, files: 200 })

export const ZIP_TOO_BIG_WORDS = Object.freeze({
  en: `These files are more than ${ORDER_ZIP_LIMITS.files} or larger than ${ORDER_ZIP_LIMITS.zipBytes / 1024 / 1024} MiB together, the most one download holds: download them one by one, or the largest apart.`,
  it: `Questi file sono più di ${ORDER_ZIP_LIMITS.files} o insieme superano ${ORDER_ZIP_LIMITS.zipBytes / 1024 / 1024} MiB, il massimo di un download: scaricali uno alla volta, o i più grandi a parte.`,
})
export const ZIP_EMPTY_WORDS = Object.freeze({
  en: 'There is no file of this order you may open: nothing to download.',
  it: 'Non c’è nessun file di questo ordine che puoi aprire: niente da scaricare.',
})

export const orderFilesZipContract = defineContract({ params: input({ orderId: id() }), response: {} })

const safeName = (name: string): string => name.replace(/[^\p{L}\p{N}._ ()-]+/gu, '_').slice(0, 120) || 'file'

/** The zip's paths: one folder per group, each name once (a second one gets " (2)" before its extension). */
function pathsOf(files: readonly OrderFile[]): string[] {
  const used = new Set<string>()
  return files.map((file) => {
    const base = `${file.group.toLowerCase()}/${safeName(file.name)}`
    let path = base
    for (let copy = 2; used.has(path.toLowerCase()); copy++) {
      const dot = base.lastIndexOf('.')
      path = dot > base.lastIndexOf('/') ? `${base.slice(0, dot)} (${copy})${base.slice(dot)}` : `${base} (${copy})`
    }
    used.add(path.toLowerCase())
    return path
  })
}

/** POST /sales/orders/:orderId/files/zip (see the file's head). */
export async function orderFilesZip(request: FastifyRequest, reply: FastifyReply, orderId: string, idempotencyKey?: string) {
  const context = officeContextOf(request)
  const read = await readOfficeOrderFiles(request, orderId)
  const listed = read.groups.flatMap((group) => group.files)
  const files = [...new Map(listed.filter((file) => read.openable.has(file.id)).map((file) => [file.id, file])).values()]
  const leftOut = read.groups.reduce((sum, group) => sum + group.leftOut + group.measurementsLeftOut + group.pricedLeftOut, 0) + (listed.length - listed.filter((file) => read.openable.has(file.id)).length)
  if (files.length === 0) throw new ConflictError(ZIP_EMPTY_WORDS.en)
  if (files.length > ORDER_ZIP_LIMITS.files || files.reduce((sum, file) => sum + file.sizeBytes, 0) > ORDER_ZIP_LIMITS.zipBytes) throw new ConflictError(ZIP_TOO_BIG_WORDS.en)
  const stored = await request.withClient((client) =>
    client.storedFile.findMany({ where: { id: { in: files.map((file) => file.id) }, status: 'AVAILABLE' }, select: { id: true, storeAccountId: true, storageKey: true, sizeBytes: true } }),
  )
  const storedOf = new Map(stored.map((row) => [row.id, row]))
  const runtime = processFiles()
  const system = systemCallerOf(request)(context.tenantId)
  const paths = pathsOf(files)
  const entries: ZipEntry[] = []
  const missing: string[] = []
  for (const [at, file] of files.entries()) {
    const row = storedOf.get(file.id)
    const bytes = row ? await storeCall(() => runtime.storage.read(system, row.storeAccountId, row.storageKey, row.sizeBytes)) : null
    if (!bytes) {
      missing.push(file.id)
      continue
    }
    entries.push({ path: paths[at]!, bytes })
  }
  if (entries.length === 0) throw new ConflictError(ZIP_EMPTY_WORDS.en)
  const now = runtime.clock.now()
  const zip = writeZip(entries, now)
  if (zip.length > ORDER_ZIP_LIMITS.zipBytes) throw new ConflictError(ZIP_TOO_BIG_WORDS.en)
  const put = files.filter((file) => !missing.includes(file.id))
  await command(request, { name: 'orders.files.zip', idempotencyKey, input: { orderId: read.order.id, fileIds: put.map((file) => file.id) } }, async ({ audit }) => {
    audit({
      action: 'orders.files.zip',
      recordType: 'SalesOrder',
      recordId: read.order.id,
      companyId: read.order.companyId,
      after: { files: put.length, leftOut, missing: missing.length, sizeBytes: zip.length, fileIds: put.map((file) => file.id), bodyDataFileIds: put.filter((file) => file.bodyData).map((file) => file.id), by: context.actorId },
    })
    return { files: put.length }
  })
  return reply
    .type('application/zip')
    .header('content-disposition', attachmentDisposition(`${read.order.number}-files.zip`))
    .header('cache-control', 'no-store')
    .header('x-left-out', String(leftOut))
    .header('x-missing', String(missing.length))
    .header('access-control-expose-headers', 'content-disposition, x-left-out, x-missing')
    .send(zip)
}
