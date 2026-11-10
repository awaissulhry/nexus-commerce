import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { LOCALES } from '../../../../lib/i18n/locales'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { RECORD_PAGES } from '../../../../lib/records/record-links'
import { ROLE_PERMISSIONS } from '../../../quality/_shared/fixtures'
import { designScreen as declarationsScreen } from '../declarations/fixtures'
import { designScreen as declarationScreen } from '../declarations/record/fixtures'
import {
  acceptHeld,
  activityOf,
  askAgainHeld,
  askBodyOf,
  askFieldProblems,
  blankAsk,
  declarationsAddressOf,
  declarationsAddressText,
  declarationsCan,
  decisionChecks,
  dueWordOf,
  groupWordsKey,
  previewHeld,
  remindHeld,
  sendHeld,
  sendLabel,
  suggestedKinds,
  writeProblemKey,
} from '../declarations/model'
import { designScreen as cardScreen } from '../profiles/card/fixtures'
import { designScreen as profilesScreen } from '../profiles/fixtures'
import { gapKeys, profileChanges, profileDraftProblems, profilesAddressOf, profilesAddressText, toAsk } from '../profiles/model'
import { demoAskReview, demoDetail, demoProfileRecord, PLANS, PROFILES, REQUESTS, RULES, SUBSTANCES, VERSIONS } from './_demo/fixtures'
import { designScreen as substancesScreen } from './fixtures'
import { activeDepthTile, depthViewOf, tileHref, viewHref, viewOfKey } from './frame/views'
import { blankPlan, blankVersion, limitOf, offReasonProblem, planChanges, planDraftOf, planDraftProblems, sourceKeys, substancesAddressOf, substancesAddressText, versionProblems } from './model'
import { ApiError } from '../../../../lib/api/errors'

const params = (text: string) => new URLSearchParams(text)
const owner = declarationsCan([...ROLE_PERMISSIONS.owner])
const readOnly = declarationsCan([...ROLE_PERMISSIONS.readOnly])

describe('the views of Tests & substances (sec:ts-views)', () => {
  it('a W2b view is named by ?view=; every other address is Lot tests with W1’s own saved filters', () => {
    expect(depthViewOf(params('view=declarations'))).toBe('declarations')
    expect(depthViewOf(params('view=substances&part=plans'))).toBe('substances')
    expect(depthViewOf(params('view=onHold'))).toBeNull()
    expect(depthViewOf(params(''))).toBeNull()
    expect(viewHref('/w/DEMO', 'lots')).toBe('/w/DEMO/compliance/tests')
    expect(viewHref('/w/DEMO', 'profiles')).toBe('/w/DEMO/compliance/tests?view=profiles')
    expect(viewOfKey('1')).toBe('lots')
    expect(viewOfKey('4')).toBe('substances')
    expect(viewOfKey('5')).toBeNull()
  })

  it('a tile is a filter on its view, pressed while the address shows it', () => {
    expect(tileHref('/w/DEMO', 'declarationsOverdue')).toBe('/w/DEMO/compliance/tests?view=declarations&shown=OVERDUE')
    expect(tileHref('/w/DEMO', 'profilesIncomplete')).toBe('/w/DEMO/compliance/tests?view=profiles&state=INCOMPLETE')
    expect(activeDepthTile(params('view=declarations&shown=REREQUEST_NEEDED'))).toBe('rerequest')
    expect(activeDepthTile(params('view=declarations'))).toBeNull()
  })

  it('a supplier declaration opens its DetailModal; a profile the material’s Compliance tab', () => {
    expect(RECORD_PAGES.SupplierDeclarationRequest).toBe('/compliance/tests?view=declarations&open=[id]')
    expect(RECORD_PAGES.MaterialComplianceProfile).toBe('/products/materials/[id]?tab=compliance')
  })
})

describe('Supplier declarations (sec:ts-decl, the record, pop:ts-request)', () => {
  it('the address round-trips: the API’s filters, the record and its tab, the dialog with its prefill', () => {
    const address = declarationsAddressOf(params('view=declarations&shown=OVERDUE&kind=NICKEL&q=zip&open=r1&tab=decision&ask=1&items=a,b&kinds=RSL,BOGUS'))
    expect(address).toMatchObject({ shown: 'OVERDUE', kind: 'NICKEL', q: 'zip', open: 'r1', tab: 'decision', ask: true, items: ['a', 'b'], kinds: ['RSL'] })
    expect(declarationsAddressText(address)).toBe('?view=declarations&shown=OVERDUE&kind=NICKEL&q=zip&open=r1&tab=decision&ask=1&items=a%2Cb&kinds=RSL')
    expect(declarationsAddressOf(params('shown=NOPE&tab=nope')).shown).toBeNull()
  })

  it('every verb waits with its reason: the right, the state, the lines, the supplier’s document', () => {
    const [waiting, overdue, answeredUpload, answeredOffice, rerequest] = REQUESTS
    expect(remindHeld(overdue!, owner)).toBeNull()
    expect(remindHeld(answeredOffice!, owner)?.key).toBe('held.remindNotWaiting')
    expect(remindHeld(waiting!, readOnly)?.key).toBe('held.manage')
    expect(remindHeld(waiting!, owner, false)?.key).toBe('held.offline')
    expect(acceptHeld(answeredUpload!, owner)).toEqual({ key: 'held.acceptLines', params: { count: 1 } })
    expect(acceptHeld(answeredOffice!, owner)).toBeNull()
    expect(acceptHeld(waiting!, owner)?.key).toBe('held.acceptNotAnswered')
    expect(acceptHeld({ ...answeredOffice!, file: { source: 'UPLOAD', uploadId: 'u', fileId: 'f', uploadStatus: 'REFUSED' } }, owner)?.key).toBe('held.uploadRefused')
    expect(askAgainHeld(answeredOffice!, owner)?.key).toBe('held.askAgainAnswered')
    expect(askAgainHeld(rerequest!, owner)).toBeNull()
    expect(previewHeld(answeredOffice!, owner)?.key).toBe('held.previewOffice')
    expect(previewHeld(waiting!, declarationsCan(['compliance.certificates.view']))?.key).toBe('held.preview')
  })

  it('the Due column counts down while it waits, says how late, or just the day', () => {
    expect(dueWordOf(REQUESTS[0]!).kind).toBe('countdown')
    expect(dueWordOf(REQUESTS[1]!)).toEqual({ kind: 'late', days: 9 })
    expect(dueWordOf(REQUESTS[5]!).kind).toBe('day')
  })

  it('the decision’s checks say what is still open, in words', () => {
    const checks = decisionChecks(demoDetail(REQUESTS[2]!))
    expect(checks.map((check) => [check.id, check.state])).toEqual([
      ['answered', 'OK'],
      ['lines', 'OPEN'],
      ['document', 'OK'],
    ])
    const svhc = decisionChecks(demoDetail(REQUESTS[4]!))
    expect(svhc.find((check) => check.id === 'list')).toMatchObject({ state: 'OPEN', key: 'decision.check.listOld' })
  })

  it('the Activity is told from the request’s facts, oldest first, then what is still to come', () => {
    const steps = activityOf(demoDetail(REQUESTS[1]!))
    expect(steps.map((step) => step.id)).toEqual(['sent', 'reminded', 'overdue', 'waitAnswer'])
    expect(activityOf(demoDetail(REQUESTS[5]!)).map((step) => step.id)).toEqual(['sent', 'answered', 'decided'])
  })

  it('Request declarations: the body, the suggested kinds, the problems, the review in our words', () => {
    const options = PROFILES.map((row) => ({ itemId: row.material.id, code: row.material.code, name: row.material.name, kind: row.material.kind, supplier: row.supplier, missing: toAsk(row) }))
    expect(suggestedKinds(options, [PROFILES[3]!.material.id])).toEqual(['RSL'])
    const draft = { ...blankAsk('2026-10-29', ['m1'], ['RSL']), reminderEveryDays: '', channel: 'OFFICE' as const }
    expect(askBodyOf(draft)).toEqual({ materials: [{ itemId: 'm1' }], kinds: ['RSL'], dueOn: '2026-11-28', reminderEveryDays: null, message: null, channel: 'OFFICE' })
    expect(askFieldProblems(blankAsk('2026-10-29'), '2026-10-29')).toMatchObject({ materials: 'ask.problem.materials', kinds: 'ask.problem.kinds' })
    expect(askFieldProblems({ ...draft, dueOn: '2026-10-01' }, '2026-10-29').dueOn).toBe('ask.problem.duePast')
    const review = demoAskReview()
    expect(review.groups.map((group) => groupWordsKey(group, review))).toEqual(['ask.group.add', 'ask.group.sendPortal', 'ask.group.sendOffice', 'ask.group.skipAsked'])
    expect(groupWordsKey({ ...review.groups[1]!, outcome: 'SKIP', kind: 'REACH_SVHC', request: null }, { svhcListVersion: null })).toBe('ask.group.skipNoList')
    expect(sendLabel(review)).toEqual({ key: 'ask.sendAndAdd', params: { send: 2, add: 1 } })
    expect(sendHeld({ ...review, counts: { send: 0, add: 0, skip: 2 } }, owner)?.key).toBe('held.nothingToAsk')
  })

  it('a refusal is said in our words by the verb and the kind of failure, never the API’s English', () => {
    expect(writeProblemKey('accept', new ApiError('conflict', 409, 'conflict', 'Every material needs its answer.'))).toBe('problem.accept.conflict')
    expect(writeProblemKey('accept', new Error('x'))).toBe('problem.accept.failed')
  })
})

describe('Material profiles (sec:ts-profiles) and the card', () => {
  it('the address keeps the API’s own filters', () => {
    const address = profilesAddressOf(params('view=profiles&state=INCOMPLETE&kind=LEATHER&q=demo'))
    expect(profilesAddressText(address)).toBe('?view=profiles&state=INCOMPLETE&kind=LEATHER&q=demo')
    expect(profilesAddressOf(params('state=bogus&kind=x1')).state).toBeNull()
  })

  it('what keeps a profile from complete comes from its flags, never from the evaluator’s sentence', () => {
    expect(gapKeys(PROFILES[0]!).map((gap) => gap.key)).toEqual(['gap.tannage', 'gap.declarations', 'gap.asked', 'gap.innocuousMissing'])
    expect(gapKeys(PROFILES[4]!).map((gap) => gap.key)).toContain('gap.never')
    expect(toAsk(PROFILES[0]!)).toEqual(['RSL'])
  })

  it('the edit sends only what changed; the origin is two letters', () => {
    const record = demoProfileRecord()
    expect(profileChanges(record, { compositionConfirmed: true, tannageConfirmed: true, originCountry: 'it', note: '' })).toEqual({ tannageConfirmed: true })
    expect(profileDraftProblems({ compositionConfirmed: true, tannageConfirmed: null, originCountry: 'ITA', note: '' }).originCountry).toBe('card.problem.origin')
  })
})

describe('the Substance list, its rules and the test plan rules (sec:ts-rsl)', () => {
  it('the address keeps the part and its dialogs', () => {
    const address = substancesAddressOf(params('view=substances&part=plans&plan=new'))
    expect(address).toMatchObject({ part: 'plans', plan: 'new' })
    expect(substancesAddressText(address)).toBe('?view=substances&part=plans&plan=new')
    expect(substancesAddressOf(params('part=nope')).part).toBe('substances')
  })

  it('a limit is said from its figure, unit and bound; a ban without a figure; the source from the entries', () => {
    expect(limitOf(RULES[1]!, 'it')).toEqual({ key: 'limit.atMost', params: { value: '30', unit: 'mg/kg' } })
    expect(limitOf(RULES[2]!, 'it').params?.value).toBe('0,5')
    expect(limitOf(RULES[4]!, 'en')).toEqual({ key: 'limit.ban' })
    expect(sourceKeys(SUBSTANCES[4]!)).toEqual([{ key: 'source.annex', params: { entries: '72' } }, { key: 'list.SVHC' }])
  })

  it('switching off needs the reason; never to the state it is in (the domain’s rule)', () => {
    const rule = RULES[1]!
    expect(offReasonProblem(rule, false, '')).toBe('switch.reasonShort')
    expect(offReasonProblem(rule, false, 'Lab method under review.')).toBeNull()
    expect(offReasonProblem(rule, true, '')).toBe('switch.alreadyOn')
    expect(offReasonProblem(PLANS[4]!, true, '')).toBeNull()
  })

  it('a plan rule: a kind or one material, a market code, an edit sends what changed', () => {
    expect(planDraftProblems({ ...blankPlan(), scope: 'MATERIAL' }, true).itemId).toBe('plan.problem.material')
    expect(planDraftProblems({ ...blankPlan(), marketCode: 'italy!' }, true).marketCode).toBe('plan.problem.market')
    expect(planDraftProblems({ ...blankPlan(), switchedOn: false, offReason: '' }, true).offReason).toBe('switch.reasonShort')
    expect(planChanges(PLANS[1]!, { ...planDraftOf(PLANS[1]!), frequency: 'EVERY_LOT' })).toEqual({ frequency: 'EVERY_LOT' })
    expect(planChanges(PLANS[1]!, { ...planDraftOf(PLANS[1]!), scope: 'MATERIAL', itemId: 'm1' })).toEqual({ itemKind: null, itemId: 'm1' })
  })

  it('a Candidate List version: not in the future, one per day, a whole count', () => {
    expect(versionProblems({ ...blankVersion('2026-10-29'), entryCount: '256' }, '2026-10-29', VERSIONS)).toEqual({})
    expect(versionProblems({ ...blankVersion('2026-10-29'), publishedOn: '2026-07-01', entryCount: '253' }, '2026-10-29', VERSIONS).publishedOn).toBe('version.problem.twice')
    expect(versionProblems({ ...blankVersion('2026-10-29'), publishedOn: '2026-12-01', entryCount: 'x' }, '2026-10-29', VERSIONS)).toMatchObject({ publishedOn: 'version.problem.future', entryCount: 'version.problem.count' })
  })
})

describe('every design case draws in both languages with no key left on screen', () => {
  const keys = new Set<string>()
  for (const namespace of ['compliance-tests-depth', 'lab']) for (const key of Object.keys(CATALOGUE.en[namespace] ?? {})) keys.add(key.replace(/_(one|other)$/, ''))
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  const leftKey = (html: string): string | null => {
    for (const key of keys) {
      if (!key.includes('.')) continue
      const at = html.indexOf(key)
      if (at < 0) continue
      const before = html[at - 1] ?? ' '
      const after = html[at + key.length] ?? ' '
      if (!/[\w.-]/.test(before) && !/[\w.]/.test(after)) return key
    }
    return null
  }
  const screens = [declarationsScreen, declarationScreen, profilesScreen, cardScreen, substancesScreen] as DesignScreen<unknown>[]
  for (const screen of screens) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(screen.screen === 'SCR-048-profile' ? 300 : 500)
          expect(leftKey(html), `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('sales sees no declaration: the permission is named', () => {
    const html = render(declarationsScreen as DesignScreen<unknown>, declarationsScreen.cases.find((item) => item.id === 'no-permission')!.model, 'en')
    expect(html).toContain('compliance.certificates.view')
    expect(html).not.toContain('DEMO-SD-0001')
  })

  it('no money anywhere on these screens (no lab price is kept)', () => {
    for (const screen of screens) for (const item of screen.cases) expect(render(screen, item.model, 'en'), `${screen.screen}/${item.id}`).not.toMatch(/€|EUR\b/)
  })

  it('the evaluator’s English sentence is never on screen', () => {
    for (const screen of [profilesScreen, cardScreen] as DesignScreen<unknown>[]) for (const item of screen.cases) expect(render(screen, item.model, 'en'), item.id).not.toContain('Made-up evaluator words')
  })
})
