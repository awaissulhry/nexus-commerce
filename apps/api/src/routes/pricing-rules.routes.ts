/**
 * Pricing Rules Routes
 * Endpoints for managing pricing rules and price evaluation
 */

import { Router, Request, Response } from 'express';
import { PricingRulesService } from '../services/pricing-rules.service.js';
import prisma from '../db.js';
import { logger } from '../utils/logger.js';
import {
  CreatePricingRuleSchema,
  CreatePricingRuleRequest,
  EvaluatePriceSchema,
  EvaluatePriceRequest
} from './validation.js';
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  notFoundResponse,
  internalErrorResponse
} from './response.js';

const router = Router();
const pricingRulesService = new PricingRulesService(prisma);

/**
 * POST /api/pricing-rules
 * Create a new pricing rule
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const validation = CreatePricingRuleSchema.safeParse(req.body);
    if (!validation.success) {
      const errors: Record<string, string[]> = {};
      validation.error.issues.forEach(err => {
        const path = err.path.join('.');
        if (!errors[path]) errors[path] = [];
        errors[path].push(err.message);
      });
      return res.status(400).json(validationErrorResponse(errors));
    }

    const input: CreatePricingRuleRequest = validation.data;

    logger.info('Creating pricing rule', {
      name: input.name,
      type: input.type,
      priority: input.priority
    });

    const rule = await pricingRulesService.createRule(input);

    logger.info('Pricing rule created successfully', {
      ruleId: rule.id,
      name: rule.name
    });

    return res.status(201).json(
      successResponse(rule, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to create pricing rule', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * GET /api/pricing-rules/variation/:variationId
 * Get all active rules for a specific variation
 */
router.get('/variation/:variationId', async (req: Request, res: Response) => {
  try {
    const { variationId } = req.params;

    if (!variationId) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Variation ID is required')
      );
    }

    logger.debug('Fetching rules for variation', { variationId });

    const rules = await pricingRulesService.getActiveRulesForVariation(variationId);

    logger.info('Rules retrieved for variation', {
      variationId,
      ruleCount: rules.length
    });

    return res.json(
      successResponse(rules, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to get rules for variation', {
      variationId: req.params.variationId,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * POST /api/pricing-rules/evaluate
 * Evaluate price based on active rules
 */
router.post('/evaluate', async (req: Request, res: Response) => {
  try {
    const validation = EvaluatePriceSchema.safeParse(req.body);
    if (!validation.success) {
      const errors: Record<string, string[]> = {};
      validation.error.issues.forEach(err => {
        const path = err.path.join('.');
        if (!errors[path]) errors[path] = [];
        errors[path].push(err.message);
      });
      return res.status(400).json(validationErrorResponse(errors));
    }

    const input: EvaluatePriceRequest = validation.data;

    logger.debug('Evaluating price', {
      variationId: input.variationId,
      currentPrice: input.currentPrice
    });

    const result = await pricingRulesService.evaluatePrice({
      variationId: input.variationId,
      currentPrice: typeof input.currentPrice === 'string' ? parseFloat(input.currentPrice) : input.currentPrice,
      competitorPrice: input.competitorPrice ? (typeof input.competitorPrice === 'string' ? parseFloat(input.competitorPrice) : input.competitorPrice) : undefined,
      costPrice: input.costPrice ? (typeof input.costPrice === 'string' ? parseFloat(input.costPrice) : input.costPrice) : undefined
    });

    logger.info('Price evaluated successfully', {
      variationId: input.variationId,
      originalPrice: result.originalPrice.toString(),
      calculatedPrice: result.calculatedPrice.toString(),
      appliedRule: result.appliedRuleName
    });

    return res.json(
      successResponse(result, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to evaluate price', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * GET /api/pricing-rules
 * Get all active pricing rules
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    logger.debug('Fetching all active pricing rules');

    const rules = await pricingRulesService.getActiveRules();

    logger.info('Active pricing rules retrieved', {
      ruleCount: rules.length
    });

    return res.json(
      successResponse(rules, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to get active pricing rules', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * PUT /api/pricing-rules/:id
 * Update a pricing rule
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Rule ID is required')
      );
    }

    const validation = CreatePricingRuleSchema.partial().safeParse(req.body);
    if (!validation.success) {
      const errors: Record<string, string[]> = {};
      validation.error.issues.forEach(err => {
        const path = err.path.join('.');
        if (!errors[path]) errors[path] = [];
        errors[path].push(err.message);
      });
      return res.status(400).json(validationErrorResponse(errors));
    }

    logger.info('Updating pricing rule', { ruleId: id });

    const updatedRule = await pricingRulesService.updateRule(id, validation.data);

    logger.info('Pricing rule updated successfully', { ruleId: id });

    return res.json(
      successResponse(updatedRule, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to update pricing rule', {
      ruleId: req.params.id,
      error: error instanceof Error ? error.message : String(error)
    });

    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('not found')) {
      return res.status(404).json(notFoundResponse('Pricing Rule', req.params.id));
    }

    return res.status(500).json(internalErrorResponse());
  }
});

/**
 * DELETE /api/pricing-rules/:id
 * Deactivate a pricing rule
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json(
        errorResponse('INVALID_REQUEST', 'Rule ID is required')
      );
    }

    logger.info('Deactivating pricing rule', { ruleId: id });

    const deactivatedRule = await pricingRulesService.deactivateRule(id);

    logger.info('Pricing rule deactivated successfully', { ruleId: id });

    return res.json(
      successResponse(deactivatedRule, { path: req.path })
    );
  } catch (error) {
    logger.error('Failed to deactivate pricing rule', {
      ruleId: req.params.id,
      error: error instanceof Error ? error.message : String(error)
    });

    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('not found')) {
      return res.status(404).json(notFoundResponse('Pricing Rule', req.params.id));
    }

    return res.status(500).json(internalErrorResponse());
  }
});

export default router;
