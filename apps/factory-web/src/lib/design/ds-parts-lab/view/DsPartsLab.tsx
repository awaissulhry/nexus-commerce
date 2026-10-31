'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, MoreHorizontal } from 'lucide-react'
import { Card, EmptyState, FileRow } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { Button, Input, Pill, Tag } from '@nexus/ui/primitives'
import type { ColDef } from '@nexus/ui/grid'
import { GridCardList, type CardSort } from '@nexus/ui/grid/card-list/index'
import { RecordNav } from '@nexus/ui/patterns/record-nav/index'
import { SaveStatus, type SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { CheckList, checkListButton, checkListHeld, type CheckItem } from '@nexus/ui/patterns/checklist/index'
import { TraceTree, traceLevels, type TraceNode } from '@nexus/ui/patterns/trace-tree/index'
import { MarginMeter } from '@nexus/ui/charts/margin-meter/index'
import { Waterfall, type WaterfallStep } from '@nexus/ui/charts/waterfall/index'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { SelectableCardGroup } from '@nexus/ui/components/SelectableCard/index'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { WithMessages } from '../../../../record-panels/i18n'
import { useDsLabels } from '../../../i18n/ds-labels'
import { formatNumber, formatTime } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import './ds-parts-lab.css'

/**
 * The shared DS parts lab (`/design/ds-parts`, B-W2b-09): every part the W2a screens composed for themselves, now in
 * the design system, drawn with the `ds-words` catalogue as their `labels` in the gallery's language. In the browser
 * every part works for real (select cards, sort, J / K, tick a branch, fix a check). Made-up data only.
 */
export interface DsPartsLabModel {
  /** One part alone (the print view takes the page) or every part. */
  show?: 'all' | 'card-list' | 'print'
  cardList?: 'normal' | 'select' | 'reading' | 'empty'
  /** RecordNav: the record on show, and a paged list ("53 of 56"). */
  record?: string
  paged?: boolean
  checks?: 'open' | 'ready'
  /** The person holds the cost and margin grain. Default true. */
  grain?: boolean
  trace?: 'walk' | 'reach'
  printReading?: boolean
}

interface Order { id: string; number: string; customer: string; due: string; total: number; status: 'OPEN' | 'SHIPPED' }
const ORDERS: Order[] = [
  { id: 'o1', number: 'SO-0101', customer: 'Demo Moto S.r.l.', due: '2026-11-04', total: 1200, status: 'OPEN' },
  { id: 'o2', number: 'SO-0102', customer: 'Demo Racing S.p.A.', due: '2026-11-06', total: 640.5, status: 'SHIPPED' },
  { id: 'o3', number: 'SO-0103', customer: 'Demo Touring', due: '2026-11-09', total: 2310, status: 'OPEN' },
  { id: 'o4', number: 'SO-0104', customer: 'Demo Pista', due: '2026-11-12', total: 980, status: 'OPEN' },
]
const PO_IDS = ['PO-0001', 'PO-0002', 'PO-0003', 'PO-0004', 'PO-0005']
const PAGED_IDS = ['PO-0051', 'PO-0052', 'PO-0053', 'PO-0054', 'PO-0055', 'PO-0056']

export function DsPartsLab({ model }: { model: DsPartsLabModel }) {
  return (
    <WithMessages namespaces={['ds-words', 'ds-parts-lab']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Section({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <Card padded header={title} className="fw-dsp-card">
      <div className={wide ? 'fw-dsp-wide' : 'fw-dsp-parts'}>{children}</div>
    </Card>
  )
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fw-dsp-part">
      <span className="fw-dsp-label">{label}</span>
      {children}
    </div>
  )
}

function Lab({ model }: { model: DsPartsLabModel }) {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const show = model.show ?? 'all'
  const money = (n: number) => formatNumber(n, locale, { style: 'currency', currency: 'EUR' })
  const pct = (n: number) => `${formatNumber(n, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`

  if (show === 'print') return <PrintLab reading={!!model.printReading} />
  return (
    <main id="main-content" className="fw-dsp">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Section title={t('section.cardList')} wide>
        <CardListLab mode={model.cardList ?? (show === 'card-list' ? 'select' : 'normal')} money={money} />
      </Section>
      {show === 'all' && (
        <>
          <Section title={t('section.recordNav')}>
            <RecordNavLab start={model.record} paged={!!model.paged} />
          </Section>
          <Section title={t('section.saveStatus')}>
            <SaveLab />
          </Section>
          <Section title={t('section.checkList')} wide>
            <ChecksLab ready={model.checks === 'ready'} />
          </Section>
          <Section title={t('section.traceTree')} wide>
            <TraceLab reach={model.trace === 'reach'} />
          </Section>
          <Section title={t('section.margins')}>
            <MarginsLab grain={model.grain !== false} money={money} pct={pct} />
          </Section>
          <Section title={t('section.cards')} wide>
            <CardsLab />
          </Section>
          <Section title={t('section.files')}>
            <Part label={t('section.files')}>
              <FileRow
                name="ddt-2026-0042.pdf"
                size={182_000}
                status={t('files.status')}
                onReplace={() => {}}
                onRemove={() => {}}
                labels={ds.fileRow}
                actions={
                  <>
                    <Button size="sm" variant="ghost" onClick={() => {}}>
                      <Download size={14} aria-hidden /> {t('files.download')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => {}}>{t('files.open')}</Button>
                  </>
                }
              />
            </Part>
          </Section>
          <Section title={t('section.print')} wide>
            <PrintLab reading={false} inline />
          </Section>
        </>
      )}
    </main>
  )
}

function CardListLab({ mode, money }: { mode: 'normal' | 'select' | 'reading' | 'empty'; money: (n: number) => string }) {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const [selected, setSelected] = useState<string[]>(mode === 'select' ? ['o1'] : [])
  const [sort, setSort] = useState<CardSort | null>(null)
  const [query, setQuery] = useState('')
  const columns = useMemo<ColDef<Order>[]>(() => [
    { colId: 'number', headerName: t('card.number'), field: 'number' },
    { colId: 'customer', headerName: t('card.customer'), field: 'customer' },
    { colId: 'due', headerName: t('card.due'), field: 'due' },
    { colId: 'total', headerName: t('card.total'), field: 'total', valueFormatter: ({ value }) => money(Number(value)) },
    {
      colId: 'status', headerName: t('card.status'), field: 'status', sortable: false,
      cellRenderer: ({ data }: { data?: Order }) => (data ? <Pill tone={data.status === 'OPEN' ? 'info' : 'success'}>{t(data.status === 'OPEN' ? 'card.open' : 'card.shipped')}</Pill> : null),
    },
    {
      colId: 'more', sortable: false,
      cellRenderer: ({ data }: { data?: Order }) => (data ? <Button size="xs" variant="quiet" aria-label={t('card.more', { number: data.number })} onClick={() => {}}><MoreHorizontal size={14} aria-hidden /></Button> : null),
    },
  ], [t, money])
  const rows = useMemo(() => {
    const found = ORDERS.filter((row) => `${row.number} ${row.customer}`.toLowerCase().includes(query.trim().toLowerCase()))
    if (!sort) return found
    const key = sort.colId as keyof Order
    return [...found].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1))
  }, [query, sort])
  const shown = mode === 'reading' ? null : mode === 'empty' ? [] : rows
  return (
    <div className="fw-dsp-phone">
      <GridCardList<Order>
        label={t('card.label')}
        rows={shown}
        rowId={(row) => row.id}
        columns={columns}
        hrefOf={(row) => `#${row.number}`}
        count={t('card.count', { shown: shown?.length ?? 0, total: ORDERS.length })}
        search={<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('card.search')} aria-label={t('card.search')} />}
        sort={sort}
        onSortChange={setSort}
        selectMode={mode === 'select'}
        isRowSelectable={(row) => (row.status === 'SHIPPED' ? t('card.shippedHeld') : null)}
        selection={{ selected, onChange: setSelected, actions: <Button size="sm" variant="danger-outline" onClick={() => setSelected([])}>{t('card.cancel', { count: selected.length })}</Button> }}
        state={mode === 'empty' || (shown && shown.length === 0) ? <EmptyState title={t('card.empty')} action={<Button size="sm" onClick={() => setQuery('')}>{t('card.clear')}</Button>} /> : undefined}
        labels={ds.cardList}
      />
    </div>
  )
}

function RecordNavLab({ start, paged }: { start?: string; paged: boolean }) {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const ids = paged ? PAGED_IDS : PO_IDS
  const [current, setCurrent] = useState(start ?? (paged ? 'PO-0053' : 'PO-0002'))
  return (
    <Part label={t('record.title', { code: current })}>
      <div className="fw-dsp-band">
        <span className="fw-dsp-band-title">{t('record.title', { code: current })}</span>
        <RecordNav ids={ids} current={current} hrefOf={(id) => `#${id}`} onGo={(id) => setCurrent(id)} noun={t('record.noun')}
          offset={paged ? 50 : undefined} total={paged ? 60 : undefined} labels={ds.recordNav} />
      </div>
      <p className="fw-dsp-note">{t('record.hint')}</p>
    </Part>
  )
}

const SAVED_AT = '2026-10-31T09:42:00Z'

function SaveLab() {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  // The time of a save in the page's language and the site's zone (the factory's writer, PLT-134).
  const time = (iso: string) => formatTime(iso, { locale })
  const [state, setState] = useState<SaveStatusState>({ kind: 'idle' })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const save = (fail: boolean) => {
    setState({ kind: 'saving' })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(fail ? { kind: 'failed', count: 1, reason: t('save.reason') } : { kind: 'saved', at: new Date().toISOString() }), 700)
  }
  const states: SaveStatusState[] = [
    { kind: 'saved', at: SAVED_AT }, { kind: 'saving' }, { kind: 'failed', count: 2 }, { kind: 'unsaved' }, { kind: 'unsaved', count: 3 }, { kind: 'offline', count: 2 },
  ]
  return (
    <>
      <Part label={t('save.states')}>
        <ul className="fw-dsp-list">
          {states.map((item, index) => (
            <li key={index}>
              <SaveStatus state={item} onRetry={item.kind === 'failed' ? () => {} : undefined} formatTime={time} labels={ds.saveStatus} />
            </li>
          ))}
        </ul>
      </Part>
      <Part label={t('save.demo')}>
        <SaveStatus state={state} onRetry={() => save(false)} formatTime={time} labels={ds.saveStatus} />
        <div className="fw-dsp-buttons">
          <Button size="sm" onClick={() => save(false)}>{t('save.edit')}</Button>
          <Button size="sm" onClick={() => save(true)}>{t('save.fail')}</Button>
          <Button size="sm" onClick={() => setState({ kind: 'offline', count: 2 })}>{t('save.offline')}</Button>
        </div>
      </Part>
    </>
  )
}

function ChecksLab({ ready }: { ready: boolean }) {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const [certState, setCertState] = useState<CheckItem['state']>(ready ? 'pass' : 'fail')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const checks: CheckItem[] = [
    { id: 'lot', state: 'pass', name: t('check.lot'), detail: t('check.lotDetail') },
    { id: 'cert', state: certState, name: t('check.cert'), detail: certState === 'pass' ? undefined : t('check.certDetail'), fix: { label: t('check.certFix'), href: '#certificate' } },
    { id: 'label', state: 'warning', name: t('check.label2'), detail: t('check.labelDetail') },
    { id: 'size', state: 'skipped', name: t('check.size') },
    { id: 'holds', state: ready ? 'pass' : 'unknown', name: t('check.holds'), detail: ready ? undefined : t('check.holdsDetail') },
  ]
  const fix = () => {
    setCertState('checking')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCertState('pass'), 800)
  }
  return (
    <div className="fw-dsp-stack">
      <CheckList label={t('check.label')} checks={checks} labels={ds.checkList} />
      <div className="fw-dsp-buttons">
        <Button variant="primary" heldReason={checkListHeld(checks, ds.checkList)} onClick={() => {}}>
          {checkListButton(t('check.release'), checks, ds.checkList)}
        </Button>
        {certState === 'fail' && <Button size="sm" onClick={fix}>{t('check.fixIt')}</Button>}
      </div>
    </div>
  )
}

function TraceLab({ reach }: { reach: boolean }) {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const [selected, setSelected] = useState<string[]>(reach ? ['b1'] : [])
  const roots = useMemo<TraceNode[]>(() => [
    {
      id: 'lot', kind: t('trace.lot'), label: 'L-0042', href: '#lot',
      children: [
        { id: 'h1', kind: t('trace.hide'), label: 'H-0042-01', children: [
          { id: 'b1', kind: t('trace.bundle'), label: 'B-0901', meta: <Tag>{t('trace.qty', { n: 24 })}</Tag>, children: [
            { id: 'w1', kind: t('trace.wo'), label: 'WO-0310', href: '#wo', children: [{ id: 'g1', kind: t('trace.garment'), label: 'SN 1001–1024', meta: <Tag>{t('trace.qty', { n: 24 })}</Tag> }] },
          ] },
          { id: 'b2', kind: t('trace.bundle'), label: 'B-0902', possible: true },
        ] },
        { id: 'h2', kind: t('trace.hide'), label: 'H-0042-02', held: reach ? t('trace.shippedHeld') : null, children: [
          { id: 'b3', kind: t('trace.bundle'), label: 'B-0903', children: [
            { id: 's1', kind: t('trace.shipment'), label: 'SH-0077', children: [{ id: 'c1', kind: t('trace.customer'), label: 'Demo Moto S.r.l.' }] },
          ] },
        ] },
      ],
    },
  ], [t, reach])
  const levels = traceLevels(roots).map((level) => ({ id: level.id, label: t('trace.count', { count: level.count + level.possible, kind: level.id }), possible: level.possible }))
  return (
    <div className="fw-dsp-stack">
      <TraceTree roots={roots} label={t('trace.label', { code: 'L-0042' })} levels={levels} defaultOpenDepth={3}
        selection={reach ? { selected, onChange: setSelected } : undefined} labels={ds.traceTree} />
      {reach && (
        <div className="fw-dsp-buttons">
          <Button variant="primary" heldReason={selected.length === 0 ? t('trace.nothing') : null} onClick={() => {}}>{t('trace.hold', { count: selected.length })}</Button>
        </div>
      )}
    </div>
  )
}

function MarginsLab({ grain, money, pct }: { grain: boolean; money: (n: number) => string; pct: (n: number) => string }) {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const [customer, setCustomer] = useState<string | null>(null)
  const price: WaterfallStep[] = [
    { id: 'base', kind: 'start', label: t('margin.base'), amount: 52 },
    { id: 'options', kind: 'step', label: t('margin.options'), amount: 6, href: '#pricelist' },
    { id: 'qty', kind: 'step', label: t('margin.qtyBreak'), amount: -4.5, detail: <p>{t('margin.qtyDetail')}</p> },
    { id: 'manual', kind: 'step', label: t('margin.manual'), amount: -1.5 },
    { id: 'net', kind: 'total', label: t('margin.net'), amount: 52 },
  ]
  const cost: WaterfallStep[] = [
    { id: 'materials', kind: 'start', label: t('margin.materials'), amount: 21.4 },
    { id: 'labour', kind: 'step', label: t('margin.labour'), amount: 14.2, href: '#costing' },
    { id: 'overhead', kind: 'step', label: t('margin.overhead'), amount: 5.1 },
    { id: 'cost', kind: 'total', label: t('margin.costTotal') },
    { id: 'margin', kind: 'step', label: t('margin.marginStep'), amount: 11.3 },
    { id: 'price', kind: 'total', label: t('margin.priceTotal'), amount: 52 },
  ]
  const customers = [
    { id: 'c1', label: 'Demo Moto S.r.l.', sub: t('margin.orders', { count: 4 }), value: 18.2, tone: 'danger' as const },
    { id: 'c2', label: 'Demo Racing S.p.A.', sub: t('margin.orders', { count: 7 }), value: 26.4, tone: 'warning' as const },
    { id: 'c3', label: 'Demo Touring', sub: t('margin.orders', { count: 2 }), value: 33.9, tone: 'success' as const },
  ]
  return (
    <>
      <Part label={t('margin.now')}>
        <MarginMeter value={18.2} floor={20} target={30} allowed={grain} format={pct} label={t('margin.now')} labels={ds.marginMeter} />
        <MarginMeter value={31.5} floor={20} target={30} allowed={grain} format={pct} label={t('margin.quoted')} labels={ds.marginMeter} />
        <MarginMeter value={null} floor={20} allowed={grain} format={pct} label={t('margin.unknown')} labels={ds.marginMeter} />
      </Part>
      <Part label={t('margin.mini')}>
        <ul className="fw-dsp-list">
          {[12, 24, 34].map((value) => (
            <li key={value} className="fw-dsp-mini"><MarginMeter size="mini" value={value} floor={20} target={30} allowed={grain} format={pct} labels={ds.marginMeter} /></li>
          ))}
        </ul>
      </Part>
      <Part label={t('margin.price')}>
        <Waterfall steps={price} label={t('margin.price')} format={money} labels={ds.waterfall} />
      </Part>
      <Part label={t('margin.cost')}>
        <Waterfall steps={cost} label={t('margin.cost')} format={money} good="down" heldReason={grain ? null : t('margin.noGrain')} labels={ds.waterfall} />
      </Part>
      <Part label={t('margin.byCustomer')}>
        <BarList items={grain ? customers : []} label={t('margin.byCustomer')} format={pct} active={customer} onPick={(id) => setCustomer(customer === id ? null : id)} labels={ds.barList} />
        {customer && <p className="fw-dsp-note" role="status">{t('margin.picked', { name: customers.find((c) => c.id === customer)?.label ?? '' })}</p>}
      </Part>
      <Part label={t('margin.overdue')}>
        <BarList
          label={t('margin.overdue')}
          format={money}
          keys={[{ id: 'd30', label: t('margin.d30'), tone: 'info' }, { id: 'd60', label: t('margin.d60'), tone: 'warning' }, { id: 'd90', label: t('margin.d90'), tone: 'danger' }]}
          items={[
            { id: 'c1', label: 'Demo Moto S.r.l.', value: 12400, parts: { d30: 8000, d60: 3100, d90: 1300 }, href: '#c1' },
            { id: 'c2', label: 'Demo Racing S.p.A.', value: 5200, parts: { d30: 5200 }, href: '#c2' },
            { id: 'c3', label: 'Demo Touring', value: null },
          ]}
          labels={ds.barList}
        />
      </Part>
    </>
  )
}

function CardsLab() {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const [scope, setScope] = useState<string | null>('L1')
  const [inReport, setInReport] = useState<string[]>(['L1', 'L3'])
  const lines = [
    { id: 'L1', state: 'running', done: 120, planned: 180, time: '10:31' },
    { id: 'L2', state: 'closed', done: 0, planned: 0, time: '—' },
    { id: 'L3', state: 'idle', done: 64, planned: 150, time: '09:58' },
  ]
  const options = lines.map((line) => ({
    id: line.id,
    title: t('cards.line', { code: line.id }),
    aside: <Tag tone={line.state === 'running' ? 'success' : line.state === 'idle' ? 'warning' : 'neutral'}>{t(`cards.${line.state}`)}</Tag>,
    held: line.state === 'closed' ? t('cards.closed') : null,
    children: (
      <>
        <span>{t('cards.output', { done: line.done, planned: line.planned })}</span>
        <span>{t('cards.lastReport', { time: line.time })}</span>
      </>
    ),
  }))
  return (
    <div className="fw-dsp-stack">
      <SelectableCardGroup label={t('cards.label')} mode="single" clearable value={scope} onChange={setScope} options={options} labels={ds.selectableCard} />
      <SelectableCardGroup label={t('cards.multiLabel')} mode="multiple" value={inReport} onChange={setInReport} options={options} minCardWidth="12rem" labels={ds.selectableCard} />
    </div>
  )
}

function PrintLab({ reading, inline }: { reading: boolean; inline?: boolean }) {
  const t = useT('ds-parts-lab')
  const ds = useDsLabels()
  const body = (
    <PrintView
      title={t('print.title')}
      meta={[t('print.site')]}
      printedAt={t('print.when')}
      printedBy={t('print.person')}
      filters={[{ label: t('print.line'), value: 'L1, L3' }]}
      printHeld={reading ? t('print.reading') : null}
      back={{ href: '#report', label: t('print.back') }}
      light={!inline}
      labels={ds.printView}
    >
      {['L1', 'L3'].map((code) => (
        <PrintSection key={code} title={t('print.lane', { code })}>
          <p>{t('print.laneBody')}</p>
        </PrintSection>
      ))}
    </PrintView>
  )
  return inline ? body : <main id="main-content" className="fw-dsp">{body}</main>
}
