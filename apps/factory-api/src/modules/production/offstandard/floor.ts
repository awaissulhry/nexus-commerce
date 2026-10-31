import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { parseInstant } from '@nexus/factory-domain/core/time'
import { believedTime, BUNDLE_RUNNING, CODE_INACTIVE, NONE_RUNNING, tileOrder } from '@nexus/factory-domain/production/offstandard/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { systemView } from '../scans/access'
import { floorRecordSubjectFor, scanSubjectFor } from '../settings/subject'
import { floorOf, refuse } from './access'
import { decideInCommand, involvedOf, lockedAt } from './blocks'
import type { FloorEndBody, FloorStartBody } from './contract'
import { deviceStationOf, latestEndOf, linesById, lockRunningBlock, readBlock, readBlockByClient, readBlocks, readCode, readCodes, runningBlockOf, runningStretchOf, sitesById, stationsById, workerOf, type BlockRow, type Reader, type Subject } from './store'
import { floorBlockOf, rowFactsOf, rowOf, tileOf, type FloorBlockView } from './views'
import { endBlock, insertBlock } from './writes'

/**
 * The floor's side of off-standard time (B-W2b-29; MES-156, MES-158, MES-157; design floor.operation "No bundle: what are
 * you doing?" — tiles: cleaning, training, samples, meeting, waiting for work; scanning a bundle returns to standard —, and
 * floor.supervisor "Waiting for you": the team leader approves with the PIN). Everything runs in the device's FLOOR scope
 * at its own site:
 *
 *   state    the site's subject (the signed-in worker, or the station), the device's station, the block running for
 *            the subject, and the tiles: the company's active codes in their order (no pay rule on the floor).
 *   start    floor.work: one tap on a tile. While no bundle runs (MES-156); another tile running ends first (SWITCH), in
 *            the same command; the same tile running answers it (nothing twice). The tablet's time when believable
 *            (offline), its client event id once per device (`<device>.<client event id>` is the command's key).
 *   end      floor.work: the running block ends (PENDING, or APPROVED at once for a code that needs no approval).
 *   lead     floor.lead: the site's waiting blocks (per line, station and code: never who) and the team leader's approve
 *            or reject, a signing act with the PIN (requireFloorStepUp), never of their own time.
 *
 * Who a block names follows the site's floor rules (settings/subject.ts): at a site that records the station, the
 * station and no worker, and no creator either (as scans).
 */

const keyOf = (context: FloorContext, clientEventId: string) => `${context.deviceId}.${clientEventId}`

interface FloorPlace {
  readonly context: FloorContext
  readonly site: { readonly id: string; readonly companyId: string; readonly timezone: string }
  readonly stationId: string | null
}

async function placeOf(caller: CommandCaller): Promise<FloorPlace> {
  const context = floorOf(caller)
  return caller.withClient(async (db) => {
    const site = (await sitesById(db, [context.siteId])).get(context.siteId)
    if (!site) throw new NotFoundError('Site not found.')
    return { context, site, stationId: await deviceStationOf(db, context.deviceId) }
  })
}

/** The subject the site's floor rules name for the signed-in worker at this device (or null where it names none yet). */
async function viewerSubject(db: Reader, place: FloorPlace): Promise<Subject> {
  const scanSubject = await scanSubjectFor(db, place.site.id)
  return scanSubject === 'STATION' ? { workerId: null, stationId: place.stationId } : { workerId: place.context.actorId, stationId: place.stationId }
}

export async function floorState(caller: CommandCaller) {
  const place = await placeOf(caller)
  const now = new Date()
  return caller.withClient(async (db) => {
    const scanSubject = await scanSubjectFor(db, place.site.id)
    const subject = await viewerSubject(db, place)
    const running = await runningBlockOf(db, place.site.id, subject)
    const station = place.stationId ? ((await stationsById(db, [place.stationId])).get(place.stationId) ?? null) : null
    const line = station?.lineId ? ((await linesById(db, [station.lineId])).get(station.lineId) ?? null) : null
    const codes = tileOrder(await readCodes(db, { companyId: place.site.companyId, active: true }))
    const runningCode = running ? await readCode(db, running.codeId) : null
    return {
      subject: scanSubject,
      station: station ? { id: station.id, code: station.code, name: station.name, line: line ? { id: line.id, code: line.code, name: line.name } : null } : null,
      running: running && runningCode ? floorBlockOf(running, runningCode, now) : null,
      codes: codes.map(tileOf),
    }
  })
}

/** The same tile already runs: the answer is that block (thrown out of the command, which then writes nothing). */
class AlreadyRunning extends Error {
  constructor(readonly block: BlockRow) {
    super('already running')
  }
}

export interface StartAnswer {
  readonly block: FloorBlockView
  readonly ended: FloorBlockView | null
  readonly replayed: boolean
}

/** A tile tapped (or its queued event sent): start the code's block for the subject, ending another tile's first. */
export async function floorStart(caller: CommandCaller, body: FloorStartBody, key?: string): Promise<StartAnswer> {
  const place = await placeOf(caller)
  const { context, site } = place
  const now = new Date()
  // Sent before under this client event id: that block, nothing done again.
  const before = await caller.withClient((db) => readBlockByClient(db, context.deviceId, body.clientEventId))
  if (before) {
    const code = (await caller.withClient((db) => readCode(db, before.codeId)))!
    return { block: floorBlockOf(before, code, now), ended: null, replayed: true }
  }
  const code = await caller.withClient((db) => readCode(db, body.codeId))
  if (!code || code.companyId !== site.companyId) throw new NotFoundError('Off-standard code not found.')
  if (!code.active) refuse(CODE_INACTIVE)
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) : null
  try {
    const { result, replayed } = await command(
      caller,
      { name: 'production.offStandardStart', idempotencyKey: key ?? keyOf(context, body.clientEventId), input: body, ...(occurredAt ? { deviceTime: occurredAt } : {}) },
      async (tools: CommandTools) => {
        const subject = await floorRecordSubjectFor(tools.tx, { siteId: site.id, workerId: context.actorId, stationId: place.stationId })
        const running = await lockRunningBlock(tools.tx, context.tenantId, site.id, subject)
        if (running && running.codeId === code.id) throw new AlreadyRunning(running)
        if (await runningStretchOf(tools.tx, context.tenantId, site.id, subject)) refuse(BUNDLE_RUNNING)
        let startedAt = believedTime(occurredAt, tools.now)
        let ended: BlockRow | null = null
        if (running) {
          const runningCode = (await readCode(tools.tx, running.codeId))!
          ended = await endBlock(tools, running, runningCode, { at: startedAt, endedBy: 'SWITCH', bump: true, action: 'production.offStandardEnd' })
        }
        // Never before the subject's latest block ended (a tablet's clock behind, an offline start sent late): no overlap.
        const lastEnd = await latestEndOf(tools.tx, site.id, subject)
        if (lastEnd && lastEnd.getTime() > startedAt.getTime()) startedAt = lastEnd.getTime() > tools.now.getTime() ? tools.now : lastEnd
        const station = subject.stationId ? (await stationsById(tools.tx, [subject.stationId])).get(subject.stationId) : undefined
        const worker = subject.workerId ? await workerOf(tools.tx, subject.workerId) : null
        const block = await insertBlock(tools, {
          companyId: site.companyId,
          siteId: site.id,
          timeZone: site.timezone,
          lineId: station?.lineId ?? null,
          stationId: subject.stationId,
          workerId: subject.workerId,
          employeeId: worker?.employeeId ?? null,
          code,
          source: 'FLOOR',
          startedAt,
          note: body.note ?? null,
          deviceId: context.deviceId,
          clientEventId: body.clientEventId,
          deviceTime: occurredAt,
          createdById: subject.workerId ? context.actorId : null,
        })
        const endedCode = ended ? (await readCode(tools.tx, ended.codeId))! : null
        return { block: floorBlockOf(block, code, tools.now), ended: ended && endedCode ? floorBlockOf(ended, endedCode, tools.now) : null }
      },
    )
    return { ...result, replayed }
  } catch (error) {
    if (error instanceof AlreadyRunning) return { block: floorBlockOf(error.block, code, now), ended: null, replayed: true }
    // A refusal in words, a stale version or a reused key: as it is.
    if (error instanceof DomainError) throw error
    // The same tap sent twice at once (the unique client event id, or the one running block per subject, refused the
    // second): the block that won answers.
    const raced = await caller
      .withClient(async (db) => (await readBlockByClient(db, context.deviceId, body.clientEventId)) ?? runningBlockOf(db, site.id, await viewerSubject(db, place)))
      .catch(() => null)
    if (raced && raced.codeId === code.id) return { block: floorBlockOf(raced, code, now), ended: null, replayed: true }
    throw error
  }
}

/** "Done" on the running block (or its queued event): it ends now, or at the tablet's believable time. */
export async function floorEnd(caller: CommandCaller, body: FloorEndBody, key?: string): Promise<{ readonly block: FloorBlockView; readonly replayed: boolean }> {
  const place = await placeOf(caller)
  const { context, site } = place
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) : null
  const subject = await caller.withClient((db) => viewerSubject(db, place))
  const running = await caller.withClient((db) => runningBlockOf(db, site.id, subject))
  const idempotencyKey = key ?? keyOf(context, body.clientEventId)
  if (!running) {
    // A resend of an end already done answers from its receipt; otherwise nothing runs.
    const answered = await command(caller, { name: 'production.offStandardEnd', idempotencyKey, input: body }, async (): Promise<FloorBlockView> => refuse(NONE_RUNNING))
    return { block: answered.result, replayed: answered.replayed }
  }
  const { result, replayed } = await command(caller, { name: 'production.offStandardEnd', idempotencyKey, input: body, ...(occurredAt ? { deviceTime: occurredAt } : {}) }, async (tools) => {
    const locked = await lockRunningBlock(tools.tx, context.tenantId, site.id, subject)
    if (!locked) refuse(NONE_RUNNING)
    const code = (await readCode(tools.tx, locked!.codeId))!
    const ended = await endBlock(tools, locked!, code, { at: believedTime(occurredAt, tools.now), endedBy: 'WORKER', bump: true })
    return floorBlockOf(ended, code, tools.now)
  })
  return { block: result, replayed }
}

// ---- the team leader on the tablet (floor.lead) ------------------------------------------------------------------------

async function leadBlock(caller: CommandCaller, blockId: string): Promise<BlockRow> {
  const context = floorOf(caller)
  const block = await caller.withClient((db) => readBlock(db, blockId))
  if (!block || block.siteId !== context.siteId || !can(actorOf(context), 'floor.lead', { companyId: block.companyId, siteId: block.siteId })) throw new NotFoundError('Off-standard block not found.')
  return block
}

/** The site's blocks waiting for the team leader, oldest first: per line, station and code, never who. */
export async function floorLeadList(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = new Date()
  return caller.withClient(async (db) => {
    const blocks = await readBlocks(db, { siteId: context.siteId, status: 'PENDING' }, 'oldest', 200)
    const facts = await rowFactsOf(db, blocks, now)
    return { blocks: blocks.map((block) => ({ ...rowOf(block, facts), own: block.workerId === context.actorId || block.createdById === context.actorId })) }
  })
}

async function floorDecide(caller: CommandCaller, blockId: string, decision: { readonly status: 'APPROVED' | 'REJECTED'; readonly version: number; readonly reason?: string }, stepUp: () => void, idempotencyKey?: string) {
  const context = floorOf(caller)
  const found = await leadBlock(caller, blockId)
  // The people it is about, also where the site records stations only (the audit rows keep who acted): read as the system.
  const involved = await systemView(caller).withClient((db) => involvedOf(db, found))
  stepUp()
  const name = decision.status === 'APPROVED' ? 'production.offStandardFloorApprove' : 'production.offStandardFloorReject'
  const { result } = await command(caller, { name, idempotencyKey, input: { blockId, ...decision } }, async (tools) => {
    const block = await lockedAt(tools, blockId, decision.version)
    await decideInCommand(tools, block, { status: decision.status, actorId: context.actorId, involved, ...(decision.reason ? { reason: decision.reason } : {}), on: 'FLOOR', bump: true, bulk: false })
    const after = (await readBlock(tools.tx, blockId))!
    return { block: rowOf(after, await rowFactsOf(tools.tx, [after], tools.now)) }
  })
  return result
}

export const floorApprove = (caller: CommandCaller, blockId: string, body: { readonly version: number }, stepUp: () => void, idempotencyKey?: string) => floorDecide(caller, blockId, { status: 'APPROVED', version: body.version }, stepUp, idempotencyKey)

export const floorReject = (caller: CommandCaller, blockId: string, body: { readonly version: number; readonly reason: string }, stepUp: () => void, idempotencyKey?: string) =>
  floorDecide(caller, blockId, { status: 'REJECTED', version: body.version, reason: body.reason }, stepUp, idempotencyKey)
