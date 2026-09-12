import prisma from '../../db.js'
import { deleteFromCloudinary } from '../cloudinary.service.js'

/** Product-image rows may share uploaded bytes after a gallery copy. */
export async function cleanUpUnreferencedMedia(file: { publicId: string; url: string; mediaType: string }) {
  const references = await Promise.all([
    prisma.productImage.count({ where: { OR: [{ publicId: file.publicId }, { url: file.url }] } }),
    prisma.listingImage.count({ where: { url: file.url } }),
    prisma.digitalAsset.count({ where: { storageProvider: 'cloudinary', storageId: file.publicId } }),
  ])
  if (references.some(count => count > 0)) return false
  return deleteFromCloudinary(file.publicId, file.mediaType === 'VIDEO' ? 'video' : file.mediaType === 'IMAGE' ? 'image' : 'raw')
}
