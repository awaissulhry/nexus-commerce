import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { textOf } from '../../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'
import { RECORD_NAMESPACES } from './OrderRecord'

/**
 * W1 browser repair (the browser golden flow's 06b-deposit): the order's step-up ("Confirm it's you", issuing the TD02, sending
 * to SDI, waiving a step) drawn with the catalogues the order's page loads, not every catalogue as the design index does. The
 * record passed the DS labels of a catalogue the page never loads, so its code field read "stepUp.code" and the browser flow
 * could not find "Two-factor code".
 */

// The DS Modal opens only in a browser (after hydration, in a portal): here the DS step-up draws in place the words it is given.
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const StepUpModal = ({ open, title, labels }: { open: boolean; title: string; labels?: Record<string, string> }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title), createElement('label', null, labels?.code), createElement('p', null, labels?.codeHint), createElement('button', null, labels?.cancel)) : null
  return { ...actual, StepUpModal }
})

const view = designScreen.view as ComponentType<{ model: unknown }>
const stepUp = designScreen.cases.find((item) => item.id === 'step-up')!.model

describe('the order’s step-up in the page’s own catalogues', () => {
  for (const locale of ['en', 'it'] as const) {
    it(`${locale}: the code field, its hint and Cancel in words, never a message key`, () => {
      const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, [...RECORD_NAMESPACES]) }, createElement(view, { model: stepUp })))
      const text = textOf(html)
      expect(text).not.toMatch(/stepUp\.(code|codeHint|cancel|confirm|checking)/)
      if (locale === 'en') {
        expect(text).toContain('Two-factor code')
        expect(text).toContain('The 6-digit code from your authenticator app.')
      }
    })
  }
})
