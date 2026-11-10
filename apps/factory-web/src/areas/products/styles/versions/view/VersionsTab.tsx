'use client'

import Link from 'next/link'
import { GitCompareArrows, Lock } from 'lucide-react'
import { Banner, Card, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { useWords, KindTag } from '../../../changes/parts'
import { DriftTable, type DriftRow } from '../../../changes/view/Impact'
import type { StyleView } from '../../api'
import { draftOf, nextRevisionNumber, startRevisionHeld } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record/record-model'
import { VERSIONS_NS } from '../../release/model'
import { byNewest, changeLines, countText, mayWiden, moneyOf, releasedText, REVISION_TONE, type Read, type StyleChanges, type VersionsActions, type VersionsModel } from '../model'
import { CompareBody } from './CompareBody'
import '../versions.css'

/**
 * Style › Versions & changes (design products.styles rec:Style tab style.versions): the revisions (state, why it changed,
 * who released it and when, the work orders, quotes and orders made from it; locked once released) with Start revision N,
 * Release… and Abandon the draft (the studio's own pop-ups) and what the released revision is released for ("Release
 * more…"); Compare revisions (VersionCompare per part, the cost difference with its grain); the change requests and change
 * orders raised against the style (Products › Changes & versions); the open quotes and orders on older revisions with the
 * cost difference (hidden when none). It draws one view model and fetches nothing.
 */
export function VersionsTab({ style, model, record, actions, recordActions }: { style: StyleView; model: VersionsModel; record: StyleRecordViewModel; actions?: VersionsActions; recordActions?: StyleRecordActions }) {
  const tv = useT(VERSIONS_NS)
  return (
    <div className="fw-st-stack-lg">
      <RevisionsCard style={style} model={model} record={record} actions={actions} recordActions={recordActions} />
      <Card header={tv('cmp.title')} description={tv('cmp.intro')} headingLevel={2} headerAction={<OpenCompare actions={actions} />}>
        <CompareBody model={model} actions={actions} />
      </Card>
      {model.changes && <ChangesCard style={style} changes={model.changes} model={model} prefix={record.prefix} actions={actions} />}
      <DriftCard model={model} prefix={record.prefix} actions={actions} />
    </div>
  )
}

function OpenCompare({ actions }: { actions?: VersionsActions }) {
  const tv = useT(VERSIONS_NS)
  return (
    <Button size="sm" variant="quiet" onClick={() => actions?.onCompareOpen?.()}>
      <GitCompareArrows size={14} aria-hidden /> {tv('cmp.openWide')}
    </Button>
  )
}

function Failed({ part, actions }: { part: 'versions' | 'changes' | 'drift' | 'released'; actions?: VersionsActions }) {
  const tv = useT(VERSIONS_NS)
  return (
    <Banner
      tone="danger"
      title={tv(`failed.${part}`)}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.(part)}>
          {tv('base.retry')}
        </Button>
      }
    />
  )
}

function Reading() {
  const tv = useT(VERSIONS_NS)
  return (
    <p className="fw-st-hint" role="status">
      <Spinner size={14} /> {tv('base.reading')}
    </p>
  )
}

function RevisionsCard({ style, model, record, actions, recordActions }: { style: StyleView; model: VersionsModel; record: StyleRecordViewModel; actions?: VersionsActions; recordActions?: StyleRecordActions }) {
  const t = useT('products')
  const tv = useT(VERSIONS_NS)
  const locale = useLocale()
  const draft = draftOf(style.revisions)
  const next = nextRevisionNumber(style.revisions)
  const startHeld = startRevisionHeld(style, record.can)
  const busy = record.busy ? t('held.busy') : null
  const recordHref = `${record.prefix}/products/styles/${style.id}`
  const releaseDraft = () => {
    if (!draft) return
    if (record.revisionId !== draft.id) recordActions?.onRevision?.(draft.id)
    recordActions?.onDialog?.({ kind: 'release' })
  }
  const tools = (
    <span className="fw-ver-row">
      {draft ? (
        <>
          <Button size="sm" heldReason={!record.can.release ? t('held.noRelease') : style.status === 'ARCHIVED' ? t('held.archived') : busy} onClick={releaseDraft}>
            {t('release.go', { revision: draft.revision })}
          </Button>
          <Button size="sm" variant="quiet" heldReason={!record.can.bomManage ? t('held.noManage') : busy} onClick={() => recordActions?.onDialog?.({ kind: 'abandon' })}>
            {t('action.abandon', { revision: draft.revision })}
          </Button>
        </>
      ) : (
        <Button size="sm" heldReason={startHeld ? t(startHeld, { revision: next }) : busy} onClick={() => recordActions?.onDialog?.({ kind: 'startRevision' })}>
          {t('action.startRevision', { revision: next })}
        </Button>
      )}
    </span>
  )
  const versions = model.versions
  return (
    <Card header={tv('ver.title')} description={tv('ver.intro')} headingLevel={2} headerAction={tools}>
      <div className="fw-st-stack">
        {versions.status === 'error' ? (
          <Failed part="versions" actions={actions} />
        ) : versions.status !== 'ready' ? (
          <Reading />
        ) : (
          <SummaryTable
            label={tv('ver.title')}
            density="roomy"
            stackOnPhone
            columns={[tv('col.revision'), tv('col.status'), tv('col.why'), tv('col.released'), tv('col.workOrders'), tv('col.quotes'), tv('col.orders'), tv('col.compare')]}
            align={['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right']}
            widths={['9%', '13%', undefined, '18%', '8%', '8%', '8%', '12%']}
            rows={byNewest(versions.value.revisions).map((row, index, all) => {
              const before = all[index + 1] ?? null
              const count = (value: number | null) => countText(value) ?? <span className="fw-st-hint" title={tv('ver.notInRole')}>—</span>
              return {
                id: row.id,
                cells: [
                  <Link key="rev" className="fw-st-link" href={`${recordHref}?tab=bom&rev=${encodeURIComponent(row.id)}`} aria-current={record.revisionId === row.id ? 'true' : undefined}>
                    {tv('ver.rev', { revision: row.revision })}
                  </Link>,
                  <span key="status" className="fw-st-inline">
                    <Pill tone={REVISION_TONE[row.status]}>{t(`revisionStatus.${row.status}`)}</Pill>
                    {row.locked && <Lock size={12} aria-label={tv('ver.locked')} role="img" />}
                    {record.revisionId === row.id && <Tag tone="neutral">{tv('ver.inView')}</Tag>}
                  </span>,
                  row.changeNote ?? <span className="fw-st-hint">{tv('ver.noNote')}</span>,
                  row.releasedAt ? (
                    <span>
                      {formatDateTime(row.releasedAt, { locale })}
                      <span className="nds-summary-sub">{row.releasedBy?.name ?? tv('ver.someone')}</span>
                    </span>
                  ) : (
                    <span className="fw-st-hint">{tv('ver.notReleased')}</span>
                  ),
                  count(row.workOrders),
                  count(row.quoteLines),
                  count(row.orderLines),
                  before ? (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onCompareOpen?.({ from: before.id, to: row.id })} aria-label={tv('ver.compareWith', { revision: row.revision, before: before.revision })}>
                      {tv('ver.compareBefore', { before: before.revision })}
                    </Button>
                  ) : (
                    <span className="fw-st-hint">—</span>
                  ),
                ],
              }
            })}
          />
        )}
        <ReleasedLine model={model} actions={actions} />
      </div>
    </Card>
  )
}

/** What the released revision is released for (PRD-191), and "Release more…" when some colourways or sizes wait. */
function ReleasedLine({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const tv = useT(VERSIONS_NS)
  const released = model.released
  if (released.status === 'error') return <Failed part="released" actions={actions} />
  if (released.status !== 'ready' || !released.value.revision) return null
  const text = releasedText(released.value)
  if (!text) return <p className="fw-st-hint">{tv('released.whole', { revision: released.value.revision.revision })}</p>
  return (
    <Banner
      tone="info"
      title={tv('released.part', { revision: released.value.revision.revision, colourways: text.colourways, sizes: text.sizes, count: text.cells })}
      action={
        mayWiden(released.value, model.can) ? (
          <Button size="sm" onClick={() => actions?.onWiden?.()}>
            {tv('released.more')}
          </Button>
        ) : undefined
      }
    >
      {tv('released.waits')}
    </Banner>
  )
}

function ChangesCard({ style, changes, model, prefix, actions }: { style: StyleView; changes: Read<StyleChanges>; model: VersionsModel; prefix: string; actions?: VersionsActions }) {
  const tv = useT(VERSIONS_NS)
  const { t: tc, say, day } = useWords()
  const styleQuery = encodeURIComponent(style.id)
  const tools = (
    <span className="fw-ver-row">
      {model.can.request ? (
        <Button size="sm" asChild>
          <Link href={`${prefix}/products/changes?new=1&style=${styleQuery}`}>{tv('chg.raise')}</Link>
        </Button>
      ) : (
        <Button size="sm" heldReason={tv('hold.noRequest')}>
          {tv('chg.raise')}
        </Button>
      )}
      <Link className="fw-st-link" href={`${prefix}/products/changes?style=${styleQuery}`}>
        {tv('chg.all')}
      </Link>
    </span>
  )
  return (
    <Card header={tv('chg.title')} description={tv('chg.intro')} headingLevel={2} headerAction={tools}>
      {changes.status === 'error' ? (
        <Failed part="changes" actions={actions} />
      ) : changes.status !== 'ready' ? (
        <Reading />
      ) : changes.value.requests.length + changes.value.orders.length === 0 ? (
        <p className="fw-st-hint">{tv('chg.none')}</p>
      ) : (
        <div className="fw-st-stack">
          <SummaryTable
            label={tv('chg.title')}
            stackOnPhone
            columns={[tv('col.change'), tv('col.kind'), tv('col.status'), tv('col.raisedBy'), tv('col.raisedOn')]}
            align={['left', 'left', 'left', 'left', 'right']}
            widths={[undefined, '14%', '16%', '20%', '14%']}
            rows={changeLines(changes.value, prefix, model.me).map((line) => ({
              id: line.id,
              cells: [
                <span key="change">
                  <Link className="fw-chg-link fw-chg-code" href={line.href}>
                    {line.number ?? tc('row.floorNoNumber')}
                  </Link>
                  <span className="nds-summary-sub">{line.title}</span>
                </span>,
                <KindTag key="kind" kind={line.kind} />,
                <Pill key="status" tone={line.status.tone}>
                  {tc(line.status.key)}
                </Pill>,
                say(line.raisedBy),
                day(line.at),
              ],
            }))}
          />
          {!changes.value.complete && <p className="fw-st-hint">{tv('chg.more')}</p>}
        </div>
      )}
    </Card>
  )
}

/** Orders on older revisions (PRD-194): hidden when there are none. */
function DriftCard({ model, prefix, actions }: { model: VersionsModel; prefix: string; actions?: VersionsActions }) {
  const tv = useT(VERSIONS_NS)
  const locale = useLocale() as 'it' | 'en'
  const drift = model.drift
  if (drift.status === 'idle') return null
  if (drift.status === 'ready' && drift.value.rows.length === 0 && drift.value.held.length === 0) return null
  const hrefOf = (row: DriftRow) => `${prefix}/${row.kind === 'QUOTE' ? 'sales/quotes' : row.kind === 'ORDER' ? 'sales/orders' : 'production/work-orders'}/${encodeURIComponent(row.documentId)}`
  const costCell = (row: DriftRow) => {
    if (row.cost === undefined) return <span className="fw-st-hint">—</span>
    if (row.cost === null || row.cost.unitCostChange === null || row.cost.unitCostChange === undefined) return <span className="fw-st-hint">{tv('drift.noCost')}</span>
    const change = Number(row.cost.unitCostChange)
    const text = moneyOf(row.cost.currency, locale)(row.cost.unitCostChange)
    return (
      <span>
        {change > 0 ? `+${text}` : text}
        <span className="nds-summary-sub">{row.cost.complete ? tv('drift.perGarment') : tv('drift.incomplete')}</span>
      </span>
    )
  }
  return (
    <Card header={tv('drift.title')} description={tv('drift.intro')} headingLevel={2}>
      <DriftTable
        drift={drift.status === 'ready' ? { value: drift.value, problem: null } : drift.status === 'error' ? { value: null, problem: drift.problem } : { value: null, problem: null }}
        onRetry={() => actions?.onRetry?.('drift')}
        hrefOf={hrefOf}
        extra={model.can.cost ? { label: tv('drift.cost'), cell: costCell } : undefined}
      />
      {!model.can.cost && <p className="fw-st-hint">{tv('drift.costNotInRole')}</p>}
    </Card>
  )
}
