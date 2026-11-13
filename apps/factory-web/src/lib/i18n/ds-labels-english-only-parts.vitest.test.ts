import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Home, Package } from 'lucide-react'

// The Lightbox's dialog portals into <body> once hydrated: inline the portal and say "hydrated", so Node renders it.
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))
vi.mock('@nexus/ui/components/useHydrated', () => ({ useHydrated: () => true }))

import { LISTBOX_LABELS, MULTI_SELECT_LABELS, ORDERED_LIST_LABELS, Listbox, ListboxPanel, MultiSelect, OptionList, OrderedList } from '@nexus/ui/components'
import { APP_RAIL_LABELS, AppRail, LIGHTBOX_LABELS, Lightbox, REPLY_COMPOSER_LABELS, ReplyComposer, WORKSPACE_SUBHEADER_LABELS, WorkspaceSubheader, type RailLinkProps } from '@nexus/ui/patterns'
import { CHANGE_VALUE_LABELS, ChangeValue } from '@nexus/ui/grid'
import { TAG_INPUT_LABELS, TagInput } from '@nexus/ui/primitives'
import { dsLabels, type DsLabels } from './ds-labels'
import { ChangeValue as PartsChangeValue, Listbox as PartsListbox, MultiSelect as PartsMultiSelect, OrderedList as PartsOrderedList, TagInput as PartsTagInput } from './ds-parts'
import { CATALOGUE, createTranslator, messagesFor } from './messages'
import type { Locale } from './locales'
import { I18nProvider } from './provider'
import { designScreen as shellScreen } from '../../shell/office/fixtures'
import { OfficeShellView } from '../../shell/office/view/OfficeShellView'
import { designScreen as labScreen } from './ds-words-lab/fixtures'

/**
 * B-W2b-F41 — the words of the DS parts that spoke English only, in the `ds-words` catalogue (the B-W2b-04 rule): every
 * word in both languages, the English is the DS's own English, the Italian differs where the words differ, and it
 * reaches the parts.
 */
const ds = (locale: Locale): DsLabels => dsLabels(createTranslator(locale, CATALOGUE[locale]['ds-words'] ?? {}), locale)
const IT = ds('it')
const EN = ds('en')

type Part = 'workspaceSubheader' | 'appRail' | 'changeValue' | 'multiSelect' | 'listbox' | 'orderedList' | 'tagInput' | 'lightbox' | 'replyComposer'
const DEFAULTS: ReadonlyArray<readonly [Part, object]> = [
  ['workspaceSubheader', WORKSPACE_SUBHEADER_LABELS],
  ['appRail', APP_RAIL_LABELS],
  ['changeValue', CHANGE_VALUE_LABELS],
  ['multiSelect', MULTI_SELECT_LABELS],
  ['listbox', LISTBOX_LABELS],
  ['orderedList', ORDERED_LIST_LABELS],
  ['tagInput', TAG_INPUT_LABELS],
  ['lightbox', LIGHTBOX_LABELS],
  ['replyComposer', REPLY_COMPOSER_LABELS],
]

/** Arguments for each word function: every branch (one / many, with / without a label). */
const SAMPLES: Readonly<Record<string, ReadonlyArray<readonly unknown[]>>> = {
  'workspaceSubheader.expand': [['Warehouse pages']], 'workspaceSubheader.collapse': [['Warehouse pages']], 'workspaceSubheader.close': [['Warehouse pages']],
  'workspaceSubheader.showRows': [['Amazon', 'markets']], 'workspaceSubheader.hideRows': [['Amazon', 'markets']], 'workspaceSubheader.rows': [['Amazon', 'markets']],
  'workspaceSubheader.currentInside': [['Amazon']],
  'appRail.withCount': [['Home', 1], ['Home', 12]], 'appRail.count': [[1], [12]], 'appRail.newTab': [['Help']], 'appRail.expand': [['Sales']],
  'appRail.collapse': [['Sales']], 'appRail.expandMarkets': [['Amazon']], 'appRail.collapseMarkets': [['Amazon']], 'appRail.seeAllMarkets': [[12]],
  'changeValue.more': [[1], [3]], 'changeValue.changes': [[1], [3]], 'changeValue.saidChanged': [['Price: ', '€ 1', '€ 2'], ['', '1', '2']],
  'changeValue.saidAdded': [['Price: ', '€ 2'], ['', '2']], 'changeValue.saidRemoved': [['Price: ', '€ 1']], 'changeValue.saidUnchanged': [['Stock: ', '5']],
  'changeValue.saidEmpty': [['Note: '], ['']], 'changeValue.saidMore': [[1], [3]], 'changeValue.saidAndMore': [['a; b', 'c']],
  'multiSelect.atLeast': [[1], [2]], 'multiSelect.selected': [[1], [3]],
  'listbox.useTyped': [['Nero']],
  'orderedList.moveUp': [['Sewing']], 'orderedList.moveDown': [['Sewing']], 'orderedList.reorder': [['Sewing']],
  'orderedList.position': [['Sewing', 2, 5]], 'orderedList.moving': [['Sewing', 2, 5]],
  'tagInput.remove': [['M']],
  'lightbox.title': [[1, 1], [2, 4]], 'lightbox.counter': [[1, 1], [2, 4]], 'lightbox.thumb': [[2, 4, true], [2, 4, false]],
  'replyComposer.over': [[1, 500], [38, 500], [1234, 5000]], 'replyComposer.length': [[1], [312], [1234]],
  'replyComposer.textarea.counter': [[12, 500], [1234, 5000]], 'replyComposer.textarea.tooLong': [[1], [38]],
}
const samplesFor = (key: string) => SAMPLES[key] ?? [['x', 'y']]

function* pairs(prefix: string, def: object, mine: object): Generator<[string, unknown, unknown]> {
  for (const [key, value] of Object.entries(def)) {
    const path = `${prefix}.${key}`
    const own = (mine as Record<string, unknown>)?.[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) yield* pairs(path, value, own as object)
    else yield [path, value, own]
  }
}
const call = (fn: unknown, args: readonly unknown[]) => (fn as (...a: unknown[]) => unknown)(...args)

describe('the B-W2b-F41 parts’ words in the ds-words catalogue', () => {
  it('every word has a word in each language (nothing falls back to the DS English, no key leaks)', () => {
    for (const labels of [IT, EN]) for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, labels[part])) {
        expect(own, `${path} is missing`).toBeDefined()
        expect(typeof own, path).toBe(typeof value)
        if (typeof own === 'function') for (const args of samplesFor(path)) expect(String(call(own, args)), path).not.toMatch(/(?:^|\s)[a-zA-Z]+\.[a-zA-Z.]+(?:$|\s)/)
        else if (typeof own === 'string') expect(own, path).not.toMatch(/^[a-zA-Z]+\.[a-zA-Z.]+$/)
      }
    }
  })

  it('the English catalogue says exactly the DS English', () => {
    for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, EN[part])) {
        if (typeof value === 'function') for (const args of samplesFor(path)) expect(call(own, args), `${path}(${JSON.stringify(args)})`).toBe(call(value, args))
        else expect(own, path).toEqual(value)
      }
    }
  })

  it('the Italian differs from the English wherever the words differ', () => {
    // The same in both languages: a join and the counter's "12 / 500".
    const same = new Set(['changeValue.saidJoin', 'replyComposer.textarea.counter'])
    for (const [part, def] of DEFAULTS) {
      for (const [path, value, own] of pairs(part, def, IT[part])) {
        if (same.has(path)) continue
        if (typeof value === 'string') expect(own, path).not.toBe(value)
        if (typeof value === 'function') {
          const en = [...pairs(part, def, EN[part])].find(([p]) => p === path)![2]
          for (const args of samplesFor(path)) expect(call(own, args), `${path}(${JSON.stringify(args)})`).not.toBe(call(en, args))
        }
      }
    }
    expect(IT.workspaceSubheader.expand('Pagine di Magazzino')).toBe('Apri pagine di magazzino')
    expect(IT.appRail.withCount('Casa', 3)).toBe('Casa, 3 in attesa')
    expect(IT.changeValue.saidAndMore('Prezzo: da € 1 a € 2', IT.changeValue.saidMore(1))).toBe('Prezzo: da € 1 a € 2; e 1 altra modifica')
    expect(IT.multiSelect.selected(1)).toBe('1 selezionato')
    expect(IT.replyComposer.over(1234, 5000)).toBe('Togli 1234 caratteri per inviarla (il limite è 5000).')
    expect(IT.replyComposer.length(12345)).toBe('12.345 caratteri')
  })
})

describe('the words reach the parts: an Italian page shows no DS English', () => {
  const saved: Record<string, unknown> = {}
  const noop = () => {}
  beforeAll(() => {
    for (const k of ['document', 'getComputedStyle']) saved[k] = (globalThis as Record<string, unknown>)[k]
    ;(globalThis as Record<string, unknown>).document = { body: {}, activeElement: null, documentElement: {}, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop }
    ;(globalThis as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: () => '' })
  })
  afterAll(() => { for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v })
  const html = (...nodes: ReactNode[]) => nodes.map((node) => renderToStaticMarkup(node as never)).join('')
  const Link = ({ href, children, ...rest }: RailLinkProps) => createElement('a', { ...rest, href }, children)

  it('the shell: the rail and the area navigation', () => {
    const out = html(
      createElement(AppRail, { navItems: [{ label: 'Casa', href: '/home', Icon: Home }, { label: 'Vendite', href: '/sales', Icon: Package, badge: 2 }], pathname: '/home', LinkComponent: Link, labels: IT.appRail }),
      createElement(WorkspaceSubheader, { navigationLabel: 'Pagine di Magazzino', groups: [{ id: 'g', label: 'Merci', items: [{ id: 'p', label: 'Giacenze', href: '/w' }] }], labels: IT.workspaceSubheader }),
    )
    for (const word of ['aria-label="Navigazione principale"', 'aria-label="Vendite, 2 in attesa"', 'aria-label="2 in attesa"', 'Apri pagine di magazzino']) expect(out).toContain(word)
    expect(out).not.toMatch(/Application navigation|pending|Expand/)
  })

  it('ChangeValue, the pickers, the ordered list and the tag field', () => {
    const options = [{ value: 'a', label: 'Uno' }, { value: 'b', label: 'Due' }]
    const out = html(
      createElement(ChangeValue, { changes: [{ label: 'Ore', from: '8', to: null }, { label: 'Turno', from: 'A', to: 'A' }], more: 1, labels: IT.changeValue }),
      createElement(MultiSelect, { options, value: ['a'], onChange: noop, labels: IT.multiSelect }),
      createElement(MultiSelect, { options, value: [], onChange: noop, labels: IT.multiSelect }),
      createElement(OptionList, { options, value: ['a'], onChange: noop, searchable: true, initialQuery: 'zzz', labels: IT.multiSelect }),
      createElement(Listbox, { options, value: undefined, onChange: noop, labels: IT.listbox }),
      createElement(ListboxPanel, { options: [], value: undefined, onCommit: noop, onCancel: noop, searchable: true, labels: IT.listbox }),
      createElement(OrderedList, { label: 'Fasi', items: ['Taglio', 'Cucito'], onChange: noop, labels: IT.orderedList }),
      createElement(TagInput, { value: ['M'], onChange: noop, labels: IT.tagInput }),
    )
    for (const word of ['>rimosso<', '>invariato<', '+1 altre', 'Ore: 8 rimosso; Turno: invariato, A; e 1 altra modifica', '>1 selezionato<', '>Tutti<', 'Cerca tra le opzioni', 'Seleziona tutto', 'Nessun risultato', 'Scegli…', 'Sposta Taglio giù', 'aria-label="Togli M"'])
      expect(out).toContain(word)
    expect(out).not.toMatch(/>[^<]*\b(removed|unchanged|more|selected|All|Select all|No matches|Search options|Select…|Move |Remove )[^<]*</)
    expect(out).not.toMatch(/aria-label="(Search options|Remove M)"/)
  })

  it('the lightbox and the reply composer', () => {
    const out = html(
      createElement(Lightbox, { open: true, onClose: noop, items: [{ url: 'https://x.invalid/1.jpg', alt: 'Giacca' }], index: 0, onIndex: noop, labels: IT.lightbox }),
      createElement(ReplyComposer, { value: '', onChange: noop, limit: 2000, ruleLine: 'Regola', primary: { label: 'Invia', onClick: noop }, labels: IT.replyComposer }),
    )
    for (const word of ['Foto 1 di 1', '>1 di 1<', 'aria-label="Foto precedente"', 'È l&#x27;unica foto.', ' sposta · ', ' chiudi', 'aria-label="Chiudi"', '>Risposta<', '>Testo della risposta<', 'Scrivi prima una risposta.', '0 / 2000'])
      expect(out).toContain(word)
    expect(out).not.toMatch(/Photo|photo| move | close<|aria-label="Close"|>Reply|Reply text|Write a reply/)
  })
})

describe('the screens get the words without passing them', () => {
  const page = (locale: Locale, node: ReactNode) =>
    renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, node as never))

  it('the screens’ parts (lib/i18n/ds-parts) speak the page’s language, English = the DS English', () => {
    const parts = (locale: Locale) => page(locale, createElement('div', null,
      createElement(PartsMultiSelect, { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: ['a'], onChange: () => {} }),
      createElement(PartsListbox, { options: [{ value: 'a', label: 'A' }], value: undefined, onChange: () => {} }),
      createElement(PartsOrderedList, { label: 'L', items: ['x', 'y'], onChange: () => {} }),
      createElement(PartsTagInput, { value: ['M'], onChange: () => {} }),
      createElement(PartsChangeValue, { changes: [{ label: 'Ore', from: '8', to: null }] }),
    ))
    const italian = parts('it')
    for (const word of ['>1 selezionato<', 'Scegli…', 'Sposta x giù', 'aria-label="Togli M"', '>rimosso<']) expect(italian).toContain(word)
    const en = parts('en')
    for (const word of ['>1 selected<', 'Select…', 'Move x down', 'aria-label="Remove M"', '>removed<']) expect(en).toContain(word)
  })

  it('the Office shell: the rail and the area navigation’s button (SCR-003, Warehouse)', () => {
    const warehouse = shellScreen.cases.find((entry) => entry.id === 'warehouse')!.model
    const italian = page('it', createElement(OfficeShellView, { model: warehouse }))
    expect(italian).toContain('aria-label="Navigazione principale"')
    expect(italian).toMatch(/aria-label="Apri pagine di [^"]+"/)
    expect(italian).not.toMatch(/Application navigation|aria-label="Expand /)
    const en = page('en', createElement(OfficeShellView, { model: warehouse }))
    expect(en).toContain('aria-label="Application navigation"')
    expect(en).toMatch(/aria-label="Expand [^"]+"/)
  })
})

describe('the DS words lab shows them (/design/ds-words)', () => {
  const saved: Record<string, unknown> = {}
  beforeAll(() => {
    for (const k of ['document', 'getComputedStyle']) saved[k] = (globalThis as Record<string, unknown>)[k]
    ;(globalThis as Record<string, unknown>).document = { body: {}, activeElement: null, documentElement: {}, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} }
    ;(globalThis as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: () => '' })
  })
  afterAll(() => { for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v })
  const lab = (locale: Locale, id: string) =>
    renderToStaticMarkup(createElement(I18nProvider, { locale, messages: {} }, createElement(labScreen.view, { model: labScreen.cases.find((entry) => entry.id === id)!.model })))

  it('every part on "Every part", the photos on "Photos", in Italian; the same parts in the DS English', () => {
    const parts = lab('it', 'parts')
    for (const word of ['Navigazione, scelte, elenchi, foto e risposte', 'aria-label="Apri pagine di magazzino"', '>rimosso<', '>invariato<', '>1 selezionato<', 'Scegli…', 'Sposta Taglio giù', 'aria-label="Togli 48"', '>Testo della risposta<'])
      expect(parts).toContain(word)
    expect(lab('it', 'lightbox')).toContain('Foto 1 di 2')
    const english = lab('en', 'parts')
    for (const word of ['aria-label="Expand warehouse pages"', '>removed<', '>1 selected<', 'Move Cutting down', '>Reply text<']) expect(english).toContain(word)
  })
})
