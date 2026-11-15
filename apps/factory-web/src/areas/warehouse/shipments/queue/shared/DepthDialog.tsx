'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { DEPTH_NS, type Words } from './depth'

/** This step's words: `say` takes a Words (key + values) of the catalogue. */
export function useDepthWords() {
  const t = useT(DEPTH_NS)
  const say = (value: Words | null | undefined): string | null => (value ? t(value.key, value.params) : null)
  return { t, say }
}

/**
 * The frame of every dialog of this step (the DS Modal): Cancel + the confirm, held with its reason in words; ⌘↵ confirms;
 * the refusal said inside; a receipt in place of the form once done (then only Done).
 */
export function DepthDialog({
  title,
  subtitle,
  held,
  onGo,
  goLabel,
  onClose,
  problem,
  done,
  size = 'md',
  tone = 'primary',
  children,
}: {
  title: string
  subtitle?: string
  held: string | null
  onGo: () => void
  goLabel: string
  onClose: () => void
  problem: string | null
  done?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  tone?: 'primary' | 'danger'
  children?: ReactNode
}) {
  const { t } = useDepthWords()
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held && !done) {
      event.preventDefault()
      onGo()
    }
  }
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
            <Button size="sm" variant={tone} heldReason={held} onClick={onGo} aria-keyshortcuts="Meta+Enter Control+Enter">
              {goLabel}
            </Button>
          </>
        )
      }
    >
      <form
        className="fw-shd-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held && !done) onGo()
        }}
        onKeyDown={onKeyDown}
      >
        {problem && <Banner tone="danger" title={problem} />}
        {done ?? children}
      </form>
    </Modal>
  )
}

/** A part while it loads, or why it could not be read (never drawn as empty), with Try again. */
export function PartRead({ problem, onRetry, label }: { problem: Words | null; onRetry?: () => void; label: string }) {
  const { t, say } = useDepthWords()
  if (problem) {
    return (
      <div className="fw-shd-part-state" role="alert">
        <span>
          <strong>{t('part.failed', { part: label })}</strong> {say(problem)}
        </span>
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    )
  }
  return (
    <p className="fw-sh-hint" role="status" aria-busy="true">
      {t('part.loading', { part: label })}
    </p>
  )
}
