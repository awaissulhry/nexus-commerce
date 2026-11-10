'use client'

import Link from 'next/link'
import { FilePlus2, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { Banner, Card, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, EditModeBar, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { OrderView } from '../../api'
import {
  actionHeld,
  approversHeld,
  approversOf,
  CHANGE_EFFECTS,
  CHANGE_PRIORITIES,
  linkable,
  orderChanges,
  orderDraftOf,
  personPhrase,
  recordHref,
  sameWip,
  styleHref,
  wipLinesOf,
  type ChangeEffect,
  type ChangePriority,
} from '../../model'
import { OrderPill, PriorityTag, RequestPill, useWords } from '../../parts'
import { DriftTable, OrderImpact } from '../../view/Impact'
import { Redline } from '../../view/Redline'
import type { ChangeRecordActions, ChangeRecordModel } from '../view-model'

/**
 * A change order's Change tab (design change.change, an explicit save with the EditModeBar; PRD-170): what, why, the
 * description, when it takes effect and its priority — editable while it is a draft (the priority until it is decided for
 * good), else text with the reason; the requests it carries (changed while a draft); the redline: the draft revision that
 * holds the proposed BOM, spec and operations ("Open the draft revision", or "Start the draft revision" from the released
 * one) and what differs, part by part (VersionCompare; "Use as change note" fills the description).
 */
export function OrderChangeTab({ model, order, actions }: { model: ChangeRecordModel; order: OrderView; actions?: ChangeRecordActions }) {
  const { t, say, day, when } = useWords()
  const offline = model.live === 'offline'
  const editHeld = !model.can.manage ? { key: 'held.viewOnly' } : order.status === 'DRAFT' ? (offline ? { key: 'held.offline' } : null) : actionHeld(order, 'edit', model.can, offline)
  const draftable = order.status === 'DRAFT' && !editHeld
  const priorityOnly = !draftable && model.can.manage && (order.status === 'SUBMITTED' || order.status === 'APPROVED') && !offline
  const draft = model.order.draft ?? orderDraftOf(order)
  const changes = orderChanges(order, draft)
  const startHeld = say(actionHeld(order, 'startDraft', model.can, offline))
  const carriedIds = model.carried.ids
  const carriedHeld = !model.can.manage ? t('held.noManage') : order.status !== 'DRAFT' ? say({ key: 'refusal.ORDER_NOT_DRAFT' }) : offline ? t('held.offline') : null
  const facts = [
    { label: t('field.kind'), value: t('kind.order') },
    { label: t('field.author'), value: say(personPhrase(order.authorId, model.me)) },
    { label: t('field.raisedAt'), value: when(order.createdAt) },
    {
      label: t('field.style'),
      value: (
        <Link className="fw-chg-link" href={styleHref(model.prefix, order.style.id, order.fromRevision.id)}>
          {order.style.code} · {order.style.name}
        </Link>
      ),
    },
    { label: t('col.revision'), value: order.toRevision ? t('revision.move', { from: order.fromRevision.revision, to: order.toRevision.revision }) : t('revision.noDraft', { from: order.fromRevision.revision }) },
    { label: t('col.approvals'), value: t('approvals.count', { approved: order.approvals.approved, required: order.approvals.required }) },
  ]
  return (
    <div className="fw-chg-stack">
      {editHeld && !priorityOnly && <Banner tone="info" title={t('record.readOnly', { reason: say(editHeld) ?? '' })} />}
      {priorityOnly && <Banner tone="info" title={t('record.priorityOnly', { status: t(`order.${order.status}`) })} />}
      <div className="fw-chg-two">
        <Card padded>
          <h2 className="fw-chg-h2">{t('record.what')}</h2>
          <div className="fw-chg-form">
            {draftable ? (
              <>
                <Field label={t('new.what')} required>
                  <Input size="sm" maxLength={200} value={draft.title} onChange={(event) => actions?.onOrderDraft?.({ title: event.target.value })} />
                </Field>
                <Field label={t('new.why')} required>
                  <Textarea rows={3} maxLength={4000} value={draft.reason} onChange={(event) => actions?.onOrderDraft?.({ reason: event.target.value })} />
                </Field>
                <Field label={t('field.description')} hint={t('field.descriptionHint')}>
                  <Textarea rows={4} maxLength={10000} value={draft.description} onChange={(event) => actions?.onOrderDraft?.({ description: event.target.value })} />
                </Field>
              </>
            ) : (
              <>
                <h3 className="fw-chg-h3">{order.title}</h3>
                <p className="fw-chg-text">{order.reason}</p>
                {order.description && <p className="fw-chg-text">{order.description}</p>}
              </>
            )}
            <div className="fw-chg-form-grid">
              <Field label={t('col.priority')}>
                {draftable || priorityOnly ? (
                  <Select size="sm" value={draft.priority} onChange={(event) => actions?.onOrderDraft?.({ priority: event.target.value as ChangePriority })}>
                    {CHANGE_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {t(`priority.${priority}`)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <PriorityTag priority={order.priority} />
                )}
              </Field>
              <Field label={t('field.effect')} hint={t('newOrder.effectHint')}>
                {draftable ? (
                  <Select size="sm" value={draft.effect} onChange={(event) => actions?.onOrderDraft?.({ effect: event.target.value as ChangeEffect })}>
                    {CHANGE_EFFECTS.map((effect) => (
                      <option key={effect} value={effect}>
                        {t(`effect.${effect}`)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <p className="fw-chg-text">{order.effect === 'DATE' ? t('effect.on', { day: day(order.effectiveDate) }) : t(`effect.${order.effect}`)}</p>
                )}
              </Field>
              {draftable && draft.effect === 'DATE' && (
                <Field label={t('field.effectiveDate')} required>
                  <DateField value={draft.effectiveDate} onChange={(value) => actions?.onOrderDraft?.({ effectiveDate: value })} />
                </Field>
              )}
            </div>
          </div>
        </Card>
        <Card padded>
          <h2 className="fw-chg-h2">{t('record.facts')}</h2>
          <KeyValue items={facts} labelCase="sentence" columns={2} />
        </Card>
      </div>
      <Card padded>
        <div className="fw-chg-cardhead">
          <h2 className="fw-chg-h2">{t('order.requestsCarried')}</h2>
          {carriedIds === null && (
            <Button size="sm" variant="quiet" heldReason={carriedHeld} onClick={() => actions?.onCarriedEdit?.()}>
              <Pencil size={13} aria-hidden /> {t('order.changeRequests')}
            </Button>
          )}
        </div>
        {carriedIds === null ? (
          order.requestsList.length === 0 ? (
            <p className="fw-chg-hint">{t('order.noRequests')}</p>
          ) : (
            <ul className="fw-chg-picks">
              {order.requestsList.map((request) => (
                <li key={request.id} className="fw-chg-pick">
                  <Link className="fw-chg-link" href={recordHref(model.prefix, 'request', request.id)}>
                    {request.number ?? t('row.floorNoNumber')} · {request.title}
                  </Link>
                  <RequestPill status={request.status} />
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="fw-chg-stack">
            {model.carried.options?.value === null && !model.carried.options?.problem ? (
              <p className="fw-chg-hint" role="status">
                <Spinner size={14} /> {t('common.loading')}
              </p>
            ) : (
              <ul className="fw-chg-picks">
                {[...order.requestsList, ...(model.carried.options?.value ?? []).filter((request) => linkable(request) && !order.requestsList.some((one) => one.id === request.id))].map((request) => (
                  <li key={request.id} className="fw-chg-pick">
                    <Checkbox checked={carriedIds.includes(request.id)} onChange={(event) => actions?.onCarriedToggle?.(request.id, event.target.checked)} label={`${request.number ?? t('row.floorNoNumber')} · ${request.title}`} />
                    <RequestPill status={request.status} />
                  </li>
                ))}
              </ul>
            )}
            <div className="fw-chg-actions">
              <Button size="sm" variant="secondary" onClick={() => actions?.onCarriedDiscard?.()}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" heldReason={model.carried.saving ? t('common.working') : carriedHeld} onClick={() => actions?.onCarriedSave?.()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </Card>
      <Card padded>
        <div className="fw-chg-cardhead">
          <h2 className="fw-chg-h2">{t('order.redline')}</h2>
          {order.toRevision ? (
            <Link className="fw-chg-link" href={styleHref(model.prefix, order.style.id, order.toRevision.id)}>
              {t('order.openDraft', { revision: order.toRevision.revision })}
            </Link>
          ) : (
            <Button size="sm" variant="secondary" heldReason={startHeld} onClick={() => actions?.onDialog?.({ kind: 'startDraft', changeNote: order.title, busy: false, notice: null })}>
              <FilePlus2 size={13} aria-hidden /> {t('order.startDraft')}
            </Button>
          )}
        </div>
        {model.order.redline ? (
          <Redline
            model={model.order.redline}
            onUseAsNote={draftable ? (note) => actions?.onUseAsNote?.(note) : undefined}
            noteHeld={draftable ? null : t('order.noteHeld')}
            onRetry={() => actions?.onRedlineRetry?.()}
          />
        ) : (
          <p className="fw-chg-hint">{t('held.needsRight', { right: t('right.product.bom.view') })}</p>
        )}
      </Card>
      {order.lines.length > 0 && (
        <Card padded>
          <h2 className="fw-chg-h2">{t('order.lines')}</h2>
          <SummaryTable
            label={t('order.lines')}
            columns={[t('order.line.record'), t('order.line.field'), t('order.line.before'), t('order.line.after'), t('order.line.note')]}
            stackOnPhone
            rows={order.lines.map((line) => ({ id: line.id, cells: [line.recordType, line.field ?? '—', written(line.before), written(line.after), line.note ?? '—'] }))}
          />
        </Card>
      )}
      {draftable && changes.count > 0 && (
        <EditModeBar
          count={changes.count}
          busy={model.order.saving}
          applyHeldReason={model.order.saving ? t('common.working') : (say(changes.problem) ?? null)}
          onApply={() => actions?.onOrderSave?.()}
          onDiscard={() => actions?.onOrderDiscard?.()}
          saveShortcut
        />
      )}
      {priorityOnly && changes.count > 0 && (
        <EditModeBar count={changes.count} busy={model.order.saving} applyHeldReason={model.order.saving ? t('common.working') : null} onApply={() => actions?.onOrderSave?.()} onDiscard={() => actions?.onOrderDiscard?.()} saveShortcut />
      )}
    </div>
  )
}

/** A CHANGE line's value as written (a number, words, or the JSON of an object); none: a dash. */
function written(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** A change order's Impact tab: work in progress per open work order (chosen while a draft, saved as one list) and the drift. */
export function OrderImpactTab({ model, order, actions }: { model: ChangeRecordModel; order: OrderView; actions?: ChangeRecordActions }) {
  const { t, say } = useWords()
  const offline = model.live === 'offline'
  const held = !model.can.manage ? { key: 'held.viewOnly' } : order.status !== 'DRAFT' ? { key: 'refusal.ORDER_NOT_DRAFT' } : offline ? { key: 'held.offline' } : null
  const lines = model.wip.lines ?? (held ? null : wipLinesOf(order))
  const changed = model.wip.lines !== null && !sameWip(order, model.wip.lines)
  return (
    <div className="fw-chg-stack">
      <Card padded>
        <h2 className="fw-chg-h2">{t('tab.impact')}</h2>
        <p className="fw-chg-hint">{t('impact.intro')}</p>
        <OrderImpact order={order} lines={lines} wipHeld={held} drift={model.order.drift} prefix={model.prefix} canWorkOrders={model.can.workOrders} onDisposition={actions?.onDisposition} onDriftRetry={actions?.onDriftRetry} />
      </Card>
      {changed && (
        <EditModeBar
          count={1}
          busy={model.wip.saving}
          applyHeldReason={model.wip.saving ? t('common.working') : say(held)}
          onApply={() => actions?.onWipSave?.()}
          onDiscard={() => actions?.onWipDiscard?.()}
          saveShortcut
        />
      )}
    </div>
  )
}

/**
 * A change order's Approvals tab (design change.approvals, one stage in V1; PRD-170): each approver — required or optional
 * —, the decision, when and why; Change approvers (never its author: four eyes; decided approvals stay) while a draft or
 * waiting; Submit for approval; Approve… opens Approve change. The approver's name is said here, inside the one record.
 */
export function OrderApprovalsTab({ model, order, actions }: { model: ChangeRecordModel; order: OrderView; actions?: ChangeRecordActions }) {
  const { t, say, when } = useWords()
  const offline = model.live === 'offline'
  const editing = model.approvers.lines
  const editHeld = say(approversHeld(order, editing ?? approversOf(order), model.can, offline))
  const options = model.approvers.options
  const free = (options?.value?.people ?? []).filter((person) => !(editing ?? []).some((line) => line.userId === person.id))
  return (
    <div className="fw-chg-stack">
      <Card padded>
        <div className="fw-chg-cardhead">
          <h2 className="fw-chg-h2">{t('tab.approvals')}</h2>
          <span className="fw-chg-row">
            {editing === null && (
              <Button size="sm" variant="quiet" heldReason={editHeld} onClick={() => actions?.onApproversEdit?.()}>
                <Pencil size={13} aria-hidden /> {t('approvers.change')}
              </Button>
            )}
            {order.status === 'DRAFT' && (
              <Button size="sm" variant="primary" heldReason={say(actionHeld(order, 'submit', model.can, offline))} onClick={() => actions?.onSubmit?.()}>
                <Send size={13} aria-hidden /> {t('order.submit')}
              </Button>
            )}
            {order.status === 'SUBMITTED' && (
              <Button size="sm" variant="primary" heldReason={say(actionHeld(order, 'decide', model.can, offline))} onClick={() => actions?.onDecide?.()} aria-keyshortcuts="a">
                {t('order.decide')}
              </Button>
            )}
          </span>
        </div>
        {editing === null ? (
          order.approvalsList.length === 0 ? (
            <p className="fw-chg-hint">{t('approvals.notSent')}</p>
          ) : (
            <SummaryTable
              label={t('tab.approvals')}
              columns={[t('approvers.col.approver'), t('approvers.col.required'), t('approvers.col.decision'), t('approvers.col.when'), t('approvers.col.why')]}
              stackOnPhone
              widths={['26%', '14%', '16%', '18%', undefined]}
              rows={order.approvalsList.map((approval) => ({
                id: approval.id,
                cells: [
                  approval.approverId === model.me ? t('approvers.youName', { name: approval.approverName ?? '' }) : (approval.approverName ?? t('person.other')),
                  approval.required ? t('approvers.required') : t('approvers.optional'),
                  approval.decision ? t(`decision.${approval.decision}`) : t('approvers.waiting'),
                  approval.decidedAt ? when(approval.decidedAt) : '—',
                  approval.reason ?? '—',
                ],
              }))}
            />
          )
        ) : (
          <div className="fw-chg-stack">
            <ul className="fw-chg-picks" aria-label={t('tab.approvals')}>
              {editing.length === 0 && <li className="fw-chg-hint">{t('approvers.none')}</li>}
              {editing.map((line) => (
                <li key={line.userId} className="fw-chg-pick">
                  <span>{line.name || t('person.other')}</span>
                  <span className="fw-chg-row">
                    <Checkbox checked={line.required} disabled={line.decided} onChange={(event) => actions?.onApproverRequired?.(line.userId, event.target.checked)} label={t('approvers.required')} />
                    <Button size="xs" variant="quiet" heldReason={line.decided ? t('approvers.decidedStays') : null} onClick={() => actions?.onApproverRemove?.(line.userId)} aria-label={t('approvers.remove', { name: line.name })}>
                      <Trash2 size={13} aria-hidden />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="fw-chg-row">
              <Field label={t('approvers.add')} hint={options?.problem ? t(options.problem) : t('approvers.addHint')}>
                {options?.value === null && !options?.problem ? (
                  <Spinner size={14} />
                ) : (
                  <Select size="sm" value={model.approvers.pick} onChange={(event) => actions?.onApproverPick?.(event.target.value)}>
                    <option value="">{free.length === 0 ? t('approvers.noneLeft') : t('approvers.pick')}</option>
                    {free.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button size="sm" variant="secondary" heldReason={model.approvers.pick ? null : t('approvers.pickFirst')} onClick={() => actions?.onApproverAdd?.()}>
                <Plus size={13} aria-hidden /> {t('approvers.addButton')}
              </Button>
            </div>
            <div className="fw-chg-actions">
              <Button size="sm" variant="secondary" onClick={() => actions?.onApproversDiscard?.()}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" heldReason={model.approvers.saving ? t('common.working') : editHeld} onClick={() => actions?.onApproversSave?.()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
        <p className="fw-chg-hint">{t('approvers.fourEyes')}</p>
      </Card>
    </div>
  )
}

/** A change order's Affected records: the style, its revision old → new, open orders on older revisions; Release (explicit). */
export function OrderAffectedTab({ model, order, actions }: { model: ChangeRecordModel; order: OrderView; actions?: ChangeRecordActions }) {
  const { t, say, day, when } = useWords()
  const offline = model.live === 'offline'
  const releaseHeld = say(actionHeld(order, 'release', model.can, offline))
  return (
    <div className="fw-chg-stack">
      <Card padded>
        <div className="fw-chg-cardhead">
          <h2 className="fw-chg-h2">{t('tab.affected')}</h2>
          {(order.status === 'APPROVED' || order.status === 'SUBMITTED') && order.toRevision && (
            <Button size="sm" variant="primary" heldReason={releaseHeld} onClick={() => actions?.onDialog?.({ kind: 'release', changeNote: order.title, busy: false, notice: null })}>
              {t('order.release', { revision: order.toRevision.revision })}
            </Button>
          )}
        </div>
        <KeyValue
          labelCase="sentence"
          columns={3}
          items={[
            {
              label: t('field.style'),
              value: (
                <Link className="fw-chg-link" href={styleHref(model.prefix, order.style.id)}>
                  {order.style.code} · {order.style.name}
                </Link>
              ),
            },
            { label: t('affected.old'), value: t('revision.label', { revision: order.fromRevision.revision }) },
            {
              label: t('affected.new'),
              value: order.toRevision ? (
                <span className="fw-chg-row">
                  <Link className="fw-chg-link" href={styleHref(model.prefix, order.style.id, order.toRevision.id)}>
                    {t('revision.label', { revision: order.toRevision.revision })}
                  </Link>
                  <span className="fw-chg-hint">{t(`revision.${order.toRevision.status}`)}</span>
                </span>
              ) : (
                t('revision.none')
              ),
            },
            { label: t('col.effective'), value: order.effect === 'DATE' ? t('effect.on', { day: day(order.effectiveDate) }) : t(`effect.${order.effect}`) },
            { label: t('col.status'), value: <OrderPill status={order.status} /> },
            { label: t('affected.releasedAt'), value: order.releasedAt ? when(order.releasedAt) : '—' },
          ]}
        />
        <p className="fw-chg-hint">{t('affected.choiceLater')}</p>
      </Card>
      <Card padded>
        <h2 className="fw-chg-h2">{t('impact.drift')}</h2>
        <DriftTable drift={model.order.drift} onRetry={actions?.onDriftRetry} />
      </Card>
    </div>
  )
}
