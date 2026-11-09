'use client'

import type { ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { StepUpModel } from '../../../../admin/shared/model'
import { NS } from '../../../../admin/users/partners/model'
import type { PortalNotice } from '../model'
import '../portal.css'

/** The partner screens' own catalogue (and the DS words through ds-parts). */
export function PortalAccessMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[NS]}>{children}</WithMessages>
}

export const usePortalT = () => useT(NS)

/** A held reason in words: `right.<x>` names the right that is missing, anything else is the rule's own sentence. */
export function heldWords(t: (key: string, params?: Record<string, string | number>) => string, reason: string | null | undefined): string | null {
  if (!reason) return null
  return reason.startsWith('right.') ? t('held.needs', { right: t(reason) }) : t(reason)
}

/** One notice (a receipt or a refusal); a run over many people names each refused one with its problem. */
export function NoticeLine({ notice, onDismiss }: { notice: PortalNotice | null | undefined; onDismiss?: () => void }) {
  const t = usePortalT()
  if (!notice) return null
  const refused = notice.refused ?? []
  return (
    <Banner
      tone={notice.tone}
      title={refused.length > 0 ? `${t(notice.key, notice.params)} · ${t('notice.refused', { count: refused.length })}` : t(notice.key, notice.params)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    >
      {refused.length > 0 && (
        <ul className="fw-pa-list">
          {refused.map((row, index) => (
            <li key={`${row.name}-${index}`}>
              {row.name} — {t(row.problem)}
            </li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** The fresh code a change of access asks for (A1 §3.10), in these words. */
export function PortalStepUp({ model, onSubmit, onClose }: { model: StepUpModel | undefined; onSubmit?: (code: string) => void; onClose?: () => void }) {
  const t = usePortalT()
  if (!model) return null
  return (
    <StepUpModal
      open={model.open}
      title={t('stepUp.title')}
      sentence={t(model.sentence)}
      busy={model.busy}
      error={model.problem ? t(model.problem) : null}
      confirmLabel={t('stepUp.confirm')}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onClose?.()}
    />
  )
}
