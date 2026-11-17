import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { PRODUCTION_ASK_KINDS } from '@nexus/factory-domain/production-brand/kinds'
import { LEVEL_WORDS, SUPERVISOR_REFUSAL_WORDS } from '@nexus/factory-domain/production-brand/words'
import { STAGE_WORDS, ORDER_FREEZE_STAGES } from '@nexus/factory-domain/sales/order-changes/freeze'
import { ApiError } from '../../../../../lib/api/errors'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { leftKeys, render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { scanText } from '../../../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../../lib/testing/two-brands'
import { runWithStepUp } from '../../../../admin/shared/step-up'
import type { PartnerPerson, ProductionLimits } from '../../../../admin/users/partners/api'
import { CUSTOMER_PEOPLE, freezeList, limitsModel, OFFICE_PEOPLE, productionLimits } from '../demo'
import { designScreen } from '../fixtures'
import { LimitsCard } from '../view/LimitsCard'
import { PortalAccessMessages } from '../view/parts'
import {
  approverChoices,
  BACKUP_SENTENCES,
  blankFreezeDraft,
  changeCount,
  EVERY_COMPANY_SENTENCE,
  freezeDraftProblem,
  freezeProblemOf,
  freezeRows,
  limitsApply,
  limitsBody,
  limitsDraftOf,
  limitsHeld,
  limitsProblemOf,
  limitsProblems,
  LIMITS_SENTENCES,
  openAsksOf,
  pickProblemOf,
  PRODUCTION_PARTNER,
  productionPreviewAddress,
  productionPreviewHeld,
  saveLimits,
  seesNow,
  slotChoices,
  supervisorBody,
  supervisorHeld,
  supervisorMove,
  supervisorProblemOf,
  urgencyNote,
  withPreset,
  type LimitsModel,
  type PickState,
} from './model'

/**
 * F-PR-07 — the per-customer limits card on Customer › Portal access (production plan §3, §4, §7.1, §7.7; lead picks L18, L21; review
 * fixes R-46, R-50, R-53). Everything starts off; the preset "Production partner"; only what changes is sent, with the version read;
 * one Apply = the limits (fresh code) then the supervisor on its own route with the version the limits gave; urgency switched off keeps
 * its marks ("3 urgent marks are kept but not used while this is off"); the supervisor block is office only and drawn with the portal
 * off. Wall tests (web side): PW-S01 (the card names only its customer; a change asks the fresh code), PW-08b (another customer's card
 * or preview reads as not found, neutral), PW-14 (the supervisor's pick list only; refused in words, no names), PW-15 (no portal
 * screen, catalogue or read ever carries a supervisor). Every name is made up.
 */

const saved = productionLimits().production
const DEFAULT = limitsDraftOf(saved)
const apiError = (kind: ApiError['kind'], status: number, message: string, issues: Array<{ path: string; message: string }> = []) => new ApiError(kind, status, kind, message, 'r', issues)
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const read = (path: string) => readFileSync(here(path), 'utf8')
const API = '../../../../../../../factory-api/src'
const DOMAIN = '../../../../../../../../packages/factory-domain/src'

const card = (model: LimitsModel, locale: 'it' | 'en' = 'en', over: { partyName?: string; portalOn?: boolean; people?: readonly PartnerPerson[]; preview?: boolean } = {}) =>
  render(
    createElement(PortalAccessMessages, null, createElement(LimitsCard, { model, partyName: over.partyName ?? 'Moda Demo', portalOn: over.portalOn ?? true, people: over.people ?? CUSTOMER_PEOPLE, can: { preview: over.preview ?? true }, previewing: false })),
    locale,
  )

describe('F-PR-07 — everything starts off; only what changes is sent', () => {
  it('a new customer: Status only, urgency off (quota 3), no production asks, anyone answers, no second person, no supervisor', () => {
    expect(DEFAULT).toEqual({ level: 'STATUS', urgencyOn: false, urgentMax: 3, askKinds: [], approverMode: 'ANYONE', approverId: null, fourEyes: false, supervisorId: null, backupId: null, preset: false })
    expect(limitsBody(saved, DEFAULT)).toBeNull()
    expect(supervisorBody(saved, DEFAULT)).toBeNull()
    expect(changeCount(saved, DEFAULT)).toBe(0)
    expect(openAsksOf(DEFAULT)).toEqual([])
  })

  it('the preset "Production partner" is the API’s: + Progress, urgency on (3), every production ask — named while the draft holds it', () => {
    const office = read(`${API}/platform/auth/partners/office.ts`)
    expect(office).toContain("const PRODUCTION_PARTNER = Object.freeze({ productionLevel: 'PROGRESS' as const, productionUrgencyOn: true, productionUrgentMax: URGENT_MAX.byDefault, productionAskKinds: [...PRODUCTION_ASK_KINDS] })")
    expect(PRODUCTION_PARTNER).toEqual({ level: 'PROGRESS', urgencyOn: true, urgentMax: 3, askKinds: [...PRODUCTION_ASK_KINDS] })
    const preset = withPreset(DEFAULT)
    expect(limitsBody(saved, preset)).toEqual({ preset: 'PRODUCTION_PARTNER', version: 4, productionLevel: 'PROGRESS', productionUrgencyOn: true, productionAskKinds: ['HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'] })
    // Changed after the preset: the preset is no longer named (the audit would say what was not done).
    expect(limitsBody(saved, { ...preset, level: 'GATES' })).toEqual({ version: 4, productionLevel: 'GATES', productionUrgencyOn: true, productionAskKinds: ['HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'] })
    // The preset leaves the approver, the second person and the supervisor as they are.
    expect(supervisorBody(saved, preset)).toBeNull()
    expect(openAsksOf(preset)).toEqual(['RUSH', 'HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'])
  })

  it('the asks in the card’s order, each once; the approver named or anyone; the second person; the quota range', () => {
    expect(limitsBody(saved, { ...DEFAULT, askKinds: ['SAMPLE_ROUND', 'HOLD'] })).toEqual({ version: 4, productionAskKinds: ['HOLD', 'SAMPLE_ROUND'] })
    expect(limitsBody(saved, { ...DEFAULT, approverMode: 'NAMED', approverId: CUSTOMER_PEOPLE[1]!.id, fourEyes: true })).toEqual({ version: 4, productionApproverId: CUSTOMER_PEOPLE[1]!.id, overrideFourEyes: true })
    const named = productionLimits({ approver: { id: CUSTOMER_PEOPLE[1]!.id, name: 'Marco Prova', active: true } }).production
    expect(limitsBody(named, { ...limitsDraftOf(named), approverMode: 'ANYONE', approverId: null })).toEqual({ version: 4, productionApproverId: null })
    // NAMED with nobody picked: held in words, never sent.
    expect(limitsProblems({ ...DEFAULT, approverMode: 'NAMED', approverId: null })).toEqual({ approver: 'limits.approver.pick' })
    expect(limitsBody(saved, { ...DEFAULT, approverMode: 'NAMED', approverId: null })).toBeNull()
    expect(limitsProblems({ ...DEFAULT, urgentMax: 21 })).toEqual({ urgentMax: 'limits.urgency.maxRange' })
    expect(limitsProblems({ ...DEFAULT, urgentMax: 0 })).toEqual({})
  })

  it('the approver comes from their ACTIVE customer-portal people; a saved one no longer active stays shown', () => {
    const choices = approverChoices(CUSTOMER_PEOPLE, saved)
    expect(choices.map((entry) => entry.label)).toEqual(['Giulia Esempio · Admin', 'Marco Prova · Buyer', 'Sara Demo · Finance'])
    const gone = productionLimits({ approver: { id: CUSTOMER_PEOPLE[4]!.id, name: 'Elena Modello', active: false } }).production
    expect(approverChoices(CUSTOMER_PEOPLE, gone).at(-1)).toEqual({ value: CUSTOMER_PEOPLE[4]!.id, label: 'Elena Modello', active: false })
  })

  it('what each level adds: pieces, gates & dates, quality & photos (the level shares each from its own rank)', () => {
    expect(seesNow('STATUS').map((entry) => entry.shared)).toEqual([false, false, false])
    expect(seesNow('PROGRESS').map((entry) => entry.shared)).toEqual([true, false, false])
    expect(seesNow('QUALITY').map((entry) => entry.shared)).toEqual([true, true, true])
  })

  it('the card is a customer’s (or a brand’s) only', () => {
    expect(limitsApply('customers', ['CUSTOMER'])).toBe(true)
    expect(limitsApply('customers', ['SUPPLIER'])).toBe(false)
    expect(limitsApply('suppliers', ['CUSTOMER', 'SUPPLIER'])).toBe(false)
  })
})

describe('F-PR-07 — urgency off keeps the marks (R-46); a lower quota keeps them too', () => {
  it('switched off with 3 marks: "3 urgent marks are kept but not used while this is off", before Apply and after', () => {
    const on = productionLimits({ urgency: { on: true, max: 3, now: 3, dormant: null, overQuota: null } }).production
    expect(urgencyNote(on, { ...limitsDraftOf(on), urgencyOn: false })?.en).toBe('3 urgent marks are kept but not used while this is off.')
    expect(urgencyNote(on, { ...limitsDraftOf(on), urgencyOn: false })?.it).toBe('3 ordini urgenti sono tenuti ma non contano finché questo è spento.')
    expect(urgencyNote(on, limitsDraftOf(on))).toBeNull()
    expect(urgencyNote(on, { ...limitsDraftOf(on), urgentMax: 1 })?.en).toBe('3 urgent orders for a quota of 1: they stay urgent; new marks only below the quota.')
    const text = textOf(card(limitsModel({ read: productionLimits({ urgency: { on: false, max: 3, now: 3, dormant: { it: 'x', en: 'y' }, overQuota: null } }) })))
    expect(text).toContain('3 urgent marks are kept but not used while this is off.')
    expect(text).toContain('Off: they cannot mark orders urgent.')
  })

  it('on: the rule in words and "At most 3 urgent at once"', () => {
    const text = textOf(card(limitsModel({ read: productionLimits({ urgency: { on: true, max: 3, now: 2, dormant: null, overQuota: null } }) })))
    expect(text).toContain('over the limit, or from Cutting on, a mark becomes a request we answer')
    expect(text).toContain('At most 3 urgent at once · 2 urgent now.')
  })
})

describe('F-PR-07 — one Apply: the limits (fresh code), then the supervisor with the version they gave', () => {
  const limitsAnswer = (version: number): ProductionLimits => productionLimits({ version })
  const draft = { ...withPreset(DEFAULT), supervisorId: OFFICE_PEOPLE.bea.id, backupId: OFFICE_PEOPLE.carlo.id }

  it('the order of the two calls and the shared version', async () => {
    const calls: string[] = []
    const outcome = await saveLimits(saved, draft, {
      limits: async (body) => {
        calls.push(`limits v${body.version}`)
        return limitsAnswer(5)
      },
      supervisor: async (body) => {
        calls.push(`supervisor v${body.version} ${body.supervisorId} ${body.backupId}`)
        return { version: 6 }
      },
    }, { manage: true, supervise: true })
    expect(outcome).toEqual({ state: 'saved', limits: true, supervisor: true })
    expect(calls).toEqual(['limits v4', `supervisor v5 ${OFFICE_PEOPLE.bea.id} ${OFFICE_PEOPLE.carlo.id}`])
  })

  it('a refused supervisor after saved limits says both; refused limits send no supervisor', async () => {
    const refused = apiError('invalid', 400, 'x', [{ path: 'body/supervisorId', message: SUPERVISOR_REFUSAL_WORDS.NO_MEASUREMENTS.en }])
    const after = await saveLimits(saved, draft, { limits: async () => limitsAnswer(5), supervisor: async () => Promise.reject(refused) }, { manage: true, supervise: true })
    expect(after).toMatchObject({ state: 'failed', part: 'supervisor', limitsSaved: true })
    let supervisorAsked = false
    const before = await saveLimits(saved, draft, { limits: async () => Promise.reject(apiError('conflict', 409, 'stale')), supervisor: async () => ((supervisorAsked = true), { version: 9 }) }, { manage: true, supervise: true })
    expect(before).toMatchObject({ state: 'failed', part: 'limits', limitsSaved: false })
    expect(supervisorAsked).toBe(false)
  })

  it('without partners.production.manage only the supervisor goes (and only with production.brand.manage)', async () => {
    const calls: string[] = []
    const run = (rights: { manage: boolean; supervise: boolean }) =>
      saveLimits(saved, draft, { limits: async () => (calls.push('limits'), limitsAnswer(5)), supervisor: async () => (calls.push('supervisor'), { version: 5 }) }, rights)
    expect(await run({ manage: false, supervise: true })).toEqual({ state: 'saved', limits: false, supervisor: true })
    expect(await run({ manage: false, supervise: false })).toEqual({ state: 'saved', limits: false, supervisor: false })
    expect(calls).toEqual(['supervisor'])
  })

  it('PW-S01 (web side): a change the API refuses without a fresh code is sent again only after the code', async () => {
    let tries = 0
    let asked = 0
    const answer = await runWithStepUp(
      async () => {
        tries++
        if (tries === 1) throw new ApiError('step_up', 403, 'forbidden', 'A fresh code is needed.', 'r', [{ path: 'stepUp', message: 'x' }])
        return limitsAnswer(5)
      },
      async () => {
        asked++
      },
    )
    expect([tries, asked, answer.production.version]).toEqual([2, 1, 5])
    const sources = read('./use-limits.ts')
    expect(sources).toContain("guard(SENTENCE, () => changeProductionLimits(api, partyId, body, limitsKey))")
    expect(CATALOGUE.en['portal-access']!['stepUp.sentence.production']).toContain('fresh code')
  })
})

describe('F-PR-07 — refusals in words, never the API’s English', () => {
  it('the limits route: only a customer, the approver, nothing changes, the rest by kind (the sentences are the API’s own)', () => {
    const office = read(`${API}/platform/auth/partners/office.ts`)
    for (const sentence of Object.values(LIMITS_SENTENCES)) expect(office).toContain(sentence)
    expect(limitsProblemOf(apiError('conflict', 409, LIMITS_SENTENCES.onlyCustomers))).toBe('limits.problem.onlyCustomers')
    expect(limitsProblemOf(apiError('invalid', 400, LIMITS_SENTENCES.approver, [{ path: 'body/productionApproverId', message: LIMITS_SENTENCES.approver }]))).toBe('limits.problem.approver')
    expect(limitsProblemOf(apiError('conflict', 409, 'Nothing changes: these are the limits already.'))).toBe('limits.problem.nothing')
    expect(limitsProblemOf(apiError('conflict', 409, 'stale'))).toBe('problem.conflict')
    // PW-08b: another customer's card reads as not found, the neutral words of an unknown organisation.
    expect(limitsProblemOf(apiError('not_found', 404, 'Organisation not found.'))).toBe('problem.notFound')
  })

  it('the supervisor’s route: the person refused from its code, the backup’s shape, not at every company (the API’s sentences)', () => {
    const sources = read(`${API}/modules/production/supervisor/assign.ts`) + read(`${DOMAIN}/production-brand/supervisor.ts`)
    for (const sentence of [...Object.values(BACKUP_SENTENCES), EVERY_COMPANY_SENTENCE]) expect(sources).toContain(sentence)
    expect(supervisorProblemOf(apiError('invalid', 400, 'x', [{ path: 'body/supervisorId', message: SUPERVISOR_REFUSAL_WORDS.NO_REACH.en }]))).toEqual({ key: 'skip.NO_REACH', ns: 'production-supervisor' })
    expect(supervisorProblemOf(apiError('invalid', 400, 'x', [{ path: 'body/backupId', message: BACKUP_SENTENCES.same }]))).toEqual({ key: 'limits.supervisor.backupSame', ns: 'portal-access' })
    expect(supervisorProblemOf(apiError('forbidden', 403, EVERY_COMPANY_SENTENCE))).toEqual({ key: 'limits.supervisor.heldEveryCompany', ns: 'portal-access' })
    expect(supervisorProblemOf(apiError('conflict', 409, 'stale'))).toEqual({ key: 'problem.conflict', ns: 'portal-access' })
  })

  it('the backup only beside a supervisor, never the same person; clearing the supervisor clears the backup', () => {
    expect(limitsProblems({ ...DEFAULT, backupId: OFFICE_PEOPLE.carlo.id })).toEqual({ backup: 'limits.supervisor.backupAlone' })
    expect(limitsProblems({ ...DEFAULT, supervisorId: OFFICE_PEOPLE.bea.id, backupId: OFFICE_PEOPLE.bea.id })).toEqual({ backup: 'limits.supervisor.backupSame' })
    const set = productionLimits({ supervisor: { id: OFFICE_PEOPLE.bea.id, name: 'Bea Esempio', active: true }, backup: { id: OFFICE_PEOPLE.carlo.id, name: 'Carlo Prova', active: true } }).production
    expect(supervisorBody(set, { ...limitsDraftOf(set), supervisorId: null })).toEqual({ supervisorId: null, backupId: null, version: 4 })
    expect(changeCount(set, { ...limitsDraftOf(set), supervisorId: null, backupId: null })).toBe(2)
  })
})

describe('F-PR-07 — who looks after it here: office only, the pick list, the orders that move (PW-14, R-53)', () => {
  const ready: PickState = { status: 'ready', people: [OFFICE_PEOPLE.me, OFFICE_PEOPLE.bea, OFFICE_PEOPLE.carlo], complete: true, ordersOnDefault: 7 }

  it('PW-14 (web side): the slots offer the pick list’s people only (the backup never the supervisor); a 404 holds them, no name read', () => {
    expect(slotChoices(ready, null, null).map((entry) => entry.label)).toEqual(['Alex Demo', 'Bea Esempio', 'Carlo Prova'])
    expect(slotChoices(ready, null, OFFICE_PEOPLE.bea.id).map((entry) => entry.label)).toEqual(['Alex Demo', 'Carlo Prova'])
    expect(slotChoices(ready, { id: 'u-gone', name: 'Dora Campione', active: false }, null).at(-1)).toEqual({ value: 'u-gone', label: 'Dora Campione', listed: false })
    const held = pickProblemOf(apiError('not_found', 404, 'Customer not found.'))
    expect(held).toEqual({ status: 'held', key: 'limits.supervisor.heldEveryCompany', ns: 'portal-access' })
    expect(slotChoices(held, null, null)).toEqual([])
    expect(supervisorHeld(true, held)).toEqual({ key: 'limits.supervisor.heldEveryCompany', ns: 'portal-access' })
    expect(supervisorHeld(false, ready)).toEqual({ key: 'held.noRight', ns: 'production-supervisor' })
    expect(supervisorHeld(true, ready)).toBeNull()
  })

  it('a new supervisor says before Apply how many orders without their own supervisor move', () => {
    const draft = { ...DEFAULT, supervisorId: OFFICE_PEOPLE.bea.id }
    expect(supervisorMove(saved, draft, ready)).toEqual({ key: 'limits.supervisor.moves', count: 7 })
    expect(supervisorMove(saved, DEFAULT, ready)).toBeNull()
    expect(supervisorMove(saved, draft, { ...ready, ordersOnDefault: 0 })).toEqual({ key: 'limits.supervisor.movesNone', count: 0 })
    const set = productionLimits({ supervisor: { id: OFFICE_PEOPLE.bea.id, name: 'Bea Esempio', active: true } }).production
    expect(supervisorMove(set, { ...limitsDraftOf(set), supervisorId: null }, ready)).toEqual({ key: 'limits.supervisor.clears', count: 7 })
    expect(textOf(card(limitsModel({ draft }), 'en'))).toContain('Changing the supervisor moves 7 orders that have no supervisor of their own.')
    expect(textOf(card(limitsModel({ draft }), 'it'))).toContain('Cambiare il supervisore sposta 7 ordini che non hanno un supervisore proprio.')
  })

  it('R-53: drawn with the portal off; nobody eligible says what a supervisor needs; without the right, held in words', () => {
    const off = textOf(card(limitsModel({ read: productionLimits({ version: 0 }) }), 'en', { portalOn: false }))
    expect(off).toContain('Who looks after Moda Demo here')
    expect(off).toContain('Office only')
    expect(off).toContain('A supervisor works without a portal: saving one opens nothing for them.')
    expect(textOf(card(limitsModel({ pick: { status: 'ready', people: [], complete: true, ordersOnDefault: 0 } })))).toContain('A supervisor must be active, allowed on the customer and hold the measurements right.')
    const held = textOf(card(limitsModel({ supervise: false, pick: { status: 'held', key: 'held.noRight', ns: 'production-supervisor' }, read: productionLimits({ supervisor: { id: OFFICE_PEOPLE.bea.id, name: 'Bea Esempio', active: true } }) })))
    expect(held).toContain("Setting a production supervisor needs the right to manage customers' production.")
    expect(held).toContain('Bea Esempio')
  })
})

describe('F-PR-07 — the freeze points: the company’s beside the customer’s own', () => {
  it('one row per field; another customer’s rule never shows as theirs (PW-S01)', () => {
    const list = freezeList()
    const rows = freezeRows({ ...list, rules: [...list.rules, { ...list.rules[3]!, id: 'other', partyId: BRAND_ALPHA.ids.order, field: 'PRICE' }] })
    expect(rows.map((row) => row.field)).toEqual(['SIZE_QUANTITY', 'COLOURWAY', 'OPTION', 'DELIVERY_DATE', 'SHIP_TO', 'PRICE'])
    const sizes = rows.find((row) => row.field === 'SIZE_QUANTITY')!
    expect(sizes.company.map((rule) => [rule.frozenFrom, rule.action])).toEqual([
      ['CUT', 'CHANGE_REQUEST'],
      ['SEWING', 'BLOCKED'],
    ])
    expect(sizes.own).toEqual([])
    expect(rows.find((row) => row.field === 'COLOURWAY')!.own.map((rule) => rule.frozenFrom)).toEqual(['RELEASED'])
    expect(rows.find((row) => row.field === 'PRICE')!.own).toEqual([])
  })

  it('a rule of their own is checked before Save: a twin at the stage, a looser one after a block, the note; the API’s words mapped', () => {
    const colour = freezeRows(freezeList()).find((row) => row.field === 'COLOURWAY')!
    expect(freezeDraftProblem(colour, { ...blankFreezeDraft('COLOURWAY'), frozenFrom: 'RELEASED' })).toBe('limits.freeze.problem.twin')
    expect(freezeDraftProblem(colour, { ...blankFreezeDraft('COLOURWAY'), frozenFrom: 'SEWING', action: 'CHANGE_REQUEST' })).toBe('limits.freeze.problem.loosens')
    expect(freezeDraftProblem(colour, { ...blankFreezeDraft('COLOURWAY'), frozenFrom: 'SEWING', action: 'BLOCKED', note: 'x'.repeat(201) })).toBe('limits.freeze.problem.note')
    expect(freezeDraftProblem(colour, { ...blankFreezeDraft('COLOURWAY'), frozenFrom: 'SEWING', action: 'BLOCKED' })).toBeNull()
    expect(freezeProblemOf(apiError('conflict', 409, 'This customer has an active rule for the colourway from "sewing started" already: switch it off or change it.'))).toBe('limits.freeze.problem.twin')
    expect(freezeProblemOf(apiError('conflict', 409, 'The colourway cannot be opened again for a change request at a later stage than a block.'))).toBe('limits.freeze.problem.loosens')
    expect(freezeProblemOf(apiError('not_found', 404, 'Customer not found.'))).toBe('problem.notFound')
  })

  it('the card draws both sides in words; without the right every Set… is held', () => {
    const text = textOf(card(limitsModel()))
    expect(text).toContain('Sizes and quantities')
    expect(text).toContain('Cutting started: a priced change they accept')
    expect(text).toContain('Sewing started: no change any more')
    expect(text).toContain('Released to production: no change any more')
    expect(text).toContain('Follows the company')
    expect(textOf(card(limitsModel({ freeze: { status: 'ready', list: freezeList({ mayManage: false }) } })))).toContain("Needs the right: Set customers' production limits.")
  })
})

describe('F-PR-07 — the card on screen', () => {
  it('the defaults in both languages: four levels (Status only chosen), Urgent orders off, the asks, who answers, the second person', () => {
    const en = textOf(card(limitsModel()))
    for (const words of ['What Moda Demo sees', 'Status only', '+ Progress', '+ Gates & dates', '+ Quality & photos', 'Urgent orders', 'Ask to pause', 'Ask for another sample round', 'Anyone with the Production role', 'One named person', 'PP sample, size set, top of production, fabric and trims', 'Overrides need a second person', 'Production partner', 'Open My production as Moda Demo'])
      expect(en, words).toContain(words)
    const it = textOf(card(limitsModel(), 'it'))
    for (const words of ['Cosa vede Moda Demo', 'Solo lo stato', 'Ordini urgenti', 'Supervisore di produzione', 'Partner di produzione', 'Solo ufficio']) expect(it, words).toContain(words)
  })

  it('the level titles are the domain’s words; the freeze stages too (one source)', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['portal-access']!
      for (const [level, said] of Object.entries(LEVEL_WORDS)) expect(words[`limits.level.${level}`], `${locale} ${level}`).toBe(said[locale])
      for (const stage of ORDER_FREEZE_STAGES) expect(words[`limits.freeze.stage.${stage}`], `${locale} ${stage}`).toBe(STAGE_WORDS[stage][locale])
    }
  })

  it('read only: every limit held with the right it needs; the warning when their roles leave Production out', () => {
    const text = textOf(card(limitsModel({ read: productionLimits({}, false) }), 'en', { preview: false }))
    expect(text).toContain("Needs the right: Set customers' production limits.")
    expect(limitsHeld(productionLimits({}, false))).toBe('right.productionManage')
    const warned = textOf(card(limitsModel({ read: productionLimits({ productionRoleOffered: false, productionRoleWords: { en: "The Production role is not among this customer's allowed roles: add it to give it to someone.", it: 'x' } }) })))
    expect(warned).toContain("The Production role is not among this customer's allowed roles")
  })

  it('"Open My production as …" opens the customer’s My production, held while unsaved and without the preview right', () => {
    expect(productionPreviewAddress('BRAND-BETA')).toBe('/p/BRAND-BETA/production')
    expect(productionPreviewHeld({ preview: true }, false)).toBeNull()
    expect(productionPreviewHeld({ preview: true }, true)).toBe('limits.preview.saveFirst')
    expect(productionPreviewHeld({ preview: false }, false)).toBe('right.preview')
  })

  it('a failed read says so with Try again; loading is not drawn as empty', () => {
    expect(textOf(card(limitsModel({ state: 'error', read: null, problem: 'problem.unavailable' })))).toContain('The production limits could not be read.')
    expect(textOf(card(limitsModel({ state: 'loading', read: null })))).not.toContain('Status only')
  })

  it('every design case of the card, in both languages: no word left as a key', () => {
    const PREFIXES = ['limits', 'done', 'stepUp', 'right', 'held', 'problem', 'skip', 'dialog', 'fact', 'settings', 'preview', 'common']
    for (const item of designScreen.cases) {
      const limits = item.model.limits
      if (!limits) continue
      for (const locale of ['it', 'en'] as const) expect(leftKeys(card(limits, locale, { portalOn: item.model.access?.settings.portalOn ?? true }), PREFIXES), `${item.id} (${locale})`).toEqual([])
    }
  })

  it('every new word in both languages with the same placeholders', () => {
    const en = CATALOGUE.en['portal-access']!
    const it = CATALOGUE.it['portal-access']!
    const mine = Object.keys(en).filter((key) => key.startsWith('limits.') || ['stepUp.sentence.production', 'right.productionManage'].includes(key) || /^done\.(production|supervisor|productionAndSupervisor|freeze|freezeReset|previewProduction)$/.test(key))
    expect(mine.length).toBeGreaterThan(100)
    for (const key of mine) {
      expect(it[key], key).toBeTruthy()
      expect((it[key]!.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((en[key]!.match(/\{\w+\}/g) ?? []).sort())
    }
    // The old production-progress switch is gone with its words (the card replaces it in place).
    expect(en['settings.progress']).toBeUndefined()
    expect(it['settings.progressHint']).toBeUndefined()
  })
})

describe('F-PR-07 — the brand wall (web side)', () => {
  it('PW-S01 / PW-08b: Brand Beta’s card names nothing of Brand Alpha, in both languages and every state', () => {
    const beta: PartnerPerson = { ...CUSTOMER_PEOPLE[1]!, id: 'beta-person', displayName: BRAND_BETA.portalPerson.name, email: BRAND_BETA.portalPerson.email }
    const limits = productionLimits({ approver: { id: beta.id, name: beta.displayName, active: true }, supervisor: { id: OFFICE_PEOPLE.bea.id, name: OFFICE_PEOPLE.bea.name, active: true } })
    const model = limitsModel({ read: { ...limits, party: { ...limits.party, id: BRAND_BETA.ids.order, code: BRAND_BETA.code, name: BRAND_BETA.tradeName } } })
    for (const locale of ['it', 'en'] as const) {
      for (const html of [card(model, locale, { partyName: BRAND_BETA.tradeName, people: [beta] }), card(limitsModel({ state: 'error', read: null, problem: 'problem.notFound' }), locale, { partyName: BRAND_BETA.tradeName })]) {
        expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      }
    }
  })

  it('PW-15: no portal screen, catalogue or portal read ever carries a supervisor (the preview opens the portal: it has none to show)', () => {
    const portal = here('../../../../../portal')
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]))
    const sources = files(portal).filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path))
    expect(sources.length).toBeGreaterThan(20)
    for (const path of sources) expect(readFileSync(path, 'utf8'), path).not.toMatch(/supervisor|supervisore|backupId|productionApprover/i)
    for (const locale of ['it', 'en'] as const)
      for (const [namespace, words] of Object.entries(CATALOGUE[locale]).filter(([name]) => name.startsWith('portal') && name !== 'portal-access'))
        for (const value of Object.values(words)) expect(value, `${locale} ${namespace}`).not.toMatch(/supervisor|supervisore/i)
    // The limits card is the office's only: its supervisor block never reaches the settings event or a partner live entry (the API's
    // PW-15 test); on screen it is the one block marked "Office only".
    expect(textOf(card(limitsModel()))).toContain('Office only')
  })
})
