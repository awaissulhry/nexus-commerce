'use client'

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { namesLine } from '../../../../admin/shared/reach'
import { ASKABLE, type Askable, type Capability, type PartnerPerson, type PartnerRole, type PortalAccess } from '../../../../admin/users/partners/api'
import {
  addDays,
  blankInvite,
  capabilitiesFor,
  inviteProblems,
  personBody,
  personDraftOf,
  personProblems,
  personReach,
  roleChoices,
  type PartnerInviteDraft,
  type PersonDraft,
} from '../../../../admin/users/partners/model'
import { personOf, showsPrices, type PortalAccessActions, type PortalAccessModel } from '../model'
import { ConfirmBox } from './ConfirmBox'
import { usePortalT } from './parts'

/** ⌘Enter sends a dialog's form (00 §3.17); Esc closes it (the DS Modal). */
const sendOnMetaEnter = (go: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    go()
  }
}

function DialogProblem({ problem }: { problem: string | null }) {
  const t = usePortalT()
  return problem ? <Banner tone="danger" title={t(problem)} /> : null
}

/** One role as a card: its name, what it does in a plain line, whether it sees prices (customers), the admin mark. */
function RoleCards({ roles, value, onChange, prices, name, error }: { roles: readonly PartnerRole[]; value: string; onChange: (role: PartnerRole) => void; prices: boolean; name: string; error?: string | null }) {
  const t = usePortalT()
  return (
    <fieldset className="fw-pa-fieldset" aria-describedby={error ? `${name}-error` : undefined}>
      <legend className="fw-pa-legend">{t('invite.role')}</legend>
      <div className="fw-pa-cards">
        {roles.map((role) => (
          <RadioCard
            key={role.key}
            name={name}
            value={role.key}
            checked={value === role.key}
            selected={value === role.key}
            onChange={() => onChange(role)}
            title={t(`role.${role.key}`)}
            description={`${t(`roleLine.${role.key}`)}${prices ? ` ${t(role.seesPrices ? 'invite.seesPrices' : 'invite.noPrices')}` : ''}`}
          />
        ))}
      </div>
      {error && (
        <p id={`${name}-error`} className="fw-pa-error">
          {t(error)}
        </p>
      )}
    </fieldset>
  )
}

/** What the person may also do (COL-062): the capabilities the role allows. */
function CapabilityCards({ role, value, onChange }: { role: PartnerRole | undefined; value: readonly Capability[]; onChange: (next: Capability[]) => void }) {
  const t = usePortalT()
  if (!role || role.capabilities.allowed.length === 0) return null
  return (
    <fieldset className="fw-pa-fieldset">
      <legend className="fw-pa-legend">{t('invite.also')}</legend>
      <div className="fw-pa-cards">
        {role.capabilities.allowed.map((capability) => (
          <CheckboxCard
            key={capability}
            variant="row"
            checked={value.includes(capability)}
            selected={value.includes(capability)}
            onChange={(event) => onChange(event.target.checked ? [...value, capability] : value.filter((entry) => entry !== capability))}
            title={t(`capability.${capability}`)}
            description={t(`capabilityLine.${capability}`)}
          />
        ))}
      </div>
    </fieldset>
  )
}

export function InviteDialog({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const access = model.access!
  const open = model.dialog?.kind === 'invite'
  const [draft, setDraft] = useState<PartnerInviteDraft>(model.inviteDraft ?? blankInvite(access, locale))
  const [tried, setTried] = useState(model.inviteDraft !== undefined)
  useEffect(() => {
    if (open) {
      setDraft(model.inviteDraft ?? blankInvite(access, locale))
      setTried(model.inviteDraft !== undefined)
    }
    // A new dialog starts blank; the read behind it does not reset what is typed.
  }, [open])
  const problems = inviteProblems(draft, access, model.today)
  const shown = tried ? problems : {}
  const roles = roleChoices(access.roles, draft.kind)
  const role = roles.find((entry) => entry.key === draft.roleKey)
  const go = () => {
    setTried(true)
    if (Object.keys(problems).length > 0 || model.busy) return
    void actions?.onInvite?.(draft)
  }
  const set = (patch: Partial<PartnerInviteDraft>) => setDraft((current) => ({ ...current, ...patch }))
  return (
    <Modal
      open={open}
      onClose={() => actions?.onDialog?.(null)}
      title={t('invite.title', { name: access.party.name })}
      subtitle={t('invite.hint')}
      size="lg"
      footer={
        <span className="fw-pa-footer">
          <span className="fw-pa-hint">{t('invite.valid')}</span>
          <span className="fw-pa-actions">
            <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" heldReason={model.busy ? t('common.sending') : null} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              {t('invite.go')}
            </Button>
          </span>
        </span>
      }
    >
      <div className="fw-pa-form" onKeyDown={sendOnMetaEnter(go)}>
        <DialogProblem problem={model.dialogProblem} />
        <div className="fw-pa-two">
          <Field label={t('invite.name')} required error={shown.name ? t(shown.name) : undefined}>
            <Input value={draft.name} onChange={(event) => set({ name: event.target.value })} autoComplete="off" />
          </Field>
          <Field label={t('invite.email')} required error={shown.email ? t(shown.email) : undefined}>
            <Input type="email" value={draft.email} onChange={(event) => set({ email: event.target.value })} autoComplete="off" />
          </Field>
        </div>
        {access.kinds.length > 1 && (
          <Field label={t('invite.kind')} error={shown.kind ? t(shown.kind) : undefined}>
            <Select
              value={draft.kind ?? ''}
              onChange={(event) => {
                const kind = (event.target.value || null) as PartnerInviteDraft['kind']
                const first = roleChoices(access.roles, kind).find((entry) => !entry.admin)
                set({ kind, roleKey: first?.key ?? '', capabilities: capabilitiesFor(first, [], true), until: kind === 'GUEST' && draft.until === '' ? addDays(model.today, 30) : draft.until })
              }}
            >
              <option value="">{t('invite.kindPick')}</option>
              {access.kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {roles.length === 0 ? (
          <Banner tone="warning" title={t('invite.noRoles')} />
        ) : (
          <RoleCards roles={roles} value={draft.roleKey} onChange={(next) => set({ roleKey: next.key, capabilities: capabilitiesFor(next, draft.capabilities, next.key !== draft.roleKey) })} prices={showsPrices(access)} name="invite-role" error={shown.roleKey ?? null} />
        )}
        <CapabilityCards role={role} value={draft.capabilities} onChange={(capabilities) => set({ capabilities })} />
        <div className="fw-pa-two">
          <Field label={t('invite.until')} hint={draft.kind === 'GUEST' ? t('invite.untilGuest') : t('invite.untilHint')} error={shown.until ? t(shown.until) : undefined}>
            <DateField value={draft.until} onChange={(value) => set({ until: value })} locale={INTL_LOCALE[locale]} min={addDays(model.today, 1)} clearable clearLabel={t('invite.untilClear')} ariaLabel={t('invite.until')} />
          </Field>
          <Field label={t('invite.language')}>
            <Select value={draft.locale} onChange={(event) => set({ locale: event.target.value === 'en' ? 'en' : 'it' })}>
              <option value="it">{t('language.it')}</option>
              <option value="en">{t('language.en')}</option>
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  )
}

export function PersonDialog({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const access = model.access!
  const person = model.dialog?.kind === 'person' ? personOf(model, model.dialog.userId) : null
  const [draft, setDraft] = useState<PersonDraft>(model.personDraft ?? (person ? personDraftOf(person) : { roleKey: '', capabilities: [], until: '' }))
  useEffect(() => {
    if (person) setDraft(model.personDraft ?? personDraftOf(person))
    // A person's dialog starts from what they hold; their next read does not reset what is typed.
  }, [person?.id])
  if (!person) return null
  const roles = roleChoices(access.roles, person.kind, person.roleKey)
  const role = roles.find((entry) => entry.key === draft.roleKey)
  const problems = personProblems(draft, person, model.today)
  const body = personBody(person, draft)
  const held = model.busy ? t('common.saving') : Object.keys(problems).length > 0 ? t('person.fixFirst') : body === null ? t('person.nothing') : null
  const go = () => {
    if (held) return
    void actions?.onChangePerson?.(person, draft)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('person.title', { name: person.displayName })}
      subtitle={person.email}
      size="lg"
      footer={
        <span className="fw-pa-actions">
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('person.save')}
          </Button>
        </span>
      }
    >
      <div className="fw-pa-form" onKeyDown={sendOnMetaEnter(go)}>
        <DialogProblem problem={model.dialogProblem} />
        {person.status === 'INVITED' && <Banner tone="info" title={t('person.invitedNote')} />}
        <RoleCards roles={roles} value={draft.roleKey} onChange={(next) => setDraft((current) => ({ ...current, roleKey: next.key, capabilities: capabilitiesFor(next, current.capabilities, next.key !== current.roleKey) }))} prices={showsPrices(access)} name="person-role" error={problems.roleKey ?? null} />
        <CapabilityCards role={role} value={draft.capabilities} onChange={(capabilities) => setDraft((current) => ({ ...current, capabilities }))} />
        <Field label={t('invite.until')} hint={person.kind === 'GUEST' ? t('invite.untilGuest') : t('person.untilHint')} error={problems.until ? t(problems.until) : undefined}>
          <DateField value={draft.until} onChange={(value) => setDraft((current) => ({ ...current, until: value }))} locale={INTL_LOCALE[locale]} min={addDays(model.today, 1)} clearable clearLabel={t('invite.untilClear')} ariaLabel={t('invite.until')} />
        </Field>
      </div>
    </Modal>
  )
}

/** Suspend, reactivate, deactivate, the invitation again or revoked — over one person or the ticked ones. */
export function ConfirmDialog({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const dialog = model.dialog?.kind === 'confirm' ? model.dialog : null
  if (!dialog || !model.access) return null
  const picked = model.access.people.filter((person) => dialog.userIds.includes(person.id))
  const reach = personReach(dialog.action, picked, model.can)
  const people = reach.items
  const danger = dialog.action === 'suspend' || dialog.action === 'deactivate' || dialog.action === 'revoke'
  return (
    <ConfirmBox
      open
      title={t(`confirm.${dialog.action}.title`, { count: people.length, name: people[0]?.displayName ?? '' })}
      lines={[
        t(`confirm.${dialog.action}.body`),
        namesLine(people.map((person) => person.displayName), (more) => t('confirm.andMore', { count: more })),
        ...(reach.skipped > 0 ? [t('confirm.skipped', { count: reach.skipped })] : []),
      ]}
      confirmLabel={t(`bulk.${dialog.action}`, { count: people.length })}
      tone={danger ? 'danger' : 'primary'}
      reason={dialog.action === 'suspend' || dialog.action === 'deactivate'}
      busy={model.busy}
      problem={people.length === 0 ? 'held.nobody' : model.dialogProblem}
      onClose={() => actions?.onDialog?.(null)}
      onConfirm={(reason) => {
        if (model.busy || people.length === 0) return
        void actions?.onRows?.(dialog.action, people, reason)
      }}
    />
  )
}

/** Ask the partner for something on their own record (B-W2b-167: the office's requests by hand). */
export function AskDialog({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const open = model.dialog?.kind === 'ask'
  const [kind, setKind] = useState<Askable>('UPLOAD_DOCUMENT')
  const [due, setDue] = useState('')
  useEffect(() => {
    if (open) {
      setKind('UPLOAD_DOCUMENT')
      setDue(addDays(model.today, 7))
    }
  }, [open])
  const go = () => {
    if (model.busy) return
    void actions?.onAsk?.(kind, due)
  }
  // Measurements are a customer's (made to measure); progress a supplier's or a workshop's.
  const kinds = ASKABLE.filter((entry) => (model.side === 'customers' ? entry !== 'REPORT_PROGRESS' : entry !== 'SEND_MEASUREMENTS'))
  return (
    <Modal
      open={open}
      onClose={() => actions?.onDialog?.(null)}
      title={t('ask.title', { name: model.access?.party.name ?? model.partyName })}
      subtitle={t('ask.hint')}
      footer={
        <span className="fw-pa-actions">
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={model.busy ? t('common.sending') : null} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('ask.go')}
          </Button>
        </span>
      }
    >
      <div className="fw-pa-form" onKeyDown={sendOnMetaEnter(go)}>
        <DialogProblem problem={model.dialogProblem} />
        <fieldset className="fw-pa-fieldset">
          <legend className="fw-pa-legend">{t('ask.what')}</legend>
          <div className="fw-pa-cards">
            {kinds.map((entry) => (
              <RadioCard key={entry} name="ask-kind" value={entry} checked={kind === entry} selected={kind === entry} onChange={() => setKind(entry)} title={t(`ask.kind.${entry}`)} description={t(`ask.kindLine.${entry}`)} />
            ))}
          </div>
        </fieldset>
        <Field label={t('ask.due')} hint={t('ask.dueHint')}>
          <DateField value={due} onChange={setDue} locale={INTL_LOCALE[locale]} min={model.today} clearable clearLabel={t('ask.noDue')} ariaLabel={t('ask.due')} />
        </Field>
      </div>
    </Modal>
  )
}

export function CancelRequestDialog({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const dialog = model.dialog?.kind === 'cancelRequest' ? model.dialog : null
  const requests = dialog ? (model.requests.items ?? []).filter((item) => dialog.requestIds.includes(item.id)) : []
  if (!dialog || requests.length === 0) return null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('requests.cancelTitle', { count: requests.length })}
      footer={
        <span className="fw-pa-actions">
          <Button onClick={() => actions?.onDialog?.(null)}>{t('requests.keep')}</Button>
          <Button variant="danger" heldReason={model.busy ? t('common.saving') : null} onClick={() => void actions?.onCancelRequests?.(requests)}>
            {t('requests.cancelN', { count: requests.length })}
          </Button>
        </span>
      }
    >
      <div className="fw-pa-form">
        <DialogProblem problem={model.dialogProblem} />
        <ul className="fw-pa-list">
          {requests.map((request) => (
            <li key={request.id}>
              <span className="fw-pa-strong">{locale === 'en' ? request.words.en : request.words.it}</span>
              {request.dueAt ? ` · ${t('requests.dueOn', { date: formatDate(request.dueAt, { locale }) })}` : ''}
            </li>
          ))}
        </ul>
        <p className="fw-pa-text">{t('requests.cancelBody')}</p>
      </div>
    </Modal>
  )
}

/** Every dialog of the tab, in one place. */
export function PortalDialogs({ model, actions, children }: { model: PortalAccessModel; actions?: PortalAccessActions; children?: ReactNode }) {
  if (!model.access) return <>{children}</>
  return (
    <>
      {children}
      <InviteDialog model={model} actions={actions} />
      <PersonDialog model={model} actions={actions} />
      <ConfirmDialog model={model} actions={actions} />
      <AskDialog model={model} actions={actions} />
      <CancelRequestDialog model={model} actions={actions} />
    </>
  )
}

export type { PortalAccess, PartnerPerson }
