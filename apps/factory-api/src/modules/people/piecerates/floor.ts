import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText, inForceOn, versionStateOf, type RateBasis } from '@nexus/factory-domain/people/piecerates/rates'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { systemContext } from '../../../platform/outbox/system'
import { floorOf, payGuarded } from './access'
import { day, RATE_SELECT, todayOf, VERSION_SELECT, versionRowOf } from './store'

/**
 * Piece rates on the floor (B-W2b-34; MES-255; design people.piecerates "Publish rates": "on the floor (My day) … reading
 * is recorded (AckTracker)"; c.c. art. 2101 c.3). The signed-in worker reads the rates published to them, and confirms
 * they read them (a signing act: the PIN again, requireFloorStepUp in the route). Their own records only.
 *
 * The pay tables are office-only (factory-db ownership/pay.json: the receipt is personal data for the purpose PAY, which
 * is not a floor purpose), so once the floor session is checked the API reads and writes them in the tenant's system
 * scope, as My day reads a worker's own figures (B-W2b-68). The receipt names the device, its clock and its event id
 * (unique per device: a resent reading is recorded once); its audit row names the worker and the device.
 */

/** The tenant's system caller for a checked floor request (the floor role has no grant on the pay tables). */
function systemCallerOf(caller: CommandCaller): CommandCaller {
  const context = floorOf(caller)
  const system = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  system.factoryContext = systemContext(context.tenantId, context.requestId)
  return system
}

/** floor.work: the publications to the signed-in worker of versions that pay now or later, with their rates. */
export async function floorMine(caller: CommandCaller) {
  const context = floorOf(caller)
  const today = todayOf(serverClock.now())
  return systemCallerOf(caller).withClient(async (client) => {
    const publications = await client.ratePublication.findMany({
      where: { siteId: context.siteId, status: 'PUBLISHED', onFloor: true, workerIds: { has: context.actorId } },
      select: { id: true, versionId: true, publishedAt: true },
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    })
    const versions = publications.length === 0 ? [] : await client.pieceRateVersion.findMany({ where: { id: { in: publications.map((row) => row.versionId) } }, select: VERSION_SELECT })
    const live = new Map(
      versions
        .filter((row) => {
          if (row.status === 'CANCELLED') return false
          const rules = versionRowOf(row)
          return inForceOn(rules, today) || rules.effectiveFrom > today || row.status === 'DRAFT'
        })
        .map((row) => [row.id, row]),
    )
    const shown = publications.filter((row) => live.has(row.versionId))
    const tableIds = [...new Set([...live.values()].map((row) => row.tableId))]
    const tables = tableIds.length === 0 ? [] : await client.pieceRateTable.findMany({ where: { id: { in: tableIds } }, select: { id: true, code: true, name: true, currency: true, styleId: true } })
    const tableById = new Map(tables.map((row) => [row.id, row]))
    const styleIds = tables.map((row) => row.styleId).filter((value): value is string => value !== null)
    const styles = styleIds.length === 0 ? [] : await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })
    const styleById = new Map(styles.map((row) => [row.id, row]))
    const rates = live.size === 0 ? [] : await client.pieceRateEntry.findMany({ where: { versionId: { in: [...live.keys()] } }, select: RATE_SELECT, orderBy: [{ sizeBand: 'asc' }, { id: 'asc' }] })
    const operationIds = [...new Set(rates.map((row) => row.operationId))]
    const operations = operationIds.length === 0 ? [] : await client.operation.findMany({ where: { id: { in: operationIds } }, select: { id: true, code: true, name: true } })
    const operationById = new Map(operations.map((row) => [row.id, row]))
    const receipts = shown.length === 0 ? [] : await client.rateAcknowledgement.findMany({ where: { publicationId: { in: shown.map((row) => row.id) }, workerId: context.actorId }, select: { publicationId: true, channel: true, serverTime: true }, orderBy: { serverTime: 'asc' } })
    return {
      today,
      publications: shown.map((publication) => {
        const version = live.get(publication.versionId)!
        const rules = versionRowOf(version)
        const table = tableById.get(version.tableId)!
        const read = receipts.find((receipt) => receipt.publicationId === publication.id) ?? null
        const { state, words } = versionStateOf(rules, today)
        return {
          publicationId: publication.id,
          versionId: version.id,
          versionNo: version.versionNo,
          table: { code: table.code, name: table.name, currency: table.currency },
          style: table.styleId ? (styleById.get(table.styleId) ?? null) : null,
          state,
          stateWords: words,
          effectiveFrom: rules.effectiveFrom,
          effectiveTo: rules.effectiveTo,
          provisional: version.provisional,
          trialEndsOn: day(version.trialEndsOn),
          publishedAt: toUtcIso(publication.publishedAt),
          read: read ? { at: toUtcIso(read.serverTime), channel: read.channel as 'DEVICE' | 'PAPER' } : null,
          rates: rates
            .filter((rate) => rate.versionId === version.id)
            .map((rate) => {
              const operation = operationById.get(rate.operationId)
              return {
                operation: { code: operation?.code ?? '?', name: operation?.name ?? '?' },
                sizeBand: rate.sizeBand,
                basis: rate.basis as RateBasis,
                standardMinutes: rate.standardMinutes === null ? null : decimalText(rate.standardMinutes.toString()),
                ratePerPiece: asMoney('pay', decimalText(rate.ratePerPiece.toString())),
              }
            }),
        }
      }),
    }
  })
}

/**
 * floor.work + the PIN again: the signed-in worker confirms they read a publication's rates (a DEVICE receipt). Reading
 * it again changes nothing; a worker the publication did not go to, or one not linked to an employee, is refused in words.
 */
export async function floorRead(caller: CommandCaller, publicationId: string, body: { readonly clientEventId?: string | undefined; readonly deviceTime?: string | undefined }, idempotencyKey?: string) {
  const context = floorOf(caller)
  if (!idempotencyKey) throw new ValidationError('An Idempotency-Key is required for floor writes.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
  const system = systemCallerOf(caller)
  const deviceTime = body.deviceTime ? new Date(body.deviceTime) : undefined
  const { result } = await command(system, { name: 'people.readRates', idempotencyKey, input: { publicationId, ...body, workerId: context.actorId, deviceId: context.deviceId }, ...(deviceTime ? { deviceTime } : {}) }, async (tools) => {
    const publication = await tools.tx.ratePublication.findFirst({ where: { id: publicationId, siteId: context.siteId }, select: { id: true, companyId: true, versionId: true, status: true, workerIds: true } })
    if (!publication || !publication.workerIds.includes(context.actorId)) throw new NotFoundError('Publication not found.')
    if (publication.status !== 'PUBLISHED') throw new ConflictError('These rates were withdrawn; nothing to confirm.')
    const worker = (await tools.tx.worker.findUnique({ where: { id: context.actorId }, select: { status: true, employeeId: true } }))!
    if (worker.employeeId === null) throw new ConflictError('Your floor sign-in is not linked to your employee record yet: ask the office (People › Employees); your reading is recorded on you.')
    const earlier = await tools.tx.rateAcknowledgement.findFirst({ where: { publicationId, workerId: context.actorId }, select: { id: true, channel: true, serverTime: true }, orderBy: { serverTime: 'asc' } })
    if (earlier) {
      tools.audit({ action: 'people.readRates', recordType: 'RateAcknowledgement', recordId: earlier.id, companyId: publication.companyId, siteId: context.siteId, after: { unchanged: true, workerId: context.actorId, deviceId: context.deviceId } })
      return { publicationId, read: { at: toUtcIso(earlier.serverTime), channel: earlier.channel as 'DEVICE' | 'PAPER' }, changed: false }
    }
    const id = newId()
    await payGuarded(() =>
      tools.tx.rateAcknowledgement.create({
        data: {
          id,
          siteId: context.siteId,
          publicationId,
          versionId: publication.versionId,
          employeeId: worker.employeeId!,
          workerId: context.actorId,
          channel: 'DEVICE',
          deviceId: context.deviceId,
          deviceTime: deviceTime ?? null,
          clientEventId: body.clientEventId ?? null,
          serverTime: tools.now,
          createdById: context.actorId,
        },
        select: { id: true },
      }),
    )
    tools.audit({ action: 'people.readRates', recordType: 'RateAcknowledgement', recordId: id, companyId: publication.companyId, siteId: context.siteId, after: { publicationId, versionId: publication.versionId, workerId: context.actorId, deviceId: context.deviceId, channel: 'DEVICE' } })
    tools.emit({ type: 'rate.read', subject: publicationId, companyId: publication.companyId, siteId: context.siteId, payload: { publicationId, versionId: publication.versionId, siteId: context.siteId, channel: 'DEVICE', receipts: 1 } })
    return { publicationId, read: { at: toUtcIso(tools.now), channel: 'DEVICE' as const }, changed: true }
  })
  return result
}
