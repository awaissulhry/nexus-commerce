import { NextResponse } from 'next/server'

// GET /api/sync/amazon/catalog/history
export async function GET() {
  return NextResponse.json({
    success: true,
    data: [],
    total: 0,
  })
}
