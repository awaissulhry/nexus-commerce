import type { Prisma } from '@nexus/factory-db'
import { CERTIFICATES_MANAGE } from '@nexus/factory-domain/compliance/certificates/permissions'
import { acceptsCoverage, type CertificateStatus } from '@nexus/factory-domain/compliance/certificates/rules'
import { certificateKindOf, scopeCheck } from '@nexus/factory-domain/compliance/certificates-depth/bodies'
import { supplierProblems } from '@nexus/factory-domain/compliance/certificates-depth/bought-in'
import { cleanLevels, gloveMarking, LEVEL_VOCABULARY, levelFamilyOf, levelsOf, levelsProblems, sameLevels, type Levels } from '@nexus/factory-domain/compliance/certificates-depth/levels'
import { baseStanding, outlivesBase, ownBrandProblems, sameStandard } from '@nexus/factory-domain/compliance/certificates-depth/own-brand'
import { fiveYearCheck } from '@nexus/factory-domain/compliance/certificates-depth/validity'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { certificatesClock, dayOf, mayManage, readCertificate, todayOf } from '../certificates/certificates'
import { officeOf, type Reader } from '../register-of-rules/common'
import { BODY_SELECT, bodyViews, namingBody, SUMMARY_SELECT, summaryOf, visibleCertificates } from './bodies'
import type { DepthView } from './contract'
import { inWords } from './guarded'

/**
 * A certificate in depth (B-W2b-255; design compliance.certificates rec Certificate › Notified body, Coverage › items,
 * pop:ce-new's five-year words): one read of what the W1 record does not say, and the four writes that fill it in —
 *
 *   PUT …/notified-body   pick the body from the directory (PRD-286). A draft takes the body's number and name as its
 *                         typed ones (W1 keeps them typed); a registered certificate links a body once, and only the body
 *                         whose number it was issued under.
 *   PUT …/levels          the performance levels in the standard's vocabulary (PRD-290: EN 13594 glove level and KP; EN
 *                         1621 zones).
 *   PUT …/base            an own-brand certificate's base: the factory's certificate it rests on (PRD-287).
 *   PUT …/coverage/:coverageId/supplier   a bought-in part's supplier and article code on the item's coverage (QHS-106).
 *
 * A draft changes freely; once registered each of body, levels and base is filled in once (from none) and never changes
 * (B-W2b-216's Certificate_w2b4_rules: said here first, in words). Reading is W1's (compliance.certificates.view over the
 * certificate's company and holder: another one is not found); writing is compliance.certificates.manage over the same.
 * Each write is ONE command on the certificate's (or the coverage's) version with its audit row on the certificate and
 * `certificates_depth.certificate_detailed`; a draft whose typed body changed also emits W1's
 * `compliance.certificate_changed` (EDITED), which the search index follows.
 */

const DEPTH_SELECT = {
  ...SUMMARY_SELECT,
  notifiedBodyName: true,
  notifiedBodyId: true,
  performanceLevels: true,
  baseCertificateId: true,
  version: true,
  holderParty: { select: { roles: true } },
} as const satisfies Prisma.CertificateSelect
type DepthRow = Prisma.CertificateGetPayload<{ select: typeof DEPTH_SELECT }>

const settings = () => ({ ...COMMAND_SETTINGS, clock: certificatesClock() })
const partyName = (party: { legalName: string; tradeName: string | null }): string => party.tradeName?.trim() || party.legalName

/** The certificate in depth, read with this client (a request's, or a command's transaction). */
export async function certificateDepth(db: Reader, context: OfficeContext, certificateId: string, today: BusinessDate): Promise<DepthView> {
  const row = await db.certificate.findUnique({ where: { id: certificateId }, select: DEPTH_SELECT })
  if (!row) throw new NotFoundError('Certificate not found.')
  const visible = visibleCertificates(context)
  const kind = certificateKindOf(row.standard)
  const registered = row.status !== 'DRAFT'

  const linked = row.notifiedBodyId ? await db.notifiedBody.findUnique({ where: { id: row.notifiedBodyId }, select: BODY_SELECT }) : null
  const matchingRows = await db.notifiedBody.findMany({ where: { number: row.notifiedBodyNumber, status: 'ACTIVE' }, select: BODY_SELECT, orderBy: { createdAt: 'asc' } })
  const [directory] = linked ? await bodyViews(db, context, [linked], kind) : [null]
  const matching = await bodyViews(db, context, matchingRows, kind)
  const others = await db.certificate.findMany({
    where: { AND: [visible, linked ? namingBody(linked) : { notifiedBodyNumber: row.notifiedBodyNumber }, { id: { not: row.id } }] },
    select: SUMMARY_SELECT,
    orderBy: [{ validTo: 'desc' }, { number: 'asc' }],
    take: 50,
  })

  const levels = levelsOf(row.performanceLevels)
  const family = levelFamilyOf(row.standard)

  const brandHeld = !!row.holderPartyId && (row.holderParty?.roles ?? []).includes('BRAND')
  const base = row.baseCertificateId ? await db.certificate.findUnique({ where: { id: row.baseCertificateId }, select: SUMMARY_SELECT }) : null
  const restingOnThis = await db.certificate.findMany({ where: { AND: [visible, { baseCertificateId: row.id }] }, select: SUMMARY_SELECT, orderBy: [{ validTo: 'desc' }, { number: 'asc' }], take: 50 })
  const candidates =
    brandHeld && (!registered || !row.baseCertificateId)
      ? (
          await db.certificate.findMany({
            where: { AND: [visible, { id: { not: row.id }, companyId: { not: null }, holderPartyId: null, baseCertificateId: null, status: { in: ['DRAFT', 'VALID', 'SUSPENDED'] } }] },
            select: SUMMARY_SELECT,
            orderBy: [{ validTo: 'desc' }, { number: 'asc' }],
            take: 100,
          })
        )
          .map(summaryOf)
          .sort((a, b) => Number(sameStandard(b.standard, row.standard)) - Number(sameStandard(a.standard, row.standard)))
          .slice(0, 50)
      : []

  const items = await db.certificateCoverage.findMany({
    where: { certificateId: row.id, itemId: { not: null }, status: 'ACTIVE' },
    select: { id: true, version: true, note: true, supplierArticleCode: true, item: { select: { id: true, code: true, name: true } }, supplierParty: { select: { id: true, legalName: true, tradeName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  const summary = summaryOf(row)
  const baseSummary = base ? summaryOf(base) : null
  return {
    certificate: { ...summary, version: row.version, notifiedBodyName: row.notifiedBodyName, registered },
    validity: fiveYearCheck(summary.validFrom, summary.validTo),
    body: {
      typed: { name: row.notifiedBodyName, number: row.notifiedBodyNumber },
      directory: directory ?? null,
      matching,
      scope: linked ? scopeCheck(linked.scopes, kind === 'OTHER' ? 'GARMENT' : kind) : null,
      others: others.map(summaryOf),
    },
    levels: {
      family,
      properties: family ? LEVEL_VOCABULARY[family].properties.map((property) => ({ key: property.key, values: [...property.values], required: property.required, zone: property.zone ?? false })) : [],
      values: levels,
      marking: family === 'EN13594' ? gloveMarking(levels) : null,
      problems: levelsProblems(row.standard, row.ppeClass, levels),
    },
    ownBrand: {
      brandHeld,
      base: baseSummary,
      standing: baseSummary ? baseStanding(baseSummary, today) : null,
      outlivesBaseDays: baseSummary ? outlivesBase(summary, baseSummary) : 0,
      sameStandard: baseSummary ? sameStandard(baseSummary.standard, row.standard) : null,
      restingOnThis: restingOnThis.map(summaryOf),
      candidates,
    },
    boughtIn: items.map((item) => ({
      coverageId: item.id,
      version: item.version,
      item: item.item,
      supplier: item.supplierParty ? { id: item.supplierParty.id, name: partyName(item.supplierParty) } : null,
      supplierArticleCode: item.supplierArticleCode,
      note: item.note,
    })),
    mayManage: can(actorOf(context), CERTIFICATES_MANAGE, { companyId: row.companyId, partyId: row.holderPartyId }),
    today,
  }
}

/** GET /compliance/certificates/:certificateId/depth */
export async function getDepth(caller: CommandCaller, certificateId: string): Promise<{ depth: DepthView }> {
  const context = officeOf(caller)
  await readCertificate(caller, certificateId)
  return { depth: await caller.withClient((db) => certificateDepth(db, context, certificateId, todayOf())) }
}

type Detail = 'NOTIFIED_BODY' | 'LEVELS' | 'BASE' | 'SUPPLIER'

function detailed(tools: Pick<CommandTools, 'emit'>, row: { id: string; companyId: string | null; number: string; status: CertificateStatus }, detail: Detail): void {
  tools.emit({ type: 'certificates_depth.certificate_detailed', subject: row.id, companyId: row.companyId, payload: { certificateId: row.id, number: row.number, status: row.status, detail } })
}

const filledOnce = (number: string, status: string, what: string) =>
  new DomainError('conflict', `Certificate ${number} is ${status}: its ${what} is filled in once and never changes after. A correction is a new certificate.`, [{ path: `refusal/FILLED_ONCE`, message: `Registered: the ${what} is fixed.` }])

/** Runs one depth write on the certificate's version (locked by command()), then answers the depth as it left it. */
async function certificateWrite(
  caller: CommandCaller,
  certificateId: string,
  name: `${string}.${string}`,
  input: { readonly version: number } & Record<string, unknown>,
  key: string | null | undefined,
  unchanged: (row: DepthRow) => boolean,
  work: (tools: CommandTools, row: DepthRow) => Promise<Detail | null>,
): Promise<{ depth: DepthView }> {
  const context = officeOf(caller)
  const before = await readCertificate(caller, certificateId)
  mayManage(caller, before)
  // Nothing to change (the value it has already): the depth as it stands, no command (every command is audited).
  const current = await caller.withClient((db) => db.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: DEPTH_SELECT }))
  if (unchanged(current)) return { depth: await caller.withClient((db) => certificateDepth(db, context, certificateId, todayOf())) }
  const { result } = await inWords(() =>
    runCommand(
      caller,
      { name, idempotencyKey: key, input: { certificateId, ...input }, record: { type: 'Certificate', id: certificateId, expectedVersion: input.version } },
      async (tools) => {
        const row = await tools.tx.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: DEPTH_SELECT })
        const detail = await work(tools, row)
        if (detail) detailed(tools, row, detail)
        // Another write made the same change meanwhile: the request is still recorded (every command is audited).
        else tools.audit({ action: name, recordType: 'Certificate', recordId: row.id, companyId: row.companyId, after: { unchanged: true } })
        return certificateDepth(tools.tx, context, certificateId, businessDate(tools.now))
      },
      settings(),
    ),
  )
  return { depth: result }
}

/** PUT /compliance/certificates/:certificateId/notified-body — the body from the directory (null: none, a draft only). */
export async function setNotifiedBody(caller: CommandCaller, certificateId: string, body: { readonly version: number; readonly notifiedBodyId: string | null }, key: string | null | undefined) {
  return certificateWrite(caller, certificateId, 'compliance.certificates.setNotifiedBody', body, key, (row) => row.notifiedBodyId === body.notifiedBodyId, async (tools, row) => {
    const { tx, now, audit, emit } = tools
    if (body.notifiedBodyId === row.notifiedBodyId) return null
    const registered = row.status !== 'DRAFT'
    if (registered && row.notifiedBodyId) throw filledOnce(row.number, row.status, 'notified body')
    if (body.notifiedBodyId === null) {
      const updated = await tx.certificate.update({ where: { id: row.id }, data: { notifiedBodyId: null, updatedAt: now }, select: { notifiedBodyId: true } })
      audit({ action: 'compliance.certificates.setNotifiedBody', recordType: 'Certificate', recordId: row.id, companyId: row.companyId, before: { notifiedBodyId: row.notifiedBodyId }, after: updated })
      return 'NOTIFIED_BODY'
    }
    const chosen = isUuid(body.notifiedBodyId) ? await tx.notifiedBody.findUnique({ where: { id: body.notifiedBodyId }, select: { id: true, number: true, name: true, status: true } }) : null
    if (!chosen) throw new ValidationError('The notified body is not valid.', [{ path: 'body/notifiedBodyId', message: 'Not a body of the directory.' }])
    if (chosen.status !== 'ACTIVE') throw new DomainError('conflict', `Notified body ${chosen.number} is archived: pick the active entry of the directory.`, [{ path: 'body/notifiedBodyId', message: 'Archived.' }])
    if (registered && chosen.number !== row.notifiedBodyNumber) {
      throw new DomainError('conflict', `Certificate ${row.number} was issued by notified body ${row.notifiedBodyNumber} (as typed from it): the directory's body ${chosen.number} is another one.`, [{ path: 'body/notifiedBodyId', message: `Pick body ${row.notifiedBodyNumber}.` }])
    }
    // A draft takes the body's number and name as its typed ones (the design: "the 4-digit number fills in").
    const typed = registered ? {} : { notifiedBodyNumber: chosen.number, notifiedBodyName: chosen.name }
    const updated = await tx.certificate.update({ where: { id: row.id }, data: { notifiedBodyId: chosen.id, ...typed, updatedAt: now }, select: { notifiedBodyId: true, notifiedBodyNumber: true, notifiedBodyName: true } })
    audit({ action: 'compliance.certificates.setNotifiedBody', recordType: 'Certificate', recordId: row.id, companyId: row.companyId, before: { notifiedBodyId: row.notifiedBodyId, notifiedBodyNumber: row.notifiedBodyNumber, notifiedBodyName: row.notifiedBodyName }, after: updated })
    if (!registered && (updated.notifiedBodyNumber !== row.notifiedBodyNumber || updated.notifiedBodyName !== row.notifiedBodyName)) {
      emit({ type: 'compliance.certificate_changed', subject: row.id, companyId: row.companyId, payload: { certificateId: row.id, number: row.number, status: row.status, change: 'EDITED' } })
    }
    return 'NOTIFIED_BODY'
  })
}

/** PUT /compliance/certificates/:certificateId/levels — the performance levels (null: none, a draft only). */
export async function setLevels(caller: CommandCaller, certificateId: string, body: { readonly version: number; readonly levels: Readonly<Record<string, string>> | null }, key: string | null | undefined) {
  return certificateWrite(caller, certificateId, 'compliance.certificates.setLevels', body, key, (row) => sameLevels(body.levels ? cleanLevels(body.levels) : null, levelsOf(row.performanceLevels)), async (tools, row) => {
    const { tx, now, audit } = tools
    const next: Levels | null = body.levels ? cleanLevels(body.levels) : null
    const current = levelsOf(row.performanceLevels)
    if (sameLevels(next, current)) return null
    if (row.status !== 'DRAFT' && current !== null) throw filledOnce(row.number, row.status, 'performance levels')
    const problems: Issue[] = levelsProblems(row.standard, row.ppeClass, next)
    if (problems.length > 0) throw new ValidationError('The performance levels are not valid.', problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })))
    await tx.certificate.update({ where: { id: row.id }, data: { performanceLevels: next === null ? (null as unknown as Prisma.InputJsonValue) : (next as Prisma.InputJsonValue), updatedAt: now }, select: { id: true } })
    audit({ action: 'compliance.certificates.setLevels', recordType: 'Certificate', recordId: row.id, companyId: row.companyId, before: { performanceLevels: current }, after: { performanceLevels: next } })
    return 'LEVELS'
  })
}

/** PUT /compliance/certificates/:certificateId/base — an own-brand certificate's base (null: none, a draft only). */
export async function setBase(caller: CommandCaller, certificateId: string, body: { readonly version: number; readonly baseCertificateId: string | null }, key: string | null | undefined) {
  const context = officeOf(caller)
  return certificateWrite(caller, certificateId, 'compliance.certificates.setBase', body, key, (row) => row.baseCertificateId === body.baseCertificateId, async (tools, row) => {
    const { tx, now, audit } = tools
    if (body.baseCertificateId === row.baseCertificateId) return null
    if (row.status !== 'DRAFT' && row.baseCertificateId) throw filledOnce(row.number, row.status, 'base certificate')
    if (body.baseCertificateId !== null) {
      const base = isUuid(body.baseCertificateId)
        ? await tx.certificate.findFirst({ where: { AND: [visibleCertificates(context), { id: body.baseCertificateId }] }, select: { ...SUMMARY_SELECT, baseCertificateId: true } })
        : null
      if (!base) throw new ValidationError('The base certificate is not valid.', [{ path: 'body/baseCertificateId', message: 'Not a certificate of the register you may see.' }])
      const problems = ownBrandProblems({
        certificate: { id: row.id, number: row.number, standard: row.standard, holderPartyId: row.holderPartyId },
        holderIsBrand: (row.holderParty?.roles ?? []).includes('BRAND'),
        restingOnThis: await tx.certificate.count({ where: { baseCertificateId: row.id } }),
        base: { id: base.id, number: base.number, standard: base.standard, companyId: base.companyId, holderPartyId: base.holderPartyId, baseCertificateId: base.baseCertificateId, status: base.status, validFrom: dayOf(base.validFrom), validTo: dayOf(base.validTo) },
      })
      if (problems.length > 0) throw new ValidationError('The base certificate is not valid.', problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })))
    }
    await tx.certificate.update({ where: { id: row.id }, data: { baseCertificateId: body.baseCertificateId, updatedAt: now }, select: { id: true } })
    audit({ action: 'compliance.certificates.setBase', recordType: 'Certificate', recordId: row.id, companyId: row.companyId, before: { baseCertificateId: row.baseCertificateId }, after: { baseCertificateId: body.baseCertificateId } })
    return 'BASE'
  })
}

/** PUT /compliance/certificates/:certificateId/coverage/:coverageId/supplier — a bought-in part's supplier, named once. */
export async function setSupplier(
  caller: CommandCaller,
  certificateId: string,
  coverageId: string,
  body: { readonly version: number; readonly supplierPartyId: string; readonly supplierArticleCode?: string | null | undefined },
  key: string | null | undefined,
): Promise<{ depth: DepthView }> {
  const context = officeOf(caller)
  const certificate = await readCertificate(caller, certificateId)
  mayManage(caller, certificate)
  if (!isUuid(coverageId)) throw new NotFoundError('Coverage not found.')
  const articleCode = body.supplierArticleCode?.trim() || null
  const seen = await caller.withClient((db) => db.certificateCoverage.findUnique({ where: { id: coverageId }, select: { certificateId: true, supplierPartyId: true, supplierArticleCode: true } }))
  if (!seen || seen.certificateId !== certificateId) throw new NotFoundError('Coverage not found.')
  // Nothing to change: the depth as it stands, no command (every command is audited).
  if (seen.supplierPartyId === body.supplierPartyId && seen.supplierArticleCode === articleCode) return { depth: await caller.withClient((db) => certificateDepth(db, context, certificateId, todayOf())) }
  const { result } = await inWords(() =>
    runCommand(
      caller,
      { name: 'compliance.certificates.setSupplier', idempotencyKey: key, input: { certificateId, coverageId, ...body }, record: { type: 'CertificateCoverage', id: coverageId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const coverage = await tx.certificateCoverage.findUniqueOrThrow({ where: { id: coverageId }, select: { id: true, certificateId: true, itemId: true, status: true, supplierPartyId: true, supplierArticleCode: true } })
        if (coverage.certificateId !== certificateId) throw new NotFoundError('Coverage not found.')
        const owner = await tx.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: { id: true, number: true, status: true, companyId: true } })
        if (coverage.status !== 'ACTIVE') throw new InvalidStateError(`This coverage of certificate ${owner.number} has ended: it names nothing more.`)
        if (!acceptsCoverage(owner.status)) throw new InvalidStateError(`Certificate ${owner.number} is ${owner.status}: it covers nothing more.`)
        const party = await tx.party.findUnique({ where: { id: body.supplierPartyId }, select: { roles: true } })
        if (!party) throw new ValidationError('The supplier is not valid.', [{ path: 'body/supplierPartyId', message: 'Not a party of the tenant.' }])
        const problems = supplierProblems({ isItem: coverage.itemId !== null, current: coverage.supplierPartyId, supplierPartyId: body.supplierPartyId, supplierArticleCode: articleCode, isSupplier: party.roles.includes('SUPPLIER') })
        if (problems.length > 0) throw new ValidationError('The supplier is not valid.', problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })))
        if (coverage.supplierPartyId === body.supplierPartyId && coverage.supplierArticleCode === articleCode) {
          audit({ action: 'compliance.certificates.setSupplier', recordType: 'Certificate', recordId: certificateId, companyId: owner.companyId, after: { coverageId, unchanged: true } })
          return certificateDepthIn(tools, context, certificateId)
        }
        const updated = await tx.certificateCoverage.update({ where: { id: coverage.id }, data: { supplierPartyId: body.supplierPartyId, supplierArticleCode: articleCode, updatedAt: now }, select: { supplierPartyId: true, supplierArticleCode: true } })
        audit({ action: 'compliance.certificates.setSupplier', recordType: 'Certificate', recordId: certificateId, companyId: owner.companyId, before: { coverageId, supplierPartyId: coverage.supplierPartyId, supplierArticleCode: coverage.supplierArticleCode }, after: { coverageId, ...updated } })
        detailed(tools, owner, 'SUPPLIER')
        return certificateDepthIn(tools, context, certificateId)
      },
      settings(),
    ),
  )
  return { depth: result }
}

const certificateDepthIn = (tools: CommandTools, context: OfficeContext, certificateId: string) => certificateDepth(tools.tx, context, certificateId, businessDate(tools.now))
