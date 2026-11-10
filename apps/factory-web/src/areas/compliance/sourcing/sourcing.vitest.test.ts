import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { BLOCK_CAUSES, CLAIM_KINDS, CLAIM_REFUSALS, CLAIM_SCOPES, CLAIM_STATES, FINDING_CODES, USE_KINDS } from '@nexus/factory-domain/compliance/claims/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { FILES, LWG, PFAS_BLOCKED, RECYCLED, TODAY } from './_demo/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressText,
  approveHeld,
  bodyOf,
  draftChanged,
  draftOf,
  draftProblems,
  EMPTY_ADDRESS,
  EMPTY_DRAFT,
  EMPTY_USE,
  EVIDENCE_RECORDS,
  FILE_CATEGORIES,
  findingsOf,
  isClaimsChange,
  problemOf,
  replacementOf,
  sourcingCan,
  stateOfTile,
  tileOfState,
  tilesOf,
  useHeld,
  withAddress,
  withdrawHeld,
} from './model'

const params = (text: string) => new URLSearchParams(text)

describe('sourcing: the address, the tiles and who may do what', () => {
  it('keeps the filters and every dialog in the address, the API’s own terms', () => {
    const address = addressOf(params('state=BLOCKED&kind=CARBON&scope=STYLE&q=pfas&open=abc&tab=where&do=use'))
    expect(address).toMatchObject({ state: 'BLOCKED', kind: 'CARBON', scope: 'STYLE', q: 'pfas', open: 'abc', tab: 'where', mode: 'use', add: false })
    expect(addressOf(params(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(params('state=x&kind=y&scope=z&tab=q&do=delete'))).toEqual(EMPTY_ADDRESS)
    const adding = addressOf(params('new=1&replaces=r1'))
    expect(adding).toMatchObject({ add: true, replaces: 'r1' })
    expect(withAddress(adding, { add: false }).replaces).toBeNull()
    // Another claim starts on its words; closing the window clears its tab and mode.
    expect(withAddress(address, { open: 'other' })).toMatchObject({ mode: 'view', tab: 'wording' })
    expect(withAddress(address, { open: null })).toMatchObject({ mode: 'view', tab: 'wording' })
    expect(tilesOf({ approved: 3, blocked: 1, drafts: 2, retired: 4 }).map((tile) => [tile.id, tile.value])).toEqual([['approved', 3], ['blocked', 1], ['drafts', 2]])
    expect(tileOfState('BLOCKED')).toBe('blocked')
    expect(stateOfTile('drafts')).toBe('DRAFT')
  })

  it('gives the register to every compliance reader; keeping and approving claims to the quality inspector', () => {
    const quality = sourcingCan(templateOf('quality_inspector')!.permissions)
    expect(quality).toEqual({ view: true, manage: true, approve: true, upload: true })
    expect(sourcingCan(templateOf('production_manager')!.permissions)).toMatchObject({ view: true, manage: false, approve: false })
    expect(sourcingCan(templateOf('sales')!.permissions).view).toBe(false)
    const nav = officeNavFor(permissionCheck([...templateOf('quality_inspector')!.permissions]))
    const compliance = nav.areas.find((area) => area.id === 'compliance')!
    expect((compliance.sections ?? []).flatMap((section) => section.items.map((item) => item.href))).toContain('/compliance/sourcing')
    expect(OFFICE_PAGES.has('/compliance/sourcing')).toBe(true)
    expect(recordAddress({ type: 'SustainabilityClaim', id: 'c1' }, OFFICE_PAGES)).toBe('/compliance/sourcing?open=c1')
    expect(LIST_PAGES['/compliance/claims']).toBe('/compliance/sourcing')
  })
})

describe('sourcing: the claim as typed', () => {
  it('holds Create until the draft is complete and the checker refuses nothing', () => {
    expect(draftProblems(EMPTY_DRAFT, true).map((problem) => problem.key)).toEqual(['held.code', 'held.kind', 'held.wording'])
    const draft = { ...EMPTY_DRAFT, code: 'CL-0009', kind: 'SUBSTANCE_FREE' as const, wording: { it: 'Realizzato senza PFAS', en: '' } }
    expect(draftProblems(draft, true)).toEqual([])
    expect(draftProblems({ ...draft, wording: { en: 'Eco-friendly jacket' } }, true).map((problem) => problem.key)).toEqual(['held.wordingRefused'])
    expect(draftProblems({ ...draft, scope: 'STYLE' }, true).map((problem) => problem.key)).toEqual(['held.style'])
    expect(Object.keys(findingsOf({ kind: 'CARBON', wording: { it: 'A impatto zero', en: 'Made in Italy' } }))).toEqual(['it'])
    expect(bodyOf({ ...draft, scope: 'COMPANY', styleId: 'x', validUntil: ' ', note: ' a ' })).toEqual({ kind: 'SUBSTANCE_FREE', wording: { it: 'Realizzato senza PFAS' }, phraseKey: null, scope: 'COMPANY', styleId: null, itemId: null, scopeNote: null, evidenceFileIds: [], validUntil: null, note: 'a' })
  })

  it('edits a draft from what was read, and starts a replacement without evidence', () => {
    const draft = draftOf(LWG)
    expect(draft).toMatchObject({ code: LWG.code, kind: 'RESPONSIBLE_SOURCING', scope: 'MATERIAL', itemId: LWG.material!.id, evidenceFileIds: [FILES.lwg.id], validUntil: '2027-06-30' })
    expect(draftChanged(LWG, draft)).toBe(false)
    expect(draftChanged(LWG, { ...draft, note: 'x' })).toBe(true)
    expect(replacementOf(PFAS_BLOCKED, 'CL-0010')).toMatchObject({ code: 'CL-0010', supersedesId: PFAS_BLOCKED.id, evidenceFileIds: [], validUntil: '' })
  })

  it('holds Approve, Withdraw and Record a use with the reason', () => {
    const quality = sourcingCan(templateOf('quality_inspector')!.permissions)
    expect(approveHeld(LWG, TODAY, quality, false)).toBeNull()
    expect(approveHeld({ ...LWG, evidence: [] }, TODAY, quality, false)).toBe('refusal.NO_EVIDENCE')
    expect(approveHeld({ ...LWG, validUntil: '2026-11-01' }, TODAY, quality, false)).toBe('refusal.VALID_UNTIL_PAST')
    expect(approveHeld(RECYCLED, TODAY, quality, false)).toBe('held.notDraft')
    expect(approveHeld(LWG, TODAY, sourcingCan(templateOf('production_manager')!.permissions), false)).toBe('held.approve')
    expect(withdrawHeld('', false)).toBe('held.reason')
    expect(withdrawHeld('Changed supplier', false)).toBeNull()
    expect(useHeld(PFAS_BLOCKED, { ...EMPTY_USE, recordId: 'x' }, false)).toBe('refusal.NOT_HOLDING')
    expect(useHeld(RECYCLED, { ...EMPTY_USE, kind: 'CATALOGUE', recordId: 'x' }, false)).toBe('held.useName')
    expect(useHeld(RECYCLED, { ...EMPTY_USE, recordId: null }, false)).toBe('held.useLabel')
  })

  it('says the API’s refusal in our words, at its field; hears the claims’ live events', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/CODE_TAKEN' }, { path: 'body/code' }])
    expect(problemOf(refused)).toEqual({ key: 'refusal.CODE_TAKEN', field: 'code' })
    expect(problemOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/wording.en' }]))).toEqual({ key: 'held.wordingRefused', field: 'wording' })
    expect(problemOf(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('problem.forbidden')
    expect(isClaimsChange({ type: 'claim.evidence_expired' })).toBe(true)
    expect(isClaimsChange({ type: 'chemical.changed' })).toBe(false)
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NAMESPACE = 'compliance-sourcing'
const TOP = [...new Set(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, '')))].filter((key) => !['claim', 'form', 'state', 'status', 'use', 'scope', 'record'].includes(key))
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("compliance.claims.manage"); addresses, file names and phrase keys are not keys. */
const SAID = /\b(?:compliance\.[a-zA-Z.]+|files\.upload|claim\.[a-z-]+|[a-z-]+\.example\.com[^\s"<]*|[\w .,'-]+\.pdf)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'quality']) }, createElement(View, { model })))
}

describe('sourcing: the words', () => {
  it('every key in it and en; every word the screens name exists; every code has its words', () => {
    expect(Object.keys(CATALOGUE.it[NAMESPACE] ?? {}).sort()).toEqual(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:held|refusal|problem|saved|notice|bulk|approve)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][NAMESPACE] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      for (const code of [...CLAIM_REFUSALS, 'DATABASE']) expect(has(`refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of CLAIM_KINDS) expect(has(`kind.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of CLAIM_STATES) expect(has(`state.${code}`) && has(`rows.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of CLAIM_SCOPES) expect(has(`scopeKind.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of USE_KINDS) expect(has(`use.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of BLOCK_CAUSES) expect(has(`block.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of FINDING_CODES) expect(has(`finding.${code}`) && has(`law.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of FILE_CATEGORIES) expect(has(`category.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of EVIDENCE_RECORDS) expect(has(`record.${code}`), `${locale} ${code}`).toBe(true)
      for (const field of ['code', 'kind', 'wording', 'phraseKey', 'styleId', 'itemId', 'scopeNote', 'evidenceFileIds', 'validUntil', 'note', 'label', 'recordId', 'reason', 'companyId', 'supersedesId', 'version']) expect(has(`held.${field}`), `${locale} held.${field}`).toBe(true)
      for (const action of ['draft', 'edit', 'approve', 'withdraw', 'addUse', 'endUse', 'replaced', 'evidenceExpired']) expect(has(`activity.${action}`), `${locale} activity.${action}`).toBe(true)
    }
  })

  it(`SCR-215: ${designScreen.cases.length} cases × it, en with no key or placeholder left`, () => {
    for (const entry of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(designScreen as unknown as DesignScreen<unknown>, entry.model, locale).replace(SAID, '')
        expect(html.length, `SCR-215/${entry.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-215/${entry.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `SCR-215/${entry.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('SCR-215 names every state and role case the design asks for', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['normal', 'loading', 'error', 'empty', 'filtered-empty', 'no-permission', 'read-only', 'new', 'new-refused-words', 'claim', 'claim-evidence', 'claim-where', 'claim-activity', 'approve', 'step-up', 'withdraw-many', 'keys']),
    )
  })
})
