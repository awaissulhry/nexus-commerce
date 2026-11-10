import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { PpeCategory } from '@nexus/factory-domain/compliance/cert-gate/gate'
import type { OperatorRole } from '@nexus/factory-domain/compliance/operators/rules'
import {
  checkOf,
  isCertificateCoverage,
  ownerOf,
  W1_CERTIFICATE_REQUIREMENT,
  type ComplianceGate,
  type ProductType,
  type RequirementKind,
  type RequirementRow,
  type RequirementStatus,
} from '@nexus/factory-domain/compliance/requirements/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { namesFor, type Reader } from '../register-of-rules/common'

/**
 * The requirement rows (B-W2b-254; B-W2b-216's ComplianceRequirement): what the gate, the checklist and Rules & markets ›
 * Gates read, and the W1 certificate requirement written on first need. One query per read (one connection runs one
 * query at a time).
 */

export const REQUIREMENT_SELECT = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  kind: true,
  checkKey: true,
  operatorRole: true,
  productTypes: true,
  productTypeProfileId: true,
  ppeCategories: true,
  marketCode: true,
  blocks: true,
  lockedBlocks: true,
  overrideRoleKeys: true,
  overrideMaxDays: true,
  legalReference: true,
  regulationId: true,
  explanationI18n: true,
  appliesFrom: true,
  appliesUntil: true,
  seq: true,
  switchedOn: true,
  offReason: true,
  switchedAt: true,
  switchedById: true,
  note: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ComplianceRequirementSelect
export type RequirementRecord = Prisma.ComplianceRequirementGetPayload<{ select: typeof REQUIREMENT_SELECT }>

export const textsOf = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

export const dayText = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

/** A stored row as the domain reads it. */
export function rowOf(record: RequirementRecord): RequirementRow {
  return {
    id: record.id,
    companyId: record.companyId,
    code: record.code,
    name: record.name,
    nameI18n: textsOf(record.nameI18n),
    kind: record.kind as RequirementKind,
    checkKey: record.checkKey,
    operatorRole: record.operatorRole as OperatorRole | null,
    productTypes: record.productTypes as ProductType[],
    productTypeProfileId: record.productTypeProfileId,
    ppeCategories: record.ppeCategories as PpeCategory[],
    marketCode: record.marketCode,
    blocks: record.blocks as ComplianceGate[],
    lockedBlocks: record.lockedBlocks as ComplianceGate[],
    overrideRoleKeys: record.overrideRoleKeys,
    overrideMaxDays: record.overrideMaxDays,
    legalReference: record.legalReference,
    explanationI18n: textsOf(record.explanationI18n),
    appliesFrom: dayText(record.appliesFrom),
    appliesUntil: dayText(record.appliesUntil),
    seq: record.seq,
    switchedOn: record.switchedOn,
    status: record.status as RequirementStatus,
  }
}

/** The built-in W1 requirement (no row yet: id null). */
export const BUILT_IN_W1: RequirementRow = { ...W1_CERTIFICATE_REQUIREMENT, id: null }

/**
 * Every requirement of the tenant as the gate reads it (any status: the checklist says why one does not apply), plus the
 * built-in W1 certificate requirement while the tenant has no certificate-coverage row (B-W2b-216's gap: live tenants have
 * none yet — W1's behaviour stays until the row exists).
 */
export async function gateRequirements(db: Reader): Promise<RequirementRow[]> {
  const rows = (await db.complianceRequirement.findMany({ select: REQUIREMENT_SELECT, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })).map(rowOf)
  return rows.some(isCertificateCoverage) ? rows : [BUILT_IN_W1, ...rows]
}

/**
 * The W1 certificate requirement as a row, written once on first need (a refusal must name its requirement). Under a
 * tenant lock, so two first refusals write one row; the code CERT-COVERAGE, or CERT-COVERAGE-W1 when a row of another
 * check already took that code. Returns the row's id. Runs in the caller's transaction (the system context: the floor
 * role may not write requirements).
 */
export async function ensureW1Requirement(tx: CommandTx, tenantId: string, now: Date): Promise<{ id: string; created: boolean }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.compliance-w1-requirement', ${tenantId}::uuid), 0))`
  const existing = (await tx.complianceRequirement.findMany({ select: REQUIREMENT_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(rowOf).find(isCertificateCoverage)
  if (existing?.id) return { id: existing.id, created: false }
  const taken = await tx.complianceRequirement.findFirst({ where: { code: W1_CERTIFICATE_REQUIREMENT.code }, select: { id: true } })
  const regulation = await tx.regulationOrStandard.findFirst({ where: { code: 'Reg. (EU) 2016/425', edition: null }, select: { id: true } })
  const id = newId()
  const w1 = W1_CERTIFICATE_REQUIREMENT
  await tx.complianceRequirement.create({
    data: {
      id,
      code: taken ? `${w1.code}-W1` : w1.code,
      name: w1.name,
      nameI18n: w1.nameI18n as Prisma.InputJsonValue,
      kind: w1.kind,
      checkKey: w1.checkKey,
      ppeCategories: [...w1.ppeCategories],
      blocks: [...w1.blocks],
      lockedBlocks: [...w1.lockedBlocks],
      overrideRoleKeys: [],
      overrideMaxDays: w1.overrideMaxDays,
      legalReference: w1.legalReference,
      regulationId: regulation?.id ?? null,
      explanationI18n: w1.explanationI18n as Prisma.InputJsonValue,
      seq: w1.seq,
      note: "W1's two gates, QHS-051 (label, final release) and MES-004 (work-order release), as one requirement (written by the gate on first need).",
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  })
  return { id, created: true }
}

/** The requirement's answer for the office (Rules & markets › Gates, the requirement record). */
export async function requirementViews(db: Reader, records: readonly RequirementRecord[]) {
  const person = await namesFor(db, records.map((record) => record.switchedById))
  const regulationIds = [...new Set(records.flatMap((record) => (record.regulationId ? [record.regulationId] : [])))]
  const regulations = regulationIds.length > 0 ? await db.regulationOrStandard.findMany({ where: { id: { in: regulationIds } }, select: { id: true, code: true, edition: true, link: true } }) : []
  const regulationOf = new Map(regulations.map((entry) => [entry.id, entry]))
  return records.map((record) => {
    const row = rowOf(record)
    const owner = ownerOf(row)
    const regulation = record.regulationId ? regulationOf.get(record.regulationId) : undefined
    return {
      ...row,
    productTypes: [...row.productTypes],
    ppeCategories: [...row.ppeCategories],
    blocks: [...row.blocks],
    lockedBlocks: [...row.lockedBlocks],
    overrideRoleKeys: [...row.overrideRoleKeys],
    nameI18n: { ...row.nameI18n },
    explanationI18n: { ...row.explanationI18n },
      id: record.id,
      check: checkOf(row),
      who: owner.who,
      fixPlace: owner.fix,
      regulation: regulation ? { id: regulation.id, label: regulation.edition ? `${regulation.code}:${regulation.edition}` : regulation.code, link: regulation.link } : null,
      offReason: record.offReason,
      switchedAt: record.switchedAt ? toUtcIso(record.switchedAt) : null,
      switchedBy: person(record.switchedById),
      note: record.note,
      version: record.version,
      updatedAt: toUtcIso(record.updatedAt),
      builtIn: false,
    }
  })
}
export type RequirementView = Awaited<ReturnType<typeof requirementViews>>[number]

/** The built-in W1 requirement shown before its row exists (the gate matrix says what is enforced today). */
export function builtInView() {
  const owner = ownerOf(BUILT_IN_W1)
  const row = BUILT_IN_W1
  return {
    ...row,
    productTypes: [...row.productTypes],
    ppeCategories: [...row.ppeCategories],
    blocks: [...row.blocks],
    lockedBlocks: [...row.lockedBlocks],
    overrideRoleKeys: [...row.overrideRoleKeys],
    nameI18n: { ...row.nameI18n },
    explanationI18n: { ...row.explanationI18n },
    id: null,
    check: checkOf(BUILT_IN_W1),
    who: owner.who,
    fixPlace: owner.fix,
    regulation: null,
    offReason: null,
    switchedAt: null,
    switchedBy: null,
    note: "W1's two gates (QHS-051, MES-004): built in until the gate first refuses, then written as a row.",
    version: 0,
    updatedAt: null,
    builtIn: true,
  }
}
