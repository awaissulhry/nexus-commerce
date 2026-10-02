import type { FastifyInstance } from 'fastify'

/** Dictionary edits must be visible immediately in both editor caches. */
export function invalidateAttributeSchemasAfterWrites(fastify: FastifyInstance) {
  fastify.addHook('onResponse', async (request, reply) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) || reply.statusCode >= 300
      || !/\/(?:families|family-attributes|attributes|attribute-options|attribute-groups)(?:\/|\?|$)/.test(request.url)) return
    await clearAttributeSchemaCaches()
  })
}

/** MCP full control P8 — the same clear, for a write made outside these routes (Claude's structure changes). */
export async function clearAttributeSchemaCaches(): Promise<void> {
  const { clearSheetColumnCache } = await import('./sheet-columns.service.js')
  const { clearStudioColumnCache } = await import('./studio-columns.js')
  clearSheetColumnCache(); clearStudioColumnCache()
}
