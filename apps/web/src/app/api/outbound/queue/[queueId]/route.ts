import { NextRequest, NextResponse } from "next/server";

/**
 * DELETE /api/outbound/queue/:queueId
 * Cancel a pending sync (grace period - undo sync)
 * ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
 * Proxy route that forwards DELETE requests to the backend API
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ queueId: string }> }
) {
  try {
    const { queueId } = await params;

    // Forward DELETE request to backend API
    const response = await fetch(
      `http://localhost:3001/api/outbound/queue/${queueId}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    console.error("Error cancelling queue item:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
