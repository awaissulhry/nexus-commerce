import prisma from '../../db.js'

/** Resolve IDs emitted by the library while retaining literal DAM IDs. */
export async function findLibraryAsset(assetId: string) {
  const strippedId = assetId.startsWith('da_') ? assetId.slice(3) : assetId
  let asset = await prisma.digitalAsset.findUnique({ where: { id: strippedId } })
  if (!asset && strippedId !== assetId) {
    asset = await prisma.digitalAsset.findUnique({ where: { id: assetId } })
  }
  return asset
}
