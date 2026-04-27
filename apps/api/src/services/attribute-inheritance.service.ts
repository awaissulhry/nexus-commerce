/**
 * Phase 30: Reactive Attribute Inheritance Service
 *
 * Manages parent-to-child attribute synchronization with user override capability.
 * When parent attributes change, automatically syncs to unlocked child attributes.
 */

import prisma from '../db.js';
import { logger } from '../utils/logger.js';

export interface LockedAttributes {
  [attributeName: string]: boolean; // true = locked (don't inherit), false = inherit
}

export interface AttributeInheritanceResult {
  childId: string;
  attributesUpdated: string[];
  attributesSkipped: string[]; // locked attributes
  success: boolean;
  error?: string;
}

/**
 * Main hook: Called when parent product attributes change
 * Syncs changes to all child variations, respecting locked attributes
 */
export async function onParentAttributeUpdate(
  parentProductId: string,
  updatedAttributes: Record<string, any>
): Promise<AttributeInheritanceResult[]> {
  try {
    logger.info('[PHASE30] Parent attribute update triggered', {
      parentProductId,
      attributeKeys: Object.keys(updatedAttributes),
    });

    // Fetch parent product
    const parent = await prisma.product.findUnique({
      where: { id: parentProductId },
      include: { children: true },
    });

    if (!parent) {
      throw new Error(`Parent product not found: ${parentProductId}`);
    }

    if (!parent.children || parent.children.length === 0) {
      logger.info('[PHASE30] No child variations found', { parentProductId });
      return [];
    }

    // Process each child variation
    const results: AttributeInheritanceResult[] = [];

    for (const child of parent.children) {
      const result = await syncAttributesToChild(
        child.id,
        updatedAttributes,
        child.lockedAttributes as LockedAttributes | null
      );
      results.push(result);
    }

    logger.info('[PHASE30] Parent attribute sync completed', {
      parentProductId,
      childrenProcessed: results.length,
      successCount: results.filter((r) => r.success).length,
    });

    return results;
  } catch (error: any) {
    logger.error('[PHASE30] Parent attribute update failed', {
      parentProductId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Sync parent attributes to a single child variation
 * Respects locked attributes (delta check)
 */
async function syncAttributesToChild(
  childVariationId: string,
  parentAttributes: Record<string, any>,
  lockedAttributes: LockedAttributes | null
): Promise<AttributeInheritanceResult> {
  try {
    // Fetch current child variation
    const child = await prisma.productVariation.findUnique({
      where: { id: childVariationId },
    });

    if (!child) {
      return {
        childId: childVariationId,
        attributesUpdated: [],
        attributesSkipped: [],
        success: false,
        error: 'Child variation not found',
      };
    }

    // Parse locked attributes (default: all unlocked)
    const locked = lockedAttributes || {};

    // Perform delta check: only update non-locked attributes
    const currentAttributes = (child.categoryAttributes as Record<string, any>) || {};
    const attributesToUpdate: Record<string, any> = {};
    const attributesSkipped: string[] = [];

    for (const [key, value] of Object.entries(parentAttributes)) {
      if (locked[key] === true) {
        // Attribute is locked - skip it
        attributesSkipped.push(key);
        logger.debug('[PHASE30] Attribute locked, skipping', {
          childId: childVariationId,
          attribute: key,
        });
      } else {
        // Attribute is not locked - update it
        attributesToUpdate[key] = value;
      }
    }

    // Merge with existing attributes (preserve variation-specific ones)
    const mergedAttributes = {
      ...currentAttributes,
      ...attributesToUpdate,
    };

    // Update child variation
    const updated = await prisma.productVariation.update({
      where: { id: childVariationId },
      data: {
        categoryAttributes: mergedAttributes,
      },
    });

    logger.info('[PHASE30] Child attributes synced', {
      childId: childVariationId,
      attributesUpdated: Object.keys(attributesToUpdate),
      attributesSkipped,
    });

    return {
      childId: childVariationId,
      attributesUpdated: Object.keys(attributesToUpdate),
      attributesSkipped,
      success: true,
    };
  } catch (error: any) {
    logger.error('[PHASE30] Child attribute sync failed', {
      childId: childVariationId,
      error: error.message,
    });

    return {
      childId: childVariationId,
      attributesUpdated: [],
      attributesSkipped: [],
      success: false,
      error: error.message,
    };
  }
}

/**
 * Toggle attribute lock status for a child variation
 * When locked=true, attribute won't inherit from parent
 */
export async function toggleAttributeLock(
  childVariationId: string,
  attributeName: string,
  locked: boolean
): Promise<LockedAttributes> {
  try {
    const child = await prisma.productVariation.findUnique({
      where: { id: childVariationId },
    });

    if (!child) {
      throw new Error(`Child variation not found: ${childVariationId}`);
    }

    // Parse current locked attributes
    const currentLocked = (child.lockedAttributes as LockedAttributes) || {};

    // Update lock status
    const updatedLocked = {
      ...currentLocked,
      [attributeName]: locked,
    };

    // Save to database
    await prisma.productVariation.update({
      where: { id: childVariationId },
      data: {
        lockedAttributes: updatedLocked,
      },
    });

    logger.info('[PHASE30] Attribute lock toggled', {
      childId: childVariationId,
      attribute: attributeName,
      locked,
    });

    return updatedLocked;
  } catch (error: any) {
    logger.error('[PHASE30] Toggle attribute lock failed', {
      childId: childVariationId,
      attribute: attributeName,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get locked attributes for a child variation
 */
export async function getLockedAttributes(
  childVariationId: string
): Promise<LockedAttributes> {
  try {
    const child = await prisma.productVariation.findUnique({
      where: { id: childVariationId },
    });

    if (!child) {
      throw new Error(`Child variation not found: ${childVariationId}`);
    }

    return (child.lockedAttributes as LockedAttributes) || {};
  } catch (error: any) {
    logger.error('[PHASE30] Get locked attributes failed', {
      childId: childVariationId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Bulk update locked attributes for multiple children
 */
export async function bulkToggleAttributeLocks(
  childVariationIds: string[],
  attributeName: string,
  locked: boolean
): Promise<Map<string, LockedAttributes>> {
  const results = new Map<string, LockedAttributes>();

  for (const childId of childVariationIds) {
    try {
      const updated = await toggleAttributeLock(childId, attributeName, locked);
      results.set(childId, updated);
    } catch (error: any) {
      logger.error('[PHASE30] Bulk toggle failed for child', {
        childId,
        error: error.message,
      });
    }
  }

  return results;
}
