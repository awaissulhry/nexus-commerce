'use client'

import type { ReactElement } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowRightLeft, Pencil } from 'lucide-react'
import { Banner, KeyValue, Tabs } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { Section } from '../../../../lib/record-sections/Kit'
import type { EmployeeFacts, PersonRow, UnitRow } from '../api'
import { PERSON_TABS, STRUCTURE_NS, structureHref, type PersonTab, type Words } from '../model'
import { HistoryList, type UnitProfileModel } from './UnitProfileView'
import '../structure.css'

/**
 * owb-ss8 (8.2; design § 5zb "the profile of a person, two tabs": Overview · History) — where the person works and whom the person
 * answers to (the home unit and the line up to the top), the role, and the facts (phone only for someone with the personal right,
 * reads and speaks, with us since). No figure about the work of one person: no speed, no count, no rank. Fetches nothing.
 */

export interface PersonProfileModel {
  readonly path: string
  readonly tab: PersonTab
  readonly state: 'reading' | 'failed' | 'ready'
  readonly problem: string | null
  readonly row: PersonRow | null
  /** The home unit and the units above it, nearest first. */
  readonly line: readonly UnitRow[]
  readonly boss: { readonly employeeId: string; readonly name: string } | null
  readonly facts: EmployeeFacts | null
  /** The facts' read failed (a key of `factory-structure`). */
  readonly factsProblem: string | null
  /** The phone is shown (and its field offered) only with the personal right. */
  readonly phone: boolean
  readonly history: UnitProfileModel['history']
  /** Edit the person (today's people.employees.manage). */
  readonly edit: boolean
  /** Move the person (today's people.teams.manage). */
  readonly move: boolean
  readonly notice: Words | null
}

export interface PersonProfileActions {
  readonly onRetry: () => void
  readonly onEdit: () => void
  readonly onMove: () => void
  readonly onDismissNotice: () => void
}

export function PersonProfileView({ model, actions }: { model: PersonProfileModel; actions?: PersonProfileActions }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const locale = useLocale()
  const row = model.row
  const home = model.line[0] ?? null
  const back = home ? structureHref(model.path, { unit: home.id, tab: 'people' }) : model.path
  const tabs = PERSON_TABS.map((id) => ({ id, label: t(`tab.${id}`), href: structureHref(model.path, { person: row?.employeeId ?? null, tab: id }) }))
  const facts = model.facts
  const items = facts
    ? [
        ...(model.phone && facts.phone ? [{ label: t('facts.phone'), value: facts.phone }] : []),
        { label: t('facts.speaks'), value: t(`speaks.${facts.locale}`) === `speaks.${facts.locale}` ? facts.locale.toUpperCase() : t(`speaks.${facts.locale}`) },
        { label: t('facts.since'), value: formatDate(facts.startDate, { locale }) },
      ]
    : []
  return (
    <div className="fw-fs">
      <div className="fw-fs-band">
        <Link className="fw-fs-back" href={back}>
          <ArrowLeft size={14} aria-hidden />
          {home ? home.name : t('profile.backToStructure')}
        </Link>
        {row ? (
          <div className="fw-fs-band-row">
            <PeoplePicture source={sourceOfPicture(row.name, row.picture, 'person')} size="lg" nameBeside />
            <span className="fw-fs-band-t">
              <h2 className="fw-fs-band-name">{row.name}</h2>
              <span className="fw-fs-card-sub">
                {row.role ?? t('person.noRole')}
                {home ? null : (
                  <>
                    {' '}
                    <Tag tone="warning">{t('person.loose')}</Tag>
                  </>
                )}
              </span>
            </span>
            <span className="fw-fs-acts">
              {model.edit && facts ? (
                <Button size="sm" onClick={() => actions?.onEdit()}>
                  <Pencil size={14} aria-hidden />
                  {t('profile.edit')}
                </Button>
              ) : null}
              {model.move ? (
                <Button size="sm" onClick={() => actions?.onMove()}>
                  <ArrowRightLeft size={14} aria-hidden />
                  {t(home ? 'profile.move' : 'person.putIn')}
                </Button>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>

      {model.notice ? (
        <Banner
          tone={model.notice.key.startsWith('error.') ? 'danger' : 'success'}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice()}>
              {t('notice.dismiss')}
            </Button>
          }
        />
      ) : null}

      <Tabs ariaLabel={t('profile.tabs')} tabs={tabs} active={model.tab} />

      {model.state === 'reading' ? (
        <Skeleton height={96} />
      ) : model.state === 'failed' || !row ? (
        <Banner
          tone="danger"
          title={t('profile.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem ?? 'error.read')}
        </Banner>
      ) : model.tab === 'history' ? (
        <HistoryList history={model.history} />
      ) : (
        <div className="fw-fs-grid">
          <Section
            id="where"
            title={t('person.where')}
            answer={home ? t(row.isLeader ? 'person.inUnitLeads' : 'person.inUnit', { role: row.role ?? t('person.noRole'), unit: home.name }) + ' ' + (model.boss ? t('person.answersTo', { name: model.boss.name }) : t('person.answersToNobody')) : t('person.loose')}
          >
            {model.line.length ? (
              <ul className="fw-fs-chain">
                {model.line.map((unit) => (
                  <li key={unit.id}>
                    <Link className="fw-fs-chain-l" href={structureHref(model.path, { unit: unit.id })}>
                      <PeoplePicture source={sourceOfPicture(unit.name, unit.picture, 'team')} size="sm" nameBeside />
                      <span className="fw-fs-card-t">
                        <span className="fw-fs-card-name">{unit.name}</span>
                        <span className="fw-fs-card-sub">{unit.leader ? unit.leader.name : t('unit.noLeader')}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
          <Section id="facts" title={t('person.facts')}>
            {facts ? <KeyValue dense labelCase="sentence" items={items} /> : model.factsProblem ? <p className="fw-fs-quiet">{t(model.factsProblem)}</p> : <Skeleton height={48} />}
          </Section>
        </div>
      )}
      <p className="fw-fs-quiet">{t('person.privacy')}</p>
    </div>
  )
}
