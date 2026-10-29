import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  blockSize,
  checkBlockUses,
  DEVICE_BLOCK_SIZE,
  MAX_BLOCK_SIZE,
  nextRange,
  scanCodes,
  SCAN_KIND_WORDS,
  topUpFor,
  type BlockUseRefusal,
  type RefRange,
} from '@nexus/factory-domain/numbering/blocks'
import { isScanIdKind, SCAN_ID_KINDS, type ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import { NUMBERING_MANAGE, NUMBERING_VIEW } from '@nexus/factory-domain/numbering/permissions'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type FloorContext } from '../../core/context'
import { ApiError } from '../../core/errors'

/**
 * Scan ids for the floor (design 02-sections-floor "tags print offline from numbers reserved per tablet"; features
 * PLT-126, PLT-237): the BUNDLE, HIDE and GARMENT_SERIAL kinds, ONE tenant-wide counter each (a scan id carries the
 * tenant's tag, never the company). The counter is the tenant's ledger of blocks (NumberBlock); the rules are
 * factory-domain numbering/blocks, and the …_numbering_floor_guards triggers hold them for every login.
 *
 * Inside a command (office, worker, or a floor tablet's; scan ids need no NumberSeries/NumberAllocation, which a floor
 * session reaches only for the floor's document kinds, through allocateNumber):
 *   - allocateScanIds(tools, kind, count): ONLINE numbers, used by the command at once (a bundle make, a receipt's hide
 *     tags, a garment's serial). One ONLINE block, in the command's transaction: a command that rolls back takes none.
 *   - useScanIds(tools, kind, uses): the numbers a tablet printed from its OWN blocks (offline too), checked and recorded
 *     once each (NumberBlockUse); a refusal is a 409 listing every refused code with its words and fix.
 * And for the tablets' blocks: reserve (office, or the tablet's own top-up when it runs low), list, close (a lost or
 * retired tablet: its numbers left are never used).
 *
 * Locks: the tenant's `factory.scan-ids|tenant|kind` lock, before the highest block is read (the guard trigger takes it
 * too), held to the end of the command; uses take `factory.scan-id-use|tenant|device|kind` before they read what the
 * tablet used. A caller takes them after its own record locks, like the series' row lock of allocateNumber.
 */

/** What the scan-id functions need of the command's tools. */
export type ScanIdTools = Pick<CommandTools, 'tx' | 'context' | 'now'>

/** Numbers taken at once by a command (one ONLINE block). */
export interface ScanIdBatch {
  readonly kind: ScanIdKind
  readonly blockId: string
  readonly fromRef: number
  readonly toRef: number
  /** The printed scan ids, in order (`BN-7K-00002A-Q` …). */
  readonly codes: readonly string[]
}

const tenantOf = (tools: ScanIdTools): string => {
  const { context } = tools
  if (context.audience !== 'office' && context.audience !== 'system' && context.audience !== 'floor') {
    throw new ApiError('internal_error', `Scan ids are taken by office, floor and system commands; the ${context.audience} audience has none.`)
  }
  return context.tenantId
}

const assertKind = (kind: unknown): ScanIdKind => {
  if (!isScanIdKind(kind)) throw new ApiError('internal_error', `${JSON.stringify(kind)} is not a scan-id kind (${SCAN_ID_KINDS.join(', ')}); document numbers come from allocateNumber.`)
  return kind
}

/** The tenant's lock for a kind's counter: one block is taken at a time (the guard trigger takes the same one). */
export async function lockScanIds(tx: CommandTx, tenantId: string, kind: ScanIdKind): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-ids', ${tenantId}::uuid, ${kind}::text), 0))`
}

/** Under the kind's lock: the next `count` references after the tenant's highest block of the kind. */
async function takeRange(tools: ScanIdTools, tenantId: string, kind: ScanIdKind, count: number): Promise<RefRange> {
  await lockScanIds(tools.tx, tenantId, kind)
  const [row] = await tools.tx.$queryRaw<{ highest: number | null }[]>`SELECT max("toRef") AS "highest" FROM "NumberBlock" WHERE "kind" = ${kind}::"NumberKind"`
  try {
    return nextRange(row?.highest ?? null, count)
  } catch (error) {
    if (error instanceof RangeError && error.message.includes('used up')) throw new ConflictError(`This factory has used up its ${SCAN_KIND_WORDS[kind]} numbers.`)
    throw error
  }
}

/**
 * The next `count` scan ids of a kind (1 to 1000), for the command to use at once. Any audience that writes (office,
 * system, floor). The numbers are the tenant's: no other command, site or tablet ever gets them.
 *
 *   const { codes } = await allocateScanIds(tools, 'GARMENT_SERIAL', 12)
 */
export async function allocateScanIds(tools: ScanIdTools, kind: ScanIdKind, count: number): Promise<ScanIdBatch> {
  const tenantId = tenantOf(tools)
  assertKind(kind)
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BLOCK_SIZE) throw new ApiError('internal_error', `allocateScanIds(): 1 to ${MAX_BLOCK_SIZE} numbers at a time, not ${String(count)}.`)
  const range = await takeRange(tools, tenantId, kind, count)
  const blockId = newId()
  await tools.tx.numberBlock.create({
    data: { id: blockId, kind, purpose: 'ONLINE', ...range, deviceId: null, requestId: tools.context.requestId, createdAt: tools.now, updatedAt: tools.now },
    select: { id: true },
  })
  return { kind, blockId, ...range, codes: scanCodes(tenantId, kind, range) }
}

/** One scan id taken at once: `await allocateScanId(tools, 'GARMENT_SERIAL')` → `SN-7K-00001A-4`. */
export async function allocateScanId(tools: ScanIdTools, kind: ScanIdKind): Promise<string> {
  return (await allocateScanIds(tools, kind, 1)).codes[0]!
}

// ---- the tablets' blocks --------------------------------------------------------------------------------------------------

const BLOCK_SELECT = {
  id: true,
  kind: true,
  purpose: true,
  fromRef: true,
  toRef: true,
  deviceId: true,
  status: true,
  closedReason: true,
  closedAt: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.NumberBlockSelect
type BlockRow = Prisma.NumberBlockGetPayload<{ select: typeof BLOCK_SELECT }>

/** A tablet's block as the tablet and the office see it. */
export interface BlockView {
  readonly id: string
  readonly kind: ScanIdKind
  readonly deviceId: string
  readonly fromRef: number
  readonly toRef: number
  readonly size: number
  /** Numbers of it the server saw used. */
  readonly used: number
  /** The highest number used (null: none): a tablet that lost its data goes on after it. */
  readonly highestUsedRef: number | null
  readonly remaining: number
  readonly firstCode: string
  readonly lastCode: string
  readonly status: 'ACTIVE' | 'CLOSED'
  readonly closedReason: string | null
  readonly closedAt: string | null
  readonly version: number
  readonly createdAt: string
}

type Reader = Pick<FactoryClient, 'numberBlock' | 'numberBlockUse'> | Pick<CommandTx, 'numberBlock' | 'numberBlockUse'>

/** The blocks with their used counts. */
async function viewsOf(db: Reader, tenantId: string, rows: readonly BlockRow[]): Promise<BlockView[]> {
  if (rows.length === 0) return []
  const counts = await db.numberBlockUse.groupBy({ by: ['blockId'], where: { blockId: { in: rows.map((row) => row.id) } }, _count: { _all: true }, _max: { ref: true } })
  const byBlock = new Map(counts.map((count) => [count.blockId, count]))
  return rows.map((row) => {
    const kind = assertKind(row.kind)
    const count = byBlock.get(row.id)
    const used = count?._count._all ?? 0
    const [firstCode] = scanCodes(tenantId, kind, { fromRef: row.fromRef, toRef: row.fromRef })
    const [lastCode] = scanCodes(tenantId, kind, { fromRef: row.toRef, toRef: row.toRef })
    return {
      id: row.id,
      kind,
      deviceId: row.deviceId!,
      fromRef: row.fromRef,
      toRef: row.toRef,
      size: blockSize(row),
      used,
      highestUsedRef: count?._max.ref ?? null,
      remaining: row.status === 'ACTIVE' ? blockSize(row) - used : 0,
      firstCode: firstCode!,
      lastCode: lastCode!,
      status: row.status,
      closedReason: row.closedReason,
      closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}

export interface BlockFilter {
  readonly kind?: ScanIdKind | undefined
  readonly status?: 'ACTIVE' | 'CLOSED' | undefined
}

/** A tablet's blocks (DEVICE), newest first per kind. The caller has checked it may see the tablet. */
export async function deviceBlocks(db: Reader, tenantId: string, deviceId: string, filter: BlockFilter = {}): Promise<BlockView[]> {
  const rows = await db.numberBlock.findMany({
    where: { purpose: 'DEVICE', deviceId, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ kind: 'asc' }, { fromRef: 'desc' }],
    take: 200,
    select: BLOCK_SELECT,
  })
  return viewsOf(db, tenantId, rows)
}

interface DeviceFacts {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly status: string
  readonly name: string
}

async function readDevice(db: Pick<FactoryClient, 'device'> | Pick<CommandTx, 'device'>, deviceId: string): Promise<DeviceFacts | null> {
  if (!isUuid(deviceId)) return null
  return db.device.findUnique({ where: { id: deviceId }, select: { id: true, companyId: true, siteId: true, status: true, name: true } })
}

/**
 * Reserves a block of a kind for a tablet (DEVICE), inside the caller's command: office (numbering.manage, checked by the
 * route) or the tablet's own top-up. Audited on the block. Refused for a tablet that is not ACTIVE.
 */
async function reserveInCommand(tools: Pick<CommandTools, 'tx' | 'context' | 'now' | 'audit'>, device: DeviceFacts, kind: ScanIdKind, size: number): Promise<BlockRow> {
  const tenantId = tenantOf(tools)
  if (device.status !== 'ACTIVE') throw new ConflictError(`Tablet ${device.name} is ${device.status.toLowerCase()}; only an enrolled, active tablet gets numbers.`)
  const range = await takeRange(tools, tenantId, kind, size)
  const id = newId()
  const row = await tools.tx.numberBlock.create({
    data: { id, kind, purpose: 'DEVICE', ...range, deviceId: device.id, requestId: tools.context.requestId, createdAt: tools.now, updatedAt: tools.now },
    select: BLOCK_SELECT,
  })
  tools.audit({ action: 'numbering.reserveBlock', recordType: 'NumberBlock', recordId: id, companyId: device.companyId, siteId: device.siteId, after: { kind, deviceId: device.id, ...range } })
  return row
}

/** Office: the tablets' blocks the caller's numbering.view reaches (by the tablet's company and site). */
export async function listBlocks(client: FactoryClient, actor: Actor, filter: BlockFilter & { readonly deviceId?: string | undefined }): Promise<BlockView[]> {
  const tenantId = actor.tenantId!
  if (filter.deviceId !== undefined) {
    const device = await readDevice(client, filter.deviceId)
    if (!device || !can(actor, NUMBERING_VIEW, { companyId: device.companyId, siteId: device.siteId })) throw new NotFoundError('Tablet not found.')
    return deviceBlocks(client, tenantId, device.id, filter)
  }
  const rows = await client.numberBlock.findMany({
    where: { purpose: 'DEVICE', ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ kind: 'asc' }, { fromRef: 'desc' }],
    take: 500,
    select: BLOCK_SELECT,
  })
  const devices = await client.device.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.deviceId!))] } }, select: { id: true, companyId: true, siteId: true } })
  const visible = new Set(devices.filter((device) => can(actor, NUMBERING_VIEW, { companyId: device.companyId, siteId: device.siteId })).map((device) => device.id))
  return viewsOf(client, tenantId, rows.filter((row) => visible.has(row.deviceId!)))
}

/** Office: numbering.reserveBlock — a block of a kind for a tablet (default the kind's tablet size). */
export async function reserveBlock(caller: CommandCaller, input: { deviceId: string; kind: ScanIdKind; size?: number | undefined }, idempotencyKey?: string): Promise<BlockView> {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  const device = await caller.withClient((client) => readDevice(client, input.deviceId))
  if (!device || !can(actorOf(context), NUMBERING_VIEW, { companyId: device.companyId, siteId: device.siteId })) throw new NotFoundError('Tablet not found.')
  if (!can(actorOf(context), NUMBERING_MANAGE, { companyId: device.companyId, siteId: device.siteId })) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'numbering.reserveBlock', idempotencyKey, input }, async (tools) => {
    const current = await readDevice(tools.tx, device.id)
    if (!current) throw new NotFoundError('Tablet not found.')
    const row = await reserveInCommand(tools, current, input.kind, input.size ?? DEVICE_BLOCK_SIZE[input.kind])
    return (await viewsOf(tools.tx, context.tenantId, [row]))[0]!
  })
  return result
}

/** Office: numbering.closeBlock — a tablet's block closed (a lost or retired tablet): its numbers left are never used. */
export async function closeBlock(caller: CommandCaller, blockId: string, input: { reason: string; version: number }, idempotencyKey?: string): Promise<BlockView> {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const block = await caller.withClient((client) => client.numberBlock.findUnique({ where: { id: blockId }, select: { deviceId: true, purpose: true } }))
  const device = block?.deviceId ? await caller.withClient((client) => readDevice(client, block.deviceId!)) : null
  if (!block || !device || !can(actor, NUMBERING_VIEW, { companyId: device.companyId, siteId: device.siteId })) throw new NotFoundError('Number block not found.')
  if (!can(actor, NUMBERING_MANAGE, { companyId: device.companyId, siteId: device.siteId })) throw new ForbiddenError()
  const reason = input.reason.trim()
  const { result } = await command(
    caller,
    { name: 'numbering.closeBlock', idempotencyKey, input, record: { type: 'NumberBlock', id: blockId, expectedVersion: input.version } },
    async ({ tx, audit, now }) => {
      const before = await tx.numberBlock.findUniqueOrThrow({ where: { id: blockId }, select: BLOCK_SELECT })
      if (before.status === 'CLOSED') throw new ConflictError('This block of numbers is closed already.')
      const after = await tx.numberBlock.update({ where: { id: blockId }, data: { status: 'CLOSED', closedAt: now, closedReason: reason }, select: BLOCK_SELECT })
      audit({ recordType: 'NumberBlock', recordId: blockId, companyId: device.companyId, siteId: device.siteId, before: { status: before.status }, after: { status: 'CLOSED' }, reason })
      return (await viewsOf(tx, context.tenantId, [after]))[0]!
    },
  )
  return result
}

/**
 * Inside the command that revokes a tablet (platform/auth/floor revokeDevice): its open DEVICE blocks are closed, so a
 * label it printed and never sent is refused (BLOCK_CLOSED) and its numbers left are never used. One audit row per block.
 * Answers how many it closed.
 */
export async function closeDeviceBlocks(tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>, device: { readonly id: string; readonly companyId: string; readonly siteId: string }, reason: string): Promise<number> {
  const open = await tools.tx.numberBlock.findMany({ where: { purpose: 'DEVICE', deviceId: device.id, status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })
  if (open.length === 0) return 0
  await tools.tx.numberBlock.updateMany({ where: { id: { in: open.map((block) => block.id) } }, data: { status: 'CLOSED', closedAt: tools.now, closedReason: reason, version: { increment: 1 } } })
  for (const block of open) {
    tools.audit({ action: 'numbering.closeBlock', recordType: 'NumberBlock', recordId: block.id, companyId: device.companyId, siteId: device.siteId, before: { status: 'ACTIVE' }, after: { status: 'CLOSED' }, reason })
  }
  return open.length
}

// ---- the tablet's side ------------------------------------------------------------------------------------------------------

function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** The tablet's own blocks that are open, with what is left: what it numbers from offline. */
export async function myBlocks(caller: CommandCaller): Promise<{ scanTag: string; blocks: BlockView[] }> {
  const context = floorOf(caller)
  const blocks = await caller.withClient((client) => deviceBlocks(client, context.tenantId, context.deviceId, { status: 'ACTIVE' }))
  return { scanTag: tenantTag(context.tenantId), blocks }
}

export interface TopUpAsk {
  readonly kind: ScanIdKind
  /** How many numbers of the kind the tablet has left by its own count (it knows the labels it printed and has not sent). */
  readonly remaining?: number | undefined
}

/**
 * numbering.topUpBlocks — the tablet asks for numbers when it runs low (and at its first start: it has none). For each
 * kind asked (default all): when fewer than the kind's low-water mark are left over its open blocks (the lower of its
 * own count and the server's), and it holds fewer than three blocks with numbers left, one new block of the kind's
 * tablet size. Answers the tablet's open blocks and the ones reserved now.
 */
export async function topUpBlocks(caller: CommandCaller, asks: readonly TopUpAsk[] | undefined, idempotencyKey?: string): Promise<{ scanTag: string; blocks: BlockView[]; reserved: BlockView[] }> {
  const context = floorOf(caller)
  const wanted: readonly TopUpAsk[] = asks && asks.length > 0 ? asks : SCAN_ID_KINDS.map((kind) => ({ kind }))
  const kinds = new Set(wanted.map((ask) => ask.kind))
  if (kinds.size !== wanted.length) throw new ValidationError('Name each kind once.', [{ path: 'body/kinds', message: 'A kind is named twice.' }])
  const { result } = await command(caller, { name: 'numbering.topUpBlocks', idempotencyKey, input: { kinds: wanted } }, async (tools) => {
    const device = await readDevice(tools.tx, context.deviceId)
    if (!device) throw new NotFoundError('Tablet not found.')
    const reserved: BlockRow[] = []
    // Kinds in a fixed order: the counters' locks are taken in that order by every top-up.
    for (const ask of [...wanted].sort((a, b) => SCAN_ID_KINDS.indexOf(a.kind) - SCAN_ID_KINDS.indexOf(b.kind))) {
      const open = await deviceBlocks(tools.tx, context.tenantId, device.id, { kind: ask.kind, status: 'ACTIVE' })
      const decision = topUpFor(ask.kind, open, ask.remaining)
      if (decision.reserve !== null) reserved.push(await reserveInCommand(tools, device, ask.kind, decision.reserve))
    }
    if (reserved.length === 0) {
      // Every command writes an audit row: the tablet asked and had enough.
      tools.audit({ action: 'numbering.topUpChecked', recordType: 'Device', recordId: device.id, companyId: device.companyId, siteId: device.siteId, after: { kinds: wanted.map((ask) => ask.kind) } })
    }
    return {
      scanTag: tenantTag(context.tenantId),
      blocks: await deviceBlocks(tools.tx, context.tenantId, device.id, { status: 'ACTIVE' }),
      reserved: await viewsOf(tools.tx, context.tenantId, reserved),
    }
  })
  return result
}

// ---- numbers a tablet used ------------------------------------------------------------------------------------------------

/** The numbers a tablet used, refused: each code with its words and fix (`issues`: `scanIds/<index>/<CODE>`). */
export class ScanIdsRefusedError extends ConflictError {
  override name = 'ScanIdsRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusals: readonly (BlockUseRefusal & { readonly index: number })[]) {
    super(refusals.length === 1 ? `${refusals[0]!.message} ${refusals[0]!.fix}` : `${refusals.length} labels cannot be used: ${refusals.map((refusal) => refusal.scanned).join(', ')}.`)
    this.issues = refusals.map((refusal) => ({ path: `scanIds/${refusal.index}/${refusal.code}`, message: `${refusal.message} ${refusal.fix}` }))
  }
}

export interface ScanIdUse {
  /** The code as the tablet sent it (scanned, typed, or the one it printed). */
  readonly code: string
  /** The record that takes the number: its model name and id (Hide, Bundle, GarmentSerial). */
  readonly record: { readonly type: string; readonly id: string }
}

export interface UsedScanId {
  /** The code as printed (canonical). */
  readonly code: string
  readonly ref: number
  readonly blockId: string
}

const RECORD_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/

/**
 * The numbers a tablet printed from its own blocks (offline too), checked and recorded once each, inside the command
 * that stores what they number. A floor command uses its own tablet; an office or system command acting for a tablet
 * names it (`deviceId`). Refused (409 ScanIdsRefusedError, nothing written) when any code is not this tenant's, not of
 * the kind, not inside an open block of THAT tablet, or used before.
 *
 *   const [tag] = await useScanIds(tools, 'HIDE', [{ code: body.tag, record: { type: 'Hide', id: hideId } }])
 */
export async function useScanIds(tools: ScanIdTools, kind: ScanIdKind, uses: readonly ScanIdUse[], options: { readonly deviceId?: string } = {}): Promise<UsedScanId[]> {
  const tenantId = tenantOf(tools)
  assertKind(kind)
  const { tx, context } = tools
  let deviceId: string
  if (context.audience === 'floor') {
    if (options.deviceId !== undefined && options.deviceId !== context.deviceId) throw new ForbiddenError('A tablet uses only its own numbers.')
    deviceId = context.deviceId
  } else {
    if (options.deviceId === undefined) throw new ApiError('internal_error', 'useScanIds(): an office or system command names the tablet whose numbers it records.')
    deviceId = options.deviceId
  }
  for (const use of uses) {
    if (!RECORD_TYPE.test(use.record.type) || !isUuid(use.record.id)) throw new ApiError('internal_error', 'useScanIds() needs each record\'s model name and id.')
  }
  if (uses.length === 0) return []
  const device = await readDevice(tx, deviceId)
  if (!device) throw new NotFoundError('Tablet not found.')
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-id-use', ${tenantId}::uuid, ${deviceId}::uuid, ${kind}::text), 0))`

  const blocks = await tx.numberBlock.findMany({ where: { purpose: 'DEVICE', deviceId, kind }, select: { id: true, fromRef: true, toRef: true, status: true } })
  const canonical = uses.map((use) => parseScanId(use.code)).flatMap((parsed) => (parsed.ok ? [parsed.text] : []))
  const used = await tx.numberBlockUse.findMany({ where: { code: { in: canonical } }, select: { code: true, usedAt: true } })
  const check = checkBlockUses({ tenantId, kind, codes: uses.map((use) => use.code), blocks, used: new Map(used.map((row) => [row.code, row.usedAt])) })
  if (!check.ok) throw new ScanIdsRefusedError(check.refusals)

  await tx.numberBlockUse.createMany({
    data: check.uses.map((use, index) => ({
      id: newId(),
      siteId: device.siteId,
      deviceId,
      blockId: use.blockId,
      kind,
      ref: use.ref,
      code: use.code,
      recordType: uses[index]!.record.type,
      recordId: uses[index]!.record.id,
      usedAt: tools.now,
      requestId: context.requestId,
    })),
  })
  return check.uses.map((use) => ({ ...use }))
}
