/**
 * Response Utilities
 * Consistent JSON response structures for all API endpoints
 */

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
  meta?: {
    timestamp: string;
    path?: string;
  };
}

export interface PaginatedResponse<T = any> extends ApiResponse<T[]> {
  meta?: {
    timestamp: string;
    path?: string;
    pagination?: {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  };
}

/**
 * Create a successful response
 */
export function successResponse<T>(data: T, meta?: Record<string, any>): ApiResponse<T> {
  return {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  };
}

/**
 * Create a paginated response
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  limit: number,
  offset: number,
  meta?: Record<string, any>
): PaginatedResponse<T> {
  const hasMore = offset + limit < total;

  return {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      pagination: {
        total,
        limit,
        offset,
        hasMore
      },
      ...meta
    }
  };
}

/**
 * Create an error response
 */
export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, any>
): ApiResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details && { details })
    },
    meta: {
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Validation error response
 */
export function validationErrorResponse(errors: Record<string, string[]>): ApiResponse {
  return errorResponse(
    'VALIDATION_ERROR',
    'Request validation failed',
    { validationErrors: errors }
  );
}

/**
 * Not found error response
 */
export function notFoundResponse(resource: string, id: string): ApiResponse {
  return errorResponse(
    'NOT_FOUND',
    `${resource} not found`,
    { id }
  );
}

/**
 * Internal server error response
 */
export function internalErrorResponse(message: string = 'Internal server error'): ApiResponse {
  return errorResponse(
    'INTERNAL_ERROR',
    message
  );
}

/**
 * Unauthorized error response
 */
export function unauthorizedResponse(message: string = 'Unauthorized'): ApiResponse {
  return errorResponse(
    'UNAUTHORIZED',
    message
  );
}

/**
 * Forbidden error response
 */
export function forbiddenResponse(message: string = 'Forbidden'): ApiResponse {
  return errorResponse(
    'FORBIDDEN',
    message
  );
}

/**
 * Bad request error response
 */
export function badRequestResponse(message: string, details?: Record<string, any>): ApiResponse {
  return errorResponse(
    'BAD_REQUEST',
    message,
    details
  );
}

/**
 * Conflict error response
 */
export function conflictResponse(message: string, details?: Record<string, any>): ApiResponse {
  return errorResponse(
    'CONFLICT',
    message,
    details
  );
}
