'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MapPin, PlugZap, Printer as PrinterIcon, RotateCcw, ShieldOff, Truck, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, SegmentedControl, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { WithMessages } from '../../../../record-panels/i18n'
import { TRANSPORT_BY, type CarrierAccount, type Printer, type SiteSettings, type TransportBy } from '../api'
import {
  ADDRESS_FIELDS,
  ADDRESS_MAX,
  accountState,
  changedFields,
  chosenSite,
  FIELD_MAX,
  formOf,
  formProblems,
  printersFor,
  problemCount,
  siteAccounts,
  STATE_TONE,
  testMode,
  type AddressField,
  type AddressForm,
  type FieldId,
  type FieldProblems,
  type SettingsAbilities,
  type SettingsForm,
} from '../model'
import '../shipping-setup.css'

/** A part read beside the page (the accounts, the printers): loading while both are null. */
export interface Part<T> {
  value: T | null
  problem: string | null
}

export interface ShippingSettingsViewModel {
  /** `/w/<company>`. */
  prefix: string
  can: SettingsAbilities
  sites: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; items: SiteSettings[] }
  /** The site the address names (`?site=`); null: the first. */
  siteId: string | null
  /** The carrier accounts; null when the person cannot list them (no integrations.view). */
  accounts: Part<CarrierAccount[]> | null
  /** The site's printers; null when the person cannot list them (no print.view). */
  printers: Part<Printer[]> | null
  /** A new key starts the form again from the saved settings (another site, a save, a reload). */
  formKey: string
  busy: boolean
  /** When this page last saved (ISO): "All changes saved · 10:42". */
  savedAt: string | null
  notice: { tone: 'success' | 'info' | 'warning' | 'danger'; key: string } | null
  /** The settings changed meanwhile (409): the person's typing stays until they reload. */
  conflict: boolean
  /** What the server refused, by field. */
  serverProblems: FieldProblems
  timeZone?: string
  /** Design cases: the form as typed, problems shown, the discard prompt open. */
  draft?: SettingsForm
  tried?: boolean
  discardOpen?: boolean
}

export interface ShippingSettingsActions {
  onSite?: (siteId: string) => void
  onSave?: (form: SettingsForm) => void
  onRetry?: () => void
  onReload?: () => void
  onRetryPart?: (part: 'accounts' | 'printers') => void
  onDismissNotice?: () => void
}

/**
 * SCR-068 — Warehouse › Settings › Carriers & shipping (design warehouse.shipping; LOG-117, LOG-032): one site's shipping
 * settings, saved whole — the carrier account behind the labels (the company's own Sendcloud account; TEST while it is
 * a test one; it is connected, its keys replaced and disconnected in Admin › Connections, never here), the ship-from
 * and return addresses, what a new shipment starts with (who carries, carrier and service, the goods' appearance on the
 * DDT, the daily cut-off) and the packing station's two printers. A site picker when the person reaches several sites.
 * Read-only without shipping.settings.manage. Fetches nothing (ShippingSettingsPage reads and saves).
 */
export function ShippingSettingsView({ model, actions }: { model: ShippingSettingsViewModel; actions?: ShippingSettingsActions }) {
  return (
    <WithMessages namespaces={['shipping-setup']}>
      <Settings model={model} actions={actions} />
    </WithMessages>
  )
}

function Settings({ model, actions }: { model: ShippingSettingsViewModel; actions?: ShippingSettingsActions }) {
  const t = useT('shipping-setup')
  if (model.sites.status === 'loading') {
    return (
      <div className="fw-shipset" aria-busy="true">
        <p className="fw-shipset-hint" role="status">
          <Spinner size={14} /> {t('read.loading')}
        </p>
        <div className="fw-shipset-grid">
          {Array.from({ length: 4 }, (_, index) => (
            <Card key={index} padded>
              <div className="fw-shipset-stack">
                <Skeleton width={180} height={18} />
                <Skeleton height={32} />
                <Skeleton height={32} />
                <Skeleton height={32} />
              </div>
            </Card>
          ))}
        </div>
      </div>
    )
  }
  if (model.sites.status === 'error') {
    const forbidden = model.sites.problem === 'read.problem.forbidden'
    return (
      <div className="fw-shipset">
        <Card padded>
          <EmptyState
            icon={forbidden ? <ShieldOff size={24} aria-hidden /> : undefined}
            title={forbidden ? t('read.forbidden.title') : t('read.failed')}
            description={forbidden ? t('read.forbidden.body') : t(model.sites.problem)}
            action={
              forbidden ? undefined : (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  <RotateCcw size={13} aria-hidden /> {t('common.retry')}
                </Button>
              )
            }
          />
        </Card>
      </div>
    )
  }
  const site = chosenSite(model.sites.items, model.siteId)
  if (!site) {
    return (
      <div className="fw-shipset">
        <Card padded>
          <EmptyState icon={<MapPin size={24} aria-hidden />} title={t('noSites.title')} description={t('noSites.body')} />
        </Card>
      </div>
    )
  }
  return <SiteForm key={`${site.site.id}:${model.formKey}`} site={site} sites={model.sites.items} model={model} actions={actions} />
}

function SiteForm({ site, sites, model, actions }: { site: SiteSettings; sites: SiteSettings[]; model: ShippingSettingsViewModel; actions?: ShippingSettingsActions }) {
  const t = useT('shipping-setup')
  const locale = useLocale()
  const saved = useMemo(() => formOf(site.settings), [site.settings])
  const [draft, setDraft] = useState<SettingsForm>(() => model.draft ?? saved)
  const [tried, setTried] = useState(!!model.tried)
  const [discard, setDiscard] = useState(!!model.discardOpen)
  const formRef = useRef<HTMLFormElement>(null)
  const changed = changedFields(saved, draft)
  const dirty = changed.length > 0
  const problems = formProblems(draft)
  const editable = model.can.manage
  const accounts = model.accounts?.value ? siteAccounts(model.accounts.value, site.site.companyId) : null
  const state = accountState(draft.integrationAccountId, model.accounts ? (model.accounts.value ?? null) : null)
  const test = testMode(draft.integrationAccountId, accounts)

  /** A field's problem shown beside it: the server's (until the field changes), else the form's once it was changed or a save was tried. */
  const problemOf = (field: FieldId): string | undefined => {
    const server = model.serverProblems[field]
    if (server && !changed.includes(field)) return t(server)
    const own = problems[field]
    return own && (tried || changed.includes(field)) ? t(own) : undefined
  }

  const save = () => {
    if (!editable || model.busy) return
    setTried(true)
    if (problemCount(problems) > 0) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    actions?.onSave?.(draft)
  }
  const latest = useRef({ save, dirty, discard })
  latest.current = { save, dirty, discard }

  // ⌘S / Ctrl+S saves; Esc with unsaved changes asks before discarding them (never inside a dialog or a menu).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        if (!latest.current.dirty) return
        event.preventDefault()
        latest.current.save()
        return
      }
      if (event.key === 'Escape' && latest.current.dirty && !latest.current.discard && !target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) {
        event.preventDefault()
        setDiscard(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  const set = <K extends keyof SettingsForm>(field: K, value: SettingsForm[K]) => setDraft((current) => ({ ...current, [field]: value }))
  const setAddress = (part: 'sender' | 'returns', field: AddressField, value: string) =>
    setDraft((current) => ({ ...current, [part]: { ...current[part], [field]: field === 'country' ? value.toUpperCase() : value } }))

  const status = dirty
    ? t('status.unsaved', { count: changed.length })
    : model.savedAt
      ? t('status.saved', { time: formatTime(model.savedAt, { locale, timeZone: model.timeZone }) })
      : site.settings
        ? t('status.lastSaved', { when: formatDateTime(site.settings.updatedAt, { locale, timeZone: model.timeZone }) })
        : t('status.notSetUp')

  return (
    <form
      ref={formRef}
      className="fw-shipset"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <div className="fw-shipset-head">
        <div className="fw-shipset-head-text">
          <p className="fw-shipset-intro">{t('intro')}</p>
          <span className="fw-shipset-status" role="status">
            {status}
            {test && (
              <Pill tone="warning" title={t(`test.${test}`)}>
                {t('test.pill')}
              </Pill>
            )}
          </span>
        </div>
        {sites.length > 1 && (
          <label className="fw-shipset-site">
            <span className="fw-shipset-site-label">{t('site.label')}</span>
            <Select size="sm" aria-label={t('site.label')} value={site.site.id} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.site.id} value={entry.site.id}>
                  {t('site.option', { code: entry.site.code, name: entry.site.name })}
                  {entry.settings ? '' : ` · ${t('site.notSetUp')}`}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>

      {model.conflict && (
        <Banner
          tone="warning"
          title={t('conflict.title')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('conflict.reload')}
            </Button>
          }
        >
          {t('conflict.body')}
        </Banner>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {!site.settings && <Banner tone="info" title={editable ? t('new.title') : t('new.titleReadOnly')}>{editable ? t('new.body') : t('new.bodyReadOnly')}</Banner>}
      {!editable && site.settings && <Banner tone="info" title={t('readOnly.title')}>{t('readOnly.body')}</Banner>}

      <div className="fw-shipset-grid">
        <ConnectionCard site={site} draft={draft} accounts={accounts} model={model} actions={actions} state={state} editable={editable} problem={problemOf('integrationAccountId')} onAccount={(id) => set('integrationAccountId', id)} />

        <Section id="sender" icon={<MapPin size={16} aria-hidden />} title={t('sender.title')} intro={t('sender.intro')}>
          <AddressFields part="sender" address={draft.sender} editable={editable} problemOf={problemOf} onChange={setAddress} t={t} />
        </Section>

        <Section id="returns" icon={<Undo2 size={16} aria-hidden />} title={t('returns.title')} intro={t('returns.intro')}>
          {editable ? (
            <Checkbox checked={draft.returnDifferent} onChange={(event) => set('returnDifferent', event.target.checked)} label={t('returns.different')} />
          ) : null}
          {draft.returnDifferent ? (
            <AddressFields part="returns" address={draft.returns} editable={editable} problemOf={problemOf} onChange={setAddress} t={t} />
          ) : (
            <p className="fw-shipset-hint">{t('returns.same')}</p>
          )}
        </Section>

        <Section id="defaults" icon={<Truck size={16} aria-hidden />} title={t('defaults.title')} intro={t('defaults.intro')}>
          {editable ? (
            <div className="fw-shipset-fields">
              <Field label={t('defaults.transportBy')} hint={t(`defaults.transportHint.${draft.defaultTransportBy}`)} className="fw-shipset-wide">
                <SegmentedControl
                  ariaLabel={t('defaults.transportBy')}
                  value={draft.defaultTransportBy}
                  onChange={(value) => set('defaultTransportBy', value as TransportBy)}
                  options={TRANSPORT_BY.map((option) => ({ value: option, label: t(`transportBy.${option}`) }))}
                  wrap
                />
              </Field>
              <Field label={t('defaults.carrier')} hint={t('defaults.carrierHint')} error={problemOf('defaultCarrierCode')}>
                <Input value={draft.defaultCarrierCode} maxLength={FIELD_MAX.defaultCarrierCode} spellCheck={false} autoCapitalize="none" placeholder="brt" onChange={(event) => set('defaultCarrierCode', event.target.value)} />
              </Field>
              <Field label={t('defaults.service')} hint={t('defaults.serviceHint')} error={problemOf('defaultServiceCode')}>
                <Input value={draft.defaultServiceCode} maxLength={FIELD_MAX.defaultServiceCode} spellCheck={false} autoCapitalize="none" onChange={(event) => set('defaultServiceCode', event.target.value)} />
              </Field>
              <Field label={t('defaults.appearance')} hint={t('defaults.appearanceHint')} error={problemOf('defaultGoodsAppearance')}>
                <Input value={draft.defaultGoodsAppearance} maxLength={FIELD_MAX.defaultGoodsAppearance} placeholder={t('defaults.appearancePlaceholder')} onChange={(event) => set('defaultGoodsAppearance', event.target.value)} />
              </Field>
              <Field label={t('defaults.cutOff')} hint={t('defaults.cutOffHint')} error={problemOf('cutOffTime')}>
                <Input value={draft.cutOffTime} maxLength={FIELD_MAX.cutOffTime} inputMode="numeric" placeholder="17:00" onChange={(event) => set('cutOffTime', event.target.value)} />
              </Field>
            </div>
          ) : (
            <KeyValue
              items={[
                { label: t('defaults.transportBy'), value: t(`transportBy.${draft.defaultTransportBy}`) },
                { label: t('defaults.carrier'), value: draft.defaultCarrierCode || '—' },
                { label: t('defaults.service'), value: draft.defaultServiceCode || '—' },
                { label: t('defaults.appearance'), value: draft.defaultGoodsAppearance || '—' },
                { label: t('defaults.cutOff'), value: draft.cutOffTime || t('defaults.noCutOff') },
              ]}
            />
          )}
        </Section>

        <PrintersCard draft={draft} model={model} actions={actions} editable={editable} problemOf={problemOf} onPrinter={(slot, id) => set(slot, id)} />
      </div>

      {editable && dirty && (
        <div className="fw-shipset-savebar" role="region" aria-label={t('save.region')}>
          <span className="fw-shipset-savebar-text">
            {t('status.unsaved', { count: changed.length })}
            {tried && problemCount(problems) > 0 ? ` · ${t('save.problems', { count: problemCount(problems) })}` : ''}
          </span>
          <span className="fw-shipset-savebar-actions">
            <Button size="sm" variant="secondary" disabled={model.busy} onClick={() => setDiscard(true)}>
              {t('save.discard')}
            </Button>
            <Button size="sm" variant="primary" type="submit" aria-keyshortcuts="Meta+S Control+S" heldReason={model.busy ? t('save.busy') : null}>
              {model.busy ? <Spinner size={13} /> : null} {site.settings ? t('save.save') : t('save.create')}
            </Button>
          </span>
        </div>
      )}

      {discard && (
        <Modal
          open
          size="sm"
          title={t('discard.title')}
          onClose={() => setDiscard(false)}
          footer={
            <>
              <Button variant="secondary" data-autofocus onClick={() => setDiscard(false)}>
                {t('discard.keep')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setDraft(saved)
                  setTried(false)
                  setDiscard(false)
                }}
              >
                {t('discard.confirm', { count: changed.length })}
              </Button>
            </>
          }
        >
          <p>{t('discard.body', { count: changed.length })}</p>
        </Modal>
      )}
    </form>
  )
}

function Section({ id, icon, title, intro, wide, children }: { id: string; icon: ReactNode; title: string; intro?: string; wide?: boolean; children?: ReactNode }) {
  return (
    <Card padded className={wide ? 'fw-shipset-card fw-shipset-wide' : 'fw-shipset-card'}>
      <section className="fw-shipset-section" aria-labelledby={`shipset-${id}`}>
        <div className="fw-shipset-section-head">
          <h2 id={`shipset-${id}`} className="fw-shipset-h2">
            {icon} {title}
          </h2>
          {intro && <p className="fw-shipset-hint">{intro}</p>}
        </div>
        {children}
      </section>
    </Card>
  )
}

function AddressFields({
  part,
  address,
  editable,
  problemOf,
  onChange,
  t,
}: {
  part: 'sender' | 'returns'
  address: AddressForm
  editable: boolean
  problemOf: (field: FieldId) => string | undefined
  onChange: (part: 'sender' | 'returns', field: AddressField, value: string) => void
  t: Translate
}) {
  if (!editable) {
    const lines = [address.name, address.line1, address.line2, [address.postalCode, address.city, address.province ? `(${address.province})` : ''].filter(Boolean).join(' '), address.country].filter((line) => line.trim() !== '')
    return (
      <KeyValue
        items={[
          { label: t('address.label'), value: lines.length > 0 ? <span className="fw-shipset-lines">{lines.join('\n')}</span> : '—' },
          { label: t('address.phone'), value: address.phone || '—' },
          { label: t('address.email'), value: address.email || '—' },
        ]}
      />
    )
  }
  const required: readonly AddressField[] = ['name', 'line1', 'postalCode', 'city', 'country']
  const wide: readonly AddressField[] = ['name', 'line1', 'line2']
  return (
    <div className="fw-shipset-fields">
      {ADDRESS_FIELDS.map((field) => (
        <Field key={field} label={t(`address.${field}`)} required={required.includes(field)} hint={field === 'country' ? t('address.countryHint') : field === 'name' && part === 'sender' ? t('address.nameHint') : undefined} error={problemOf(`${part}.${field}`)} className={wide.includes(field) ? 'fw-shipset-wide' : undefined}>
          <Input
            value={address[field]}
            maxLength={ADDRESS_MAX[field]}
            autoComplete={AUTOCOMPLETE[field]}
            type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
            spellCheck={field === 'email' || field === 'country' ? false : undefined}
            onChange={(event) => onChange(part, field, event.target.value)}
          />
        </Field>
      ))}
    </div>
  )
}

const AUTOCOMPLETE: Readonly<Record<AddressField, string>> = {
  name: 'organization',
  line1: 'address-line1',
  line2: 'address-line2',
  postalCode: 'postal-code',
  city: 'address-level2',
  province: 'address-level1',
  country: 'country',
  phone: 'tel',
  email: 'email',
}

function ConnectionCard({
  site,
  draft,
  accounts,
  model,
  actions,
  state,
  editable,
  problem,
  onAccount,
}: {
  site: SiteSettings
  draft: SettingsForm
  accounts: CarrierAccount[] | null
  model: ShippingSettingsViewModel
  actions?: ShippingSettingsActions
  state: ReturnType<typeof accountState>
  editable: boolean
  problem: string | undefined
  onAccount: (id: string) => void
}) {
  const t = useT('shipping-setup')
  const locale = useLocale()
  const account = accounts?.find((entry) => entry.id === draft.integrationAccountId) ?? null
  const connections = model.can.openConnections ? `${model.prefix}/admin/connections${account ? `/${encodeURIComponent(account.id)}` : ''}` : null
  const reading = model.accounts !== null && model.accounts.value === null && model.accounts.problem === null

  let body: ReactNode
  if (model.accounts === null) {
    // No integrations.view: the account is named only as set or not; an administrator chooses it.
    body = <p className="fw-shipset-hint">{t(draft.integrationAccountId ? 'connection.setHidden' : 'connection.noneHidden')}</p>
  } else if (model.accounts.problem) {
    body = (
      <div className="fw-shipset-stack">
        <p className="fw-shipset-hint">{t('connection.readFailed', { problem: t(model.accounts.problem) })}</p>
        <span>
          <Button size="sm" onClick={() => actions?.onRetryPart?.('accounts')}>
            {t('common.retry')}
          </Button>
        </span>
      </div>
    )
  } else if (reading) {
    body = (
      <p className="fw-shipset-hint" role="status">
        <Spinner size={14} /> {t('connection.loading')}
      </p>
    )
  } else if (accounts && accounts.length === 0 && !draft.integrationAccountId) {
    body = (
      <EmptyState
        icon={<PlugZap size={22} aria-hidden />}
        title={t('connection.empty.title')}
        description={t('connection.empty.body')}
        action={
          connections ? (
            <Button size="sm" asChild>
              <Link href={connections}>{t('connection.manage')}</Link>
            </Button>
          ) : undefined
        }
      />
    )
  } else {
    const missing = draft.integrationAccountId !== '' && !account
    body = (
      <div className="fw-shipset-stack">
        {editable ? (
          <Field label={t('connection.account')} hint={t('connection.accountHint')} error={problem}>
            <Select value={draft.integrationAccountId} onChange={(event) => onAccount(event.target.value)}>
              <option value="">{t('connection.none')}</option>
              {(accounts ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t('connection.option', { label: entry.label, mode: t(`mode.${entry.mode}`) })}
                  {entry.status === 'PAUSED' ? ` · ${t('state.paused')}` : ''}
                </option>
              ))}
              {missing && <option value={draft.integrationAccountId}>{t('connection.missingOption')}</option>}
            </Select>
          </Field>
        ) : null}
        {account ? (
          <KeyValue
            items={[
              { label: t('connection.name'), value: account.label },
              { label: t('connection.mode'), value: t(`mode.${account.mode}`) },
              { label: t('connection.keys'), value: account.credentials.saved ? t('connection.keysSaved') : t('connection.keysMissing') },
              { label: t('connection.lastOk'), value: account.lastOkAt ? formatDateTime(account.lastOkAt, { locale, timeZone: model.timeZone }) : t('connection.never') },
              ...(account.lastErrorAt ? [{ label: t('connection.lastError'), value: formatDateTime(account.lastErrorAt, { locale, timeZone: model.timeZone }) }] : []),
            ]}
          />
        ) : !editable ? (
          <p className="fw-shipset-hint">{t(missing ? 'connection.missing' : 'connection.noneSet')}</p>
        ) : null}
        {state === 'test' && account && (
          <Banner tone="warning" title={t('test.bannerTitle')}>
            {t(`test.${account.mode}`)}
          </Banner>
        )}
        {state === 'paused' && <Banner tone="warning" title={t('state.pausedBody')} />}
        {state === 'noCredentials' && <Banner tone="danger" title={t('state.noCredentialsBody')} />}
        {missing && <Banner tone="danger" title={t('connection.missing')} />}
      </div>
    )
  }

  return (
    <Section id="connection" icon={<PlugZap size={16} aria-hidden />} title={t('connection.title')} intro={t('connection.intro', { site: site.site.name })}>
      <span className="fw-shipset-pills">
        <Pill tone={STATE_TONE[state]}>{t(`state.${state}`)}</Pill>
      </span>
      {body}
      <p className="fw-shipset-hint">
        {t('connection.where')}{' '}
        {connections ? (
          <Link className="fw-shipset-link" href={connections}>
            {t('connection.manage')}
          </Link>
        ) : (
          t('connection.askAdmin')
        )}
      </p>
    </Section>
  )
}

function PrintersCard({
  draft,
  model,
  actions,
  editable,
  problemOf,
  onPrinter,
}: {
  draft: SettingsForm
  model: ShippingSettingsViewModel
  actions?: ShippingSettingsActions
  editable: boolean
  problemOf: (field: FieldId) => string | undefined
  onPrinter: (slot: 'labelPrinterId' | 'documentPrinterId', id: string) => void
}) {
  const t = useT('shipping-setup')
  const devices = model.can.openDevices ? `${model.prefix}/admin/devices` : null
  const printers = model.printers?.value ?? null
  const slots = [
    { slot: 'labelPrinterId' as const, kind: 'LABEL_ZPL' as const },
    { slot: 'documentPrinterId' as const, kind: 'A4_PDF' as const },
  ]

  let body: ReactNode
  if (model.printers === null) {
    body = (
      <div className="fw-shipset-stack">
        <p className="fw-shipset-hint">{t('printers.hidden')}</p>
        <KeyValue items={slots.map(({ slot }) => ({ label: t(`printers.${slot}`), value: draft[slot] ? t('printers.set') : t(`printers.none.${slot}`) }))} />
      </div>
    )
  } else if (model.printers.problem) {
    body = (
      <div className="fw-shipset-stack">
        <p className="fw-shipset-hint">{t('printers.readFailed', { problem: t(model.printers.problem) })}</p>
        <span>
          <Button size="sm" onClick={() => actions?.onRetryPart?.('printers')}>
            {t('common.retry')}
          </Button>
        </span>
      </div>
    )
  } else if (printers === null) {
    body = (
      <p className="fw-shipset-hint" role="status">
        <Spinner size={14} /> {t('printers.loading')}
      </p>
    )
  } else {
    body = (
      <div className="fw-shipset-fields">
        {slots.map(({ slot, kind }) => {
          const options = printersFor(printers, kind)
          const current = draft[slot]
          const known = options.find((printer) => printer.id === current) ?? null
          const hint = options.length === 0 ? t(`printers.noneAtSite.${slot}`) : t(`printers.hint.${slot}`)
          if (!editable) {
            return (
              <KeyValue
                key={slot}
                items={[{ label: t(`printers.${slot}`), value: known ? t('printers.option', { code: known.code, name: known.name }) : current ? t('printers.unknown') : t(`printers.none.${slot}`) }]}
              />
            )
          }
          return (
            <Field key={slot} label={t(`printers.${slot}`)} hint={hint} error={problemOf(slot)}>
              <Select value={current} onChange={(event) => onPrinter(slot, event.target.value)}>
                <option value="">{t(`printers.none.${slot}`)}</option>
                {options.map((printer) => (
                  <option key={printer.id} value={printer.id}>
                    {t('printers.option', { code: printer.code, name: printer.name })}
                    {printer.status === 'PAUSED' ? ` · ${t('printers.paused')}` : ''}
                  </option>
                ))}
                {current && !known && <option value={current}>{t('printers.unknown')}</option>}
              </Select>
            </Field>
          )
        })}
      </div>
    )
  }

  return (
    <Section id="printers" icon={<PrinterIcon size={16} aria-hidden />} title={t('printers.title')} intro={t('printers.intro')}>
      {body}
      {devices && (
        <p className="fw-shipset-hint">
          <Link className="fw-shipset-link" href={devices}>
            {t('printers.manage')}
          </Link>
        </p>
      )}
    </Section>
  )
}
