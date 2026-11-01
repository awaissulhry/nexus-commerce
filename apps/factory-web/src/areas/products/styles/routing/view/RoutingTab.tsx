'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, CircleAlert, CircleX, Flag, Plus, Search, Trash2, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, MetricStrip } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { RoutingStep, RoutingView, StyleView } from '../../api'
import { costCellOf, decimalInput, editableRevision, editText, issueWords, minutesText, moneyText, revisionInView } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record/record-model'
import { subcontractDraftOf, subcontractPatch, subcontractProblems, workshopName, workshopsFor, type SubcontractDraft } from '../subcontract-model'

/**
 * SCR-043 Operations (routing) of the revision in view: the minutes strip (standard minutes per garment, by department
 * — a department tile filters the table —, operations, scan points, and the labour cost with the cost grain), the
 * steps in order (minutes typed here, "Library: x · Use library value" when they differ, scanned or not, the final
 * operation where the batch is given, instructions), Add operations from the library (`n`, several at once, in the
 * order picked), Alt+↑ / Alt+↓ to move a step. A released revision is frozen.
 */
export function RoutingTab({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const locale = useLocale()
  const revision = revisionInView(style.revisions, model.revisionId)
  const editable = editableRevision(style, revision) && model.can.routingManage
  const heldWhy = !model.can.routingManage ? t('held.noManage') : !editableRevision(style, revision) ? t('bom.held.frozen') : model.busy ? t('held.busy') : null
  const [kind, setKind] = useState<string | null>(null)
  const [instructions, setInstructions] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'n' && editable) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'addOperations' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!revision) return <EmptyState title={t('bom.noRevision.title')} description={t('bom.noRevision.body')} />
  if (model.routing.status === 'loading' || model.routing.status === 'idle')
    return (
      <Card padded aria-busy="true">
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('routing.loading')}
        </p>
      </Card>
    )
  if (model.routing.status === 'error')
    return <Banner tone="danger" title={t('routing.failed')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('common.retry')}</Button>}>{t(model.routing.problem)}</Banner>
  const routing = model.routing.value
  const sheet = model.cost.status === 'ready' ? model.cost.value : null
  const cell = sheet ? costCellOf(sheet, model.costCell ?? (sheet.colourways[0] && sheet.style.baseSize ? { colourwayId: sheet.colourways[0].id, size: sheet.style.baseSize } : null)) : null
  const labour = model.grains.cost && cell?.labour.complete ? moneyText(cell.labour.amount, sheet!.currency, locale) : null
  const shown = kind ? routing.steps.filter((step) => step.workCentreKind === kind) : routing.steps
  const issues = revision.status === 'DRAFT' ? routing.issues : []

  return (
    <div className="fw-st-stack-lg">
      <MetricStrip
        metrics={[
          { label: t('routing.strip.total'), value: t('routing.minutes', { minutes: minutesText(routing.minutes.perGarment, locale) }), hint: t('routing.strip.totalHint') },
          ...routing.minutes.byKind.map((entry) => ({
            label: t(`department.${entry.workCentreKind}`),
            value: t('routing.minutes', { minutes: minutesText(entry.minutes, locale) }),
            hint: t('routing.strip.steps', { count: entry.steps }),
            onClick: () => setKind((current) => (current === entry.workCentreKind ? null : entry.workCentreKind)),
            active: kind === entry.workCentreKind,
          })),
          { label: t('routing.strip.scans'), value: String(routing.minutes.scanPoints), hint: t('routing.strip.scansHint', { count: routing.minutes.steps }) },
          { label: t('routing.strip.subcontracted'), value: String(routing.minutes.subcontracted), hint: t('routing.strip.subcontractedHint', { count: routing.minutes.steps }) },
          ...(model.can.costView ? [{ label: t('routing.strip.labour'), value: model.grains.cost ? (labour ?? '—') : t('cost.notInRole'), hint: model.grains.cost ? t('routing.strip.labourHint') : t('cost.notInRoleHint') }] : []),
        ]}
      />

      {issues.length > 0 && (
        <Banner tone="danger" title={t('routing.issuesTitle', { count: issues.length })}>
          <ul className="fw-st-checklist">
            {issues.map((issue, index) => {
              const words = issueWords({ ...issue, lineId: null, size: null, colourwayId: null }, null, routing)
              return (
                <li key={index} className="fw-st-check is-blocked">
                  <CircleX size={14} aria-hidden />
                  <span>{t(words.key, words.params)}</span>
                  <span />
                </li>
              )
            })}
          </ul>
        </Banner>
      )}
      {routing.warnings.length > 0 && (
        <Banner tone="warning" title={t('routing.warningsTitle', { count: routing.warnings.length })}>
          <ul className="fw-st-list">
            {routing.warnings.map((issue, index) => {
              const words = issueWords({ ...issue, lineId: null, size: null, colourwayId: null }, null, routing)
              return <li key={index}>{t(words.key, words.params)}</li>
            })}
          </ul>
        </Banner>
      )}

      <Card
        header={t('routing.title', { count: routing.steps.length })}
        description={kind ? t('routing.filtered', { department: t(`department.${kind}`) }) : t('routing.intro', { revision: routing.revision.revision })}
        headerAction={
          <span className="fw-st-inline">
            {kind && (
              <Button size="sm" variant="quiet" onClick={() => setKind(null)}>
                {t('routing.showAll')}
              </Button>
            )}
            <Button size="sm" variant="primary" heldReason={heldWhy} onClick={() => actions?.onDialog?.({ kind: 'addOperations' })} aria-keyshortcuts="n">
              <Plus size={13} aria-hidden /> {t('routing.add')}
            </Button>
          </span>
        }
      >
        {routing.steps.length === 0 ? (
          <EmptyState
            title={t('routing.empty.title')}
            description={t('routing.empty.body')}
            action={
              <Button size="sm" variant="primary" heldReason={heldWhy} onClick={() => actions?.onDialog?.({ kind: 'addOperations' })}>
                {t('routing.addFirst')}
              </Button>
            }
          />
        ) : (
          <div
            className="fw-st-scroll"
            onKeyDown={(event) => {
              if (!editable || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
              const id = (event.target as HTMLElement).closest<HTMLElement>('[data-step]')?.dataset.step
              if (!id) return
              event.preventDefault()
              actions?.onMoveStep?.(id, event.key === 'ArrowUp' ? -1 : 1)
            }}
          >
            <table className="fw-st-grid fw-st-routing" aria-label={t('routing.title', { count: routing.steps.length })}>
              <thead>
                <tr>
                  <th scope="col">{t('routing.col.seq')}</th>
                  <th scope="col" className="fw-st-grid-first">
                    {t('routing.col.operation')}
                  </th>
                  <th scope="col">{t('routing.col.department')}</th>
                  <th scope="col">{t('routing.col.machine')}</th>
                  <th scope="col">{t('routing.col.minutes')}</th>
                  <th scope="col">{t('routing.col.scanned')}</th>
                  <th scope="col">{t('routing.col.subcontracted')}</th>
                  <th scope="col">{t('routing.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((step) => (
                  <StepRow key={step.id} step={step} routing={routing} editable={editable} heldWhy={heldWhy} actions={actions} prefix={model.prefix} costGrain={model.grains.cost} onInstructions={() => setInstructions(step.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {model.dialog?.kind === 'addOperations' && <AddOperationsDialog routing={routing} model={model} actions={actions} />}
      {model.dialog?.kind === 'removeStep' && <RemoveStepDialog routing={routing} model={model} actions={actions} stepId={model.dialog.stepId} />}
      {model.dialog?.kind === 'subcontract' && routing.steps.some((step) => model.dialog?.kind === 'subcontract' && step.id === model.dialog.stepId) && (
        <SubcontractDialog step={routing.steps.find((step) => model.dialog?.kind === 'subcontract' && step.id === model.dialog.stepId)!} style={style} model={model} editable={editable} heldWhy={heldWhy} actions={actions} />
      )}
      {instructions && <InstructionsDialog step={routing.steps.find((step) => step.id === instructions)!} editable={editable} busy={model.busy} actions={actions} onClose={() => setInstructions(null)} />}
    </div>
  )
}

function StepRow({ step, routing, editable, heldWhy, actions, prefix, costGrain, onInstructions }: { step: RoutingStep; routing: RoutingView; editable: boolean; heldWhy: string | null; actions?: StyleRecordActions; prefix: string; costGrain: boolean; onInstructions: () => void }) {
  const t = useT('products')
  const locale = useLocale()
  const [minutes, setMinutes] = useState(editText(step.standardMinutes, locale))
  const [bad, setBad] = useState(false)
  useEffect(() => setMinutes(editText(step.standardMinutes, locale)), [step.standardMinutes, locale])
  const index = routing.steps.findIndex((entry) => entry.id === step.id)
  const commit = () => {
    const value = decimalInput(minutes, 6)
    if (value === undefined || value === null || Number(value) <= 0) {
      setBad(true)
      return
    }
    setBad(false)
    if (value !== decimalInput(step.standardMinutes, 6)) void actions?.onStep?.(step.id, { standardMinutes: value })
  }
  return (
    <tr data-step={step.id}>
      <td>{step.seq}</td>
      <th scope="row" className="fw-st-grid-first">
        <span className="fw-st-cellstack">
          <span className="fw-st-inline">
            {/* The operation record (Products › Operations, SCR-049). */}
            <Link className="fw-st-link" href={`${prefix}/products/operations/${step.operation.id}`}>
              <b>{step.code}</b>
            </Link>{' '}
            {step.name}
            {step.final && (
              <Tag tone="info">
                <Flag size={11} aria-hidden /> {t('routing.final')}
              </Tag>
            )}
            {step.operation.status === 'ARCHIVED' && <Tag tone="warning">{t('routing.archivedOp')}</Tag>}
          </span>
          {step.instructions ? (
            <button type="button" className="fw-st-linkbtn fw-st-hint" onClick={onInstructions}>
              {step.instructions}
            </button>
          ) : (
            editable && (
              <button type="button" className="fw-st-linkbtn fw-st-hint" onClick={onInstructions}>
                {t('routing.addInstructions')}
              </button>
            )
          )}
        </span>
      </th>
      <td>{t(`department.${step.workCentreKind}`)}</td>
      <td>
        <span className="fw-st-cellstack">
          <span>{step.operation.machineType ?? '—'}</span>
          {step.operation.skill && <span className="fw-st-hint">{step.operation.skill}</span>}
        </span>
      </td>
      <td>
        <span className="fw-st-cellstack">
          {editable ? (
            <Input
              size="sm"
              inputMode="decimal"
              value={minutes}
              aria-label={t('routing.minutesOf', { step: `${step.seq} · ${step.code}` })}
              aria-invalid={bad || undefined}
              onChange={(event) => setMinutes(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commit()
                }
              }}
              suffix="min"
            />
          ) : (
            <span>{t('routing.minutes', { minutes: minutesText(step.standardMinutes, locale) })}</span>
          )}
          {step.differsFromLibrary && (
            <span className="fw-st-hint fw-st-inline">
              {t('routing.library', { minutes: minutesText(step.operation.standardMinutes, locale) })}
              {editable && (
                <Button size="sm" variant="link" onClick={() => void actions?.onStep?.(step.id, { standardMinutes: step.operation.standardMinutes })}>
                  {t('routing.useLibrary')}
                </Button>
              )}
            </span>
          )}
        </span>
      </td>
      <td>
        {editable ? (
          <Toggle size="sm" checked={step.scanRequired} onChange={(next) => void actions?.onStep?.(step.id, { scanRequired: next })} aria-label={t('routing.scannedOf', { step: `${step.seq} · ${step.code}` })} />
        ) : (
          t(step.scanRequired ? 'common.yes' : 'common.no')
        )}
      </td>
      <td>
        <SubcontractCell step={step} costGrain={costGrain} editable={editable} onOpen={() => actions?.onDialog?.({ kind: 'subcontract', stepId: step.id })} />
      </td>
      <td>
        <span className="fw-st-inline fw-st-nowrap">
          <Button size="sm" variant="quiet" heldReason={heldWhy ?? (index === 0 ? t('bom.held.first') : null)} onClick={() => actions?.onMoveStep?.(step.id, -1)} aria-label={t('routing.moveUp', { step: step.seq })} aria-keyshortcuts="Alt+ArrowUp">
            <ArrowUp size={13} aria-hidden />
          </Button>
          <Button size="sm" variant="quiet" heldReason={heldWhy ?? (index === routing.steps.length - 1 ? t('bom.held.last') : null)} onClick={() => actions?.onMoveStep?.(step.id, 1)} aria-label={t('routing.moveDown', { step: step.seq })} aria-keyshortcuts="Alt+ArrowDown">
            <ArrowDown size={13} aria-hidden />
          </Button>
          <Button size="sm" variant="quiet" heldReason={heldWhy} onClick={() => actions?.onDialog?.({ kind: 'removeStep', stepId: step.id })} aria-label={t('routing.removeOne', { step: step.seq })} title={t('routing.removeOne', { step: step.seq })}>
            <Trash2 size={13} aria-hidden />
          </Button>
        </span>
      </td>
    </tr>
  )
}

function AddOperationsDialog({ routing, model, actions }: { routing: RoutingView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const locale = useLocale()
  const [query, setQuery] = useState(model.operationSearch.query)
  const [kind, setKind] = useState<string | null>(model.operationSearch.kind)
  const [picked, setPicked] = useState<string[]>([])
  const search = useRef(actions?.onOperationQuery)
  search.current = actions?.onOperationQuery
  useEffect(() => {
    const timer = setTimeout(() => search.current?.(query, kind), 250)
    return () => clearTimeout(timer)
  }, [query, kind])
  const results = model.operationSearch.results
  const inRouting = new Set(routing.steps.map((step) => step.operation.id))
  const held = picked.length === 0 ? t('routing.addHeld') : model.busy ? t('held.busy') : null
  const run = () => {
    if (held) return
    void actions?.onAddSteps?.(picked).then((ok) => ok && actions?.onDialog?.(null))
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="lg"
      title={t('routing.addTitle')}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('routing.addN', { count: picked.length })}
          </Button>
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            run()
          }
        }}
      >
        <div className="fw-st-form-grid">
          <Field label={t('routing.search')}>
            <Input type="search" autoFocus leadingIcon={<Search size={13} aria-hidden />} value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <Field label={t('routing.col.department')}>
            <Select value={kind ?? ''} onChange={(event) => setKind(event.target.value || null)}>
              <option value="">{t('routing.everyDepartment')}</option>
              {WORK_CENTRE_KINDS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`department.${entry}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {model.operationSearch.problem ? (
          <Banner tone="danger" title={t(model.operationSearch.problem)} />
        ) : results === null ? (
          <p className="fw-st-hint" role="status">
            <Spinner size={14} /> {t('routing.searching')}
          </p>
        ) : results.length === 0 ? (
          <p className="fw-st-hint">{t('routing.noneFound')}</p>
        ) : (
          <ul className="fw-st-pick" aria-label={t('routing.libraryList')}>
            {results.map((operation) => {
              const at = picked.indexOf(operation.id)
              return (
                <li key={operation.id}>
                  <label className="fw-st-pick-row">
                    <Checkbox
                      checked={at >= 0}
                      onChange={() => setPicked((current) => (current.includes(operation.id) ? current.filter((id) => id !== operation.id) : [...current, operation.id]))}
                    />
                    <span className="fw-st-cellstack">
                      <span>
                        <b>{operation.code}</b> {operation.name} {at >= 0 && <Tag tone="info">{t('routing.pickOrder', { n: at + 1 })}</Tag>}
                        {inRouting.has(operation.id) && <Tag tone="neutral">{t('routing.alreadyIn')}</Tag>}
                      </span>
                      <span className="fw-st-hint">
                        {[t(`department.${operation.workCentreKind}`), operation.machineType, operation.skill, t('routing.minutes', { minutes: minutesText(operation.standardMinutes, locale) })].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        <p className="fw-st-hint">{t('routing.addOrder')}</p>
      </div>
    </Modal>
  )
}

function RemoveStepDialog({ routing, model, actions, stepId }: { routing: RoutingView; model: StyleRecordViewModel; actions?: StyleRecordActions; stepId: string }) {
  const t = useT('products')
  const step = routing.steps.find((entry) => entry.id === stepId)
  const run = () => void actions?.onRemoveStep?.(stepId).then((ok) => ok && actions?.onDialog?.(null))
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="sm"
      title={t('routing.removeTitle', { step: step ? `${step.seq} · ${step.code}` : '' })}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={model.busy ? t('held.busy') : null} onClick={run}>
            {t('bom.remove')}
          </Button>
        </>
      }
    >
      <p>{t('routing.removeBody')}</p>
      {step?.final && (
        <p className="fw-st-inline">
          <CircleAlert size={14} aria-hidden /> {t('routing.removeFinal')}
        </p>
      )}
    </Modal>
  )
}

function InstructionsDialog({ step, editable, busy, actions, onClose }: { step: RoutingStep; editable: boolean; busy: boolean; actions?: StyleRecordActions; onClose: () => void }) {
  const t = useT('products')
  const [text, setText] = useState(step.instructions ?? '')
  const run = () => void actions?.onStep?.(step.id, { instructions: text.trim() || null }).then((ok) => ok && onClose())
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('routing.instructionsTitle', { step: `${step.seq} · ${step.code}` })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          {editable && (
            <Button variant="primary" heldReason={busy ? t('held.busy') : (step.instructions ?? '') === text.trim() ? t('sku.gtinSame') : null} onClick={run}>
              {t('identity.save')}
            </Button>
          )}
        </>
      }
    >
      {editable ? (
        <Field label={t('routing.instructions')} hint={t('routing.instructionsHint')}>
          <Textarea value={text} rows={4} maxLength={4000} autoFocus onChange={(event) => setText(event.target.value)} />
        </Field>
      ) : (
        <p>{step.instructions ?? '—'}</p>
      )}
    </Modal>
  )
}

/** The routing grid's Subcontracted cell: the workshop, its fee per piece (the cost grain) and the transit days. */
function SubcontractCell({ step, costGrain, editable, onOpen }: { step: RoutingStep; costGrain: boolean; editable: boolean; onOpen: () => void }) {
  const t = useT('products')
  const locale = useLocale()
  const sub = step.subcontract
  if (!sub)
    return (
      <span className="fw-st-cellstack">
        <span className="fw-st-hint">{t('subcontract.inHouse')}</span>
        {editable && (
          <button type="button" className="fw-st-linkbtn fw-st-hint" onClick={onOpen}>
            {t('subcontract.make')}
          </button>
        )}
      </span>
    )
  const fee = !costGrain ? t('subcontract.feeNotInRole') : sub.pricePerPiece ? t('subcontract.feeIs', { fee: moneyText(sub.pricePerPiece, 'EUR', locale) }) : t('subcontract.feePerOrder')
  return (
    <span className="fw-st-cellstack">
      <span className="fw-st-inline">
        <Truck size={12} aria-hidden /> <b>{sub.supplier.code}</b> {sub.supplier.name}
      </span>
      <span className="fw-st-hint">{[fee, sub.transitDays === null ? t('subcontract.noDays') : t('subcontract.days', { count: sub.transitDays })].join(' · ')}</span>
      <button type="button" className="fw-st-linkbtn fw-st-hint" onClick={onOpen}>
        {t(editable ? 'subcontract.change' : 'subcontract.details')}
      </button>
    </span>
  )
}

/**
 * Subcontract details of one step (design pop:styles.opDrawer "Subcontract details (W2a)"; the W1 routing has no
 * operation drawer, so it is a dialog from the step's Subcontracted cell, like Instructions): done in-house or by a
 * workshop of the style's company (or of every company), its fee per piece — the cost grain only — and the transit days.
 */
function SubcontractDialog({ step, style, model, editable, heldWhy, actions }: { step: RoutingStep; style: StyleView; model: StyleRecordViewModel; editable: boolean; heldWhy: string | null; actions?: StyleRecordActions }) {
  const t = useT('products')
  const locale = useLocale()
  const [draft, setDraft] = useState<SubcontractDraft>(() => subcontractDraftOf(step, locale))
  const [tried, setTried] = useState(false)
  const load = useRef(actions?.onLoadWorkshops)
  load.current = actions?.onLoadWorkshops
  useEffect(() => {
    if (model.can.workshops && model.libraries.workshops === null) load.current?.()
  }, [model.can.workshops, model.libraries.workshops])
  const close = () => actions?.onDialog?.(null)
  const set = (patch: Partial<SubcontractDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const cost = model.grains.cost
  const problems = subcontractProblems(draft, model.grains)
  const patch = subcontractPatch(step, draft, model.grains)
  const choices = model.libraries.workshops ? workshopsFor(model.libraries.workshops, style.companyId) : null
  const current = step.subcontract
  const held = !editable
    ? heldWhy
    : Object.keys(problems).length > 0
      ? t('subcontract.held.fix', { count: Object.keys(problems).length })
      : patch === undefined
        ? t('subcontract.held.same')
        : model.busy
          ? t('held.busy')
          : null
  const save = () => {
    setTried(true)
    if (held || patch === undefined) return
    void actions?.onSubcontract?.(step.id, patch).then((ok) => ok && close())
  }
  const show = (field: 'supplierId' | 'fee' | 'days') => (tried && problems[field] ? t(problems[field]!) : undefined)

  if (!editable)
    return (
      <Modal open onClose={close} size="md" title={t('subcontract.title', { step: `${step.seq} · ${step.code}` })} footer={<Button onClick={close}>{t('common.close')}</Button>}>
        <div className="fw-st-dialog">
          {heldWhy && <Banner tone="info" title={heldWhy} />}
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('subcontract.who'), value: current ? `${current.supplier.code} · ${current.supplier.name}` : t('subcontract.inHouse') },
              ...(current
                ? [
                    { label: t('subcontract.fee'), value: !cost ? t('cost.notInRole') : current.pricePerPiece ? t('subcontract.feeIs', { fee: moneyText(current.pricePerPiece, 'EUR', locale) }) : t('subcontract.feePerOrder') },
                    { label: t('subcontract.transit'), value: current.transitDays === null ? t('subcontract.noDays') : t('subcontract.days', { count: current.transitDays }) },
                  ]
                : []),
            ]}
          />
        </div>
      </Modal>
    )

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('subcontract.title', { step: `${step.seq} · ${step.code}` })}
      subtitle={step.name}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('identity.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        <div className="fw-st-start" role="radiogroup" aria-label={t('subcontract.who')}>
          <RadioCard name="fw-sub-mode" value="in" checked={draft.mode === 'in'} selected={draft.mode === 'in'} onChange={() => set({ mode: 'in' })} title={t('subcontract.mode.in')} description={t('subcontract.mode.inHint')} />
          <RadioCard name="fw-sub-mode" value="out" checked={draft.mode === 'out'} selected={draft.mode === 'out'} onChange={() => set({ mode: 'out' })} title={t('subcontract.mode.out')} description={t('subcontract.mode.outHint')} />
        </div>
        {draft.mode === 'out' && (
          <>
            <Field label={t('subcontract.workshop')} required hint={style.companyId === null ? t('subcontract.workshopHintAll') : t('subcontract.workshopHint')} error={show('supplierId')}>
              {!model.can.workshops ? (
                <span className="fw-st-cellstack">
                  <span className="fw-st-static">{current ? `${current.supplier.code} · ${current.supplier.name}` : '—'}</span>
                  <span className="fw-st-hint">{t('subcontract.noParties')}</span>
                </span>
              ) : choices === null ? (
                <p className="fw-st-hint" role="status">
                  <Spinner size={14} /> {t('subcontract.loading')}
                </p>
              ) : (
                <Select value={draft.supplierId} onChange={(event) => set({ supplierId: event.target.value })}>
                  <option value="">{t('subcontract.pick')}</option>
                  {current && !choices.some((workshop) => workshop.id === current.supplier.id) && <option value={current.supplier.id}>{`${current.supplier.code} · ${current.supplier.name}`}</option>}
                  {choices.map((workshop) => (
                    <option key={workshop.id} value={workshop.id}>
                      {workshop.code} · {workshopName(workshop)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {model.can.workshops && choices !== null && choices.length === 0 && <Banner tone="warning" title={t('subcontract.noneYet')} />}
            <div className="fw-st-form-grid">
              <Field label={t('subcontract.fee')} hint={cost ? t('subcontract.feeHint') : t('cost.notInRoleHint')} error={show('fee')}>
                {cost ? <Input value={draft.fee} inputMode="decimal" suffix="€" onChange={(event) => set({ fee: event.target.value })} /> : <span className="fw-st-static">{t('cost.notInRole')}</span>}
              </Field>
              <Field label={t('subcontract.transit')} hint={t('subcontract.transitHint')} error={show('days')}>
                <Input value={draft.days} inputMode="numeric" suffix={t('subcontract.daysUnit')} onChange={(event) => set({ days: event.target.value })} />
              </Field>
            </div>
            {current && draft.supplierId && draft.supplierId !== current.supplier.id && <p className="fw-st-hint">{t('subcontract.otherStarts')}</p>}
          </>
        )}
        {draft.mode === 'in' && current && <p className="fw-st-hint">{t('subcontract.backInHouse', { code: current.supplier.code })}</p>}
        <p className="fw-st-hint">{t('subcontract.floor')}</p>
      </div>
    </Modal>
  )
}
