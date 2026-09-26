import { Prisma } from '@prisma/client'
import {
  activationBlocker, diffMappingFields, mappingCounts, MAPPING_DIRECTIONS, MAPPING_FIELD_STATES, MAPPING_TARGET_KINDS,
  type MappingDiff, type MappingFieldRow, type MappingForm, type MappingSetDetail, type MappingSetSummary, type MappingTransform,
} from '@nexus/shared/channel-mapping'
import prisma from '../../db.js'

/**
 * CHMAP — the mapping versions in the database (`ChannelMappingSet` / `ChannelMappingField` / `ChannelMappingUse`).
 *
 * Rules this module enforces:
 *   - An ACTIVE or RETIRED version never changes. Only a DRAFT is edited; `newVersionFrom` makes one from any version.
 *   - Activating a version retires the form's ACTIVE one in the same transaction (the database allows one ACTIVE).
 *   - Activation is refused while a column the channel REQUIRES is unmapped or ignored.
 *   - A file finds its version by template id + column fingerprint; an unknown form gets a new DRAFT built by the
 *     rules, with the Owner's decisions from the nearest earlier version carried over.
 */

export type DraftRow = Omit<MappingFieldRow, 'id'>
type SetRecord = Prisma.ChannelMappingSetGetPayload<{ include: { fields: true } }>
type FieldRecord = SetRecord['fields'][number]

/** Rows whose meaning the readers depend on: never re-decided on the screen. */
const LOCKED_TARGETS = new Set(['identity', 'productType', 'recordAction'])
const STATUS_RANK: Record<string, number> = { ACTIVE: 3, DRAFT: 2, RETIRED: 1 }

export class MappingError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function fieldRowOf(f: FieldRecord): MappingFieldRow {
  return {
    id: f.id, channelKey: f.channelKey, columnKey: f.columnKey, label: f.label, aliases: f.aliases, productTypes: f.productTypes,
    requirement: f.requirement as MappingFieldRow['requirement'], templateRequirement: f.templateRequirement,
    targetKind: f.targetKind as MappingFieldRow['targetKind'], targetKey: f.targetKey, transform: (f.transform ?? []) as MappingTransform[],
    direction: f.direction as MappingFieldRow['direction'], state: f.state as MappingFieldRow['state'], reason: f.reason,
    decidedBy: f.decidedBy as MappingFieldRow['decidedBy'], sortOrder: f.sortOrder,
  }
}

type SummaryInput = Omit<SetRecord, 'fields'> & { fields: Pick<FieldRecord, 'state' | 'requirement'>[] }
export function summaryOf(s: SummaryInput): MappingSetSummary {
  return {
    id: s.id, channel: s.channel as MappingSetSummary['channel'], marketplace: s.marketplace, formKind: s.formKind as MappingSetSummary['formKind'], formKey: s.formKey,
    templateIdentifier: s.templateIdentifier, templateVersion: s.templateVersion, language: s.language, layout: s.layout as unknown as MappingSetSummary['layout'],
    keyFingerprint: s.keyFingerprint, version: s.version, status: s.status as MappingSetSummary['status'], basedOnId: s.basedOnId,
    source: s.source as MappingSetSummary['source'], notes: s.notes, createdAt: s.createdAt.toISOString(),
    activatedAt: s.activatedAt?.toISOString() ?? null, retiredAt: s.retiredAt?.toISOString() ?? null,
    counts: mappingCounts(s.fields.map(f => ({ state: f.state as MappingFieldRow['state'], requirement: f.requirement as MappingFieldRow['requirement'] }))),
  }
}

export const detailOf = (s: SetRecord): MappingSetDetail => ({ ...summaryOf(s), fields: s.fields.map(fieldRowOf).sort((a, b) => a.sortOrder - b.sortOrder) })

const formWhere = (form: Pick<MappingForm, 'channel' | 'marketplace' | 'formKind' | 'formKey'>) =>
  ({ channel: form.channel, marketplace: form.marketplace, formKind: form.formKind, formKey: form.formKey })

/** The version a file of this form is read with: same columns (and the same template id when both have one). */
export async function findSetForForm(form: MappingForm): Promise<SetRecord | null> {
  const versions = await prisma.channelMappingSet.findMany({ where: formWhere(form), select: { id: true, status: true, version: true, keyFingerprint: true, templateIdentifier: true } })
  const matching = versions.filter(s => s.keyFingerprint === form.keyFingerprint && (!form.templateIdentifier || !s.templateIdentifier || s.templateIdentifier === form.templateIdentifier))
  const best = matching.sort((a, b) => (STATUS_RANK[b.status] - STATUS_RANK[a.status]) || (b.version - a.version))[0]
  return best ? prisma.channelMappingSet.findUnique({ where: { id: best.id }, include: { fields: true } }) : null
}

/** The version to carry the Owner's decisions from: the form's ACTIVE one, its latest one, else the same form's ACTIVE one in another market. */
async function baseFor(form: MappingForm): Promise<SetRecord | null> {
  const same = await prisma.channelMappingSet.findMany({ where: formWhere(form), orderBy: { version: 'desc' }, select: { id: true, status: true } })
  const pick = same.find(s => s.status === 'ACTIVE') ?? same[0]
  const other = pick ? null : await prisma.channelMappingSet.findFirst({ where: { channel: form.channel, formKind: form.formKind, formKey: form.formKey, status: 'ACTIVE', marketplace: { not: form.marketplace } }, orderBy: { activatedAt: 'desc' }, select: { id: true } })
  const id = pick?.id ?? other?.id
  return id ? prisma.channelMappingSet.findUnique({ where: { id }, include: { fields: true } }) : null
}

/** A key with its language tag made neutral, so a decision made on the IT template reaches the DE one. */
const neutralKey = (key: string, language: string | null) => language ? key.split(`[language_tag=${language}]`).join('[language_tag=*]') : key

/** Pure: lay the Owner's decisions from an earlier version over fresh rule rows (matched by column). */
export function carryOwnerDecisions(rows: DraftRow[], earlier: readonly MappingFieldRow[], languages: { from: string | null; to: string | null }): DraftRow[] {
  const owner = new Map(earlier.filter(f => f.decidedBy === 'owner').map(f => [neutralKey(f.channelKey, languages.from), f]))
  return rows.map(row => {
    const decided = owner.get(neutralKey(row.channelKey, languages.to))
    if (!decided || LOCKED_TARGETS.has(row.targetKind)) return row
    return { ...row, state: decided.state, targetKind: decided.targetKind, targetKey: decided.targetKey, transform: decided.transform, direction: decided.direction, reason: decided.reason, decidedBy: 'owner' }
  })
}

const fieldData = (row: DraftRow) => ({
  channelKey: row.channelKey, columnKey: row.columnKey, label: row.label, aliases: row.aliases, productTypes: row.productTypes,
  requirement: row.requirement, templateRequirement: row.templateRequirement, targetKind: row.targetKind, targetKey: row.targetKey,
  transform: row.transform as unknown as Prisma.InputJsonValue, direction: row.direction, state: row.state, reason: row.reason,
  decidedBy: row.decidedBy, sortOrder: row.sortOrder,
})

async function createVersion(form: MappingForm, rows: DraftRow[], meta: { source: 'FILE' | 'COPY' | 'EDIT'; basedOnId: string | null; createdBy?: string | null; notes?: string | null }) {
  return prisma.$transaction(async tx => {
    const last = await tx.channelMappingSet.findFirst({ where: formWhere(form), orderBy: { version: 'desc' }, select: { version: true } })
    return tx.channelMappingSet.create({
      data: {
        ...formWhere(form), version: (last?.version ?? 0) + 1, status: 'DRAFT', templateIdentifier: form.templateIdentifier, templateVersion: form.templateVersion,
        language: form.language, layout: form.layout ? (form.layout as unknown as Prisma.InputJsonValue) : Prisma.JsonNull, keyFingerprint: form.keyFingerprint,
        basedOnId: meta.basedOnId, source: meta.source, createdBy: meta.createdBy ?? null, notes: meta.notes ?? null,
        fields: { create: rows.map(fieldData) },
      },
      include: { fields: true },
    })
  })
}

const isUniqueConflict = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'

/**
 * The version a file is read with. An unknown form gets a new DRAFT: the rules' rows (`buildRows`), with the
 * Owner's decisions of the nearest earlier version laid over them. Two readers racing on the same new form
 * end on the same version (the loser re-reads the winner's).
 */
export async function ensureSetForForm(form: MappingForm, buildRows: () => DraftRow[], opts: { createdBy?: string | null } = {}): Promise<{ set: SetRecord; created: boolean }> {
  const found = await findSetForForm(form)
  if (found) return { set: found, created: false }
  const base = await baseFor(form)
  const rows = base ? carryOwnerDecisions(buildRows(), base.fields.map(fieldRowOf), { from: base.language, to: form.language }) : buildRows()
  const why = base ? `New ${form.templateVersion ? `template version ${form.templateVersion}` : 'column set'}; your decisions from v${base.version}${base.marketplace !== form.marketplace ? ` (${base.marketplace})` : ''} were carried over.` : 'First file of this form.'
  try {
    return { set: await createVersion(form, rows, { source: 'FILE', basedOnId: base?.id ?? null, createdBy: opts.createdBy, notes: why }), created: true }
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const winner = await findSetForForm(form)
    if (!winner) throw error
    return { set: winner, created: false }
  }
}

export async function listSets(filter: { channel?: string; marketplace?: string } = {}): Promise<MappingSetSummary[]> {
  const sets = await prisma.channelMappingSet.findMany({
    where: { ...(filter.channel ? { channel: filter.channel } : {}), ...(filter.marketplace ? { marketplace: filter.marketplace } : {}) },
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { formKey: 'asc' }, { version: 'desc' }],
    include: { fields: { select: { state: true, requirement: true } } },
  })
  return sets.map(summaryOf)
}

async function loadSet(id: string): Promise<SetRecord> {
  const set = await prisma.channelMappingSet.findUnique({ where: { id }, include: { fields: true } })
  if (!set) throw new MappingError('This mapping version does not exist', 404)
  return set
}

export async function getSet(id: string): Promise<MappingSetDetail> { return detailOf(await loadSet(id)) }

export interface FieldDecision {
  state: MappingFieldRow['state']
  targetKind?: MappingFieldRow['targetKind']
  targetKey?: string | null
  reason?: string | null
  direction?: MappingFieldRow['direction']
  transform?: MappingTransform[]
}

/** The Owner's decision for one column of a DRAFT. */
export async function decideField(setId: string, channelKey: string, decision: FieldDecision): Promise<MappingSetDetail> {
  const set = await loadSet(setId)
  if (set.status !== 'DRAFT') throw new MappingError(`Version ${set.version} is ${set.status.toLowerCase()} and cannot change. Make a new version from it first.`, 409)
  const field = set.fields.find(f => f.channelKey === channelKey)
  if (!field) throw new MappingError(`Version ${set.version} has no column ${channelKey}`, 404)
  if (LOCKED_TARGETS.has(field.targetKind)) throw new MappingError('The SKU, product-type and action columns are read by every import; their meaning cannot change.')
  if (!MAPPING_FIELD_STATES.includes(decision.state)) throw new MappingError('Choose mapped, ignored, managed or unmapped')
  const targetKind = decision.targetKind ?? field.targetKind
  if (!MAPPING_TARGET_KINDS.includes(targetKind as MappingFieldRow['targetKind'])) throw new MappingError('Unknown target')
  const direction = decision.direction ?? field.direction
  if (!MAPPING_DIRECTIONS.includes(direction as MappingFieldRow['direction'])) throw new MappingError('Choose in, out or both')
  const reason = decision.reason?.trim() || null
  if ((decision.state === 'ignored' || decision.state === 'managed') && !reason) throw new MappingError('Say why this column is not mapped: the reason is shown on every import that skips it.')
  const targetKey = decision.targetKey === undefined ? field.targetKey : decision.targetKey
  if (decision.state === 'mapped' && ['channelField', 'itemSpecific'].includes(targetKind) && !targetKey) throw new MappingError('Choose the field this column maps to')
  await prisma.channelMappingField.update({
    where: { id: field.id },
    data: { state: decision.state, targetKind, targetKey: decision.state === 'mapped' ? targetKey : null, reason, direction, decidedBy: 'owner',
      ...(decision.transform ? { transform: decision.transform as unknown as Prisma.InputJsonValue } : {}) },
  })
  return getSet(setId)
}

/** A new DRAFT copied from any version (the way to change an ACTIVE mapping, or to roll back to an old one). */
export async function newVersionFrom(setId: string, createdBy?: string | null): Promise<MappingSetDetail> {
  const set = await loadSet(setId)
  const form: MappingForm = { channel: set.channel as MappingForm['channel'], marketplace: set.marketplace, formKind: set.formKind as MappingForm['formKind'], formKey: set.formKey,
    templateIdentifier: set.templateIdentifier, templateVersion: set.templateVersion, language: set.language, layout: set.layout as unknown as MappingForm['layout'], keyFingerprint: set.keyFingerprint }
  const rows = set.fields.map(fieldRowOf).map(({ id: _id, ...row }) => row)
  return detailOf(await createVersion(form, rows, { source: 'EDIT', basedOnId: set.id, createdBy, notes: `Copied from v${set.version}.` }))
}

/** Activate a DRAFT (or re-activate a RETIRED version): the form's ACTIVE version is retired in the same transaction. */
export async function activateSet(setId: string, activatedBy?: string | null): Promise<MappingSetDetail> {
  const set = await loadSet(setId)
  if (set.status === 'ACTIVE') return detailOf(set)
  const blocker = activationBlocker(set.fields.map(fieldRowOf))
  if (blocker) throw new MappingError(blocker, 409)
  const now = new Date()
  await prisma.$transaction(async tx => {
    await tx.channelMappingSet.updateMany({ where: { ...formWhere(set as unknown as MappingForm), status: 'ACTIVE' }, data: { status: 'RETIRED', retiredAt: now } })
    await tx.channelMappingSet.update({ where: { id: set.id }, data: { status: 'ACTIVE', activatedAt: now, activatedBy: activatedBy ?? null, retiredAt: null } })
  })
  return getSet(setId)
}

export async function retireSet(setId: string): Promise<MappingSetDetail> {
  const set = await loadSet(setId)
  if (set.status !== 'RETIRED') await prisma.channelMappingSet.update({ where: { id: set.id }, data: { status: 'RETIRED', retiredAt: new Date() } })
  return getSet(setId)
}

export async function diffSets(olderId: string, newerId: string): Promise<MappingDiff> {
  const [older, newer] = await Promise.all([loadSet(olderId), loadSet(newerId)])
  return diffMappingFields(older.fields.map(fieldRowOf), newer.fields.map(fieldRowOf))
}

/** Which version an import, export or push used. Never blocks the caller: a failed note is logged, not thrown. */
export async function recordUse(setId: string, action: 'IMPORT' | 'EXPORT' | 'PUSH', reference: string | null, detail: Record<string, unknown> = {}) {
  try {
    await prisma.channelMappingUse.create({ data: { setId, action, reference, detail: detail as Prisma.InputJsonValue } })
  } catch (error) {
    console.warn('[channel-mapping] could not record a mapping use', { setId, action, error: error instanceof Error ? error.message : String(error) })
  }
}

export async function listUses(setId: string, take = 50) {
  return prisma.channelMappingUse.findMany({ where: { setId }, orderBy: { createdAt: 'desc' }, take })
}

/**
 * A DRAFT learns how the Owner's files spell its dictionary columns: a later file of the same form may use a label the
 * first one never showed (`XXS (xx_s)` for trousers). Only new facts are added — a spelling the version already records
 * wins — and an ACTIVE or RETIRED version never changes. Returns the columns that learned something.
 */
export async function learnSpellings(setId: string, learned: ReadonlyMap<string, Extract<MappingTransform, { op: 'dictionary' }>>): Promise<string[]> {
  const set = await prisma.channelMappingSet.findUnique({ where: { id: setId }, include: { fields: true } })
  if (!set || set.status !== 'DRAFT') return []
  const changed: string[] = []
  for (const field of set.fields) {
    const next = learned.get(field.channelKey)
    if (!next) continue
    const transform = (field.transform ?? []) as MappingTransform[]
    const at = transform.findIndex(t => t.op === 'dictionary')
    if (at < 0) continue
    const current = transform[at] as Extract<MappingTransform, { op: 'dictionary' }>
    const prefer = { ...(next.prefer ?? {}), ...(current.prefer ?? {}) }
    const write = current.write ?? next.write
    if (JSON.stringify(prefer) === JSON.stringify(current.prefer ?? {}) && write === current.write) continue
    const merged: Extract<MappingTransform, { op: 'dictionary' }> = { op: 'dictionary', ...(write ? { write } : {}), ...(Object.keys(prefer).length ? { prefer } : {}) }
    await prisma.channelMappingField.update({ where: { id: field.id }, data: { transform: transform.map((t, i) => i === at ? merged : t) as unknown as Prisma.InputJsonValue } })
    changed.push(field.channelKey)
  }
  return changed
}
