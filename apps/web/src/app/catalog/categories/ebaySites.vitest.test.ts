import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandKey } from '@/lib/command-key'
import {
  LEAVE_EMPTY, SEARCH, assignLabel, assignSites, chosenAssignments, defaultChoices, doneView, pathText, siteOptions, suggestionsPath,
  summaryLine, undoRows, undoSites, undoView, whyLabel, type SiteSuggestion,
} from './ebaySites'

afterEach(() => vi.unstubAllGlobals())

const de: SiteSuggestion = { market: 'DE', treeReady: true, defaultCategoryId: '177117', candidates: [
  { categoryId: '177117', path: 'Auto & Motorrad › Motorradjacken', reasons: ['same_name', 'ebay_suggestion'] },
  { categoryId: '177118', path: 'Auto & Motorrad › Motorradhosen', reasons: ['ebay_suggestion'] },
] }
const es: SiteSuggestion = { market: 'ES', treeReady: true, defaultCategoryId: null, candidates: [] }
const uk: SiteSuggestion = { market: 'UK', treeReady: false, defaultCategoryId: null, candidates: [] }

describe('the Fill other eBay sites dialog', () => {
  it('says where the category comes from, in one line', () => {
    expect(summaryLine({ categoryName: 'Jackets', source: { market: 'IT', channelCategoryId: '177104', path: 'Abbigliamento per moto › Giacche e giubbotti' } }))
      .toBe('Jackets is on eBay IT as 177104 · Abbigliamento per moto › Giacche e giubbotti. Choose the category for the other sites. Nothing is sent to eBay.')
    expect(summaryLine({ categoryName: 'Gloves', source: null })).toBe('Gloves has no eBay category yet. Choose the category for the other sites. Nothing is sent to eBay.')
  })

  it('starts every site on its default, or on Leave empty, and counts the button from the choices', () => {
    const choices = defaultChoices([de, es, uk])
    expect(choices).toEqual({ DE: de.candidates[0], ES: null, UK: null })
    expect(chosenAssignments([de, es, uk], choices)).toEqual([{ market: 'DE', channelCategoryId: '177117' }])
    expect(assignLabel(1)).toBe('Assign 1 site')
    expect(assignLabel(4)).toBe('Assign 4 sites')
    expect(assignLabel(0)).toBe('Nothing to assign')
  })

  it('offers the candidates, a searched category, Search… and Leave empty', () => {
    expect(siteOptions(de, de.candidates[0]).map(o => [o.value, o.label])).toEqual([
      ['177117', '177117 · Motorradjacken'], ['177118', '177118 · Motorradhosen'], [SEARCH, 'Search…'], [LEAVE_EMPTY, 'Leave empty'],
    ])
    const searched = { categoryId: '999', path: 'Auto › Other', reasons: [] }
    expect(siteOptions(es, searched).map(o => o.value)).toEqual(['999', SEARCH, LEAVE_EMPTY])
  })

  it('explains each choice in plain words', () => {
    expect(whyLabel(de.candidates[0])).toBe('Same name · eBay suggests')
    expect(whyLabel({ categoryId: '1', path: 'A', reasons: ['same_id'] })).toBe('Same number')
    expect(whyLabel({ categoryId: '1', path: 'A', reasons: [] })).toBe('Your search')
    expect(whyLabel(null)).toBe('—')
    expect(pathText(es, null)).toBe('Left empty')
    expect(pathText(uk, null)).toContain('category list is not downloaded')
    expect(pathText(de, de.candidates[0])).toBe('Auto & Motorrad › Motorradjacken')
  })

  it('the Done state names what happened, and Undo carries only what was assigned', () => {
    const results = [
      { market: 'DE', channelCategoryId: '177117', outcome: 'assigned' as const, assignedAt: '2026-09-27T10:00:00.000Z' },
      { market: 'FR', channelCategoryId: '177104', outcome: 'failed' as const, reason: 'refused' },
    ]
    expect(doneView(results)).toEqual({ tone: 'warning', title: 'Assigned 1 site. 1 site could not be assigned.' })
    expect(doneView([results[0]])).toEqual({ tone: 'success', title: 'Assigned 1 site. Nothing was sent to eBay.' })
    expect(doneView([results[1]]).tone).toBe('danger')
    expect(undoRows(results)).toEqual([{ market: 'DE', channelCategoryId: '177117', assignedAt: '2026-09-27T10:00:00.000Z' }])
    expect(undoView([{ market: 'DE', channelCategoryId: '177117', outcome: 'removed' }]).tone).toBe('success')
    expect(undoView([{ market: 'DE', channelCategoryId: '177117', outcome: 'removed' }, { market: 'FR', channelCategoryId: '1', outcome: 'unchanged' }]).title).toBe('1 of 2 assignments removed. The others are listed below.')
  })

  it('asks the API for one category', () => {
    expect(suggestionsPath('cat 1')).toBe('category-workspace/EBAY/site-suggestions?categoryId=cat+1')
  })
})

describe('requests', () => {
  it('assigns with an Idempotency-Key and returns the per-site results', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ market: 'DE', channelCategoryId: '177117', outcome: 'assigned' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const results = await assignSites(new CommandKey(() => 'key-1'), 'jackets', [{ market: 'DE', channelCategoryId: '177117' }])
    expect(results).toEqual([{ market: 'DE', channelCategoryId: '177117', outcome: 'assigned' }])
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toMatch(/\/api\/pim\/category-workspace\/EBAY\/site-assignments$/)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('key-1')
    expect(JSON.parse(init.body)).toEqual({ categoryId: 'jackets', assignments: [{ market: 'DE', channelCategoryId: '177117' }] })
  })

  it('says what went wrong instead of showing an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Category no longer exists.' }), { status: 404 })))
    await expect(assignSites(new CommandKey(), 'gone', [{ market: 'DE', channelCategoryId: '1' }])).rejects.toThrow('Category no longer exists.')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))
    await expect(assignSites(new CommandKey(), 'jackets', [{ market: 'DE', channelCategoryId: '1' }])).rejects.toThrow('No answer from the server')
  })

  it('undoes with DELETE and the rows of one save', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ market: 'DE', channelCategoryId: '177117', outcome: 'removed' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const rows = [{ market: 'DE', channelCategoryId: '177117', assignedAt: '2026-09-27T10:00:00.000Z' }]
    expect(await undoSites('jackets', rows)).toEqual([{ market: 'DE', channelCategoryId: '177117', outcome: 'removed' }])
    expect(fetcher.mock.calls[0][1].method).toBe('DELETE')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ categoryId: 'jackets', assignments: rows })
  })
})
