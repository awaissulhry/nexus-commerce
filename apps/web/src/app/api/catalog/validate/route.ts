export async function POST(request: Request) {
  try {
    const body = await request.json();

    const response = await fetch('http://localhost:3001/api/catalog/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
    console.error('Error validating attributes:', error);
    return Response.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to validate attributes',
        },
      },
      { status: 500 }
    );
  }
}
