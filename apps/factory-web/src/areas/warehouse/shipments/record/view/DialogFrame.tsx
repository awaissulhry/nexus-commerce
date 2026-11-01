'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'

/** The frame of every dialog of a shipment (DS Modal): Cancel + the confirm (held with its reason), ⌘↵, the refusal inside. */
const confirmKeys = (held: string | null, go: () => void) => (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
    event.preventDefault()
    go()
  }
}

export function Frame({ title, subtitle, held, go, goLabel, onClose, children, problem, size = 'md', tone = 'primary', done }: { title: string; subtitle?: string; held: string | null; go: () => void; goLabel: string; onClose: () => void; children?: ReactNode; problem: ShipmentRecordModel['dialogProblem']; size?: 'sm' | 'md' | 'lg' | 'xl'; tone?: 'primary' | 'danger'; done?: ReactNode }) {
  const t = useT('shipments')
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size={size}
      footer={
        done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={onClose}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant={tone} heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              {goLabel}
            </Button>
          </>
        )
      }
    >
      <form
        className="fw-sh-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held && !done) go()
        }}
        onKeyDown={done ? undefined : confirmKeys(held, go)}
      >
        {problem && (
          <Banner tone="danger" title={t(problem.words.key, problem.words.params)}>
            {problem.detail}
          </Banner>
        )}
        {done ?? children}
      </form>
    </Modal>
  )
}

export const close = (actions?: ShipmentRecordActions) => () => actions?.onDialog?.(null)

