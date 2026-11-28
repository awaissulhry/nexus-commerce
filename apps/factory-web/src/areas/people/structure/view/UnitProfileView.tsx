'use client'

import type { ReactElement } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowRightLeft, Layers, Lock, Pencil, Plus, UserCheck, UserPlus } from 'lucide-react'
import { ORDER_LIFE, type OrderLife } from '@nexus/factory-domain/sales/order-life'
import { Banner, KeyValue, Tabs } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { StateChip } from '../../../../lib/order-cells/view/StateChip'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { Quiet, Section } from '../../../../lib/record-sections/Kit'
import type { HistoryRow, UnitRecord, UnitRow } from '../api'
import { openOrdersOf, STRUCTURE_NS, structureHref, UNIT_TABS, type UnitNode, type UnitTab, type Words } from '../model'
import '../structure.css'

/**
 * owb-ss8 (8.2; design § 5zb "the profile of a unit, four tabs": Overview · People · Work · History) — a unit's (a team's) profile, in the
 * record section kit. Overview: who leads it and the line up to the top, at a glance (kind, under, people, works for, the stand-in, new
 * orders, baskets at most, about, your own facts), its people, the units under it. People: one row a person (role, leader; Make leader,
 * Move…). Work: its orders now and before. History: every change, who and when (the API's words through the base's ONE allow-list).
 * No figure about one person's work. The band's acts: Edit the profile… · Move… · Merge… · Close… (with the right). Fetches nothing.
 */

export interface UnitProfileModel {
  readonly path: string
  readonly prefix: string
  readonly tab: UnitTab
  readonly state: 'reading' | 'failed' | 'ready'
  readonly problem: string | null
  /** The unit in the tree (its people, the units under it); null while the structure is read. */
  readonly node: UnitNode | null
  readonly record: UnitRecord | null
  /** The units above, nearest first. */
  readonly chain: readonly UnitRow[]
  readonly history: { readonly rows: readonly HistoryRow[] | null; readonly problem: string | null }
  /** Change the structure (people.structure.manage). */
  readonly manage: boolean
  /** Move a person, make a leader (today's people.teams.manage). */
  readonly people: boolean
  /** Add a person (today's employee create + move). */
  readonly addPerson: boolean
  readonly notice: Words | null
}

export interface UnitProfileActions {
  readonly onRetry: () => void
  readonly onEdit: () => void
  readonly onMove: () => void
  readonly onMerge: () => void
  readonly onClose: () => void
  readonly onNewUnit: () => void
  readonly onAddPerson: () => void
  readonly onMakeLeader: (employeeId: string) => void
  readonly onMovePerson: (employeeId: string) => void
  readonly onDismissNotice: () => void
}

export function UnitProfileView({ model, actions }: { model: UnitProfileModel; actions?: UnitProfileActions }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const unit = model.record ?? model.node?.unit ?? null
  const up = model.chain[0] ?? null
  const back = up ? structureHref(model.path, { unit: up.id }) : model.path
  const record = model.record
  const tabs = UNIT_TABS.map((id) => ({
    id,
    label: t(`tab.${id}`),
    href: structureHref(model.path, { unit: unit?.id ?? null, tab: id }),
    count: id === 'people' ? (model.node?.total ?? null) : id === 'work' && record ? openOrdersOf(record) || null : null,
  }))
  return (
    <div className="fw-fs">
      <div className="fw-fs-band">
        <Link className="fw-fs-back" href={back}>
          <ArrowLeft size={14} aria-hidden />
          {up ? up.name : t('profile.backToStructure')}
        </Link>
        {unit ? (
          <div className="fw-fs-band-row">
            <PeoplePicture source={sourceOfPicture(unit.name, unit.picture, 'team')} size="lg" nameBeside />
            <span className="fw-fs-band-t">
              <h2 className="fw-fs-band-name">{unit.name}</h2>
              <span className="fw-fs-card-sub">
                {unit.takesOrders ? t('unit.team') : (unit.kindWord ?? t('unit.unit'))}
                {unit.takesOrders ? (
                  <>
                    {' '}
                    <Tag tone="info">{t('unit.takesOrders')}</Tag>
                  </>
                ) : null}
                {unit.closed ? (
                  <>
                    {' '}
                    <Tag tone="neutral">{t('unit.closed')}</Tag>
                  </>
                ) : null}
              </span>
            </span>
            {model.manage && !unit.closed && record ? (
              <span className="fw-fs-acts">
                <Button size="sm" onClick={() => actions?.onEdit()}>
                  <Pencil size={14} aria-hidden />
                  {t('profile.edit')}
                </Button>
                {unit.parentId !== null ? (
                  <>
                    <Button size="sm" onClick={() => actions?.onMove()}>
                      <ArrowRightLeft size={14} aria-hidden />
                      {t('profile.move')}
                    </Button>
                    <Button size="sm" onClick={() => actions?.onMerge()}>
                      <Layers size={14} aria-hidden />
                      {t('profile.merge')}
                    </Button>
                    <Button size="sm" onClick={() => actions?.onClose()}>
                      <Lock size={14} aria-hidden />
                      {t('profile.close')}
                    </Button>
                  </>
                ) : null}
              </span>
            ) : null}
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
      {unit?.closed ? <Banner tone="info">{t('profile.closedNote')}</Banner> : null}

      <Tabs ariaLabel={t('profile.tabs')} tabs={tabs} active={model.tab} />

      {model.state === 'reading' ? (
        <div className="fw-fs-skel" aria-busy="true">
          <Skeleton height={96} />
          <Skeleton height={96} />
        </div>
      ) : model.state === 'failed' || !record || !unit ? (
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
      ) : model.tab === 'overview' ? (
        <Overview model={model} record={record} actions={actions} />
      ) : model.tab === 'people' ? (
        <PeopleTab model={model} record={record} actions={actions} />
      ) : model.tab === 'work' ? (
        <WorkTab model={model} record={record} />
      ) : (
        <HistoryList history={model.history} />
      )}
      <p className="fw-fs-quiet">{t('privacy')}</p>
    </div>
  )
}

function Overview({ model, record, actions }: { model: UnitProfileModel; record: UnitRecord; actions?: UnitProfileActions }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const locale = useLocale()
  const node = model.node
  const own = record.members.length
  const items = [
    { label: t('glance.kind'), value: record.takesOrders ? t('unit.team') : (record.kindWord ?? '—') },
    { label: t('glance.under'), value: model.chain[0]?.name ?? t('glance.top') },
    { label: t('glance.people'), value: node && node.total !== own ? t('glance.peopleUnder', { count: node.total, own, under: node.total - own }) : String(own) },
    ...(node && node.children.length ? [{ label: t('glance.units'), value: String(node.children.length) }] : []),
    ...(record.takesOrders || record.worksFor.length ? [{ label: t('glance.worksFor'), value: record.worksFor.length ? record.worksFor.map((party) => party.name).join(' · ') : t('glance.allCustomers') }] : []),
    ...(record.standIn ? [{ label: t('glance.standIn'), value: record.standIn.until ? t('glance.standInUntil', { name: record.standIn.name, date: formatDate(record.standIn.until, { locale }) }) : record.standIn.name }] : []),
    ...(record.takesOrders ? [{ label: t('glance.newOrders'), value: record.takesNewOrders ? t('glance.takesNew') : t('glance.takesNoNew') }] : []),
    ...(record.takesOrders && record.maxBaskets !== null ? [{ label: t('glance.max'), value: t('glance.maxN', { count: record.maxBaskets }) }] : []),
    ...(record.about ? [{ label: t('glance.about'), value: record.about }] : []),
    ...record.ownFacts.map((fact) => ({ label: fact.label || '—', value: fact.value || '—' })),
  ]
  return (
    <div className="fw-fs-grid">
      <Section id="leads" title={t('overview.leads')} answer={record.leader ? t('overview.leadsName', { name: record.leader.name }) : t('overview.noLeader')} buttons={model.manage ? [<Button key="lead" size="sm" onClick={() => actions?.onEdit()}>{t(record.leader ? 'overview.changeLeader' : 'overview.chooseLeader')}</Button>] : []}>
        <ul className="fw-fs-chain">
          {[record, ...model.chain].map((unit, index) => (
            <li key={unit.id}>
              <Link className="fw-fs-chain-l" href={structureHref(model.path, { unit: unit.id })} aria-current={index === 0 ? 'true' : undefined}>
                <PeoplePicture source={sourceOfPicture(unit.name, unit.picture, 'team')} size="sm" nameBeside />
                <span className="fw-fs-card-t">
                  <span className="fw-fs-card-name">{unit.name}</span>
                  <span className="fw-fs-card-sub">{unit.leader ? unit.leader.name : t('unit.noLeader')}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
      <Section id="glance" title={t('overview.glance')}>
        <KeyValue dense labelCase="sentence" items={items} />
      </Section>
      <Section id="people" title={t('overview.people')} answer={own ? undefined : t('overview.nobody')} buttons={model.addPerson ? [<Button key="add" size="sm" onClick={() => actions?.onAddPerson()}><UserPlus size={14} aria-hidden />{t('head.addPerson')}</Button>] : []}>
        {own ? (
          <ul className="fw-fs-faces">
            {record.members.map((row) => (
              <li key={row.employeeId}>
                <Link className="fw-fs-person-l is-full" href={structureHref(model.path, { person: row.employeeId })}>
                  <PeoplePicture source={sourceOfPicture(row.name, row.picture, 'person')} size="sm" nameBeside />
                  <span className="fw-fs-person-n">{[row.name, row.role].filter(Boolean).join(' · ')}</span>
                  {row.isLeader ? <Tag tone="info">{t('unit.leader')}</Tag> : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Quiet>{t('overview.nobody')}</Quiet>
        )}
      </Section>
      {record.takesOrders ? null : (
        <Section id="under" title={t('overview.under')} answer={node?.children.length ? undefined : t('overview.noneUnder')} buttons={model.manage ? [<Button key="new" size="sm" onClick={() => actions?.onNewUnit()}><Plus size={14} aria-hidden />{t('head.newUnit')}</Button>] : []}>
          {node?.children.length ? (
            <ul className="fw-fs-chain">
              {node.children.map((kid) => (
                <li key={kid.unit.id}>
                  <Link className="fw-fs-chain-l" href={structureHref(model.path, { unit: kid.unit.id })}>
                    <PeoplePicture source={sourceOfPicture(kid.unit.name, kid.unit.picture, 'team')} size="sm" nameBeside />
                    <span className="fw-fs-card-t">
                      <span className="fw-fs-card-name">{kid.unit.name}</span>
                      <span className="fw-fs-card-sub">{[kid.unit.takesOrders ? t('unit.team') : kid.unit.kindWord, kid.unit.leader ? kid.unit.leader.name : t('unit.noLeader'), t('head.people', { count: kid.total })].filter(Boolean).join(' · ')}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Quiet>{t('overview.noneUnder')}</Quiet>
          )}
        </Section>
      )}
    </div>
  )
}

function PeopleTab({ model, record, actions }: { model: UnitProfileModel; record: UnitRecord; actions?: UnitProfileActions }): ReactElement {
  const t = useT(STRUCTURE_NS)
  return (
    <Section id="people-tab" title={t('overview.people')} answer={record.members.length ? t('head.people', { count: record.members.length }) : t('overview.nobody')} buttons={model.addPerson ? [<Button key="add" size="sm" onClick={() => actions?.onAddPerson()}><UserPlus size={14} aria-hidden />{t('head.addPerson')}</Button>] : []}>
      <ul className="fw-fs-ptable">
        {record.members.map((row) => (
          <li key={row.employeeId} className="fw-fs-prow">
            <Link className="fw-fs-person-l is-full" href={structureHref(model.path, { person: row.employeeId })}>
              <PeoplePicture source={sourceOfPicture(row.name, row.picture, 'person')} size="sm" nameBeside />
              <span className="fw-fs-person-n">{row.name}</span>
            </Link>
            <span className="fw-fs-card-sub">{row.role ?? '—'}</span>
            {row.isLeader ? <Tag tone="info">{t('unit.leadsThis')}</Tag> : <span />}
            {model.people ? (
              <span className="fw-fs-unit-acts">
                {row.isLeader ? null : (
                  <Button size="xs" onClick={() => actions?.onMakeLeader(row.employeeId)}>
                    <UserCheck size={14} aria-hidden />
                    {t('person.makeLeader')}
                  </Button>
                )}
                <Button size="xs" onClick={() => actions?.onMovePerson(row.employeeId)}>
                  <ArrowRightLeft size={14} aria-hidden />
                  {t('profile.move')}
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  )
}

const isLife = (state: string): state is OrderLife => (ORDER_LIFE as readonly string[]).includes(state)

function WorkTab({ model, record }: { model: UnitProfileModel; record: UnitRecord }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const open = record.work.filter((order) => !['SHIPPED', 'DELIVERED', 'WITHDRAWN'].includes(order.state))
  const before = record.work.filter((order) => ['SHIPPED', 'DELIVERED', 'WITHDRAWN'].includes(order.state))
  const list = (orders: UnitRecord['work']) => (
    <ul className="fw-fs-chain">
      {orders.map((order) => (
        <li key={order.orderId}>
          <Link className="fw-fs-chain-l" href={`${model.prefix}/sales/orders/${encodeURIComponent(order.orderId)}?tab=production`}>
            <span className="fw-fs-card-t">
              <span className="fw-fs-card-name">{order.number}</span>
              <span className="fw-fs-card-sub">{order.customerCode}</span>
            </span>
            {isLife(order.state) ? <StateChip life={order.state} /> : null}
          </Link>
        </li>
      ))}
    </ul>
  )
  return (
    <>
      <Section id="work-now" title={t('work.now')} answer={open.length ? undefined : t(record.takesOrders ? 'work.noneTeam' : 'work.noneUnit')} buttons={[<Button key="teams" size="sm" asChild><Link href={`${model.prefix}/production/teams`}>{t('work.openTeams')}</Link></Button>]}>
        {open.length ? list(open) : <Quiet>{t(record.takesOrders ? 'work.noneTeam' : 'work.noneUnit')}</Quiet>}
      </Section>
      {before.length ? (
        <Section id="work-before" title={t('work.before')}>
          {list(before)}
        </Section>
      ) : null}
    </>
  )
}

export function HistoryList({ history }: { history: UnitProfileModel['history'] }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const locale = useLocale()
  return (
    <Section id="history" title={t('history.title')} answer={history.rows && history.rows.length === 0 ? t('history.none') : undefined}>
      {history.problem ? (
        <Quiet>{t(history.problem)}</Quiet>
      ) : !history.rows ? (
        <Skeleton height={48} />
      ) : history.rows.length === 0 ? (
        <Quiet>{t('history.none')}</Quiet>
      ) : (
        <ul className="fw-fs-hist">
          {history.rows.map((row, index) => (
            <li key={`${row.at}-${index}`} className="fw-fs-hist-row">
              <span className="fw-fs-hist-w">{row.words}</span>
              <span className="fw-fs-card-sub">{[row.who, formatDateTime(row.at, { locale })].join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
