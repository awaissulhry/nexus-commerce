import { NextResponse } from 'next/server'

// GET /api/sync/amazon/catalog/history
// SyncHistoryDisplay reads result.data.syncs — return the expected shape.
export async function GET() {
  return NextResponse.json({
    success: true,
    data: { syncs: [], total: 0 },
  })
}
