import type { FastifyRequest } from 'fastify'
import { GUARD_KINDS, type GuardKind, type OverrideReasonCode } from '@nexus/factory-domain/production/guards/rules'
import { systemView } from '../scans/access'
import { reportScan, type ReportInput } from '../scans/scans'
import { verifyOverride, type LeadInput } from './override'
import { OVERRIDDEN_ACTION } from './store'

/**
 * POST /production/guards/override (B-W2b-46; design floor.operation pop-up "Team leader override"): the held report,
 * sent again with the team leader's badge (or name), PIN and reason tile. The team leader is proved first (override.ts);
 * then the report runs as any report (the scans' command, locks and rules, the same clientScanId: a resend answers the
 * scan recorded first), carrying the verified override, which lifts the checks that held it. The answer says what was
 * overridden (read back from the record as the tenant's system caller: the floor role reads no audit row), or null when
 * nothing held the report any more.
 */
export async function overrideReport(request: FastifyRequest, body: { readonly report: Omit<ReportInput, 'override'>; readonly lead: LeadInput; readonly reasonCode: OverrideReasonCode; readonly note?: string | undefined }) {
  const override = await verifyOverride(request, { lead: body.lead, reasonCode: body.reasonCode, note: body.note })
  const result = await reportScan(request, { ...body.report, override })
  const row = await systemView(request).withClient((db) => db.auditLog.findFirst({ where: { recordType: 'OperationScan', recordId: result.scan.id, action: OVERRIDDEN_ACTION }, select: { after: true } }))
  const after = row?.after && typeof row.after === 'object' && !Array.isArray(row.after) ? (row.after as Record<string, unknown>) : null
  const guards = after && Array.isArray(after.guards) ? [...new Set(after.guards.map((entry) => (entry as { kind?: unknown }).kind).filter((kind): kind is GuardKind => (GUARD_KINDS as readonly unknown[]).includes(kind)))].sort() : []
  return { ...result, override: after ? { guards, reasonCode: after.reasonCode as OverrideReasonCode } : null }
}
