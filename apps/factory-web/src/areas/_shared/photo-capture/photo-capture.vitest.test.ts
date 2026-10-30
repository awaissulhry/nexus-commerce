import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PHOTO_CAPTURE_WORDS } from '@nexus/ui/components/PhotoCapture/index'
import { I18nProvider } from '../../../lib/i18n/provider'
import { createTranslator, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { designScreen } from './fixtures'
import { PhotoCaptureLabView } from './view/PhotoCaptureLabView'
import { PHOTO_KIT_NAMESPACE, PHOTO_WORD_KEYS, photoWordsOf } from '../../../lib/ds-words/photo-capture'

describe('photo-kit words (DS photo capture, D21)', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale, messagesFor(locale, [PHOTO_KIT_NAMESPACE])[PHOTO_KIT_NAMESPACE] ?? {})

    it(`${locale}: every word the part takes, with the DS's own placeholders`, () => {
      const words = photoWordsOf(t)
      for (const key of PHOTO_WORD_KEYS) {
        expect(words[key], key).not.toBe(`photo.${key}`)
        expect(placeholdersOf(words[key]), key).toEqual(placeholdersOf(PHOTO_CAPTURE_WORDS[key]))
      }
    })
  }
})

describe('SCR-247 design cases', () => {
  it('every state the design names is a case', () => {
    expect(designScreen.screen).toBe('SCR-247')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['camera', 'camera-denied', 'camera-missing', 'markup', 'keyboard', 'ready', 'required', 'offline', 'floor', 'comfortable', 'phone', 'read-only'])
  })

  it('draws in Italian with no key on screen', () => {
    for (const item of designScreen.cases) {
      const out = render(h(I18nProvider, { locale: 'it', messages: {} }, h(PhotoCaptureLabView, { model: item.model })))
      expect(out, item.id).not.toMatch(/photo\.|lab\./)
      if (item.id === 'camera') {
        expect(out).toContain('Niente volti nella foto')
        expect(out).toContain('Avvia la fotocamera')
        expect(out).toContain('Usa un file')
      }
      if (item.id === 'camera-denied') expect(out).toContain('La fotocamera è bloccata per questa pagina')
      if (item.id === 'markup') {
        expect(out).toContain('2 segni')
        expect(out).toContain('<li>Cerchio 1 in alto</li>')
        expect(out).toContain('Freccia 2: parte in basso a sinistra e punta a sinistra')
      }
      if (item.id === 'required') expect(out).toMatch(/aria-description="Prima cerchia il problema[^"]*"[^>]*>.*?Usa la foto/)
      if (item.id === 'offline') {
        expect(out).toContain('data-density="floor"')
        expect(out).toContain('Offline: la foto resta nella coda')
        // Offline does not hold the part: Use photo can run.
        expect(out).not.toMatch(/aria-description="[^"]*"[^>]*>(?:(?!<button).)*Usa la foto/)
      }
      if (item.id === 'comfortable') expect(out).toContain('Mettiti dentro la sagoma')
    }
  })

  it('draws in English', () => {
    const out = render(h(I18nProvider, { locale: 'en', messages: {} }, h(PhotoCaptureLabView, { model: designScreen.cases[3]!.model })))
    expect(out).toContain('aria-label="Photo of the defect"')
    expect(out).toContain('<li>Circle 1 around top</li>')
    expect(out).toContain('Use photo')
  })
})
