import type { Prisma } from '@prisma/client'
import type { WorkspaceDestination } from './workspace-destination.js'

/** Missing account attribution is unknown, including historical primary-account writes. */
export function workspaceMetadataWhere(destination: WorkspaceDestination | null): Prisma.ProductEventWhereInput {
  if (!destination) return { metadata: { path: ['layer'], equals: 'master' } }
  return { AND: [
    { metadata: { path: ['channel'], equals: destination.channel } },
    { metadata: { path: ['marketplace'], equals: destination.marketplace } },
    { OR: [
      { metadata: { path: ['accountId'], equals: destination.accountId } },
      { metadata: { path: ['channelConnectionId'], equals: destination.accountId } },
    ] },
    ...(destination.aliasKey === null ? [] : [{ OR: [
      { metadata: { path: ['aliasKey'], equals: destination.aliasKey } },
      { metadata: { path: ['aliasId'], equals: destination.aliasKey } },
    ] }]),
  ] }
}
