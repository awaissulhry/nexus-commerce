'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { PortalThread } from '../../shell/thread/PortalThread'
import { useOffline } from '../orders/hooks'
import { NotInAccess } from '../orders/view/parts'
import { fetchPortalProjects, fetchProjectNews, type NewsEntry, type PortalProject } from './api'
import { newsLineOf, NS, pageStateOf, projectBandOf, projectOf, PROJECTS_PERMISSION } from './model'
import { ProjectPageView, type ProjectNewsModel } from './view/ProjectPageView'
import { useProjectWords } from './words'

/**
 * `/p/<party>/projects/<id>` — a project the person was ADDED to (threads plan TH-5, B-TH-253; RECORD_PAGES.Project opens it from
 * the API's links, Home's Messages card and Samples & tech packs): the same page for a customer, a supplier and a workshop. It reads
 * the person's own projects (GET /portal/projects: members only, in the party's own scope) for the summary — a project that is not
 * there reads "not found", the same words as one that does not exist (W06, W08, W09) —, the conversation through the portal's
 * PortalThread (GET /portal/threads/Project/:id: shared messages only; a 404 is "not found" too), and the news of the person's own
 * linked records (GET /portal/projects/:id/news). It reads again on the live channel's project and notification events (ours only:
 * the channel names the party) and when the connection comes back.
 */
export function ProjectRecordPage({ id }: { id: string }) {
  return (
    <WithMessages namespaces={[NS, 'portal-orders', 'ds-words']}>
      <ProjectContainer id={id} />
    </WithMessages>
  )
}

function ProjectContainer({ id }: { id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const { t, portal, time } = useProjectWords()
  const offline = useOffline()
  const allowed = frame.me.permissions.includes(PROJECTS_PERMISSION) && frame.kinds.some((kind) => kind === 'CUSTOMER' || kind === 'SUPPLIER' || kind === 'SUBCONTRACTOR')
  const [projects, setProjects] = useState<PortalProject[] | null | 'error'>(null)
  const [threadMissing, setThreadMissing] = useState(false)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [news, setNews] = useState<{ state: ProjectNewsModel['state']; entries: NewsEntry[]; cursor: string | null; busy: boolean }>({ state: 'loading', entries: [], cursor: null, busy: false })
  const newsRead = useRef(0)

  const loadProjects = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const list = await fetchPortalProjects(api, signal)
        setProjects(list)
        setLoadedAt(new Date().toISOString())
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        // A failed read keeps what was read (never drawn as "not found": that would say something it does not know).
        setProjects((current) => (Array.isArray(current) ? current : 'error'))
      }
    },
    [api],
  )

  const loadNews = useCallback(
    async (signal?: AbortSignal) => {
      const read = ++newsRead.current
      try {
        const page = await fetchProjectNews(api, id, null, signal)
        if (read === newsRead.current) setNews({ state: 'ready', entries: page.entries, cursor: page.nextCursor, busy: false })
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        if (read === newsRead.current) setNews((current) => ({ ...current, state: current.entries.length > 0 ? 'ready' : 'error', busy: false }))
      }
    },
    [api, id],
  )

  const loadOlder = useCallback(async () => {
    const cursor = news.cursor
    if (!cursor || news.busy) return
    setNews((current) => ({ ...current, busy: true }))
    try {
      const page = await fetchProjectNews(api, id, cursor)
      setNews((current) => ({ state: 'ready', entries: [...current.entries, ...page.entries], cursor: page.nextCursor, busy: false }))
    } catch {
      setNews((current) => ({ ...current, busy: false }))
    }
  }, [api, id, news.cursor, news.busy])

  useEffect(() => {
    if (!allowed) return
    const abort = new AbortController()
    void loadProjects(abort.signal)
    void loadNews(abort.signal)
    return () => abort.abort()
  }, [allowed, loadProjects, loadNews])

  // The office added or took out a person, changed the project, a linked record moved: read again in place.
  usePortalLive(
    {
      onChange: (change) => {
        if (change.type.startsWith('project.') || change.type === 'partner_notification.created') {
          void loadProjects()
          void loadNews()
        }
      },
      onReconnect: () => {
        void loadProjects()
        void loadNews()
      },
    },
    allowed,
  )

  const state = pageStateOf({ projects, projectId: id, threadMissing })
  const project = Array.isArray(projects) ? projectOf(projects, id) : null
  usePortalBand(allowed ? projectBandOf({ t, project, state, homeHref: frame.prefix, homeLabel: portal('nav.home'), projectId: id }) : { title: t('band.title') })

  const newsModel = useMemo<ProjectNewsModel>(
    () => ({ state: news.state, lines: news.entries.map((entry) => newsLineOf(entry, frame.prefix)), older: news.cursor ? { busy: news.busy } : null }),
    [news, frame.prefix],
  )

  if (!allowed) return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />

  return (
    <ProjectPageView
      model={{
        state,
        project,
        companyName: frame.me.company.name,
        news: newsModel,
        offlineSince: offline && loadedAt ? time(loadedAt) : null,
        homeHref: frame.prefix,
      }}
      actions={{
        onRetry: () => {
          setProjects(null)
          void loadProjects()
        },
        onRetryNews: () => {
          setNews((current) => ({ ...current, state: 'loading' }))
          void loadNews()
        },
        onOlderNews: () => void loadOlder(),
      }}
      thread={state === 'missing' ? null : <PortalThread type="Project" id={id} title={t('thread.title')} showRecord={false} onMissing={() => setThreadMissing(true)} />}
    />
  )
}
