'use client'

import { useEffect } from 'react'
import { Field } from '@nexus/ui/components'
import { Button, Input, Kbd, Select } from '@nexus/ui/primitives'
import { FileDropzone, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { PartyOption, RoundOption, StyleDetail } from '../api'
import { CHANGE_PRIORITIES, newRequestHeld, OFFICE_SOURCES, sourceHeld, type ChangePriority, type ChangesCan, type NewRequestDraft, type Notice, type OfficeSource, type Phrase } from '../model'
import { NoticeLine, useWords } from '../parts'
import { StylePicker, type StylePick } from './StylePicker'

/** New change request (design pop:changes.new): the style, what and why, who asked, photos. */
export interface NewRequestModel {
  draft: NewRequestDraft
  styles: StylePick
  style: { item: StyleDetail | null; reading: boolean; problem: string | null }
  /** The customers (CUSTOMER) or suppliers (SUPPLIER) to pick, read when that source is chosen (parties.view). */
  parties: { items: PartyOption[] | null; problem: string | null } | null
  /** The style's sample rounds (SAMPLE; sales.samples.view). */
  rounds: { items: RoundOption[] | null; problem: string | null } | null
  busy: boolean
  notice: Notice | null
  lines: readonly Phrase[]
  offline: boolean
}

export interface NewRequestActions {
  onDraft?: (patch: Partial<NewRequestDraft>) => void
  onFindStyles?: (q: string) => void
  onPickStyle?: (styleId: string | null) => void
  onSubmit?: () => void
  onClose?: () => void
}

const PHOTO_TYPES = '.jpg,.jpeg,.png,.webp,.heic'
const PHOTO_MAX = 15 * 1024 * 1024

/**
 * New change request (design products.changes pop:changes.new, ⌘↵ "Raise request"; from the band, the Style studio's ⋯ and
 * `?new=1&style=`): the style, who asked (the office, a customer, a sample round, a supplier — each picker with its own
 * right), the revision it is about (the style as it is by default), the priority, what should change and why, photos
 * (sent once the request is raised; files.upload). Raise request is held with the first reason.
 */
export function NewRequestDialog({ model, can, actions }: { model: NewRequestModel; can: ChangesCan; actions?: NewRequestActions }) {
  const { t, say } = useWords()
  const draft = model.draft
  const style = model.style.item
  const held = newRequestHeld(draft, style, can, model.offline)
  const heldText = model.busy ? t('common.working') : say(held)

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

  const partyLabel = draft.source === 'SUPPLIER' ? t('new.supplier') : t('new.customer')
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
            <span className="fw-chg-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <div className="fw-chg-form">
        <NoticeLine notice={model.notice} lines={model.lines} />
        <div className="fw-chg-form-grid">
          <StylePicker pick={model.styles} style={style} styleId={draft.styleId} held={can.styles ? null : t('held.needsRight', { right: t('right.product.styles.view') })} onFind={actions?.onFindStyles} onPick={actions?.onPickStyle} />
          <Field label={t('new.revision')} hint={t('new.revisionHint')}>
            <Select size="sm" value={draft.revisionId} disabled={!style} onChange={(event) => actions?.onDraft?.({ revisionId: event.target.value })}>
              <option value="">{t('revision.asItIs')}</option>
              {(style?.revisions ?? [])
                .filter((revision) => revision.status !== 'OBSOLETE')
                .sort((a, b) => b.revision - a.revision)
                .map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {t('revision.option', { revision: revision.revision, status: t(`revision.${revision.status}`) })}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('new.source')}>
            <Select size="sm" value={draft.source} onChange={(event) => actions?.onDraft?.({ source: event.target.value as OfficeSource, partyId: null, sampleRoundId: null })}>
              {OFFICE_SOURCES.map((source) => {
                const why = say(sourceHeld(source, can))
                return (
                  <option key={source} value={source} disabled={!!why}>
                    {why ? `${t(`source.${source}`)} — ${why}` : t(`source.${source}`)}
                  </option>
                )
              })}
            </Select>
          </Field>
          {(draft.source === 'CUSTOMER' || draft.source === 'SUPPLIER') && (
            <Field label={partyLabel} required hint={model.parties?.problem ? t(model.parties.problem) : undefined}>
              <Select size="sm" value={draft.partyId ?? ''} onChange={(event) => actions?.onDraft?.({ partyId: event.target.value || null })}>
                <option value="">{model.parties?.items === null ? t('common.loading') : draft.source === 'SUPPLIER' ? t('new.pickSupplier') : t('new.pickCustomer')}</option>
                {(model.parties?.items ?? []).map((party) => (
                  <option key={party.id} value={party.id}>
                    {party.code} · {party.tradeName ?? party.legalName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {draft.source === 'SAMPLE' && (
            <Field label={t('new.round')} required hint={!style ? t('new.heldStyle') : model.rounds?.problem ? t(model.rounds.problem) : undefined}>
              <Select size="sm" value={draft.sampleRoundId ?? ''} disabled={!style} onChange={(event) => actions?.onDraft?.({ sampleRoundId: event.target.value || null })}>
                <option value="">{model.rounds?.items === null ? t('common.loading') : model.rounds?.items?.length === 0 ? t('new.noRounds') : t('new.pickRound')}</option>
                {(model.rounds?.items ?? []).map((round) => (
                  <option key={round.id} value={round.id}>
                    {t('new.roundOption', { number: round.number, n: round.roundNo })}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('col.priority')}>
            <Select size="sm" value={draft.priority} onChange={(event) => actions?.onDraft?.({ priority: event.target.value as ChangePriority })}>
              {CHANGE_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`priority.${priority}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="fw-chg-wide">
            <Field label={t('new.what')} required>
              <Input size="sm" maxLength={200} value={draft.title} onChange={(event) => actions?.onDraft?.({ title: event.target.value })} placeholder={t('new.whatPlaceholder')} />
            </Field>
          </div>
          <div className="fw-chg-wide">
            <Field label={t('new.why')} required>
              <Textarea rows={4} maxLength={4000} value={draft.reason} onChange={(event) => actions?.onDraft?.({ reason: event.target.value })} placeholder={t('new.whyPlaceholder')} />
            </Field>
          </div>
          <div className="fw-chg-wide">
            <Field label={t('field.photos')} hint={can.files ? t('new.photosHint') : t('held.needsRight', { right: t('right.files.upload') })}>
              {can.files ? (
                <div className="fw-chg-stack">
                  <FileDropzone accept={PHOTO_TYPES} multiple maxBytes={PHOTO_MAX} hint={t('new.photosAdd')} onFiles={(files) => actions?.onDraft?.({ photos: [...draft.photos, ...files] })} />
                  {draft.photos.length > 0 && (
                    <div className="fw-chg-row">
                      <span className="fw-chg-hint">
                        {t('new.photosAdded', { count: draft.photos.length })}: {draft.photos.map((photo) => photo.name).join(', ')}
                      </span>
                      <Button size="xs" variant="quiet" onClick={() => actions?.onDraft?.({ photos: [] })}>
                        {t('new.photosClear')}
                      </Button>
                    </div>
                  )}
                </div>
              ) : null}
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  )
}
