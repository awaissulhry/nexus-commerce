import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { designScreen as mailScreen } from '../areas/home/mail-to-sort/fixtures'
import { RECORD_FINDERS } from '../areas/home/mail-to-sort/api'
import { HELD_REASONS, INBOUND_STATUSES, MAIL_FILTERS, MAIL_VERDICTS, PERSON_REJECT_REASONS, SKIP_REASONS } from '../areas/home/mail-to-sort/model'
import type { DesignScreen } from '../lib/design/design-screen'
import { LOCALES } from '../lib/i18n/locales'
import { CATALOGUE, messagesFor, placeholdersOf } from '../lib/i18n/messages'
import { I18nProvider } from '../lib/i18n/provider'
import { designScreen as panelsScreen } from './fixtures'
import { AUTHOR_KINDS, changeVerbKey, EMAIL_STATUSES, FILE_AUDIENCES, FILE_KINDS, PANEL_TABS, QUARANTINE_REASONS, TIMELINE_FILTERS } from './model'
import { FOLLOW_REASONS, followReasonKey } from './tasks/model'

/**
 * Every UI string of the two screens exists in every language (PLAN §4.6, PLT-127): the same keys and placeholders in
 * it and en, every key the code names (literally, or built from an enum) in the catalogue, and every design case drawn
 * in both languages with no message key left on screen. The cases render on the server, as `/design` first draws them.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })
}

/** Strings shaped like keys that are not: the permissions and live events the code names. */
const NOT_KEYS: ReadonlySet<string> = new Set(['files.read', 'files.upload', 'files.manage', 'thread.message_posted', 'thread.followers_changed', 'tasks.manage'])

/** The keys a folder's code names literally (`'files.kind.PHOTO'`), for the prefixes of one catalogue. */
function literalKeys(dir: string, prefixes: readonly string[]): string[] {
  const pattern = new RegExp(`['"\`]((?:${prefixes.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
  const keys = new Set<string>()
  for (const file of sources(dir)) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) if (!NOT_KEYS.has(match[1])) keys.add(match[1])
  return [...keys].sort()
}

const has = (namespace: string, key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale][namespace] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

const RECORDS_PREFIXES = ['panels', 'notice', 'thread', 'composer', 'message', 'files', 'history', 'tasks', 'followers']

const recordsBuilt = [
  ...PANEL_TABS.map((tab) => `panels.tabs.${tab}`),
  ...FILE_KINDS.flatMap((kind) => [`files.kind.${kind}`, `files.kindHint.${kind}`]),
  ...FILE_AUDIENCES.map((audience) => `files.audience.${audience}`),
  ...FILE_AUDIENCES.filter((audience) => audience !== 'OFFICE').map((audience) => `files.upload.share.${audience}`),
  ...[...QUARANTINE_REASONS, 'unknown'].map((reason) => `files.quarantine.${reason}`),
  ...['hashing', 'uploading', 'confirming'].map((phase) => `files.phase.${phase}`),
  ...EMAIL_STATUSES.map((status) => `message.email.${status}`),
  ...AUTHOR_KINDS.map((kind) => `message.author.${kind}`),
  ...TIMELINE_FILTERS.flatMap((filter) => [`history.filter.${filter}`, `history.empty.body.${filter}`]),
  ...FOLLOW_REASONS.map(followReasonKey),
  ...['OFFICE', 'FLOOR', 'PARTNER', 'LINK', 'SYSTEM'].map((audience) => `history.actor.${audience}`),
  ...['create', 'update', 'delete', 'issue', 'suspend', 'reinstate', 'withdraw', 'archive', 'postNote', 'setStatus', 'send', 'requestUpload', 'completeUpload', 'setVisibility', 'setRetention', 'assign', 'release', 'reject', 'other'].map(
    (verb) => changeVerbKey(`module.${verb}`),
  ),
]

const homeBuilt = [
  ...MAIL_FILTERS.flatMap((filter) => [`mailToSort.filter.${filter}`, `mailToSort.empty.${filter}.title`, `mailToSort.empty.${filter}.body`]),
  ...INBOUND_STATUSES.map((status) => `mailToSort.status.${status}`),
  ...HELD_REASONS.flatMap((reason) => [`mailToSort.heldReason.${reason}.short`, `mailToSort.heldReason.${reason}.body`]),
  ...['TRIAGE', 'HELD', 'FAILED'].map((status) => `mailToSort.whyTitle.${status}`),
  ...['spf', 'dkim', 'dmarc', 'spam', 'virus'].map((check) => `mailToSort.check.${check}`),
  ...MAIL_VERDICTS.flatMap((verdict) => [`mailToSort.verdict.auth.${verdict}`, `mailToSort.verdict.content.${verdict}`]),
  ...SKIP_REASONS.map((reason) => `mailToSort.skip.${reason}`),
  ...['assign', 'release', 'reject'].map((action) => `mailToSort.action.${action}`),
  ...PERSON_REJECT_REASONS.flatMap((reason) => [`mailToSort.reject.reason.${reason}.title`, `mailToSort.reject.reason.${reason}.body`, `mailToSort.notice.rejected.${reason}`]),
  ...['thread', 'list'].flatMap((target) => [`mailToSort.release.body.${target}`, `mailToSort.release.go.${target}`]),
  ...RECORD_FINDERS.map((finder) => `mailToSort.recordKind.${finder.type}`),
  'mailToSort.why.FAILED',
]

describe('every string of the record panels and mail to sort exists in it and en (PLAN §4.6)', () => {
  for (const namespace of ['records', 'home']) {
    it(`${namespace}: the same keys and placeholders in every language, no empty text`, () => {
      const en = CATALOGUE.en[namespace] ?? {}
      const itc = CATALOGUE.it[namespace] ?? {}
      expect(Object.keys(en).length).toBeGreaterThan(50)
      expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
      for (const key of Object.keys(en)) {
        expect(en[key]?.trim(), `en ${key}`).not.toBe('')
        expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
        expect(placeholdersOf(itc[key] ?? ''), `placeholders of ${key}`).toEqual(placeholdersOf(en[key] ?? ''))
      }
    })
  }

  it('every key the record panels name exists', () => {
    const keys = [...literalKeys(join(SRC, 'record-panels'), RECORDS_PREFIXES), ...recordsBuilt]
    expect(keys.length).toBeGreaterThan(100)
    expect(keys.filter((key) => !has('records', key))).toEqual([])
  })

  it('every key mail to sort names exists', () => {
    const keys = [...literalKeys(join(SRC, 'areas/home/mail-to-sort'), ['mailToSort']), ...homeBuilt]
    expect(keys.length).toBeGreaterThan(60)
    expect(keys.filter((key) => !has('home', key))).toEqual([])
  })
})

const LEFT_KEY = /\b(?:panels|notice|thread|composer|message|files|history|tasks|followers|mailToSort)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [panelsScreen, mailScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('an internal note and a shared message never look alike (COL-003)', () => {
    const html = render(panelsScreen as DesignScreen<unknown>, panelsScreen.cases.find((item) => item.id === 'conversation')!.model, 'en')
    expect(html).toContain('fw-rp-message is-internal')
    expect(html).toContain('fw-rp-message is-shared')
    expect(html).toContain('Internal note')
    expect(html).toContain('Email to Marchio Demo S.r.l.')
  })
})
