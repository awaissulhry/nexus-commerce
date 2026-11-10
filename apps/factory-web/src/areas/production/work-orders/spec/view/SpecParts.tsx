'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import Link from 'next/link'
import { FileDiff, GitPullRequestArrow, Lock } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { CHANGE_PRIORITIES, recordHref, REQUEST_TONE, sectionKey } from '../../../../products/changes/model'
import { useWords } from '../../../../products/changes/parts'
import { DriftTable, MadeText } from '../../../../products/changes/view/Impact'
import { Redline } from '../../../../products/changes/view/Redline'
import type { WorkOrder } from '../../../_shared/api'
import { compareHeld, decisionPhrase, DRAFT_LIMITS, newerPhrase, raiseHeld, requestHeld, sameSpec, SPEC_NS, type SpecActions, type SpecModel, type SpecPhrase } from '../model'
import '../../../../products/styles/versions/versions.css'

/** This step's words and Changes & versions' (the redline, the drift, a request's status and priority) around a part. */
function SpecMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[SPEC_NS, 'products-changes']}>{children}</WithMessages>
}

/** `say` a phrase of this step's catalogue (or of products-changes); a day is said in the page's format. */
function useSay() {
  const t = useT(SPEC_NS)
  const { t: tc } = useWords()
  const locale = useLocale()
  return (phrase: SpecPhrase | null | undefined): string | null => {
    if (!phrase) return null
    const params: Record<string, string | number> = {}
    for (const [name, value] of Object.entries(phrase.params ?? {})) params[name] = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(`${value}T12:00:00Z`, { locale }) : value
    return (phrase.changes ? tc : t)(phrase.key, params)
  }
}

// ---- inline parts of W1's record ----------------------------------------------------------------------------------------------

/**
 * Overview › Frozen spec (design wo-frozen "'Compare with the current master' → Spec differences (W2b)"): a newer spec in force
 * (and what the office decided for this work order), "Compare with the current master" and "Change request…".
 */
export function FrozenSpecLine({ model, actions }: { model: SpecModel; actions?: SpecActions }) {
  return (
    <SpecMessages>
      <FrozenSpec model={model} actions={actions} />
    </SpecMessages>
  )
}

function FrozenSpec({ model, actions }: { model: SpecModel; actions?: SpecActions }) {
  const t = useT(SPEC_NS)
  const say = useSay()
  const spec = model.spec.status === 'ready' ? model.spec.value : null
  const newer = spec ? newerPhrase(spec) : null
  const held = compareHeld(model.spec)
  return (
    <div className="fw-ver-spec">
      {model.spec.status === 'error' && (
        <Banner
          tone="warning"
          title={t('wo.specFailed')}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.('spec')}>
              {t('base.retry')}
            </Button>
          }
        />
      )}
      {spec && newer && (
        <Banner tone="warning" title={say(newer)}>
          {say(decisionPhrase(spec))}
        </Banner>
      )}
      {spec && !newer && <p className="fw-ver-hint">{sameSpec(spec) ? t('wo.current', { revision: spec.revision?.revision ?? '—' }) : t('wo.noBanner')}</p>}
      <span className="fw-ver-row">
        <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onOpen?.({ kind: 'diff' })}>
          <FileDiff size={14} aria-hidden /> {t('wo.compare')}
        </Button>
        <Button size="sm" variant="quiet" heldReason={requestHeld(model.can) ? t(requestHeld(model.can)!) : null} onClick={() => actions?.onOpen?.({ kind: 'change' })}>
          <GitPullRequestArrow size={14} aria-hidden /> {t('wo.changeOpen')}
        </Button>
      </span>
      <p className="fw-ver-hint">{t('wo.differentSpec')}</p>
    </div>
  )
}

/** Size run (design wo-sizegrid "Released and later: read-only Banner 'Frozen at release: a change needs a change request'"). */
export function SizeRunFrozen({ model, actions }: { model: SpecModel; actions?: SpecActions }) {
  return (
    <SpecMessages>
      <SizeRunBanner model={model} actions={actions} />
    </SpecMessages>
  )
}

function SizeRunBanner({ model, actions }: { model: SpecModel; actions?: SpecActions }) {
  const t = useT(SPEC_NS)
  const held = requestHeld(model.can)
  return (
    <Banner
      tone="info"
      icon={<Lock size={16} aria-hidden />}
      title={t('wo.sizeFrozen')}
      action={
        <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onOpen?.({ kind: 'change' })}>
          {t('wo.changeOpen')}
        </Button>
      }
    />
  )
}

// ---- the pop-ups --------------------------------------------------------------------------------------------------------------

/** Spec differences (pop:wo-diff) or Change request (pop:wo-change), whichever is open. */
export function SpecDialogs({ workOrder, model, prefix, actions }: { workOrder: WorkOrder; model: SpecModel; prefix: string; actions?: SpecActions }) {
  if (!model.dialog) return null
  return (
    <SpecMessages>
      {model.dialog.kind === 'diff' ? <SpecDiffDialog workOrder={workOrder} model={model} actions={actions} /> : <ChangeRequestDialog workOrder={workOrder} model={model} prefix={prefix} actions={actions} />}
    </SpecMessages>
  )
}

/**
 * Spec differences (design pop:wo-diff "what changed in the master since release (BOM, routing, label, certificate) as
 * ChangeValue lines; 'a different spec is a new work order or a change request'"; PRD-194): the work order's frozen revision
 * against the style's released one — B-W2b-244's redline (one VersionCompare per part) with the BOM's right, else what
 * differs by part — the newer-spec banner and the office's decision, and the order lines quoted or ordered on another
 * revision. "Start a change request" opens the Change request pop-up.
 */
function SpecDiffDialog({ workOrder, model, actions }: { workOrder: WorkOrder; model: SpecModel; actions?: SpecActions }) {
  const t = useT(SPEC_NS)
  const { t: tc } = useWords()
  const say = useSay()
  const close = () => actions?.onClose?.()
  const spec = model.spec.status === 'ready' ? model.spec.value : null
  const held = requestHeld(model.can)
  const newer = spec ? newerPhrase(spec) : null
  return (
    <Modal
      open
      onClose={close}
      size="xl"
      title={t('wo.diff.title')}
      footer={
        <>
          <Button onClick={close}>{t('base.close')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onOpen?.({ kind: 'change' })}>
            {t('wo.diff.start')}
          </Button>
        </>
      }
    >
      <div className="fw-ver-dialog">
        {model.spec.status === 'loading' || model.spec.status === 'idle' ? (
          <p className="fw-ver-hint" role="status">
            <Spinner size={14} /> {t('base.reading')}
          </p>
        ) : model.spec.status === 'error' ? (
          <Banner tone="danger" title={t('wo.specFailed')} action={<Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.('spec')}>{t('base.retry')}</Button>}>
            {tc(model.spec.problem)}
          </Banner>
        ) : spec ? (
          <>
            <p className="fw-ver-text">{spec.revision && spec.released ? t('wo.diff.facts', { number: workOrder.number, revision: spec.revision.revision, released: spec.released.revision }) : spec.revision ? t('wo.diff.noReleased', { number: workOrder.number, revision: spec.revision.revision }) : t('wo.diff.noRevision', { number: workOrder.number })}</p>
            {newer && (
              <Banner tone="warning" title={say(newer)}>
                {say(decisionPhrase(spec))}
              </Banner>
            )}
            {sameSpec(spec) ? (
              <p className="fw-ver-hint">{t('wo.diff.same', { revision: spec.revision?.revision ?? '—' })}</p>
            ) : !spec.released || !spec.revision ? null : model.can.compare && model.compare ? (
              <Redline model={{ compare: model.compare.status === 'ready' ? model.compare.value : null, problem: model.compare.status === 'error' ? model.compare.problem : null }} onRetry={() => actions?.onRetry?.('compare')} />
            ) : (
              <>
                <ul className="fw-ver-list">
                  {spec.differs.length === 0 ? <li>{t('wo.diff.nothing')}</li> : spec.differs.map((entry) => <li key={entry.section}>{tc('redline.differs', { section: tc(sectionKey(entry.section)), added: entry.added, removed: entry.removed, changed: entry.changed })}</li>)}
                </ul>
                <p className="fw-ver-hint">{t('wo.diff.noBomRight')}</p>
              </>
            )}
            {spec.orders.length > 0 && (
              <section className="fw-ver-stack" aria-label={t('wo.diff.orders')}>
                <h3 className="fw-ver-h3">{t('wo.diff.orders')}</h3>
                <DriftTable drift={{ value: { style: { id: spec.workOrder.styleId, code: spec.workOrder.styleCode, name: spec.workOrder.styleCode }, current: spec.revision, rows: spec.orders, held: [] }, problem: null }} />
              </section>
            )}
            <p className="fw-ver-hint">{t('wo.differentSpec')}</p>
          </>
        ) : null}
      </div>
    </Modal>
  )
}

/**
 * Change request (design pop:wo-change "reason, what changes, the bundles already cut or sewn and so affected (MES-006);
 * approval"; B-W2b-226): what changes and why, the priority, what of the work order is already cut and worked (it would be
 * touched), the requests already about it; "Ask for approval" raises it for the product office (accepted, rejected, or
 * taken into a change order with its own approvers). ⌘↵ asks; Esc closes.
 */
function ChangeRequestDialog({ workOrder, model, prefix, actions }: { workOrder: WorkOrder; model: SpecModel; prefix: string; actions?: SpecActions }) {
  const t = useT(SPEC_NS)
  const { t: tc, day } = useWords()
  const say = useSay()
  const close = () => actions?.onClose?.()
  const held = raiseHeld(model.draft, model.can, model.busy)
  const run = () => {
    if (!held) actions?.onRaise?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      run()
    }
  }
  const changes = model.changes
  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={t('wo.change.title')}
      footer={
        <>
          <Button onClick={close}>{t('base.close')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('wo.change.ask')}
          </Button>
        </>
      }
    >
      <div className="fw-ver-dialog" onKeyDown={onKeyDown}>
        <p className="fw-ver-text">{t('wo.change.about', { number: workOrder.number, style: workOrder.style.code, revision: workOrder.revision?.revision ?? '—' })}</p>
        {model.raised && (
          <Banner
            tone="success"
            title={model.raised.number ? t('wo.change.raised', { number: model.raised.number }) : t('wo.change.raisedPlain')}
            action={
              <Link className="fw-ver-link" href={recordHref(prefix, 'request', model.raised.id)}>
                {t('wo.change.openIt')}
              </Link>
            }
          />
        )}
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        <Field label={t('wo.change.what')} hint={t('wo.change.whatHint')} required>
          <Input value={model.draft.title} maxLength={DRAFT_LIMITS.title} onChange={(event) => actions?.onDraft?.({ title: event.target.value })} autoFocus />
        </Field>
        <Field label={t('wo.change.why')} hint={t('wo.change.whyHint')} required>
          <Textarea value={model.draft.reason} rows={3} maxLength={DRAFT_LIMITS.reason} onChange={(event) => actions?.onDraft?.({ reason: event.target.value })} />
        </Field>
        <Field label={t('wo.change.priority')}>
          <Select size="sm" value={model.draft.priority} onChange={(event) => actions?.onDraft?.({ priority: event.target.value as (typeof CHANGE_PRIORITIES)[number] })}>
            {CHANGE_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {tc(`priority.${priority}`)}
              </option>
            ))}
          </Select>
        </Field>
        <h3 className="fw-ver-h3">{t('wo.change.made')}</h3>
        {changes === null ? (
          <p className="fw-ver-hint">{t('wo.change.madeNoRight')}</p>
        ) : changes.status === 'error' ? (
          <Banner tone="warning" title={t('wo.change.madeFailed')} action={<Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.('changes')}>{t('base.retry')}</Button>}>
            {tc(changes.problem)}
          </Banner>
        ) : changes.status !== 'ready' ? (
          <p className="fw-ver-hint" role="status">
            <Spinner size={14} /> {t('base.reading')}
          </p>
        ) : (
          <>
            <p className="fw-ver-text">
              <MadeText made={changes.value.made} />
            </p>
            {changes.value.made.cut.bundles + changes.value.made.worked.bundles > 0 && <p className="fw-ver-hint">{t('wo.change.madeHint')}</p>}
            <h3 className="fw-ver-h3">{t('wo.change.already')}</h3>
            {changes.value.requests.length === 0 ? (
              <p className="fw-ver-hint">{t('wo.change.noneYet')}</p>
            ) : (
              <SummaryTable
                label={t('wo.change.already')}
                stackOnPhone
                columns={[t('wo.col.request'), t('wo.col.what'), t('wo.col.status'), t('wo.col.raisedOn')]}
                align={['left', 'left', 'left', 'right']}
                widths={['20%', undefined, '18%', '16%']}
                rows={changes.value.requests.map((request) => ({
                  id: request.id,
                  cells: [
                    <Link key="number" className="fw-chg-link fw-chg-code" href={recordHref(prefix, 'request', request.id)}>
                      {request.number ?? tc('row.floorNoNumber')}
                    </Link>,
                    request.title,
                    <Pill key="status" tone={REQUEST_TONE[request.status]}>
                      {tc(`request.${request.status}`)}
                    </Pill>,
                    day(request.createdAt),
                  ],
                }))}
              />
            )}
          </>
        )}
        <p className="fw-ver-hint">{t('wo.change.approval')}</p>
      </div>
    </Modal>
  )
}
