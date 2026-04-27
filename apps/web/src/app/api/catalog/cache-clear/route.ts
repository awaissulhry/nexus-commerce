export async function POST() {
  try {
    const response = await fetch('http://localhost:3001/api/catalog/cache-clear', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return Response.json(
        {
          success: false,
          error: {
            code: 'BACKEND_ERROR',
            message: `Backend returned ${response.status}`,
          },
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    return Response.json(data);
  } catch (error) {
    console.error('Error clearing cache:', error);
    return Response.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to clear cache',
        },
      },
      { status: 500 }
    );
  }
}
