'use client'

import { useEffect, useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { CAPA_LIMITS, CAPA_PRIORITIES, CAPA_TYPES } from '@nexus/factory-domain/quality/capa/rules'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { CapaPriority, CapaType } from '../../api'
import { newDraftProblems, refusedKey, sourceTypeKey, type CapaCan } from '../../model'
import { NoticeLine, useCapaWords } from '../../parts'
import type { CapaListActions, NewDialog } from '../view-model'

/**
 * New CAPA (design pop:capa-new, the band's primary; also opened from records by address `?new=1&from=&ids=`): type (CAPA or
 * 8D), title, the sources it comes from (open NCRs and complaints, escalated in the same command), owner, due day,
 * priority, the customer an 8D is written for, and the problem in a sentence. The team (D1) and the rest of the problem
 * (D2) are written on the record's Problem tab. Create is held, with the reason, until the title and the due day are said
 * and every source may go. Esc closes; the focus returns to the opener (the DS Modal).
 */
export function NewCapaDialog({ dialog, can, today, me, offline, actions }: { dialog: NewDialog; can: CapaCan; today: string; me: string; offline: boolean; actions?: CapaListActions }) {
  const { t, say } = useCapaWords()
  const { draft } = dialog
  const [query, setQuery] = useState(dialog.found.q)
  const [customerQuery, setCustomerQuery] = useState('')
  useEffect(() => setQuery(dialog.found.q), [dialog.found.q])
  const problems = newDraftProblems(draft, today)
  const firstProblem = Object.values(problems)[0] ?? null
  const held = !can.manage ? t('held.noManage') : offline ? t('held.offline') : dialog.busy ? t('common.working') : dialog.from?.reading ? t('new.heldReading') : firstProblem ? say(firstProblem) : null
  const set = (patch: Parameters<NonNullable<CapaListActions['onNewDraft']>>[0]) => actions?.onNewDraft?.(patch)
  const people = Array.isArray(dialog.people) ? dialog.people : null
  const picked = new Set(draft.sources.map((source) => source.recordId))
  const canFind = can.ncrView || can.complaintsView

  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('new.title')}
      size="lg"
      footer={
        <span className="fw-capa-foot">
          <Button size="sm" onClick={() => actions?.onDialogClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSubmitNew?.()}>
            {dialog.busy ? <Spinner size={12} /> : <Plus size={14} aria-hidden />} {t('new.submit')}
          </Button>
        </span>
      }
    >
      <div className="fw-capa-stack">
        <NoticeLine notice={dialog.notice} />
        {dialog.from?.problem && <Banner tone="warning" title={t(dialog.from.problem)} />}
        <div className="fw-capa-form">
          <Field label={t('new.type')} className="is-wide" hint={t(draft.type === 'EIGHT_D' ? 'new.typeHint8D' : 'new.typeHintCapa')}>
            <SegmentedControl size="sm" ariaLabel={t('new.type')} value={draft.type} onChange={(value) => set({ type: value as CapaType })} options={CAPA_TYPES.map((type) => ({ value: type, label: t(`type.${type}`) }))} />
          </Field>
          <Field label={t('new.fieldTitle')} hint={t('new.fieldTitleHint')} required className="is-wide" error={draft.title && problems.title ? say(problems.title) : undefined}>
            <Input value={draft.title} maxLength={CAPA_LIMITS.title} onChange={(event) => set({ title: event.target.value })} />
          </Field>

          <section className="fw-capa-sources is-wide" aria-labelledby="capa-new-sources">
            <h3 id="capa-new-sources" className="fw-capa-h3">
              {t('new.sources')}
            </h3>
            <p className="fw-capa-hint">{t('new.sourcesHint')}</p>
            {dialog.from?.reading && (
              <p className="fw-capa-hint" role="status">
                <Spinner size={12} /> {t('new.reading')}
              </p>
            )}
            {draft.sources.length > 0 && (
              <ul className="fw-capa-picked">
                {draft.sources.map((source) => (
                  <li key={source.recordId}>
                    <span className="fw-q-code">{source.number}</span>
                    <span className="fw-capa-hint">{t(sourceTypeKey(source.recordType))}</span>
                    {source.title && <span className="fw-capa-clip">{source.title}</span>}
                    {source.held && <span className="fw-capa-bad">{t(refusedKey(source.held))}</span>}
                    <Button size="xs" variant="quiet" aria-label={t('new.dropSource', { number: source.number })} onClick={() => actions?.onDropSource?.(source.recordId)}>
                      <X size={13} aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {problems.sources && <p className="fw-capa-bad">{say(problems.sources)}</p>}
            {canFind ? (
              <span className="fw-capa-row">
                <Input
                  size="sm"
                  type="search"
                  aria-label={t('new.findSources')}
                  placeholder={t('new.findSources')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      actions?.onFindSources?.(query)
                    }
                  }}
                />
                <Button size="sm" onClick={() => actions?.onFindSources?.(query)}>
                  <Search size={13} aria-hidden /> {t('new.find')}
                </Button>
              </span>
            ) : (
              <p className="fw-capa-hint">{t('new.noFindRight')}</p>
            )}
            {dialog.found.problem && <p className="fw-capa-bad">{t(dialog.found.problem)}</p>}
            {dialog.found.items && dialog.found.items.length === 0 && <p className="fw-capa-hint">{t('new.foundNone')}</p>}
            {dialog.found.items && dialog.found.items.length > 0 && (
              <ul className="fw-capa-found" aria-label={t('new.found')}>
                {dialog.found.items.map((choice) => (
                  <li key={choice.recordId}>
                    <span className="fw-q-code">{choice.number}</span>
                    <span className="fw-capa-hint">{t(sourceTypeKey(choice.recordType))}</span>
                    <span className="fw-capa-clip">{choice.title}</span>
                    <Button size="xs" heldReason={picked.has(choice.recordId) ? t('new.pickedAlready') : draft.sources.length >= CAPA_LIMITS.sources ? t('new.tooManySources') : null} onClick={() => actions?.onPickSource?.(choice)}>
                      <Plus size={13} aria-hidden /> {t('new.add')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Field label={t('new.owner')} hint={dialog.people === 'failed' ? t('new.peopleFailed') : t('new.ownerHint')}>
            <Select value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })}>
              {!people && <option value={me}>{t('new.ownerMe')}</option>}
              {(people ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.me ? t('common.me', { name: person.name }) : person.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.due')} required hint={t('new.dueHint')} error={problems.dueOn ? say(problems.dueOn) : undefined}>
            <DateField value={draft.dueOn} min={today} onChange={(value) => set({ dueOn: value })} />
          </Field>
          <Field label={t('new.priority')}>
            <Select value={draft.priority} onChange={(event) => set({ priority: event.target.value as CapaPriority })}>
              {CAPA_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`priority.${priority}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.customer')} hint={can.partiesView ? t(draft.type === 'EIGHT_D' ? 'new.customerHint8D' : 'new.customerHint') : t('held.noParties')}>
            {can.partiesView ? (
              <span className="fw-capa-row">
                <Input
                  size="sm"
                  type="search"
                  aria-label={t('new.findCustomer')}
                  placeholder={t('new.findCustomer')}
                  value={customerQuery}
                  onChange={(event) => setCustomerQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      actions?.onFindCustomers?.(customerQuery)
                    }
                  }}
                  onFocus={() => dialog.customers.items === null && !dialog.customers.problem && actions?.onFindCustomers?.('')}
                />
                <Select
                  size="sm"
                  aria-label={t('new.customer')}
                  value={draft.customerId}
                  onChange={(event) => {
                    const choice = dialog.customers.items?.find((entry) => entry.id === event.target.value)
                    set({ customerId: event.target.value, customerLabel: choice ? `${choice.code} · ${choice.name}` : '' })
                  }}
                >
                  <option value="">{t('new.customerNone')}</option>
                  {draft.customerId && !dialog.customers.items?.some((entry) => entry.id === draft.customerId) && <option value={draft.customerId}>{draft.customerLabel}</option>}
                  {(dialog.customers.items ?? []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {`${entry.code} · ${entry.name}`}
                    </option>
                  ))}
                </Select>
              </span>
            ) : (
              <span className="fw-capa-hint">—</span>
            )}
          </Field>
          {dialog.customers.problem && <p className="fw-capa-bad is-wide">{t(dialog.customers.problem)}</p>}
          <Field label={t('new.problem')} hint={t('new.problemHint')} className="is-wide">
            <Textarea value={draft.problemWhat} rows={3} maxLength={CAPA_LIMITS.problem} onChange={(event) => set({ problemWhat: event.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
