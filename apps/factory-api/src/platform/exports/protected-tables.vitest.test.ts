import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Protected safety data never leaves through an export, a report or the search index (B-W2b-91; GDPR art. 9; D.Lgs. 81/2008
 * arts. 25, 41; the lead's rule for the protected schema: "no export, no search index"): no export source, no report of the
 * pack and no search indexer reads a health visit, a fitness judgement, the view log of protected records, a person
 * involved in an incident or an INAIL filing (factory-db health.prisma). The database refuses a search entry of one and
 * keeps their files to the office (…_protected_safety_w2b_guards); this test keeps the code that writes exports honest. An
 * anonymised incident list reads Incident only, a chemical register Chemical and SafetyDataSheet: neither is listed here.
 * A step the Owner allows to export one of these changes this test on purpose, with the ProtectedView row the export writes.
 */

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const FOLDERS = ['platform/exports/sources', 'platform/search/indexers', 'modules/insights/reports']
// W2b-5 (B-W2b-291; SAL-415, GDPR art. 9): the injury of a product-safety report, kept apart from the report.
const PROTECTED = ['HealthVisit', 'FitnessJudgement', 'ProtectedView', 'IncidentPerson', 'InailFiling', 'ProductSafetyInjury'] as const

const delegate = (model: string): string => model[0]!.toLowerCase() + model.slice(1)
/** A Prisma delegate (`tx.healthVisit.`) or the table in SQL text (`"HealthVisit"`). */
const readsOf = (text: string): string[] =>
  PROTECTED.filter((model) => new RegExp(`\\.${delegate(model)}\\b`).test(text) || new RegExp(`"${model}"`).test(text))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.[cm]?tsx?$/.test(name) && !/\.test\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

describe('protected safety data stays out of exports, reports and search', () => {
  it('no export source, report or search indexer reads a protected table', () => {
    const files = FOLDERS.flatMap((folder) => sourceFiles(join(SRC, folder)))
    // Not vacuous: each folder holds its sources.
    for (const folder of FOLDERS) expect(files.some((file) => relative(SRC, file).startsWith(folder)), folder).toBe(true)
    const found = files.flatMap((file) => readsOf(readFileSync(file, 'utf8')).map((model) => `${relative(SRC, file)} reads ${model}`))
    expect(found).toEqual([])
  })

  it('would see a delegate or a table name', () => {
    expect(readsOf('await tx.fitnessJudgement.findMany({})')).toEqual(['FitnessJudgement'])
    expect(readsOf('SELECT * FROM "IncidentPerson" p')).toEqual(['IncidentPerson'])
    expect(readsOf('await tx.productSafetyInjury.findMany({})')).toEqual(['ProductSafetyInjury'])
    expect(readsOf('await tx.incident.findMany({}); await tx.chemical.findMany({})')).toEqual([])
  })
})
