/**
 * Reviews › Settings — the page's words from the API's answers: `?section=`, the strip's problem counts, the Sources
 * links, times, the pipeline banner, the automations' last runs, and the unsubscribe list's bulk bar (ruling 7: Remove
 * counts only bounced and hand-added addresses; held when every ticked one is the buyer's own).
 */
import { describe, expect, it } from 'vitest'
import {
  addressProblem, automationLastRun, canRemove, loadTemplatesButton, maskEmail, pipelineSummary, removePlan, removedWords, sectionFlag,
  sectionFromSearch, sourceActionHref, suppressionScope, suppressionWhy, suppressionsCsv, templateLanguagesWords, timeWords,
  visibleSuppressions, type PipelineJob, type SuppressionRow,
} from './settingsModel'

const row = (id: string, source: string, extra: Partial<SuppressionRow> = {}): SuppressionRow =>
  ({ id, email: `${id}@example.test`, channel: null, source, reason: null, createdAt: '2026-10-22T09:00:00.000Z', ...extra })

describe('sections', () => {
  it('reads ?section= for a section the page has', () => {
    expect(sectionFromSearch('?section=automations')).toBe('automations')
    expect(sectionFromSearch('?section=nope')).toBeNull()
    expect(sectionFromSearch('')).toBeNull()
  })

  it('flags problems in the strip, with words for a screen reader', () => {
    expect(sectionFlag('sources', { sources: 2, pipeline: null })).toEqual({ count: 2, words: '2 sources need attention' })
    expect(sectionFlag('pipeline', { sources: 0, pipeline: 1 })).toEqual({ count: 1, words: '1 problem in the pipeline' })
    expect(sectionFlag('sources', { sources: 0, pipeline: 3 })).toBeNull()
    expect(sectionFlag('alerts', { sources: 5, pipeline: 5 })).toBeNull()
  })
})

describe('sources and times', () => {
  it('Reviews links come from reviewsLinks; Settings › Channels as the API says', () => {
    expect(sourceActionHref({ kind: 'import', label: 'Import reviews…', href: null })).toBe('/marketing/reviews/inbox?import=1')
    expect(sourceActionHref({ kind: 'rules', label: 'Open requests', href: null })).toBe('/marketing/reviews/requests')
    expect(sourceActionHref({ kind: 'reconnect', label: 'Reconnect eBay Germany', href: '/settings/channels/ebay' })).toBe('/settings/channels/ebay')
    expect(sourceActionHref(null)).toBeNull()
  })

  it('times in words', () => {
    const now = new Date(2026, 9, 26, 12, 0)
    expect(timeWords(new Date(2026, 9, 26, 9, 5).toISOString(), now)).toBe('Today 09:05')
    expect(timeWords(new Date(2026, 9, 27, 3, 30).toISOString(), now)).toBe('Tomorrow 03:30')
    expect(timeWords(new Date(2026, 10, 2, 6, 0).toISOString(), now)).toBe('Mon 2 Nov 06:00')
    expect(timeWords(null, now)).toBe('—')
  })
})

describe('pipeline', () => {
  const job = (key: string, state: PipelineJob['state'], words = ''): PipelineJob =>
    ({ key, name: key, what: '', every: 'Every hour', lastRunAt: null, nextRunAt: null, state, stateWords: state, tone: 'success', code: null, words })

  it('no banner when every job is fine', () => {
    expect(pipelineSummary({ jobs: [job('a', 'healthy'), job('b', 'never')], problems: [] })).toBeNull()
  })

  it('names what is stuck, failed and late, then the freshness findings', () => {
    const sum = pipelineSummary({ jobs: [job('Spike check', 'stuck', 'Running for 3 hours.'), job('Amazon topics', 'failed', 'Amazon refused.')], problems: ['12 orders wait.'] })
    expect(sum?.title).toBe('1 job is stuck, 1 failed')
    expect(sum?.words).toEqual(['Spike check: Running for 3 hours.', 'Amazon topics: Amazon refused.', '12 orders wait.'])
  })
})

describe('automations', () => {
  const now = new Date(2026, 9, 26, 14, 0)
  it('last run in words', () => {
    expect(automationLastRun({ id: 'a', name: 'A', description: null, enabled: false, dryRun: true, lastEvaluatedAt: null, lastMatchedAt: null, matchCount: 0 }, now))
      .toEqual({ when: 'Never run', result: 'off' })
    expect(automationLastRun({ id: 'a', name: 'A', description: null, enabled: true, dryRun: false, lastEvaluatedAt: new Date(2026, 9, 26, 13, 15).toISOString(), lastMatchedAt: null, matchCount: 3 }, now))
      .toEqual({ when: 'Today 13:15', result: '3 matched so far' })
  })

  it('Load templates counts what is missing; held when all are loaded', () => {
    expect(loadTemplatesButton({ total: 3, missing: 3 })).toEqual({ label: 'Load templates (3)', held: null })
    expect(loadTemplatesButton({ total: 3, missing: 0 })).toEqual({ label: 'Load templates', held: 'All 3 review automation templates are loaded.' })
  })

  it('template languages', () => {
    expect(templateLanguagesWords(['it', 'de', 'en'])).toBe('IT · DE · EN')
  })
})

describe('the unsubscribe list', () => {
  it('only bounced and hand-added addresses can be removed', () => {
    expect(canRemove({ source: 'UNSUBSCRIBE_LINK' })).toBe(false)
    expect(canRemove({ source: 'COMPLAINT' })).toBe(false)
    expect(canRemove({ source: 'GDPR_REQUEST' })).toBe(false)
    expect(canRemove({ source: 'BOUNCE_HARD' })).toBe(true)
    expect(canRemove({ source: 'MANUAL' })).toBe(true)
  })

  it('Remove counts what it removes, says what stays, and is held when every ticked address is the buyer’s', () => {
    const buyer = row('b1', 'UNSUBSCRIBE_LINK')
    const bounced = row('x1', 'BOUNCE_HARD')
    const hand = row('h1', 'MANUAL')
    expect(removePlan([bounced, hand])).toMatchObject({ ids: ['x1', 'h1'], kept: 0, label: 'Remove…', held: null, note: null })
    const some = removePlan([buyer, bounced, hand])
    expect(some).toMatchObject({ ids: ['x1', 'h1'], kept: 1, label: 'Remove 2…', held: null })
    expect(some.note).toBe('1 ticked address was put on the list by the buyer and stays. Remove takes off the other 2 (bounced or added by hand).')
    expect(removePlan([buyer]).held).toBe('The ticked address was put on the list by the buyer and stays there. Only the buyer can undo that.')
    expect(removePlan([buyer, row('b2', 'COMPLAINT')]).held).toBe('All 2 ticked addresses were put on the list by the buyer and stay there. Only the buyer can undo that.')
    expect(removedWords(2, 1)).toBe('Removed 2 addresses from the list. 1 stays: only the buyer can undo that.')
  })

  it('words for a row', () => {
    expect(maskEmail('giovanni@gmail.com')).toBe('g••••••@gmail.com')
    expect(maskEmail('ab@x.it')).toBe('a••@x.it')
    expect(suppressionWhy(row('a', 'BOUNCE_HARD', { reason: 'mailbox full' }))).toBe('E-mail bounced — mailbox full')
    expect(suppressionWhy(row('a', 'MANUAL', { reason: 'Asked by phone' }))).toBe('Added by hand — Asked by phone')
    expect(suppressionScope(null)).toBe('Every review e-mail')
    expect(suppressionScope('review-request')).toBe('Review requests')
  })

  it('Export, the first rows, a typed address', () => {
    expect(suppressionsCsv([row('a', 'MANUAL', { reason: 'Said "no", twice' })])).toBe('Address,Why,Stops,Since\na@example.test,"Added by hand — Said ""no"", twice",Every review e-mail,2026-10-22\n')
    expect(visibleSuppressions([1, 2, 3], false, 2)).toEqual([1, 2])
    expect(visibleSuppressions([1, 2, 3], true, 2)).toEqual([1, 2, 3])
    expect(addressProblem('')).toBe('Type the e-mail address.')
    expect(addressProblem('nope')).toBe('This does not look like an e-mail address.')
    expect(addressProblem(' a@b.it ')).toBeNull()
  })
})
