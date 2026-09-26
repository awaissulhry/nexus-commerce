import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement } from 'react'
import { ListingIssuesCard } from './ListingIssuesCard'
import { Button } from '@/design-system/primitives/Button'
import { Tag } from '@/design-system/primitives/Tag'
import Link from '@/lib/workspaces/Link'
import { productWorkspaceHref } from '@/app/_shared/product-workspace-href'

const state = vi.hoisted(() => ({ page: null as any, busy: false, error: null, reload: vi.fn(), loadMore: vi.fn() }))
vi.mock('./useListingIssues', () => ({ useListingIssues: () => state }))
beforeEach(() => {
  vi.clearAllMocks(); state.busy = false
  state.page = { connectionId: 'account', workspaceId: 'workspace', channel: 'AMAZON', readAt: '2026-09-25T00:00:00Z', nextCursor: 'next', items: [{ id: 'issue', listingId: 'listing/1', productId: 'product 1', productSku: 'SKU-1', marketplace: 'IT', externalListingId: 'B000TEST', severity: 'ERROR', code: '90220', message: '<script>untrusted</script>', attributeNames: [], categories: [], source: 'amazon-feed', firstSeenAt: '2026-09-25T00:00:00Z', lastSeenAt: '2026-09-25T00:00:00Z', occurredAt: null }] }
})
function nodes(value: unknown): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!isValidElement(value)) return []
  const element = value as ReactElement<any>
  return [element, ...nodes(element.props.children)]
}
const card = () => ListingIssuesCard({ connectionId: 'account', workspaceId: 'workspace' })
it('keeps refresh focusable while preventing activation during a read', () => {
  state.busy = true
  const action = card().props.headerAction
  expect(action.props['aria-disabled']).toBe(true)
  expect(action.props.disabled).toBeUndefined()
  action.props.onClick(); expect(state.reload).not.toHaveBeenCalled()
  state.busy = false; card().props.headerAction.props.onClick(); expect(state.reload).toHaveBeenCalledTimes(1)
})
it('keeps continuation focus while guarding busy and exhausted pages', () => {
  const action = () => nodes(card()).find(node => node.props.children === 'Load more saved issues' || node.props.children === 'All recorded issues loaded')!
  state.busy = true; action().props.onClick(); expect(state.loadMore).not.toHaveBeenCalled()
  state.busy = false; action().props.onClick(); expect(state.loadMore).toHaveBeenCalledTimes(1)
  state.page.nextCursor = null
  expect(action().props['aria-disabled']).toBe(true)
  expect(action().props.disabled).toBeUndefined()
  action().props.onClick(); expect(state.loadMore).toHaveBeenCalledTimes(1)
})

// Review 2026-09-26: the card must be actionable — SKU → product page, listing → the listing's own workspace — and
// it names where a finding came from in words, not as the recorder's internal source code.
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('')
  : typeof value === 'string' || typeof value === 'number' ? String(value)
  : isValidElement(value) ? text((value as ReactElement<any>).props.children) : ''
const links = () => nodes(card()).filter(node => node.type === Link)

describe('review 2026-09-26 — links that act on the finding', () => {
  it('the SKU is a design-system link to its product page, through the workspace-aware Link', () => {
    const sku = links().find(link => text(link) === 'SKU-1')
    expect(sku, 'SKU link').toBeDefined()
    expect(sku!.props.href).toBe('/products/product%201/edit')
    const button = nodes(card()).find(node => node.type === Button && text(node) === 'SKU-1')!
    // A long SKU wraps inside the card at 390 px instead of pushing the row off screen (browser check 2026-09-26).
    expect(button.props).toMatchObject({ asChild: true, variant: 'link', inline: true, wrap: true })
    expect(isValidElement(button.props.children) && (button.props.children as ReactElement).type).toBe(Link)
  })
  it('the listing links to its own workspace page, bound to this account, channel and marketplace', () => {
    const listing = links().find(link => text(link) === 'Open listing')
    expect(listing, 'listing link').toBeDefined()
    const href = new URL(listing!.props.href, 'http://nexus.test')
    expect(href.pathname).toBe('/products/product%201/edit/studio')
    expect(Object.fromEntries(href.searchParams)).toEqual({ scope: 'AMAZON', market: 'IT', account: 'account', listing: 'listing/1', rec: 'primary:product 1' })
    // The app's existing listing route, not a second spelling of it.
    expect(listing!.props.href).toBe(productWorkspaceHref({ productId: 'product 1', id: 'listing/1', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account' }))
    // Many rows each say "Open listing": the accessible name starts with the visible words and says which one.
    expect(listing!.props['aria-label']).toBe('Open listing SKU-1 on IT')
    const button = nodes(card()).find(node => node.type === Button && text(node) === 'Open listing')!
    expect(button.props).toMatchObject({ asChild: true, variant: 'link' })
  })
  it('every row gets its own pair of links', () => {
    state.page.items = [state.page.items[0], { ...state.page.items[0], id: 'issue-2', listingId: 'listing-2', productId: 'product-2', productSku: 'SKU-2', marketplace: 'DE' }]
    const hrefs = links().map(link => link.props.href)
    expect(hrefs).toEqual([
      '/products/product%201/edit', expect.stringContaining('listing=listing%2F1'),
      '/products/product-2/edit', expect.stringContaining('listing=listing-2'),
    ])
    expect(links().filter(link => text(link) === 'Open listing').map(link => link.props['aria-label'])).toEqual(['Open listing SKU-1 on IT', 'Open listing SKU-2 on DE'])
  })
})

describe('review 2026-09-26 — the source in plain language, never the raw code', () => {
  const recorder = readFileSync(new URL('../../../../../api/src/services/listing-issue-recorder.service.ts', import.meta.url), 'utf8')
  const sources = [...(/export type IssueSource =([\s\S]*?)\n\n/.exec(recorder)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(m => m[1])
  it('reads every source the API can record (positive control)', () => {
    expect(sources).toContain('amazon-feed')
    expect(sources.length).toBeGreaterThanOrEqual(8)
  })
  it('each recorded source shows a distinct plain-language label, and its raw code appears nowhere on the card', () => {
    const labels = sources.map(source => {
      state.page.items[0].source = source
      const shown = text(card())
      expect(shown, source).not.toContain(source)
      const label = /Reported by ([^·]+) ·/.exec(shown)?.[1]?.trim()
      expect(label, source).toMatch(/^(Amazon|eBay|Shopify) [a-z][a-z -]+$/)
      return label
    })
    expect(new Set(labels).size).toBe(sources.length)
  })
  it('an unknown source is stated as unrecognised, not echoed and not guessed', () => {
    state.page.items[0].source = 'some-new-recorder'
    const shown = text(card())
    expect(shown).toContain('Reported by an unrecognised source ·')
    expect(shown).not.toContain('some-new-recorder')
  })
})

// Coordinator 2026-09-26: severity in sentence case on the DS Tag; the channel's issue code stays, but only as
// secondary muted text beside the plain source label (sellers search the vendor's help by that code).
describe('coordinator 2026-09-26 — severity in words, issue code secondary', () => {
  const tags = () => nodes(card()).filter(node => node.type === Tag)
  it.each([['ERROR', 'Error', 'danger'], ['WARNING', 'Warning', 'warning'], ['INFO', 'Info', 'neutral'], ['CRITICAL', 'Critical', 'neutral']])('%s shows as the DS Tag "%s" (%s)', (severity, words, tone) => {
    state.page.items[0].severity = severity
    const tag = tags().find(node => text(node) === words)
    expect(tag, words).toBeDefined()
    expect(tag!.props.tone ?? 'neutral').toBe(tone)
    expect(text(card())).not.toContain(severity)
  })
  it('an empty severity is stated, not left as a blank Tag', () => {
    state.page.items[0].severity = ' '
    expect(tags().map(text)).toContain('Unknown severity')
  })
  it('the issue code sits beside the source label as muted secondary text, and nowhere else', () => {
    const tree = nodes(card())
    const code = tree.filter(node => node.props.className === 'cx-listing-issues-code')
    expect(code.map(text)).toEqual(['· issue code 90220'])
    const meta = tree.find(node => node.type === 'p' && text(node).startsWith('Reported by'))!
    expect(nodes(meta)).toContain(code[0])
    expect(text(meta)).toMatch(/^Reported by Amazon feed upload · issue code 90220 · Last recorded /)
    const labels = nodes(card()).find(node => node.props.className === 'cx-listing-issues-labels')!
    expect(text(labels)).not.toMatch(/90220/)
    expect(text(card()).match(/90220/g)).toHaveLength(1)
  })
  it('the muted style is a semantic token, not a palette value', () => {
    const css = readFileSync(new URL('./listing-issues.css', import.meta.url), 'utf8')
    expect(/\.cx-listing-issues-code\s*\{([^}]*)\}/.exec(css)?.[1]).toMatch(/color:\s*var\(--nds-text-muted\)/)
  })
})
