/**
 * Phase 30: Attribute Inheritance Tests
 * 
 * Tests for reactive attribute inheritance with user override capability
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import prisma from '../../db.js';
import {
  onParentAttributeUpdate,
  toggleAttributeLock,
  getLockedAttributes,
} from '../attribute-inheritance.service.js';

describe('Phase 30: Attribute Inheritance', () => {
  let parentProductId: string;
  let childVariationId: string;

  beforeAll(async () => {
    // Create a parent product
    const parent = await prisma.product.create({
      data: {
        sku: 'PARENT-TEST-001',
        name: 'Test Parent Product',
        basePrice: 99.99,
        totalStock: 100,
        isParent: true,
        categoryAttributes: {
          Material: 'Cotton',
          Color: 'Blue',
          Size: 'M',
        },
      },
    });
    parentProductId = parent.id;

    // Create a child variation
    const child = await prisma.productVariation.create({
      data: {
        productId: parentProductId,
        sku: 'CHILD-TEST-001',
        price: 49.99,
        stock: 50,
        categoryAttributes: {
          Material: 'Cotton',
          Color: 'Blue',
          Size: 'M',
        },
      },
    });
    childVariationId = child.id;
  });

  afterAll(async () => {
    // Cleanup
    await prisma.productVariation.deleteMany({
      where: { productId: parentProductId },
    });
    await prisma.product.delete({
      where: { id: parentProductId },
    });
  });

  describe('onParentAttributeUpdate', () => {
    it('should sync parent attributes to unlocked child attributes', async () => {
      const updatedAttributes = {
        Material: 'Polyester',
        Color: 'Red',
      };

      const results = await onParentAttributeUpdate(
        parentProductId,
        updatedAttributes
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].attributesUpdated).toContain('Material');
      expect(results[0].attributesUpdated).toContain('Color');

      // Verify child was updated
      const updatedChild = await prisma.productVariation.findUnique({
        where: { id: childVariationId },
      });

      expect(updatedChild?.categoryAttributes).toEqual({
        Material: 'Polyester',
        Color: 'Red',
        Size: 'M', // Should remain unchanged
      });
    });

    it('should skip locked attributes during sync', async () => {
      // Lock the Material attribute
      await toggleAttributeLock(childVariationId, 'Material', true);

      const updatedAttributes = {
        Material: 'Silk',
        Color: 'Green',
      };

      const results = await onParentAttributeUpdate(
        parentProductId,
        updatedAttributes
      );

      expect(results[0].attributesSkipped).toContain('Material');
      expect(results[0].attributesUpdated).toContain('Color');

      // Verify Material was NOT updated (still Polyester from previous test)
      const updatedChild = await prisma.productVariation.findUnique({
        where: { id: childVariationId },
      });

      expect(updatedChild?.categoryAttributes?.Material).toBe('Polyester');
      expect(updatedChild?.categoryAttributes?.Color).toBe('Green');
    });
  });

  describe('toggleAttributeLock', () => {
    it('should lock an attribute', async () => {
      const locked = await toggleAttributeLock(
        childVariationId,
        'Size',
        true
      );

      expect(locked.Size).toBe(true);

      // Verify in database
      const child = await prisma.productVariation.findUnique({
        where: { id: childVariationId },
      });

      expect((child?.lockedAttributes as any)?.Size).toBe(true);
    });

    it('should unlock an attribute', async () => {
      const locked = await toggleAttributeLock(
        childVariationId,
        'Size',
        false
      );

      expect(locked.Size).toBe(false);
    });
  });

  describe('getLockedAttributes', () => {
    it('should return locked attributes for a variation', async () => {
      // Lock multiple attributes
      await toggleAttributeLock(childVariationId, 'Material', true);
      await toggleAttributeLock(childVariationId, 'Color', true);

      const locked = await getLockedAttributes(childVariationId);

      expect(locked.Material).toBe(true);
      expect(locked.Color).toBe(true);
    });

    it('should return empty object if no attributes are locked', async () => {
      // Create a new child without locks
      const newChild = await prisma.productVariation.create({
        data: {
          productId: parentProductId,
          sku: 'CHILD-TEST-002',
          price: 49.99,
          stock: 50,
        },
      });

      const locked = await getLockedAttributes(newChild.id);

      expect(Object.keys(locked)).toHaveLength(0);

      // Cleanup
      await prisma.productVariation.delete({
        where: { id: newChild.id },
      });
    });
  });

  describe('Delta Check (selective updates)', () => {
    it('should only update non-locked attributes', async () => {
      // Setup: lock Material, leave Color unlocked
      await toggleAttributeLock(childVariationId, 'Material', true);
      await toggleAttributeLock(childVariationId, 'Color', false);

      // Update both attributes on parent
      const updatedAttributes = {
        Material: 'Wool',
        Color: 'Yellow',
      };

      const results = await onParentAttributeUpdate(
        parentProductId,
        updatedAttributes
      );

      // Material should be skipped, Color should be updated
      expect(results[0].attributesSkipped).toContain('Material');
      expect(results[0].attributesUpdated).toContain('Color');

      // Verify the actual values
      const child = await prisma.productVariation.findUnique({
        where: { id: childVariationId },
      });

      expect(child?.categoryAttributes?.Material).not.toBe('Wool');
      expect(child?.categoryAttributes?.Color).toBe('Yellow');
    });
  });
});
