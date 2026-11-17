import type { FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { command } from '../../../core/command'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { previewFile } from '../../../platform/files/preview/preview'
import { processFiles } from '../../../platform/files/service'
import { officeContextOf } from '../work-orders/access'
import { readOrderFiles } from './read'

/**
 * B-PR-44: POST /production/work-orders/:workOrderId/order-files/:fileId/open — ONE file of the work order's orders, through
 * its own wall: the file is found again in ./read.ts's answer for this reader (the work order reached with its customer, the
 * file of one of ITS orders or of their lines, files.read over the file's company AND the order's customer, a measurement sheet
 * or body photo only with sales.measurements.view), else "File not found." — the words of an unknown id, whoever's it is. Then
 * the 60-second presigned GET of platform/files (`preview`: a picture or a PDF opens in the browser; `download`: as a file).
 * Opening body data is recorded on the order (an audit row: who looked, when), as the made-to-measure routes record theirs.
 * The generic `/files/:id/preview` is never what production links to.
 */
export async function openOrderFile(request: FastifyRequest, workOrderId: string, fileId: string, body: { readonly mode?: 'preview' | 'download' | undefined } | undefined, idempotencyKey?: string) {
  const context = officeContextOf(request)
  const read = await readOrderFiles(request, workOrderId)
  const found = read.groups.flatMap((group) => group.files.map((file) => ({ group, file }))).find((entry) => entry.file.id === fileId)
  if (!found) throw new NotFoundError('File not found.')
  const { group, file } = found
  if (file.bodyData) {
    await command(request, { name: 'production.orderFileOpened', idempotencyKey, input: { workOrderId: read.workOrder.id, fileId } }, async ({ audit }) => {
      audit({ action: 'production.orderFileOpened', recordType: 'SalesOrder', recordId: group.order.id, companyId: group.order.companyId, after: { workOrderId: read.workOrder.id, fileId, category: file.category, by: context.actorId } })
      return null
    })
  }
  const callers = { caller: request, system: systemCallerOf(request) }
  const files = processFiles()
  if (body?.mode === 'download') {
    const download = await downloadFile(files, callers, file.id)
    return { file: { id: file.id, name: file.name, contentType: file.contentType }, open: { mode: 'download' as const, method: 'GET' as const, url: download.url, headers: download.headers, expiresAt: download.expiresAt } }
  }
  const preview = await previewFile(files, callers, file.id)
  return { file: { id: file.id, name: file.name, contentType: file.contentType }, open: { mode: preview.mode, method: 'GET' as const, url: preview.url, headers: preview.headers, expiresAt: preview.expiresAt } }
}
