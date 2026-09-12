import prisma from '../../db.js'

export async function recordManagedContentChange(externalListingId: string, updatedAt: string): Promise<boolean> {
  const managed = await prisma.channelListing.findMany({ where: { channel: 'SHOPIFY',
    externalListingId, platformAttributes: { path: ['_nexusContent', 'version'], equals: 1 },
  }, select: { id: true, version: true, platformAttributes: true } });
  if (managed.length) {
    for (const listing of managed) {
      const attributes = (listing.platformAttributes ?? {}) as Record<string, any>;
      const publication = attributes._nexusContentPublish ?? {};
      if (publication.status === 'PUBLISHING' || (publication.remoteUpdatedAt && Date.parse(updatedAt) <= Date.parse(publication.remoteUpdatedAt))) continue;
      await prisma.channelListing.updateMany({ where: { id: listing.id, version: listing.version }, data: {
        version: { increment: 1 }, platformAttributes: { ...attributes, _nexusContentPublish: { ...publication, status: 'REMOTE_CHANGED', observedAt: updatedAt, error: 'Shopify reported a product change. Refresh the remote review before synchronising.' } },
      } });
    }
    return true;
  }

  return false;
}
