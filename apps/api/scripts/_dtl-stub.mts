/**
 * NAF.DT verification stub — READ-ONLY. Serves only the endpoints the fleet
 * page reads, using the real timeline service against the real database.
 *
 * Why not the real API: booting apps/api starts always-on crons (the orphan
 * sweeper among them) against production Neon. This process opens no cron,
 * writes nothing, and exits when killed.
 */
import '../src/env.js'
import { createServer } from 'node:http'

const { default: prisma } = await import('/Users/awais/nexus-commerce/apps/api/src/db.js')
const { getFleetTimeline } = await import(
  '/Users/awais/nexus-commerce/apps/api/src/services/agent-fleet/fleet-timeline.service.js'
)
const { FLEET_GRAPH } = await import(
  '/Users/awais/nexus-commerce/apps/api/src/services/agent-fleet/fleet-graph.js'
)

const charterRows = () =>
  prisma.agentCharter.findMany({
    select: {
      key: true, name: true, tier: true, domain: true, description: true,
      enabled: true, autonomyLevel: true, dailyBudgetUSD: true, maxTokensPerRun: true,
    },
    orderBy: { key: 'asc' },
  })

async function handle(url: URL): Promise<unknown> {
  const p = url.pathname
  const q = url.searchParams

  if (p.endsWith('/timeline')) {
    return getFleetTimeline(
      { q: q.get('q') ?? undefined, actor: q.get('actor') ?? undefined },
      { limit: Number(q.get('limit')) || 40, cursor: q.get('cursor') ?? undefined },
    )
  }
  if (p.endsWith('/charters')) {
    const rows = await charterRows()
    return {
      charters: rows.map((c) => ({
        ...c,
        dailyBudgetUSD: Number(c.dailyBudgetUSD),
        autonomyCap: 'PROPOSE',
        degraded: false,
      })),
    }
  }
  if (p.endsWith('/graph')) {
    const rows = await charterRows()
    const byKey = new Map(rows.map((c) => [c.key, c]))
    return {
      nodes: FLEET_GRAPH.nodes.map((n: { key: string; tier: string }) => ({
        key: n.key,
        tier: n.tier,
        enabled: byKey.get(n.key)?.enabled ?? false,
        autonomyLevel: byKey.get(n.key)?.autonomyLevel ?? 'OFF',
        degraded: false,
      })),
      edges: FLEET_GRAPH.edges,
    }
  }
  if (p.endsWith('/state')) {
    const s = await prisma.agentFleetState.findUnique({
      where: { id: 'singleton' },
      select: { halted: true, haltReason: true, dailyCeilingUSD: true },
    })
    return {
      halted: s?.halted ?? false,
      haltReason: s?.haltReason ?? null,
      dailyCeilingUSD: Number(s?.dailyCeilingUSD ?? 2),
      degraded: false,
    }
  }
  if (p.endsWith('/runs')) {
    const runs = await prisma.agentRun.findMany({
      where: { mode: { not: null } },
      select: {
        id: true, agentKey: true, mode: true, trigger: true, status: true, ok: true,
        findingCount: true, costUSD: true, latencyMs: true, haltedReason: true,
        errorMessage: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 60,
    })
    return { runs: runs.map((r) => ({ ...r, costUSD: String(r.costUSD) })) }
  }
  if (p.endsWith('/findings')) {
    const findings = await prisma.agentFinding.findMany({
      select: {
        id: true, runId: true, charterKey: true, kind: true, entityType: true,
        entityId: true, severity: true, confidence: true, rationale: true,
        status: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 60,
    })
    return { findings: findings.map((f) => ({ ...f, confidence: String(f.confidence) })), labels: { campaigns: {}, targets: {} } }
  }
  if (p.endsWith('/plans')) {
    const plans = await prisma.agentPlan.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, charterKey: true, headline: true, narrative: true, status: true,
        criticVerdict: true, criticNotes: true, blastRadius: true, items: true,
        droppedItems: true, approvalIds: true, createdAt: true,
      },
    })
    return { plans, labels: { campaigns: {}, targets: {} } }
  }
  if (p.endsWith('/approvals')) {
    const { listInbox, inboxCounts } = await import(
      '/Users/awais/nexus-commerce/apps/api/src/services/agent-fleet/approval-inbox.service.js'
    )
    const v = q.get('view')
    const view = v === 'decided' || v === 'expired' ? v : 'waiting'
    const [approvals, counts] = await Promise.all([listInbox(view as never), inboxCounts()])
    // VISUAL CHECK ONLY. The fleet is dark, so no worker has ever queued an
    // approval and the waiting view is empty — which means the risk-shaped
    // cards cannot be seen. These synthetic rows exist purely so the UI can
    // be inspected; they are invented HERE, in a read-only stub, and nothing
    // is ever written to the database.
    if (view === 'waiting' && process.env.DT_FAKE_WAITING === '1') {
      const now = new Date().toISOString()
      const fake = [
        { id: 'fake1', toolName: 'set-target-bid', charterKey: 'amazon-bid-tuner', status: 'pending', riskTier: 'low',
          args: {}, preview: { effect: 'Moves "chaqueta moto" from €0.42 to €0.25 in XAVIA-SP-IT-Brand.' },
          requestedAt: now, decidedAt: null, decidedBy: null, reason: null, expiresAt: null, isFleet: true, orchestrationId: null },
        { id: 'fake2', toolName: 'create-negative-keyword', charterKey: 'amazon-negative-miner', status: 'pending', riskTier: 'high',
          args: {}, preview: { effect: 'Stops "veste moto homme homologué" from matching in XAVIA-SP-FR-Generic; spend on it (last 30d) was €40.37 with 0 orders.' },
          requestedAt: now, decidedAt: null, decidedBy: null, reason: null, expiresAt: null, isFleet: true, orchestrationId: null },
        { id: 'fake3', toolName: 'send-customer-message', charterKey: 'amazon-negative-miner', status: 'pending', riskTier: 'high',
          args: {}, preview: { note: 'Drafted follow-up about a delayed delivery.' },
          requestedAt: now, decidedAt: null, decidedBy: null, reason: null, expiresAt: null, isFleet: false, orchestrationId: null },
        { id: 'fake4', toolName: 'some-unmapped-tool', charterKey: 'amazon-bid-tuner', status: 'pending', riskTier: 'medium',
          args: {}, preview: null,
          requestedAt: now, decidedAt: null, decidedBy: null, reason: null, expiresAt: null, isFleet: false, orchestrationId: null },
      ]
      return { approvals: fake, counts: { ...counts, waiting: fake.length }, view, labels: { campaigns: {}, targets: {} } }
    }
    return { approvals, counts, view, labels: { campaigns: {}, targets: {} } }
  }
  if (p.endsWith('/sweeps')) return { sweeps: [] }
  if (p.endsWith('/schedule')) {
    return {
      jobs: [
        { key: 'fleet-sweep', label: 'Nightly sweep', schedule: '45 4 * * *', enabled: true, nextFireAt: new Date(Date.now() + 3600_000).toISOString(), lastRun: null },
        { key: 'fleet-council', label: 'Weekly council', schedule: '15 5 * * 1', enabled: true, nextFireAt: new Date(Date.now() + 86400_000).toISOString(), lastRun: null },
      ],
    }
  }
  if (p.endsWith('/scorecards')) return { scorecards: [] }
  if (p.endsWith('/entity-graph')) return { nodes: [], edges: [], relationCounts: {}, focus: null, truncated: false }
  return null
}

createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  // AP.4 verification: the stub forwards the approval write endpoints to the
  // REAL services so the undo round trip can be exercised. Still touches only
  // AgentApproval rows that this script itself seeded.
  if (req.method === 'POST') {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const body = await new Promise<string>((resolve) => {
        let b = ''
        req.on('data', (c) => (b += c))
        req.on('end', () => resolve(b))
      })
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      const svc = await import(
        '/Users/awais/nexus-commerce/apps/api/src/services/agent-fleet/approval-inbox.service.js'
      )
      const actor = { label: 'Awais (local check)', userId: 'local' }
      const m = /\/approvals\/([^/]+)\/(undo|commit|decide)$/.exec(url.pathname)
      let out: unknown = null
      if (m && m[2] === 'undo') out = await svc.undoScheduledApproval({ id: m[1]!, actor })
      else if (m && m[2] === 'commit') out = await svc.commitScheduledApproval(m[1]!)
      else if (m && m[2] === 'decide')
        out = await svc.decideFleetApproval({
          id: m[1]!,
          decision: parsed.decision as 'approve' | 'reject',
          reason: parsed.reason as string | undefined,
          actor,
        })
      else if (url.pathname.endsWith('/bulk-preview'))
        out = await svc.previewBulk(parsed.ids as string[], parsed.decision as 'approve')
      else if (url.pathname.endsWith('/bulk-decide'))
        out = await svc.bulkDecide({
          ids: parsed.ids as string[],
          decision: parsed.decision as 'approve' | 'reject',
          reason: parsed.reason as string | undefined,
          actor,
        })
      else return res.writeHead(404).end(JSON.stringify({ error: 'not in stub' }))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(out))
    } catch (e) {
      console.error('stub POST error', req.url, e)
      res.writeHead(500, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  }
  if (req.method !== 'GET') return res.writeHead(405).end('read-only stub')
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const body = await handle(url)
    if (body === null) return res.writeHead(404).end(JSON.stringify({ error: 'not in stub' }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  } catch (e) {
    console.error('stub error', req.url, e)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
  }
}).listen(4099, () => console.log('DT stub API (read-only) on http://localhost:4099'))
