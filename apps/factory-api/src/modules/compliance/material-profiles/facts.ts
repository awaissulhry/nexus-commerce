import type { StyleUse } from '@nexus/factory-domain/compliance/substances/evaluate'
import { innocuousness, profileGaps, type EvidenceFile, type Innocuousness, type ResultFact } from '@nexus/factory-domain/compliance/material-profiles/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { Reader } from '../substances/store'

/**
 * What a material's compliance profile lacks beyond the rules (B-W2b-256; PRD-303, PRD-314), read for the evaluator
 * (modules/compliance/substances/evaluation.ts folds the gaps into the state it writes, so a material is COMPLETE only
 * with its composition, a leather's tannage and a PPE material's innocuousness evidence in place): the profile's
 * confirmations, the newest current lab results of the innocuousness tests of its lots (Cr VI, azo, nickel) and the
 * profile's evidence files (record type "MaterialComplianceProfile", record id = the item's id: one profile per material).
 * One query after another; nothing written here.
 */

export const PROFILE_RECORD_TYPE = 'MaterialComplianceProfile'

export interface ProfileFacts {
  readonly compositionConfirmed: boolean
  readonly tannageConfirmed: boolean
  readonly innocuousness: Innocuousness
  readonly files: readonly EvidenceFile[]
  readonly gaps: readonly string[]
}

const day = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

/** The profile's evidence files in force (available, the current version, not deleted), per material. */
export async function evidenceFilesOf(db: Reader, itemIds: readonly string[]): Promise<Map<string, EvidenceFile[]>> {
  const out = new Map<string, EvidenceFile[]>(itemIds.map((id) => [id, []]))
  if (itemIds.length === 0) return out
  const rows = await db.storedFile.findMany({
    where: { recordType: PROFILE_RECORD_TYPE, recordId: { in: [...itemIds] }, status: 'AVAILABLE', supersededAt: null },
    select: { id: true, recordId: true, originalName: true, category: true, expiresOn: true },
    orderBy: [{ createdAt: 'asc' }],
  })
  for (const row of rows) out.get(row.recordId)?.push({ fileId: row.id, name: row.originalName, category: row.category, expiresOn: row.expiresOn ? day(row.expiresOn) : null })
  return out
}

/** The current (not superseded) results of the innocuousness tests per material, any lot. */
async function innocuousnessResultsOf(db: Reader, itemIds: readonly string[]): Promise<Map<string, ResultFact[]>> {
  const out = new Map<string, ResultFact[]>(itemIds.map((id) => [id, []]))
  if (itemIds.length === 0) return out
  const rows = await db.labResult.findMany({
    where: { itemId: { in: [...itemIds] }, test: { in: ['CR_VI', 'AZO', 'NICKEL'] }, supersededBy: { none: {} } },
    select: { id: true, itemId: true, lotId: true, test: true, verdict: true, testedOn: true },
  })
  for (const row of rows) {
    if (row.verdict !== 'PASS' && row.verdict !== 'FAIL') continue
    out.get(row.itemId)?.push({ resultId: row.id, lotId: row.lotId, test: row.test, verdict: row.verdict, testedOn: day(row.testedOn) })
  }
  return out
}

/** Per material: its confirmations, its innocuousness evidence (required when a PPE style uses it) and the gaps both leave. */
export async function profileFactsOf(db: Reader, materials: readonly { readonly id: string; readonly kind: string }[], uses: ReadonlyMap<string, readonly StyleUse[]>, today: BusinessDate): Promise<Map<string, ProfileFacts>> {
  const ids = materials.map((material) => material.id)
  const out = new Map<string, ProfileFacts>()
  if (ids.length === 0) return out
  const confirmations = new Map(
    (await db.materialComplianceProfile.findMany({ where: { id: { in: ids } }, select: { id: true, compositionConfirmedAt: true, tannageConfirmedAt: true } })).map((row) => [row.id, row]),
  )
  const results = await innocuousnessResultsOf(db, ids)
  const files = await evidenceFilesOf(db, ids)
  for (const material of materials) {
    const saved = confirmations.get(material.id)
    const ppeStyles = (uses.get(material.id) ?? []).filter((use) => use.ppeCategory !== 'NOT_PPE').map((use) => use.code)
    const evidence = innocuousness({ kind: material.kind, ppeStyles, results: results.get(material.id) ?? [], files: files.get(material.id) ?? [], today })
    const compositionConfirmed = Boolean(saved?.compositionConfirmedAt)
    const tannageConfirmed = Boolean(saved?.tannageConfirmedAt)
    out.set(material.id, {
      compositionConfirmed,
      tannageConfirmed,
      innocuousness: evidence,
      files: files.get(material.id) ?? [],
      gaps: profileGaps({ kind: material.kind, compositionConfirmed, tannageConfirmed, innocuousness: evidence }),
    })
  }
  return out
}
