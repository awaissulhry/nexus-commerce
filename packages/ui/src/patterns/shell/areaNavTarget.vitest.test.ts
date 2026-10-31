import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LayoutGrid } from 'lucide-react'
import { SecondaryNavRow, type WorkspaceNavItem } from '../WorkspaceSubheader'
import { areaSubNavGroups, type AreaNavArea } from './area-nav'

/** B-W2b-09 — a nav row that opens its page in a new tab (B-W2a-83's gap): `target` on AreaNavItem and its row. */
const AREA: AreaNavArea = {
  id: 'planning', label: 'Planning', href: '/planning', icon: LayoutGrid,
  sections: [{ id: 'main', label: 'Planning', items: [
    { id: 'mrp', label: 'MRP', href: '/planning/mrp' },
    { id: 'board', label: 'Board', href: '/planning/board', target: '_blank', targetLabel: 'opens in a new tab' },
  ] }],
}
const row = (item: WorkspaceNavItem) => render(h(SecondaryNavRow, { item, listId: 'l', open: false, onToggle: () => {}, onNavigate: () => {} }))

it('passes the target and its words to the sub-sidebar row; a row without one is unchanged', () => {
  const [group] = areaSubNavGroups(AREA, { path: '/planning/mrp' })
  expect(group!.items[1]).toMatchObject({ target: '_blank', targetLabel: 'opens in a new tab' })
  expect(group!.items[0]).not.toHaveProperty('target')
  expect(group!.items[0]).not.toHaveProperty('targetLabel')
})

it('draws a new-tab row as a real link with target, rel, a mark and its words', () => {
  const html = row({ id: 'board', label: 'Board', href: '/planning/board', target: '_blank', targetLabel: 'opens in a new tab' })
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noopener noreferrer"')
  expect(html).toContain('nds-secondary-nav-newtab')
  expect(html).toContain('<span class="nds-vh"> (opens in a new tab)</span>')
})

it('draws a plain row exactly as before: no target, rel or mark', () => {
  const html = row({ id: 'mrp', label: 'MRP', href: '/planning/mrp', active: true })
  expect(html).toBe('<a href="/planning/mrp" class="nds-secondary-nav-link" aria-current="page"><span class="nds-secondary-nav-label">MRP</span></a>')
})
