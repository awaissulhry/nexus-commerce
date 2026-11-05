import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { badgeCodeHash, normalizeBadgeCode } from '@nexus/factory-domain/auth/floor/badge'
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { lineEventId, lineProblems, PPE_REFUSALS, RECEIPT_STATEMENT, sha256Hex, signedReceiptText, statementLanguageOf, type IssueLineDraft } from '@nexus/factory-domain/safety/ppe/rules'
import { command, type CommandTx } from '../../../core/command'
import { requireContext, type FloorContext } from '../../../core/context'
import { floorSessionOf } from '../../../platform/auth/floor/authenticator'
import { requireDevice } from '../../../platform/auth/floor/device'
import { claimProved, provedWorker, refuseByMode } from '../../../platform/auth/floor/sign-in'
import type { OfficeAuth } from '../../../platform/auth/sessions/office-auth'
import { problemsError, refuse, todayOf } from '../organisation/access'
import { holdingsOf } from '../rolesheets/needs'
import { holdingKey } from '@nexus/factory-domain/safety/rolesheets/rules'
import { itemsOfLines } from './issues'
import { lockPerson, RECORD_ISSUE } from './store'

/**
 * Receive PPE on the floor (B-W2b-134; QHS-261; design floor.training "Receive PPE": scan the worker's badge → the item or its
 * tile → size → quantity → the worker signs with their PIN "I received these items and their instructions"; D.Lgs. 81/2008
 * art. 77 c.4, art. 18 c.1 d), at the tablet's own site, floor.work:
 *
 *   GET  /safety/floor/ppe/items      the tiles: the ACTIVE items of the site's company (sizes; never a cost or a supplier)
 *   POST /safety/floor/ppe/person     the scanned badge (or the name picked): who receives, their role's kit against what they
 *                                     hold at this site (the tablet prefills the missing items) and the words they will sign.
 *                                     No PIN, nothing written.
 *   POST /safety/floor/ppe/receive    the badge (or name) and the PERSON'S OWN PIN with the lines: the floor sign-in's own check
 *                                     (`provedWorker`: one answer for a wrong badge, a wrong PIN, a locked or inactive worker;
 *                                     a wrong PIN counts towards the person's lockout), claimed again inside ONE command
 *                                     (`claimProved`), which writes one FLOOR_PIN row per line: the person's own worker, the
 *                                     tablet, the line's event id (`<Idempotency-Key>.<n>`), the SHA-256 of what they signed
 *                                     (the statement in their language and exactly the lines: factory-domain
 *                                     `signedReceiptText`); handed over by the worker signed in at the tablet when that is
 *                                     someone else. A badge alone never signs (the PIN is always asked: a signing act).
 *
 * Online only (no floor-sync kind): a PIN is never queued, and a receipt is the PIN proved at the moment it is signed. A line
 * board refuses before any PIN is read; a personal phone signs only its own person (B-W2b-52 `refuseByMode`). The office
 * never proves a worker's PIN (B-W2b-122's rule): the database refuses a FLOOR_PIN row written outside a floor session.
 */

/** GET /safety/floor/ppe/items. */
export async function floorItems(request: FastifyRequest) {
  const context = floorContextOf(request)
  return request.withClient(async (client) => {
    const site = await client.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
    if (!site) throw new NotFoundError('The tablet’s site is not found.')
    const items = await client.ppeItem.findMany({ where: { companyId: site.companyId, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }], select: { id: true, code: true, name: true, nameI18n: true, category: true, standard: true, sizes: true } })
    return { items: items.map((item) => ({ ...item, nameI18n: i18nOf(item.nameI18n), category: item.category as 'CATEGORY_I' | 'CATEGORY_II' | 'CATEGORY_III' })) }
  })
}

const i18nOf = (value: Prisma.JsonValue | null): Record<string, string> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null)

function floorContextOf(request: FastifyRequest): FloorContext {
  const context = requireContext(request)
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

interface Credentials {
  readonly badgeCode?: string | undefined
  readonly workerId?: string | undefined
}

const oneOf = (body: Credentials): void => {
  if ((body.badgeCode === undefined) === (body.workerId === undefined)) throw new ValidationError('Scan the badge of the person who receives, or pick their name.', [{ path: 'badgeCode', message: 'Send a badge code or a worker id, not both.' }])
}

/** POST /safety/floor/ppe/person: who the badge (or the name) is, and their kit against what they hold here. */
export async function floorPerson(request: FastifyRequest, body: Credentials, now: Date = new Date()) {
  const context = floorContextOf(request)
  oneOf(body)
  return request.withClient(async (client) => {
    let worker: { id: string; displayName: string; locale: string; employeeId: string | null; status: string } | null = null
    const select = { id: true, displayName: true, locale: true, employeeId: true, status: true } as const
    if (body.badgeCode !== undefined) {
      const code = normalizeBadgeCode(body.badgeCode)
      const badge = code === null ? null : await client.badge.findUnique({ where: { codeHash: badgeCodeHash(code) }, select: { status: true, worker: { select } } })
      worker = badge && badge.status === 'ACTIVE' ? badge.worker : null
    } else {
      worker = await client.worker.findFirst({ where: { id: body.workerId!, siteId: context.siteId }, select })
    }
    if (!worker || worker.status !== 'ACTIVE') throw new NotFoundError('This badge is not known here, or the worker is not active.')
    const kit: { ppeItemId: string; quantity: number; held: number; missing: number; whenToWear: string }[] = []
    let role: { code: string; name: string } | null = null
    // The floor reads its site's people and kits (never a name of the record): the person's role, its kit, what they hold here.
    const employee = worker.employeeId ? await client.employee.findUnique({ where: { id: worker.employeeId }, select: { roleSheetId: true, status: true } }) : null
    if (employee?.roleSheetId) {
      const sheet = await client.roleSheet.findUnique({ where: { id: employee.roleSheetId }, select: { code: true, name: true } })
      role = sheet ? { code: sheet.code, name: sheet.name } : null
      const lines = await client.ppeKitLine.findMany({ where: { roleSheetId: employee.roleSheetId }, orderBy: [{ seq: 'asc' }], select: { ppeItemId: true, quantity: true, whenToWear: true } })
      const { held } = await holdingsOf(client, [worker.employeeId!], [], lines.map((line) => line.ppeItemId), todayOf(now))
      for (const line of lines) {
        const units = held.get(holdingKey(worker.employeeId!, line.ppeItemId)) ?? 0
        kit.push({ ppeItemId: line.ppeItemId, quantity: line.quantity, held: units, missing: Math.max(0, line.quantity - units), whenToWear: line.whenToWear })
      }
    }
    return { worker: { id: worker.id, displayName: worker.displayName }, role, kit, statement: RECEIPT_STATEMENT[statementLanguageOf(worker.locale)] }
  })
}

/** Inside the receive command: the person behind the worker (their record, ACTIVE, of the site's company when it is visible here). */
async function receiverOf(tx: CommandTx, context: FloorContext, workerId: string) {
  const worker = await tx.worker.findUnique({ where: { id: workerId }, select: { employeeId: true, displayName: true, locale: true } })
  if (!worker?.employeeId) refuse('NO_EMPLOYEE', PPE_REFUSALS.NO_EMPLOYEE)
  const site = await tx.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
  if (!site) throw new NotFoundError('The tablet’s site is not found.')
  // A record of another site of the company is not visible on this floor: its company is the foreign key's to check.
  const employee = await tx.employee.findUnique({ where: { id: worker!.employeeId! }, select: { status: true, companyId: true } })
  if (employee && employee.status !== 'ACTIVE') refuse('NOT_ACTIVE', PPE_REFUSALS.NOT_ACTIVE)
  if (employee && employee.companyId !== site.companyId) refuse('OTHER_COMPANY', PPE_REFUSALS.OTHER_COMPANY)
  return { employeeId: worker!.employeeId!, companyId: site.companyId, displayName: worker!.displayName, locale: worker!.locale }
}

/** POST /safety/floor/ppe/receive. */
export async function floorReceive(auth: OfficeAuth, request: FastifyRequest, body: Credentials & { readonly pin: string; readonly lines: readonly IssueLineDraft[] }, idempotencyKey: string | undefined) {
  const context = floorContextOf(request)
  oneOf(body)
  if (idempotencyKey === undefined) throw new ValidationError('An Idempotency-Key is required for floor writes.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
  const session = floorSessionOf(request)
  const place = await requireDevice(auth, request)
  if (place.device.id !== session.device.id) throw new UnauthenticatedError()
  refuseByMode(place, null)
  // The person's own badge (or name) and PIN, by the floor sign-in's own rules: a wrong PIN counts towards their lockout.
  const proved = await provedWorker(auth, request, place, { badgeCode: body.badgeCode, workerId: body.workerId, pin: body.pin }, session.workerId)
  if (!proved.pinVerified) throw new ValidationError('The person signs with their PIN.', [{ path: 'pin', message: 'Required.' }])
  const receiver = proved.candidate.worker
  refuseByMode(place, receiver.id)
  const lines = body.lines.map((line) => ({ ...line, size: line.size?.trim() || null }))
  const { result } = await command(request, { name: 'safety.receivePpe', idempotencyKey, input: { workerId: receiver.id, lines } }, async (tools) => {
    const { tx, now } = tools
    await claimProved(tx, place.device, proved, now)
    const person = await receiverOf(tx, context, receiver.id)
    await lockPerson(tx, person.employeeId)
    const items = await itemsOfLines(tools, lines)
    const problems = lineProblems(lines, items, person.companyId)
    if (problems.length > 0) throw problemsError(problems, 'The items to hand over are not valid.')
    const language = statementLanguageOf(person.locale)
    const issuedAt = toUtcIso(now)
    const sha256 = sha256Hex(
      signedReceiptText({
        language,
        companyId: person.companyId,
        siteId: context.siteId,
        employeeId: person.employeeId,
        workerId: receiver.id,
        deviceId: context.deviceId,
        issuedAt,
        lines: lines.map((line) => ({ ppeItemId: line.ppeItemId, code: items.get(line.ppeItemId)!.code, size: line.size, quantity: line.quantity, reason: line.reason })),
      }),
    )
    const ids = lines.map(() => newId()).sort()
    const giver = session.workerId !== receiver.id ? session.workerId : null
    for (const [index, line] of lines.entries()) {
      await tx.ppeIssue.create({
        data: {
          id: ids[index]!,
          companyId: person.companyId,
          siteId: context.siteId,
          kind: 'ISSUE',
          employeeId: person.employeeId,
          ppeItemId: line.ppeItemId,
          size: line.size,
          quantity: line.quantity,
          reason: line.reason,
          issuedAt: now,
          issuedByWorkerId: giver,
          method: 'FLOOR_PIN',
          signedByWorkerId: receiver.id,
          deviceId: context.deviceId,
          clientEventId: lineEventId(idempotencyKey, index),
          signatureSha256: sha256,
          createdAt: now,
        },
        select: { id: true },
      })
    }
    const receiptId = ids[0]!
    const units = lines.reduce((sum, line) => sum + line.quantity, 0)
    tools.audit({
      action: 'safety.receivePpe',
      recordType: RECORD_ISSUE,
      recordId: receiptId,
      companyId: person.companyId,
      siteId: context.siteId,
      after: { receiptId, employeeId: person.employeeId, method: 'FLOOR_PIN', issuedAt, signedByWorkerId: receiver.id, issuedByWorkerId: giver, deviceId: context.deviceId, sha256, lines: lines.map((line, index) => ({ issueId: ids[index], ppeItemId: line.ppeItemId, size: line.size, quantity: line.quantity, reason: line.reason })) },
    })
    tools.emit({ type: 'ppe.issued', subject: receiptId, companyId: person.companyId, siteId: context.siteId, payload: { receiptId, employeeId: person.employeeId, issueIds: ids, units, method: 'FLOOR_PIN', via: 'FLOOR' } })
    return { receipt: { id: receiptId, issuedAt, issueIds: ids, units, worker: { id: receiver.id, displayName: person.displayName }, statement: RECEIPT_STATEMENT[language], sha256 } }
  })
  return result
}
