/**
 * Bulk Actions Routes
 * Endpoints for managing asynchronous bulk operations
 */

import { Router, Request, Response } from 'express';
import { BulkActionService } from '../services/bulk-action.service';
import prisma from '../db';
import { logger } from '../utils/logger';
import {
  CreateBulkJobSchema,
  CreateBulkJobRequest
} from './validation';
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  notFoundResponse,
  internalErrorResponse
} from './response';

const router = Router();
const bulkActionService = new BulkActionService(prisma);

/**
 * POST /api/bulk-actions
 * Create a new bulk action job
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    // Validate request
    const validation = CreateBulkJobSchema.safeParse(req.body);
    if (!validation.success) {
      const errors: Record<string, string[]> = {};
      validation.error.issues.forEach(err => {
        const path = err.path.join('.');
        if (!errors[path]) errors[path] = [];
        errors[path].push(err.message);
      });
      return res.status(400).json(validationErrorResponse(errors));
    }

    const input: CreateBulkJobRequest = validation.data;

    logger.info('Creating bulk action job', {
      jobName: input.jobName,
      actionType: input.actionType,
      channel: input.channel
    });

    // Create job
    const job = await bulkActionService.createJob(input);

    logger.info('Bulk action job created successfully', {
      jobId: job.id,
      totalItems: job.totalItems
    });

    return res.status(201).json(
      successResponse(job, {
        path: req.path
      })
    );
  } catch (error) {
    logger.error('Failed to create bulk action job', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * GET /api/bulk-actions/:id
 * Get bulk action job status and progress
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Job ID is required')
      );
    }

    logger.debug('Fetching bulk action job status', { jobId: id });

    const job = await bulkActionService.getJobStatus(id);

    if (!job) {
      return res.status(404).json(notFoundResponse('Bulk Action Job', id));
    }

    logger.info('Bulk action job status retrieved', {
      jobId: id,
      status: job.status,
      progress: job.progressPercent
    });

    return res.json(
      successResponse(job, {
        path: req.path
      })
    );
  } catch (error) {
    logger.error('Failed to get bulk action job status', {
      jobId: req.params.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * POST /api/bulk-actions/:id/process
 * Trigger job processing (asynchronous)
 */
router.post('/:id/process', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Job ID is required')
      );
    }

    logger.info('Processing bulk action job', { jobId: id });

    // Check job exists
    const job = await bulkActionService.getJobStatus(id);
    if (!job) {
      return res.status(404).json(notFoundResponse('Bulk Action Job', id));
    }

    if (job.status !== 'PENDING' && job.status !== 'QUEUED') {
      return res.status(400).json(
        errorResponse(
          'INVALID_STATE',
          `Cannot process job with status: ${job.status}`
        )
      );
    }

    // Process job asynchronously (fire and forget)
    // In production, this should be queued to a job processor
    bulkActionService.processJob(id).catch(error => {
      logger.error('Async job processing failed', {
        jobId: id,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    logger.info('Bulk action job processing started', { jobId: id });

    return res.json(
      successResponse(
        {
          jobId: id,
          status: 'IN_PROGRESS',
          message: 'Job processing started'
        },
        { path: req.path }
      )
    );
  } catch (error) {
    logger.error('Failed to process bulk action job', {
      jobId: req.params.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * GET /api/bulk-actions
 * Get all pending jobs
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    logger.debug('Fetching pending bulk action jobs');

    const jobs = await bulkActionService.getPendingJobs();

    logger.info('Pending bulk action jobs retrieved', {
      count: jobs.length
    });

    return res.json(
      successResponse(jobs, {
        path: req.path
      })
    );
  } catch (error) {
    logger.error('Failed to get pending bulk action jobs', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * POST /api/bulk-actions/:id/cancel
 * Cancel a pending job
 */
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Job ID is required')
      );
    }

    logger.info('Cancelling bulk action job', { jobId: id });

    const job = await bulkActionService.getJobStatus(id);
    if (!job) {
      return res.status(404).json(notFoundResponse('Bulk Action Job', id));
    }

    const cancelledJob = await bulkActionService.cancelJob(id);

    logger.info('Bulk action job cancelled successfully', { jobId: id });

    return res.json(
      successResponse(cancelledJob, {
        path: req.path
      })
    );
  } catch (error) {
    logger.error('Failed to cancel bulk action job', {
      jobId: req.params.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * POST /api/bulk-actions/:id/rollback
 * Create a rollback job
 */
router.post('/:id/rollback', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Job ID is required')
      );
    }

    logger.info('Creating rollback job', { originalJobId: id });

    const rollbackJob = await bulkActionService.createRollbackJob(id);

    logger.info('Rollback job created successfully', {
      rollbackJobId: rollbackJob.id,
      originalJobId: id
    });

    return res.status(201).json(
      successResponse(rollbackJob, {
        path: req.path
      })
    );
  } catch (error) {
    logger.error('Failed to create rollback job', {
      originalJobId: req.params.id,
      error: error instanceof Error ? error.message : String(error)
    });

    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('not found')) {
      return res.status(404).json(notFoundResponse('Bulk Action Job', req.params.id));
    }
    if (errorMessage.includes('not rollbackable')) {
      return res.status(400).json(
        errorResponse('INVALID_STATE', 'Job is not rollbackable')
      );
    }

    return res.status(500).json(internalErrorResponse());
  }
});

export default router;
