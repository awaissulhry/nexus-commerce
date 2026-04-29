import { NextRequest, NextResponse } from 'next/server';
import { getBackendUrl } from '@/lib/backend-url';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'Product ID is required' } },
        { status: 400 }
      );
    }

    // Forward the DELETE request to the Fastify backend
    const backendUrl = getBackendUrl();
    const response = await fetch(`${backendUrl}/api/catalog/products/${id}`, {
      method: 'DELETE',
    });

    // Get the response body as text first
    const responseText = await response.text();

    // Return the response with the same status code and content type
    return new NextResponse(responseText, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to delete product',
        },
      },
      { status: 500 }
    );
  }
}
