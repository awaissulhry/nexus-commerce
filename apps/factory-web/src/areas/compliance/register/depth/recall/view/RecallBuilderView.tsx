'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Lock, Megaphone, Siren, X } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Builder } from '@nexus/ui/patterns'
import { TraceTree, type TraceNode } from '@nexus/ui/patterns/trace-tree/index'
import { Button, Checkbox, Input, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import { Textarea, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../../lib/i18n/provider'
import { NoticeBanner, RecordFrame, RecordProblem, RecordSkeleton } from '../../../../../quality/_shared/parts'
import type { Notice, Read } from '../../../../../quality/_shared/model'
import type { PickerReason } from '../../../../../_shared/reasons/api'
import { RegisterMessages } from '../../../view/parts'
import type { HoldsAnswer, ProgressRow, PublicWords, RecallDetail } from '../../api'
import {
  blankWords,
  percentBack,
  pickLanguage,
  progressCounts,
  progressFormOf,
  publicNoticeChanged,
  publicNoticeProblems,
  readerChain,
  recallHeld,
  recallPrimary,
  scopeBody,
  scopeFormOf,
  scopeProblems,
  splitCodes,
  type DepthCan,
  type ProgressForm,
  type RecallAction,
  type ScopeForm,
} from '../../model'
import { DistributorsSection } from '../../view/ActionsDepth'
import { DepthDialogs } from '../../view/DepthDialogs'
import { DepthDialog, Law, NS, RecallStatus } from '../../view/parts'
import type { DepthActions, DepthModel } from '../../view/types'

/**
 * SCR-328 — Recall or withdrawal (design compliance.register › pop:rg-recall, W2b; PRD-388; Reg. (EU) 2016/425 art. 8(8),
 * Reg. (EU) 2023/988 art. 35-36; B-W2b-271 on B-W2b-260's API): the DS Builder in page mode, one section per step — 1 Scope
 * (what it calls back, from the entry's trace: the TraceTree of work orders and the customers who got garments), 2 Block
 * stock (holds on what is still here), 3 Customers and notices (a notice per recipient, reviewed one by one, one send with
 * a fresh code), 4 Returns, remedy, disposal (per customer and shipment, a ProgressBar of what came back), the public
 * safety notice (words per language, published with a fresh code: first on the public DoC page), and Review → "Start
 * recall of 126 garments". A started recall only widens; it closes with how it ended. Fetches nothing: RecallPage.tsx.
 */

export type RecallDialog = 'hold' | 'close' | 'cancel' | 'withdrawNotice'

export interface RecallPageModel {
  readonly prefix: string
  readonly can: DepthCan
  readonly recall: Read<RecallDetail>
  /** The entry's depth parts (the distributors' log and its dialogs, the step-up). */
  readonly depth: DepthModel | null
  readonly reasons: Read<readonly PickerReason[]> | null
  readonly dialog: RecallDialog | null
  readonly busy: boolean
  readonly problem: { key: string; lines: readonly string[] } | null
  readonly notice: Notice | null
  readonly holdResult: Pick<HoldsAnswer, 'placed' | 'alreadyHeld'> | null
  readonly today: string
}

export interface RecallPageActions {
  onRetry?(): void
  onDialog?(dialog: RecallDialog | null): void
  onScope?(body: { wholeStyle?: boolean; batchNumbers?: string[]; serials?: string[] }): void
  onHold?(input: { reasonCode: string; reasonNote: string }): void
  onPublicWords?(words: Readonly<Record<string, PublicWords>>): void
  onPublish?(words: Readonly<Record<string, PublicWords>> | null): void
  onWithdrawNotice?(): void
  onProgress?(row: ProgressRow, counts: { unitsReturned: number; unitsRepaired: number; unitsDestroyed: number }): void
  onStart?(): void
  onClose?(note: string): void
  onCancel?(reason: string): void
  onDismissNotice?(): void
  depth?: DepthActions
  depthNotice?: Notice | null
  onDismissDepthNotice?(): void
}

export function RecallBuilderView({ model, actions }: { model: RecallPageModel; actions?: RecallPageActions }) {
  return (
    <RegisterMessages>
      <RecallBuilder model={model} actions={actions} />
    </RegisterMessages>
  )
}

function RecallBuilder({ model, actions }: { model: RecallPageModel; actions?: RecallPageActions }) {
  const d = useT(NS)
  const s = useScopedT(NS)
  const locale = useLocale()
  const read = model.recall
  if (read.problem && !read.value)
    return (
      <RecordProblem
        problem={read.problem}
        back={
          <Link className="fw-q-link" href={`${model.prefix}/compliance/register`}>
            {d('builder.backRegister')}
          </Link>
        }
        onRetry={() => actions?.onRetry?.()}
      />
    )
  if (!read.value) return <RecordSkeleton />
  const recall = read.value
  const held = (action: RecallAction) => {
    const key = recallHeld(action, recall, model.can)
    return key ? d(key) : null
  }
  const primary = recallPrimary(recall)
  const primaryHeld = primary ? held(primary.action) ?? (model.busy ? d('dialog.saving') : null) : null
  const onPrimary = () => (primary?.action === 'start' ? actions?.onStart?.() : actions?.onDialog?.('close'))
  const back = `${model.prefix}/compliance/register/${encodeURIComponent(recall.entryId)}?tab=actions`
  const primaryButton = primary ? (
    <Button size="sm" variant="primary" heldReason={primaryHeld} onClick={onPrimary}>
      <Siren size={14} aria-hidden /> {d(primary.key, { count: primary.count })}
    </Button>
  ) : null

  const sections = [
    { id: 'scope', label: d('builder.step.scope'), title: d('builder.step.scope'), content: <ScopeStep model={model} recall={recall} actions={actions} held={held} /> },
    { id: 'holds', label: d('builder.step.holds'), title: d('builder.step.holds'), content: <HoldsStep model={model} recall={recall} actions={actions} held={held} />, badge: recall.holds.length > 0 ? String(recall.holds.length) : undefined },
    {
      id: 'customers',
      label: d('builder.step.customers'),
      title: d('builder.step.customers'),
      content: model.depth ? <DistributorsSection model={model.depth} actions={actions?.depth} /> : <Skeleton height={60} />,
      badge: `${recall.distributors.told}/${recall.distributors.of}`,
    },
    { id: 'returns', label: d('builder.step.returns'), title: d('builder.step.returns'), content: <ReturnsStep recall={recall} actions={actions} held={held} busy={model.busy} /> },
    { id: 'notice', label: d('builder.step.notice'), title: d('builder.step.notice'), content: <PublicStep model={model} recall={recall} actions={actions} held={held} /> },
    { id: 'review', label: d('builder.step.review'), title: d('builder.step.review'), content: <ReviewStep model={model} recall={recall} actions={actions} held={held} primary={primaryButton} /> },
  ]

  return (
    <RecordFrame
      back={{ href: back, label: d('builder.back', { reference: recall.entry.reference }) }}
      title={
        <>
          <span className="fw-q-code">{recall.number}</span> · {d(`recallKind.${recall.kind}`)} · {recall.style.code}
        </>
      }
      meta={
        <span className="fw-q-cell-row">
          <span>{recall.style.name}</span>
          {recall.startedAt && <span className="fw-q-hint">{d('recalls.startedOn', { date: formatDate(recall.startedAt, { locale }) })}</span>}
        </span>
      }
      status={<RecallStatus recall={recall} />}
      actions={primaryButton}
      tabs={[]}
      active=""
      tabHref={() => back}
    >
      <NoticeBanner notice={model.notice} namespace={NS} onDismiss={actions?.onDismissNotice} />
      <NoticeBanner notice={actions?.depthNotice} namespace={NS} onDismiss={actions?.onDismissDepthNotice} />
      {model.problem && !model.dialog && (
        <Banner tone="danger" title={s(model.problem.key)}>
          {model.problem.lines.length > 0 && (
            <ul className="fw-q-lines">
              {model.problem.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      {read.problem && <Banner tone="warning" title={d('builder.reloadFailed')} />}
      {recall.status === 'CLOSED' && <Banner tone="success" title={d('builder.closed', { date: recall.closedAt ? formatDateTime(recall.closedAt, { locale }) : '—' })}>{recall.closeNote}</Banner>}
      {recall.status === 'CANCELLED' && <Banner tone="neutral" title={d('builder.cancelled')}>{recall.cancelReason}</Banner>}
      <Builder mode="page" sections={sections} navLabel={d('builder.steps')} />
      <RecallDialogs model={model} recall={recall} actions={actions} held={held} />
      {model.depth && <DepthDialogs model={model.depth} actions={actions?.depth} />}
    </RecordFrame>
  )
}

type Held = (action: RecallAction) => string | null

function ScopeStep({ model, recall, actions, held }: { model: RecallPageModel; recall: RecallDetail; actions?: RecallPageActions; held: Held }) {
  const d = useT(NS)
  const s = useScopedT(NS)
  const ds = useDsWords()
  const [form, setForm] = useState<ScopeForm>(() => scopeFormOf(recall))
  const [batches, setBatches] = useState(recall.scope.batchNumbers.join(', '))
  const [serials, setSerials] = useState(recall.serials.join(', '))
  useEffect(() => {
    setForm(scopeFormOf(recall))
    setBatches(recall.scope.batchNumbers.join(', '))
    setSerials(recall.serials.join(', '))
  }, [recall])
  const typed: ScopeForm = { wholeStyle: form.wholeStyle, batchNumbers: splitCodes(batches), serials: splitCodes(serials) }
  const body = scopeBody(typed, recall)
  const changed = Object.keys(body).length > 0 && (recall.status !== 'DRAFT' || JSON.stringify(body) !== JSON.stringify({ wholeStyle: recall.scope.wholeStyle, batchNumbers: recall.scope.batchNumbers, serials: recall.serials }))
  const problems = scopeProblems(typed, recall)
  const saveHeld = held('scope') ?? (!changed ? d('scope.nothingChanged') : problems[0] ? s(problems[0]) : model.busy ? d('dialog.saving') : null)
  const c = recall.trace.counts
  const roots: TraceNode[] = useMemo(
    () => [
      {
        id: 'made',
        label: recall.style.code,
        kind: d('tree.style'),
        meta: d('tree.garments', { count: c.concerned }),
        children: [
          ...recall.workOrders.map((order) => ({
            id: `wo-${order.id}`,
            label: order.number,
            kind: d('tree.workOrder'),
            href: `${model.prefix}/production/work-orders/${encodeURIComponent(order.id)}`,
            meta: order.batchNumber ? d('tree.batch', { batch: order.batchNumber }) : undefined,
          })),
          // The batches the scope names by number (their work orders are found by the trace, not named).
          ...recall.scope.batchNumbers
            .filter((batch) => !recall.workOrders.some((order) => order.batchNumber === batch))
            .map((batch) => ({ id: `b-${batch}`, label: batch, kind: d('tree.batchKind') })),
          ...(recall.serials.length > 0 ? [{ id: 'serials', label: d('tree.serials', { count: recall.serials.length }), kind: d('tree.serialKind') }] : []),
        ],
      },
      {
        id: 'customers',
        label: d('tree.customers'),
        meta: d('tree.garments', { count: c.shipped }),
        children: recall.trace.customers.map((customer) => ({
          id: `c-${customer.partyId}`,
          label: customer.name,
          kind: d('tree.customer'),
          meta: d('tree.garments', { count: customer.garments }),
          children: customer.shipmentNumbers.map((number) => ({ id: `s-${customer.partyId}-${number}`, label: number, kind: d('tree.shipment') })),
        })),
      },
    ],
    [recall, c.concerned, c.shipped, d, model.prefix],
  )
  return (
    <div className="fw-q-stack">
      <p className="fw-q-hint">{recall.status === 'DRAFT' ? d('scope.subDraft') : d('scope.subStarted')}</p>
      <TraceTree
        label={d('tree.label', { number: recall.number })}
        roots={roots}
        labels={ds.traceTree}
        levels={[
          { id: 'wo', label: d('tree.levelWorkOrders', { count: c.workOrders }) },
          { id: 'garments', label: d('tree.levelGarments', { count: c.concerned }) },
          { id: 'shipped', label: d('tree.levelShipped', { count: c.shipped }) },
          { id: 'customers', label: d('tree.levelCustomers', { count: c.customers }) },
        ]}
        before={
          recall.trace.problems.length > 0 ? (
            <Banner tone="warning" title={d('scope.traceProblems', { count: recall.trace.problems.length })}>
              <ul className="fw-q-lines">
                {recall.trace.problems.map((problem) => (
                  <li key={`${problem.path}-${problem.code}`}>{problem.message}</li>
                ))}
              </ul>
            </Banner>
          ) : undefined
        }
        empty={<p className="fw-q-hint">{d('scope.nothingTraced')}</p>}
      />
      <div className="fw-rgd-form">
        <Checkbox checked={form.wholeStyle} disabled={recall.status === 'ACTIVE' && recall.scope.wholeStyle} onChange={(event) => setForm((current) => ({ ...current, wholeStyle: event.target.checked }))} label={d('scope.wholeStyle', { style: recall.style.code })} />
        <div className="fw-q-form-two">
          <Field label={d('scope.batches')} hint={recall.status === 'ACTIVE' ? d('scope.widenHint') : d('scope.codesHint')}>
            <Input value={batches} onChange={(event) => setBatches(event.target.value)} />
          </Field>
          <Field label={d('scope.serials')} hint={recall.status === 'ACTIVE' ? d('scope.widenHint') : d('scope.codesHint')}>
            <Input value={serials} onChange={(event) => setSerials(event.target.value)} />
          </Field>
        </div>
        <p className="fw-q-hint">{d('scope.alsoNamed', { workOrders: recall.workOrders.length, shipments: recall.shipments.length })}</p>
        <div>
          <Button size="sm" heldReason={saveHeld} onClick={() => actions?.onScope?.(body)}>
            {recall.status === 'ACTIVE' ? d('scope.widen') : d('scope.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function HoldsStep({ model, recall, actions, held }: { model: RecallPageModel; recall: RecallDetail; actions?: RecallPageActions; held: Held }) {
  const d = useT(NS)
  const h = recall.holdable
  return (
    <div className="fw-q-stack">
      <p className="fw-q-hint">{d('holds.sub')}</p>
      <KeyValue
        items={[
          { label: d('holds.workOrders'), value: String(h.workOrders) },
          { label: d('holds.serials'), value: String(h.serials) },
          { label: d('holds.shipments'), value: String(h.shipments) },
        ]}
        labelCase="sentence"
        columns={3}
      />
      {model.holdResult && (
        <Banner tone="success" title={d('holds.placed', { count: model.holdResult.placed.length, already: model.holdResult.alreadyHeld })} />
      )}
      {recall.holds.length > 0 ? (
        <SummaryTable
          label={d('holds.table')}
          columns={[d('holds.col.hold'), d('holds.col.what'), d('holds.col.count'), d('holds.col.status')]}
          rows={recall.holds.map((hold) => ({
            id: hold.id,
            cells: [<span key="n" className="fw-q-code">{hold.number ?? '—'}</span>, d(`holds.subject.${['WorkOrder', 'GarmentSerial', 'Shipment', 'Lot'].includes(hold.subjectType) ? hold.subjectType : 'OTHER'}`), hold.subjects, d(`holds.status.${hold.status === 'ACTIVE' || hold.status === 'RELEASED' ? hold.status : 'OTHER'}`)],
          }))}
          stackOnPhone
        />
      ) : (
        <p className="fw-q-hint">{d('holds.none')}</p>
      )}
      <div>
        <Button size="sm" heldReason={held('hold')} onClick={() => actions?.onDialog?.('hold')}>
          <Lock size={13} aria-hidden /> {d('holds.action')}
        </Button>
      </div>
    </div>
  )
}

function ReturnsStep({ recall, actions, held, busy }: { recall: RecallDetail; actions?: RecallPageActions; held: Held; busy: boolean }) {
  const d = useT(NS)
  const p = recall.progress
  if (recall.status === 'DRAFT') return <p className="fw-q-hint">{d('progress.afterStart')}</p>
  return (
    <div className="fw-q-stack">
      <div className="fw-rgd-progress">
        <ProgressBar ariaLabel={d('recalls.progressLabel', { number: recall.number })} value={percentBack(p)} showValue />
        <p className="fw-rgd-counts">{d('recalls.counts', { sent: p.unitsSent, returned: p.unitsReturned, repaired: p.unitsRepaired, destroyed: p.unitsDestroyed, out: p.unitsStillOut })}</p>
      </div>
      {recall.progressRows.length === 0 ? (
        <EmptyState title={d('progress.noRows')} description={d('progress.noRowsBody')} />
      ) : (
        <ProgressTable recall={recall} actions={actions} held={held} busy={busy} />
      )}
    </div>
  )
}

/** The progress per customer and shipment: returned, remedied (repaired), disposed (destroyed) typed per row, saved per row. */
function ProgressTable({ recall, actions, held, busy }: { recall: RecallDetail; actions?: RecallPageActions; held: Held; busy: boolean }) {
  const d = useT(NS)
  const s = useScopedT(NS)
  const [forms, setForms] = useState<Record<string, ProgressForm>>(() => Object.fromEntries(recall.progressRows.map((row) => [row.id, progressFormOf(row)])))
  useEffect(() => setForms(Object.fromEntries(recall.progressRows.map((row) => [row.id, progressFormOf(row)]))), [recall.progressRows])
  const rows = recall.progressRows.map((row) => {
    const form = forms[row.id] ?? progressFormOf(row)
    const result = progressCounts(form, row.unitsSent)
    const changed = form.returned !== String(row.unitsReturned) || form.repaired !== String(row.unitsRepaired) || form.destroyed !== String(row.unitsDestroyed)
    const rowHeld = held('progress') ?? ('problem' in result ? s(result.problem) : !changed ? d('progress.nothingChanged') : busy ? d('dialog.saving') : null)
    const input = (field: keyof ProgressForm, label: string): ReactNode => (
      <Input
        key={field}
        size="sm"
        inputMode="numeric"
        className="fw-rgd-num"
        value={form[field]}
        aria-label={`${label} · ${row.party.name}${row.shipment ? ` · ${row.shipment.number}` : ''}`}
        onChange={(event) => setForms((current) => ({ ...current, [row.id]: { ...form, [field]: event.target.value } }))}
        disabled={recall.status !== 'ACTIVE'}
      />
    )
    return {
      id: row.id,
      cells: [
        <span key="p" className="fw-q-cell">
          <span>{row.party.name}</span>
          <span className="fw-q-hint">{row.shipment ? row.shipment.number : d('progress.wholeCustomer')}</span>
        </span>,
        row.unitsSent,
        input('returned', d('progress.returned')),
        input('repaired', d('progress.repaired')),
        input('destroyed', d('progress.destroyed')),
        'stillOut' in result ? result.stillOut : row.unitsStillOut,
        <Button key="b" size="sm" heldReason={rowHeld} onClick={() => 'counts' in result && actions?.onProgress?.(row, result.counts)}>
          {d('progress.save')}
        </Button>,
      ] as ReactNode[],
    }
  })
  return (
    <SummaryTable
      label={d('progress.table')}
      columns={[d('progress.customer'), d('progress.sent'), d('progress.returned'), d('progress.repaired'), d('progress.destroyed'), d('progress.stillOut'), d('col.actions')]}
      rows={rows}
      align={[undefined, 'right', 'right', 'right', 'right', 'right', 'right']}
      widths={['24%', '10%', '13%', '13%', '13%', '10%', '17%']}
      density="roomy"
      stackOnPhone
    />
  )
}

function PublicStep({ model, recall, actions, held }: { model: RecallPageModel; recall: RecallDetail; actions?: RecallPageActions; held: Held }) {
  const d = useT(NS)
  const s = useScopedT(NS)
  const locale = useLocale()
  const published = !!recall.notice.publishedAt
  const [words, setWords] = useState<Record<string, PublicWords>>(() => ({ ...(recall.publicNotice ?? {}) }))
  const [newLanguage, setNewLanguage] = useState('')
  useEffect(() => setWords({ ...(recall.publicNotice ?? {}) }), [recall.publicNotice])
  const languages = Object.keys(words)
  const [language, setLanguage] = useState<string | null>(() => pickLanguage(languages, readerChain(locale)))
  const shown = language && languages.includes(language) ? language : pickLanguage(languages, readerChain(locale))
  const changed = publicNoticeChanged(recall.publicNotice, words)
  const problems = publicNoticeProblems(words)
  const frozen = published && !!shown && !!recall.publicNotice?.[shown]
  const editHeld = held('scope') ?? (!changed ? d('public.nothingChanged') : problems[0] ? s(problems[0]) : null)
  const publishHeld = held('publish') ?? (changed ? d('public.saveFirst') : problems[0] ? s(problems[0]) : null)
  const set = (field: keyof PublicWords, value: string) => shown && setWords((current) => ({ ...current, [shown]: { ...(current[shown] ?? blankWords()), [field]: value } }))
  const text = shown ? (words[shown] ?? blankWords()) : null
  return (
    <div className="fw-q-stack">
      <Law law={recall.law.publicNotice} plain={d('law.publicNotice')} />
      <p className="fw-q-hint">{d('public.sub')}</p>
      {published ? (
        <Banner tone={recall.notice.live ? 'danger' : 'neutral'} title={recall.notice.live ? d('public.live', { date: formatDate(recall.notice.publishedAt!, { locale }) }) : d('public.down', { date: recall.notice.withdrawnAt ? formatDate(recall.notice.withdrawnAt, { locale }) : '—' })}>
          {recall.notice.publishedBy ? d('public.by', { name: recall.notice.publishedBy.name }) : null}
        </Banner>
      ) : null}
      <div className="fw-q-cell-row">
        {languages.length > 0 && <SegmentedControl ariaLabel={d('public.language')} size="sm" options={languages.map((code) => ({ value: code, label: code.toUpperCase() }))} value={shown ?? ''} onChange={setLanguage} />}
        <Input size="sm" value={newLanguage} onChange={(event) => setNewLanguage(event.target.value.toLowerCase())} maxLength={3} aria-label={d('notice.addLanguage')} placeholder={d('notice.addLanguagePlaceholder')} />
        <Button
          size="sm"
          heldReason={held('scope') ?? (!/^[a-z]{2,3}$/.test(newLanguage) ? d('notice.languageCode') : words[newLanguage] ? d('notice.languageThere') : null)}
          onClick={() => {
            setWords((current) => ({ ...current, [newLanguage]: blankWords() }))
            setLanguage(newLanguage)
            setNewLanguage('')
          }}
        >
          {d('notice.addLanguage')}
        </Button>
        {!published && shown && languages.length > 1 && (
          <Button
            size="sm"
            variant="quiet"
            onClick={() =>
              setWords((current) => {
                const next = { ...current }
                delete next[shown]
                return next
              })
            }
          >
            <X size={13} aria-hidden /> {d('notice.removeLanguage', { language: shown.toUpperCase() })}
          </Button>
        )}
      </div>
      {text && shown ? (
        <div className="fw-rgd-form">
          {frozen && <p className="fw-q-hint">{d('public.frozen')}</p>}
          <Field label={d('public.title')} required>
            <Input value={text.title} onChange={(event) => set('title', event.target.value)} maxLength={200} disabled={frozen} />
          </Field>
          <div className="fw-q-form-two">
            <Field label={d('public.wrong')} required hint={d('public.problemHint')}>
              <Textarea value={text.problem} onChange={(event) => set('problem', event.target.value)} rows={4} limit={2000} disabled={frozen} />
            </Field>
            <Field label={d('public.action')} required hint={d('public.actionHint')}>
              <Textarea value={text.action} onChange={(event) => set('action', event.target.value)} rows={4} limit={2000} disabled={frozen} />
            </Field>
          </div>
          <Field label={d('public.contact')} required hint={d('public.contactHint')}>
            <Textarea value={text.contact} onChange={(event) => set('contact', event.target.value)} rows={2} limit={1000} disabled={frozen} />
          </Field>
        </div>
      ) : (
        <p className="fw-q-hint">{d('public.none')}</p>
      )}
      <div className="fw-q-cell-row">
        <Button size="sm" heldReason={editHeld ?? (model.busy ? d('dialog.saving') : null)} onClick={() => actions?.onPublicWords?.(words)}>
          {published ? d('public.addLanguages') : d('public.save')}
        </Button>
        {!published && (
          <Button size="sm" variant="danger" heldReason={publishHeld ?? (model.busy ? d('dialog.saving') : null)} onClick={() => actions?.onPublish?.(null)}>
            <Megaphone size={13} aria-hidden /> {d('public.publish')}
          </Button>
        )}
        {published && recall.notice.live && (
          <Button size="sm" heldReason={held('withdrawNotice')} onClick={() => actions?.onDialog?.('withdrawNotice')}>
            {d('public.withdraw')}
          </Button>
        )}
      </div>
    </div>
  )
}

function ReviewStep({ model, recall, actions, held, primary }: { model: RecallPageModel; recall: RecallDetail; actions?: RecallPageActions; held: Held; primary: ReactNode }) {
  const d = useT(NS)
  const c = recall.trace.counts
  const cancelHeld = held('cancel')
  return (
    <div className="fw-q-stack">
      <KeyValue
        items={[
          { label: d('review.kind'), value: d(`recallKind.${recall.kind}`) },
          { label: d('review.scope'), value: recall.scope.wholeStyle ? d('recalls.scopeStyle', { style: recall.style.code }) : d('recalls.scopeParts', { batches: recall.scope.batchNumbers.length, serials: recall.scope.serialCount, workOrders: recall.scope.workOrderCount, shipments: recall.scope.shipmentCount }) },
          { label: d('review.garments'), value: d('tree.garments', { count: c.concerned }) },
          { label: d('review.shipped'), value: d('review.shippedValue', { count: c.shipped, customers: c.customers }) },
          { label: d('review.holds'), value: recall.holds.length > 0 ? d('review.holdsValue', { count: recall.holds.length }) : d('holds.none') },
          { label: d('review.told'), value: d('told.count', { told: recall.distributors.told, of: recall.distributors.of }) },
          { label: d('review.notice'), value: recall.notice.live ? d('review.noticeLive') : recall.notice.publishedAt ? d('review.noticeDown') : d('review.noticeNot') },
        ]}
        labelCase="sentence"
        columns={2}
      />
      <Law law={recall.law.correctiveAction} plain={d('law.correctiveAction')} />
      {recall.status === 'DRAFT' && <p className="fw-q-hint">{d('review.startSays', { count: c.concerned })}</p>}
      <div className="fw-q-cell-row">
        {primary}
        {recall.status === 'DRAFT' && (
          <Button size="sm" variant="quiet" heldReason={cancelHeld ?? (model.busy ? d('dialog.saving') : null)} onClick={() => actions?.onDialog?.('cancel')}>
            {d('review.cancel')}
          </Button>
        )}
      </div>
    </div>
  )
}

function RecallDialogs({ model, recall, actions, held }: { model: RecallPageModel; recall: RecallDetail; actions?: RecallPageActions; held: Held }) {
  const d = useT(NS)
  const locale = useLocale()
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => {
    setText('')
    setReason(model.reasons?.value?.[0]?.code ?? '')
  }, [model.dialog, model.reasons])
  const close = () => actions?.onDialog?.(null)
  const reasons = model.reasons?.value ?? []
  if (model.dialog === 'hold')
    return (
      <DepthDialog
        open
        title={d('holds.dialogTitle', { number: recall.number })}
        sub={d('holds.dialogSub', { workOrders: recall.holdable.workOrders, serials: recall.holdable.serials, shipments: recall.holdable.shipments })}
        confirm={d('holds.confirm')}
        held={held('hold') ?? (!reason ? d('holds.needsReason') : null)}
        busy={model.busy}
        problem={model.problem}
        onConfirm={() => actions?.onHold?.({ reasonCode: reason, reasonNote: text.trim() })}
        onClose={close}
      >
        <Field label={d('holds.reason')} required hint={model.reasons?.problem ? d('holds.reasonsFailed') : undefined}>
          <Select value={reason} onChange={(event) => setReason(event.target.value)}>
            <option value="">{d('holds.chooseReason')}</option>
            {reasons.map((item) => (
              <option key={item.id} value={item.code}>
                {locale === 'it' ? item.labelIt : item.labelEn}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={d('holds.note')}>
          <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} limit={500} />
        </Field>
      </DepthDialog>
    )
  if (model.dialog === 'close')
    return (
      <DepthDialog
        open
        title={d('builder.closeTitle', { number: recall.number })}
        sub={d('builder.closeSub', { count: recall.progress.unitsStillOut })}
        confirm={d('builder.closeConfirm')}
        held={held('close') ?? (!text.trim() ? d('builder.needsCloseNote') : null)}
        busy={model.busy}
        problem={model.problem}
        onConfirm={() => actions?.onClose?.(text.trim())}
        onClose={close}
      >
        {recall.progress.unitsStillOut > 0 && <Banner tone="warning" title={d('builder.stillOut', { count: recall.progress.unitsStillOut })} />}
        <Field label={d('builder.closeNote')} required hint={d('builder.closeNoteHint')}>
          <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} limit={2000} />
        </Field>
      </DepthDialog>
    )
  if (model.dialog === 'cancel')
    return (
      <DepthDialog
        open
        tone="danger"
        title={d('builder.cancelTitle', { number: recall.number })}
        sub={d('builder.cancelSub')}
        confirm={d('builder.cancelConfirm')}
        held={held('cancel') ?? (!text.trim() ? d('dialog.needsReason') : null)}
        busy={model.busy}
        problem={model.problem}
        onConfirm={() => actions?.onCancel?.(text.trim())}
        onClose={close}
      >
        <Field label={d('dialog.reason')} required>
          <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} limit={500} />
        </Field>
      </DepthDialog>
    )
  if (model.dialog === 'withdrawNotice')
    return (
      <DepthDialog open title={d('public.withdrawTitle')} sub={d('public.withdrawSub')} confirm={d('public.withdraw')} held={held('withdrawNotice')} busy={model.busy} problem={model.problem} onConfirm={() => actions?.onWithdrawNotice?.()} onClose={close} />
    )
  return null
}
