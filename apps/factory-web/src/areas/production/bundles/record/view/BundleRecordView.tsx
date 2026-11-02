'use client'

import Link from 'next/link'
import { Ban, CheckCircle2, Circle, ExternalLink, FileX, MapPin, MoreHorizontal, Printer, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, EntityLinks, KeyValue, Menu, SummaryTable, Tabs, type TabItem } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { DetailHeader } from '@nexus/ui/patterns'
import { TraceTree, type TraceNode } from '@nexus/ui/patterns/trace-tree/index'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { WithMessages } from '../../../../../record-panels/i18n'
import { STATUS_TONE } from '../../../_shared/model'
import type { BundleRecord, RecordScan } from '../../api'
import { BUNDLE_TABS, BUNDLES_NAMESPACE, BUNDLES_NAMESPACES, nextWords, PLACE_TONE, placeWords, stuckWords, ticketLayout, voidHeld } from '../../model'
import { ReprintDialog, VoidDialog } from '../../view/BundleDialogs'
import { TicketQr, type Words } from '../../view/parts'
import type { BundleRecordActions, BundleRecordModel } from '../record-model'
import '../../../_shared/production.css'
import '../../bundles.css'

export type { BundleRecordActions, BundleRecordModel } from '../record-model'

/**
 * SCR-259-record — the Bundle record (design production.bundles rec:Bundle): the band (‹ Bundles, the code, the style, its
 * state and place, ⋯ Void bundle), then Progress (operations in order: done · here · not reached with their counts),
 * Scans (the append-only scans; a correction is never made here), Quality (holds, rework, the genealogy tree) and Ticket
 * (the label, replaced codes, reprints, print jobs, coupons; Reprint). Worker names only on the Scans tab of this one
 * bundle, where the site records workers.
 */
export function BundleRecordView({ model, actions }: { model: BundleRecordModel; actions?: BundleRecordActions }) {
  return (
    <WithMessages namespaces={BUNDLES_NAMESPACES}>
      <Record model={model} actions={actions} />
    </WithMessages>
  )
}

function Record({ model, actions }: { model: BundleRecordModel; actions?: BundleRecordActions }) {
  const t = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const listHref = `${model.prefix}/production/bundles`
  const loaded = model.bundle
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-pr">
        <div className="fw-pr-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-pr-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`record.state.${loaded.status}.title`)}
              description={loaded.status === 'error' ? scoped(`production:${loaded.problem}`) : t(`record.state.${loaded.status}.body`, { permission: 'production.bundles.view' })}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('record.backToList')}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </div>
    )
  }
  return <Ready record={loaded.value} model={model} actions={actions} />
}

function Ready({ record, model, actions }: { record: BundleRecord; model: BundleRecordModel; actions?: BundleRecordActions }) {
  const t = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const tp = useT('production')
  const locale = useLocale()
  const href = `${model.prefix}/production/bundles/${record.bundle.id}`
  const place = placeWords(record)
  const stuck = stuckWords(record)
  const voidWait = voidHeld(record, model.can)
  const tabs: TabItem[] = BUNDLE_TABS.map((tab) => ({ id: tab, href: `${href}?tab=${tab}`, label: t(`record.tab.${tab}`), count: tab === 'scans' ? record.bundle.scans : null }))
  const more = [
    ...(model.can.workOrders ? [{ id: 'order', label: t('list.openWorkOrder'), href: `${model.prefix}/production/work-orders/${record.workOrder.id}?tab=bundles` }] : []),
    { id: 'ticket', label: t('ticket.pdf'), ...(model.can.printLabels ? { href: `${href}/ticket`, target: '_blank' as const } : { disabled: true, description: t('held.noPrint', { permission: 'print.labels' }) }) },
    { id: 'void', label: t('void.open'), tone: 'danger' as const, disabled: voidWait !== null, ...(voidWait ? { description: t(voidWait.key, voidWait.params) } : {}), onSelect: () => actions?.onVoidDialog?.(true) },
  ]
  return (
    <div className="fw-pr">
      <div className="fw-pr-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/production/bundles`}>{t('record.back')}</Link>}
          title={
            <span className="fw-pr-title">
              {record.bundle.code}{' '}
              <span className="fw-pr-title-sub">
                · {record.style.code} {record.style.name} · {record.bundle.colourwayCode} {record.bundle.size}
              </span>
            </span>
          }
          actions={
            <span className="fw-pr-actions">
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-pr-meta-row">
          <span className="fw-pr-meta">
            <Pill tone={record.bundle.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`status.${record.bundle.status}`)}</Pill>
            <Pill tone={PLACE_TONE[record.place]}>{t(place.key, place.params)}</Pill>
            {stuck && <Tag tone="danger">{t(stuck.key, stuck.params)}</Tag>}
            {model.can.workOrders ? (
              <Link className="fw-pr-link" href={`${model.prefix}/production/work-orders/${record.workOrder.id}`}>
                {record.workOrder.number}
              </Link>
            ) : (
              <span>{record.workOrder.number}</span>
            )}
            <Pill tone={STATUS_TONE[record.workOrder.status]}>{tp(`status.${record.workOrder.status}`)}</Pill>
          </span>
          <span className="fw-pr-status" role="status">
            {t(`live.${model.live}`)}
          </span>
        </div>
        <Tabs ariaLabel={t('record.tabs')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={scoped(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {record.bundle.status === 'VOID' && <Banner tone="info" title={t('record.voided', { when: record.bundle.voidedAt ? formatDateTime(record.bundle.voidedAt, { locale }) : '—', reason: record.bundle.voidReason ?? '—' })} />}
      {model.tab === 'progress' && <ProgressTab record={record} t={t} locale={locale} />}
      {model.tab === 'scans' && <ScansTab model={model} actions={actions} />}
      {model.tab === 'quality' && <QualityTab record={record} model={model} />}
      {model.tab === 'ticket' && <TicketTab record={record} model={model} actions={actions} href={href} />}
      {model.voiding && <VoidDialog code={record.bundle.code} problem={model.voiding.problem} busy={model.voiding.busy} {...(model.voiding.reason ? { reason: model.voiding.reason } : {})} onVoid={actions?.onVoid} onClose={() => actions?.onVoidDialog?.(false)} />}
      {model.reprint && <ReprintDialog run={model.reprint} prefix={model.prefix} onRun={actions?.onRunReprint} onClose={() => actions?.onReprintDialog?.(false)} />}
    </div>
  )
}

const STATE_ICON = { DONE: CheckCircle2, HERE: MapPin, NOT_REACHED: Circle } as const

/** Progress (design bd-progress "OperationFlow for one bundle: done · here · not reached"): composed, the DS has no such part. */
function ProgressTab({ record, t, locale }: { record: BundleRecord; t: Words; locale: 'it' | 'en' }) {
  const next = nextWords(record)
  const place = placeWords(record)
  return (
    <div className="fw-pr-stack">
      <Card padded className="fw-pr-card">
        <h2 className="fw-pr-h2">{t('progress.title')}</h2>
        {record.progress.length === 0 ? (
          <p className="fw-pr-hint">{t('progress.none')}</p>
        ) : (
          <ol className="fw-bd-flow" aria-label={t('progress.title')}>
            {record.progress.map((operation) => {
              const Icon = STATE_ICON[operation.state]
              return (
                <li key={operation.id} className={operation.state === 'HERE' ? 'fw-bd-step is-here' : 'fw-bd-step'}>
                  <span className="fw-pr-code">
                    {operation.seq} · {operation.code}
                  </span>
                  <span className="fw-pr-cell-sub fw-pr-ellipsis">{operation.name}</span>
                  <span className="fw-bd-step-state">
                    <Icon size={14} aria-hidden /> {t(`progress.state.${operation.state}`)}
                  </span>
                  {operation.state === 'DONE' && (
                    <span className="fw-bd-tags">
                      <Tag tone="success">{t('progress.good', { count: operation.good ?? 0 })}</Tag>
                      {(operation.scrap ?? 0) > 0 && <Tag tone="danger">{t('progress.scrap', { count: operation.scrap ?? 0 })}</Tag>}
                      {(operation.rework ?? 0) > 0 && <Tag tone="warning">{t('progress.rework', { count: operation.rework ?? 0 })}</Tag>}
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </Card>
      <Card padded className="fw-pr-card">
        <h2 className="fw-pr-h2">{t('progress.where')}</h2>
        <KeyValue
          columns={3}
          items={[
            { label: t('progress.place'), value: t(place.key, place.params) },
            { label: t('progress.next'), value: next && record.next ? `${record.next.seq} ${record.next.code}` : '—' },
            { label: t('progress.since'), value: formatDateTime(record.since, { locale }) },
            { label: t('col.lastScan'), value: record.lastScan ? [formatDateTime(record.lastScan.at, { locale }), record.lastScan.station?.code].filter(Boolean).join(' · ') : t('col.noScan') },
            { label: t('col.pieces'), value: String(record.bundle.quantity) },
            { label: t('col.part'), value: record.bundle.part ?? t('col.whole') },
          ]}
        />
      </Card>
    </div>
  )
}

/** Scans (design bd-scans): the append-only rows; a correction is asked from the floor or approved in Labour & corrections. */
function ScansTab({ model, actions }: { model: BundleRecordModel; actions?: BundleRecordActions }) {
  const t = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const ds = useDsWords()
  const locale = useLocale()
  const scans = model.scans
  if (!scans) {
    return (
      <Card padded>
        <EmptyState title={t('scans.noRight.title')} description={t('scans.noRight.body', { permission: 'workorders.view' })} />
      </Card>
    )
  }
  if (!scans.value) {
    return (
      <Card padded>
        {scans.problem ? (
          <EmptyState
            title={t('scans.failed')}
            description={scoped(`production:${scans.problem}`)}
            action={
              <Button size="sm" onClick={() => actions?.onRetryScans?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <p className="fw-pr-hint" role="status">
            <Spinner size={14} /> {t('scans.loading')}
          </p>
        )}
      </Card>
    )
  }
  const rows: readonly RecordScan[] = scans.value
  const named = rows.some((scan) => scan.worker !== null)
  const seqOf = new Map(rows.map((scan, index) => [scan.id, index + 1]))
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('scans.title')}</h2>
        <span className="fw-pr-hint">{t('scans.hint')}</span>
      </div>
      {named && <PrivacyNote level="individual" variant="panel" text={t('scans.privacy')} labels={ds.privacyNote} />}
      {rows.length === 0 ? (
        <p className="fw-pr-hint">{t('col.noScan')}</p>
      ) : (
        <SummaryTable
          label={t('scans.title')}
          stackOnPhone
          columns={[t('scans.col.n'), t('scans.col.kind'), t('scans.col.operation'), t('scans.col.good'), t('scans.col.scrap'), t('scans.col.rework'), t('scans.col.reason'), t('scans.col.device'), t('scans.col.server'), t('scans.col.station'), ...(named ? [t('scans.col.worker')] : []), t('scans.col.state')]}
          align={[undefined, undefined, undefined, 'right', 'right', 'right']}
          widths={named ? ['44px', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '150px'] : ['44px', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '150px']}
          rows={rows.map((scan, index) => ({
            id: scan.id,
            cells: [
              String(index + 1),
              t(`scanKind.${scan.kind}`),
              `${scan.operation.seq} ${scan.operation.code}`,
              String(scan.goodQuantity),
              String(scan.scrapQuantity),
              String(scan.reworkQuantity),
              scan.scrapReason ?? '—',
              scan.deviceTime ? formatDateTime(scan.deviceTime, { locale }) : '—',
              formatDateTime(scan.serverTime, { locale }),
              scan.station?.code ?? '—',
              ...(named ? [scan.worker?.name ?? '—'] : []),
              <span key="state" className="fw-bd-tags">
                {scan.voidedById && <Tag tone="warning">{t('scans.voidedBy', { n: seqOf.get(scan.voidedById) ?? '—' })}</Tag>}
                {scan.correctsId && <Tag tone="info">{t('scans.voids', { n: seqOf.get(scan.correctsId) ?? '—' })}</Tag>}
                {scan.approvedById && <Tag tone="success">{t('scans.approved')}</Tag>}
              </span>,
            ],
          }))}
        />
      )}
    </Card>
  )
}

/** Quality (design bd-quality, bd-genealogy): holds and rework as links, the tree from the hides to the garments. */
function QualityTab({ record, model }: { record: BundleRecord; model: BundleRecordModel }) {
  const t = useT(BUNDLES_NAMESPACE)
  const ds = useDsWords()
  const { genealogy, quality } = record
  const open = (type: string, id: string) => `${model.prefix}${recordAddress({ type, id }, OFFICE_PAGES)}`
  const hides: TraceNode[] = genealogy.hides.map((hide) => ({ id: `hide:${hide.hideId}`, kind: t('tree.hide'), label: hide.code, href: open('Hide', hide.hideId), children: [{ id: `lot:${hide.hideId}:${hide.lotId}`, kind: t('tree.lot'), label: hide.lotCode, href: open('Lot', hide.lotId) }] }))
  const serials: TraceNode[] = genealogy.serials.map((serial) => ({ id: `serial:${serial.id}`, kind: t('tree.serial'), label: serial.serial }))
  const children: TraceNode[] = genealogy.children.map((child) => ({ id: `child:${child.id}`, kind: t('tree.child'), label: child.code, href: open('Bundle', child.id), meta: <Tag tone="neutral">{t('col.piecesCount', { count: child.quantity })}</Tag> }))
  const parent: TraceNode[] = genealogy.parent ? [{ id: `parent:${genealogy.parent.id}`, kind: t('tree.parent'), label: genealogy.parent.code, href: open('Bundle', genealogy.parent.id) }] : []
  const roots: TraceNode[] = [{ id: `bundle:${record.bundle.id}`, kind: t('tree.bundle'), label: record.bundle.code, children: [...parent, ...hides, ...children, ...serials] }]
  return (
    <div className="fw-pr-stack">
      <div className="fw-bd-pair">
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('quality.holds')}</h2>
          {quality.holds.length === 0 ? <p className="fw-pr-hint">{t('quality.noHolds')}</p> : <EntityLinks items={quality.holds.map((hold) => ({ id: hold.id, name: hold.reasonCode, href: open('QualityHold', hold.id) }))} noun={{ one: t('quality.holdOne'), many: t('quality.holdMany') }} />}
        </Card>
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('quality.reworks')}</h2>
          {quality.reworks.length === 0 ? <p className="fw-pr-hint">{t('quality.noReworks')}</p> : <EntityLinks items={quality.reworks.map((rework) => ({ id: rework.id, name: t('quality.reworkName', { count: rework.quantity, status: rework.status }), href: open('ReworkOrder', rework.id) }))} noun={{ one: t('quality.reworkOne'), many: t('quality.reworkMany') }} />}
        </Card>
      </div>
      <Card padded className="fw-pr-card">
        <div className="fw-pr-card-head">
          <h2 className="fw-pr-h2">{t('quality.genealogy')}</h2>
          {genealogy.shades.length > 0 && <span className="fw-pr-hint">{t('quality.shades', { shades: genealogy.shades.join(', ') })}</span>}
        </div>
        <TraceTree roots={roots} label={t('quality.treeLabel', { code: record.bundle.code })} labels={ds.traceTree} />
      </Card>
    </div>
  )
}

/** Ticket (design bd-ticket): the current ticket, the replaced codes ("scanning it says replaced"), reprints and print jobs. */
function TicketTab({ record, model, actions, href }: { record: BundleRecord; model: BundleRecordModel; actions?: BundleRecordActions; href: string }) {
  const t = useT(BUNDLES_NAMESPACE)
  const tp = useT('production')
  const locale = useLocale()
  const { ticket } = record
  const pdfHeld = model.can.printLabels ? null : t('held.noPrint', { permission: 'print.labels' })
  const reprintWait = !model.can.act ? t('held.noAct', { permission: 'production.bundles' }) : record.bundle.status === 'VOID' ? t('held.ticketVoid') : record.workOrder.status !== 'RELEASED' && record.workOrder.status !== 'IN_PROGRESS' ? t('held.ticketNotOpen') : pdfHeld
  const layout = ticketLayout(record, {
    name: (code) => t('ticket.name', { code }),
    workOrder: t('ticket.workOrder'),
    style: t('col.style'),
    colour: t('col.colour'),
    size: t('col.size'),
    pieces: t('col.pieces'),
    operations: t('ticket.operations'),
  })
  return (
    <div className="fw-pr-stack">
      <Card padded className="fw-pr-card">
        <div className="fw-pr-card-head">
          <h2 className="fw-pr-h2">{t('ticket.title')}</h2>
          <span className="fw-pr-actions">
            {pdfHeld ? (
              <Button size="sm" heldReason={pdfHeld}>
                <ExternalLink size={13} aria-hidden /> {t('ticket.pdf')}
              </Button>
            ) : (
              <Button size="sm" asChild>
                <Link href={`${href}/ticket`} target="_blank">
                  <ExternalLink size={13} aria-hidden /> {t('ticket.pdf')}
                </Link>
              </Button>
            )}
            <Button size="sm" variant="primary" heldReason={reprintWait} onClick={() => actions?.onReprintDialog?.(true)}>
              <Printer size={13} aria-hidden /> {t('ticket.reprint')}
            </Button>
          </span>
        </div>
        <LabelPreview layout={layout} renderQr={(value) => <TicketQr value={value} label={t('ticket.qr', { code: value })} />} codeLabel={(value, kind) => t(`ticket.code.${kind}`, { code: value })} />
        {record.bundle.status === 'VOID' && <p className="fw-pr-hint"><Ban size={13} aria-hidden /> {t('ticket.voided')}</p>}
      </Card>
      <div className="fw-bd-pair">
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('ticket.replaced')}</h2>
          {ticket.replacedCodes.length === 0 ? <p className="fw-pr-hint">{t('ticket.noReplaced')}</p> : <p className="fw-pr-code">{ticket.replacedCodes.join(', ')}</p>}
          {ticket.replacedCodes.length > 0 && <p className="fw-pr-hint">{t('ticket.replacedHint')}</p>}
          {ticket.reprints.length > 0 && (
            <SummaryTable
              label={t('ticket.reprints')}
              stackOnPhone
              columns={[t('ticket.col.when'), t('ticket.col.new'), t('ticket.col.old'), t('ticket.col.reason'), t('ticket.col.where')]}
              rows={ticket.reprints.map((reprint, index) => ({ id: String(index), cells: [formatDateTime(reprint.at, { locale }), reprint.code, reprint.replacedCode, reprint.reason, tp(`bundles.postedBy.${reprint.postedBy}`)] }))}
            />
          )}
        </Card>
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('ticket.jobs')}</h2>
          {ticket.jobs === null ? (
            <p className="fw-pr-hint">{t('ticket.noJobsRight', { permission: 'print.view' })}</p>
          ) : ticket.jobs.length === 0 ? (
            <p className="fw-pr-hint">{t('ticket.noJobs')}</p>
          ) : (
            <SummaryTable
              label={t('ticket.jobs')}
              stackOnPhone
              columns={[t('ticket.col.when'), t('ticket.col.state'), t('ticket.col.error')]}
              rows={ticket.jobs.map((job) => ({ id: job.jobId, cells: [formatDateTime(job.createdAt, { locale }), tp(`bundles.job.${job.status}`), job.lastError ? t('ticket.jobFailed') : '—'] }))}
            />
          )}
        </Card>
      </div>
      {ticket.coupons.length > 0 && (
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('ticket.coupons')}</h2>
          <SummaryTable
            label={t('ticket.coupons')}
            stackOnPhone
            columns={[t('ticket.col.code'), t('ticket.col.operation'), t('ticket.col.state'), t('ticket.col.when')]}
            rows={ticket.coupons.map((coupon) => ({ id: coupon.id, cells: [coupon.code, `${coupon.operation.seq} ${coupon.operation.code}`, t(`status.${coupon.status}`), formatDateTime(coupon.createdAt, { locale })] }))}
          />
        </Card>
      )}
    </div>
  )
}
