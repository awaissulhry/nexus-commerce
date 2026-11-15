import { ApiError } from '../../../core/errors'
import { DUPLICATE_LIMITS, likelihoodOf, materialKeys, materialReasons, partyKeys, partyReasons, type DuplicateRecordType, type PartyProbe, type ReasonFound } from '@nexus/factory-domain/imports/duplicates/rules'
import { MATERIAL_IMPORTER_KEY } from '@nexus/factory-domain/product/materials/importer'
import { PARTY_IMPORTER_KEY } from '@nexus/factory-domain/parties/importer'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { getImport } from '../jobs'
import { materialCandidates, materialIndex, partyCandidates, partyIndex, type Candidate } from './candidates'

/**
 * Likely duplicates on create, in an import's check and as a list (B-W2b-427; PLT-178). Read only; every record named is
 * one the caller may see (the record type's view permission, scopeWhere). The candidates' `createdAt` is internal (the
 * pair's order) and is not sent with a check.
 */

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

const shown = ({ createdAt: _createdAt, ...candidate }: Candidate) => ({ ...candidate, roles: [...candidate.roles], reasons: candidate.reasons.map((reason) => ({ ...reason })) })

export interface PartyCheck {
  readonly exceptId?: string | undefined
  readonly legalName?: string | null | undefined
  readonly tradeName?: string | null | undefined
  readonly country?: string | null | undefined
  readonly vatNumber?: string | null | undefined
  readonly fiscalCode?: string | null | undefined
  readonly emails?: readonly string[] | undefined
  readonly website?: string | null | undefined
}

/** POST /duplicates/parties/check: the parties a new (or edited) party looks like, the likeliest first. */
export async function checkParty(caller: CommandCaller, body: PartyCheck) {
  const actor = actorOf(contextOf(caller))
  const probe = { legalName: body.legalName, tradeName: body.tradeName, vatNumbers: [body.vatNumber], fiscalCodes: [body.fiscalCode], emails: body.emails ?? [], website: body.website, country: body.country }
  const found = await caller.withClient((client) => partyCandidates(client, actor, probe, new Set(body.exceptId ? [body.exceptId] : [])))
  return { candidates: found.map(shown) }
}

export interface MaterialCheck {
  readonly exceptId?: string | undefined
  readonly code?: string | null | undefined
  readonly name?: string | null | undefined
  readonly supplierId?: string | null | undefined
  readonly supplierArticleCode?: string | null | undefined
}

/** POST /duplicates/materials/check: the materials a new (or edited) material looks like. */
export async function checkMaterial(caller: CommandCaller, body: MaterialCheck) {
  const actor = actorOf(contextOf(caller))
  const found = await caller.withClient((client) => materialCandidates(client, actor, body, new Set(body.exceptId ? [body.exceptId] : [])))
  return { candidates: found.map(shown) }
}

/** GET /duplicates?recordType=: the pairs of records the caller may see that look alike (not archived), the likeliest first. */
export async function scanDuplicates(caller: CommandCaller, query: { readonly recordType: DuplicateRecordType; readonly companyId?: string | undefined }) {
  const actor = actorOf(contextOf(caller))
  const options = { archived: false, companyId: query.companyId }
  const { found, compared } = await caller.withClient(async (client) => {
    const index = query.recordType === 'PARTY' ? await partyIndex(client, actor, options) : await materialIndex(client, actor, options)
    return { found: index.pairs(DUPLICATE_LIMITS.pairs), compared: index.size }
  })
  const side = (view: (typeof found.pairs)[number]['a']) => ({ ...view, roles: [...view.roles] })
  return {
    recordType: query.recordType,
    pairs: found.pairs.map((pair) => ({ key: `${pair.a.id}:${pair.b.id}`, a: side(pair.a), b: side(pair.b), likelihood: pair.likelihood, reasons: pair.reasons.map((reason) => ({ ...reason })) })),
    more: found.more,
    compared,
  }
}

type ImportDuplicateRow = {
  rowNumber: number
  key: string | null
  name: string | null
  recordId: string | null
  candidates: ReturnType<typeof shown>[]
  sameSheet: { rowNumber: number; key: string | null; recordId: string | null; likelihood: 'HIGH' | 'MEDIUM'; reasons: ReasonFound[] }[]
}

const IMPORT_TYPES: Readonly<Record<string, DuplicateRecordType>> = { [PARTY_IMPORTER_KEY]: 'PARTY', [MATERIAL_IMPORTER_KEY]: 'MATERIAL' }

type Values = Readonly<Record<string, unknown>>
const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** A planned row's key as the person reads it: the key columns' values (stored as a JSON list) joined. */
function keyOf(key: string | null): string | null {
  if (!key) return null
  try {
    const values = JSON.parse(key) as unknown
    if (Array.isArray(values)) return values.map((value) => (value === null || value === undefined ? '' : String(value))).join(' · ')
  } catch {
    // Not a JSON list: as it is.
  }
  return key
}

const partyProbeOf = (values: Values): PartyProbe & { country: string | null } => ({
  legalName: textOf(values.legalName),
  tradeName: textOf(values.tradeName),
  vatNumbers: [textOf(values.vatNumber)],
  fiscalCodes: [textOf(values.fiscalCode)],
  emails: [textOf(values.contactEmail)],
  country: textOf(values.country),
})

const materialProbeOf = (values: Values) => ({ code: textOf(values.code), name: textOf(values.name), supplierArticleCode: textOf(values.supplierArticleCode) })

/**
 * GET /imports/:importId/duplicates: the import's new rows (planned CREATE rows; after the apply, the records they made)
 * that look like a record already there, or like an earlier row of the same sheet. Only importers of parties and
 * materials are checked; at most the first 500 new rows, in sheet order.
 */
export async function importDuplicates(caller: CommandCaller, importId: string) {
  const actor = actorOf(contextOf(caller))
  const job = await getImport(caller, importId)
  const recordType = IMPORT_TYPES[job.importerKey] ?? null
  if (!recordType) return { jobId: job.id, importerKey: job.importerKey, supported: false, recordType: null, checked: 0, more: false, rows: [] as ImportDuplicateRow[] }
  const { rows, index, more, archived } = await caller.withClient(async (client) => {
    const planned = await client.importRow.findMany({
      where: { jobId: job.id, action: 'CREATE' },
      select: { rowNumber: true, key: true, recordId: true, after: true },
      orderBy: { rowNumber: 'asc' },
      take: DUPLICATE_LIMITS.importRows + 1,
    })
    const options = { archived: true }
    const ids = planned.map((row) => row.recordId).filter((id): id is string => id !== null)
    // A record the import made that is archived since (merged, or archived by hand) is no longer offered.
    const gone =
      ids.length === 0
        ? []
        : recordType === 'PARTY'
          ? await client.party.findMany({ where: { id: { in: ids }, status: 'ARCHIVED' }, select: { id: true } })
          : await client.item.findMany({ where: { id: { in: ids }, status: 'ARCHIVED' }, select: { id: true } })
    return {
      rows: planned.slice(0, DUPLICATE_LIMITS.importRows),
      more: planned.length > DUPLICATE_LIMITS.importRows,
      archived: new Set(gone.map((row) => row.id)),
      index: recordType === 'PARTY' ? await partyIndex(client, actor, options) : await materialIndex(client, actor, options),
    }
  })
  // The records this import made are compared as rows of the sheet, never as records already there.
  const made = new Set(rows.map((row) => row.recordId).filter((id): id is string => id !== null))
  const judged = rows.map((row) => {
    const values = (row.after ?? {}) as Values
    if (recordType === 'PARTY') {
      const keys = partyKeys(partyProbeOf(values))
      return { row, name: textOf(values.tradeName) ?? textOf(values.legalName), keys, candidates: (index as Awaited<ReturnType<typeof partyIndex>>).candidatesFor(keys, made) }
    }
    const keys = materialKeys(materialProbeOf(values))
    return { row, name: textOf(values.name), keys, candidates: (index as Awaited<ReturnType<typeof materialIndex>>).candidatesFor(keys, made) }
  })
  const reasonsBetween = (a: (typeof judged)[number], b: (typeof judged)[number]): ReasonFound[] =>
    recordType === 'PARTY' ? partyReasons(a.keys as ReturnType<typeof partyKeys>, b.keys as ReturnType<typeof partyKeys>) : materialReasons(a.keys as ReturnType<typeof materialKeys>, b.keys as ReturnType<typeof materialKeys>)
  const answer = judged.flatMap((entry, at) => {
    if (entry.row.recordId !== null && archived.has(entry.row.recordId)) return []
    const sameSheet = judged
      .slice(0, at)
      .filter((earlier) => earlier.row.recordId === null || !archived.has(earlier.row.recordId))
      .flatMap((earlier) => {
        const reasons = reasonsBetween(entry, earlier)
        return reasons.length > 0 ? [{ rowNumber: earlier.row.rowNumber, key: keyOf(earlier.row.key), recordId: earlier.row.recordId, likelihood: likelihoodOf(reasons), reasons }] : []
      })
      .slice(0, DUPLICATE_LIMITS.candidates)
    if (entry.candidates.length === 0 && sameSheet.length === 0) return []
    return [{ rowNumber: entry.row.rowNumber, key: keyOf(entry.row.key), name: entry.name, recordId: entry.row.recordId, candidates: entry.candidates.map(shown), sameSheet }]
  })
  return { jobId: job.id, importerKey: job.importerKey, supported: true, recordType: recordType as DuplicateRecordType | null, checked: rows.length, more, rows: answer as ImportDuplicateRow[] }
}
