'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CircleX, Flag, Truck } from 'lucide-react'
import { Banner, Card, Disclosure, EmptyState, Field, KeyValue, MetricStrip } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { RoutingStep, RoutingView, StyleView } from '../../api'
import { costCellOf, editableRevision, issueWords, minutesText, moneyText, parallelChoices, revisionInView, sideBySideWith, startRevisionHeld, stepLabel } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record/record-model'
import { subcontractDraftOf, subcontractPatch, subcontractProblems, workshopName, workshopsFor, type SubcontractDraft } from '../subcontract-model'
// B-W2b-235: the routing in depth (times, sizes, variants, checkpoints, settings) and the step's run beside its SMV.
import { WithMessages } from '../../../../../record-panels/i18n'
import { runWords, type RoutingDepthActions, type StepTimes } from '../depth/model'
import { DepthSection } from '../depth/view/DepthSection'
// owb-pd6 (S4, step 6.1): the route face (chips, steps with the department chip, rules, the builder's doors, who decides) reads for itself.
import { RouteContainer } from '../route/RouteContainer'
import '../route/route.css'

/**
 * SCR-043 the product tab "Route" (owb-pd6 step 6.1; design plan § 5u, § 5v, § 5w — was "Operations"): on top the route face
 * (route/RouteContainer: the product's route and its model and customer routes as chips, the steps of the chosen one with the
 * department chip and minutes, the rules as notes, "Edit this route…" / "New route…" / "Take out", who decides the route). The
 * route builder is the ONE place a route changes (steps, their order, departments, minutes): this tab no longer adds, moves or
 * removes a step itself. Under "More" (one closed section) today's depth of each step stays, nothing lost: the minutes strip by
 * department, the steps with their scan point, side-by-side group, outside workshop and instructions (B-W2b-88, W2a PRD-120), and
 * the routing in depth (B-W2b-235: times, sizes, checkpoints, machine settings). A released revision is frozen; the release check
 * stays on top.
 */
export function RoutingTab({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  // B-W2b-235: the depth's words beside the routing's; owb-pd6: the route's own words.
  return (
    <WithMessages namespaces={['products-operations-depth', 'products-route']}>
      <Routing style={style} model={model} actions={actions} />
    </WithMessages>
  )
}

function Routing({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const tr = useT('products-route')
  const locale = useLocale()
  const revision = revisionInView(style.revisions, model.revisionId)
  const editable = editableRevision(style, revision) && model.can.routingManage
  const heldWhy = !model.can.routingManage ? t('held.noManage') : !editableRevision(style, revision) ? t('bom.held.frozen') : model.busy ? t('held.busy') : null
  const [kind, setKind] = useState<string | null>(null)
  const [instructions, setInstructions] = useState<string | null>(null)

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

      {/* owb-pd6 step 6.1: the route face and its builder. */}
      <RouteContainer
        style={style}
        revisionId={revision.id}
        manage={model.can.routingManage}
        busy={model.busy}
        routingVersion={routing.revision.version}
        onChanged={() => actions?.onReload?.()}
        onStartRevision={actions?.onDialog && startRevisionHeld(style, model.can) === null ? () => actions?.onDialog?.({ kind: 'startRevision' }) : null}
      />

      {/* owb-pd6 step 6.1: today's depth of the steps, under one closed section ("More"). */}
      {routing.steps.length > 0 && (
        <Disclosure summary={tr('more.summary', { count: routing.steps.length })}>
          <div className="fw-rt-more-body">
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

            <Card
              header={tr('more.stepsTitle', { count: routing.steps.length })}
              description={kind ? t('routing.filtered', { department: t(`department.${kind}`) }) : tr('more.stepsIntro', { revision: routing.revision.revision })}
              headerAction={
                kind ? (
                  <Button size="sm" variant="quiet" onClick={() => setKind(null)}>
                    {t('routing.showAll')}
                  </Button>
                ) : undefined
              }
            >
              <div className="fw-st-scroll">
                <table className="fw-st-grid fw-st-routing" aria-label={tr('more.stepsTitle', { count: routing.steps.length })}>
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
                      <th scope="col">{t('routing.col.parallel')}</th>
                      <th scope="col">{t('routing.col.subcontracted')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((step) => (
                      <StepRow
                        key={step.id}
                        step={step}
                        routing={routing}
                        editable={editable}
                        actions={actions}
                        prefix={model.prefix}
                        costGrain={model.grains.cost}
                        onInstructions={() => setInstructions(step.id)}
                        times={model.routingDepth?.times.status === 'ready' ? (model.routingDepth.times.value.steps.find((entry) => entry.stepId === step.id) ?? null) : null}
                        depthActions={actions?.routingDepth}
                      />
                    ))}
                  </tbody>
                </table>
                {(editable || routing.steps.some((step) => step.parallelGroup !== null)) && <p className="fw-st-hint">{t('routing.parallel.hint')}</p>}
                <p className="fw-st-hint">{tr('more.minutesInBuilder')}</p>
              </div>
            </Card>

            {/* B-W2b-235: the routing in depth (design style.rt.grid's W2b columns and the operation drawer's variants). */}
            <DepthSection model={model.routingDepth} actions={actions?.routingDepth} />
          </div>
        </Disclosure>
      )}

      {model.dialog?.kind === 'subcontract' && routing.steps.some((step) => model.dialog?.kind === 'subcontract' && step.id === model.dialog.stepId) && (
        <SubcontractDialog step={routing.steps.find((step) => model.dialog?.kind === 'subcontract' && step.id === model.dialog.stepId)!} style={style} model={model} editable={editable} heldWhy={heldWhy} actions={actions} />
      )}
      {instructions && <InstructionsDialog step={routing.steps.find((step) => step.id === instructions)!} editable={editable} busy={model.busy} actions={actions} onClose={() => setInstructions(null)} />}
    </div>
  )
}

/**
 * One step's depth under "More" (owb-pd6: the step itself — its department, its place, its minutes — changes in the route builder):
 * the operation and its instructions, the department kind, the machine, the minutes with where the run comes from and the library's
 * SMV ("Use library value" copies the approved version: B-W2b-235), the scan point, the side-by-side group, the outside workshop.
 */
function StepRow({
  step,
  routing,
  editable,
  actions,
  prefix,
  costGrain,
  onInstructions,
  times,
  depthActions,
}: {
  step: RoutingStep
  routing: RoutingView
  editable: boolean
  actions?: StyleRecordActions
  prefix: string
  costGrain: boolean
  onInstructions: () => void
  /** B-W2b-235: the step's run (where it comes from) and the library's SMV in force today, when read. */
  times: StepTimes | null
  depthActions?: RoutingDepthActions
}) {
  const t = useT('products')
  const td = useT('products-operations-depth')
  const locale = useLocale()
  // B-W2b-235: the library's SMV in force today (an approved version) — "Use library value" copies that version.
  const differs = times ? times.library.differs : step.differsFromLibrary
  const libraryMinutes = times ? times.library.standardMinutes : step.operation.standardMinutes
  const useLibrary = () => {
    if (times?.library.inForceVersionId && depthActions?.onUseLibrary) void depthActions.onUseLibrary(step.id)
    else if (times && times.run.from !== 'TYPED' && depthActions?.onTypedRun) void depthActions.onTypedRun(step.id, libraryMinutes)
    else void actions?.onStep?.(step.id, { standardMinutes: libraryMinutes })
  }
  const run = times && times.run.from !== 'TYPED' ? runWords(times) : null
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
          <span>{t('routing.minutes', { minutes: minutesText(step.standardMinutes, locale) })}</span>
          {run && <span className="fw-st-hint">{td(run.key, run.params)}</span>}
          {differs && (
            <span className="fw-st-hint fw-st-inline">
              {t('routing.library', { minutes: minutesText(libraryMinutes, locale) })}
              {editable && (
                <Button size="sm" variant="link" onClick={useLibrary}>
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
        <ParallelCell step={step} routing={routing} editable={editable} actions={actions} />
      </td>
      <td>
        <SubcontractCell step={step} costGrain={costGrain} editable={editable} onOpen={() => actions?.onDialog?.({ kind: 'subcontract', stepId: step.id })} />
      </td>
    </tr>
  )
}

/**
 * B-W2b-88: the step's parallel group. A Select (in sequence, a group the routing uses, a new group) on a draft; on a frozen
 * revision the group and the steps beside it as text.
 */
function ParallelCell({ step, routing, editable, actions }: { step: RoutingStep; routing: RoutingView; editable: boolean; actions?: StyleRecordActions }) {
  const t = useT('products')
  const beside = sideBySideWith(step, routing.steps)
  const withWords = beside.length > 0 ? t('routing.parallel.with', { steps: beside.join(', ') }) : null
  if (!editable)
    return step.parallelGroup === null ? (
      <span className="fw-st-hint">{t('routing.parallel.none')}</span>
    ) : (
      <span className="fw-st-cellstack">
        <span className="fw-st-inline">
          <Tag tone="info">{t('routing.parallel.group', { group: step.parallelGroup })}</Tag>
        </span>
        {withWords && <span className="fw-st-hint">{withWords}</span>}
      </span>
    )
  const choices = parallelChoices(routing.steps)
  return (
    <span className="fw-st-cellstack">
      <Select
        size="sm"
        value={step.parallelGroup === null ? '' : String(step.parallelGroup)}
        aria-label={t('routing.parallel.of', { step: stepLabel(step) })}
        onChange={(event) => {
          const value = event.target.value === '' ? null : Number(event.target.value)
          if (value !== step.parallelGroup) void actions?.onStep?.(step.id, { parallelGroup: value })
        }}
      >
        <option value="">{t('routing.parallel.none')}</option>
        {choices.groups.map((entry) => (
          <option key={entry.group} value={String(entry.group)}>
            {t('routing.parallel.groupOf', { group: entry.group, steps: entry.steps.join(', ') })}
          </option>
        ))}
        {!choices.groups.some((entry) => entry.group === choices.next) && <option value={String(choices.next)}>{t('routing.parallel.newGroup', { group: choices.next })}</option>}
      </Select>
      {withWords && <span className="fw-st-hint">{withWords}</span>}
    </span>
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
