'use client'

import { useId } from 'react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { Combobox, DateField, Modal } from '../../../../lib/i18n/ds-parts'
import { CAPA_TYPES, type CapaType } from '../api'
import { escalateHeld, goingOf, recordProblem, type EscalateActions, type EscalateModel } from '../escalate'
import { NoticeLine, useNcrWords } from '../parts'

/**
 * Escalate to CAPA (B-W2b-113; design quality.ncr pop:ncr-capa "Link to an open CAPA (Combobox) or start a new one; many
 * NCRs → one CAPA; the rule that suggested it ('repeat defect', 'critical', 'customer complaint')"): ONE dialog for the list
 * (row verb, selection, key e) and the record (band). Pure: the model and the actions; the state, the calls and the rules
 * are ../escalate.ts (useEscalate), so this view never reaches the API client.
 */

export { dayAfter, ESCALATE_CODES, escalateHeld, escalateModelOf, escalateRefusal, goingOf, recordProblem, withPreview, type EscalateActions, type EscalateModel } from '../escalate'

// ---- the dialog ---------------------------------------------------------------------------------------------------------------

/** The dialog (pure: the model and the actions). */
export function EscalateDialog({ model, actions }: { model: EscalateModel; actions?: EscalateActions }) {
  const { t, say } = useNcrWords()
  const ids = { capa: useId(), title: useId(), due: useId() }
  const ready = model.preview.status === 'ready' ? model.preview.preview : null
  const going = ready ? goingOf(ready) : []
  const held = escalateHeld(model)
  const count = model.ncrs.length
  const title = count === 1 ? t('escalate.titleOne', { number: model.ncrs[0]?.number ?? '' }) : t('escalate.titleMany', { count })
  const submitCount = ready ? going.length : count

  return (
    <Modal
      open
      onClose={() => actions?.onCancel?.()}
      title={title}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onCancel?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={say(held)} onClick={() => actions?.onSubmit?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('escalate.submit', { count: submitCount })}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        <p className="fw-q-hint">{t('escalate.intro')}</p>
        <NoticeLine notice={model.notice} />
        {model.preview.status === 'loading' && (
          <p className="fw-q-hint fw-ncr-row">
            <Spinner size={12} /> {t('escalate.reading')}
          </p>
        )}
        {model.preview.status === 'error' && (
          <EmptyState
            title={t('escalate.failed')}
            description={t(model.preview.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        {ready && (
          <>
            <section aria-label={t('escalate.rowsLabel')}>
              <ul className="fw-ncr-escalate-rows">
                {ready.records.map((record) => {
                  const problem = recordProblem(record)
                  return (
                    <li key={record.recordId} className={problem ? 'is-held' : undefined}>
                      <span className="fw-ncr-row">
                        <b className="fw-q-code">{record.number}</b>
                        {record.title && <span className="fw-q-hint">{record.title}</span>}
                      </span>
                      <span className="fw-ncr-row">
                        <span className="fw-q-hint">{t('escalate.reasons')}</span>
                        {record.reasons.length === 0 ? <span className="fw-q-hint">{t('escalate.noReason')}</span> : record.reasons.map((reason) => <Tag key={reason} tone={reason === 'CRITICAL' || reason === 'SAFETY' ? 'danger' : 'info'}>{t(`escalate.reason.${reason}`)}</Tag>)}
                      </span>
                      {problem && <span className="fw-q-hint fw-ncr-escalate-why">{say(problem)}</span>}
                    </li>
                  )
                })}
              </ul>
              {going.length > 0 && going.length < ready.records.length && <p className="fw-q-hint">{t('escalate.willGo', { count: going.length, total: ready.records.length })}</p>}
            </section>
            {!ready.sameCompany && <Banner tone="warning" title={t('escalate.held.companies')} />}
            {!ready.mayOpen && ready.sameCompany && <Banner tone="info" title={t('escalate.held.noManage')} />}
            <SegmentedControl
              size="sm"
              ariaLabel={t('escalate.mode')}
              value={model.mode}
              onChange={(value) => actions?.onChange?.({ mode: value as 'new' | 'link' })}
              options={[
                { value: 'link', label: t('escalate.modeLink') },
                { value: 'new', label: t('escalate.modeNew') },
              ]}
            />
            {model.mode === 'link' ? (
              ready.capas.length === 0 ? (
                <p className="fw-q-hint">{t('escalate.noCapas')}</p>
              ) : (
                <Field label={<span id={`${ids.capa}-label`}>{t('escalate.capa')}</span>} required htmlFor={ids.capa}>
                  <Combobox
                    options={ready.capas.map((capa) => ({ value: capa.id, label: [capa.number, capa.title, capa.customer ? t('escalate.customer', { name: capa.customer.name }) : null].filter(Boolean).join(' · ') }))}
                    value={model.capaId}
                    onChange={(value) => actions?.onChange?.({ capaId: value })}
                    placeholder={t('escalate.capaSearch')}
                    labelledBy={`${ids.capa}-label`}
                  />
                </Field>
              )
            ) : (
              <div className="fw-ncr-form">
                <Field label={t('escalate.type')} required>
                  <SegmentedControl size="sm" ariaLabel={t('escalate.type')} value={model.type} onChange={(value) => actions?.onChange?.({ type: value as CapaType })} options={CAPA_TYPES.map((type) => ({ value: type, label: t(`escalate.typeName.${type}`) }))} />
                </Field>
                <Field label={t('escalate.due')} required hint={t('escalate.dueHint')} htmlFor={ids.due}>
                  <DateField id={ids.due} value={model.dueOn} onChange={(value) => actions?.onChange?.({ dueOn: value })} ariaLabel={t('escalate.due')} clearable={false} />
                </Field>
                <div className="is-wide">
                  <Field label={t('escalate.newTitle')} required htmlFor={ids.title}>
                    <Input id={ids.title} size="sm" value={model.title} maxLength={200} onChange={(event) => actions?.onChange?.({ title: event.target.value })} />
                  </Field>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
