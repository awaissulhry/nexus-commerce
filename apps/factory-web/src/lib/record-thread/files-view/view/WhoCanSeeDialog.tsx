'use client'

import { Users } from 'lucide-react'
import { RadioCard } from '@nexus/ui/primitives'
import { Modal } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'
import { actHeld, type FileActWindow, type FileActsState } from '../model'
import { ActFoot, ActLines, type FileActActions } from './FileActParts'

/**
 * F-OF-303 (10-design §7 "Who can see {name}"; L7): who can see one file or the chosen ones — Office only, or Office and <customer> (THIS
 * order's customer only) — and it TAKES A FILE BACK too (F6-B11); a floor or a link it has is said and stays (set on the work order, set by
 * an invite at the thread's head). files.manage only (the Owner, D5): the container hides the door without it. The bulk bar's "Who can
 * see N…" opens the same window (it replaced "Share N own").
 */
export function WhoCanSeeDialog({ window, state, actions }: { window: Extract<FileActWindow, { kind: 'whoCanSee' }>; state: FileActsState; actions?: FileActActions | undefined }) {
  const t = useT('record-thread-files-view')
  const party = state.party ?? ''
  const one = window.items.length === 1 ? window.items[0]! : null
  const floor = window.items.some((item) => item.visibility.includes('FLOOR'))
  const link = window.items.some((item) => item.visibility.includes('LINK'))
  const held = actHeld(window)
  return (
    <Modal
      open
      onClose={() => actions?.onActClose?.()}
      size="md"
      title={one ? t('acts.who.title', { name: one.name }) : t('acts.who.titleBulk', { count: window.items.length })}
      footer={<ActFoot held={held} busy={state.busy} label={t('acts.who.save')} icon={<Users size={14} aria-hidden />} onCancel={() => actions?.onActClose?.()} onGo={() => actions?.onActSubmit?.()} />}
    >
      <div className="fw-of-act-form">
        <fieldset className="fw-rtv-fieldset">
          <legend className="fw-rtv-legend">{t('upload.who')}</legend>
          <RadioCard name="fw-of-who" checked={window.to === 'OFFICE'} selected={window.to === 'OFFICE'} onChange={() => actions?.onActChange?.({ ...window, to: 'OFFICE' })} title={t('upload.audience.OFFICE')} description={t('upload.audience.OFFICEBody')} />
          {state.party && <RadioCard name="fw-of-who" checked={window.to === 'CUSTOMER'} selected={window.to === 'CUSTOMER'} onChange={() => actions?.onActChange?.({ ...window, to: 'CUSTOMER' })} title={t('upload.audience.PARTNER', { party })} description={t('upload.audience.PARTNERBody', { party })} />}
        </fieldset>
        {floor && <p className="fw-rtv-muted">{t('acts.who.floor')}</p>}
        {link && <p className="fw-rtv-muted">{t('acts.who.link')}</p>}
        <ActLines problem={state.problem} happens={t('acts.who.happens', { party })} customer={window.to === 'CUSTOMER' ? t('acts.who.customerShown', { party }) : t('acts.who.customerGone', { party })} never={t('acts.who.never')} />
      </div>
    </Modal>
  )
}
