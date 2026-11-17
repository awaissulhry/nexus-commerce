'use client'

import { BellOff, FolderKanban, MessageSquare } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { StatusPill, useWords } from '../../../../products/projects/parts'
import { orderRows, PANEL_ROWS, panelShown, type MyProjectsModel } from '../model'
import '../../today.css'
import '../projects.css'

export interface MyProjectsActions {
  onRetry?: () => void
}

/**
 * Today › My projects (B-TH-252; design PROJ.home-F03, F04; picture 36 never drawn: Today's section pattern): the open projects I
 * am in — number and name (the project), the outside company or "Office only", the status when not Active, the target date with
 * its words, MY new messages ("3 new" opens the thread at what is new), muted, "You lead it", and for a project I lead that is past
 * its target date and quiet: "close or update it". Hidden when I am in none. It draws ONE model.
 */
export function MyProjectsView({ model, actions }: { model: MyProjectsModel; actions?: MyProjectsActions }) {
  return (
    <WithMessages namespaces={['home', 'products-projects']}>
      <MyProjects model={model} actions={actions} />
    </WithMessages>
  )
}

function MyProjects({ model, actions }: { model: MyProjectsModel; actions?: MyProjectsActions }) {
  const t = useT('home')
  const { say, day } = useWords()
  if (!panelShown(model)) return null
  const items = model.rows.status === 'ready' ? orderRows(model.rows.data.items) : []
  const shown = items.slice(0, PANEL_ROWS)
  return (
    <section className="fw-today-section" aria-labelledby="fw-today-my-projects">
      <div className="fw-today-head">
        <h2 id="fw-today-my-projects" className="fw-today-h">
          {t('myProjects.title')}
        </h2>
        <a className="fw-today-myprj-all" href={model.allHref}>
          {items.length > PANEL_ROWS ? t('myProjects.allCount', { count: items.length }) : t('myProjects.all')}
        </a>
      </div>
      {model.rows.status === 'error' ? (
        <Banner tone="danger" title={t('myProjects.error')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('myProjects.retry')}</Button>}>
          {t(`myProjects.problem.${model.rows.problem}`)}
        </Banner>
      ) : model.rows.status === 'loading' ? (
        <div aria-busy="true">
          <Skeleton height={20} />
        </div>
      ) : (
        <ul className="fw-today-myprj" aria-label={t('myProjects.title')}>
          {shown.map((row) => (
            <li key={row.id} className="fw-today-myprj-row">
              <FolderKanban size={16} className="fw-today-myprj-icon" aria-hidden />
              <span className="fw-today-myprj-text">
                <a className="fw-today-myprj-link" href={row.href}>
                  <span className="fw-today-myprj-number">{row.number}</span> {row.name}
                </a>
                <span className="fw-today-muted">
                  {row.party ?? t('myProjects.officeOnly')}
                  {row.lead ? ` · ${t('myProjects.youLead')}` : ''}
                </span>
              </span>
              <span className="fw-today-myprj-facts">
                {row.status !== 'ACTIVE' && <StatusPill status={row.status} />}
                <span className="fw-today-myprj-date">
                  <span className="fw-today-muted">{t('myProjects.target', { date: day(row.targetDate) })}</span>
                  {row.target.phrase && <Tag tone={row.target.tone}>{say(row.target.phrase)}</Tag>}
                </span>
                {row.stale && (
                  <a className="fw-today-myprj-stale" href={row.href} title={t('myProjects.staleHint')}>
                    <Tag tone="warning">{t('myProjects.stale')}</Tag>
                  </a>
                )}
                {row.muted ? (
                  <span className="fw-today-muted fw-today-myprj-muted" role="img" aria-label={t('myProjects.muted')} title={t('myProjects.muted')}>
                    <BellOff size={14} aria-hidden />
                  </span>
                ) : row.newForMe > 0 ? (
                  <a className="fw-today-myprj-new" href={row.threadHref} aria-label={t('myProjects.newLabel', { count: row.newForMe, name: row.name })}>
                    <MessageSquare size={14} aria-hidden /> {t('myProjects.new', { count: row.newForMe })}
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
