import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { OrderProduction } from '../overview/api'
import type { OrderIssue } from './api'
import { finalChecksOf, ncrsOf, qualityVerdictOf, waitingAnswersOf } from './problems'
// F-SC-W7: the gate rows' anchors — each its gate's own id, never shared
import { createElement } from 'react'
import { render } from '../../../../../lib/record-thread/parts/testing'
import { gateAnchorsOf, gateIdOf } from '../links/model'
import { LINKS_FULL, LINKS_MANAGER, linksModel } from '../links/fixtures'
import { GateRows } from '../links/view/OrderLinks'

// F-PT-301 / F-PT-302 (order PRODUCTION tab, W3): Problems & holds — what waits for an answer, the quality in plain words.

const w = (en: string, it: string) => ({ en, it })
const issue = (over: Partial<OrderIssue> = {}): OrderIssue => ({
  id: 'i1',
  source: 'OFFICE',
  sourceWords: w('Question for production', 'Domanda per la produzione'),
  status: 'OPEN',
  record: { type: 'SalesOrder', id: 'so1', label: 'SEED-SO-0002' },
  raisedAt: '2026-11-20T15:20:00Z',
  dueOn: '2026-11-23',
  answeredAt: null,
  escalation: null,
  task: { id: 't1', assignee: 'SOMEONE_ELSE' },
  batch: null,
  excerpt: 'Where is SEED-SO-0002 now?\nThe customer asks.',
  messageId: 'm1',
  askedBy: { id: 'u1', name: 'Sara Prova' },
  reply: null,
  ...over,
})
type Final = NonNullable<NonNullable<OrderProduction['quality']>['final']>[number]
const final = (over: Partial<Final> = {}): Final => ({ workOrderId: 'w1', number: 'FI-2026-0088', status: 'PASSED', sampleSize: 8, on: '2026-11-18', ...over })

describe('F-PT-302: what needs an answer (the ONE issues list, B31)', () => {
  it('open ones only, the most due first: kind, on which work order, who asked, the first line, late, escalated, who answers', () => {
    const list = waitingAnswersOf(
      [
        issue({ id: 'later' }),
        issue({ id: 'answered', status: 'ANSWERED', answeredAt: '2026-11-20T16:00:00Z' }),
        issue({ id: 'late', dueOn: '2026-11-19', source: 'BRAND', sourceWords: w('Reported by the customer', 'Segnalato dal cliente'), record: { type: 'WorkOrder', id: 'wo1', label: 'SEED-WO-0411' }, escalation: { step: 1, at: '2026-11-19T07:00:00Z', words: w('now with the backup', 'ora al sostituto') }, task: null }),
      ],
      '2026-11-21',
    )
    expect(list.map((entry) => entry.id)).toEqual(['late', 'later'])
    expect(list[0]).toMatchObject({ source: 'BRAND', workOrder: 'SEED-WO-0411', late: true, escalated: w('now with the backup', 'ora al sostituto'), answers: null })
    expect(list[1]).toMatchObject({ workOrder: null, by: 'Sara Prova', late: false, escalated: null, answers: 'SOMEONE_ELSE', excerpt: 'Where is SEED-SO-0002 now?', messageId: 'm1' })
    expect(waitingAnswersOf(null, '2026-11-21')).toEqual([])
  })
})

describe('F-PT-302: the quality in plain words', () => {
  it('each final check its own row (B28), the newest first, with inspected of the lot and its defects; the verdict first', () => {
    const checks = finalChecksOf([final({ id: 'a', status: 'FAILED', on: '2026-11-15' }), final({ id: 'b', on: '2026-11-18', lotSize: 40, inspectedCount: 8, defects: { critical: 0, major: 1, minor: 2 } })])!
    expect(checks.map((check) => [check.key, check.status])).toEqual([
      ['b', 'PASSED'],
      ['a', 'FAILED'],
    ])
    expect(checks.map((check) => check.inspectionId)).toEqual(['b', 'a'])
    expect(checks[0]).toMatchObject({ inspected: 8, lot: 40, defects: { critical: 0, major: 1, minor: 2 }, shared: false })
    expect(checks[1]).toMatchObject({ inspected: null, lot: null, defects: null })
    expect(qualityVerdictOf(checks)).toBe('FAILED')
    expect(qualityVerdictOf(finalChecksOf([final({ status: 'OPEN', on: null }), final()]))).toBe('WAITING')
    expect(qualityVerdictOf(finalChecksOf([final()]))).toBe('PASSED')
    expect(qualityVerdictOf(finalChecksOf([]))).toBeNull()
    expect(finalChecksOf(null)).toBeNull()
  })

  it('the NCRs the most severe first', () => {
    const ncr = (number: string, severity: string) => ({ id: number, number, stage: 'OPEN', severity, sharedWorkOrder: false })
    expect(ncrsOf([ncr('NCR-2', 'MINOR'), ncr('NCR-10', 'CRITICAL'), ncr('NCR-1', 'MINOR')])!.map((row) => row.number)).toEqual(['NCR-10', 'NCR-1', 'NCR-2'])
    expect(ncrsOf(null)).toBeNull()
  })
})

describe('F-PT-301: one strip rule on both tabs', () => {
  it('Problems & holds draws Overview’s own strips and doors (StripRow, whereStripsOf, stripDoorsOf), never a second rule', () => {
    const view = readFileSync(new URL('../view/production/ProblemsSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain("import { CREDIT_NS, StripRow } from '../overview/StripRow'")
    expect(view).toContain('whereStripsOf(order, read, approval, waiting)')
    expect(view).toContain('stripDoorsOf(strip, input)')
    expect(view).toContain('<Section id="holds"')
    expect(readFileSync(new URL('../view/overview/WhereCard.tsx', import.meta.url), 'utf8')).toContain("import { CREDIT_NS, StripRow } from './StripRow'")
    // F-CO-K2: and that ONE row is the shared overview kit's strip — both tabs still draw one row.
    expect(readFileSync(new URL('../view/overview/StripRow.tsx', import.meta.url), 'utf8')).toContain('<Strip tone={toneOf(strip, model.today)} mark={MARK[strip.kind]} ')
    // B-PT-018: the tab no longer reads quality.issues (the ONE issues list instead).
    expect(view).not.toContain('quality?.issues')
    // F-PT-302: Raise a nonconformance… is Quality's own New NCR from the inspection, only with quality.ncr.raise.
    expect(view).toContain("newNcrAddress(model.prefix, 'Inspection', raiseFrom)")
    expect(view).toContain('model.can.raiseNcr')
  })

  it('F-SC-W4: the gates that stop the order are Problems & holds rows (the notice\'s own parts), and the notice stays on top of every tab', () => {
    const view = readFileSync(new URL('../view/production/ProblemsSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain("import { GateRows } from '../../links/view/OrderLinks'")
    expect(view).toContain('<GateRows model={model.links} prefix={model.prefix} />')
    expect(view).toContain('const stops = strips.length + gates')
    expect(view).toContain("t('productionTab.problems.stops', { count: stops })")
    const links = readFileSync(new URL('../links/view/OrderLinks.tsx', import.meta.url), 'utf8')
    // One title, one sentence, one door for the notice and the row (never a second copy of their words).
    expect(links.match(/t\('links\.gate\.title'/g)?.length).toBe(1)
    expect(links.match(/t\('links\.gate\.open'\)/g)?.length).toBe(1)
    // F-CO-K2: the row is the kit's Strip — its anchor is the row's id (the kit's part draws `id={anchor}`).
    expect(links).toContain('anchor={anchors[index]}')
    expect(readFileSync(new URL('../../../../../lib/record-overview/Overview.tsx', import.meta.url), 'utf8')).toContain('id={anchor} tabIndex={anchor === undefined ? undefined : -1}')
    // The page notice: drawn for every tab (no tab condition in front of it), inside the page's notices.
    const page = readFileSync(new URL('../view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/\n\s*<GateNotices model=\{model\.links\} prefix=\{model\.prefix\} \/>/)
    expect(page.match(/<GateNotices /g)?.length).toBe(1)
  })

  it('F-SC-W7: each gate row\'s anchor carries the gate\'s own id — about-GateEvent-<id> — and two gates on one work order never share one', () => {
    const base = LINKS_FULL.gates[0]!
    expect(gateAnchorsOf([base])).toEqual([`about-GateEvent-${base.eventId}`])
    // Without the compliance view right the event's id is not sent: the gate's own gate, subject and instant make its id.
    const label = { ...base, eventId: null, gate: 'LABEL_PRINT' as const, at: '2026-11-15T14:30:00.000Z' }
    const release = { ...base, eventId: null }
    expect(gateIdOf(release)).toBe(`${base.subject.id}-WORK_ORDER_RELEASE-${Date.parse(base.at)}`)
    const two = gateAnchorsOf([release, label])
    expect(new Set(two).size).toBe(2)
    for (const anchor of two) expect(anchor).toMatch(/^about-GateEvent-[\w-]+$/)
    // Even the same gate twice at the same instant: never one anchor for two rows.
    expect(new Set(gateAnchorsOf([release, release, release])).size).toBe(3)
    // Drawn: two gates on one work order, words only — two rows, two ids.
    const html = render(createElement('ul', null, createElement(GateRows, { model: linksModel({ ...LINKS_MANAGER, gates: [release, label] }), prefix: '/w/demo' })), 'en')
    const ids = [...html.matchAll(/id="(about-GateEvent-[^"]+)"/g)].map((match) => match[1])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('its words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['title', 'stopsNothing', 'noQuestions', 'final.PASSED', 'final.FAILED', 'final.WAITING', 'final.none', 'stopsTitle', 'answersTitle', 'late', 'answers.ME', 'answers.SOMEONE_ELSE', 'answers.NOT_SET', 'reply', 'qualityTitle', 'sharedCheck', 'qualityWithheld', 'noFinal', 'infoBody', 'raiseNcr'] /* liftHint: the strip's own line now (StripRow, wo.heldHold — both tabs) */) expect(t(`productionTab.problems.${key}`), `${locale} ${key}`).not.toBe(`productionTab.problems.${key}`)
      expect(t('productionTab.problems.stops', { count: 1 }), locale).toMatch(/1/)
      expect(t('productionTab.problems.defects', { critical: 0, major: 1, minor: 2 }), locale).toMatch(/0.*1.*2/)
      expect(t('productionTab.problems.inspected', { inspected: 5, lot: 40 }), locale).toMatch(/5.*40/)
      expect(t('productionTab.now.answeredForMore', { orders: 'SEED-SO-0090', count: 1 }), locale).toMatch(/SEED-SO-0090.*1/)
    }
  })
})
