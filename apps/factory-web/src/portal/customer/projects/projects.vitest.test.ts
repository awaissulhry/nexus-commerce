import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROJECT_STATUSES, STATUS_WORDS } from '@nexus/factory-domain/projects/rules'
import type { ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA } from '../../../lib/testing/two-brands'
import { recordPageOf } from '../../shell/nav/portal-nav'
import { fetchPortalProjects, fetchProjectNews } from './api'
import { BETA_PROJECTS, newsOf, PROJECT_ID } from './design-data'
import { designScreen } from './fixtures'
import { MOVE_WORDS, newsLineOf, newsMoveKey, NS, openProjects, pageStateOf, projectBandOf, projectHref, projectOf, STATUS_TONE, statusKey } from './model'

/**
 * B-TH-253 — a project in the portal (threads plan TH-5, PROJ.portal; walls W06, W08, W09, W38): members only (the page shows only
 * what the person's own list holds; a project that is not there, or a conversation that answers 404, reads "not found" in words that
 * never say "added", "member" or that another customer exists), never an office field (the lead, the goal, the outcome, office
 * notes) nor the office's project number (an office series), the status in the office's three words, the news said as status moves
 * only, and every design case read by Brand Beta with nothing of Brand Alpha.
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const PROJECT_SERIES = /\bPRJ-\d{2}-\d{3}\b/
const OFFICE_FIELDS = /\b(lead|goal|outcome|office note|internal note)\b|nota d.ufficio/i

describe('members only, in neutral words', () => {
  it('a project opens only when it is in the person’s own list; anything else is "not found" (never an error that says more)', () => {
    expect(pageStateOf({ projects: null, projectId: PROJECT_ID, threadMissing: false })).toBe('loading')
    expect(pageStateOf({ projects: BETA_PROJECTS, projectId: PROJECT_ID, threadMissing: false })).toBe('ready')
    // Not a member (or another company's project): the list does not hold it.
    expect(pageStateOf({ projects: BETA_PROJECTS, projectId: 'a1a1a1a1-0000-4000-8000-000000000999', threadMissing: false })).toBe('missing')
    expect(pageStateOf({ projects: [], projectId: PROJECT_ID, threadMissing: false })).toBe('missing')
    // The conversation said 404 (taken out meanwhile): not found too.
    expect(pageStateOf({ projects: BETA_PROJECTS, projectId: PROJECT_ID, threadMissing: true })).toBe('missing')
    // A failed read is a failed read, never "not found".
    expect(pageStateOf({ projects: 'error', projectId: PROJECT_ID, threadMissing: false })).toBe('error')
    expect(projectOf(null, PROJECT_ID)).toBeNull()
  })

  it('the not-found words never say "added", "member" or another customer — it and en', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = `${t(locale)('missing.title')} ${t(locale)('missing.body')}`
      expect(words).not.toMatch(/added|member|aggiunt|membro|another customer|other customer|altro cliente|belongs to/i)
    }
    expect(t('en')('missing.body')).toBe('This project is not one of yours, or it no longer exists.')
  })

  it('reads only the portal’s own routes: the person’s list and the project’s news', async () => {
    const asked: string[] = []
    const api = { get: async (path: string) => (asked.push(path), path.endsWith('/news') ? { entries: [], nextCursor: null } : { projects: BETA_PROJECTS }) } as unknown as ApiClient
    expect((await fetchPortalProjects(api)).map((project) => project.id)).toEqual(BETA_PROJECTS.map((project) => project.id))
    await fetchProjectNews(api, PROJECT_ID)
    expect(asked).toEqual(['/portal/projects', `/portal/projects/${PROJECT_ID}/news`])
    const failing = { get: async () => Promise.reject(new ApiError('not_found', 404, 'not_found', 'Project not found.')) } as unknown as ApiClient
    await expect(fetchProjectNews(failing, PROJECT_ID)).rejects.toBeInstanceOf(ApiError)
  })

  it('RECORD_PAGES.Project opens this page for a customer, a supplier and a workshop; a guest has none', () => {
    expect(recordPageOf(['CUSTOMER'], 'Project', PROJECT_ID)).toBe(`/projects/${PROJECT_ID}`)
    expect(recordPageOf(['SUPPLIER'], 'Project', PROJECT_ID)).toBe(`/projects/${PROJECT_ID}`)
    expect(recordPageOf(['SUBCONTRACTOR'], 'Project', PROJECT_ID)).toBe(`/projects/${PROJECT_ID}`)
    expect(recordPageOf(['GUEST'], 'Project', PROJECT_ID)).toBeNull()
    expect(projectHref('/p/BRAND-BETA', PROJECT_ID, true)).toBe(`/p/BRAND-BETA/projects/${PROJECT_ID}#messages`)
  })
})

describe('the summary and the band', () => {
  it('the status in the office’s three words, one tone each', () => {
    for (const status of PROJECT_STATUSES) {
      expect(t('en')(statusKey(status))).toBe(STATUS_WORDS[status].en)
      expect(t('it')(statusKey(status))).toBe(STATUS_WORDS[status].it)
    }
    expect(STATUS_TONE).toEqual({ ACTIVE: 'info', ON_HOLD: 'warning', CLOSED: 'neutral' })
  })

  it('the band names the project by its name — never the office’s number — and asks about it only when it is theirs', () => {
    const project = BETA_PROJECTS[0]!
    const band = projectBandOf({ t: t('en'), project, state: 'ready', homeHref: '/p/BRAND-BETA', homeLabel: 'Home', projectId: project.id })
    expect(band.title).toBe(project.name)
    expect(JSON.stringify(band)).not.toMatch(PROJECT_SERIES)
    expect(band.ask).toEqual({ type: 'Project', id: project.id, label: project.name })
    const missing = projectBandOf({ t: t('en'), project: null, state: 'missing', homeHref: '/p/BRAND-BETA', homeLabel: 'Home', projectId: project.id })
    expect(missing.title).toBe('Project not found')
    expect(missing.ask).toBeNull()
    expect(missing.status).toBeNull()
  })

  it('Home and Samples list the open projects in the API’s order; a closed one only with its conversation', () => {
    expect(openProjects(BETA_PROJECTS).map((project) => project.status)).toEqual(['ACTIVE', 'ON_HOLD'])
  })
})

describe('news of the person’s own records: status moves only', () => {
  it('a move with words both ways; only where it got to; neither — "moved on", never a code', () => {
    const lines = newsOf().map((entry) => newsLineOf(entry, '/p/BRAND-BETA'))
    expect(lines[0]).toMatchObject({ from: 'move.IN_PROGRESS', to: 'move.SENT', typeKey: 'record.type.SampleRound', href: expect.stringMatching(/^\/p\/BRAND-BETA\/open\/SampleRound\//) })
    expect(newsMoveKey(lines[0]!)).toBe('news.moved')
    // Their reference first (their PO), and how many moves of that day the line stands for.
    expect(lines[1]).toMatchObject({ ref: 'BETA-PO-0077', more: 2 })
    // An office status without words is never drawn: only where it got to.
    expect(lines[2]).toMatchObject({ from: null, to: 'move.APPROVED' })
    expect(newsMoveKey(lines[2]!)).toBe('news.now')
    expect(lines[3]).toMatchObject({ from: null, to: null })
    expect(newsMoveKey(lines[3]!)).toBe('news.changed')
    for (const code of MOVE_WORDS) for (const locale of ['it', 'en'] as const) expect(t(locale)(`move.${code}`), `${code} ${locale}`).not.toBe(`move.${code}`)
  })

  it('a news line carries no actor, value or action — only the record, the move and the day', () => {
    const line = newsLineOf(newsOf()[0]!, '/p/X')
    expect(Object.keys(line).sort()).toEqual(['at', 'from', 'href', 'key', 'more', 'ref', 'to', 'typeKey'])
  })
})

const KEY = /\b(?:band|summary|news|move|missing|failed|status|thread|record|nav)\.[a-zA-Z_]+\b/

describe('SCR-702 design cases (read by Brand Beta; the supplier’s by a tannery)', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  const render = (locale: 'it' | 'en', id: string) =>
    renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: screen.cases.find((entry) => entry.id === id)!.model })))

  it('every case draws in Italian and English with no raw key, nothing of Brand Alpha, no office series and no office field', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of screen.cases) {
        const html = render(locale, entry.id)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html.match(KEY)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
        expect(scanText(html, BRAND_ALPHA), `${entry.id} (${locale})`).toEqual([])
        expect(html.match(PROJECT_SERIES)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
        expect(html.replace(/<[^>]+>/g, ' ').match(OFFICE_FIELDS)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
      }
    }
  })

  it('the project: its name, status, target date, the conversation and the news of the person’s own records', () => {
    const html = render('en', 'th-253-project')
    expect(html).toContain('Winter touring line')
    expect(html).toContain('Active')
    expect(html).toContain('Target date')
    expect(html).toContain('Messages about this project')
    expect(html).toContain('News of your records')
    expect(html).toContain('Sample round Fit round 2: in progress → sent')
    expect(html).toContain('moved on')
    expect(html).not.toContain('SOMETHING_ELSE')
    expect(html).not.toContain('DRAFT_INTERNAL')
  })

  it('a project that is not theirs reads like one that does not exist; the conversation is not drawn', () => {
    const html = render('en', 'th-253-missing')
    expect(html).toContain('This project is not one of yours, or it no longer exists.')
    expect(html).not.toContain('Messages about this project')
    expect(html).not.toMatch(/added|member|another customer/i)
  })

  it('the conversation draws two sides only — no office note — and a closed project keeps its messages to read', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = render(locale, 'th-253-closed')
      expect(html).not.toMatch(/Office note|Nota d.ufficio|Internal note|Office only/i)
    }
    expect(render('en', 'th-253-closed')).toContain('The project is closed: its messages stay here to read.')
  })

  it('a supplier’s project never names a customer', () => {
    const html = render('en', 'th-253-supplier')
    expect(html).toContain('New tanned leather for the touring line')
    expect(html).not.toMatch(/Brand Beta|Brand Alpha|Pelletteria Esempio/)
  })
})
