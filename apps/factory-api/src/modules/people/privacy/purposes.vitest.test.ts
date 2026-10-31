import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PEOPLE_DATA_PURPOSES, PURPOSE_RULES, gateFor, isPeopleDataPurpose } from '@nexus/factory-domain/people/privacy/purposes'
// The ownership files and their rules are no package export: a test reads them where they live (as the PG tests read the seeds).
import { FLOOR_PURPOSES, PERSONAL_PURPOSES, readOwnershipFolder } from '../../../../../../packages/factory-db/src/ownership'

/**
 * The purpose tags the API checks (factory-domain people/privacy/purposes, B-W2b-27; PLT-209, PLT-207) are the purposes
 * the ownership files tag the personal columns with (packages/factory-db ownership/*.json `personal.columns`, B-W2b-06):
 * the same six, the same floor purposes, and no column tagged with a purpose the API does not know. A schema step that
 * tags a column with a new purpose fails here until the API knows the purpose and the gate it needs.
 */

const OWNERSHIP = fileURLToPath(new URL('../../../../../../packages/factory-db/ownership', import.meta.url))

type Personal = { readonly subject: string; readonly columns: Readonly<Record<string, readonly string[]>> }

function personalEntries(): { file: string; model: string; personal: Personal }[] {
  return readOwnershipFolder(OWNERSHIP).flatMap(({ file, data }) =>
    Object.entries((data as { models?: Record<string, { personal?: Personal }> }).models ?? {}).flatMap(([model, entry]) => (entry.personal ? [{ file, model, personal: entry.personal }] : [])),
  )
}

describe('purpose tags on worker data (PLT-209, PLT-207)', () => {
  it('the API knows the same six purposes as the ownership rules, and the same floor purposes', () => {
    expect([...PEOPLE_DATA_PURPOSES].sort()).toEqual(Object.keys(PERSONAL_PURPOSES).sort())
    expect(PEOPLE_DATA_PURPOSES.filter((purpose) => PURPOSE_RULES[purpose].floor).sort()).toEqual([...FLOOR_PURPOSES].sort())
  })

  it('every personal column of every ownership file carries purposes the API knows', () => {
    const entries = personalEntries()
    expect(entries.length).toBeGreaterThan(10)
    const unknown = entries.flatMap(({ file, model, personal }) =>
      Object.entries(personal.columns).flatMap(([column, tags]) => tags.filter((tag) => !isPeopleDataPurpose(tag)).map((tag) => `${file}: ${model}.${column}: ${tag}`)),
    )
    expect(unknown).toEqual([])
  })

  it('the attendance and one-person-figures tables are behind their legal gate', () => {
    const gated = new Map<string, Set<string>>()
    for (const { model, personal } of personalEntries()) {
      for (const tags of Object.values(personal.columns)) {
        for (const tag of tags) {
          const gate = isPeopleDataPurpose(tag) ? gateFor(tag) : null
          if (gate) gated.set(gate, (gated.get(gate) ?? new Set()).add(model))
        }
      }
    }
    expect([...(gated.get('ATTENDANCE') ?? [])]).toEqual(expect.arrayContaining(['ClockEvent', 'AttendanceDay', 'AbsenceEntry']))
    expect([...(gated.get('PERFORMANCE') ?? [])]).toEqual(expect.arrayContaining(['LabourEdit', 'OffStandardEntry']))
  })
})
