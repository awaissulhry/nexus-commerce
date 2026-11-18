import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { command } from '../../../core/command'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { previewFile } from '../../../platform/files/preview/preview'
import { processFiles } from '../../../platform/files/service'
import { officeContextOf } from './access'
import { readOfficeOrderFiles } from './order-files'

/**
 * B-SA-036: POST /sales/orders/:orderId/files/:fileId/open {mode} — ONE file of the order, through its own wall: found again in
 * ./order-files.ts's read for this reader (the order with orders.view, the file over its record's scope and its group's right,
 * body data only with sales.measurements.view; a copy folded under another one opens too), else "File not found." — the words of
 * an unknown id, whoever's it is. Then the 60-second presigned GET of platform/files (`preview`: a picture or a PDF opens in the
 * browser; `download`: as a file). Opening body data is recorded on the order (an audit row: who looked, when), as production's
 * order files record theirs. The generic `/files/:id/preview` is never what the order page links to.
 */

export const openOrderFileContract = defineContract({
  params: input({ orderId: id(), fileId: id() }),
  /** `preview` (default): a picture or a PDF opens in the browser (`inline`), any other kind downloads; `download`: always as a file. */
  body: input({ mode: z.enum(['preview', 'download']).optional() }).optional(),
  response: {
    200: output({
      file: output({ id: id(), name: z.string(), contentType: z.string() }),
      open: output({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})

export async function openOrderFile(request: FastifyRequest, orderId: string, fileId: string, body: { readonly mode?: 'preview' | 'download' | undefined } | undefined, idempotencyKey?: string) {
  const context = officeContextOf(request)
  const read = await readOfficeOrderFiles(request, orderId)
  const file = read.openable.get(fileId)
  if (!file) throw new NotFoundError('File not found.')
  if (file.bodyData) {
    await command(request, { name: 'sales.orderFileOpened', idempotencyKey, input: { orderId: read.order.id, fileId } }, async ({ audit }) => {
      audit({ action: 'sales.orderFileOpened', recordType: 'SalesOrder', recordId: read.order.id, companyId: read.order.companyId, after: { fileId, category: file.category, by: context.actorId } })
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
