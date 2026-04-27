import { prisma } from '@nexus/database'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const listings = await prisma.listing.findMany({
      include: {
        channel: true,
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    return NextResponse.json(listings)
  } catch (error) {
    console.error('Error fetching listings:', error)
    return NextResponse.json({ error: 'Failed to fetch listings' }, { status: 500 })
  }
}
