export async function GET() {
  try {
    const response = await fetch('http://localhost:3001/api/catalog/product-types', {
      method: 'GET',
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
    console.error('Error fetching product types:', error);
    return Response.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch product types',
        },
      },
      { status: 500 }
    );
  }
}
