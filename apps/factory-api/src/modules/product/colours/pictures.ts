import type { FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { isPictureType } from '@nexus/factory-domain/product/images/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { actorOf } from '../../../core/context'
import { storedPictureBytes } from '../images/bytes'
import { contextOf } from '../styles/store'

/**
 * A library picture's bytes (B-W2b-247): `GET /product/colours/pictures/:fileId` (office, product.styles.view) — only a
 * colour's photo (a PHOTO file of a Colour the caller may see) or a picture a branding set names as a logo or label
 * artwork (of a set the caller may see: its company and its brand), AVAILABLE, a JPEG, PNG or WebP. Served as B-W2b-236's
 * pictures are (images/bytes.ts storedPictureBytes): read once from the store, kept in this process and by the browser —
 * never a presigned store address per picture and per read.
 */
export async function libraryPictureBytes(request: FastifyRequest, fileId: string): Promise<{ bytes: Buffer; contentType: string; name: string }> {
  const actor = actorOf(contextOf(request))
  const found = isUuid(fileId)
    ? await request.withClient(async (client) => {
        const file = await client.storedFile.findUnique({
          where: { id: fileId },
          select: { id: true, companyId: true, recordType: true, recordId: true, kind: true, status: true, contentType: true, originalName: true, storeAccountId: true, storageKey: true, sizeBytes: true },
        })
        if (!file) return null
        if (file.recordType === 'Colour' && file.kind === 'PHOTO') {
          const colour = await client.colour.findUnique({ where: { id: file.recordId }, select: { companyId: true } })
          return colour && can(actor, PRODUCT_STYLES_VIEW, { companyId: colour.companyId }) ? file : null
        }
        if (file.recordType === 'BrandingSet') {
          const set = await client.brandingSet.findUnique({ where: { id: file.recordId }, select: { companyId: true, partyId: true, logoFileIds: true, labelArtworkFileIds: true } })
          const named = set && (set.logoFileIds.includes(file.id) || set.labelArtworkFileIds.includes(file.id))
          return named && can(actor, PRODUCT_STYLES_VIEW, { companyId: set.companyId, partyId: set.partyId }) ? file : null
        }
        return null
      })
    : null
  if (!found || found.status !== 'AVAILABLE' || !isPictureType(found.contentType)) throw new NotFoundError('Picture not found.')
  return storedPictureBytes(request, { companyId: found.companyId, file: found })
}
