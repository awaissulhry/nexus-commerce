import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { StoreError } from '../../../../record-panels/store'
import { SUIT_RULES } from '../../../products/sizes/templates/demo/fixtures'
import { changeCount, draftOf, draftProblems, editRulesHeld, newRuleDraft, rulesBody, saveRulesHeld, saveRulesProblem, withKind } from '../../../products/sizes/templates/rules/model'
import { designScreen as rulesScreen } from '../../../products/sizes/templates/rules/fixtures'
import { designScreen as whereUsedScreen } from '../../../products/sizes/templates/where-used/fixtures'
import { designScreen as filtersScreen } from '../list-filters/fixtures'
import { customerName, rangeTone, rangeWords } from '../list-filters/model'
import { CUSTOMERS, ROLE_PERMISSIONS, ROWS } from '../demo/fixtures'
import { addressOf, addressText, chipsOf, HOME_ADDRESS, mtmCan, queryOf } from '../model'
import { designScreen as threadScreen } from '../thread/fixtures'
import { designScreen as photosScreen, PHOTOS } from './fixtures'
import { dateHeld, dateProblem, deleteLine, EXTRAS_NS, fileProblem, fittingPhotos, photoCount, uploadDateHeld, uploadHeld, uploadProblem } from './model'

/**
 * The made-to-measure office extras (B-W2b-371): the photos' rules (held, the delete date in words, refusals from paths), the list
 * filters (address, query, chips, a row's range), the rule editor (drafts, the PUT body, problems by field, held), and every design
 * case of SCR-036-photos, SCR-036-list-filters, SCR-036-thread, SCR-049-template-rules and SCR-049-template-whereused drawn in Italian
 * and English with no key left on screen.
 */

const owner = mtmCan(ROLE_PERMISSIONS.owner)
const production = mtmCan(ROLE_PERMISSIONS.production)
const api = (kind: ConstructorParameters<typeof ApiError>[0], paths: string[] = []) => new ApiError(kind, 409, kind, 'English.', null, paths.map((path) => ({ path, message: 'English.' })))

describe('photos: held with why, the delete date in words, refusals in our words', () => {
  it('an upload waits for the read, made-to-measure started, the right, the network', () => {
    expect(uploadHeld(null, 'profile', owner, false)?.key).toBe('photo.held.reading')
    expect(uploadHeld({ ...PHOTOS, started: false }, 'profile', owner, false)).toEqual({ key: 'photo.held.off', params: { garment: 'JACKET' } })
    expect(uploadHeld(PHOTOS, 'profile', production, false)?.key).toBe('photo.held.rightRecord')
    expect(uploadHeld(PHOTOS, 'fitting', production, false)).toBeNull()
    expect(uploadHeld(PHOTOS, 'profile', owner, true)?.key).toBe('photo.held.offline')
    expect(uploadHeld(PHOTOS, 'profile', owner, false)).toBeNull()
  })

  it('a picked file: JPEG or PNG up to 15 MB; a delete date from today on', () => {
    expect(fileProblem(null)?.key).toBe('photo.upload.noFile')
    expect(fileProblem({ type: 'image/gif', size: 10 })?.key).toBe('photo.upload.type')
    expect(fileProblem({ type: 'image/jpeg', size: 16 * 1_048_576 })?.key).toBe('photo.upload.size')
    expect(fileProblem({ type: 'image/png', size: 1000 })).toBeNull()
    expect(uploadDateHeld('', '2026-11-13')).toBeNull()
    expect(uploadDateHeld('2026-11-12', '2026-11-13')?.key).toBe('photo.date.problem.past')
    expect(uploadDateHeld('2026-12-01', '2026-11-13')).toBeNull()
  })

  it('says the delete date: a day, within the hour, after shipping', () => {
    expect(deleteLine({ deleteAfter: null, status: 'AVAILABLE' }, '2026-11-13').key).toBe('photo.delete.afterShipping')
    expect(deleteLine({ deleteAfter: '2026-11-13T08:00:00.000Z', status: 'AVAILABLE' }, '2026-11-13').key).toBe('photo.delete.withinHour')
    expect(deleteLine({ deleteAfter: '2026-12-31T23:00:00.000Z', status: 'AVAILABLE' }, '2026-11-13')).toEqual({ key: 'photo.delete.on', params: { date: '2027-01-01' } })
  })

  it('a date move needs the right, a day from today on, why; a deleted photo keeps its date', () => {
    const photo = PHOTOS.revisions[0]!.photos[0]!
    expect(dateHeld({ day: '2026-12-01', reason: 'x' }, photo, '2026-11-13', false, false)?.key).toBe('photo.held.rightDate')
    expect(dateHeld({ day: '2026-11-01', reason: 'x' }, photo, '2026-11-13', true, false)?.key).toBe('photo.date.problem.past')
    expect(dateHeld({ day: '2026-12-01', reason: ' ' }, photo, '2026-11-13', true, false)?.key).toBe('photo.date.problem.reason')
    expect(dateHeld({ day: '2026-12-01', reason: 'x' }, { ...photo, status: 'DELETED' }, '2026-11-13', true, false)?.key).toBe('photo.date.problem.deleted')
    expect(dateHeld({ day: '2026-12-01', reason: 'The rider asked.' }, photo, '2026-11-13', true, false)).toBeNull()
  })

  it('reads a refusal from its path, never the API English', () => {
    expect(uploadProblem(api('conflict', ['held/MTM_NOT_STARTED'])).key).toBe('photo.upload.off')
    expect(uploadProblem(api('conflict', ['held/FULL'])).key).toBe('photo.upload.full')
    expect(uploadProblem(api('invalid', ['body/contentType'])).key).toBe('photo.upload.type')
    expect(uploadProblem(new StoreError(500)).key).toBe('photo.upload.store')
    expect(dateProblem(api('conflict', ['held/STALE'])).key).toBe('photo.date.problem.stale')
    expect(dateProblem(api('conflict', ['held/DELETED'])).key).toBe('photo.date.problem.deleted')
    expect(dateProblem(api('forbidden')).key).toBe('photo.problem.forbidden')
  })

  it('counts the office and fitting photos; a fitting card reads its own', () => {
    expect(photoCount(PHOTOS)).toBe(5)
    expect(photoCount(null)).toBeNull()
    expect(fittingPhotos(PHOTOS, PHOTOS.fittings[0]!.resultId)).toHaveLength(1)
    expect(fittingPhotos(PHOTOS, 'none')).toEqual([])
  })
})

describe('the list filters: outside the range, fittings this week, a customer', () => {
  const customer = CUSTOMERS[0]!.id
  it('keeps the views and the customer in the address, asks the API what they mean', () => {
    const address = addressOf(new URLSearchParams(`view=outside&customer=${customer}`))
    expect(address).toMatchObject({ view: 'outside', customer })
    expect(addressText(address)).toBe(`?view=outside&customer=${customer}`)
    expect(addressOf(new URLSearchParams('customer=not-an-id')).customer).toBeNull()
    expect(queryOf(address)).toMatchObject({ range: 'outside', fittings: null, partyId: customer })
    expect(queryOf({ ...HOME_ADDRESS, view: 'fittings' })).toMatchObject({ range: null, fittings: 'week', partyId: null })
  })

  it('says the customer chip by name once known, and the range of a row', () => {
    expect(chipsOf({ ...HOME_ADDRESS, customer }, CUSTOMERS[0]!.legalName)[0]).toMatchObject({ id: 'customer', label: { key: 'chip.customer', params: { customer: CUSTOMERS[0]!.legalName } } })
    expect(chipsOf({ ...HOME_ADDRESS, customer })[0]!.label.key).toBe('chip.customerUnnamed')
    expect(customerName(CUSTOMERS, ROWS, customer)).toBe(CUSTOMERS[0]!.legalName)
    expect(customerName(null, ROWS, ROWS[0]!.partyId)).toBe(ROWS[0]!.customer.name)
    expect(rangeWords({ inside: null, points: [] }).key).toBe('list.range.unknown')
    expect(rangeWords({ inside: false, points: ['chest', 'sleeve'] })).toEqual({ key: 'list.range.outsidePoints', params: { points: 'chest, sleeve' } })
    expect(rangeTone({ inside: true, points: [] })).toBe('success')
  })
})

describe('the rule editor: typed rules, one PUT, problems by field', () => {
  const draft = draftOf(SUIT_RULES)
  it('reads the rules into a draft and sends them back unchanged (no change to save)', () => {
    expect(draft.rules.map((rule) => rule.code)).toEqual(['INSEAM_LE_OUTSEAM', 'WAIST_TO_CHEST', 'CHEST_RANGE', 'OLD_KNEE'])
    expect(changeCount(SUIT_RULES, draft)).toBe(0)
    const body = rulesBody(draft, SUIT_RULES.template.version)
    expect(body).toMatchObject({ version: SUIT_RULES.template.version, baseSizeRule: { points: ['chest', 'height'], tie: 'LARGER' } })
    expect(body.rules[3]).toMatchObject({ code: 'OLD_KNEE', status: 'ARCHIVED', minValue: '30', maxValue: null, otherPointCode: null })
    expect(saveRulesHeld(SUIT_RULES, draft, false)?.key).toBe('rules.held.nothing')
  })

  it('a kind keeps only its own fields; a new rule is counted; problems sit at their field', () => {
    const ratio = withKind({ ...draft.rules[2]!, minFactor: '1', otherPointCode: 'waist' }, 'ORDER')
    expect(ratio).toMatchObject({ kind: 'ORDER', minValue: '', maxValue: '', minFactor: '' })
    const added = { ...newRuleDraft(SUIT_RULES.points), key: 'n1', code: 'CHEST_RANGE' }
    const twice = { ...draft, rules: [...draft.rules, added] }
    expect(changeCount(SUIT_RULES, twice)).toBe(1)
    const problems = draftProblems(twice, SUIT_RULES.points)
    expect(problems['n1/code']?.key).toBe('rules.problem.code')
    expect(problems['n1/messageI18n']?.key).toBe('rules.problem.words')
    expect(saveRulesHeld(SUIT_RULES, twice, false)).toMatchObject({ key: 'rules.held.fix' })
    const limit = { ...draft, limits: draft.limits.map((entry) => (entry.code === 'chest' ? { ...entry, alterationPlus: '-1' } : entry)) }
    expect(draftProblems(limit, SUIT_RULES.points)['limit/chest/alterationPlus']?.key).toBe('rules.problem.limit')
    const base = { ...draft, basePoints: [] }
    expect(rulesBody(base, 4).baseSizeRule).toBeNull()
  })

  it('a refused save: a moved version reads again, a field named is said there; Edit held without the right', () => {
    expect(saveRulesProblem(api('conflict'), draft)).toMatchObject({ reload: true, notice: { key: 'rules.problem.stale' } })
    const said = saveRulesProblem(api('invalid', ['body/rules/1/minFactor']), draft)
    expect(said.fields[`${draft.rules[1]!.key}/minFactor`]?.key).toBe('rules.problem.factor')
    expect(editRulesHeld(SUIT_RULES, { view: true, manage: false, switch: false })?.key).toBe('rules.held.right')
    expect(editRulesHeld({ ...SUIT_RULES, template: { ...SUIT_RULES.template, status: 'ARCHIVED' } }, { view: true, manage: true, switch: false })?.key).toBe('rules.held.archived')
    expect(editRulesHeld(SUIT_RULES, { view: true, manage: true, switch: false })).toBeNull()
  })
})

describe('the catalogue', () => {
  it('has every key in both languages', () => {
    const keys = (locale: 'it' | 'en') => Object.keys(CATALOGUE[locale][EXTRAS_NS] ?? {}).sort()
    expect(keys('it').length).toBeGreaterThan(100)
    expect(keys('it')).toEqual(keys('en'))
  })
})

const LEFT_KEY = /\b(?:photo|rules|used|list|view|verdict|lifecycle|status|review|range|chip|tile|col|row|held|problem|common|activity|tab|band|mtm|record|kind|severity|switch|points)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [photosScreen, filtersScreen, threadScreen, rulesScreen, whereUsedScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b[\w-]+\.(?:pdf|png|jpg)\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
