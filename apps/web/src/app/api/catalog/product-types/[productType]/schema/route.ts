export async function GET(
  _request: Request,
  { params }: { params: Promise<{ productType: string }> }
) {
  try {
    const { productType } = await params;

    if (!productType) {
      return Response.json(
        {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Product type is required',
          },
        },
        { status: 400 }
      );
    }

    const response = await fetch(
      `http://localhost:3001/api/catalog/product-types/${encodeURIComponent(productType)}/schema`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

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
    console.error('Error fetching schema:', error);
    return Response.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch schema',
        },
      },
      { status: 500 }
    );
  }
}
