'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, NumberStepper, Pill, RadioCard, Tag, Textarea } from '@nexus/ui/primitives'
import { DateTimeField } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, type Words } from '../../queue/shared/depth'
import { DepthDialog, PartRead } from '../../queue/shared/DepthDialog'
import type { PickupAddress, PickupDraft, PickupRow } from '../api'
import { DISPATCH_NAMESPACES, DISPATCH_NS, kilograms } from '../dispatch'
import { ADDRESS_MAX, ADDRESS_PARTS, bookHeld, formProblems, moveHeld, PICKUP_MAX, PICKUP_VIAS, pickupLine, readyOnSite, viaHeld, viaWords, WEEKDAYS, type PickupDialogActions, type PickupDialogModel, type PickupField, type PickupForm, type PickupMove } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'
import '../dispatch.css'

const STATUS_TONE = { REQUESTED: 'info', CONFIRMED: 'success', FAILED: 'danger', CANCELLED: 'neutral' } as const

/**
 * SCR-650 — Book a pickup (B-W2b-412 on B-W2b-395; LOG-048; design warehouse.shipments pop-up sh-pickup "ready time · parcels
 * or pallets · site address · recurring", opened from ⋯ and the selection row): through the company's Sendcloud connection
 * (a site in test mode books the TEST pickup: nothing is sent) or booked by phone with the carrier (with whom; the carrier's
 * regular round on its weekdays), the parcels and pallets of the selected shipments (those left out said with why), when the
 * goods are ready on the site's clock, where the driver collects. The carrier's answer is said (booked, waiting, or failed with
 * its words: a failure stays visible). The pickups already coming today for the site: confirm by hand, failed, call off.
 */
export function PickupDialog({ model, actions }: { model: PickupDialogModel; actions?: PickupDialogActions }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <Dialog model={model} actions={actions} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: PickupDialogModel; actions?: PickupDialogActions }) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words | null | undefined) => (value ? t(value.key, value.params) : null)
  const close = () => actions?.onClose?.()
  if (model.draft.state !== 'ready' || !model.form) {
    return (
      <DepthDialog title={t('pickup.title')} held={t('pickup.held.reading')} onGo={() => undefined} goLabel={t('pickup.go')} onClose={close} problem={null}>
        <PartRead problem={model.draft.state === 'error' ? model.draft.problem : null} onRetry={actions?.onRetry} label={t('pickup.title')} />
      </DepthDialog>
    )
  }
  const draft = model.draft.value
  const form = model.form
  const problems = formProblems(form)
  const shown = (field: PickupField) => (model.tried ? say(problems[field]) : null) ?? undefined
  const done = model.booked ? <Booked row={model.booked} weightKg={form.weightKg} /> : undefined
  return (
    <DepthDialog
      title={t('pickup.titleAt', { site: draft.site.code })}
      subtitle={draft.site.name}
      held={say(bookHeld(form, draft, model.can, model.busy))}
      onGo={() => actions?.onBook?.()}
      goLabel={form.via === 'SENDCLOUD' && draft.testMode ? t('pickup.goTest') : form.via === 'PHONE' ? t('pickup.goPhone') : t('pickup.go')}
      onClose={close}
      problem={say(model.problem)}
      done={done}
      size="lg"
    >
      {draft.testMode && <Banner tone="warning" title={t('pickup.testMode')} />}
      <Selection draft={draft} />
      <Ways draft={draft} form={form} actions={actions} />
      <div className="fw-shd-fields">
        <Field label={t('pickup.carrier')} hint={draft.carrierName && draft.carrierCode === form.carrierCode ? t('pickup.carrierHint', { name: draft.carrierName }) : t('pickup.carrierCodeHint')} error={shown('carrierCode')} required>
          <Input value={form.carrierCode} maxLength={40} spellCheck={false} autoCapitalize="none" placeholder="brt" onChange={(event) => actions?.onForm?.({ carrierCode: event.target.value })} />
        </Field>
        <ReadyField draft={draft} form={form} error={shown('readyAt')} actions={actions} />
        <Field label={t('pickup.parcels')} error={shown('parcels')}>
          <NumberStepper size="sm" min={0} max={PICKUP_MAX.count} value={form.parcels} onChange={(next) => actions?.onForm?.({ parcels: next })} aria-label={t('pickup.parcels')} decrementLabel={t('pickup.fewer')} incrementLabel={t('pickup.more')} />
        </Field>
        <Field label={t('pickup.pallets')}>
          <NumberStepper size="sm" min={0} max={PICKUP_MAX.count} value={form.pallets} onChange={(next) => actions?.onForm?.({ pallets: next })} aria-label={t('pickup.pallets')} decrementLabel={t('pickup.fewer')} incrementLabel={t('pickup.more')} />
        </Field>
        {form.via === 'SENDCLOUD' ? (
          <Field label={t('pickup.weight')} hint={draft.weightKg === null && draft.shipments.length > 0 ? t('pickup.weightUnknown') : t('pickup.weightHint')} error={shown('weightKg')}>
            <Input value={form.weightKg} inputMode="decimal" maxLength={9} onChange={(event) => actions?.onForm?.({ weightKg: event.target.value.replace(',', '.') })} />
          </Field>
        ) : (
          <Field label={t('pickup.reference')} hint={t('pickup.referenceHint')} error={shown('reference')}>
            <Input value={form.reference} maxLength={PICKUP_MAX.reference} onChange={(event) => actions?.onForm?.({ reference: event.target.value })} />
          </Field>
        )}
      </div>
      {form.via === 'PHONE' && (
        <Field label={t('pickup.note')} hint={t('pickup.noteHint')} error={shown('note')} required>
          <Textarea rows={2} value={form.note} maxLength={PICKUP_MAX.note} onChange={(event) => actions?.onForm?.({ note: event.target.value })} />
        </Field>
      )}
      <Recurring draft={draft} form={form} error={shown('weekdays')} actions={actions} />
      <Where draft={draft} form={form} shown={shown} actions={actions} />
      <Today model={model} draft={draft} actions={actions} />
    </DepthDialog>
  )
}

function Selection({ draft }: { draft: PickupDraft }) {
  const t = useT(DISPATCH_NS)
  if (draft.shipments.length === 0 && draft.skipped.length === 0) return <p className="fw-sh-hint">{t('pickup.byHand')}</p>
  return (
    <div className="fw-shd-stack">
      {draft.shipments.length > 0 && (
        <p className="fw-sh-hint">
          {t('pickup.fromShipments', { count: draft.shipments.length, numbers: draft.shipments.map((row) => row.number).join(', ') })}
        </p>
      )}
      {draft.skipped.length > 0 && (
        <Banner tone="info" title={t('pickup.skipped', { count: draft.skipped.length })}>
          <ul className="fw-sh-list">
            {draft.skipped.map((row) => (
              // The reason has no code: the API's own sentence.
              <li key={row.id}>
                {row.number ?? '—'}: {row.words}
              </li>
            ))}
          </ul>
        </Banner>
      )}
    </div>
  )
}

function Ways({ draft, form, actions }: { draft: PickupDraft; form: PickupForm; actions?: PickupDialogActions }) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words | null) => (value ? t(value.key, value.params) : null)
  return (
    <fieldset className="fw-shd-choices fw-shd-choices--grid">
      <legend className="fw-sh-hint">{t('pickup.how')}</legend>
      {PICKUP_VIAS.map((via) => {
        const held = say(viaHeld(draft, via))
        const description = held ?? (via === 'SENDCLOUD' ? t(draft.testMode ? 'pickup.way.SENDCLOUD.test' : 'pickup.way.SENDCLOUD.body') : t('pickup.way.PHONE.body'))
        return (
          <RadioCard
            key={via}
            name="pickup-via"
            value={via}
            checked={form.via === via}
            selected={form.via === via}
            disabled={!!held}
            onChange={() => actions?.onForm?.({ via })}
            title={t(`pickup.way.${via}.title`)}
            description={description}
          />
        )
      })}
    </fieldset>
  )
}

function ReadyField({ draft, form, error, actions }: { draft: PickupDraft; form: PickupForm; error: string | undefined; actions?: PickupDialogActions }) {
  const t = useT(DISPATCH_NS)
  const locale = useLocale()
  const wall = readyOnSite(form, draft.site.timeZone)
  return (
    <Field label={t('pickup.readyAt')} hint={wall ? t('pickup.readyHint', { day: formatDate(dayInstant(wall.day), { locale }), time: wall.time, site: draft.site.code }) : undefined} error={error} required>
      <DateTimeField value={form.readyAt} onChange={(value) => actions?.onForm?.({ readyAt: value })} min={new Date(Date.now() - PICKUP_MAX.pastSkewMs).toISOString()} stepMinutes={30} locale={INTL_LOCALE[locale]} ariaLabel={t('pickup.readyAt')} />
    </Field>
  )
}

function Recurring({ draft, form, error, actions }: { draft: PickupDraft; form: PickupForm; error: string | undefined; actions?: PickupDialogActions }) {
  const t = useT(DISPATCH_NS)
  if (form.via !== 'PHONE') return <p className="fw-sh-hint">{t('pickup.recurringPhoneOnly')}</p>
  return (
    <div className="fw-shd-stack">
      <Checkbox checked={form.recurring} disabled={!draft.vias.PHONE.recurring} onChange={(event) => actions?.onForm?.({ recurring: event.target.checked })} label={t('pickup.recurring')} />
      {form.recurring && (
        <fieldset className="fw-shd-choices">
          <legend className="fw-sh-hint">{t('pickup.weekdays')}</legend>
          <span className="fw-shd-actions">
            {WEEKDAYS.map((day) => (
              <Checkbox
                key={day}
                checked={form.weekdays.includes(day)}
                onChange={(event) => actions?.onForm?.({ weekdays: event.target.checked ? [...form.weekdays, day] : form.weekdays.filter((entry) => entry !== day) })}
                label={t(`pickup.weekday.${day}`)}
              />
            ))}
          </span>
          {error && <p className="fw-dsp-error">{error}</p>}
        </fieldset>
      )}
    </div>
  )
}

function addressLines(address: PickupAddress | null): string {
  if (!address) return ''
  return [address.name, address.line1, address.line2, [address.postalCode, address.city, address.province ? `(${address.province})` : ''].filter(Boolean).join(' '), address.country].filter((line) => typeof line === 'string' && line.trim() !== '').join('\n')
}

function Where({ draft, form, shown, actions }: { draft: PickupDraft; form: PickupForm; shown: (field: PickupField) => string | undefined; actions?: PickupDialogActions }) {
  const t = useT(DISPATCH_NS)
  return (
    <div className="fw-shd-stack">
      {draft.address ? (
        <>
          <KeyValue labelCase="sentence" items={[{ label: t('pickup.address'), value: <span className="fw-dsp-lines">{addressLines(draft.address)}</span> }]} />
          <Checkbox checked={form.otherAddress} onChange={(event) => actions?.onForm?.({ otherAddress: event.target.checked })} label={t('pickup.otherAddress')} />
        </>
      ) : (
        <Banner tone="warning" title={t('pickup.refusal.NO_SETTINGS')} />
      )}
      {form.otherAddress && (
        <div className="fw-shd-fields">
          {ADDRESS_PARTS.map((part) => (
            <Field key={part} label={t(`pickup.addressPart.${part}`)} error={shown(`address.${part}`)} required={part !== 'province' && part !== 'phone'} hint={part === 'country' ? t('pickup.countryHint') : undefined}>
              <Input value={form.address[part]} maxLength={ADDRESS_MAX[part]} type={part === 'phone' ? 'tel' : 'text'} onChange={(event) => actions?.onForm?.({ address: { ...form.address, [part]: part === 'country' ? event.target.value.toUpperCase() : event.target.value } })} />
            </Field>
          ))}
        </div>
      )}
    </div>
  )
}

/** The pickups already coming today for the site: a second one is rarely meant; each may be confirmed, failed or called off. */
function Today({ model, draft, actions }: { model: PickupDialogModel; draft: PickupDraft; actions?: PickupDialogActions }) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words | null) => (value ? t(value.key, value.params) : null)
  if (draft.alreadyToday.length === 0 && !model.moved) return null
  return (
    <section className="fw-shd-check" aria-label={t('pickup.today')}>
      <h3 className="fw-dsp-h3">{t('pickup.today')}</h3>
      {model.moved && (
        <p className="fw-sh-hint" role="status">
          {say(model.moved)}
        </p>
      )}
      <ul className="fw-shd-hold-list">
        {draft.alreadyToday.map((row) => (
          <li key={row.id} className="fw-shd-hold">
            <PickupHead row={row} />
            {model.move?.pickupId === row.id ? (
              <MoveForm model={model} row={row} move={model.move.move} text={model.move.text} actions={actions} />
            ) : (
              <span className="fw-shd-actions">
                {(['CONFIRMED', 'FAILED', 'CANCELLED'] as const).map((move) => {
                  const allowance = move === 'CONFIRMED' ? row.may.confirm : move === 'FAILED' ? row.may.fail : row.may.cancel
                  if (!allowance.allowed && allowance.refusal?.code === 'FINAL') return null
                  if (move === 'CONFIRMED' && row.status !== 'REQUESTED') return null
                  return (
                    <Button key={move} size="sm" variant={move === 'CANCELLED' ? 'quiet' : 'secondary'} heldReason={say(moveHeld(row, move, model.can, model.busy))} onClick={() => actions?.onMove?.({ pickupId: row.id, move, text: '' })}>
                      {t(`pickup.move.${move}`)}
                    </Button>
                  )
                })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function PickupHead({ row }: { row: PickupRow }) {
  const t = useT(DISPATCH_NS)
  const line = pickupLine(row)
  const via = viaWords(row)
  return (
    <>
      <span className="fw-shd-hold-head">
        <span className="fw-shd-actions">
          <Pill tone={STATUS_TONE[row.status]}>{t(`pickup.status.${row.status}`)}</Pill>
          <strong>{t(line.key, line.params)}</strong>
          <span className="fw-sh-hint">{row.carrierName}</span>
        </span>
        <span className="fw-shd-chips">
          <Tag tone={row.test ? 'warning' : 'neutral'}>{t(via.key, via.params)}</Tag>
          {row.recurring && <Tag tone="info">{t('pickup.everyWeek', { days: row.repeatWeekdays.map((day) => t(`pickup.weekdayShort.${day}`)).join(' ') })}</Tag>}
        </span>
      </span>
      <span className="fw-sh-hint">
        {t('pickup.counts', { parcels: row.parcels, pallets: row.pallets })}
        {row.providerReference ? ` · ${t('pickup.ref', { reference: row.providerReference })}` : ''}
      </span>
      {/* A failure keeps the carrier's (or the person's) own words: they have no code. */}
      {row.status === 'FAILED' && row.errorWords && <span className="fw-shd-hold-words">{row.errorWords}</span>}
      {row.note && <span className="fw-shd-hold-words">{t('pickup.noteShown', { note: row.note })}</span>}
    </>
  )
}

function MoveForm({ model, row, move, text, actions }: { model: PickupDialogModel; row: PickupRow; move: PickupMove; text: string; actions?: PickupDialogActions }) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words | null) => (value ? t(value.key, value.params) : null)
  const needsWords = move === 'FAILED'
  const held = say(moveHeld(row, move, model.can, model.busy)) ?? (needsWords && text.trim() === '' ? t('pickup.held.words') : null)
  return (
    <div className="fw-shd-stack">
      <Field label={t(needsWords ? 'pickup.moveWhy' : 'pickup.moveWords')} required={needsWords}>
        <Textarea rows={2} value={text} maxLength={PICKUP_MAX.words} onChange={(event) => actions?.onMove?.({ pickupId: row.id, move, text: event.target.value })} />
      </Field>
      {move === 'CANCELLED' && row.via === 'SENDCLOUD' && !row.test && <p className="fw-sh-hint">{t('pickup.cancelSendcloud')}</p>}
      <span className="fw-shd-actions">
        <Button size="sm" variant={move === 'CANCELLED' ? 'danger' : 'primary'} heldReason={held} onClick={() => actions?.onMoveGo?.()}>
          {t(`pickup.moveGo.${move}`)}
        </Button>
        <Button size="sm" variant="quiet" onClick={() => actions?.onMove?.(null)}>
          {t('pickup.moveBack')}
        </Button>
      </span>
    </div>
  )
}

function Booked({ row, weightKg }: { row: PickupRow; weightKg: string }) {
  const t = useT(DISPATCH_NS)
  const locale = useLocale()
  const weight = kilograms(weightKg, locale)
  return (
    <div className="fw-shd-stack" role="status">
      <Banner tone={row.status === 'FAILED' ? 'danger' : row.status === 'REQUESTED' ? 'info' : 'success'} title={t(`pickup.done.${row.status}`, { time: row.readyTime, carrier: row.carrierName })}>
        {row.status === 'FAILED' && row.errorWords ? row.errorWords : row.test ? t('pickup.done.test') : null}
      </Banner>
      <PickupHead row={row} />
      {weight && row.via === 'SENDCLOUD' && <p className="fw-sh-hint">{t('pickup.weightTold', { weight })}</p>}
      {row.status === 'FAILED' && <p className="fw-sh-hint">{t('pickup.done.failedNext')}</p>}
    </div>
  )
}
