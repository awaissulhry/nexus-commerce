'use client'

import Link from 'next/link'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Input, Select, Spinner } from '@nexus/ui/primitives'
import { EditModeBar, FileDropzone, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { RequestView } from '../../api'
import { CHANGE_PRIORITIES, personPhrase, recordHref, requestChanges, requestDraftOf, requestEditable, styleHref, workOrderHref, type ChangePriority, type Phrase } from '../../model'
import { OrderPill, PriorityTag, RequestPill, useWords } from '../../parts'
import { RequestImpact } from '../../view/Impact'
import type { ChangeRecordActions, ChangeRecordModel } from '../view-model'

/** Who raised it, in words (the floor names no worker; an office author is "You" / "A colleague" beside the record). */
function raisedBy(request: RequestView, me: string, say: (phrase: Phrase) => string | null): string {
  const source = say({ key: `source.${request.source}` }) ?? ''
  const who = request.party ? request.party.name : request.sampleRound ? request.sampleRound.number : request.source === 'OFFICE' ? say(personPhrase(request.createdById, me)) : null
  return who ? `${source} · ${who}` : source
}

/**
 * A change request's Change tab (design change.change, an explicit save with the EditModeBar; PRD-169): what should change
 * and why, its priority and the revision it is about — editable until it is decided (the priority alone once accepted);
 * read-only it is drawn as text with the reason in a Banner. Kind, who raised it, the style, the work order where it was
 * seen, the change order that carries it; its photos (Add photos while it is open; files.upload).
 */
export function RequestChangeTab({ model, request, actions }: { model: ChangeRecordModel; request: RequestView; actions?: ChangeRecordActions }) {
  const { t, say, when } = useWords()
  const offline = model.live === 'offline'
  const editable = requestEditable(request, model.can, offline)
  const draft = model.request.draft ?? requestDraftOf(request)
  const changes = requestChanges(request, draft)
  const style = model.request.style.value
  const all = editable.fields === 'all'
  const facts = [
    { label: t('field.kind'), value: t('kind.request') },
    { label: t('col.raisedBy'), value: raisedBy(request, model.me, say) },
    { label: t('field.raisedAt'), value: when(request.createdAt) },
    {
      label: t('field.style'),
      value: (
        <Link className="fw-chg-link" href={styleHref(model.prefix, request.style.id, request.revision?.id)}>
          {request.style.code} · {request.style.name}
        </Link>
      ),
    },
    {
      label: t('impact.workOrder'),
      value: request.workOrder ? (
        model.can.workOrders ? (
          <Link className="fw-chg-link" href={workOrderHref(model.prefix, request.workOrder.id)}>
            {request.workOrder.number}
          </Link>
        ) : (
          request.workOrder.number
        )
      ) : (
        '—'
      ),
    },
    {
      label: t('field.changeOrder'),
      value: request.changeOrder ? (
        <span className="fw-chg-row">
          <Link className="fw-chg-link" href={recordHref(model.prefix, 'order', request.changeOrder.id)}>
            {request.changeOrder.number}
          </Link>
          <OrderPill status={request.changeOrder.status} />
        </span>
      ) : (
        t('request.noOrder')
      ),
    },
  ]
  return (
    <div className="fw-chg-stack">
      {editable.why && editable.fields !== 'all' && <Banner tone="info" title={t('record.readOnly', { reason: say(editable.why) ?? '' })} />}
      <div className="fw-chg-two">
        <Card padded>
          <h2 className="fw-chg-h2">{t('record.what')}</h2>
          <div className="fw-chg-form">
            {all ? (
              <>
                <Field label={t('new.what')} required>
                  <Input size="sm" maxLength={200} value={draft.title} onChange={(event) => actions?.onRequestDraft?.({ title: event.target.value })} />
                </Field>
                <Field label={t('new.why')} required>
                  <Textarea rows={5} maxLength={4000} value={draft.reason} onChange={(event) => actions?.onRequestDraft?.({ reason: event.target.value })} />
                </Field>
              </>
            ) : (
              <>
                <h3 className="fw-chg-h3">{request.title}</h3>
                <p className="fw-chg-text">{request.reason}</p>
              </>
            )}
            <div className="fw-chg-form-grid">
              <Field label={t('col.priority')}>
                {editable.fields === 'none' ? (
                  <PriorityTag priority={request.priority} />
                ) : (
                  <Select size="sm" value={draft.priority} onChange={(event) => actions?.onRequestDraft?.({ priority: event.target.value as ChangePriority })}>
                    {CHANGE_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {t(`priority.${priority}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('new.revision')}>
                {all && style ? (
                  <Select size="sm" value={draft.revisionId} onChange={(event) => actions?.onRequestDraft?.({ revisionId: event.target.value })}>
                    <option value="">{t('revision.asItIs')}</option>
                    {style.revisions
                      .filter((revision) => revision.status !== 'OBSOLETE' || revision.id === request.revision?.id)
                      .sort((a, b) => b.revision - a.revision)
                      .map((revision) => (
                        <option key={revision.id} value={revision.id}>
                          {t('revision.option', { revision: revision.revision, status: t(`revision.${revision.status}`) })}
                        </option>
                      ))}
                  </Select>
                ) : (
                  <p className="fw-chg-text">{request.revision ? t('revision.label', { revision: request.revision.revision }) : t('revision.asItIs')}</p>
                )}
              </Field>
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
          <h2 className="fw-chg-h2">{t('field.photos')}</h2>
          <span className="fw-chg-hint">{t('photos.count', { count: request.photosList.length })}</span>
        </div>
        <div className="fw-chg-stack">
          {model.request.photos.failed > 0 && <Banner tone="warning" title={t('photos.failed', { count: model.request.photos.failed })} />}
          {request.photosList.length > 0 ? (
            <ul className="fw-chg-picks">
              {request.photosList.map((photo) => (
                <li key={photo.id} className="fw-chg-pick">
                  <span>{photo.originalName}</span>
                  <span className="fw-chg-hint">{when(photo.availableAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fw-chg-hint">{t('photos.none')}</p>
          )}
          {model.request.photos.busy ? (
            <p className="fw-chg-hint" role="status">
              <Spinner size={14} /> {t('photos.sending')}
            </p>
          ) : request.status === 'OPEN' || request.status === 'IN_REVIEW' ? (
            model.can.files && !offline ? (
              <FileDropzone accept=".jpg,.jpeg,.png,.webp,.heic" multiple maxBytes={15 * 1024 * 1024} hint={t('new.photosAdd')} onFiles={(files) => actions?.onPhotos?.(files)} />
            ) : (
              <p className="fw-chg-hint">{offline ? t('held.offline') : t('held.needsRight', { right: t('right.files.upload') })}</p>
            )
          ) : null}
          <p className="fw-chg-hint">{t('photos.inActivity')}</p>
        </div>
      </Card>
      {editable.fields !== 'none' && changes.count > 0 && (
        <EditModeBar
          count={changes.count}
          busy={model.request.saving}
          applyHeldReason={model.request.saving ? t('common.working') : (say(changes.problem) ?? (offline ? t('held.offlineKept') : null))}
          onApply={() => actions?.onRequestSave?.()}
          onDiscard={() => actions?.onRequestDiscard?.()}
          saveShortcut
        />
      )}
    </div>
  )
}

/** A change request's Approvals tab: its triage decision (who, when, why), and the change order that carries it to approval. */
export function RequestApprovalsTab({ model, request }: { model: ChangeRecordModel; request: RequestView }) {
  const { t, say, when } = useWords()
  const decided = request.decidedAt !== null
  return (
    <div className="fw-chg-two">
      <Card padded>
        <h2 className="fw-chg-h2">{t('approvals.triage')}</h2>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('col.status'), value: <RequestPill status={request.status} /> },
            { label: t('approvals.decidedBy'), value: decided ? say(personPhrase(request.decidedById, model.me)) : '—' },
            { label: t('approvals.decidedAt'), value: decided ? when(request.decidedAt) : '—' },
            { label: t('approvals.note'), value: request.decisionNote ?? '—' },
          ]}
        />
      </Card>
      <Card padded>
        <h2 className="fw-chg-h2">{t('approvals.order')}</h2>
        {request.changeOrder ? (
          <div className="fw-chg-stack">
            <span className="fw-chg-row">
              <Link className="fw-chg-link fw-chg-code" href={recordHref(model.prefix, 'order', request.changeOrder.id, 'approvals')}>
                {request.changeOrder.number}
              </Link>
              <OrderPill status={request.changeOrder.status} />
            </span>
            <p className="fw-chg-hint">{t('approvals.orderHint')}</p>
          </div>
        ) : (
          <p className="fw-chg-hint">{t('approvals.notSent')}</p>
        )}
      </Card>
    </div>
  )
}

/** A change request's Affected records: the style and the revision it is about (→ the revision its change order proposes). */
export function RequestAffectedTab({ model, request }: { model: ChangeRecordModel; request: RequestView }) {
  const { t } = useWords()
  return (
    <div className="fw-chg-stack">
      <Card padded>
        <KeyValue
          labelCase="sentence"
          columns={3}
          items={[
            {
              label: t('field.style'),
              value: (
                <Link className="fw-chg-link" href={styleHref(model.prefix, request.style.id, request.revision?.id)}>
                  {request.style.code} · {request.style.name}
                </Link>
              ),
            },
            { label: t('col.revision'), value: request.revision ? t('revision.label', { revision: request.revision.revision }) : t('revision.asItIs') },
            { label: t('field.changeOrder'), value: request.changeOrder ? request.changeOrder.number : t('request.noOrder') },
          ]}
        />
      </Card>
      <p className="fw-chg-hint">{t('affected.requestHint')}</p>
    </div>
  )
}

/** A change request's Impact: the work order where it was seen and what of it is already made (MES-006). */
export function RequestImpactTab({ model, request }: { model: ChangeRecordModel; request: RequestView }) {
  const { t } = useWords()
  return (
    <Card padded>
      <h2 className="fw-chg-h2">{t('tab.impact')}</h2>
      <RequestImpact request={request} prefix={model.prefix} canWorkOrders={model.can.workOrders} />
      <p className="fw-chg-hint">{t('impact.requestHint')}</p>
    </Card>
  )
}
