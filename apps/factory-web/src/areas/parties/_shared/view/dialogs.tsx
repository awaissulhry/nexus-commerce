'use client'

import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ADDRESS_KINDS, CONTACT_ROLES, PARTY_TAX_MODES, type PartyRole, type PartyRow, type TaxMode } from '../api'
import {
  addressDraftProblems,
  blankAddress,
  blankContact,
  blankIdentity,
  blankNewParty,
  BULK_MAX,
  contactDraftProblems,
  countryOptions,
  CURRENCY_CHOICES,
  identityFields,
  identityProblems,
  isReady,
  LANGUAGE_CHOICES,
  languageName,
  languageOf,
  newPartyProblems,
  partyProblems,
  recordHref,
  reasonProblem,
  SIDES,
  suggestCode,
  type AddressDraft,
  type BulkRun,
  type ContactDraft,
  type IdentityDraft,
  type NewPartyDraft,
  type PartyDraft,
  type Problems,
  type Side,
} from '../model'
import { RoleTags, StatusPill } from './parts'

/**
 * The dialogs of the customers' and suppliers' pages (design: customers.new / block / identity / archive, the address and
 * contact forms of the Addresses & contacts tab, suppliers.new / block). Forms check a field when it is left and every
 * field on submit (00 §3.10); a refused value shows at its field in this app's words. ⌘↵ submits, Esc closes. The
 * submit is never disabled: it is held with its reason (00 §4.1).
 */

type Shown = (field: string) => string | undefined

/** Field problems shown once the field was left, or after a submit. */
function useShown(problems: Problems, refused: readonly string[] = []) {
  const t = useT('parties')
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [tried, setTried] = useState(false)
  const shown: Shown = (field) => {
    const problem = problems[field]
    if (problem && (tried || touched.has(field))) return t(problem.key, problem.params)
    const last = field.split('.').at(-1) ?? field
    return refused.includes(last) ? t('form.refused') : undefined
  }
  return {
    shown,
    leave: (field: string) => setTouched((current) => new Set(current).add(field)),
    tried,
    setTried,
    reset: () => {
      setTouched(new Set())
      setTried(false)
    },
  }
}

/** ⌘↵ / Ctrl↵ submits the form it is typed in. */
const submitKeys = (submit: () => void) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    submit()
  }
}

function SubmitHint() {
  const t = useT('parties')
  return (
    <span className="fw-pty-hint" aria-hidden>
      <Kbd>⌘</Kbd>
      <Kbd>↵</Kbd> {t('form.submitHint')}
    </span>
  )
}

// ---- shared form parts ------------------------------------------------------------------------------------------------

/**
 * True once the page has hydrated. Country and language names come from the browser's Intl, whose data differs from the
 * server's on some names ("Falkland Islands" / "… (Islas Malvinas)"): the long pick lists show codes until then, so the
 * first browser render matches the server's.
 */
const subscribeNever = () => () => undefined
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  )
}

export function CountrySelect({ value, onChange, onBlur, id }: { value: string; onChange: (value: string) => void; onBlur?: () => void; id?: string }) {
  const locale = useLocale()
  const hydrated = useHydrated()
  // Before hydration: codes in code order (the names, and so their order, are the browser's).
  const options = useMemo(
    () =>
      hydrated
        ? countryOptions(locale)
        : countryOptions(locale)
            .map((option) => ({ ...option, label: option.value }))
            .sort((a, b) => (a.value === 'IT' ? -1 : b.value === 'IT' ? 1 : a.value.localeCompare(b.value))),
    [hydrated, locale],
  )
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} onBlur={onBlur}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  )
}

export function LanguageSelect({ value, onChange, empty }: { value: string; onChange: (value: string) => void; empty?: string }) {
  const locale = useLocale()
  const hydrated = useHydrated()
  const choices = LANGUAGE_CHOICES.includes(value as (typeof LANGUAGE_CHOICES)[number]) || value === '' ? LANGUAGE_CHOICES : [value, ...LANGUAGE_CHOICES]
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {choices.map((code) => (
        <option key={code} value={code}>
          {hydrated ? languageName(code, locale) : code}
        </option>
      ))}
    </Select>
  )
}

/** A party's own fields (New, Edit, the supplier's Overview form). */
export function PartyFields({
  draft,
  onChange,
  shown,
  leave,
  side,
  withCode = true,
  withTerms = false,
  withCountry = true,
  roles,
}: {
  draft: PartyDraft
  onChange: (next: PartyDraft) => void
  shown: Shown
  leave: (field: string) => void
  side: Side
  withCode?: boolean
  withTerms?: boolean
  /** The country field (New takes it from the tax country above). */
  withCountry?: boolean
  /** The roles offered (default the side's; an edit offers all five: one record carries every role). */
  roles?: readonly PartyRole[]
}) {
  const t = useT('parties')
  const offered = roles ?? SIDES[side].newRoles
  const set = <K extends keyof PartyDraft>(field: K, value: PartyDraft[K]) => onChange({ ...draft, [field]: value })
  return (
    <div className="fw-pty-form">
      <Field label={t('field.legalName')} required hint={t('field.legalNameHint')} error={shown('legalName')}>
        <Input value={draft.legalName} onChange={(event) => set('legalName', event.target.value)} onBlur={() => leave('legalName')} />
      </Field>
      <Field label={t('field.tradeName')} hint={t('field.tradeNameHint')} error={shown('tradeName')}>
        <Input value={draft.tradeName} onChange={(event) => set('tradeName', event.target.value)} onBlur={() => leave('tradeName')} />
      </Field>
      <Field label={t('field.kind')}>
        <SegmentedControl
          ariaLabel={t('field.kind')}
          size="sm"
          value={draft.kind}
          onChange={(value) => set('kind', value as PartyDraft['kind'])}
          options={[
            { value: 'ORGANISATION', label: t('kind.ORGANISATION') },
            { value: 'PERSON', label: t('kind.PERSON') },
          ]}
        />
      </Field>
      {withCode && (
        <Field label={t('field.code')} required hint={t('field.codeHint')} error={shown('code')}>
          <Input className="fw-pty-code" value={draft.code} onChange={(event) => set('code', event.target.value.toUpperCase())} onBlur={() => leave('code')} />
        </Field>
      )}
      <fieldset className="fw-pty-pick fw-pty-form-wide">
        <legend>{t('field.roles')}</legend>
        <span className="fw-pty-checks">
          {offered.map((role) => (
            <Checkbox
              key={role}
              label={t(`role.${role}`)}
              checked={draft.roles.includes(role)}
              onChange={(event) => set('roles', event.target.checked ? [...draft.roles, role] : draft.roles.filter((held) => held !== role))}
              onBlur={() => leave('roles')}
            />
          ))}
        </span>
        {shown('roles') && <span className="fw-pty-hint">{shown('roles')}</span>}
      </fieldset>
      {withCountry && (
        <Field label={t('field.country')} required error={shown('country')}>
          <CountrySelect value={draft.country} onChange={(value) => set('country', value)} onBlur={() => leave('country')} />
        </Field>
      )}
      <Field label={t('field.language')} hint={t('field.languageHint')} error={shown('language')}>
        <LanguageSelect value={draft.language} onChange={(value) => set('language', value)} />
      </Field>
      <Field label={t('field.currency')} error={shown('currency')}>
        <Select value={draft.currency} onChange={(event) => set('currency', event.target.value)}>
          {(CURRENCY_CHOICES.includes(draft.currency as (typeof CURRENCY_CHOICES)[number]) ? CURRENCY_CHOICES : [draft.currency, ...CURRENCY_CHOICES]).map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
      </Field>
      {withTerms && (
        <>
          <Field label={t('field.paymentTerms')} hint={t('field.paymentTermsHint')} error={shown('paymentTerms')} className="fw-pty-form-wide">
            <Input value={draft.paymentTerms} maxLength={500} onChange={(event) => set('paymentTerms', event.target.value)} onBlur={() => leave('paymentTerms')} />
          </Field>
          <Field label={t('field.internalNote')} hint={t('field.internalNoteHint')} error={shown('internalNote')} className="fw-pty-form-wide">
            <Textarea rows={3} value={draft.internalNote} onChange={(event) => set('internalNote', event.target.value)} onBlur={() => leave('internalNote')} />
          </Field>
        </>
      )}
    </div>
  )
}

/** A tax identity's fields, as its mode asks (IT business: Partita IVA, codice fiscale, SDI code, PEC). */
export function IdentityFields({
  draft,
  onChange,
  shown,
  leave,
  prefix = '',
  withDate = false,
  dateOptional = false,
  withCountry = true,
}: {
  draft: IdentityDraft
  onChange: (next: IdentityDraft) => void
  shown: Shown
  leave: (field: string) => void
  prefix?: string
  withDate?: boolean
  /** The first identity: no day means from today. */
  dateOptional?: boolean
  withCountry?: boolean
}) {
  const t = useT('parties')
  const fields = identityFields(draft.taxMode)
  const set = <K extends keyof IdentityDraft>(field: K, value: IdentityDraft[K]) => onChange({ ...draft, [field]: value })
  const name = (field: string) => `${prefix}${field}`
  return (
    <div className="fw-pty-form">
      {withDate && (
        <Field label={t('field.validFrom')} required={!dateOptional} hint={t(dateOptional ? 'field.validFromToday' : 'field.validFromHint')} error={shown(name('validFrom'))}>
          <DateField value={draft.validFrom} onChange={(value) => set('validFrom', value)} ariaLabel={t('field.validFrom')} />
        </Field>
      )}
      {withCountry && (
        <Field label={t('field.taxCountry')} required error={shown(name('country'))}>
          <CountrySelect
            value={draft.country}
            onChange={(value) => onChange({ ...draft, country: value, taxMode: blankIdentity(value, draft.vatNumber !== '' || draft.taxMode.endsWith('B2B')).taxMode })}
            onBlur={() => leave(name('country'))}
          />
        </Field>
      )}
      <Field label={t('field.taxMode')} required hint={t(`taxModeHint.${draft.taxMode}`)} error={shown(name('taxMode'))}>
        <Select value={draft.taxMode} onChange={(event) => set('taxMode', event.target.value as TaxMode)}>
          {PARTY_TAX_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`taxMode.${mode}`)}
            </option>
          ))}
        </Select>
      </Field>
      {fields.vat && (
        <Field
          label={t(draft.taxMode === 'EXTRA_EU' ? 'field.foreignTaxId' : 'field.vatNumber')}
          required={draft.taxMode !== 'EXTRA_EU'}
          hint={t(`field.vatHint.${draft.taxMode}`)}
          error={shown(name('vatNumber'))}
        >
          <Input className="fw-pty-code" value={draft.vatNumber} autoComplete="off" onChange={(event) => set('vatNumber', event.target.value)} onBlur={() => leave(name('vatNumber'))} />
        </Field>
      )}
      {fields.fiscal && (
        <Field label={t('field.fiscalCode')} required={draft.taxMode === 'IT_B2C'} hint={t('field.fiscalCodeHint')} error={shown(name('fiscalCode'))}>
          <Input className="fw-pty-code" value={draft.fiscalCode} autoComplete="off" onChange={(event) => set('fiscalCode', event.target.value)} onBlur={() => leave(name('fiscalCode'))} />
        </Field>
      )}
      {fields.sdi && (
        <>
          <Field label={t('field.sdi')} hint={t('field.sdiHint')} error={shown(name('sdiRecipientCode'))}>
            <Input
              className="fw-pty-code"
              value={draft.sdiRecipientCode}
              autoComplete="off"
              maxLength={10}
              onChange={(event) => set('sdiRecipientCode', event.target.value.toUpperCase())}
              onBlur={() => leave(name('sdiRecipientCode'))}
            />
          </Field>
          <Field label={t('field.pec')} hint={t('field.pecHint')} error={shown(name('pec'))}>
            <Input type="email" value={draft.pec} autoComplete="off" onChange={(event) => set('pec', event.target.value)} onBlur={() => leave(name('pec'))} />
          </Field>
        </>
      )}
    </div>
  )
}

function Footer({ onCancel, submit, label, held, busy }: { onCancel: () => void; submit: () => void; label: ReactNode; held: string | null; busy?: boolean }) {
  const t = useT('parties')
  return (
    <>
      <SubmitHint />
      <span className="grow" />
      <Button onClick={onCancel}>{t('common.cancel')}</Button>
      <Button variant="primary" onClick={submit} heldReason={busy ? t('common.saving') : held}>
        {busy && <Spinner size={12} />} {label}
      </Button>
    </>
  )
}

// ---- New customer / supplier ------------------------------------------------------------------------------------------

export interface NewPartyActions {
  /** Look for parties with this VAT number or name (the duplicate warning). */
  onLookup?: (q: string) => void
  /** Resolve true when created. */
  onCreate?: (draft: NewPartyDraft) => Promise<boolean>
  onClose?: () => void
}

export function NewPartyModal({
  side,
  prefix,
  open,
  busy,
  problem,
  refused,
  duplicates,
  canVies,
  initial,
  companies = [],
  actions,
}: {
  side: Side
  prefix: string
  open: boolean
  busy?: boolean
  problem?: string | null
  refused?: readonly string[]
  duplicates?: readonly PartyRow[]
  canVies: boolean
  initial?: NewPartyDraft
  /** The companies the person works in: asked "belongs to" only when there are several. */
  companies?: ReadonlyArray<{ id: string; name: string }>
  actions?: NewPartyActions
}) {
  const t = useT('parties')
  const config = SIDES[side]
  const [draft, setDraft] = useState<NewPartyDraft>(initial ?? blankNewParty(config))
  const problems = newPartyProblems(draft)
  const form = useShown(problems, refused)
  useEffect(() => {
    if (open) {
      setDraft(initial ?? blankNewParty(config))
      form.reset()
    }
  }, [open])
  const submit = () => {
    form.setTried(true)
    if (isReady(problems) && !busy) void actions?.onCreate?.(draft)
  }
  const setParty = (party: PartyDraft) => {
    const named = party.tradeName.trim() || party.legalName
    setDraft((current) => ({ ...current, party: current.codeTouched ? party : { ...party, code: suggestCode(named) } }))
  }
  const eu = draft.identity.taxMode === 'EU_B2B'
  const count = Object.keys(problems).length
  // A refused create because another party holds the number: the other record(s) at the top, in the refusal's banner.
  const conflict = problem === 'new.conflictNumber' && !!duplicates && duplicates.length > 0
  const duplicateList =
    duplicates && duplicates.length > 0 ? (
      <Banner tone={conflict ? 'danger' : 'warning'} title={conflict ? t('new.conflictNumber') : t('new.duplicate', { count: duplicates.length })}>
        <ul className="fw-pty-list">
          {duplicates.map((row) => {
            const other = row.roles.some((role) => SIDES.customers.roles.includes(role)) ? 'customers' : 'suppliers'
            return (
              <li key={row.id}>
                <Link className="fw-pty-name" href={recordHref(prefix, SIDES[other], row.id)}>
                  <span className="fw-pty-code">{row.code}</span> {row.tradeName ?? row.legalName}
                </Link>
                <RoleTags roles={row.roles} />
                <StatusPill status={row.status} />
              </li>
            )
          })}
        </ul>
        <p className="fw-pty-hint">{t('new.duplicateHint')}</p>
      </Banner>
    ) : null
  return (
    <Modal
      open={open}
      onClose={() => actions?.onClose?.()}
      title={t(`${side}.new.title`)}
      subtitle={t(`${side}.new.subtitle`)}
      size="lg"
      busy={busy}
      footer={<Footer onCancel={() => actions?.onClose?.()} submit={submit} label={t(`${side}.new.go`)} held={form.tried && count > 0 ? t('form.fixFirst', { count }) : null} busy={busy} />}
    >
      <form
        className="fw-pty-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={submitKeys(submit)}
      >
        {problem && !conflict && <Banner tone="danger" title={t(problem)} />}
        {conflict && duplicateList}
        <fieldset className="fw-pty-pick">
          <legend>{t('new.taxFirst')}</legend>
          <p className="fw-pty-hint">{t('new.taxFirstHint')}</p>
          <IdentityFields
            draft={{ ...draft.identity, country: draft.party.country }}
            prefix="identity."
            shown={form.shown}
            leave={(field) => {
              form.leave(field)
              const typed = field === 'identity.vatNumber' ? draft.identity.vatNumber : field === 'identity.fiscalCode' ? draft.identity.fiscalCode : ''
              if (typed.trim().length >= 5) actions?.onLookup?.(typed.trim())
            }}
            onChange={(identity) => {
              const country = identity.country
              setDraft((current) => ({
                ...current,
                identity,
                party: country !== current.party.country ? { ...current.party, country, language: languageOf(country), currency: current.party.currency } : current.party,
              }))
            }}
          />
          {eu && <Banner tone="info" title={t(canVies ? 'new.viesWillCheck' : 'new.viesNoRight')} />}
        </fieldset>
        {!conflict && duplicateList}
        <fieldset className="fw-pty-pick">
          <legend>{t('new.who')}</legend>
          <PartyFields
            draft={draft.party}
            side={side}
            withCountry={false}
            shown={form.shown}
            leave={(field) => {
              form.leave(field)
              if (field === 'legalName' && draft.party.legalName.trim().length >= 4) actions?.onLookup?.(draft.party.legalName.trim())
            }}
            onChange={(party) => {
              if (party.code !== draft.party.code) setDraft((current) => ({ ...current, party, codeTouched: true }))
              else setParty(party)
            }}
          />
        </fieldset>
        {companies.length > 1 && (
          <Field label={t('field.belongsTo')} hint={t('field.belongsToHint')}>
            <Select value={draft.companyId ?? ''} onChange={(event) => setDraft((current) => ({ ...current, companyId: event.target.value === '' ? null : event.target.value }))}>
              <option value="">{t('field.everyCompany')}</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <p className="fw-pty-hint">{t(`${side}.new.after`)}</p>
      </form>
    </Modal>
  )
}

// ---- Edit the party (customer Overview "Edit") ------------------------------------------------------------------------

export function EditPartyModal({
  side,
  open,
  busy,
  problem,
  refused,
  initial,
  onSave,
  onClose,
}: {
  side: Side
  open: boolean
  busy?: boolean
  problem?: string | null
  refused?: readonly string[]
  initial: PartyDraft
  onSave?: (draft: PartyDraft) => void
  onClose?: () => void
}) {
  const t = useT('parties')
  const [draft, setDraft] = useState<PartyDraft>(initial)
  const problems = partyProblems(draft)
  const form = useShown(problems, refused)
  useEffect(() => {
    if (open) {
      setDraft(initial)
      form.reset()
    }
  }, [open])
  const submit = () => {
    form.setTried(true)
    if (isReady(problems) && !busy) onSave?.(draft)
  }
  const count = Object.keys(problems).length
  return (
    <Modal
      open={open}
      onClose={() => onClose?.()}
      title={t('edit.title')}
      subtitle={t('edit.subtitle')}
      size="lg"
      busy={busy}
      footer={<Footer onCancel={() => onClose?.()} submit={submit} label={t('common.save')} held={form.tried && count > 0 ? t('form.fixFirst', { count }) : null} busy={busy} />}
    >
      <form
        className="fw-pty-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={submitKeys(submit)}
      >
        {problem && <Banner tone={problem === 'problem.conflict' ? 'warning' : 'danger'} title={t(problem)} />}
        <PartyFields draft={draft} onChange={setDraft} shown={form.shown} leave={form.leave} side={side} withTerms roles={['CUSTOMER', 'BRAND', 'SUPPLIER', 'SUBCONTRACTOR', 'CARRIER']} />
      </form>
    </Modal>
  )
}

// ---- Block, archive -----------------------------------------------------------------------------------------------------

/** Block one or several (one reason for all; the API blocks each with it). */
export function BlockModal({
  side,
  open,
  names,
  busy,
  problem,
  onBlock,
  onClose,
}: {
  side: Side
  open: boolean
  names: readonly string[]
  busy?: boolean
  problem?: string | null
  onBlock?: (reason: string) => void
  onClose?: () => void
}) {
  const t = useT('parties')
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) {
      setReason('')
      setTried(false)
    }
  }, [open])
  const issue = reasonProblem(reason, true)
  const submit = () => {
    setTried(true)
    if (!issue && !busy) onBlock?.(reason.trim())
  }
  return (
    <Modal
      open={open}
      onClose={() => onClose?.()}
      title={names.length > 1 ? t(`${side}.block.titleMany`, { count: names.length }) : t(`${side}.block.title`, { name: names[0] ?? '' })}
      size="md"
      busy={busy}
      footer={
        <>
          <SubmitHint />
          <span className="grow" />
          <Button onClick={() => onClose?.()}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={submit} heldReason={busy ? t('common.saving') : tried && issue ? t(issue) : null}>
            {names.length > 1 ? t('block.goMany', { count: names.length }) : t(`${side}.block.go`)}
          </Button>
        </>
      }
    >
      <form
        className="fw-pty-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={submitKeys(submit)}
      >
        {problem && <Banner tone="danger" title={t(problem)} />}
        <div>
          <p className="fw-pty-pop-title">{t('block.stops')}</p>
          <ul className="fw-pty-list">
            <li>{t(`${side}.block.stops1`)}</li>
            <li>{t(`${side}.block.stops2`)}</li>
          </ul>
        </div>
        {names.length > 1 && <p className="fw-pty-hint">{names.slice(0, 8).join(' · ') + (names.length > 8 ? ` · ${t('archive.andMore', { count: names.length - 8 })}` : '')}</p>}
        <Field label={t('block.reason')} required hint={t('block.reasonHint')} error={tried && issue ? t(issue) : undefined}>
          <Textarea rows={3} autoFocus value={reason} onChange={(event) => setReason(event.target.value)} onBlur={() => setTried(reason !== '' || tried)} />
        </Field>
        <p className="fw-pty-hint">{t('block.undo')}</p>
      </form>
    </Modal>
  )
}

/** Archive one or several (design customers.archive: the reach, the reversal). */
export function ArchiveModal({
  side,
  open,
  names,
  skipped,
  busy,
  problem,
  onArchive,
  onClose,
}: {
  side: Side
  open: boolean
  names: readonly string[]
  skipped?: number
  busy?: boolean
  problem?: string | null
  onArchive?: () => void
  onClose?: () => void
}) {
  const t = useT('parties')
  const one = names.length === 1
  return (
    <Modal
      open={open}
      onClose={() => onClose?.()}
      title={one ? t(`${side}.archive.titleOne`, { name: names[0]! }) : t(`${side}.archive.titleMany`, { count: names.length })}
      size="md"
      busy={busy}
      footer={
        <>
          <span className="grow" />
          <Button onClick={() => onClose?.()}>{t('common.cancel')}</Button>
          <Button variant="danger-outline" onClick={() => !busy && onArchive?.()} heldReason={busy ? t('common.saving') : names.length === 0 ? t('archive.nothing') : null}>
            {one ? t('archive.goOne') : t('archive.goMany', { count: names.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pty-modal-body">
        {problem && <Banner tone="danger" title={t(problem)} />}
        <div>
          <p className="fw-pty-pop-title">{t('archive.reach')}</p>
          <ul className="fw-pty-list">
            <li>{t(`${side}.archive.reach1`)}</li>
            <li>{t('archive.reach2')}</li>
          </ul>
        </div>
        <p className="fw-pty-hint">{t('archive.reversal')}</p>
        {!one && names.length > 0 && <p className="fw-pty-hint">{names.slice(0, 8).join(' · ') + (names.length > 8 ? ` · ${t('archive.andMore', { count: names.length - 8 })}` : '')}</p>}
        {skipped ? <Banner tone="info" title={t('archive.skipped', { count: skipped })} /> : null}
      </div>
    </Modal>
  )
}

// ---- Address, contact -------------------------------------------------------------------------------------------------

export function AddressModal({
  open,
  editing,
  busy,
  problem,
  refused,
  initial,
  partyCountry,
  first,
  onSave,
  onClose,
}: {
  open: boolean
  editing: boolean
  busy?: boolean
  problem?: string | null
  refused?: readonly string[]
  initial?: AddressDraft
  partyCountry: string
  first: boolean
  onSave?: (draft: AddressDraft) => void
  onClose?: () => void
}) {
  const t = useT('parties')
  const start = initial ?? blankAddress(partyCountry, first)
  const [draft, setDraft] = useState<AddressDraft>(start)
  const problems = addressDraftProblems(draft)
  const form = useShown(problems, refused)
  useEffect(() => {
    if (open) {
      setDraft(initial ?? blankAddress(partyCountry, first))
      form.reset()
    }
  }, [open])
  const set = <K extends keyof AddressDraft>(field: K, value: AddressDraft[K]) => setDraft((current) => ({ ...current, [field]: value }))
  const submit = () => {
    form.setTried(true)
    if (isReady(problems) && !busy) onSave?.(draft)
  }
  const count = Object.keys(problems).length
  const italian = draft.country === 'IT'
  return (
    <Modal
      open={open}
      onClose={() => onClose?.()}
      title={t(editing ? 'address.editTitle' : 'address.newTitle')}
      subtitle={editing ? t('address.sentKeepCopy') : undefined}
      size="lg"
      busy={busy}
      footer={
        <Footer onCancel={() => onClose?.()} submit={submit} label={t(editing ? 'common.save' : 'address.add')} held={form.tried && count > 0 ? t('form.fixFirst', { count }) : null} busy={busy} />
      }
    >
      <form
        className="fw-pty-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={submitKeys(submit)}
      >
        {problem && <Banner tone={problem === 'problem.conflict' ? 'warning' : 'danger'} title={t(problem)} />}
        <fieldset className="fw-pty-pick">
          <legend>{t('address.kinds')}</legend>
          <span className="fw-pty-checks">
            {ADDRESS_KINDS.map((kind) => (
              <Checkbox
                key={kind}
                label={t(`addressKind.${kind}`)}
                checked={draft.kinds.includes(kind)}
                onChange={(event) => set('kinds', event.target.checked ? ADDRESS_KINDS.filter((held) => held === kind || draft.kinds.includes(held)) : draft.kinds.filter((held) => held !== kind))}
              />
            ))}
          </span>
          {form.shown('kinds') && <span className="fw-pty-hint">{form.shown('kinds')}</span>}
        </fieldset>
        <div className="fw-pty-form">
          <Field label={t('field.addressName')} hint={t('field.addressNameHint')} error={form.shown('name')}>
            <Input value={draft.name} onChange={(event) => set('name', event.target.value)} onBlur={() => form.leave('name')} />
          </Field>
          <Field label={t('field.country')} required error={form.shown('country')}>
            <CountrySelect value={draft.country} onChange={(value) => set('country', value)} onBlur={() => form.leave('country')} />
          </Field>
          <Field label={t('field.line1')} required hint={t('field.line1Hint')} error={form.shown('line1')} className="fw-pty-form-wide">
            <Input autoFocus value={draft.line1} onChange={(event) => set('line1', event.target.value)} onBlur={() => form.leave('line1')} />
          </Field>
          <Field label={t('field.line2')} error={form.shown('line2')} className="fw-pty-form-wide">
            <Input value={draft.line2} onChange={(event) => set('line2', event.target.value)} onBlur={() => form.leave('line2')} />
          </Field>
          <Field label={t(italian ? 'field.cap' : 'field.postalCode')} required error={form.shown('postalCode')}>
            <Input value={draft.postalCode} onChange={(event) => set('postalCode', event.target.value)} onBlur={() => form.leave('postalCode')} />
          </Field>
          <Field label={t('field.city')} required error={form.shown('city')}>
            <Input value={draft.city} onChange={(event) => set('city', event.target.value)} onBlur={() => form.leave('city')} />
          </Field>
          <Field label={t(italian ? 'field.provinceIt' : 'field.province')} required={italian} hint={italian ? t('field.provinceHint') : undefined} error={form.shown('province')}>
            <Input
              value={draft.province}
              maxLength={italian ? 2 : 40}
              onChange={(event) => set('province', italian ? event.target.value.toUpperCase() : event.target.value)}
              onBlur={() => form.leave('province')}
            />
          </Field>
          <Field label={t('field.contactName')} error={form.shown('contactName')}>
            <Input value={draft.contactName} onChange={(event) => set('contactName', event.target.value)} onBlur={() => form.leave('contactName')} />
          </Field>
          <Field label={t('field.phone')} error={form.shown('phone')}>
            <Input type="tel" value={draft.phone} onChange={(event) => set('phone', event.target.value)} onBlur={() => form.leave('phone')} />
          </Field>
          <Field label={t('field.deliveryNotes')} hint={t('field.deliveryNotesHint')} error={form.shown('deliveryNotes')} className="fw-pty-form-wide">
            <Textarea rows={2} value={draft.deliveryNotes} onChange={(event) => set('deliveryNotes', event.target.value)} onBlur={() => form.leave('deliveryNotes')} />
          </Field>
        </div>
        {!editing && (
          <span className="fw-pty-checks">
            <Checkbox label={t('address.defaultBillTo')} checked={draft.isDefaultBillTo} onChange={(event) => set('isDefaultBillTo', event.target.checked)} />
            <Checkbox label={t('address.defaultShipTo')} checked={draft.isDefaultShipTo} onChange={(event) => set('isDefaultShipTo', event.target.checked)} />
          </span>
        )}
        {(form.shown('isDefaultBillTo') || form.shown('isDefaultShipTo')) && <Banner tone="warning" title={form.shown('isDefaultBillTo') ?? form.shown('isDefaultShipTo')} />}
      </form>
    </Modal>
  )
}

export function ContactModal({
  side,
  open,
  editing,
  busy,
  problem,
  refused,
  initial,
  others,
  onSave,
  onClose,
}: {
  side: Side
  open: boolean
  editing: boolean
  busy?: boolean
  problem?: string | null
  refused?: readonly string[]
  initial?: ContactDraft
  others: Parameters<typeof contactDraftProblems>[1]
  onSave?: (draft: ContactDraft) => void
  onClose?: () => void
}) {
  const t = useT('parties')
  const [draft, setDraft] = useState<ContactDraft>(initial ?? blankContact())
  const problems = contactDraftProblems(draft, others)
  const form = useShown(problems, refused)
  useEffect(() => {
    if (open) {
      setDraft(initial ?? blankContact())
      form.reset()
    }
  }, [open])
  const set = <K extends keyof ContactDraft>(field: K, value: ContactDraft[K]) => setDraft((current) => ({ ...current, [field]: value }))
  const submit = () => {
    form.setTried(true)
    if (isReady(problems) && !busy) onSave?.(draft)
  }
  const count = Object.keys(problems).length
  return (
    <Modal
      open={open}
      onClose={() => onClose?.()}
      title={t(editing ? 'contact.editTitle' : 'contact.newTitle')}
      size="md"
      busy={busy}
      footer={
        <Footer onCancel={() => onClose?.()} submit={submit} label={t(editing ? 'common.save' : 'contact.add')} held={form.tried && count > 0 ? t('form.fixFirst', { count }) : null} busy={busy} />
      }
    >
      <form
        className="fw-pty-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={submitKeys(submit)}
      >
        {problem && <Banner tone={problem === 'problem.conflict' ? 'warning' : 'danger'} title={t(problem)} />}
        <div className="fw-pty-form">
          <Field label={t('field.contactPerson')} required error={form.shown('name')}>
            <Input autoFocus value={draft.name} onChange={(event) => set('name', event.target.value)} onBlur={() => form.leave('name')} />
          </Field>
          <Field label={t('field.email')} hint={t('field.emailHint')} error={form.shown('email')}>
            <Input type="email" value={draft.email} onChange={(event) => set('email', event.target.value)} onBlur={() => form.leave('email')} />
          </Field>
          <Field label={t('field.phone')} error={form.shown('phone')}>
            <Input type="tel" value={draft.phone} onChange={(event) => set('phone', event.target.value)} onBlur={() => form.leave('phone')} />
          </Field>
          <Field label={t('field.contactLanguage')} error={form.shown('language')}>
            <LanguageSelect value={draft.language} onChange={(value) => set('language', value)} empty={t('field.partyLanguage')} />
          </Field>
        </div>
        <fieldset className="fw-pty-pick">
          <legend>{t('contact.roles')}</legend>
          <div className="fw-pty-pick-row">
            {CONTACT_ROLES.map((role) => (
              <Checkbox
                key={role}
                label={
                  <span className="fw-pty-cell">
                    <span>{t(`contactRole.${role}`)}</span>
                    <span className="fw-pty-hint">{t(`${side}.contactRoleHint.${role}`)}</span>
                  </span>
                }
                checked={draft.roles.includes(role)}
                onChange={(event) => set('roles', event.target.checked ? CONTACT_ROLES.filter((held) => held === role || draft.roles.includes(held)) : draft.roles.filter((held) => held !== role))}
              />
            ))}
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}

// ---- Tax identity (new from a date, or correct the one in force) ------------------------------------------------------

export function IdentityModal({
  open,
  mode,
  busy,
  problem,
  refused,
  initial,
  first = false,
  onSave,
  onClose,
}: {
  open: boolean
  mode: 'new' | 'correct'
  busy?: boolean
  problem?: string | null
  refused?: readonly string[]
  initial: IdentityDraft
  /** The party has no identity yet: the day may be left out (it starts today). */
  first?: boolean
  onSave?: (draft: IdentityDraft) => void
  onClose?: () => void
}) {
  const t = useT('parties')
  const [draft, setDraft] = useState<IdentityDraft>(initial)
  const problems = identityProblems(draft, mode === 'new' && !first)
  const form = useShown(problems, refused)
  useEffect(() => {
    if (open) {
      setDraft(initial)
      form.reset()
    }
  }, [open, mode])
  const submit = () => {
    form.setTried(true)
    if (isReady(problems) && !busy) onSave?.(draft)
  }
  const count = Object.keys(problems).length
  return (
    <Modal
      open={open}
      onClose={() => onClose?.()}
      title={t(mode === 'new' ? 'identity.newTitle' : 'identity.correctTitle')}
      subtitle={t(mode === 'new' ? 'identity.newSubtitle' : 'identity.correctSubtitle')}
      size="lg"
      busy={busy}
      footer={
        <Footer
          onCancel={() => onClose?.()}
          submit={submit}
          label={t(mode === 'new' ? 'identity.add' : 'common.save')}
          held={form.tried && count > 0 ? t('form.fixFirst', { count }) : null}
          busy={busy}
        />
      }
    >
      <form
        className="fw-pty-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={submitKeys(submit)}
      >
        {problem && <Banner tone={problem === 'problem.conflict' ? 'warning' : 'danger'} title={t(problem)} />}
        <IdentityFields draft={draft} onChange={setDraft} shown={form.shown} leave={form.leave} withDate={mode === 'new'} dateOptional={first} />
        <p className="fw-pty-hint">{t('identity.documentsKeep')}</p>
      </form>
    </Modal>
  )
}

// ---- Keyboard shortcuts, bulk runs --------------------------------------------------------------------------------------

export function ShortcutsModal({ open, keys, onClose }: { open: boolean; keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose?: () => void }) {
  const t = useT('parties')
  return (
    <Modal open={open} onClose={() => onClose?.()} title={t('keys.title')} size="sm" footer={<Button onClick={() => onClose?.()}>{t('common.close')}</Button>}>
      <dl className="fw-pty-keymap">
        {keys.map((entry) => (
          <Fragment key={entry.does}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does}</dd>
          </Fragment>
        ))}
      </dl>
    </Modal>
  )
}

/** A bulk run (Check VIES for N, Archive N): one call per row, a result per row; the dialog closes when it is done. */
export function BulkModal({ run, open, onClose }: { run: BulkRun | null | undefined; open: boolean; onClose?: () => void }) {
  const t = useT('parties')
  if (!run) return null
  const done = run.results.length
  return (
    <Modal
      open={open}
      onClose={() => onClose?.()}
      title={t(`bulk.${run.kind}.title`, { count: run.total })}
      size="md"
      closeHeld={run.done ? null : t('bulk.running')}
      footer={
        <Button variant="primary" onClick={() => onClose?.()} heldReason={run.done ? null : t('bulk.running')}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="fw-pty-modal-body">
        <p className="fw-pty-hint" role="status">
          {run.done ? t(`bulk.${run.kind}.done`, { done, total: run.total }) : t('bulk.progress', { done, total: run.total })}
        </p>
        {run.kind === 'vies' && <p className="fw-pty-hint">{t('bulk.vies.note', { max: BULK_MAX })}</p>}
        <ul className="fw-pty-results">
          {run.results.map((result) => (
            <li key={result.id}>
              <span className="fw-pty-code">{result.code}</span>
              <span>{result.name}</span>
              <Tag tone={result.tone}>{t(result.outcome)}</Tag>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
