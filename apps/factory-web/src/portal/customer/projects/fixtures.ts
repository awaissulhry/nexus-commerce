import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { threadHeldKey } from '../../shell/thread-model'
import { shellOf as supplierShellOf } from '../../supplier/orders/design-data'
import { betaShellOf, PREFIX } from '../requests/design-data'
import type { PortalProject } from './api'
import { BETA_PROJECTS, newsOf, PROJECT_ID, projectThreadOf, SUPPLIER_PROJECT } from './design-data'
import { newsLineOf, NS, projectBandOf, type PageState } from './model'
import { ProjectCase, type ProjectCaseBuilder } from './view/ProjectCase'
import type { ProjectNewsModel } from './view/ProjectPageView'

/**
 * SCR-702 › a project in the portal (threads plan TH-5, B-TH-253; design PROJ.portal; picture 37 never drawn: the design kit and
 * the portal frame's "comfortable" density), MADE-UP data only and read by Brand Beta (brand B) — a supplier's case by a tannery,
 * which never names a customer: a project with messages and news of its own records, a conversation with no message yet, on hold,
 * closed (the conversation kept to read), a colleague who may read but not write, a supplier's project, loading, a failed read,
 * news that could not be read, no connection, and a project that is not theirs (the neutral not-found page). The office's
 * project number is in the data and never drawn; nothing office-only (lead, goal, outcome, office notes) ever comes.
 */

const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
const SUPPLIER_PREFIX = '/p/CONCERIA-PROVA'

interface CaseOptions {
  readonly project?: PortalProject | null
  readonly state?: PageState
  readonly news?: ProjectNewsModel['state'] | 'none'
  readonly messages?: 'some' | 'none'
  /** The conversation's held reason (the API's composer reason: CLOSED, NO_COMMENT). */
  readonly held?: 'CLOSED' | 'NO_COMMENT' | null
  readonly offline?: boolean
  readonly supplier?: boolean
}

function projectCase(options: CaseOptions = {}): ProjectCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const portal = words(locale, 'portal')
    const supplier = options.supplier ?? false
    const prefix = supplier ? SUPPLIER_PREFIX : PREFIX
    const project = options.project === undefined ? (supplier ? SUPPLIER_PROJECT : BETA_PROJECTS[0]!) : options.project
    const state: PageState = options.state ?? (project ? 'ready' : 'loading')
    const projectId = project?.id ?? PROJECT_ID
    const band = projectBandOf({ t, project, state, homeHref: prefix, homeLabel: portal('nav.home'), projectId })
    const companyName = supplier ? 'Officina Demo' : 'Pelletteria Esempio'
    const news: ProjectNewsModel =
      options.news === 'none'
        ? { state: 'ready', lines: [], older: null }
        : options.news === 'loading' || options.news === 'error'
          ? { state: options.news, lines: [], older: null }
          : { state: 'ready', lines: supplier ? [] : newsOf().map((entry) => newsLineOf(entry, prefix)), older: supplier ? null : { busy: false } }
    const held = options.held ?? null
    const thread =
      state === 'ready' && project
        ? projectThreadOf(locale, {
            messages: options.messages ?? 'some',
            held: held ? portal(threadHeldKey(held)) : null,
            accessLine: held === 'NO_COMMENT' ? portal('thread.whoCan', { names: 'Berta Becker' }) : null,
            companyName,
            ...(supplier ? { partner: { name: 'Luca Prova' } } : {}),
          })
        : null
    const shell = supplier ? supplierShellOf(locale, { band, path: `/projects/${projectId}` }) : betaShellOf(locale, band, `/projects/${projectId}`)
    return {
      shell,
      page: {
        state,
        project: state === 'ready' || state === 'error' ? project : null,
        companyName,
        news,
        offlineSince: options.offline ? new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date('2026-11-17T09:40:00Z')) : null,
        homeHref: prefix,
      },
      thread,
    }
  }
}

export const designScreen = defineDesignScreen<ProjectCaseBuilder>({
  screen: 'SCR-702',
  title: 'Portal — a project (B-TH-253)',
  view: ProjectCase,
  cases: [
    {
      id: 'th-253-project',
      label: 'A project with messages and news of the customer’s own records',
      model: projectCase(),
      note: 'The name (never PRJ-…), Active, the target date, with whom it is shared; the conversation as the main column (two sides, never an office note); beside it from 1280 px the news of Brand Beta’s own records only — a code without words says “moved on”, never the code.',
    },
    { id: 'th-253-empty', label: 'No message yet, nothing moved', model: projectCase({ messages: 'none', news: 'none' }), note: 'The conversation’s own empty words and the box ready; “Nothing moved on your records yet.”' },
    { id: 'th-253-on-hold', label: 'On hold', model: projectCase({ project: BETA_PROJECTS[1]! }), note: 'On hold in amber with its words; writing still works.' },
    { id: 'th-253-closed', label: 'Closed: the conversation kept to read', model: projectCase({ project: BETA_PROJECTS[2]!, held: 'CLOSED' }), note: 'The thread’s own words for a closed conversation in place of the box; no outcome (office-only) is shown.' },
    { id: 'th-253-read-only', label: 'A colleague who may read but not write', model: projectCase({ held: 'NO_COMMENT' }), note: 'The reason in place of the box and who in their company can give the right.' },
    { id: 'th-253-supplier', label: 'A supplier’s project (the same page in the supplier portal)', model: projectCase({ supplier: true, news: 'none' }), note: 'A tannery reads its own project: our name, never a customer’s.' },
    { id: 'th-253-news-failed', label: 'The news could not be read', model: projectCase({ news: 'error' }), note: 'The page stays; the news card says so with Try again.' },
    { id: 'th-253-offline', label: 'No connection', model: projectCase({ offline: true }), note: 'What was read and when; the thread’s Send says why it waits.' },
    { id: 'th-253-loading', label: 'Loading', model: projectCase({ project: null, state: 'loading', news: 'loading' }) },
    { id: 'th-253-error', label: 'Could not be read', model: projectCase({ project: null, state: 'error' }), note: 'The problem in words + Try again (never drawn as “not found”).' },
    { id: 'th-253-missing', label: 'Not theirs (or no longer there): the neutral page', model: projectCase({ project: null, state: 'missing' }), note: 'The same words as a project that does not exist: never “you were not added”, never another customer (W06, W08, W09).' },
  ],
})
