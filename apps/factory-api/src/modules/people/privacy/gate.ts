import type { Prisma } from '@nexus/factory-db'
import { DomainError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { gateClosedWords, gateOpen } from '@nexus/factory-domain/people/privacy/gate'
import { serverClock } from '../../../core/time'
import type { GatePurpose } from '@nexus/factory-domain/people/privacy/purposes'
import type { MonitoringBasis } from '@nexus/factory-domain/production/settings/monitoring'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'

/**
 * legalGate(site, purpose) (B-W2b-27; W2b plan §2 GATE-LABOUR, §11 "worker monitoring by the back door": every per-person
 * People read goes through this one gate; Statuto dei Lavoratori art. 4 c.1-3; GDPR arts. 13, 35). The gate of a site and
 * a purpose is the PeopleLegalGate row of that site and purpose with no switch-off; none means OFF (every site starts
 * closed: the build ships with every purpose off).
 *
 * For the later People and floor steps:
 *   legalGateFor(db, siteId, purpose)        the gate as it stands (office scope, or the system caller)
 *   requireLegalGate(db, siteId, purpose)    the gate in force, or 409 invalid_state `gate/<PURPOSE>` in words: call it
 *                                            inside the read or the writing command, before any person's data is read
 *   legalGateReader(caller)                  a reader for any caller: the floor role may not read the gate (it reads no
 *                                            legal basis, B-W1-36), so a floor caller reads it as the tenant's system
 *                                            caller, which reads nothing but this
 *   gateClosedError(purpose)                 the refusal itself (the screens' words; the golden flow checks the code)
 */

export const GATE_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  purpose: true,
  basis: true,
  basisReference: true,
  basisCoversLeads: true,
  leadsSeeFigures: true,
  noticeId: true,
  dpiaId: true,
  switchedOnAt: true,
  switchedOnById: true,
  switchedOffAt: true,
  switchedOffById: true,
  switchOffReason: true,
  version: true,
} as const satisfies Prisma.PeopleLegalGateSelect

export type GateRecord = Prisma.PeopleLegalGateGetPayload<{ select: typeof GATE_SELECT }>

export type GateReader = Pick<CommandTx, 'peopleLegalGate'>

export interface LegalGate {
  readonly siteId: string
  readonly purpose: GatePurpose
  readonly open: boolean
  /** The row in force; null when the purpose is off at the site. */
  readonly gate: GateRecord | null
}

/** The gate of a site and a purpose as it stands at `now` (a gate switched on from a later moment is not open yet). */
export async function legalGateFor(db: GateReader, siteId: string, purpose: GatePurpose, now: Date = serverClock.now()): Promise<LegalGate> {
  const gate = await db.peopleLegalGate.findFirst({ where: { siteId, purpose, switchedOffAt: null, switchedOnAt: { lte: now } }, select: GATE_SELECT })
  return { siteId, purpose, open: gateOpen(gate), gate }
}

/**
 * The row not switched off of a site and a purpose, whatever its switch-on moment: what switching on, off and the leads
 * choice act on (a row dated later than now is there, and refused in words, never a second row or a 500). Reads of
 * people data use legalGateFor, which opens only from the switch-on moment.
 */
export async function gateRowInForce(db: GateReader, siteId: string, purpose: GatePurpose): Promise<GateRecord | null> {
  return db.peopleLegalGate.findFirst({ where: { siteId, purpose, switchedOffAt: null }, select: GATE_SELECT })
}

/** The gates in force of several sites (both purposes), by site then purpose. */
export async function legalGatesOf(db: GateReader, siteIds: readonly string[]): Promise<Map<string, Map<GatePurpose, GateRecord>>> {
  const rows = siteIds.length === 0 ? [] : await db.peopleLegalGate.findMany({ where: { siteId: { in: [...siteIds] }, switchedOffAt: null }, select: GATE_SELECT })
  const bySite = new Map<string, Map<GatePurpose, GateRecord>>()
  for (const row of rows) {
    const site = bySite.get(row.siteId) ?? new Map<GatePurpose, GateRecord>()
    site.set(row.purpose as GatePurpose, row)
    bySite.set(row.siteId, site)
  }
  return bySite
}

/** A closed gate's refusal: 409 invalid_state, the purpose in `gate/<PURPOSE>`, the law in the words. */
export function gateClosedError(purpose: GatePurpose): DomainError {
  const words = gateClosedWords(purpose)
  return new DomainError('invalid_state', words, [{ path: `gate/${purpose}`, message: words }])
}

/** The gate in force of a site and a purpose, or the refusal (before any person's data is read). */
export async function requireLegalGate(db: GateReader, siteId: string, purpose: GatePurpose): Promise<GateRecord> {
  const { gate } = await legalGateFor(db, siteId, purpose)
  if (!gate) throw gateClosedError(purpose)
  return gate
}

/**
 * Runs `read` with a client that may read the gate: the caller's own (office, system) or, for a floor caller, the
 * tenant's system caller's (the floor role is granted nothing on PeopleLegalGate). Nothing else should be read with it.
 * The caller's withClient must follow `this.factoryContext`, as a FastifyRequest's does (a floor caller is always a
 * request: the worker and the scheduler are the system caller already).
 */
export async function legalGateReader<T>(caller: CommandCaller, read: (db: GateReader) => Promise<T>): Promise<T> {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience === 'office' || context.audience === 'system') return caller.withClient((client) => read(client))
  if (context.audience !== 'floor') throw new DomainError('forbidden', 'People data is read by the office and the floor only.')
  const system = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  system.factoryContext = systemContext(context.tenantId, context.requestId)
  return system.withClient((client) => read(client))
}

/** The basis a gate recorded, as answers show it. */
export const recordedBasisOf = (gate: GateRecord): { readonly kind: MonitoringBasis; readonly reference: string } => ({ kind: gate.basis as MonitoringBasis, reference: gate.basisReference })
