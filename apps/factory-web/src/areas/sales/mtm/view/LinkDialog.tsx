'use client'

import { useId } from 'react'
import { Copy, Send } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { LINK_DAYS, linkHeld, type MtmCan } from '../model'
import { MtmMessages, NoticeLine, useSubmitKey, useWords } from '../parts'
import type { LinkDialogActions, LinkDialogModel } from '../view-model'

/**
 * Send a measurement link (design pop:mtm.link, the band's ⋯ and the Measurements tab; B-W2b-171's link): the rider (picked
 * from the list when opened from the band), the rider's address (empty: the rider's contact's), the language of the mail and
 * the page, whether the front, side and back photos are required, how long the link stays open, and "what the rider will see"
 * (the privacy notice first, the guided points, the photos, check and send). Send link mails it (FAKE locally); "Give me the
 * link" shows the address ONCE to pass on. The answer comes back as a new revision waiting for the factory review. ⌘↵ sends.
 * Fetches nothing.
 */
export function LinkDialog({ model, can, actions }: { model: LinkDialogModel; can: MtmCan; actions?: LinkDialogActions }) {
  return (
    <MtmMessages>
      <Dialog model={model} can={can} actions={actions} />
    </MtmMessages>
  )
}

function Dialog({ model, can, actions }: { model: LinkDialogModel; can: MtmCan; actions?: LinkDialogActions }) {
  const { t, say, when } = useWords()
  const ids = { rider: useId(), email: useId(), days: useId(), language: useId() }
  const held = say(linkHeld(model.draft, { can, offline: model.offline, hasContact: model.hasContact })) ?? (model.busy ? t('common.working') : !model.profileId ? t('link.held.rider') : null)
  const onKey = useSubmitKey(!model.sent, !!held, () => actions?.onSend?.())
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="lg"
      title={t('link.title')}
      subtitle={model.profileId ? t('link.sub', { rider: model.riderName, garment: model.garmentType }) : t('link.subPick')}
      footer={
        model.sent ? (
          <Button variant="primary" onClick={() => actions?.onClose?.()}>
            {t('common.close')}
          </Button>
        ) : (
          <span className="fw-mtm-actions">
            <Button variant="secondary" onClick={() => actions?.onClose?.()}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" heldReason={held} onClick={() => actions?.onSend?.()} aria-keyshortcuts="Meta+Enter">
              {model.busy ? <Spinner size={12} /> : <Send size={14} aria-hidden />} {model.draft.send ? t('link.send') : t('link.make')} <Kbd>⌘↵</Kbd>
            </Button>
          </span>
        )
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        <NoticeLine notice={model.notice} />
        {model.sent ? (
          <div className="fw-mtm-stack">
            <Banner tone={model.sent.delivery === 'FAILED' ? 'warning' : 'success'} title={model.sent.url ? t('link.made', { date: when(model.sent.link.expiresAt) }) : model.sent.delivery === 'FAILED' ? t('link.failed') : t('link.sent', { email: model.sent.link.email ?? t('link.theContact'), date: when(model.sent.link.expiresAt) })} />
            {model.sent.url && (
              <div className="fw-mtm-tight">
                <p className="fw-mtm-hint">{t('link.once')}</p>
                <p className="fw-mtm-url">{model.sent.url}</p>
                <span className="fw-mtm-actions">
                  <Button size="sm" variant="secondary" onClick={() => actions?.onCopy?.()}>
                    <Copy size={13} aria-hidden /> {model.copied ? t('link.copied') : t('link.copy')}
                  </Button>
                </span>
              </div>
            )}
            <p className="fw-mtm-hint">{t('link.comesBack')}</p>
          </div>
        ) : (
          <>
            {model.choices && (
              <Field label={t('link.rider')} required htmlFor={ids.rider} hint={t('link.riderHint')}>
                <Select id={ids.rider} size="sm" value={model.profileId} onChange={(event) => actions?.onPick?.(event.target.value)}>
                  <option value="">{t('link.riderPick', { count: model.choices.length })}</option>
                  {model.choices.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.riderName} · {row.customer.name} · {row.garmentType}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="fw-mtm-fields">
              <Field label={t('link.email')} htmlFor={ids.email} hint={model.hasContact ? t('link.emailHintContact') : t('link.emailHint')}>
                <Input id={ids.email} size="sm" type="email" autoComplete="off" value={model.draft.email} onChange={(event) => actions?.onDraft?.({ email: event.target.value })} />
              </Field>
              <Field label={t('link.language')} htmlFor={ids.language}>
                <Select id={ids.language} size="sm" value={model.draft.language} onChange={(event) => actions?.onDraft?.({ language: event.target.value === 'en' ? 'en' : 'it' })}>
                  <option value="it">{t('link.lang.it')}</option>
                  <option value="en">{t('link.lang.en')}</option>
                </Select>
              </Field>
              <Field label={t('link.days')} htmlFor={ids.days}>
                <Select id={ids.days} size="sm" value={String(model.draft.days)} onChange={(event) => actions?.onDraft?.({ days: Number(event.target.value) })}>
                  {LINK_DAYS.map((days) => (
                    <option key={days} value={days}>
                      {t('link.daysValue', { count: days })}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t('link.photos')}>
              <SegmentedControl
                ariaLabel={t('link.photos')}
                size="sm"
                value={model.draft.photos}
                onChange={(value) => actions?.onDraft?.({ photos: value === 'REQUIRED' ? 'REQUIRED' : 'OPTIONAL' })}
                options={[
                  { value: 'OPTIONAL', label: t('link.photosOptional') },
                  { value: 'REQUIRED', label: t('link.photosRequired') },
                ]}
              />
            </Field>
            <Checkbox checked={!model.draft.send} onChange={(event) => actions?.onDraft?.({ send: !event.target.checked })} label={t('link.dontMail')} />
            <section className="fw-mtm-preview fw-mtm-tight" aria-label={t('link.preview')}>
              <h3 className="fw-mtm-h3">{t('link.preview')}</h3>
              <ol className="fw-mtm-lines">
                <li>{t('link.see.notice')}</li>
                <li>{t('link.see.basics')}</li>
                <li>{model.pointCount === null ? t('link.see.pointsUnknown') : t('link.see.points', { count: model.pointCount })}</li>
                <li>{t('link.see.fit')}</li>
                <li>{model.draft.photos === 'REQUIRED' ? t('link.see.photosRequired') : t('link.see.photosOptional')}</li>
                <li>{t('link.see.send')}</li>
              </ol>
              <p className="fw-mtm-hint">{t('link.see.language', { language: t(`link.lang.${model.draft.language}`) })}</p>
            </section>
          </>
        )}
      </div>
    </Modal>
  )
}
