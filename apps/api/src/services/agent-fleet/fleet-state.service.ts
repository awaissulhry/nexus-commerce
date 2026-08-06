/**
 * NAF.A — fleet runtime state (plan D7): the circuit-breaker halt + the
 * fleet-wide daily ceiling, one singleton row, upsert-on-read (the
 * ads-automation-state.service.ts idiom).
 *
 * Fail-safe direction: an UNREADABLE row reports halted=true with
 * degraded=true — the orchestrator and executor treat "cannot read the
 * safety state" as "stopped", and the flag lets the UI say so rather than
 * presenting the assumption as an operator choice.
 *
 * resumeFleet deliberately RETAINS haltedAt/haltReason: ACR 4.3 found the
 * ads twin nulls them on resume, erasing the only in-row trace of a trip.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

/** Matches the schema default — reported when the row cannot be read so a
 *  degraded state never renders a zero ceiling ("spent out") for "unknown". */
const DEFAULT_DAILY_CEILING_USD = 2.0

const SINGLETON = 'singleton'

export interface FleetStateView {
  halted: boolean
  haltedAt: Date | null
  haltReason: string | null
  haltedBy: string | null
  dailyCeilingUSD: number
  degraded: boolean
}

async function getRow() {
  return prisma.agentFleetState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  })
}

function toView(
  r: Awaited<ReturnType<typeof getRow>> | null,
): FleetStateView {
  if (r == null) {
    return {
      halted: true,
      haltedAt: null,
      haltReason: null,
      haltedBy: null,
      dailyCeilingUSD: DEFAULT_DAILY_CEILING_USD,
      degraded: true,
    }
  }
  return {
    halted: r.halted,
    haltedAt: r.haltedAt,
    haltReason: r.haltReason,
    haltedBy: r.haltedBy,
    dailyCeilingUSD: Number(r.dailyCeilingUSD),
    degraded: false,
  }
}

export async function getFleetState(): Promise<FleetStateView> {
  const r = await getRow().catch((err) => {
    logger.error(
      '[agent-fleet] state read failed — reporting the fail-safe halted posture',
      { error: String(err) },
    )
    return null
  })
  return toView(r)
}

export async function haltFleet(
  reason: string,
  by?: string | null,
): Promise<FleetStateView> {
  const data = {
    halted: true,
    haltedAt: new Date(),
    haltReason: reason,
    haltedBy: by ?? null,
  }
  const r = await prisma.agentFleetState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...data },
    update: data,
  })
  return toView(r)
}

export async function resumeFleet(by?: string | null): Promise<FleetStateView> {
  // halted flips off; the trip record (haltedAt/haltReason) stays.
  const data = { halted: false, haltedBy: by ?? null }
  const r = await prisma.agentFleetState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...data },
    update: data,
  })
  return toView(r)
}
