import prisma from '../../db.js'

export function saveMediaFingerprint(imageId: string, hashes: { contentHash: string; perceptualHash?: string | null; dhash256?: string | null }) {
  return prisma.productImage.update({ where: { id: imageId }, data: hashes })
}
