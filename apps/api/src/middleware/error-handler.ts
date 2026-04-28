/**
 * Global Error Handling Middleware
 * Catches unhandled exceptions and formats them using consistent response structure
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { internalErrorResponse } from '../routes/response.js';

/**
 * Global error handler middleware
 * Must be registered last in the middleware stack
 */
export function errorHandler(
  error: Error | any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log the error with full context
  logger.error('Unhandled error caught by global error handler', {
    message: error?.message || String(error),
    stack: error?.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });

  // Ensure we don't leak sensitive information to the client
  const statusCode = error?.statusCode || 500;
  const response = internalErrorResponse(
    process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : error?.message || 'Internal server error'
  );

  // Send error response
  res.status(statusCode).json(response);
}

/**
 * 404 Not Found handler
 * Should be registered after all other routes
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.warn('404 Not Found', {
    path: req.path,
    method: req.method,
    ip: req.ip
  });

  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`
    },
    meta: {
      timestamp: new Date().toISOString(),
      path: req.path
    }
  });
}

/**
 * Async error wrapper for Express route handlers
 * Wraps async functions to catch errors and pass to error handler
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
