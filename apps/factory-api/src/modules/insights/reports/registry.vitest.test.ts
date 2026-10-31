import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { PERIODS, REPORT_AREAS } from '@nexus/factory-domain/insights/reports/definition'
import { NUMBER_RULES } from '@nexus/factory-domain/insights/reports/numbers'
import { REPORT_KEYS } from '@nexus/factory-domain/production/reports/subscriptions'
import { NUMBER_READER_KEYS } from './numbers'
import { reportFiles } from './report-files'
import { checkReports, loadReports } from './registry'

/**
 * The standard pack's registry (B-W2a-79; plan W2a §1 "report definitions are files in a registry folder"): one file per
 * report, named after its key, every definition sound; the numbers of Today and the reports name each other; every
 * report's words exist in the web's catalogue (it and en, the English equal to the definition's). The catalogue lives in
 * apps/factory-web/messages: the web has no way to read these definitions, so this test reads its words.
 */

const SRC = fileURLToPath(new URL('../../..', import.meta.url))
const MESSAGES = fileURLToPath(new URL('../../../../../factory-web/messages', import.meta.url))

type Tree = { [key: string]: string | Tree }
const flatten = (tree: Tree, prefix = ''): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((all, [key, value]) => (typeof value === 'string' ? { ...all, [`${prefix}${key}`]: value } : { ...all, ...flatten(value, `${prefix}${key}.`) }), {})
const catalogue = (locale: 'it' | 'en') => flatten(JSON.parse(readFileSync(`${MESSAGES}/${locale}/home-reports.json`, 'utf8')) as Tree)

describe('the standard report pack (ANA-029)', () => {
  it('holds one file per report in defs/, each named after its key, in every area of the design', async () => {
    const reports = await loadReports(SRC)
    expect(reportFiles(SRC).map((file) => file.split('/').pop())).toEqual(reports.map((report) => `${report.key}.ts`))
    expect(reports).toHaveLength(14)
    expect([...new Set(reports.map((report) => report.area))].sort()).toEqual([...REPORT_AREAS].sort())
    expect(() => checkReports([reports[0]!, reports[0]!])).toThrow(/two definitions/)
    for (const report of reports) {
      expect(FACTORY_PERMISSIONS.isDeclared(report.permission as Permission), report.key).toBe(true)
      if (report.mail !== null) expect(REPORT_KEYS as readonly string[], report.key).toContain(report.mail)
    }
  })

  it('the numbers of Today and the reports name each other; every number has its reader', async () => {
    const reports = await loadReports(SRC)
    const byKey = new Map(reports.map((report) => [report.key, report]))
    for (const rule of NUMBER_RULES) {
      if (!rule.report) continue
      const report = byKey.get(rule.report.key)
      expect(report, `${rule.key} → ${rule.report.key}`).toBeDefined()
      expect(report!.numbers, `${rule.report.key} names ${rule.key}`).toContain(rule.key)
      for (const [filter, value] of Object.entries(rule.report.filters)) {
        const declared = report!.filters.find((entry) => entry.key === filter)
        expect(declared, `${rule.key}: ${filter}`).toBeDefined()
        expect(declared!.choices.map((choice) => choice.value), `${rule.key}: ${filter}=${value}`).toContain(value)
      }
    }
    for (const report of reports) for (const number of report.numbers) expect(NUMBER_RULES.some((rule) => rule.key === number), `${report.key}: ${number}`).toBe(true)
    expect([...NUMBER_READER_KEYS].sort()).toEqual(NUMBER_RULES.map((rule) => rule.key).sort())
  })

  it('every word of every report is in the web catalogue, in Italian and English (the English as defined)', async () => {
    const reports = await loadReports(SRC)
    const en = catalogue('en')
    const it_ = catalogue('it')
    const check = (key: string, english: string) => {
      expect(en[key], key).toBe(english)
      expect(it_[key], `${key} (it)`).toBeTruthy()
    }
    for (const report of reports) {
      const base = `report.${report.key}`
      check(`${base}.title`, report.title)
      check(`${base}.question`, report.question)
      check(`${base}.definition`, report.definition)
      check(`${base}.sources`, report.sources)
      for (const column of report.columns) {
        check(`${base}.col.${column.key}`, column.label)
        for (const code of column.codes ?? []) expect(it_[`code.${code}`] && en[`code.${code}`], `code.${code}`).toBeTruthy()
      }
      for (const filter of report.filters) {
        check(`${base}.filter.${filter.key}`, filter.label)
        if (filter.kind === 'choice') for (const choice of filter.choices) check(`${base}.choice.${filter.key}.${choice.value}`, choice.label)
        if (filter.kind === 'period') for (const choice of filter.choices) expect(PERIODS as readonly string[]).toContain(choice.value)
      }
    }
  })
})
