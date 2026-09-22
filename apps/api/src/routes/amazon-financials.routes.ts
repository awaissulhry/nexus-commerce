import type { FastifyPluginAsync } from 'fastify'

const amazonFinancialsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/amazon/financials/sync — pull financial events for a date
  // window and write FinancialTransaction rows. Body: { start?, end?, daysBack? }
  // Defaults to yesterday if no range given. Safe to re-run (idempotent).
  fastify.post<{
    Body?: { start?: string; end?: string; daysBack?: number; useV0?: boolean; marketplaceId?: string | null; probe?: boolean; dryRun?: boolean; accountId?: string }
  }>('/financials/sync', async (request, reply) => {
    const { syncFinancialEvents, syncYesterdayFinancialEvents, syncFinancialTransactions, probeFinancialTransactionsEnvelope, financialsDryRunRefusal } = await import('../services/amazon-financial-events.service.js')
    try {
      if (request.body !== undefined && (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body))) {
        return reply.code(400).send({ success: false, error: 'The financial sync body must be a JSON object.' })
      }
      const body = request.body ?? {}
      const refusal = financialsDryRunRefusal(body)
      if (refusal) return reply.code(400).send({ success: false, error: refusal })
      if (body.accountId !== undefined && (typeof body.accountId !== 'string' || !body.accountId.trim())) return reply.code(400).send({ success: false, error: 'accountId must be a nonempty string.' })
      if ((body.start !== undefined && (typeof body.start !== 'string' || !Number.isFinite(new Date(body.start).getTime()))) ||
          (body.end !== undefined && (typeof body.end !== 'string' || !Number.isFinite(new Date(body.end).getTime()))) ||
          (body.daysBack !== undefined && (!Number.isFinite(body.daysBack) || body.daysBack <= 0 || body.daysBack > 180)) ||
          (!body.probe && Boolean(body.start) !== Boolean(body.end))) {
        return reply.code(400).send({ success: false, error: 'Supply a valid start/end pair or daysBack between 0 and 180.' })
      }

      // A probe reads one page; a dry run traverses a complete bounded window.
      // Neither authorizes money writes or a live channel call by itself.
      if (body.probe === true) {
        const end = new Date(Date.now() - 180_000)
        const days = typeof body.daysBack === 'number' && body.daysBack > 0 ? Math.min(body.daysBack, 30) : 1
        const start = body.start ? new Date(body.start) : new Date(end.getTime() - days * 86_400_000)
        return { success: true, probe: await probeFinancialTransactionsEnvelope(start, end, body.marketplaceId, body.accountId) }
      }
      // v0 remains the operating writer until the new API is reconciled safely.
      const useV0 = body.useV0 !== false

      // The new API reports provider-identity candidates and order/type overlap
      // risk only. This is not a monetary reconciliation or permission to cut over.
      const dryRun = body.dryRun === true

      let summary
      if (body.start && body.end) {
        const start = new Date(body.start)
        let end = new Date(body.end)
        // Same clamp as daysBack path — protects scaffold callers that pass
        // T-23:59:59Z for "today" windows.
        const minAgo = new Date(Date.now() - 180_000)
        if (end > minAgo) end = minAgo
        summary = useV0
          ? await syncFinancialEvents(start, end)
          : await syncFinancialTransactions(start, end, body.marketplaceId, { dryRun, accountId: body.accountId })
      } else if (typeof body.daysBack === 'number') {
        // Clamp `end` to now − 3 min (SP-API rejects PostedBefore within
        // its ~2-min data-propagation window).
        const end = new Date(Date.now() - 180_000)
        const start = new Date(end.getTime() - body.daysBack * 24 * 60 * 60 * 1000)
        summary = useV0
          ? await syncFinancialEvents(start, end)
          : await syncFinancialTransactions(start, end, body.marketplaceId, { dryRun, accountId: body.accountId })
      } else {
        // Yesterday window
        const end = new Date()
        end.setHours(0, 0, 0, 0)
        const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
        summary = useV0
          ? await syncYesterdayFinancialEvents()
          : await syncFinancialTransactions(start, end, body.marketplaceId, { dryRun, accountId: body.accountId })
      }
      return { success: true, ...summary }
    } catch (err) {
      fastify.log.error({ err }, '[amazon/financials/sync] failed')
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

}

export default amazonFinancialsRoutes
