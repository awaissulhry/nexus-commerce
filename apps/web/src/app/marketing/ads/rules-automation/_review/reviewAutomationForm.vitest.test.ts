/**
 * The rules builder's review automation: Edit on Reviews › Settings › Automations opens this builder page (a real page,
 * a Reviews page for permissions), the form reads the rule as stored and sends it back as it was, what is wrong is said
 * in words per field, and the builder draws every field of the trigger, the action and the limit (rendered HTML, node
 * SSR) — held, not editable, when the API says a part cannot be drawn.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { navPagePermission } from '@/lib/auth/nav-permissions'
import { reviewAutomationEditHref } from '@/app/marketing/reviews/_lib/reviewsLinks'
import { EditCell } from '@/app/marketing/reviews/settings/_settings/AutomationsSection'
import { automationWords, type AutomationRule } from '@/app/marketing/reviews/settings/_settings/settingsModel'
import { ReviewAutomationFields } from './ReviewAutomationFields'
import {
  EVERY_MARKET, REVIEW_AUTOMATION_SLUG, formFromView, formKey, formProblems, formToBody, readDecimal, spikeCheckWords, switchWords,
  type ReviewAutomationRead, type ReviewAutomationView,
} from './reviewAutomationForm'

const APLUS: ReviewAutomationView = {
  name: 'Create A+ module from review spike', themes: [], minMultiplier: 2.5, families: [], market: null,
  does: 'aplus', tellTeam: true, message: 'A+ module draft generated from review spike', maxPerDay: 10,
}
const READ: ReviewAutomationRead = {
  rule: { id: 'rule-1', name: APLUS.name, enabled: false, dryRun: true, lastEvaluatedAt: null, updatedAt: '2026-10-27T10:00:00.000Z' },
  view: APLUS, kept: [], whenHeld: null, thenHeld: null,
  spikeCheck: { multiplier: 2, minNegative: 3, recentDays: 7, baselineDays: 28 },
  options: {
    themes: [{ value: 'FIT_SIZING', label: 'Fit & sizing' }, { value: 'COMFORT', label: 'Comfort' }],
    markets: [{ value: 'DE', label: 'Germany' }, { value: 'IT', label: 'Italy' }],
    products: [{ value: 'test-jacket', label: 'Test jacket', sku: 'TEST-JKT' }],
  },
}

describe('Edit opens the rules builder', () => {
  it('the link is the builder page for this rule, a real page, gated as a Reviews page', () => {
    const href = reviewAutomationEditHref('rule-1')
    expect(href).toBe(`/marketing/ads/rules-automation/builder/${REVIEW_AUTOMATION_SLUG}?ruleId=rule-1`)
    expect(existsSync(join(import.meta.dirname, '..', 'builder', '[type]', 'page.tsx'))).toBe(true)
    expect(navPagePermission(href.split('?')[0])).toBe('pages.reviews')
    expect(navPagePermission('/marketing/ads/rules-automation/builder/bid')).toBe('pages.advertising')
  })

  it('the Edit cell is that link, named after the rule; held with its reason for a person who may not manage', () => {
    const rule = { id: 'rule-1', name: APLUS.name } as AutomationRule
    const html = renderToStaticMarkup(createElement(EditCell, { data: rule, context: { manageHeld: null, onToggle: () => undefined } }))
    expect(html).toMatch(/<a [^>]*href="[^"]*\/marketing\/ads\/rules-automation\/builder\/review-automation\?ruleId=rule-1"/)
    expect(html).toContain(`aria-label="Edit ${APLUS.name}"`)
    expect(html).not.toMatch(/coming later|later update/i)
    const held = renderToStaticMarkup(createElement(EditCell, { data: rule, context: { manageHeld: 'You can view review settings but not change them.', onToggle: () => undefined } }))
    expect(held).not.toMatch(/<a /)
    expect(held).toContain('aria-description="You can view review settings but not change them."')
  })

  it('the list says what an edited automation does now; a loaded template keeps its own words', () => {
    expect(automationWords({ name: APLUS.name, description: 'old', words: 'When complaints about comfort rise …' })).toBe('When complaints about comfort rise …')
    expect(automationWords({ name: APLUS.name, description: 'old', words: null })).toMatch(/^When complaints about one theme rise 2\.5 times faster/)
  })
})

describe('the form', () => {
  it('reads the rule as stored and sends it back as it was', () => {
    const form = formFromView(APLUS)
    expect(form).toMatchObject({ speed: 'atLeast', multiplier: '2.5', products: 'every', market: EVERY_MARKET, does: 'aplus', tellTeam: true, maxPerDay: '10' })
    const { updatedAt, ...body } = formToBody(form, READ.rule.updatedAt)
    expect(updatedAt).toBe(READ.rule.updatedAt)
    expect(body).toEqual(APLUS)
    expect(formKey(formFromView({ ...APLUS }))).toBe(formKey(form))
  })

  it('a change is a change; a decimal comma reads; every product sends none; telling the team off keeps its words out of the key', () => {
    const form = formFromView(APLUS)
    expect(formKey({ ...form, themes: ['COMFORT'] })).not.toBe(formKey(form))
    expect(readDecimal('3,5')).toBe(3.5)
    expect(readDecimal('3x')).toBeNaN()
    expect(formToBody({ ...form, products: 'every', families: ['test-jacket'], market: 'DE' }, '')).toMatchObject({ families: [], market: 'DE' })
    expect(formKey({ ...form, tellTeam: false, message: 'a' })).toBe(formKey({ ...form, tellTeam: false, message: 'b' }))
  })

  it('what is wrong, per field, in words', () => {
    const form = formFromView(APLUS)
    expect(formProblems(form)).toEqual({})
    expect(formProblems({ ...form, name: ' ', multiplier: '0.5', products: 'only', families: [], message: '', maxPerDay: '0' })).toEqual({
      name: 'Give the automation a name.',
      multiplier: 'A number from 1 to 50: 2.5 means two and a half times faster than usual.',
      families: 'Pick at least one product, or choose every product.',
      message: 'Write what the team is told.',
      maxPerDay: 'A whole number from 1 to 500.',
    })
    // An AI draft without telling the team needs no words for the team.
    expect(formProblems({ ...form, tellTeam: false, message: '' })).toEqual({})
  })

  it('the check’s own bar and the switch, in words', () => {
    expect(spikeCheckWords(READ.spikeCheck)).toBe('The check raises an alert when, for one product in one market, reviews about a theme in the last 7 days are negative at least 2 times as often as over the last 28 days, with at least 3 negative ones.')
    expect(switchWords({ enabled: false, dryRun: true })).toBe('It is off, in trial run: it records what it would do and changes nothing. Saving here keeps that as it is; the on / off switch is on Reviews › Settings › Automations.')
  })
})

describe('the builder draws every field', () => {
  const html = (read: ReviewAutomationRead = READ, over: Partial<ReturnType<typeof formFromView>> = {}, problems = {}) =>
    renderToStaticMarkup(createElement(ReviewAutomationFields, { read, form: { ...formFromView(read.view), ...over }, problems, onChange: () => undefined }))

  it('name, trigger settings (themes, how fast, products, market), action, what the team is told, the daily limit', () => {
    const markup = html(READ, { products: 'only', families: ['test-jacket'] })
    for (const id of ['rvb-name', 'rvb-trigger', 'rvb-action', 'rvb-limit']) expect(markup).toContain(`id="${id}"`)
    for (const words of [
      'Rule Name', 'Themes', 'Every theme', 'How fast complaints must rise', 'Every alert the check raises', 'Only when complaints rise faster still',
      'Times as often as usual, at least', 'Only these products', 'Test jacket · TEST-JKT', 'Market', 'Every market',
      'Tell the team', 'Draft new bullet points', 'Draft an A+ module', 'Also tell the team', 'What the team is told', 'At most, times a day',
    ]) expect(markup).toContain(words)
    expect(markup).toMatch(/<input[^>]*type="radio"[^>]*name="rvb-does"[^>]*checked=""/)
    expect(markup).not.toMatch(/coming later|sample/i)
  })

  it('a field’s problem is said beside it; a held part is shown with why, out of reach, and kept', () => {
    expect(html(READ, { multiplier: '0' }, { multiplier: 'A number from 1 to 50: 2.5 means two and a half times faster than usual.' })).toContain('A number from 1 to 50')
    const held = html({ ...READ, whenHeld: 'Its conditions are grouped (and / or / not), which the builder cannot show. They are kept as they are.', thenHeld: 'Its actions are not ones the builder can draw. They are kept as they are.', kept: [] })
    expect(held).toContain('The trigger is kept as it is')
    expect(held).toContain('The action is kept as it is')
    expect((held.match(/ inert=""/g) ?? []).length).toBe(2)
    const kept = html({ ...READ, kept: ['spike.rate7dNumerator ≥ 3'] })
    expect(kept).toContain('Also kept as it is')
    expect(kept).toContain('spike.rate7dNumerator ≥ 3')
  })
})
