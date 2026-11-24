'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Select } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { Holds } from '../api'
import { holdDraftProblem, REASONS, type DepthCan, type HoldDialog, type Read } from '../model'
import { useSay } from './parts'

/**
 * The hold window (B-W2b-324; SAL-023): Put on hold… asks the company, the reason and the words; Release… the words. F-CT-531 (ct-w2
 * W2.4): the old Hold card went — Terms & requirements' Hold section draws the holds (cu/record/view/terms/HoldSection.tsx); this window
 * stays the ONE hold window Terms and Money open (HoldDialogView). Fetches nothing.
 */

export interface HoldCardModel {
  readonly read: Read<Holds>
  readonly can: DepthCan
  readonly status: string
  readonly prefix: string
  readonly dialog: HoldDialog | null
  readonly companies: readonly { readonly id: string; readonly name: string }[]
}

export interface HoldCardActions {
  onPlace?: () => void
  onRelease?: (hold: Holds['holds'][number]) => void
  onDraft?: (dialog: HoldDialog) => void
  onConfirm?: () => void
  onClose?: () => void
  onRetry?: () => void
}

/** F-CM-301 (customer MONEY tab, 13-backend §4.2): exported — the Money tab's Credit & terms opens this same window (one state with Terms). */
export function HoldDialogView({ model, actions }: { model: HoldCardModel; actions?: HoldCardActions | undefined }) {
  const { t, say } = useSay()
  const dialog = model.dialog
  if (!dialog) return null
  const problem = holdDraftProblem(dialog.kind === 'place' ? dialog.draft : { words: dialog.draft.words }, dialog.kind)
  const shown = dialog.tried ? problem : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={dialog.kind === 'place' ? t('hold.dialog.place') : t('hold.dialog.release', { reason: t(`reason.${dialog.hold.reason}`) })}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('dialog.saving') : shown ? say(shown) : null}>
            {dialog.kind === 'place' ? t('hold.dialog.confirmPlace') : t('hold.dialog.confirmRelease')}
          </Button>
        </>
      }
    >
      <div className="fw-cdp-stack">
        {dialog.kind === 'place' ? (
          <>
            <Field label={t('hold.dialog.company')} hint={t('hold.dialog.companyHint')}>
              <Select value={dialog.draft.companyId ?? ''} onChange={(event) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, companyId: event.target.value === '' ? null : event.target.value } })}>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
                <option value="">{t('hold.everyCompany')}</option>
              </Select>
            </Field>
            <Field label={t('hold.dialog.reason')} required error={dialog.tried && !dialog.draft.reason ? say(problem) : undefined}>
              <Select value={dialog.draft.reason ?? ''} onChange={(event) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, reason: event.target.value === '' ? null : (event.target.value as (typeof REASONS)[number]) } })}>
                <option value="">{t('hold.dialog.pick')}</option>
                {REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`reason.${reason}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('hold.dialog.words')} required hint={t('hold.dialog.wordsHint')} error={dialog.tried && dialog.draft.reason && problem ? say(problem) : undefined}>
              <Textarea rows={3} value={dialog.draft.words} onChange={(event) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, words: event.target.value } })} />
            </Field>
            <Banner tone="warning" title={t('hold.dialog.stops')} />
          </>
        ) : (
          <>
            <p className="fw-cdp-hint">{dialog.hold.words}</p>
            <Field label={t('hold.dialog.releaseWords')} required hint={t('hold.dialog.releaseHint')} error={shown ? say(shown) : undefined}>
              <Textarea rows={3} value={dialog.draft.words} onChange={(event) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, words: event.target.value } })} />
            </Field>
          </>
        )}
        {dialog.failed ? <Banner tone="danger" title={t(dialog.failed)} /> : null}
      </div>
    </Modal>
  )
}
