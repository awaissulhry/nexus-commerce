'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card, KeyValue } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Team } from '../../../_shared/api'
import { useWords } from '../../../_shared/parts'
import { ReviewWindow } from '../../../../_shared/review-window/ReviewWindow'
import { teamTitle, teamWalk } from '../model'

/**
 * B-TH-271 (threads plan PL6, picture 40; O-PPL-TEAM.list-F02, .thread-F01) — a team's window in Employees › Teams (a DetailModal at
 * `?view=teams&open=<team>`): its line and site, its lead, its members (who is lent out today and until when) and who is lent in
 * today, and — with threads.read and people.view — the team's office notes docked in the window's right column (~40 % of the
 * 1160 px window): notes only (a team has no party), nothing reaches the floor unless ticked, no read record; an empty thread folds
 * to a slim "Add a note" column. J / K walk the teams the view shows; Esc closes and Back returns to the same place. Changes (Set
 * lead, Archive, Move people) stay on the team's card and the members' list. No figure about a person (art. 4).
 */
export function TeamWindow({
  team,
  teams,
  prefix,
  timeZone,
  thread,
  threadEmpty,
  onGo,
  onClose,
}: {
  team: Team
  /** The teams the view shows, in its order (J / K). */
  teams: readonly Team[]
  prefix: string
  timeZone: string
  /** The team's docked notes (the page's OfficeRecordThread, or a design case's); none without threads.read and people.view. */
  thread?: ReactNode
  /** The notes hold nothing yet: they fold to "Add a note". */
  threadEmpty?: boolean
  onGo?: (teamId: string) => void
  onClose?: () => void
}) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const walk = teamWalk(teams, team.id)
  const away = team.members.filter((member) => member.onLoan)

  return (
    <DetailModal
      open
      onClose={() => onClose?.()}
      title={teamTitle(team)}
      subtitle={[team.site.code, team.line ? `${team.line.code} · ${team.line.name}` : t('line.none')].join(' · ')}
      meta={<Tag tone="neutral">{t('teams.members', { count: team.members.length })}</Tag>}
      nav={walk ? { ids: walk, current: team.id, onGo: (id) => onGo?.(id), noun: t('teams.window.noun') } : undefined}
    >
      <ReviewWindow thread={thread ?? null} threadLabel={t('teams.window.threadLabel', { team: teamTitle(team) })} notesOnly empty={threadEmpty ?? false} recordKey={team.id}>
        <div className="fw-pp-stack">
          <Card padded>
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('teams.lead'), value: team.lead?.name ?? t('teams.noLead') },
                { label: t('teams.window.line'), value: team.line ? `${team.line.code} · ${team.line.name}` : t('line.none') },
                { label: t('teams.window.site'), value: team.site.code },
              ]}
            />
          </Card>
          <Card padded header={t('teams.window.members')} headingLevel={3}>
            {team.members.length === 0 ? (
              <p className="fw-pp-hint">{t('teams.noMembersBody')}</p>
            ) : (
              <ul className="fw-pp-plain">
                {team.members.map((member) => (
                  <li key={member.employeeId} className="fw-pp-text">
                    <Link href={`${prefix}/people/employees/${encodeURIComponent(member.employeeId)}`}>{member.name}</Link>
                    {member.isLead && (
                      <>
                        {' '}
                        <Tag tone="info">{t('teams.lead')}</Tag>
                      </>
                    )}
                    {member.onLoan && (
                      <>
                        {' '}
                        <Tag tone="warning">{t('teams.onLoanTo', { line: member.onLoan.toLine.code, time: formatTime(member.onLoan.until, place) })}</Tag>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {away.length > 0 && <p className="fw-pp-hint fw-pp-warning">{t('teams.awaySummary', { count: away.length, line: away[0]!.onLoan!.toLine.code, time: formatTime(away[0]!.onLoan!.until, place) })}</p>}
          </Card>
          {team.loansIn.length > 0 && (
            <Card padded header={t('teams.window.loansIn')} headingLevel={3}>
              <ul className="fw-pp-plain">
                {team.loansIn.map((loan) => (
                  <li key={loan.loanId} className="fw-pp-hint">
                    {t('teams.loanIn', { name: loan.name, line: loan.fromLine?.code ?? t('line.none'), time: formatTime(loan.until, place) })}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </ReviewWindow>
    </DetailModal>
  )
}
