'use client'

import type { FormEvent } from 'react'
import { Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { DateTimeField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { DataRequestKind, DataSubjectKind } from '@nexus/factory-domain/privacy/retention/requests'
import type { PersonOption } from '../api'
import { KIND_ORDER, LOOKUP_PERMISSION, newRequestHeld, PERSON_KINDS, type NewRequestDraft, type RequestsViewModel } from '../model'

export interface NewRequestActions {
  onDraft?: (change: Partial<NewRequestDraft>) => void
  onFind?: () => void
  onCustomer?: (partyId: string) => void
  onCreate?: () => void
  onCloseNew?: () => void
}

/**
 * New data request (SCR-660 `new`, design admin.privacy h.act "New data request (primary)"; `?new=1`): the company, who asks
 * (a customer's contact, a prospect, a safety reporter, an office user, a worker), what they ask (access, erasure, correction),
 * the person found through the list of their kind (each list with its own right: a missing right is said, never a dead
 * field), when it came in (the 30-day clock starts there; never in the future) and a note without document numbers.
 */
export function NewRequestDialog({ model, actions }: { model: RequestsViewModel; actions?: NewRequestActions }) {
  const t = useT('admin-privacy-depth')
  const locale = useLocale()
  const creating = model.creating
  if (!creating) return null
  const { draft } = creating
  const held = newRequestHeld(draft, model.can, new Date(model.now).toISOString())
  const lookup = model.can.lookup[draft.personKind]
  const found = creating.found
  const options: readonly PersonOption[] = (draft.personKind === 'CONTACT' ? creating.contacts?.value : found?.value) ?? []
  const find = (event: FormEvent) => {
    event.preventDefault()
    actions?.onFind?.()
  }
  const footer = (
    <>
      <Button variant="secondary" onClick={() => actions?.onCloseNew?.()} disabled={creating.busy}>
        {t('dp.common.cancel')}
      </Button>
      <Button variant="primary" onClick={() => actions?.onCreate?.()} heldReason={creating.busy ? t('dp.common.working') : held ? t(held) : null}>
        {creating.busy && <Spinner size={14} />}
        {t('dp.new.create')}
      </Button>
    </>
  )

  return (
    <Modal open onClose={() => actions?.onCloseNew?.()} title={t('dp.new.title')} size="lg" footer={footer}>
      <div className="fw-dprq-new">
        <p className="fw-dprq-muted">{t('dp.new.intro')}</p>
        {creating.problem && <Banner tone="danger" title={t(creating.problem)} />}
        <div className="fw-dprq-grid">
          {model.companies.length > 1 && (
            <Field label={t('dp.new.company')}>
              <Select value={draft.companyId} onChange={(event) => actions?.onDraft?.({ companyId: event.target.value, person: null })}>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('dp.new.kind')} hint={t(`dp.kindHint.${draft.kind}`)}>
            <Select value={draft.kind} onChange={(event) => actions?.onDraft?.({ kind: event.target.value as DataRequestKind })}>
              {KIND_ORDER.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`dp.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('dp.new.who')}>
            <Select value={draft.personKind} onChange={(event) => actions?.onDraft?.({ personKind: event.target.value as DataSubjectKind, search: '', partyId: '', person: null })}>
              {PERSON_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`dp.personKind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {!lookup ? (
          <Banner tone="warning" title={t('dp.new.noLookup', { what: t(`dp.personKind.${draft.personKind}`), permission: LOOKUP_PERMISSION[draft.personKind] })} />
        ) : (
          <>
            <form className="fw-dprq-find" onSubmit={find} role="search">
              <Field label={t(draft.personKind === 'CONTACT' ? 'dp.new.findCustomer' : 'dp.new.find')} hint={t(`dp.new.findHint.${draft.personKind}`)}>
                <Input value={draft.search} onChange={(event) => actions?.onDraft?.({ search: event.target.value })} />
              </Field>
              <Button type="submit" heldReason={found && found.value === null && found.problem === null ? t('dp.common.working') : null}>
                <Search size={14} aria-hidden /> {t('dp.new.findButton')}
              </Button>
            </form>
            {found?.problem && <Banner tone="danger" title={t(found.problem)} />}
            {found?.value && found.value.length === 0 && <p className="fw-dprq-muted">{t('dp.new.noneFound')}</p>}
            {draft.personKind === 'CONTACT' && found?.value && found.value.length > 0 && (
              <Field label={t('dp.new.customer')}>
                <Select value={draft.partyId} onChange={(event) => actions?.onCustomer?.(event.target.value)}>
                  <option value="">{t('dp.new.pick')}</option>
                  {found.value.map((option) => (
                    <option key={option.recordId} value={option.recordId}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {draft.personKind === 'CONTACT' && creating.contacts?.problem && <Banner tone="danger" title={t(creating.contacts.problem)} />}
            {draft.personKind === 'CONTACT' && creating.contacts?.value && creating.contacts.value.length === 0 && <p className="fw-dprq-muted">{t('dp.new.noContacts')}</p>}
            {options.length > 0 && (
              <Field label={t(draft.personKind === 'CONTACT' ? 'dp.new.contact' : 'dp.new.person')} hint={draft.personKind === 'REPORTER' ? t('dp.new.reporterHint') : undefined}>
                <Select value={draft.person?.recordId ?? ''} onChange={(event) => actions?.onDraft?.({ person: options.find((option) => option.recordId === event.target.value) ?? null })}>
                  <option value="">{t('dp.new.pick')}</option>
                  {options.map((option) => (
                    <option key={option.recordId} value={option.recordId}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}

        <div className="fw-dprq-grid">
          <Field label={t('dp.new.received')} hint={t('dp.new.receivedHint')}>
            <DateTimeField value={draft.receivedAt} max={new Date(model.now + 5 * 60_000).toISOString()} stepMinutes={5} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('dp.new.received')} onChange={(value) => actions?.onDraft?.({ receivedAt: value })} />
          </Field>
        </div>
        <Field label={t('dp.new.note')} hint={t('dp.new.noteHint')}>
          <Textarea rows={3} value={draft.note} maxLength={2000} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
