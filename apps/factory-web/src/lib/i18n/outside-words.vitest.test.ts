import { createElement, type ComponentType, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import LinksLayout from '../../app/(links)/layout'
import PortalLayout from '../../app/(portal)/layout'
import { designScreen as officeChangeRecord } from '../../areas/products/changes/record/fixtures'
import { designScreen as portalNewOrder } from '../../portal/customer/neworder/fixtures'
import { usePhotoWords } from '../ds-words/photo-capture'
import { LastMessageCell } from '../last-message-cell/view/LastMessageCell'
import { pdfViewerLabels } from '../pdf/labels'
import { render, textOf } from '../record-thread/parts/testing'
import { useDsLabels } from './ds-labels'
import { useDsWords } from './ds-parts'
import { LOCALES, type Locale } from './locales'
import { CATALOGUE, OUTSIDE_WORDS, outsideWordsOf, placeholdersOf, type Reader } from './messages'
import { ReaderProvider, useReader, useScopedT, useT } from './provider'

/**
 * fix-voi-2 — the portal's own words for the keys it shares with the office (messages.ts Reader, outside-words.json): the portal
 * and the link pages read voi (#1618: a business writes to a business), an office screen still reads today's word, from the
 * SAME key. One rule: the route groups say who reads, every translator (useT, useScopedT, the DS parts' own words) reads the
 * outside words over the shared catalogue.
 */

/** Every outside word: [namespace, key, Italian]. */
const OUTSIDE: Array<[string, string, string]> = Object.entries(CATALOGUE.it[OUTSIDE_WORDS] ?? {}).map(([path, text]) => [path.slice(0, path.indexOf('.')), path.slice(path.indexOf('.') + 1), text])
/** A second-person-singular word (the office's "tu"): never in what a reader outside reads. */
const TU = /\b(tu|tuo|tua|tuoi|tue|ti|te|hai|puoi|sei|vuoi|devi)\b/i

/** What a hook answers inside the page's providers, with no reader set (the office) or the one given. */
function read<T>(reader: Reader | null, use: () => T, locale: Locale = 'it'): T {
  let out: T | undefined
  function Probe() {
    out = use()
    return null
  }
  const node = createElement(Probe)
  render(reader ? createElement(ReaderProvider, { reader }, node) : node, locale)
  return out as T
}

const view = <M,>(screen: { view: ComponentType<{ model: M; children?: ReactNode }>; cases: readonly { id: string; model: M }[] }, id: string) =>
  createElement(screen.view, { model: screen.cases.find((item) => item.id === id)!.model })

describe('the outside words (outside-words.json)', () => {
  it('each one is a key of its shared catalogue, with the same placeholders, in every language', () => {
    expect(OUTSIDE.length).toBeGreaterThan(0)
    for (const locale of LOCALES) {
      const own = Object.keys(CATALOGUE[locale][OUTSIDE_WORDS] ?? {})
      expect(own.sort(), locale).toEqual(OUTSIDE.map(([namespace, key]) => `${namespace}.${key}`).sort())
      for (const [namespace, key] of OUTSIDE) {
        const shared = CATALOGUE[locale][namespace]?.[key]
        expect(shared, `${locale} ${namespace}:${key}`).toBeTypeOf('string')
        expect(placeholdersOf(outsideWordsOf(locale, namespace)[key] ?? ''), `${locale} ${namespace}:${key}`).toEqual(placeholdersOf(shared ?? ''))
      }
    }
  })

  it('each Italian one is voi and differs from the office word (else it would not be here)', () => {
    for (const [namespace, key, text] of OUTSIDE) {
      expect(text, `${namespace}:${key}`).not.toMatch(TU)
      expect(text, `${namespace}:${key}`).not.toBe(CATALOGUE.it[namespace]?.[key])
    }
  })
})

describe('who reads', () => {
  it('the portal’s and the links’ route groups say outside; nothing said is the office', () => {
    const probe = (layout: ComponentType<{ children: ReactNode }>) => {
      let reader: Reader | undefined
      function Probe() {
        reader = useReader()
        return null
      }
      render(createElement(layout, { children: createElement(Probe) }), 'it')
      return reader
    }
    expect(probe(PortalLayout)).toBe('outside')
    expect(probe(LinksLayout)).toBe('outside')
    expect(read(null, useReader)).toBe('office')
  })
})

describe('the portal reads voi, the office today’s word — the same key', () => {
  it('every outside word through the page’s translators (useT, useScopedT)', () => {
    for (const [namespace, key, text] of OUTSIDE) {
      expect(read('outside', () => useT(namespace)(key)), `${namespace}:${key}`).toBe(text)
      expect(read('outside', () => useScopedT('shell')(`${namespace}:${key}`)), `${namespace}:${key}`).toBe(text)
      expect(read(null, () => useT(namespace)(key)), `${namespace}:${key}`).toBe(CATALOGUE.it[namespace]?.[key])
      expect(read('office', () => useT(namespace)(key)), `${namespace}:${key}`).toBe(CATALOGUE.it[namespace]?.[key])
    }
    // English: the same words for both (one register), but the portal's step-up code comes by e-mail, not from an app.
    expect(read('outside', () => useT('last-message')('columnHint'), 'en')).toBe(CATALOGUE.en['last-message']?.columnHint)
    expect(read('outside', () => useT('ds-words')('stepUp.codeHint'), 'en')).toBe('The 6-digit code we sent you by e-mail.')
    expect(read(null, () => useT('ds-words')('stepUp.codeHint'), 'en')).toBe('The 6-digit code from your authenticator app.')
  })

  it('the parts that read their words themselves: DS parts, DS labels, the PDF viewer, the photo capture', () => {
    expect(read('outside', () => useDsWords().stepUp.codeHint)).toBe('Il codice di 6 cifre che vi abbiamo inviato per e-mail.')
    expect(read(null, () => useDsWords().stepUp.codeHint)).toBe('Il codice di 6 cifre dalla tua app di autenticazione.')
    expect(read('outside', () => useDsLabels().fileDropzone.prompt)).toBe('Trascinate qui un file o fate clic per caricarlo')
    expect(read(null, () => useDsLabels().fileDropzone.prompt)).toBe('Trascina qui un file o fai clic per caricarlo')
    expect(read('outside', () => useDsWords().orderedList.reorder('Ordine A'))).toBe('Riordina Ordine A; usate le frecce')
    expect(read(null, () => useDsWords().orderedList.reorder('Ordine A'))).toBe('Riordina Ordine A; usa le frecce')
    expect(read('outside', () => pdfViewerLabels(useT('shell')).previewUnavailable)).toContain('Scaricate il documento')
    expect(read(null, () => pdfViewerLabels(useT('shell')).previewUnavailable)).toContain('Scarica il documento')
    expect(read('outside', () => usePhotoWords().guideFrame)).toBe('Tenete il pezzo dentro la cornice')
    expect(read(null, () => usePhotoWords().guideFrame)).toBe('Tieni il pezzo dentro la cornice')
  })

  it('screens: the portal New order’s drop zone and the New messages cell in voi; the office’s change request drop zone as today', () => {
    // (The step-up pop-up draws only in a browser: its words are read above, as the DS part gets them.)
    const portal = textOf(render(createElement(PortalLayout, { children: view(portalNewOrder, 'upload') }), 'it'))
    expect(portal).toContain('Trascinate qui un file o fate clic per caricarlo')
    expect(portal).not.toContain('Trascina qui un file')
    const office = textOf(render(view(officeChangeRecord, 'request'), 'it'))
    expect(office).toContain('Trascina qui un file o fai clic per caricarlo')

    const cell = createElement(LastMessageCell, { unread: { newCount: 2, lastAt: '2026-11-17T09:12:00.000Z' }, href: '/p/BA/orders/x#messages', record: 'Ordine 21' })
    expect(render(createElement(PortalLayout, { children: cell }), 'it')).toContain('aria-label="2 messaggi nuovi su Ordine 21: aprite la conversazione al primo nuovo"')
    expect(render(cell, 'it')).toContain('aria-label="2 messaggi nuovi su Ordine 21: apri la conversazione al primo nuovo"')
  })
})

describe('words only the portal and the link pages read are voi in their own catalogue', () => {
  it('EndState and RefPair (portal and link parts), the public safety notice, the report dialog from outside', () => {
    const outsideOnly: Array<[string, RegExp]> = [
      ['ds-words', /^(endState|refPair)\./],
      ['compliance-register-depth', /^publicNotice\./],
      ['safety-reports', /^(portal\.|public\.|dialog\.(step\.|sent|privacy|photosLater)|common\.discard|held\.wait|refused\.wait)/],
    ]
    for (const [namespace, keys] of outsideOnly) {
      const words = Object.entries(CATALOGUE.it[namespace] ?? {}).filter(([key]) => keys.test(key))
      expect(words.length, namespace).toBeGreaterThan(0)
      for (const [key, text] of words) expect(text, `${namespace}:${key}`).not.toMatch(TU)
    }
  })
})
