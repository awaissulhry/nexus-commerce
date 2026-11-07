import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { DUE_SOON_DAYS as DOMAIN_DUE_SOON } from '@nexus/factory-domain/safety/calendar/rules'
import * as risk from '@nexus/factory-domain/safety/risk/rules'
import * as rolesheets from '@nexus/factory-domain/safety/rolesheets/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { assessmentsAnswer, CATALOGUE as PICKERS, CUTTER, CUTTER_PREVIEW, MEASURES, measuresAnswer, northRecord, NORTH, SHEET_ROWS, sheetsAnswer, TODAY, V3, VISITS_PREVIEW } from './_demo/fixtures'
import { recordSchema, sheetSchema, versionSchema } from './api'
import { designScreen as dvrScreen } from './dvr/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressText,
  AUTHOR_KINDS,
  assessmentsOf,
  changeRows,
  DUE_SOON_DAYS,
  EMPTY_ADDRESS,
  EMPTY_MEASURE,
  EMPTY_RECORD_ADDRESS,
  emptyVersionDraft,
  freezeHeld,
  impactWords,
  IMPACT_KINDS,
  ITEM_KINDS,
  LAW,
  LIMITS,
  MEASURE_SOURCES,
  MEASURE_STATUSES,
  measureBodyOf,
  measureProblems,
  minorOf,
  newVersionHeld,
  paperHeld,
  problemOf,
  recordAddressOf,
  recordAddressText,
  recordChangeOf,
  riskCan,
  RISK_REFUSALS,
  SHEET_CODE,
  SHEET_REFUSALS,
  SHEET_STATUSES,
  sheetBodyOf,
  sheetChangedParts,
  sheetDraftOf,
  sheetProblems,
  sheetsOf,
  SIGN_METHODS,
  signerActs,
  SIGNER_ROLES,
  tileAction,
  tilesOf,
  VERSION_STATUSES,
  withAddress,
} from './model'
import { designScreen as planScreen } from './plan/fixtures'
import { designScreen as recordScreen } from './record/fixtures'
import { designScreen as sheetPrintScreen } from './role-sheets/fixtures'

const params = (text: string) => new URLSearchParams(text)

describe('risk: the mirrors of factory-domain', () => {
  it('says exactly the codes, the law and the limits the domain decides (its rules import node:crypto, no browser takes them)', () => {
    expect(SIGNER_ROLES).toEqual(risk.DVR_SIGNER_ROLES)
    expect(AUTHOR_KINDS).toEqual(risk.DVR_AUTHOR_KINDS)
    expect(VERSION_STATUSES).toEqual(risk.DVR_VERSION_STATUSES)
    expect(SIGN_METHODS).toEqual(risk.DVR_SIGN_METHODS)
    expect(MEASURE_STATUSES).toEqual(risk.MEASURE_STATUSES)
    expect(MEASURE_SOURCES).toEqual(risk.MEASURE_SOURCES)
    expect(RISK_REFUSALS).toEqual(risk.RISK_REFUSALS)
    expect(ITEM_KINDS).toEqual(rolesheets.ROLE_SHEET_ITEM_KINDS)
    expect(SHEET_STATUSES).toEqual(rolesheets.ROLE_SHEET_STATUSES)
    expect(SHEET_REFUSALS).toEqual(rolesheets.ROLE_SHEET_REFUSALS)
    expect(IMPACT_KINDS).toEqual(rolesheets.IMPACT_KINDS)
    expect(SHEET_CODE.source).toBe(rolesheets.ROLE_SHEET_CODE.source)
    expect(DUE_SOON_DAYS).toBe(DOMAIN_DUE_SOON)
    expect(LAW).toEqual({
      dvr: risk.DVR_LAW,
      versions: risk.VERSIONS_LAW,
      plan: risk.PLAN_LAW,
      review: risk.REVIEW_LAW,
      roleSheet: rolesheets.ROLE_SHEET_LAW,
      kit: rolesheets.KIT_LAW,
      training: rolesheets.TRAINING_LAW,
      surveillance: rolesheets.SURVEILLANCE_LAW,
    })
    const R = risk.RISK_LIMITS
    const S = rolesheets.ROLE_SHEET_LIMITS
    expect(LIMITS).toMatchObject({ name: R.name, label: R.label, author: R.author, summary: R.summary, title: R.title, risk: R.risk, note: R.note, reason: R.reason, evidence: R.evidence, roleSheets: R.roleSheets, cost: R.cost, daysAhead: R.daysAhead })
    expect(LIMITS).toMatchObject({ sheetCode: S.code, sheetName: S.name, sheetDescription: S.description, itemTitle: S.title, itemNote: S.note, whenToWear: S.whenToWear, items: S.items, kit: S.kit, requirements: S.requirements, quantity: S.quantity, withinDays: S.withinDays })
  })

  it('reads the API shapes the fixtures stand for (the record, a version, a sheet)', () => {
    expect(() => recordSchema.parse(northRecord())).not.toThrow()
    expect(() => versionSchema.parse(V3('DOCTOR'))).not.toThrow()
    expect(() => sheetSchema.parse(CUTTER)).not.toThrow()
  })
})

describe('risk: who may do what, and where the pages are', () => {
  it('gives the page to every safety reader, its keeping to the safety officer, signing to the signers', () => {
    const can = (key: string) => riskCan(templateOf(key)!.permissions)
    expect(can('safety_officer')).toMatchObject({ view: true, manage: true, sign: true, sheets: true, cost: false })
    expect(can('company_doctor')).toMatchObject({ view: true, manage: false, sign: true, sheets: false })
    expect(can('production_manager')).toMatchObject({ view: true, manage: false, sign: false, sheets: false })
    expect(can('read_only')).toMatchObject({ view: true, manage: false })
    expect(can('sales').view).toBe(false)
    const rows = (key: string) => officeNavFor(permissionCheck(templateOf(key)!.permissions)).areas.flatMap((area) => (area.sections ?? []).flatMap((entry) => entry.items.map((row) => row.href)))
    expect(rows('safety_officer')).toContain('/plant/risk')
    expect(rows('sales')).not.toContain('/plant/risk')
    expect([...OFFICE_PAGES]).toEqual(expect.arrayContaining(['/plant/risk', '/plant/risk/[id]', '/plant/risk/dvr', '/plant/risk/role-sheets', '/plant/risk/plan']))
    expect([...WINDOW_PAGES]).toEqual(expect.arrayContaining(['/plant/risk/dvr', '/plant/risk/role-sheets', '/plant/risk/plan']))
    expect(recordAddress({ type: 'RiskAssessment', id: 'a-1' }, OFFICE_PAGES)).toBe('/plant/risk/a-1')
    expect(recordAddress({ type: 'RiskMeasure', id: 'm-1' }, OFFICE_PAGES)).toBe('/plant/risk?measure=m-1')
    expect(recordAddress({ type: 'RoleSheet', id: 's-1' }, OFFICE_PAGES)).toBe('/plant/risk?sheet=s-1')
    expect(LIST_PAGES['/safety/risk/measures']).toBe('/plant/risk')
  })
})

describe('risk: the addresses, the tiles, the sections', () => {
  it('keeps every dialog and filter in the page’s address', () => {
    const address = addressOf(params('view=overdue&tile=roles&q=tag&new=measure&assessment=a1&sheet=s1&do=edit&measure=m1'))
    expect(address).toEqual({ view: 'overdue', tile: 'roles', q: 'tag', add: 'measure', assessment: 'a1', sheet: 's1', mode: 'edit', measure: 'm1' })
    expect(addressOf(params(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(params('view=x&tile=y&new=delete&do=burn'))).toEqual(EMPTY_ADDRESS)
    expect(withAddress(address, { sheet: 'other' }).mode).toBe('view')
    expect(withAddress(address, { add: null }).assessment).toBeNull()
  })

  it('keeps the record’s tab and dialogs in its address (Versions by default)', () => {
    const address = recordAddressOf(params('tab=plan&sign=v1&role=DOCTOR&method=paper&view=overdue&measure=m1'))
    expect(address).toMatchObject({ tab: 'plan', sign: 'v1', role: 'DOCTOR', method: 'paper', view: 'overdue', measure: 'm1' })
    expect(recordAddressOf(params(recordAddressText(address).slice(1)))).toEqual(address)
    expect(recordAddressOf(params(''))).toEqual(EMPTY_RECORD_ADDRESS)
    expect(EMPTY_RECORD_ADDRESS.tab).toBe('versions')
  })

  it('says the five tiles and what each one filters', () => {
    expect(tilesOf(null).every((tile) => tile.value === null)).toBe(true)
    const tiles = tilesOf({ measuresOverdue: 1, measuresDueSoon: 0, reviewsDue: 2, rolesWithoutKitOrTraining: 0, signaturesMissing: 3, assessments: 1, withoutVersion: 0, today: TODAY })
    expect(tiles.map((tile) => [tile.id, tile.tone])).toEqual([
      ['measuresOverdue', 'danger'],
      ['measuresDueSoon', null],
      ['reviewsDue', 'warning'],
      ['rolesWithoutKitOrTraining', null],
      ['signaturesMissing', 'danger'],
    ])
    expect(tileAction('measuresOverdue')).toEqual({ view: 'overdue' })
    expect(tileAction('reviewsDue')).toEqual({ tile: 'reviews' })
    expect(assessmentsOf([NORTH], 'signatures')).toHaveLength(1)
    expect(assessmentsOf([{ ...NORTH, waiting: null }], 'signatures')).toHaveLength(0)
    expect(sheetsOf(SHEET_ROWS, 'roles').map((row) => row.code)).toEqual(['MAG'])
  })
})

describe('risk: the dialogs’ rules', () => {
  it('sends a measure’s cost only with the cost grain, and reads the amount as typed', () => {
    const draft = { ...EMPTY_MEASURE, assessmentId: 'a', title: 'Carter', cost: '1.250,50' }
    expect('cost' in measureBodyOf(draft, false)).toBe(false)
    expect(measureBodyOf(draft, true).cost).toBe(125050)
    expect(minorOf('1250.5')).toBe(125050)
    expect(minorOf('')).toBeNull()
    expect(Number.isNaN(minorOf('dodici') as number)).toBe(true)
    expect(measureProblems({ ...EMPTY_MEASURE }, TODAY, false)[0]?.key).toBe('held.assessment')
    expect(measureProblems({ ...draft, cost: '-3' }, TODAY, true).map((problem) => problem.key)).toContain('held.cost')
    expect(measureProblems({ ...draft, dueOn: '2099-01-01' }, TODAY, false).map((problem) => problem.key)).toContain('refusal.DUE_TOO_FAR')
  })

  it('holds New DVR version while a version waits or nobody is the employer, and says the freeze’s steps in order', () => {
    const record = northRecord()
    expect(newVersionHeld(record)).toBe('refusal.VERSION_WAITING')
    const free = { ...record, versions: record.versions.slice(1) }
    expect(newVersionHeld(free)).toBeNull()
    expect(newVersionHeld({ ...free, next: { ...free.next, missingEmployer: true } })).toBe('refusal.NO_EMPLOYER')
    const draft = emptyVersionDraft(NORTH.id, TODAY)
    expect(freezeHeld(draft, free, TODAY, false)).toBe('held.file')
    const withFile = { ...draft, file: { name: 'dvr.pdf', type: 'application/pdf', size: 10 } }
    expect(freezeHeld(withFile, free, TODAY, false)).toBe('held.fingerprint')
    expect(freezeHeld({ ...withFile, sha256: 'a'.repeat(64) }, free, TODAY, false)).toBe('held.author')
    expect(freezeHeld({ ...withFile, sha256: 'a'.repeat(64), authorName: 'Studio' }, free, TODAY, false)).toBeNull()
    expect(freezeHeld({ ...withFile, file: { ...withFile.file, type: 'image/png' } }, free, TODAY, false)).toBe('refusal.NOT_PDF')
  })

  it('offers each signer what they may do: their own role here, the paper for the safety officer', () => {
    const version = V3('DOCTOR')
    const doctor = version.signers.find((signer) => signer.role === 'DOCTOR')!
    const employer = version.signers.find((signer) => signer.role === 'EMPLOYER')!
    expect(signerActs(version, doctor, { manage: false, sign: true, upload: false }).map((act) => act.kind)).toEqual(['office'])
    expect(signerActs(version, doctor, { manage: true, sign: false, upload: true }).map((act) => act.kind)).toEqual(['paper'])
    expect(signerActs(version, employer, { manage: true, sign: true, upload: true })).toEqual([{ kind: 'signed' }])
    expect(signerActs(version, doctor, { manage: false, sign: false, upload: false })).toEqual([{ kind: 'held', key: 'held.sign' }])
    expect(paperHeld({ signerName: 'Sara Prova', signedOn: TODAY, scan: null }, version, TODAY, false)).toBe('refusal.SCAN_MISSING')
    expect(paperHeld({ signerName: 'Sara Prova', signedOn: '2026-10-01', scan: { name: 's.pdf', type: 'application/pdf', size: 1 } }, version, TODAY, false)).toBe('refusal.SIGNED_BEFORE_FROZEN')
  })

  it('holds the WHOLE role sheet as one draft and sends only what the person set', () => {
    const draft = sheetDraftOf(CUTTER)
    expect(sheetChangedParts(CUTTER, draft)).toEqual([])
    expect('surveillance' in sheetBodyOf(draft, CUTTER)).toBe(false)
    const changed = { ...draft, needed: false, kit: draft.kit.map((line, index) => (index === 0 ? { ...line, quantity: '3' } : line)) }
    expect(sheetChangedParts(CUTTER, changed)).toEqual(['kit', 'surveillance'])
    expect(sheetBodyOf(changed, CUTTER).surveillance).toEqual({ needed: false })
    const noNeed = { ...draft, items: draft.items.filter((item) => item.kind === 'RISK'), needed: true }
    expect(sheetProblems(noNeed).map((problem) => problem.key)).toContain('held.surveillanceNeed')
    const twice = { ...draft, kit: [...draft.kit, { ...draft.kit[0]!, key: 'again' }] }
    expect(sheetProblems(twice).map((problem) => problem.key)).toContain('held.kitTwice')
  })

  it('says every line of "What this changes" in words, names on course and kit lines, counts on visits', () => {
    for (const preview of [CUTTER_PREVIEW, VISITS_PREVIEW]) for (const line of preview.impact) expect(impactWords(line, preview.refs, 'it').key).toMatch(/^impact\./)
    const deadline = impactWords(CUTTER_PREVIEW.impact[0]!, CUTTER_PREVIEW.refs, 'en')
    expect(deadline.params.course).toBe('Specific training (high risk)')
    expect(deadline.within?.to).toEqual({ key: 'within.days', params: { count: 30 } })
    expect(VISITS_PREVIEW.impact.find((line) => line.kind === 'VISITS_NEEDED')!.names).toBeNull()
    const rows = changeRows(CUTTER_PREVIEW.changes, CUTTER, CUTTER_PREVIEW.refs, PICKERS, 'it')
    expect(rows.map((row) => row.what.key)).toEqual(['change.riskAdded', 'change.kitAdded', 'change.kitQuantity', 'change.courseWithin'])
  })

  it('says the API’s refusals in our words, by family', () => {
    const refused = (path: string) => new ApiError('conflict', 409, 'refused', 'x', null, [{ path, message: 'x' }])
    expect(problemOf(refused('refusal/VERSION_WAITING')).key).toBe('refusal.VERSION_WAITING')
    expect(problemOf(refused('refusal/IMPACT_CHANGED'), 'sheet').key).toBe('sheetRefusal.IMPACT_CHANGED')
    expect(problemOf(refused('refusal/IMPACT_CHANGED')).key).toBe('problem.conflict')
    expect(problemOf(new Error('x')).key).toBe('problem.unavailable')
  })

  it('routes the live events to the part they move', () => {
    expect(recordChangeOf({ type: 'risk_measure.changed', fields: { assessmentId: NORTH.id } }, NORTH.id)).toBe('plan')
    expect(recordChangeOf({ type: 'risk_signature.collected', fields: { assessmentId: NORTH.id } }, NORTH.id)).toBe('record')
    expect(recordChangeOf({ type: 'risk_signature.collected', fields: { assessmentId: 'other' } }, NORTH.id)).toBeNull()
    expect(recordChangeOf({ type: 'role_sheet.changed', fields: {} }, NORTH.id)).toBe('roles')
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const TOP = [...new Set(Object.keys(CATALOGUE.en['plant-risk'] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, '')))]
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Law references and file names are said on purpose. */
const SAID = /\b(?:D\.Lgs\.[^<"]*|[\w .-]+\.pdf)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('risk: the words', () => {
  it('has every key in it and en; every word the screens name exists; every code has its words', () => {
    expect(Object.keys(CATALOGUE.it['plant-risk'] ?? {}).sort()).toEqual(Object.keys(CATALOGUE.en['plant-risk'] ?? {}).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/(?<![\w.])t\(\s*'([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:held|refusal|sheetRefusal|problem|notice|stepUp|moved)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['plant-risk'] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      for (const code of RISK_REFUSALS) expect(has(`refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of SHEET_REFUSALS) expect(has(`sheetRefusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of IMPACT_KINDS) expect(has(`impact.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of SIGNER_ROLES) expect(has(`role.${code}`) && has(`roleShort.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of MEASURE_STATUSES) expect(has(`status.${code}`) && has(`move.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of MEASURE_SOURCES) expect(has(`source.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of SIGN_METHODS) expect(has(`signed.${code}`), `${locale} ${code}`).toBe(true)
      expect(CATALOGUE[locale].shell?.['nav.plant.risk'], `${locale} nav.plant.risk`).toBeTruthy()
    }
  })

  for (const screen of [designScreen, recordScreen, dvrScreen, sheetPrintScreen, planScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en with no key or placeholder left`, () => {
      for (const entry of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, entry.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${entry.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('SCR-209 names every state and role case the design asks for', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['normal', 'all-sites', 'loading', 'error', 'empty', 'no-permission', 'read-only', 'add-measure', 'version', 'sheet', 'sheet-impact', 'keys']))
    expect(recordScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['versions', 'plan', 'roles', 'sign-office', 'sign-paper', 'loading', 'error', 'no-permission']))
    expect(assessmentsAnswer().assessments).toHaveLength(1)
    expect(measuresAnswer(MEASURES).measures.every((row) => !('cost' in row))).toBe(true)
    expect(sheetsAnswer().roleSheets).toHaveLength(4)
  })
})
