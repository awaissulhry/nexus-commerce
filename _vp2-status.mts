import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const g = await p.channelListing.groupBy({ by: ['listingStatus'], _count: { _all: true } })
console.log('listingStatus values:', g.map(r => `${r.listingStatus}=${r._count._all}`).join(' '))
const pub = await p.channelListing.groupBy({ by: ['isPublished', 'listingStatus'], _count: { _all: true } })
console.log('isPublished x status:', pub.map(r => `${r.isPublished}/${r.listingStatus}=${r._count._all}`).join(' '))
console.log('total listings:', await p.channelListing.count())
await p.$disconnect()
