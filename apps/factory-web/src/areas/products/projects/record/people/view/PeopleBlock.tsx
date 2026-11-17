'use client'

import { useId, type ReactNode } from 'react'
import { BellOff, Link2, LogOut, UserMinus, UserPlus } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { NoticeLine, ProjectsMessages, useWords } from '../../../parts'
import { PEOPLE_NS, peopleTotal, type PeopleBlockActions, type PeopleBlockModel, type PeopleGroup, type PersonRow } from '../model'
import { AddPersonDialog } from './AddPersonDialog'
import { OutConfirm } from './OutConfirm'
import '../people.css'

/**
 * B-TH-250 — the project's People (design PROJ.members-F01 … F11; picture 34 was never drawn: built to the design kit): our team
 * (name, Lead, why they are in, muted, since), the outside company's people (their organisation on every row, so nobody writes to
 * them thinking it is internal), the people invited by link (until when, or Ended), each group with its exact count; Add a colleague,
 * Add <company> people, Take out, Leave — each held with why. No "seen by", no "last active", no message counts per person (art. 4).
 * A pure view: the container (../PeopleSection.tsx) reads and writes.
 */
export function PeopleBlock({ model, actions }: { model: PeopleBlockModel; actions?: PeopleBlockActions }) {
  return (
    <ProjectsMessages also={[PEOPLE_NS]}>
      <Block model={model} actions={actions} />
    </ProjectsMessages>
  )
}

function Block({ model, actions }: { model: PeopleBlockModel; actions?: PeopleBlockActions }) {
  const { t, say } = useWords(PEOPLE_NS)
  const company = model.company ?? ''
  return (
    <Card className="fw-prjp" header={t('people.title', { count: peopleTotal(model) })} headingLevel={2}>
      <div className="fw-prjp-body">
        <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} ns={PEOPLE_NS} />

        <Group
          title={t('people.team', { count: model.team.count })}
          group={model.team}
          org={t('people.org.team')}
          foot={
            <>
              {model.onlyMe && <p className="fw-prjp-hint">{t('people.onlyYou')}</p>}
              <Button size="sm" variant="secondary" heldReason={say(model.addTeam.held)} onClick={() => actions?.onAdd?.('team')}>
                <UserPlus size={14} aria-hidden /> {t('add.team')}
              </Button>
            </>
          }
          actions={actions}
        />

        {model.outside && (
          <Group
            title={t('people.outside', { company, count: model.outside.count })}
            group={model.outside}
            org={company}
            empty={t('people.outsideNone', { company })}
            foot={
              <>
                {model.manages && (
                  <p className="fw-prjp-hint">
                    <Link2 size={13} aria-hidden /> {t('people.outsideInvite', { company })}
                  </p>
                )}
                {model.addOutside.offered && (
                  <Button size="sm" variant="secondary" heldReason={say(model.addOutside.held)} onClick={() => actions?.onAdd?.('outside')}>
                    <UserPlus size={14} aria-hidden /> {t('add.outside', { company })}
                  </Button>
                )}
              </>
            }
            actions={actions}
          />
        )}

        {model.invited.count > 0 && <Group title={t('people.invited', { count: model.invited.count })} group={model.invited} org={t('people.org.invited')} actions={actions} />}
      </div>

      {model.dialog && <AddPersonDialog model={model.dialog} project={model.project} company={model.company} actions={actions?.dialog} />}
      {model.confirm && <OutConfirm model={model.confirm} project={model.project} company={model.company} actions={actions?.confirm} />}
    </Card>
  )
}

function Group({ title, group, org, empty, foot, actions }: { title: string; group: PeopleGroup; org: string; empty?: string; foot?: ReactNode; actions?: PeopleBlockActions }) {
  const { t } = useWords(PEOPLE_NS)
  const headingId = useId()
  return (
    <section className="fw-prjp-group" aria-labelledby={headingId}>
      <h3 id={headingId} className="fw-prjp-group-title">
        {title}
      </h3>
      {group.rows.length === 0 && empty ? (
        <p className="fw-prjp-hint">{empty}</p>
      ) : (
        <ul className="fw-prjp-list" aria-labelledby={headingId}>
          {group.rows.map((row) => (
            <Person key={row.key} row={row} org={org} actions={actions} />
          ))}
        </ul>
      )}
      {group.hidden > 0 && <p className="fw-prjp-hint">{t('people.more', { shown: group.rows.length, count: group.count })}</p>}
      {foot && <div className="fw-prjp-foot">{foot}</div>}
    </section>
  )
}

function Person({ row, org, actions }: { row: PersonRow; org: string; actions?: PeopleBlockActions }) {
  const { t, say, day } = useWords(PEOPLE_NS)
  const name = row.me ? t('people.you', { name: row.name }) : row.name
  const meta = row.org === 'invited' ? (row.ended ? t('people.ended') : row.until ? t('people.until', { date: day(row.until) }) : null) : [say(row.why), row.since ? t('people.since', { date: day(row.since) }) : null].filter(Boolean).join(' · ')
  return (
    <li className="fw-prjp-person">
      <span className="fw-prjp-who">
        <span className="fw-prjp-name-line">
          <span className="fw-prjp-name">{name}</span>
          {row.lead && <Tag tone="info">{t('people.lead')}</Tag>}
          <Tag tone={row.org === 'team' ? 'neutral' : 'warning'} truncate title={org}>
            {org}
          </Tag>
          {row.muted && (
            <Tag tone="neutral">
              <BellOff size={12} aria-hidden /> {t('people.muted')}
            </Tag>
          )}
        </span>
        {meta && <span className="fw-prjp-meta">{meta}</span>}
      </span>
      {row.out && (
        <Button
          size="sm"
          variant="quiet"
          aria-label={row.out.kind === 'leave' ? t('out.leaveLabel') : t('out.removeLabel', { name: row.name })}
          heldReason={say(row.out.held)}
          onClick={() => actions?.onOut?.(row)}
        >
          {row.out.kind === 'leave' ? <LogOut size={14} aria-hidden /> : <UserMinus size={14} aria-hidden />}
          <span className="fw-prjp-out-words">{row.out.kind === 'leave' ? t('out.leave') : t('out.remove')}</span>
        </Button>
      )}
    </li>
  )
}
