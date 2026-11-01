'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Lock } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { AdminPageMessages } from '../../kit/messages'
import type { Notice, StepUpModel } from '../../shared/model'
import type { SecretState } from '../api'
import '../../shared/admin.css'
import '../connections.css'

/**
 * The parts Connections & API draws (B-W0-28), from design-system parts only. Two are the design's new DS parts, built
 * here until the DS adds them (DS gaps, frozen DS): CopyField (a read-only value with Copy and a polite "Copied"
 * message) and SecretField (a write-only secret: whether one is saved and when, never its value). Fetch nothing.
 */

/** The page's words: `admin` (common words), `records` (the panels) and `admin-connections` (conn.*, mail.*). */
export function ConnectionsMessages({ children }: { children?: ReactNode }) {
  return <AdminPageMessages namespace="admin-connections">{children}</AdminPageMessages>
}

/** Copies a text; "Copied" is said in a polite live region and on the button for 4 s (part of CopyField, DS gap). */
export function CopyButton({ text, label, what, size = 'sm', variant = 'secondary' }: { text: string; label: string; what: string; size?: 'xs' | 'sm'; variant?: 'secondary' | 'quiet' }) {
  const t = useT('admin-connections')
  const [said, setSaid] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setSaid('copied')
    } catch {
      setSaid('failed')
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaid(null), 4000)
  }
  return (
    <>
      <Button size={size} variant={variant} onClick={() => void copy()} aria-label={`${label}: ${what}`}>
        {said === 'copied' ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />} {said === 'copied' ? t('mail.copied') : label}
      </Button>
      <span className="fw-adm-sr" role="status" aria-live="polite">
        {said === 'copied' ? t('mail.copiedSr', { what }) : said === 'failed' ? t('mail.copyFailed') : ''}
      </span>
    </>
  )
}

/** A read-only value with a Copy button (CopyField, DS gap). */
export function CopyField({ value, label }: { value: string; label: string }) {
  const t = useT('admin-connections')
  return (
    <span className="fw-adm-conn-copy">
      <code className="fw-adm-conn-value">{value}</code>
      <CopyButton text={value} label={t('mail.copy')} what={label} size="xs" variant="quiet" />
    </span>
  )
}

/**
 * A write-only secret (SecretField, DS gap): "Saved on 28 Oct · sealed, never shown", or "Not saved". Replacing it is
 * held with its reason (no route replaces a secret yet). The value is never in the model: nothing can draw it.
 */
export function SecretField({ label, state, replaceHeld }: { label: string; state: SecretState; replaceHeld: string }) {
  const t = useT('admin-connections')
  const locale = useLocale()
  return (
    <div className="fw-adm-conn-secret">
      <div>
        <strong>{label}</strong>
        <span className="fw-adm-hint">
          <Lock size={12} aria-hidden />{' '}
          {state.saved
            ? state.rotatedAt
              ? t('conn.secret.rotated', { saved: formatDate(state.savedAt ?? state.rotatedAt, { locale }), rotated: formatDate(state.rotatedAt, { locale }) })
              : state.savedAt
                ? t('conn.secret.saved', { date: formatDate(state.savedAt, { locale }) })
                : t('conn.secret.savedNoDate')
            : t('conn.secret.notSaved')}
        </span>
      </div>
      <Button size="sm" heldReason={replaceHeld}>
        {t('conn.secret.replace')}
      </Button>
    </div>
  )
}

/** The step-up dialog with a sentence of this page's (`mail.*`, `conn.*`) or of `admin`. */
export function ConnStepUp({ model, onSubmit, onClose }: { model: StepUpModel | undefined; onSubmit?: (code: string) => void; onClose?: () => void }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  if (!model) return null
  const sentence = /^(mail|conn)\./.test(model.sentence) ? t(model.sentence) : tAdmin(model.sentence)
  return (
    <StepUpModal
      open={model.open}
      title={tAdmin('stepUp.title')}
      sentence={sentence}
      busy={model.busy}
      error={model.problem ? tAdmin(model.problem) : null}
      confirmLabel={tAdmin('stepUp.confirm')}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onClose?.()}
    />
  )
}

/** One notice (a receipt or a refusal) in this page's words (`conn.*`, `mail.*`) or `admin`'s, with Dismiss. */
export function ConnNotice({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  if (!notice) return null
  const title = /^(mail|conn)\./.test(notice.key) ? t(notice.key, notice.params) : tAdmin(notice.key, notice.params)
  return (
    <Banner
      tone={notice.tone}
      title={title}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {tAdmin('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}
