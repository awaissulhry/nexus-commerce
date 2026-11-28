'use client'

import { useState, type CSSProperties, type DragEvent, type ReactElement } from 'react'
import Link from 'next/link'
import { ArrowRightLeft, ChevronDown, ChevronRight, Info, LayoutList, Layers, Network, Plus, Search, UserPlus } from 'lucide-react'
import { Banner, DetailPopover } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { useRoomWidth } from '../../../../lib/order-cells/use-room-width'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { roomOf } from '../../../../lib/window-shell/model'
import type { PersonRow } from '../api'
import { dragOf, dragText, hitsOf, listRowsOf, STRUCTURE_NS, structureHref, viewOf, type Drag, type Tree, type UnitNode, type Words } from '../model'
import '../structure.css'

/**
 * owb-ss8 (8.1; design § 5zb; prototype org.js structurePage, orgNode, orgRow) — People › Factory structure: the CHART (cards with lines
 * down: picture, name, kind, leader, people; drag a card or a face onto a unit → the Move window asks first and says what moves) and the
 * LIST (one row a unit, the same buttons; a phone starts with it). The find box marks the cards of a person, a role or a unit. The chart
 * scrolls inside its own box, never the page sideways; every drag has its keyboard twin (Move…). Read only without the right to manage.
 * Draws one model; fetches nothing.
 */

export interface StructureViewModel {
  /** `/w/<company>/people/structure`. */
  readonly path: string
  readonly state: 'reading' | 'failed' | 'ready'
  /** The read's failure (a key of `factory-structure`). */
  readonly problem: string | null
  readonly tree: Tree | null
  readonly manage: boolean
  /** Add a person (today's employee create + move: people.employees.manage and people.teams.manage). */
  readonly addPerson: boolean
  /** The address's view; null = by the page's room (a narrow room starts with the list). */
  readonly view: 'chart' | 'list' | null
  readonly query: string
  /** The units whose units under them are hidden (list and chart). */
  readonly shut: ReadonlySet<string>
  readonly notice: Words | null
}

export interface StructureViewActions {
  readonly onRetry: () => void
  readonly onView: (view: 'chart' | 'list') => void
  readonly onQuery: (query: string) => void
  readonly onToggle: (unitId: string) => void
  readonly onOpenAll: (open: boolean) => void
  readonly onNewUnit: (parentId: string | null) => void
  readonly onAddPerson: (unitId: string | null) => void
  readonly onReadyMade: () => void
  readonly onMove: (drag: Drag) => void
  readonly onDrop: (drag: Drag, targetUnitId: string) => void
  readonly onDismissNotice: () => void
}

export function StructureView({ model, actions }: { model: StructureViewModel; actions?: StructureViewActions }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const room = useRoomWidth(roomOf, 'wide')
  const view = viewOf(model.view, room.value === 'narrow')
  const tree = model.tree
  const finding = model.query.trim().length > 0
  const hits = tree ? hitsOf(tree, model.query) : new Set<string>()
  const units = tree?.order.length ?? 0
  const teams = tree?.order.filter((node) => node.unit.takesOrders).length ?? 0
  const people = tree ? tree.order.reduce((sum, node) => sum + node.here.length, 0) + tree.loose.length : 0
  const anyShut = model.shut.size > 0
  return (
    <div className="fw-fs" ref={room.ref}>
      <div className="fw-fs-head">
        <p className="fw-fs-sum" role="status">
          {tree ? [t('head.units', { count: units }), t('head.teams', { count: teams }), t('head.people', { count: people }), ...(tree.loose.length ? [t('head.loose', { count: tree.loose.length })] : [])].join(' · ') : null}
        </p>
        <span className="fw-fs-acts">
          {model.manage ? (
            <>
              <Button size="sm" onClick={() => actions?.onNewUnit(tree?.roots[0]?.unit.id ?? null)}>
                <Plus size={14} aria-hidden />
                {t('head.newUnit')}
              </Button>
              {model.addPerson ? (
                <Button size="sm" onClick={() => actions?.onAddPerson(null)}>
                  <UserPlus size={14} aria-hidden />
                  {t('head.addPerson')}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => actions?.onReadyMade()}>
                <Layers size={14} aria-hidden />
                {t('head.readyMade')}
              </Button>
            </>
          ) : (
            <Tag tone="neutral">{t('head.readOnly')}</Tag>
          )}
          <DetailPopover trigger={<Info size={16} aria-hidden />} triggerLabel={t('head.infoLabel')} triggerClassName="nds-btn icon" label={t('head.infoLabel')} hoverDelay={0}>
            <p className="fw-fs-info">{t(model.manage ? 'head.infoManage' : 'head.info')}</p>
          </DetailPopover>
        </span>
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

      <div className="fw-fs-tools">
        <SegmentedControl
          size="sm"
          ariaLabel={t('tools.view')}
          value={view}
          onChange={(value) => actions?.onView(value === 'list' ? 'list' : 'chart')}
          options={[
            { value: 'chart', label: t('tools.chart'), icon: <Network size={14} aria-hidden /> },
            { value: 'list', label: t('tools.list'), icon: <LayoutList size={14} aria-hidden /> },
          ]}
        />
        <span className="fw-fs-find">
          <Input size="sm" leadingIcon={<Search size={14} aria-hidden />} value={model.query} onChange={(event) => actions?.onQuery(event.target.value)} placeholder={t('tools.find')} aria-label={t('tools.find')} />
        </span>
        {finding ? (
          <>
            <span className="fw-fs-hits" role="status">
              {hits.size > 0 ? t('tools.marked', { count: hits.size }) : t('tools.nothing', { query: model.query.trim() })}
            </span>
            <Button size="sm" variant="quiet" onClick={() => actions?.onQuery('')}>
              {t('tools.showAll')}
            </Button>
          </>
        ) : null}
        <span className="fw-fs-grow" />
        {tree && tree.order.some((node) => node.children.length > 0) ? (
          <Button size="sm" variant="quiet" onClick={() => actions?.onOpenAll(anyShut)}>
            {t(anyShut ? 'tools.openAll' : 'tools.closeAll')}
          </Button>
        ) : null}
      </div>

      {model.state === 'reading' ? (
        <div className="fw-fs-skel" aria-busy="true">
          <Skeleton height={72} />
          <Skeleton height={72} />
        </div>
      ) : model.state === 'failed' || !tree ? (
        <Banner
          tone="danger"
          title={t('failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem ?? 'error.read')}
        </Banner>
      ) : tree.roots.length === 0 ? (
        <p className="fw-fs-quiet">{t('empty')}</p>
      ) : view === 'chart' ? (
        <div className="fw-fs-chart" tabIndex={0} aria-label={t('tools.chartLabel')}>
          <ul className="fw-fs-tree">
            {tree.roots.map((node) => (
              <ChartNode key={node.unit.id} node={node} model={model} actions={actions} hits={hits} finding={finding} />
            ))}
          </ul>
        </div>
      ) : (
        <ul className="fw-fs-list">
          {listRowsOf(tree, model.shut, finding).map((node) => (
            <ListRow key={node.unit.id} node={node} model={model} actions={actions} hit={hits.has(node.unit.id)} />
          ))}
        </ul>
      )}

      {tree && tree.loose.length > 0 ? (
        <section className="fw-fs-loose" aria-label={t('loose.title')}>
          <h2 className="fw-fs-h2">{t('loose.title')}</h2>
          {model.manage ? <p className="fw-fs-quiet">{t('loose.hint')}</p> : null}
          <ul className="fw-fs-faces">
            {tree.loose.map((row) => (
              <li key={row.employeeId}>
                <PersonChip row={row} model={model} actions={actions} full />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="fw-fs-quiet">{t('privacy')}</p>
    </div>
  )
}

/** Drag and drop: a card or a face starts a drag; a unit takes the drop; the model says what it asks (the Move window). */
function useDrop(model: StructureViewModel, actions: StructureViewActions | undefined, unitId: string) {
  const [over, setOver] = useState(false)
  if (!model.manage) return { over: false, props: {} }
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setOver(false)
        const drag = dragOf(event.dataTransfer.getData('text/plain'))
        if (drag) actions?.onDrop(drag, unitId)
      },
    },
  }
}

const dragProps = (manage: boolean, drag: Drag) =>
  manage
    ? {
        draggable: true,
        onDragStart: (event: DragEvent) => {
          event.stopPropagation()
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', dragText(drag))
        },
      }
    : {}

function ChartNode({ node, model, actions, hits, finding }: { node: UnitNode; model: StructureViewModel; actions?: StructureViewActions; hits: ReadonlySet<string>; finding: boolean }): ReactElement {
  const shut = !finding && model.shut.has(node.unit.id)
  return (
    <li className="fw-fs-node">
      <UnitCard node={node} model={model} actions={actions} hit={hits.has(node.unit.id)} />
      {node.children.length > 0 && !shut ? (
        <ul className="fw-fs-kids">
          {node.children.map((kid) => (
            <ChartNode key={kid.unit.id} node={kid} model={model} actions={actions} hits={hits} finding={finding} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function UnitCard({ node, model, actions, hit }: { node: UnitNode; model: StructureViewModel; actions?: StructureViewActions; hit: boolean }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const drop = useDrop(model, actions, node.unit.id)
  const unit = node.unit
  const faces = node.here.filter((row) => !row.isLeader)
  const shown = faces.slice(0, faces.length > 4 ? 3 : 4)
  const shut = model.shut.has(unit.id)
  return (
    <div className={`fw-fs-card${unit.takesOrders ? ' is-team' : ''}${hit ? ' is-hit' : ''}${drop.over ? ' is-over' : ''}`} {...drop.props} {...dragProps(model.manage && unit.parentId !== null, { kind: 'unit', id: unit.id })}>
      <Link className="fw-fs-card-main" href={structureHref(model.path, { unit: unit.id })} title={unit.name}>
        <PeoplePicture source={sourceOfPicture(unit.name, unit.picture, 'team')} nameBeside />
        <span className="fw-fs-card-t">
          <span className="fw-fs-card-name">{unit.name}</span>
          <span className="fw-fs-card-sub">{[unit.takesOrders ? t('unit.team') : unit.kindWord, t('head.people', { count: node.total })].filter(Boolean).join(' · ')}</span>
        </span>
      </Link>
      <span className="fw-fs-card-lead">{unit.leader ? t('unit.leads', { name: unit.leader.name }) : t('unit.noLeader')}</span>
      {shown.length > 0 ? (
        <ul className="fw-fs-faces" aria-label={t('unit.peopleOf', { unit: unit.name })}>
          {shown.map((row) => (
            <li key={row.employeeId}>
              <PersonChip row={row} model={model} actions={actions} />
            </li>
          ))}
          {faces.length > shown.length ? (
            <li>
              <Link className="fw-fs-more" href={structureHref(model.path, { unit: unit.id, tab: 'people' })}>
                {t('unit.more', { count: faces.length - shown.length })}
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}
      <span className="fw-fs-card-foot">
        {node.children.length > 0 ? (
          <Button size="xs" variant="quiet" aria-expanded={!shut} onClick={() => actions?.onToggle(unit.id)}>
            {shut ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
            {t('unit.under', { count: node.children.length })}
          </Button>
        ) : null}
        <span className="fw-fs-grow" />
        {model.manage ? <UnitButtons node={node} actions={actions} addPerson={model.addPerson} /> : null}
      </span>
    </div>
  )
}

function UnitButtons({ node, actions, addPerson }: { node: UnitNode; actions?: StructureViewActions; addPerson: boolean }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const unit = node.unit
  return (
    <span className="fw-fs-unit-acts">
      {unit.takesOrders ? null : (
        <Button size="xs" variant="quiet" className="icon" aria-label={t('unit.newUnder', { unit: unit.name })} title={t('unit.newUnder', { unit: unit.name })} onClick={() => actions?.onNewUnit(unit.id)}>
          <Plus size={14} aria-hidden />
        </Button>
      )}
      {addPerson ? (
        <Button size="xs" variant="quiet" className="icon" aria-label={t('unit.addPersonTo', { unit: unit.name })} title={t('unit.addPersonTo', { unit: unit.name })} onClick={() => actions?.onAddPerson(unit.id)}>
          <UserPlus size={14} aria-hidden />
        </Button>
      ) : null}
      {unit.parentId !== null ? (
        <Button size="xs" variant="quiet" className="icon" aria-label={t('unit.moveOne', { unit: unit.name })} title={t('unit.moveOne', { unit: unit.name })} onClick={() => actions?.onMove({ kind: 'unit', id: unit.id })}>
          <ArrowRightLeft size={14} aria-hidden />
        </Button>
      ) : null}
    </span>
  )
}

function ListRow({ node, model, actions, hit }: { node: UnitNode; model: StructureViewModel; actions?: StructureViewActions; hit: boolean }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const drop = useDrop(model, actions, node.unit.id)
  const unit = node.unit
  const shut = model.shut.has(unit.id)
  return (
    <li className={`fw-fs-row${hit ? ' is-hit' : ''}${drop.over ? ' is-over' : ''}`} style={{ '--fw-fs-d': node.depth } as CSSProperties} {...drop.props}>
      {node.children.length > 0 ? (
        <Button size="xs" variant="quiet" className="icon" aria-expanded={!shut} aria-label={t(shut ? 'unit.show' : 'unit.hide', { unit: unit.name })} onClick={() => actions?.onToggle(unit.id)}>
          {shut ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </Button>
      ) : (
        <span className="fw-fs-row-sp" aria-hidden />
      )}
      <Link className="fw-fs-row-main" href={structureHref(model.path, { unit: unit.id })}>
        <PeoplePicture source={sourceOfPicture(unit.name, unit.picture, 'team')} size="sm" nameBeside />
        <span className="fw-fs-card-t">
          <span className="fw-fs-card-name">{unit.name}</span>
          <span className="fw-fs-card-sub">{[unit.takesOrders ? t('unit.team') : unit.kindWord, unit.leader ? unit.leader.name : t('unit.noLeader'), t('head.people', { count: node.total })].filter(Boolean).join(' · ')}</span>
        </span>
      </Link>
      {model.manage ? <UnitButtons node={node} actions={actions} addPerson={model.addPerson} /> : null}
    </li>
  )
}

function PersonChip({ row, model, actions, full = false }: { row: PersonRow; model: StructureViewModel; actions?: StructureViewActions; full?: boolean }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const said = [row.name, row.role].filter(Boolean).join(' · ')
  return (
    <span className="fw-fs-person" {...dragProps(model.manage, { kind: 'person', id: row.employeeId })}>
      <Link className="fw-fs-person-l" href={structureHref(model.path, { person: row.employeeId })} title={said} aria-label={said}>
        <PeoplePicture source={sourceOfPicture(row.name, row.picture, 'person')} size="sm" nameBeside />
        {full ? <span className="fw-fs-person-n">{said}</span> : null}
      </Link>
      {full && model.manage ? (
        <Button size="xs" variant="quiet" className="icon" aria-label={t('person.moveOne', { name: row.name })} title={t('person.moveOne', { name: row.name })} onClick={() => actions?.onMove({ kind: 'person', id: row.employeeId })}>
          <ArrowRightLeft size={14} aria-hidden />
        </Button>
      ) : null}
    </span>
  )
}
