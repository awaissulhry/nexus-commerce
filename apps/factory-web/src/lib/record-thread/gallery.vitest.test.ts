import { readFileSync } from 'node:fs'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales'
import { BRAND_BETA } from '../testing/two-brands'
import { scanText } from '../testing/brand-scan'
import { designScreen } from './fixtures'
import { leftKeys, renderView, textOf } from './parts/testing'
import type { ThreadCaseModel } from './ThreadCase'

/**
 * tw- T.1 (THE THREAD REBUILD; 20-preview-thread.html; B13): the picture's gallery — every `tw-` case of SCR-006-thread drawn in each
 * language, split per language and per section (the picture's cases, the roles, the states), so a failure names its case: no message
 * key left on screen, nothing of Brand Beta, never a menu or a window open on the server render; the third stage (433 / 593).
 */

const KEYS = ['record', 'head', 'feed', 'card', 'menu', 'foot', 'quote', 'mode', 'send', 'placeholder', 'state', 'answers', 'owner', 'files', 'keys', 'pinbar', 'step', 'author', 'link', 'held', 'box', 'unread', 'down', 'allOf', 'allOfCustomer', 'width', 'view', 'more']
const SECTIONS: ReadonlyArray<readonly [string, (id: string) => boolean]> = [
  ['the picture’s cases', (id) => id.startsWith('tw-') && !id.startsWith('tw-role-') && !id.startsWith('tw-state-')],
  ['the roles', (id) => id.startsWith('tw-role-')],
  ['the states', (id) => id.startsWith('tw-state-')],
]
const draw = (model: ThreadCaseModel, locale: (typeof LOCALES)[number]) => renderView(designScreen.view as ComponentType<{ model: ThreadCaseModel }>, model, locale)

for (const locale of LOCALES) {
  for (const [section, inSection] of SECTIONS) {
    describe(`tw- T.1 gallery · ${locale} · ${section}`, () => {
      const cases = designScreen.cases.filter((item) => inSection(item.id))
      it('has its cases', () => expect(cases.length).toBeGreaterThan(0))
      for (const item of cases) {
        it(`${item.id}: no key on screen, nothing of Brand Beta, no menu or window open`, () => {
          const html = draw(item.model, locale)
          expect(leftKeys(html, KEYS)).toEqual([])
          expect(scanText(textOf(html), BRAND_BETA)).toEqual([])
          expect(html).not.toContain('role="menu"')
          expect(html).not.toContain('role="dialog"')
          expect(html).toContain('fw-rt-column')
        })
      }
    })
  }
}

describe('tw- T.1 gallery · the picture’s facts', () => {
  const html = (id: string) => draw(designScreen.cases.find((item) => item.id === id)!.model, 'en')

  it('every case of the picture and every role and state is there', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['tw-busy-third', 'tw-busy-forty', 'tw-note-beside-shared', 'tw-mail-bounce', 'tw-quote-far', 'tw-pins', 'tw-hidden-floor', 'tw-pills', 'tw-empty', 'tw-role-owner', 'tw-role-sales', 'tw-role-production', 'tw-role-read-only', 'tw-state-loading', 'tw-state-error', 'tw-state-forbidden', 'tw-state-step-up', 'tw-state-offline', 'tw-state-closed']) expect(ids, id).toContain(id)
  })

  it('B13: a third stage beside 40 % (433 px at 1440, 593 px at 1920)', () => {
    expect(html('tw-busy-third')).toContain('class="fw-rt-stage is-third"')
    expect(html('tw-busy-forty')).toContain('class="fw-rt-stage"')
    expect(readFileSync(new URL('./parts/docked-stage.css', import.meta.url), 'utf8')).toMatch(/\.fw-rt-stage\.is-third \{\s*grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\);/)
  })

  it('the cases say what the picture shows: pins, hidden floor writers, status words, the bounce, the far quote, the read-only box', () => {
    expect(html('tw-pins')).toContain('fw-rt-pinbar')
    expect(textOf(html('tw-hidden-floor'))).toContain('A person on the floor')
    const pills = textOf(html('tw-pills'))
    expect(pills).not.toMatch(/CONFIRMED|IN_PRODUCTION|SOME_CODE_WITHOUT_WORDS/)
    expect(html('tw-mail-bounce')).toContain('fw-rt-bounce')
    expect(html('tw-quote-far')).toContain('fw-rt-quote')
    expect(textOf(html('tw-role-read-only'))).toContain('You can read this thread; writing in it needs another role.')
    expect(textOf(html('tw-state-step-up'))).toContain('Confirm it')
  })
})
