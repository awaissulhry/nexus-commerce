'use client'

import type { ReactNode } from 'react'
import { AlertCircle, ArrowLeft, CalendarClock, FolderKanban, FolderSearch, History, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import type { PortalProject } from '../api'
import { newsMoveKey, STATUS_TONE, statusKey, type NewsLine, type PageState } from '../model'
import { useProjectWords } from '../words'
import '../projects.css'

/**
 * SCR-702 — a project in the portal (threads plan TH-5, B-TH-253; design PROJ.portal-F02, F05, F07…F09, PROJ.linked-F09; picture
 * 37 never drawn: built to the design kit and the portal frame, as the generic record page grown, PL5): one summary line — the
 * project's name (never the office's number), its status in one word, its target date, with whom it is shared — then the
 * conversation as the main column (the portal's PartnerThread: two sides, never an office note; writing needs portal.comment and
 * the thread says so) and beside it, from 1280 px, "News of your records" (only the records the person opens in its own portal:
 * their reference, the move in words, the day). A project that is not theirs, or no longer exists, reads like one that does not
 * exist. Office-only facts (the lead, the goal, the outcome, office notes, who did what) never come and are never drawn. Fills
 * the main area (no page max-width). Draws one view model and fetches nothing: the conversation comes in as `thread`.
 */

export interface ProjectNewsModel {
  state: 'loading' | 'error' | 'ready'
  lines: readonly NewsLine[]
  /** Older news to read (its button busy while it reads), or null. */
  older: { busy: boolean } | null
}

export interface ProjectPageModel {
  state: PageState
  project: PortalProject | null
  /** The factory's name ("Pelletteria Esempio"): with whom the conversation is shared. */
  companyName: string
  news: ProjectNewsModel
  /** No connection: what was loaded, and when (written). */
  offlineSince: string | null
  homeHref: string
}

export interface ProjectPageActions {
  onRetry?: () => void
  onRetryNews?: () => void
  onOlderNews?: () => void
}

export function ProjectPageView({ model, actions, thread }: { model: ProjectPageModel; actions?: ProjectPageActions; thread: ReactNode }) {
  const { t, day, at } = useProjectWords()

  if (model.state === 'missing') {
    return (
      <div className="fw-pprj">
        <EmptyState
          icon={<FolderSearch size={24} aria-hidden />}
          title={t('missing.title')}
          description={t('missing.body')}
          action={
            <Button asChild>
              <a href={model.homeHref}>
                <ArrowLeft size={14} aria-hidden /> {t('missing.home')}
              </a>
            </Button>
          }
        />
      </div>
    )
  }

  if (model.state === 'error' && !model.project) {
    return (
      <div className="fw-pprj">
        <EmptyState icon={<AlertCircle size={24} aria-hidden />} title={t('failed.title')} description={t('failed.body')} action={<Button onClick={() => actions?.onRetry?.()}>{t('failed.retry')}</Button>} />
      </div>
    )
  }

  if (!model.project) {
    return (
      <div className="fw-pprj" role="status" aria-busy="true" aria-label={t('loading')}>
        <Skeleton height={96} />
        <div className="fw-pprj-layout">
          <div className="fw-pprj-main">
            <Skeleton height={160} />
            <Skeleton height={120} />
          </div>
          <div className="fw-pprj-side">
            <Skeleton height={200} />
          </div>
        </div>
      </div>
    )
  }

  const project = model.project
  const closed = project.status === 'CLOSED'
  return (
    <div className="fw-pprj">
      {model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline', { time: model.offlineSince })} /> : null}
      <Card padded className={project.status === 'ON_HOLD' ? 'fw-pprj-summary is-held' : closed ? 'fw-pprj-summary is-closed' : 'fw-pprj-summary'}>
        <p className="fw-pprj-kind">
          <FolderKanban size={16} aria-hidden /> {t('summary.kind')}
        </p>
        <h2 className="fw-pprj-name">{project.name}</h2>
        <div className="fw-pprj-facts">
          <Pill tone={STATUS_TONE[project.status]}>{t(statusKey(project.status))}</Pill>
          <span className="fw-pprj-fact">
            <CalendarClock size={14} aria-hidden /> {t('summary.target', { date: day(project.targetDate) })}
          </span>
        </div>
        <p className="fw-pprj-hint">{closed ? t('summary.closed') : project.status === 'ON_HOLD' ? t('summary.onHold', { company: model.companyName }) : t('summary.shared', { company: model.companyName })}</p>
      </Card>
      <div className="fw-pprj-layout">
        <section id="messages" className="fw-pprj-main" aria-label={t('thread.title')}>
          {thread}
        </section>
        <aside className="fw-pprj-side">
          <News model={model.news} actions={actions} at={at} />
        </aside>
      </div>
    </div>
  )
}

/** "News of your records": the records linked to the project that the person opens in its own portal, one line per record per day. */
function News({ model, actions, at }: { model: ProjectNewsModel; actions?: ProjectPageActions; at: (iso: string) => string }) {
  const { t, portal } = useProjectWords()
  const record = (line: NewsLine) => (line.ref ? t('news.record', { type: portal(line.typeKey), ref: line.ref }) : portal(line.typeKey))
  return (
    <Card padded className="fw-pprj-news">
      <h2 className="fw-pprj-h2">
        <History size={16} aria-hidden /> {t('news.title')}
      </h2>
      <p className="fw-pprj-sub">{t('news.hint')}</p>
      {model.state === 'loading' ? (
        <div className="fw-pprj-stack" role="status" aria-label={t('loading')}>
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      ) : model.state === 'error' ? (
        <div className="fw-pprj-line" role="alert">
          <AlertCircle size={14} aria-hidden /> <span>{t('news.failed')}</span>
          <Button size="sm" variant="quiet" onClick={() => actions?.onRetryNews?.()}>
            {t('failed.retry')}
          </Button>
        </div>
      ) : model.lines.length === 0 ? (
        <p className="fw-pprj-sub">{t('news.empty')}</p>
      ) : (
        <>
          <ul className="fw-pprj-rows" aria-label={t('news.title')}>
            {model.lines.map((line) => (
              <li key={line.key} className="fw-pprj-row">
                <a href={line.href} className="fw-pprj-rowlink">
                  {t(newsMoveKey(line), { record: record(line), from: line.from ? t(line.from) : '', to: line.to ? t(line.to) : '' })}
                </a>
                <span className="fw-pprj-sub">
                  <time dateTime={line.at}>{at(line.at)}</time>
                  {line.more > 0 ? ` · ${t('news.more', { count: line.more })}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {model.older ? (
            <Button size="sm" variant="quiet" heldReason={model.older.busy ? t('news.reading') : null} onClick={() => actions?.onOlderNews?.()}>
              {t('news.older')}
            </Button>
          ) : null}
        </>
      )}
    </Card>
  )
}
