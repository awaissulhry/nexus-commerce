import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { isPicture } from '@nexus/factory-domain/files/thumbs/strip'
import { systemCallerOf } from '../../../platform/files/files'
import { previewFile } from '../../../platform/files/preview/preview'
import { processFiles } from '../../../platform/files/service'
import { hasSmallPreview, smallPreviewAddress } from '../../../platform/files/thumbs/small'
import { serverClock } from '../../../core/time'
import { readOfficeOrderFiles, type OrderFile } from './order-files'

/**
 * B-OP-050 (order page plan N7 "files like Gmail"; 13-backend §7; review R-14): the previews of the order's file cards in ONE call,
 * for the cards the page shows (it asks only those in view):
 *
 *   POST /sales/orders/:orderId/files/previews {fileIds: 1–24, each once}   orders.view over the order (else "Sales order not
 *        found.", the words of an unknown id)
 *
 *   which files   the office's walled read of the order's files (./order-files.ts readOfficeOrderFiles) runs ONCE; an asked id is
 *                 answered only when it is in that read's openable set — any other (another order's, one the reader may not open,
 *                 an unknown id) is simply absent: no 404 per id, nothing that says it exists
 *   PICTURE       the ~320 px small preview (platform/files/thumbs/small.ts, made with the stripped copy: no EXIF, no position),
 *                 never the original; `small` null until it is made (a HEIC, a WebP copy still in the worker)
 *   PDF           `pdfDrawable` when it is at most 3 MiB: its inline link comes in this same answer (R-14: no open call per PDF —
 *                 the browser draws page 1 itself); a larger one is opened to be seen
 *   LOCKED        body data (a measurement sheet, a body photo): no address at all and nothing recorded — the opening, recorded
 *                 on the order, is the click's own (POST …/files/:fileId/open)
 *   OTHER         a document no browser draws (Word, Excel, a ZIP …): its card shows its kind
 *
 * At most 8 presigns per call in all, in the order asked (each writes its gateway ledger row): a file whose address this call could
 * not make any more says `later` (ask for it again) — never a missing preview. The addresses live 60 seconds. The generic
 * `/files/:id/preview` is never what a card links to. A read: no command, no event, no audit row.
 */

/** The most ids one call takes (the cards in view). */
export const PREVIEW_IDS_MAX = 24
/** The most presigned addresses one call makes, pictures and PDFs together. */
export const PREVIEW_PRESIGNS_MAX = 8
/** A PDF the browser draws page 1 of: at most this many bytes (3 MiB, R-14). */
export const PDF_DRAWABLE_MAX_BYTES = 3 * 1024 * 1024

export const PREVIEW_KINDS = ['PICTURE', 'PDF', 'OTHER', 'LOCKED'] as const
export type PreviewKind = (typeof PREVIEW_KINDS)[number]

/** The card's kind of preview: body data is LOCKED whatever it is; a picture; a PDF; anything else. */
export const previewKindOf = (file: Pick<OrderFile, 'contentType' | 'bodyData'>): PreviewKind => {
  if (file.bodyData) return 'LOCKED'
  if (isPicture(file.contentType)) return 'PICTURE'
  return file.contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf' ? 'PDF' : 'OTHER'
}

const address = output({ url: z.string(), expiresAt: instant() })

export const orderFilePreviewsContract = defineContract({
  params: input({ orderId: id() }),
  body: input({ fileIds: z.array(id()).min(1).max(PREVIEW_IDS_MAX) }),
  response: {
    200: output({
      previews: z.array(
        output({
          fileId: id(),
          versionNo: z.number().int(),
          kind: z.enum(PREVIEW_KINDS),
          /** PICTURE: a presigned GET of the ~320 px small preview (60 seconds); null until it is made. */
          small: address.nullable(),
          /** PDF: at most 3 MiB, page 1 drawn in the browser from `inline`. */
          pdfDrawable: z.boolean(),
          /** PDF drawable: a presigned inline GET of it (60 seconds), in this answer (no open call per PDF). Never for body data. */
          inline: address.nullable(),
          /** This call's addresses are spent (at most 8): ask for this file again. */
          later: z.boolean(),
        }),
      ),
      asOf: instant(),
    }),
  },
})

interface Asked {
  readonly file: OrderFile
  readonly kind: PreviewKind
  readonly pdfDrawable: boolean
}

/** POST /sales/orders/:orderId/files/previews (see the file's head). */
export async function orderFilePreviews(request: FastifyRequest, orderId: string, body: { readonly fileIds: readonly string[] }) {
  if (new Set(body.fileIds).size !== body.fileIds.length) throw new ValidationError('Each file once: the same file was asked twice.', [{ path: 'body/fileIds', message: 'Each file once.' }])
  const read = await readOfficeOrderFiles(request, orderId)
  const asked: Asked[] = body.fileIds.flatMap((fileId) => {
    const file = read.openable.get(fileId)
    if (!file) return []
    const kind = previewKindOf(file)
    return [{ file, kind, pdfDrawable: kind === 'PDF' && file.sizeBytes <= PDF_DRAWABLE_MAX_BYTES }]
  })
  // The store's columns of the pictures (their small preview's key): one read, after the walled one, for the asked files only.
  const pictureIds = asked.filter((entry) => entry.kind === 'PICTURE').map((entry) => entry.file.id)
  const stored = new Map(
    pictureIds.length === 0
      ? []
      : (await request.withClient((client) => client.storedFile.findMany({ where: { id: { in: pictureIds } }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } }))).map((row) => [row.id, row]),
  )
  // Which files need an address, in the order asked, and the call's budget of presigns.
  let budget = PREVIEW_PRESIGNS_MAX
  const plan = asked.map((entry) => {
    const picture = entry.kind === 'PICTURE' ? stored.get(entry.file.id) : undefined
    const wants = (picture !== undefined && hasSmallPreview(picture)) || entry.pdfDrawable
    const now = wants && budget > 0
    if (now) budget -= 1
    return { ...entry, picture, now, later: wants && !now }
  })
  const files = processFiles()
  const callers = { caller: request, system: systemCallerOf(request) }
  const made = await Promise.all(
    plan.map(async (entry) => {
      if (!entry.now) return { small: null, inline: null }
      if (entry.picture) {
        const small = await smallPreviewAddress(files, request, { storeAccountId: entry.picture.storeAccountId, thumbnailKey: entry.picture.thumbnailKey!, contentType: entry.picture.contentType, originalName: entry.picture.originalName })
        return { small: { url: small.url, expiresAt: small.expiresAt }, inline: null }
      }
      // A PDF that is not body data (LOCKED never comes here): its inline link, as its open would answer it.
      const open = await previewFile(files, callers, entry.file.id)
      return { small: null, inline: open.mode === 'inline' ? { url: open.url, expiresAt: open.expiresAt } : null }
    }),
  )
  return {
    previews: plan.map((entry, index) => ({
      fileId: entry.file.id,
      versionNo: entry.file.versionNo,
      kind: entry.kind,
      small: made[index]!.small,
      pdfDrawable: entry.pdfDrawable,
      inline: made[index]!.inline,
      later: entry.later,
    })),
    asOf: toUtcIso(serverClock.now()),
  }
}
