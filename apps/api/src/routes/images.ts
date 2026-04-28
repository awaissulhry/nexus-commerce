import { Router, Request, Response } from 'express';
import { ImageService, AutoAssignImages, ColorAnalyzer } from '../services/image.service.js';
import prisma from '../db.js';

const router = Router();

/**
 * POST /api/images/upload
 * Upload image for a product
 */
router.post('/upload', async (req: Request, res: Response) => {
  try {
    const { productId, imageUrl, type = 'ALT', alt } = req.body;

    if (!productId || !imageUrl) {
      return res.status(400).json({
        error: 'Missing required fields: productId, imageUrl',
      });
    }

    const image = await ImageService.uploadImage(
      productId,
      imageUrl,
      type,
      alt
    );

    res.json({
      success: true,
      image,
    });
  } catch (error) {
    console.error('Image upload error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Upload failed',
    });
  }
});

/**
 * GET /api/images/:productId
 * Get all images for a product
 */
router.get('/:productId', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;

    const images = await ImageService.getProductImages(productId);

    res.json({
      success: true,
      images,
      count: images.length,
    });
  } catch (error) {
    console.error('Get images error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch images',
    });
  }
});

/**
 * PUT /api/images/:imageId/hero
 * Set image as hero/primary image
 */
router.put('/:imageId/hero', async (req: Request, res: Response) => {
  try {
    const { imageId } = req.params;
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        error: 'Missing required field: productId',
      });
    }

    const image = await ImageService.setHeroImage(imageId, productId);

    res.json({
      success: true,
      image,
    });
  } catch (error) {
    console.error('Set hero image error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to set hero image',
    });
  }
});

/**
 * PUT /api/images/:imageId/color
 * Update color override for image
 */
router.put('/:imageId/color', async (req: Request, res: Response) => {
  try {
    const { imageId } = req.params;
    const { colorOverride } = req.body;

    if (!colorOverride) {
      return res.status(400).json({
        error: 'Missing required field: colorOverride',
      });
    }

    const image = await ImageService.updateColorOverride(imageId, colorOverride);

    res.json({
      success: true,
      image,
    });
  } catch (error) {
    console.error('Update color override error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update color',
    });
  }
});

/**
 * DELETE /api/images/:imageId
 * Delete image
 */
router.delete('/:imageId', async (req: Request, res: Response) => {
  try {
    const { imageId } = req.params;

    await ImageService.deleteImage(imageId);

    res.json({
      success: true,
      message: 'Image deleted successfully',
    });
  } catch (error) {
    console.error('Delete image error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to delete image',
    });
  }
});

/**
 * POST /api/images/:productId/auto-assign
 * Automatically assign images to variants based on color matching
 */
router.post('/:productId/auto-assign', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;

    const result = await AutoAssignImages.assignImagesToVariants(productId);

    res.json({
      success: true,
      assigned: result.assigned,
      updated: result.updated,
      message: `Assigned ${result.assigned} images to ${result.updated} variants`,
    });
  } catch (error) {
    console.error('Auto-assign images error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Auto-assign failed',
    });
  }
});

/**
 * POST /api/images/:imageId/assign-variants
 * Manually assign image to specific variants
 */
router.post('/:imageId/assign-variants', async (req: Request, res: Response) => {
  try {
    const { imageId } = req.params;
    const { variantIds } = req.body;

    if (!Array.isArray(variantIds)) {
      return res.status(400).json({
        error: 'Missing required field: variantIds (array)',
      });
    }

    const image = await AutoAssignImages.assignImageToVariants(
      imageId,
      variantIds
    );

    res.json({
      success: true,
      image,
      assignedCount: variantIds.length,
    });
  } catch (error) {
    console.error('Assign variants error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Assignment failed',
    });
  }
});

/**
 * GET /api/images/:imageId/assigned-variants
 * Get variants assigned to an image
 */
router.get('/:imageId/assigned-variants', async (req: Request, res: Response) => {
  try {
    const { imageId } = req.params;

    const variants = await AutoAssignImages.getAssignedVariants(imageId);

    res.json({
      success: true,
      variants,
      count: variants.length,
    });
  } catch (error) {
    console.error('Get assigned variants error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch variants',
    });
  }
});

/**
 * GET /api/images/:productId/by-color/:color
 * Get images by color
 */
router.get('/:productId/by-color/:color', async (req: Request, res: Response) => {
  try {
    const { productId, color } = req.params;

    const images = await ImageService.getImagesByColor(productId, color);

    res.json({
      success: true,
      images,
      count: images.length,
    });
  } catch (error) {
    console.error('Get images by color error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch images',
    });
  }
});

/**
 * POST /api/images/analyze-color
 * Analyze color from image URL
 */
router.post('/analyze-color', async (req: Request, res: Response) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        error: 'Missing required field: imageUrl',
      });
    }

    const { color, confidence } = await ColorAnalyzer.extractDominantColor(
      imageUrl
    );
    const colorName = ColorAnalyzer.colorNameFromHex(color);

    res.json({
      success: true,
      color,
      colorName,
      confidence,
    });
  } catch (error) {
    console.error('Color analysis error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Analysis failed',
    });
  }
});

export default router;
