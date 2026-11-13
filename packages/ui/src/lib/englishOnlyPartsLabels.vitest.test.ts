import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Home, Package, Store } from 'lucide-react'

// The Lightbox's dialog portals into <body> once hydrated: inline the portal and say "hydrated" (dialogLabels' way).
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))
vi.mock('../components/useHydrated', () => ({ useHydrated: () => true }))

import { WorkspaceSubheader, SecondaryNavRow, type WorkspaceNavItem } from '../patterns/WorkspaceSubheader'
import { WORKSPACE_SUBHEADER_LABELS, type WorkspaceSubheaderLabels } from '../patterns/WorkspaceSubheaderLabels'
import { navChildrenGroupLabel, navCurrentInsideText, navToggleLabel } from '../patterns/secondaryNavTree'
import { AppRail, type RailLinkProps, type RailNavItem } from '../patterns/shell/AppRail'
import type { AppRailLabels } from '../patterns/shell/AppRailLabels'
import { ChangeValue } from '../grid/renderers/ChangeCell'
import { changeAccessibleText, changeLineText } from '../grid/renderers/changeValue'
import type { ChangeValueLabels } from '../grid/renderers/ChangeValueLabels'
import { MultiSelect } from '../components/MultiSelect'
import { OptionList } from '../components/OptionList'
import type { MultiSelectLabels } from '../components/MultiSelectLabels'
import { ListboxPanel } from '../components/ListboxPanel'
import { Listbox } from '../components/Listbox'
import type { ListboxLabels } from '../components/ListboxLabels'
import { OrderedList } from '../components/OrderedList'
import type { OrderedListLabels } from '../components/OrderedListLabels'
import { TagInput } from '../primitives/TagInput'
import { Lightbox } from '../patterns/Lightbox'
import type { LightboxLabels } from '../patterns/LightboxLabels'
import { lightboxCounter, lightboxHeld, lightboxThumbLabel } from '../patterns/lightboxModel'
import { ReplyComposer } from '../patterns/ReplyComposer'
import type { ReplyComposerLabels } from '../patterns/ReplyComposerLabels'
import { replyHeldReason, replyLengthWords } from '../patterns/replyComposerModel'

/**
 * B-W2b-F41 — the parts that spoke English only (WorkspaceSubheader, AppRail, ChangeValue, MultiSelect / OptionList,
 * Listbox / ListboxPanel, OrderedList, TagInput, Lightbox, ReplyComposer) speak the words they are given (made-up
 * Italian here) and keep their English without `labels`. The defaults were also checked against main's source when the
 * props were added (the same markup for every case).
 */
const noop = () => {}
const render = (el: ReactNode) => renderToStaticMarkup(el as never)

const saved: Record<string, unknown> = {}
beforeAll(() => {
  for (const k of ['document', 'getComputedStyle', 'window', 'matchMedia']) saved[k] = (globalThis as Record<string, unknown>)[k]
  ;(globalThis as Record<string, unknown>).document = { body: {}, activeElement: null, documentElement: {}, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop }
  ;(globalThis as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: () => '' })
})
afterAll(() => { for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v })

describe('WorkspaceSubheader words', () => {
  const IT: WorkspaceSubheaderLabels = {
    expand: (n) => `Espandi ${n.toLowerCase()}`,
    collapse: (n) => `Comprimi ${n.toLowerCase()}`,
    close: (n) => `Chiudi ${n}`,
    rowsNoun: 'voci',
    showRows: (l, n) => `Mostra ${n} di ${l}`,
    hideRows: (l, n) => `Nascondi ${n} di ${l}`,
    rows: (l, n) => `${n} di ${l}`,
    currentInside: (l) => `(la pagina aperta è in ${l})`,
  }
  const parent: WorkspaceNavItem = { id: 'amazon', label: 'Amazon', href: '/a', children: [{ id: 'it', label: 'Italia', href: '/a/it', active: true }] }

  it('the toggle says the navigation in the words given, English without them', () => {
    const groups = [{ id: 'g', label: 'Pagine', items: [{ id: 'p', label: 'Pagina', href: '/p' }] }]
    expect(render(h(WorkspaceSubheader, { navigationLabel: 'Pagine di Magazzino', groups, labels: IT }))).toContain('aria-label="Espandi pagine di magazzino"')
    const english = render(h(WorkspaceSubheader, { navigationLabel: 'Warehouse pages', groups }))
    expect(english).toContain('aria-label="Expand warehouse pages"')
  })

  it('a parent row: chevron, list and the current-page words', () => {
    const html = render(h(SecondaryNavRow, { item: parent, listId: 'l', open: false, onToggle: noop, onNavigate: noop, words: IT }))
    expect(html).toContain('aria-label="Mostra voci di Amazon"')
    expect(html).toContain('aria-label="voci di Amazon"')
    expect(html).toContain('(la pagina aperta è in Amazon)')
    expect(html).not.toMatch(/Show|items|current page/)
    const english = render(h(SecondaryNavRow, { item: parent, listId: 'l', open: false, onToggle: noop, onNavigate: noop }))
    expect(english).toContain('aria-label="Show Amazon items"')
    expect(english).toContain('(the current page is in Amazon)')
  })

  it('the rules keep their English by default', () => {
    expect(navToggleLabel(parent, true)).toBe('Hide Amazon items')
    expect(navToggleLabel({ ...parent, childrenLabel: 'markets' }, false)).toBe('Show Amazon markets')
    expect(navChildrenGroupLabel(parent)).toBe('Amazon items')
    expect(navCurrentInsideText(parent)).toBe('(the current page is in Amazon)')
    expect(navToggleLabel({ ...parent, childrenLabel: 'mercati' }, true, IT)).toBe('Nascondi mercati di Amazon')
    expect(WORKSPACE_SUBHEADER_LABELS.close('Reviews navigation')).toBe('Close Reviews navigation')
  })
})

describe('AppRail words', () => {
  const Link = ({ href, children, ...rest }: RailLinkProps) => h('a', { ...rest, href }, children)
  const NAV: RailNavItem[] = [
    { label: 'Home', href: '/', Icon: Home },
    { label: 'Prodotti', href: '/products', Icon: Package, badge: 4, children: [{ label: 'Bozze', href: '/products/drafts', indicator: 'disconnected' }] },
    { label: 'Annunci', href: '/listings', Icon: Store, children: [{ label: 'Amazon', href: '/listings/amazon', moreMarketsCount: 9, children: [{ code: 'IT', label: 'Italia', href: '/listings/amazon/it' }] }] },
    { label: 'Aiuto', href: '/help', Icon: Home, external: 'https://help.example' },
  ]
  const IT: AppRailLabels = {
    navigation: 'Navigazione dell’applicazione',
    withCount: (l, n) => `${l}, ${n} in attesa`,
    count: (n) => `${n} in attesa`,
    newTab: (name) => `${name} (si apre in una nuova scheda)`,
    expand: (l) => `Espandi ${l}`,
    collapse: (l) => `Comprimi ${l}`,
    expandMarkets: (l) => `Espandi i mercati di ${l}`,
    collapseMarkets: (l) => `Comprimi i mercati di ${l}`,
    seeAllMarkets: (n) => `Vedi tutti i ${n} mercati`,
    connect: 'Collega',
  }

  it('every word of the rail in the words given', () => {
    const html = render(h(AppRail, { navItems: NAV, pathname: '/listings/amazon/it', LinkComponent: Link, onSeeAllMarkets: noop, labels: IT }))
    for (const word of ['aria-label="Navigazione dell’applicazione"', 'aria-label="Prodotti, 4 in attesa"', 'aria-label="4 in attesa"', 'aria-label="Aiuto (si apre in una nuova scheda)"', 'aria-label="Espandi Prodotti"', 'aria-label="Comprimi Annunci"', 'aria-label="Comprimi i mercati di Amazon"', 'Vedi tutti i 9 mercati']) {
      expect(html).toContain(word)
    }
    expect(html).not.toMatch(/Application navigation|pending|opens in a new tab|Expand|Collapse|See all/)
    const opened = render(h(AppRail, { navItems: NAV, pathname: '/products/drafts', LinkComponent: Link, labels: IT }))
    expect(opened).toContain('>Collega<')
  })

  it('English without them', () => {
    const html = render(h(AppRail, { navItems: NAV, pathname: '/listings/amazon/it', LinkComponent: Link, onSeeAllMarkets: noop }))
    for (const word of ['aria-label="Application navigation"', 'aria-label="Prodotti, 4 pending"', 'aria-label="4 pending"', 'aria-label="Aiuto (opens in a new tab)"', 'aria-label="Expand Prodotti"', 'aria-label="Collapse Amazon markets"', 'See all 9 markets']) {
      expect(html).toContain(word)
    }
  })
})

describe('ChangeValue words', () => {
  const IT: ChangeValueLabels = {
    removed: 'rimosso', unchanged: 'invariato', noValue: 'nessun valore', more: (n) => `+${n} altre`, changes: (n) => `${n} modifiche`,
    saidChanged: (head, from, to) => `${head}da ${from} a ${to}`, saidAdded: (head, to) => `${head}nuovo valore ${to}`,
    saidRemoved: (head, from) => `${head}${from} rimosso`, saidUnchanged: (head, to) => `${head}invariato, ${to}`, saidEmpty: (head) => `${head}nessun valore`,
    saidMore: (n) => `altre ${n} modifiche`, saidAndMore: (lines, more) => `${lines}; e ${more}`, saidNone: 'Nessuna modifica', saidJoin: '; ',
  }
  const lines = [{ label: 'Prezzo', from: '€ 49,90', to: null }, { label: 'Scorta', from: '5', to: '5' }, { label: 'Nota', from: null, to: null }]

  it('drawn and said in the words given', () => {
    const html = render(h(ChangeValue, { changes: lines, more: 2, labels: IT }))
    expect(html).toContain('>rimosso<')
    expect(html).toContain('>invariato<')
    expect(html).toContain('>nessun valore<')
    expect(html).toContain('+2 altre')
    expect(html).toContain('Prezzo: € 49,90 rimosso; Scorta: invariato, 5; Nota: nessun valore; e altre 2 modifiche')
    expect(html).not.toMatch(/>[^<]*(removed|unchanged|no value|more)[^<]*</) // the text, not the class names
    expect(render(h(ChangeValue, { changes: [], more: 3, labels: IT }))).toContain('3 modifiche')
  })

  it('English without them, and the rules keep it', () => {
    const html = render(h(ChangeValue, { changes: lines, more: 2 }))
    expect(html).toContain('>removed<')
    expect(html).toContain('Prezzo: € 49,90 removed; Scorta: unchanged, 5; Nota: no value; and 2 more changes')
    expect(changeLineText({ label: 'Price', from: '1', to: '2' })).toBe('Price: from 1 to 2')
    expect(changeAccessibleText({ changes: [] })).toBe('No change')
    expect(changeAccessibleText({ changes: [{ label: '', from: '1', to: '2' }] }, IT)).toBe('da 1 a 2')
  })
})

describe('MultiSelect, OptionList, Listbox words', () => {
  const IT: MultiSelectLabels = { search: 'Cerca…', searchOptions: 'Cerca tra le opzioni', selectAll: 'Seleziona tutto', noMatches: 'Nessun risultato', atLeast: (n) => `Almeno ${n} deve restare selezionata`, all: 'Tutti', selected: (n) => `${n} selezionati` }
  const options = [{ value: 'a', label: 'Uno' }, { value: 'b', label: 'Due' }, { value: 'c', label: 'Tre' }]

  it('the trigger: nothing, some and every option picked', () => {
    expect(render(h(MultiSelect, { options, value: [], onChange: noop, labels: IT }))).toContain('>Tutti<')
    expect(render(h(MultiSelect, { options, value: ['a'], onChange: noop, labels: IT }))).toContain('>1 selezionati<')
    expect(render(h(MultiSelect, { options, value: ['a', 'b', 'c'], onChange: noop, labels: IT }))).toContain('>Tutti<')
    expect(render(h(MultiSelect, { options, value: [], onChange: noop, placeholder: 'Nessuno', labels: IT }))).toContain('>Nessuno<')
    expect(render(h(MultiSelect, { options, value: ['a'], onChange: noop }))).toContain('>1 selected<')
    expect(render(h(MultiSelect, { options, value: [], onChange: noop }))).toContain('>All<')
  })

  it('the list: search, Select all, nothing found, a row that must stay', () => {
    const html = render(h(OptionList, { options, value: ['a'], onChange: noop, searchable: true, initialQuery: 'zzz', labels: IT }))
    expect(html).toContain('placeholder="Cerca…"')
    expect(html).toContain('aria-label="Cerca tra le opzioni"')
    expect(html).toContain('Seleziona tutto')
    expect(html).toContain('Nessun risultato')
    expect(render(h(OptionList, { options, value: ['a'], onChange: noop, minSelected: 1, labels: IT }))).toContain('title="Almeno 1 deve restare selezionata"')
    const english = render(h(OptionList, { options, value: ['a'], onChange: noop, searchable: true, initialQuery: 'zzz' }))
    for (const word of ['placeholder="Search…"', 'aria-label="Search options"', 'Select all', 'No matches']) expect(english).toContain(word)
  })

  it('Listbox and its panel', () => {
    const LB: ListboxLabels = { select: 'Scegli…', search: 'Cerca…', searchOptions: 'Cerca tra le opzioni', noMatches: 'Nessun risultato', useTyped: (t) => `Usa «${t}»`, actions: 'Azioni' }
    expect(render(h(Listbox, { options, value: undefined, onChange: noop, labels: LB }))).toContain('Scegli…')
    expect(render(h(Listbox, { options, value: undefined, onChange: noop }))).toContain('Select…')
    const panel = render(h(ListboxPanel, { options: [], value: undefined, onCommit: noop, onCancel: noop, searchable: true, labels: LB, actions: [{ id: 'n', label: 'Nuovo', onSelect: noop }] }))
    for (const word of ['placeholder="Cerca…"', 'aria-label="Cerca tra le opzioni"', 'Nessun risultato', 'aria-label="Azioni"']) expect(panel).toContain(word)
    expect(render(h(ListboxPanel, { options: [], value: undefined, onCommit: noop, onCancel: noop, searchable: true, allowCustom: true, initialQuery: 'Nero', labels: LB }))).toContain('Usa «Nero»')
    const english = render(h(ListboxPanel, { options: [], value: undefined, onCommit: noop, onCancel: noop, searchable: true }))
    for (const word of ['placeholder="Search…"', 'aria-label="Search options"', 'No matches']) expect(english).toContain(word)
  })
})

describe('OrderedList and TagInput words', () => {
  it('OrderedList: the move buttons and the grip', () => {
    const IT: OrderedListLabels = { moveUp: (i) => `Sposta ${i} su`, moveDown: (i) => `Sposta ${i} giù`, reorder: (i) => `Riordina ${i}; usa le frecce`, position: (i, p, t) => `${i}, posizione ${p} di ${t}`, moving: (i, p, t) => `${i}, verso la posizione ${p} di ${t}` }
    const html = render(h(OrderedList, { label: 'Fasi', items: ['Taglio', 'Cucito'], onChange: noop, labels: IT }))
    expect(html).toContain('Sposta Taglio su')
    expect(html).toContain('Sposta Cucito giù')
    expect(html).not.toMatch(/Move /)
    expect(render(h(OrderedList, { label: 'Fasi', items: ['Taglio', 'Cucito'], onChange: noop, keyboardGrip: true, labels: IT }))).toContain('Riordina Taglio; usa le frecce')
    expect(render(h(OrderedList, { label: 'Steps', items: ['Cut', 'Sew'], onChange: noop }))).toContain('Move Cut down')
  })

  it('TagInput: the remove button and the empty text', () => {
    expect(render(h(TagInput, { value: ['M'], onChange: noop, labels: { remove: (t) => `Togli ${t}` } }))).toContain('aria-label="Togli M"')
    expect(render(h(TagInput, { value: [], onChange: noop, labels: { add: 'Aggiungi…' } }))).toContain('placeholder="Aggiungi…"')
    expect(render(h(TagInput, { value: ['M'], onChange: noop }))).toContain('aria-label="Remove M"')
    expect(render(h(TagInput, { value: [], onChange: noop }))).toContain('placeholder="Add value…"')
  })
})

describe('Lightbox and ReplyComposer words', () => {
  const LB: LightboxLabels = {
    title: (p, t) => `Foto ${p} di ${t}`, counter: (p, t) => `${p} di ${t}`, previous: 'Foto precedente', next: 'Foto successiva',
    only: 'È l’unica foto.', first: 'È la prima foto.', last: 'È l’ultima foto.', photos: 'Foto', thumb: (p, t, c) => `Foto ${p} di ${t}${c ? ', mostrata ora' : ''}`,
    move: 'sposta', close: 'chiudi', modal: { close: 'Chiudi' },
  }

  it('Lightbox: title, counter, buttons, held reasons, strip, keys line, close', () => {
    const items = [{ url: 'https://x.invalid/1.jpg', alt: 'Uno' }, { url: 'https://x.invalid/2.jpg', alt: 'Due' }]
    const html = render(h(Lightbox, { open: true, onClose: noop, items, index: 0, onIndex: noop, labels: LB }))
    for (const word of ['Foto 1 di 2', '>1 di 2<', 'aria-label="Foto precedente"', 'aria-label="Foto successiva"', 'È la prima foto.', 'aria-label="Foto"', 'Foto 1 di 2, mostrata ora', ' sposta · ', ' chiudi', 'aria-label="Chiudi"']) {
      expect(html).toContain(word)
    }
    expect(html).not.toMatch(/Photo|photo|>1 of 2<| move | close<|aria-label="Close"/)
    const english = render(h(Lightbox, { open: true, onClose: noop, items, index: 0, onIndex: noop }))
    for (const word of ['Photo 1 of 2', '>1 of 2<', 'aria-label="Previous photo"', 'This is the first photo.', ' move · ', 'aria-label="Close"']) expect(english).toContain(word)
    expect(lightboxCounter(1, 4)).toBe('2 of 4')
    expect(lightboxHeld(0, 1, 1)).toBe('This is the only photo.')
    expect(lightboxThumbLabel(1, 4, true)).toBe('Photo 2 of 4, shown now')
    expect(lightboxHeld(0, 1, 1, LB)).toBe('È l’unica foto.')
  })

  it('ReplyComposer: its own words, the held reasons and the counter', () => {
    const RC: Partial<ReplyComposerLabels> = {
      title: 'Risposta', label: 'Risposta', placeholder: 'Scrivi una risposta', templates: 'Modelli', draft: 'Bozza con l’IA', text: 'Testo della risposta',
      emptyHeld: 'Scrivi prima una risposta.', sent: 'Inviata', length: (n) => `${n} caratteri`, textarea: { counter: (u, l) => `${u} su ${l}`, tooLong: (o) => `${o} caratteri di troppo` },
    }
    const html = render(h(ReplyComposer, { value: '', onChange: noop, limit: 500, ruleLine: 'Regola', primary: { label: 'Invia', onClick: noop }, templates: [{ id: 't', label: 'T1', body: 'x' }], draft: { onDraft: noop, busy: false }, labels: RC }))
    for (const word of ['>Risposta<', 'aria-label="Risposta"', 'placeholder="Scrivi una risposta"', 'Modelli ', 'Bozza con l’IA', '>Testo della risposta<', 'Scrivi prima una risposta.', '0 su 500']) expect(html).toContain(word)
    expect(html).not.toMatch(/Reply|Templates|Draft with AI|Write a reply/)
    expect(render(h(ReplyComposer, { value: 'ciao', onChange: noop, limit: null, ruleLine: 'Regola', primary: { label: 'Invia', onClick: noop }, labels: RC }))).toContain('4 caratteri')
    expect(render(h(ReplyComposer, { value: '', onChange: noop, limit: null, ruleLine: 'R', sent: { text: 'x', at: 'ora', note: '' }, labels: RC }))).toContain('>Inviata<')
    const english = render(h(ReplyComposer, { value: '', onChange: noop, limit: 500, ruleLine: 'Rule', primary: { label: 'Send', onClick: noop } }))
    for (const word of ['>Reply<', 'placeholder="Write a reply, pick a template or draft one with AI"', '>Reply text<', 'Write a reply first.']) expect(english).toContain(word)
    expect(replyHeldReason({ text: 'x'.repeat(502), limit: 500 })).toBe('Cut 2 characters to send it (the limit is 500).')
    expect(replyLengthWords('abc')).toBe('3 characters')
  })
})
