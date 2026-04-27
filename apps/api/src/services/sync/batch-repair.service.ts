/**
 * Batch Repair Service
 * 
 * Provides bulk repair operations for data integrity issues in the product catalog.
 * Supports:
 * - Fixing orphaned variations
 * - Repairing missing variation themes
 * - Populating missing variation attributes
 * - Normalizing product status
 * - Fixing inconsistent channel listings
 */

import { prisma } from '@nexus/database'

export interface RepairOperation {
  name: string
  description: string
  affectedCount: number
  fixedCount: number
  failedCount: number
  errors: string[]
  duration: number // milliseconds
}

export interface BatchRepairResult {
  success: boolean
  timestamp: Date
  operations: RepairOperation[]
  summary: {
    totalAffected: number
    totalFixed: number
    totalFailed: number
  }
}

export class BatchRepairService {
  /**
   * Repair all data integrity issues
   */
  async repairAll(): Promise<BatchRepairResult> {
    const startTime = Date.now()
    const operations: RepairOperation[] = []

    try {
      // Run all repair operations
      operations.push(await this.repairOrphanedVariations())
      operations.push(await this.repairMissingVariationThemes())
      operations.push(await this.repairMissingVariationAttributes())
      operations.push(await this.repairProductStatus())
      operations.push(await this.repairInconsistentChannelListings())

      const duration = Date.now() - startTime

      return {
        success: true,
        timestamp: new Date(),
        operations,
        summary: {
          totalAffected: operations.reduce((sum, op) => sum + op.affectedCount, 0),
          totalFixed: operations.reduce((sum, op) => sum + op.fixedCount, 0),
          totalFailed: operations.reduce((sum, op) => sum + op.failedCount, 0),
        },
      }
    } catch (error) {
      throw new Error(`Batch repair failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Repair orphaned variations (variations without products)
   */
  async repairOrphanedVariations(): Promise<RepairOperation> {
    const startTime = Date.now()
    const operation: RepairOperation = {
      name: 'Repair Orphaned Variations',
      description: 'Remove variations that reference non-existent products',
      affectedCount: 0,
      fixedCount: 0,
      failedCount: 0,
      errors: [],
      duration: 0,
    }

    try {
      // Find orphaned variations
      const orphaned = await (prisma as any).productVariation.findMany({
        where: {
          product: null,
        },
        select: {
          id: true,
          sku: true,
        },
      })

      operation.affectedCount = orphaned.length

      if (orphaned.length === 0) {
        operation.duration = Date.now() - startTime
        return operation
      }

      // Delete orphaned variations
      const result = await (prisma as any).productVariation.deleteMany({
        where: {
          id: {
            in: orphaned.map((v: any) => v.id),
          },
        },
      })

      operation.fixedCount = result.count
    } catch (error) {
      operation.failedCount = operation.affectedCount
      operation.errors.push(error instanceof Error ? error.message : String(error))
    }

    operation.duration = Date.now() - startTime
    return operation
  }

  /**
   * Repair missing variation themes
   */
  async repairMissingVariationThemes(): Promise<RepairOperation> {
    const startTime = Date.now()
    const operation: RepairOperation = {
      name: 'Repair Missing Variation Themes',
      description: 'Infer and set variation themes for products with variations',
      affectedCount: 0,
      fixedCount: 0,
      failedCount: 0,
      errors: [],
      duration: 0,
    }

    try {
      // Find products with variations but no theme
      const productsWithoutTheme = await (prisma as any).product.findMany({
        where: {
          AND: [
            {
              variations: {
                some: {},
              },
            },
            {
              variationTheme: null,
            },
          ],
        },
        select: {
          id: true,
          sku: true,
          variations: {
            select: {
              sku: true,
              name: true,
            },
          },
        },
      })

      operation.affectedCount = productsWithoutTheme.length

      if (productsWithoutTheme.length === 0) {
        operation.duration = Date.now() - startTime
        return operation
      }

      // Infer and set themes
      for (const product of productsWithoutTheme as any[]) {
        try {
          const theme = this.inferVariationTheme(product.variations)

          await (prisma as any).product.update({
            where: { id: product.id },
            data: { variationTheme: theme },
          })

          operation.fixedCount++
        } catch (error) {
          operation.failedCount++
          operation.errors.push(
            `Failed to repair product ${product.sku}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } catch (error) {
      operation.failedCount = operation.affectedCount
      operation.errors.push(error instanceof Error ? error.message : String(error))
    }

    operation.duration = Date.now() - startTime
    return operation
  }

  /**
   * Repair missing variation attributes
   */
  async repairMissingVariationAttributes(): Promise<RepairOperation> {
    const startTime = Date.now()
    const operation: RepairOperation = {
      name: 'Repair Missing Variation Attributes',
      description: 'Populate variationAttributes from legacy name/value fields',
      affectedCount: 0,
      fixedCount: 0,
      failedCount: 0,
      errors: [],
      duration: 0,
    }

    try {
      // Find variations with legacy fields but no attributes
      const variationsWithoutAttributes = await (prisma as any).productVariation.findMany({
        where: {
          AND: [
            {
              variationAttributes: null,
            },
            {
              OR: [
                {
                  name: {
                    not: null,
                  },
                },
                {
                  value: {
                    not: null,
                  },
                },
              ],
            },
          ],
        },
        select: {
          id: true,
          sku: true,
          name: true,
          value: true,
        },
      })

      operation.affectedCount = variationsWithoutAttributes.length

      if (variationsWithoutAttributes.length === 0) {
        operation.duration = Date.now() - startTime
        return operation
      }

      // Populate attributes
      for (const variation of variationsWithoutAttributes) {
        try {
          const attributes = {
            [variation.name || 'Variant']: variation.value || '',
          }

          await (prisma as any).productVariation.update({
            where: { id: variation.id },
            data: { variationAttributes: attributes },
          })

          operation.fixedCount++
        } catch (error) {
          operation.failedCount++
          operation.errors.push(
            `Failed to repair variation ${variation.sku}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } catch (error) {
      operation.failedCount = operation.affectedCount
      operation.errors.push(error instanceof Error ? error.message : String(error))
    }

    operation.duration = Date.now() - startTime
    return operation
  }

  /**
   * Repair product status
   */
  async repairProductStatus(): Promise<RepairOperation> {
    const startTime = Date.now()
    const operation: RepairOperation = {
      name: 'Repair Product Status',
      description: 'Ensure all products have valid status values',
      affectedCount: 0,
      fixedCount: 0,
      failedCount: 0,
      errors: [],
      duration: 0,
    }

    try {
      // Find products with invalid or missing status
      const productsWithoutStatus = await (prisma as any).product.findMany({
        where: {
          OR: [
            {
              status: null,
            },
            {
              status: '',
            },
          ],
        },
        select: {
          id: true,
          sku: true,
        },
      })

      operation.affectedCount = productsWithoutStatus.length

      if (productsWithoutStatus.length === 0) {
        operation.duration = Date.now() - startTime
        return operation
      }

      // Set default status
      const result = await (prisma as any).product.updateMany({
        where: {
          id: {
            in: productsWithoutStatus.map((p: any) => p.id),
          },
        },
        data: { status: 'ACTIVE' },
      })

      operation.fixedCount = result.count
    } catch (error) {
      operation.failedCount = operation.affectedCount
      operation.errors.push(error instanceof Error ? error.message : String(error))
    }

    operation.duration = Date.now() - startTime
    return operation
  }

  /**
   * Repair inconsistent channel listings
   */
  async repairInconsistentChannelListings(): Promise<RepairOperation> {
    const startTime = Date.now()
    const operation: RepairOperation = {
      name: 'Repair Inconsistent Channel Listings',
      description: 'Fix variations with missing or invalid channel listings',
      affectedCount: 0,
      fixedCount: 0,
      failedCount: 0,
      errors: [],
      duration: 0,
    }

    try {
      // Find variations without channel listings
      const variationsWithoutListings = await (prisma as any).productVariation.findMany({
        where: {
          channelListings: {
            none: {},
          },
        },
        select: {
          id: true,
          sku: true,
          price: true,
          stock: true,
        },
      })

      operation.affectedCount = variationsWithoutListings.length

      if (variationsWithoutListings.length === 0) {
        operation.duration = Date.now() - startTime
        return operation
      }

      // Get default channel (usually Amazon)
      const defaultChannel = await prisma.channel.findFirst({
        where: {
          type: 'AMAZON',
        },
      })

      if (!defaultChannel) {
        operation.errors.push('No default channel found')
        operation.duration = Date.now() - startTime
        return operation
      }

      // Create channel listings for variations
      for (const variation of variationsWithoutListings) {
        try {
          await (prisma as any).variantChannelListing.create({
            data: {
              variantId: variation.id,
              channelId: defaultChannel.id,
              channelPrice: variation.price,
              channelQuantity: variation.stock,
              listingStatus: 'PENDING',
            },
          })

          operation.fixedCount++
        } catch (error) {
          operation.failedCount++
          operation.errors.push(
            `Failed to create listing for variation ${variation.sku}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } catch (error) {
      operation.failedCount = operation.affectedCount
      operation.errors.push(error instanceof Error ? error.message : String(error))
    }

    operation.duration = Date.now() - startTime
    return operation
  }

  /**
   * Infer variation theme from variations
   */
  private inferVariationTheme(variations: Array<{ sku: string; name?: string | null }>): string {
    if (variations.length === 0) return 'Unknown'
    if (variations.length === 1) return variations[0].name || 'Single'

    // For multiple variations, use generic theme
    return 'MultiAxis'
  }
}
