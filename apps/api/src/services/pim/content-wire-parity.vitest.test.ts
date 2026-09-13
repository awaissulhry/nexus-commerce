/**
 * R-LX-15 — ONE content wire, and the two surfaces may not drift apart.
 *
 * `sheet-rows.service.ts` (the catalogue wire, `GET /api/products/sheet`) and
 * `studio-sheet.service.ts` (the studio wire) both describe a resolved content cell.
 * They disagreed: the catalogue wire emitted `requestedLocale` / `effectiveLocale` /
 * `translationState` / `needsTranslation` and the studio wire omitted all four
 * (`StudioCellValue extends Omit<SheetCellValue, …>`), because LX.12's §3 fields
 * replaced them — so the same cell described itself with two vocabularies depending on
 * which route served it.
 *
 * The §3 fields now travel on BOTH, and this test is what keeps that true: the members
 * are DERIVED from the two interfaces (a hardcoded list would go stale in hours), and
 * the legacy set is pinned so it can only shrink. Deleting it is a per-consumer
 * follow-up; the consumers are named in `sheet-rows.service.ts`'s own comment.
 *
 * Run: npx vitest run src/services/pim/content-wire-parity.vitest.test.ts
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import ts from 'typescript'

const CONTRACT = ['tier', 'language', 'requested', 'provenance', 'translation'] as const
const LEGACY = ['requestedLocale', 'effectiveLocale', 'translationState', 'needsTranslation'] as const

function members(file: string, name: string): string[] {
  const path = new URL(file, import.meta.url)
  const source = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name)
  expect(declaration, `${name} not found in ${file}`).toBeDefined()
  return declaration!.members.filter(ts.isPropertySignature).map(member => member.name.getText(source))
}

function omitted(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name)!
  const heritage = declaration.heritageClauses?.flatMap(clause => clause.types.map(type => type.getText(source))).join(' ') ?? ''
  return [...heritage.matchAll(/'([A-Za-z]+)'/g)].map(match => match[1])
}

it('both wires carry the §3 contract fields', () => {
  const catalogue = members('./sheet-rows.service.ts', 'SheetCellValue')
  const studio = members('./studio-sheet.service.ts', 'StudioCellValue')
  for (const field of CONTRACT) {
    expect(catalogue, `catalogue wire is missing §3 ${field}`).toContain(field)
    expect(studio, `studio wire is missing §3 ${field}`).toContain(field)
  }
  // POSITIVE CONTROL for the instrument: it really is reading the two interfaces.
  expect(catalogue).toContain('value')
  expect(studio.length).toBeGreaterThan(CONTRACT.length)
})

it('the legacy vocabulary exists on ONE wire only, and cannot grow', () => {
  const catalogue = members('./sheet-rows.service.ts', 'SheetCellValue')
  const studio = members('./studio-sheet.service.ts', 'StudioCellValue')
  // The catalogue wire still carries the four, for the consumers named in its comment.
  expect(LEGACY.filter(field => catalogue.includes(field))).toEqual([...LEGACY])
  // The studio wire carries none of them — and says so by OMITTING them explicitly,
  // which is the declaration this test reads rather than inferring absence.
  expect(LEGACY.filter(field => studio.includes(field))).toEqual([])
  expect(omitted('./studio-sheet.service.ts', 'StudioCellValue').sort()).toEqual([...LEGACY].sort())
  // Nothing beyond those four may be legacy: a fifth locale-ish field on one wire and
  // not the other is the drift this test exists to catch.
  const localeish = (names: string[]) => names.filter(name => /locale|translation|needs/i.test(name)).sort()
  expect(localeish(catalogue)).toEqual(['effectiveLocale', 'needsTranslation', 'requestedLocale', 'translation', 'translationState'])
  expect(localeish(studio)).toEqual(['translation'])
})
