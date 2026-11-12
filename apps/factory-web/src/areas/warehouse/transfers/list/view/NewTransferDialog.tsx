'use client'

import { useEffect } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Kbd, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { newDraftHeld, sendingSites, type NewDraft, type Notice, type OptionSite, type Phrase, type TransfersCan } from '../../model'
import { NoticeLine, useWords } from '../../parts'

/**
 * New transfer (design pop:tr-new, from the band's primary): from site · to site · ship date · expected arrival, and where it
 * is picked from and put at. The transit place is the sending site's (asked only when it has several). Who carries the goods
 * (our own van or a carrier) is asked by Ship transfer, with the DDT: a draft has no DDT (factory-db: its transport is set
 * exactly from the ship on).
 */
export interface NewTransferModel {
  draft: NewDraft
  /** The tenant's sites (null: still being read). */
  sites: readonly OptionSite[] | null
  busy: boolean
  notice: Notice | null
  lines: readonly Phrase[]
  offline: boolean
}

export interface NewTransferActions {
  onDraft?: (patch: Partial<NewDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

export function NewTransferDialog({ model, can, actions }: { model: NewTransferModel; can: TransfersCan; actions?: NewTransferActions }) {
  const { t, say } = useWords()
  const draft = model.draft
  const held = newDraftHeld(draft, model.sites, can, model.offline)
  const heldText = model.busy ? t('common.working') : say(held)
  const from = model.sites?.find((site) => site.id === draft.fromSiteId) ?? null
  const to = model.sites?.find((site) => site.id === draft.toSiteId) ?? null
  const senders = sendingSites(model.sites ?? [])
  const destinations = (model.sites ?? []).filter((site) => site.active && site.id !== draft.fromSiteId)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held && !model.busy) {
        event.preventDefault()
        actions?.onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, model.busy, actions])

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('new.title')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {t('new.submit')}
            <span className="fw-trf-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <div className="fw-trf-form">
        <p className="fw-trf-hint">{t('new.intro')}</p>
        {model.sites === null ? (
          <Skeleton height={120} />
        ) : (
          <div className="fw-trf-form-grid">
            <Field label={t('new.from')} required hint={senders.length === 0 ? t('new.noSenders') : undefined}>
              <Select size="sm" value={draft.fromSiteId ?? ''} onChange={(event) => actions?.onDraft?.({ fromSiteId: event.target.value || null, transitLocationId: null, fromLocationId: null, ...(event.target.value === draft.toSiteId ? { toSiteId: null, toLocationId: null } : {}) })}>
                <option value="">{t('new.pickSite')}</option>
                {senders.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.code} · {site.name} — {site.companyName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.to')} required hint={to && from && to.companyId !== from.companyId ? t('new.interCompany', { company: to.companyName }) : undefined}>
              <Select size="sm" value={draft.toSiteId ?? ''} disabled={!from} onChange={(event) => actions?.onDraft?.({ toSiteId: event.target.value || null, toLocationId: null })}>
                <option value="">{t('new.pickSite')}</option>
                {destinations.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.code} · {site.name} — {site.companyName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.shipOn')}>
              <DateField value={draft.shipOn ?? ''} clearable onChange={(value) => actions?.onDraft?.({ shipOn: value || null })} />
            </Field>
            <Field label={t('new.expectedOn')}>
              <DateField value={draft.expectedOn ?? ''} clearable onChange={(value) => actions?.onDraft?.({ expectedOn: value || null })} />
            </Field>
            {from && from.transitPlaces.length > 1 && (
              <Field label={t('new.transit')} required hint={t('new.transitHint')}>
                <Select size="sm" value={draft.transitLocationId ?? ''} onChange={(event) => actions?.onDraft?.({ transitLocationId: event.target.value || null })}>
                  <option value="">{t('new.pickTransit')}</option>
                  {from.transitPlaces.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.code} · {place.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('new.fromPlace')} hint={t('new.fromPlaceHint')}>
              <Select size="sm" value={draft.fromLocationId ?? ''} disabled={!from} onChange={(event) => actions?.onDraft?.({ fromLocationId: event.target.value || null })}>
                <option value="">{t('new.anyPlace')}</option>
                {(from?.places ?? []).map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.code} · {place.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.toPlace')} hint={t('new.toPlaceHint')}>
              <Select size="sm" value={draft.toLocationId ?? ''} disabled={!to} onChange={(event) => actions?.onDraft?.({ toLocationId: event.target.value || null })}>
                <option value="">{t('new.laterPlace')}</option>
                {(to?.places ?? []).map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.code} · {place.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {from && from.transitPlaces.length === 0 && <Banner tone="warning" title={t('refusal.NO_TRANSIT_PLACE')} />}
        {from && from.transitPlaces.length === 1 && <p className="fw-trf-hint">{t('new.transitOne', { place: `${from.transitPlaces[0]!.code} · ${from.transitPlaces[0]!.name}` })}</p>}
        <Field label={t('new.note')}>
          <Textarea value={draft.note} rows={2} honourRows maxLength={2000} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
        </Field>
        <p className="fw-trf-hint">{t('new.transportLater')}</p>
        <NoticeLine notice={model.notice} lines={model.lines} />
      </div>
    </Modal>
  )
}
