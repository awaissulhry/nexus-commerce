/**
 * Sync Health Routes
 * Endpoints for monitoring sync health and managing errors
 */

import { Router, Request, Response } from 'express';
import { SyncHealthService } from '../services/sync-health.service.js';
import prisma from '../db.js';
import { logger } from '../utils/logger.js';
import {
  LogErrorSchema,
  LogErrorRequest,
  ResolveConflictSchema,
  ResolveConflictRequest,
  HealthScoreQuerySchema
} from './validation.js';
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  notFoundResponse,
  internalErrorResponse
} from './response.js';

const router = Router();
const syncHealthService = new SyncHealthService(prisma);

/**
 * GET /api/sync-health/:channel/score
 * Get health score for a specific channel
 */
router.get('/:channel/score', async (req: Request, res: Response) => {
  try {
    const { channel } = req.params;
    const queryValidation = HealthScoreQuerySchema.safeParse(req.query);

    if (!channel) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Channel is required')
      );
    }

    const hoursBack = queryValidation.success ? queryValidation.data.hoursBack : 24;

    logger.debug('Calculating health score', {
      channel,
      hoursBack
    });

    const score = await syncHealthService.calculateChannelHealthScore(channel, hoursBack);

    logger.info('Health score calculated', {
      channel,
      healthScore: score.healthScore,
      successRate: score.successRate
    });

    return res.json(
      successResponse(score, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to calculate health score', {
      channel: req.params.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * GET /api/sync-health/conflicts
 * Get all unresolved conflicts (optionally filtered by channel)
 */
router.get('/conflicts', async (req: Request, res: Response) => {
  try {
    const { channel } = req.query;

    logger.debug('Fetching unresolved conflicts', {
      channel: channel || 'all'
    });

    const conflicts = await syncHealthService.getUnresolvedConflicts(
      channel ? String(channel) : undefined
    );

    logger.info('Unresolved conflicts retrieved', {
      count: conflicts.length,
      channel: channel || 'all'
    });

    return res.json(
      successResponse(conflicts, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to get unresolved conflicts', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * POST /api/sync-health/log
 * Log a new sync error
 */
router.post('/log', async (req: Request, res: Response) => {
  try {
    const validation = LogErrorSchema.safeParse(req.body);
    if (!validation.success) {
      const errors: Record<string, string[]> = {};
      validation.error.issues.forEach(err => {
        const path = err.path.join('.');
        if (!errors[path]) errors[path] = [];
        errors[path].push(err.message);
      });
      return res.status(400).json(validationErrorResponse(errors));
    }

    const input: LogErrorRequest = validation.data;

    logger.warn('Logging sync error', {
      errorType: input.errorType,
      severity: input.severity,
      channel: input.channel
    });

    const log = await syncHealthService.logError(input);

    logger.info('Sync error logged successfully', {
      logId: log.id,
      errorType: input.errorType
    });

    return res.status(201).json(
      successResponse(log, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to log sync error', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * GET /api/sync-health/errors/:channel
 * Get recent errors for a specific channel
 */
router.get('/errors/:channel', async (req: Request, res: Response) => {
  try {
    const { channel } = req.params;
    const { limit = '50', hoursBack = '24' } = req.query;

    if (!channel) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Channel is required')
      );
    }

    logger.debug('Fetching recent errors', {
      channel,
      limit,
      hoursBack
    });

    const errors = await syncHealthService.getRecentErrors(
      channel,
      parseInt(String(limit)),
      parseInt(String(hoursBack))
    );

    logger.info('Recent errors retrieved', {
      channel,
      count: errors.length
    });

    return res.json(
      successResponse(errors, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to get recent errors', {
      channel: req.params.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * POST /api/sync-health/conflicts/:id/resolve
 * Resolve a conflict
 */
router.post('/conflicts/:id/resolve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Log ID is required')
      );
    }

    const validation = ResolveConflictSchema.safeParse({
      logId: id,
      ...req.body
    });

    if (!validation.success) {
      const errors: Record<string, string[]> = {};
      validation.error.issues.forEach(err => {
        const path = err.path.join('.');
        if (!errors[path]) errors[path] = [];
        errors[path].push(err.message);
      });
      return res.status(400).json(validationErrorResponse(errors));
    }

    const input: ResolveConflictRequest = validation.data;

    logger.info('Resolving conflict', {
      logId: id,
      status: input.status
    });

    const resolved = await syncHealthService.resolveConflict(
      input.logId,
      input.status,
      input.notes
    );

    logger.info('Conflict resolved successfully', {
      logId: id,
      status: input.status
    });

    return res.json(
      successResponse(resolved, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to resolve conflict', {
      logId: req.params.id,
      error: error instanceof Error ? error.message : String(error)
    });

    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('not found')) {
      return res.status(404).json(notFoundResponse('Sync Health Log', req.params.id));
    }

    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * GET /api/sync-health/summary
 * Get health scores for all channels
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const queryValidation = HealthScoreQuerySchema.safeParse(req.query);
    const hoursBack = queryValidation.success ? queryValidation.data.hoursBack : 24;

    logger.debug('Fetching health scores for all channels', { hoursBack });

    const scores = await syncHealthService.getAllChannelHealthScores(hoursBack);

    logger.info('Health scores retrieved for all channels', {
      channelCount: scores.length
    });

    return res.json(
      successResponse(scores, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to get health scores', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

export default router;
