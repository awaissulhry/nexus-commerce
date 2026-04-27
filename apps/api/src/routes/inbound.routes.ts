/**
 * Phase 10: Inbound Catalog Sync Routes
 * 
 * Endpoints for syncing live catalog from Amazon EU into the Matrix structure
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { syncAmazonEUCatalog } from '../services/inbound-sync.service.js'
import { logger } from '../utils/logger.js'

/**
 * POST /api/inbound/sync-catalog
 * 
 * Triggers the Amazon EU catalog sync (The Vacuum)
 * Fetches live products and unpacks them into the Matrix structure
 */
async function syncCatalog(request: FastifyRequest, reply: FastifyReply) {
  try {
    logger.info('Catalog sync request received')

    // Trigger the sync
    const results = await syncAmazonEUCatalog()

    logger.info('Catalog sync completed successfully', results)

    return reply.status(200).send({
      success: true,
      message: 'Amazon EU catalog sync completed',
      results,
    })
  } catch (error) {
    logger.error('Error during catalog sync', {
      error: error instanceof Error ? error.message : String(error),
    })

    return reply.status(500).send({
      success: false,
      error: 'Failed to sync catalog',
      message: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * GET /api/inbound/sync-status
 * 
 * Returns the status of the last sync operation
 * (For future implementation with persistent sync logs)
 */
async function getSyncStatus(request: FastifyRequest, reply: FastifyReply) {
  try {
    logger.info('Sync status request received')

    return reply.status(200).send({
      status: 'ready',
      lastSync: null,
      message: 'Catalog sync engine is ready',
    })
  } catch (error) {
    logger.error('Error retrieving sync status', {
      error: error instanceof Error ? error.message : String(error),
    })

    return reply.status(500).send({
      error: 'Failed to retrieve sync status',
    })
  }
}

export async function inboundRoutes(fastify: FastifyInstance) {
  fastify.post('/api/inbound/sync-catalog', syncCatalog)
  fastify.get('/api/inbound/sync-status', getSyncStatus)
}
