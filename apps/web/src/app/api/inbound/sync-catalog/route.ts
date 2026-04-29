import { NextRequest, NextResponse } from 'next/server'
import { getBackendUrl } from '@/lib/backend-url'

const API_BASE_URL = getBackendUrl()

export async function POST(_request: NextRequest) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/inbound/sync-catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return NextResponse.json(
        { error: errorData.error || 'Failed to sync catalog' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Error syncing catalog:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
