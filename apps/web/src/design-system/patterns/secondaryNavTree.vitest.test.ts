import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SecondaryNavRow, WorkspaceSubheader, type WorkspaceNavGroup, type WorkspaceNavItem } from './WorkspaceSubheader'
import {
  currentPageInChildren, flattenNavItems, holdsCurrentPage, isNavParent, isNavParentOpen, mergeRemembered,
  navChildrenGroupLabel, navCurrentInsideText, navOpenStorageKey, navToggleLabel, openOnArrival, readNavOpenChoices,
  writeNavOpenChoice,
} from './secondaryNavTree'

const market = (code: string, word: string, active = false): WorkspaceNavItem => ({
  id: `/channel/${code}`, label: word, ariaLabel: `Channel ${word}`, href: `#channel-${code}`, active,
})
const channel = (current?: string, noun: string | null = 'markets'): WorkspaceNavItem => ({
  id: '/channel', label: 'Channel', href: '#channel', ...(noun === null ? {} : { childrenLabel: noun }),
  children: [market('it', 'Italy', current === 'it'), market('de', 'Germany', current === 'de')],
})
const groups = (parent: WorkspaceNavItem): WorkspaceNavGroup[] => [
  { id: 'top', label: 'Pages', hideLabel: true, items: [{ id: '/inbox', label: 'Inbox', href: '#inbox' }] },
  { id: 'channels', label: 'Channels', collapsible: true, items: [parent, { id: '/shop', label: 'Shop', href: '#shop', children: [] }] },
]
// The pinned column is what the server draws (desktop first), so the rows are in the static markup.
const render = (parent: WorkspaceNavItem) => renderToStaticMarkup(createElement(WorkspaceSubheader, {
  pinned: true, navigationLabel: 'Example navigation', groups: groups(parent),
}))
const noop = () => {}
const row = (item: WorkspaceNavItem, open: boolean) => renderToStaticMarkup(createElement(SecondaryNavRow, {
  item, listId: 'rows-1', open, onToggle: noop, onNavigate: noop,
}))
const attrs = (html: string, tag: string, marker: string) => {
  const match = [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].find(m => m[1].includes(marker))
  return match?.[1] ?? ''
}

/** In-memory Storage stand-in (the tests run in Node). */
function memoryStorage(throwing = false) {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => { if (throwing) throw new Error('blocked'); return data.get(key) ?? null },
    setItem: (key: string, value: string) => { if (throwing) throw new Error('quota'); data.set(key, value) },
  }
}

describe('WorkspaceSubheader rows with rows under them', () => {
  it('draws the row link and a chevron button that controls the closed list of its rows', () => {
    const html = render(channel())
    const toggle = attrs(html, 'button', 'nds-secondary-nav-toggle')
    expect(toggle).toContain('aria-expanded="false"')
    expect(toggle).toContain('aria-label="Show Channel markets"')
    const listId = /aria-controls="([^"]+)"/.exec(toggle)![1]
    const list = attrs(html, 'div', `id="${listId}"`)
    expect(list).toContain('role="group"')
    expect(list).toContain('aria-label="Channel markets"')
    expect(list).toContain('class="nds-secondary-nav-children"')
    expect(list).toMatch(/\shidden=""/)
    // The row keeps its own page; the market rows show the short word and are named in full.
    expect(attrs(html, 'a', 'href="#channel"')).toContain('class="nds-secondary-nav-link"')
    expect(attrs(html, 'a', 'href="#channel-it"')).toContain('aria-label="Channel Italy"')
    expect(html).toContain('<span class="nds-secondary-nav-label">Italy</span>')
    expect(html).not.toContain('nds-secondary-nav-current-dot')
  })

  it('opens the row whose child is the current page, with that child as the one current row', () => {
    const html = render(channel('de'))
    const toggle = attrs(html, 'button', 'nds-secondary-nav-toggle')
    expect(toggle).toContain('aria-expanded="true"')
    expect(toggle).toContain('aria-label="Hide Channel markets"')
    const listId = /aria-controls="([^"]+)"/.exec(toggle)![1]
    expect(attrs(html, 'div', `id="${listId}"`)).not.toMatch(/\shidden=/)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(attrs(html, 'a', 'href="#channel-de"')).toContain('aria-current="page"')
    expect(attrs(html, 'a', 'href="#channel"')).not.toContain('aria-current')
    expect(html).not.toContain('has-current')
  })

  it('draws a row with no rows under it (an empty list) as a plain link, without a chevron', () => {
    const html = render(channel())
    expect(html.match(/nds-secondary-nav-toggle/g)).toHaveLength(1)
    expect(attrs(html, 'a', 'href="#shop"')).toContain('class="nds-secondary-nav-link"')
    expect(html).not.toContain('Show Shop')
  })

  it('marks a closed row that holds the current page: bold class, a dot and words for a screen reader', () => {
    const closed = row(channel('it'), false)
    expect(closed).toContain('class="nds-secondary-nav-parent has-current"')
    expect(closed).toContain('<span class="nds-secondary-nav-current-dot" aria-hidden="true"></span>')
    expect(closed).toContain('<span class="nds-vh">(the current page is in Channel)</span>')
    // The dot sits in the row's own link; the link is still not the current page.
    expect(attrs(closed, 'a', 'href="#channel"')).not.toContain('aria-current')
    expect(attrs(closed, 'button', 'nds-secondary-nav-toggle')).toContain('aria-label="Show Channel markets"')
    // Open, or closed without the page inside: no mark.
    expect(row(channel('it'), true)).not.toContain('has-current')
    expect(row(channel(), false)).not.toContain('has-current')
    expect(row(channel(), false)).not.toContain('nds-secondary-nav-current-dot')
  })

  it('names the rows "items" when the feature gives no noun', () => {
    const html = row(channel(undefined, null), false)
    expect(html).toContain('aria-label="Show Channel items"')
    expect(html).toContain('aria-label="Channel items"')
  })
})

describe('secondaryNavTree: the open state', () => {
  it('a parent is a row with rows under it; it holds the page when one of them is current', () => {
    expect(isNavParent(channel())).toBe(true)
    expect(isNavParent({ id: 'x', label: 'X', children: [] })).toBe(false)
    expect(isNavParent({ id: 'x', label: 'X' })).toBe(false)
    expect(holdsCurrentPage(channel('it'))).toBe(true)
    expect(holdsCurrentPage(channel())).toBe(false)
    expect(flattenNavItems([channel(), { id: 'y', label: 'Y' }]).map(item => item.id)).toEqual(['/channel', '/channel/it', '/channel/de', 'y'])
  })

  it('starts open only on its own pages; a choice made overrides that', () => {
    expect(isNavParentOpen(channel('it'), {})).toBe(true)
    expect(isNavParentOpen(channel(), {})).toBe(false)
    expect(isNavParentOpen(channel(), { '/channel': true })).toBe(true)
    expect(isNavParentOpen(channel('it'), { '/channel': false })).toBe(false)
  })

  it('remembers the choice per navigation and row, and reads it back', () => {
    const storage = memoryStorage()
    writeNavOpenChoice(storage, 'Example navigation', '/channel', true)
    writeNavOpenChoice(storage, 'Example navigation', '/other', false)
    expect(storage.data.get(navOpenStorageKey('Example navigation', '/channel'))).toBe('open')
    expect(navOpenStorageKey('Example navigation', '/channel')).toBe('nds-secondary-nav:Example navigation:/channel')
    expect(readNavOpenChoices(storage, 'Example navigation', ['/channel', '/other', '/never'])).toEqual({ '/channel': true, '/other': false })
    // Another navigation keeps its own choices.
    expect(readNavOpenChoices(storage, 'Other navigation', ['/channel'])).toEqual({})
    // A remembered open row is open on any page after a reload.
    expect(isNavParentOpen(channel(), readNavOpenChoices(storage, 'Example navigation', ['/channel']))).toBe(true)
    // Something else in the key → ignored.
    storage.data.set(navOpenStorageKey('Example navigation', '/odd'), 'yes')
    expect(readNavOpenChoices(storage, 'Example navigation', ['/odd'])).toEqual({})
  })

  it('works without storage: none, or one that throws on every read and write', () => {
    expect(readNavOpenChoices(null, 'Example navigation', ['/channel'])).toEqual({})
    expect(() => writeNavOpenChoice(null, 'Example navigation', '/channel', true)).not.toThrow()
    const blocked = memoryStorage(true)
    expect(readNavOpenChoices(blocked, 'Example navigation', ['/channel'])).toEqual({})
    expect(() => writeNavOpenChoice(blocked, 'Example navigation', '/channel', true)).not.toThrow()
  })

  it('opens the parent when the person arrives on one of its pages, even one they had closed', () => {
    const rows = [{ id: '/inbox', label: 'Inbox' }, channel('de')]
    const arrival = currentPageInChildren(rows)
    expect(arrival).toEqual({ parentId: '/channel', childId: '/channel/de' })
    expect(openOnArrival({ '/channel': false }, arrival)).toEqual({ '/channel': true })
    const open = { '/channel': true }
    expect(openOnArrival(open, arrival)).toBe(open)
    expect(openOnArrival(open, undefined)).toBe(open)
    expect(currentPageInChildren([{ id: '/inbox', label: 'Inbox', active: true }, channel()])).toBeUndefined()
  })

  it('a later read of the remembered choices never undoes a choice made in this visit', () => {
    const visit = { '/channel': true }
    expect(mergeRemembered(visit, { '/channel': false, '/other': true })).toEqual({ '/channel': true, '/other': true })
    expect(mergeRemembered(visit, { '/channel': false })).toBe(visit)
    expect(mergeRemembered({}, { '/other': false })).toEqual({ '/other': false })
  })

  it('words: the chevron, the list and the mark', () => {
    expect(navToggleLabel(channel(), false)).toBe('Show Channel markets')
    expect(navToggleLabel(channel(), true)).toBe('Hide Channel markets')
    expect(navToggleLabel({ id: 'x', label: 'Folder', childrenLabel: '  ' }, false)).toBe('Show Folder items')
    expect(navChildrenGroupLabel(channel())).toBe('Channel markets')
    expect(navCurrentInsideText(channel())).toBe('(the current page is in Channel)')
  })
})
