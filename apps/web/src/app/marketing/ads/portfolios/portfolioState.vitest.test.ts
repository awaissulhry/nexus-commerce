/**
 * AM-31 — a portfolio's state reads like a campaign's in the Ad Manager: the same DS status pill (same word, same
 * colour). It was a local chip — green raw hex, the raw enum "ENABLED" — beside the grid's blue "Enabled".
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { StatusCell } from '../_shared/CampaignRowCells'

const here = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('Portfolios state', () => {
  it('renders through the Ad Manager’s StatusCell', () => {
    const src = here('./PortfoliosClient.tsx')
    expect(src).toMatch(/<StatusCell status=\{r\.state\.toUpperCase\(\)\} name=\{r\.name\} \/>/)
    expect(src).not.toMatch(/pf-state/)
  })

  it('has no local raw-hex state colours left', () => {
    const css = here('./portfolios.css')
    expect(css).not.toMatch(/\.pf-state/)
  })

  it('"ENABLED" reads "Enabled" with the success tone, as in the Ad Manager', () => {
    const html = renderToStaticMarkup(createElement(StatusCell, { status: 'ENABLED', name: 'P' }))
    expect(html).toContain('Enabled')
    expect(html).not.toContain('ENABLED')
  })
})
