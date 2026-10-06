/**
 * AM-26 / AM-34 — the ads header never shows a control that silently does nothing, and its refresh button has one
 * meaning per word.
 *
 *  · AM-34: the button read "Data Sync" everywhere while it re-read Nexus's copy (behind a cache), asked eBay for a
 *    real sync, or did nothing at all. It now says what it does: "Refresh view" by default, its own words on a page that
 *    really asks the channel. Every header that shows it gives it something to do.
 *  · AM-26: Trust, the Change Log, the pipeline page, Bulk operations and the eBay digest offered a market picker that
 *    changed nothing. It stays (placeholder controls are kept) but says "not by market yet" instead of pretending; the
 *    report runner's picker now IS the report's market filter.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MarketSelect } from './MarketSelect'
import { DateRangePicker } from './DateRangePicker'

const ADS = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string) => readFileSync(join(ADS, rel), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx') && !p.includes('.vitest.')) out.push(p)
  }
  return out
}

/** Every `<AdsPageHeader … />` tag in a source file (attributes only, braces balanced). */
function headerTags(src: string): string[] {
  const tags: string[] = []
  let at = src.indexOf('<AdsPageHeader')
  while (at >= 0) {
    let i = at + '<AdsPageHeader'.length
    let depth = 0
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (depth === 0 && src.startsWith('/>', i)) break
    }
    tags.push(src.slice(at, i))
    at = src.indexOf('<AdsPageHeader', i)
  }
  return tags
}

describe('AM-34 — the refresh button says what it does', () => {
  const header = read('_shell/AdsPageHeader.tsx')

  it('reads "Refresh view" by default, never "Data Sync"', () => {
    expect(header).toMatch(/dataSyncLabel = 'Refresh view'/)
    expect(header).not.toMatch(/>\s*Data Sync\s*</)
    expect(header).not.toMatch(/\} Data Sync</)
  })

  it('no ads page labels any button "Data Sync" any more', () => {
    // As a rendered label: JSX text, a prop value or a `label:` entry (comments that explain the history may name it).
    const asLabel = /(>\s*Data Sync\s*<|\} Data Sync<|label:\s*'Data Sync'|=["']Data Sync["'])/
    const offenders = walk(ADS).filter((f) => asLabel.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('every header that shows the button gives it something to do', () => {
    const idle: string[] = []
    for (const f of walk(ADS)) {
      for (const tag of headerTags(readFileSync(f, 'utf8'))) {
        if (/showDataSync=\{false\}/.test(tag)) continue
        if (!/onDataSync=/.test(tag)) idle.push(f.slice(ADS.length))
      }
    }
    expect(idle).toEqual([]) // the eBay digest's button had no handler at all
  })

  it('the one page that asks the channel says so; the re-reads skip the cache', () => {
    expect(read('ebay/campaigns/EbayCampaignsGrid.tsx')).toMatch(/dataSyncLabel="Sync from eBay now"/)
    const grid = read('campaigns/CampaignsGrid.tsx')
    expect(grid).toMatch(/opts\?\.sync \? '&fresh=1' : ''/)
    expect(read('campaigns/AdManagerGraph.tsx')).toMatch(/params\.set\('fresh', '1'\)/)
    expect(read('budget-manager/BudgetManagerClient.tsx')).toMatch(/budget-manager\?month=\$\{m\}`, \{ cache: 'no-store' \}/)
  })
})

describe('AM-26 — a market picker with nothing to filter says "not by market yet"', () => {
  it('renders "All markets" and states the reason on the control', () => {
    const html = renderToStaticMarkup(createElement(MarketSelect, {
      markets: [], value: 'all', onChange: () => {}, allowAll: true, notYet: 'Not by market yet: Trust checks every market together.',
    }))
    expect(html).toContain('All markets')
    expect(html).toContain('title="Not by market yet: Trust checks every market together."')
  })

  it('without the note the control is unchanged', () => {
    const html = renderToStaticMarkup(createElement(MarketSelect, {
      markets: [{ code: 'IT', label: '', mode: 'production', writesEnabled: true, launchable: true }], value: 'IT', onChange: () => {}, allowAll: true,
    }))
    expect(html).not.toContain('title=')
    expect(html).toContain('Italy')
  })

  it.each([
    ['trust/TrustClient.tsx'],
    ['changelog/ChangeLogClient.tsx'],
    ['reporting/PipelineClient.tsx'],
    ['bulk/BulkClient.tsx'],
    ['ebay/digest/EbayDigestClient.tsx'],
  ])('%s marks its picker instead of offering a no-op', (rel) => {
    const tags = headerTags(read(rel))
    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatch(/marketNotYet="Not [^"]+"/)
  })

  it('Trust no longer lists "All markets" as a market of its own (it showed twice)', () => {
    expect(read('trust/TrustClient.tsx')).not.toMatch(/markets=\{\['All markets'\]\}/)
  })

  it('the report runner’s header picker is the report’s own market filter', () => {
    const [tag] = headerTags(read('reporting/ReportRunner.tsx'))
    expect(tag).toMatch(/markets=\{result\?\.options\.marketplaces \?\? \[\]\}/)
    expect(tag).toMatch(/marketValues=\{params\.marketplaces\}/)
    expect(tag).toMatch(/onMarketValuesChange=\{\(codes\) => patch\(\{ marketplaces: codes \}\)\}/)
    expect(tag).not.toMatch(/onMarketChange=\{\(\) => \{\}\}/)
  })

  it('the Ad Manager footer has no "Learn More" that links nowhere', () => {
    expect(read('campaigns/CampaignsGrid.tsx')).not.toMatch(/<span className="lk">Learn More<\/span>/)
  })
})

describe('AM-26 — a date picker the page cannot use is kept, disabled, and says why', () => {
  const range = { start: new Date(2026, 8, 28), end: new Date(2026, 9, 4) }

  it('renders the range, does not act, and carries the reason for keyboard and screen readers', () => {
    const html = renderToStaticMarkup(createElement(DateRangePicker, { value: range, onChange: () => {}, disabledReason: 'The week chips below choose the week.' }))
    expect(html).toContain('09/28/2026 - 10/04/2026')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('aria-label="09/28/2026 - 10/04/2026. The week chips below choose the week."')
    expect(html).toContain('h10-tipwrap') // the InfoTip shows the reason on hover AND on focus
    expect(html).not.toContain(' disabled=""') // stays focusable
  })

  it('without a reason the picker is the ordinary one', () => {
    const html = renderToStaticMarkup(createElement(DateRangePicker, { value: range, onChange: () => {} }))
    expect(html).not.toContain('aria-disabled')
  })

  it('the eBay digest keeps its header date picker (placeholder) instead of hiding it', () => {
    const [tag] = headerTags(read('ebay/digest/EbayDigestClient.tsx'))
    expect(tag).not.toMatch(/showDateRange=\{false\}/)
    expect(tag).toMatch(/dateRangeNotYet="The week chips below choose the week/)
    expect(tag).toMatch(/dateRange=\{shownWeek \?\? undefined\}/)
  })
})

