/**
 * Phase 30: Attribute Inheritance Routes
 * 
 * API endpoints for managing reactive attribute inheritance
 */

import { Router } from 'express';
import {
  onParentAttributeUpdate,
  toggleAttributeLock,
  getLockedAttributes,
  bulkToggleAttributeLocks,
} from '../services/attribute-inheritance.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * POST /api/attributes/sync-parent
 * Sync parent attributes to all child variations
 */
router.post('/sync-parent', async (req, res) => {
  try {
    const { parentProductId, attributes } = req.body;

    if (!parentProductId || !attributes) {
      return res.status(400).json({
        error: 'Missing required fields: parentProductId, attributes',
      });
    }

    const results = await onParentAttributeUpdate(parentProductId, attributes);

    res.json({
      success: true,
      message: 'Parent attributes synced to children',
      results,
    });
  } catch (error: any) {
    logger.error('[PHASE30] Sync parent attributes failed', {
      error: error.message,
    });
    res.status(500).json({
      error: 'Failed to sync parent attributes',
      details: error.message,
    });
  }
});

/**
 * POST /api/attributes/lock
 * Toggle attribute lock for a child variation
 */
router.post('/lock', async (req, res) => {
  try {
    const { childVariationId, attributeName, locked } = req.body;

    if (!childVariationId || !attributeName || locked === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: childVariationId, attributeName, locked',
      });
    }

    const updatedLocked = await toggleAttributeLock(
      childVariationId,
      attributeName,
      locked
    );

    res.json({
      success: true,
      message: `Attribute "${attributeName}" ${locked ? 'locked' : 'unlocked'}`,
      lockedAttributes: updatedLocked,
    });
  } catch (error: any) {
    logger.error('[PHASE30] Toggle attribute lock failed', {
      error: error.message,
    });
    res.status(500).json({
      error: 'Failed to toggle attribute lock',
      details: error.message,
    });
  }
});

/**
 * GET /api/attributes/locked/:childVariationId
 * Get locked attributes for a child variation
 */
router.get('/locked/:childVariationId', async (req, res) => {
  try {
    const { childVariationId } = req.params;

    const lockedAttributes = await getLockedAttributes(childVariationId);

    res.json({
      success: true,
      childVariationId,
      lockedAttributes,
    });
  } catch (error: any) {
    logger.error('[PHASE30] Get locked attributes failed', {
      error: error.message,
    });
    res.status(500).json({
      error: 'Failed to get locked attributes',
      details: error.message,
    });
  }
});

/**
 * POST /api/attributes/bulk-lock
 * Bulk toggle attribute locks for multiple children
 */
router.post('/bulk-lock', async (req, res) => {
  try {
    const { childVariationIds, attributeName, locked } = req.body;

    if (!childVariationIds || !Array.isArray(childVariationIds) || !attributeName || locked === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: childVariationIds (array), attributeName, locked',
      });
    }

    const results = await bulkToggleAttributeLocks(
      childVariationIds,
      attributeName,
      locked
    );

    res.json({
      success: true,
      message: `Bulk toggled "${attributeName}" for ${results.size} variations`,
      results: Object.fromEntries(results),
    });
  } catch (error: any) {
    logger.error('[PHASE30] Bulk toggle attribute locks failed', {
      error: error.message,
    });
    res.status(500).json({
      error: 'Failed to bulk toggle attribute locks',
      details: error.message,
    });
  }
});

export default router;
