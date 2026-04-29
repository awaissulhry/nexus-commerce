import { NextRequest, NextResponse } from 'next/server'

// GET /api/sync/amazon/catalog/:syncId
// Returns the status of a sync job. Since syncs are currently synchronous
// (no background queue), every valid syncId is already complete.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ syncId: string }> }
) {
  const { syncId } = await params

  return NextResponse.json({
    success: true,
    data: {
      syncId,
      status: 'success',
      progress: 100,
      successCount: 0,
      failureCount: 0,
      message: 'Sync completed',
    },
  })
}
