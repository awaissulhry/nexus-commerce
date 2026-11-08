'use client'

import { useCallback, type ReactNode } from 'react'
import { Tag } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../lib/i18n/ds-parts'
import type { StepUpState } from '../../_shared/hooks'
import { formatNumber } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { QualityMessages } from '../../_shared/parts'
import type { Kind, Words } from './model'
import './depth.css'

/** The catalogues of Inspections in depth: its own (`inspections-depth`), the quality words, the DS words, the photo kit. */
export const DEPTH_NAMESPACES = ['inspections-depth', 'ds-words', 'quality-aql'] as const

/** Wraps a view in the quality catalogues plus this step's. */
export function DepthMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={DEPTH_NAMESPACES}>{children}</QualityMessages>
}

/** The step's translator. */
export const useDepthT = (): Translate => useT('inspections-depth')

/**
 * `say(words)`: a model's Words in the page's language — `text` passes raw text through, a number that is not whole is
 * written in the page's language (a whole one stays a number, so it picks the plural form).
 */
export function useSay(): (words: Words) => string {
  const t = useDepthT()
  const locale = useLocale()
  return useCallback(
    (words: Words) => {
      if (words.key === 'text') return String(words.params?.text ?? '')
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(words.params ?? {})) params[name] = typeof value === 'number' && !Number.isInteger(value) ? formatNumber(value, locale) : value
      return t(words.key, params)
    },
    [locale, t],
  )
}

const KIND_TONE: Readonly<Record<Kind, 'info' | 'neutral' | 'warning'>> = { INCOMING: 'info', INLINE: 'warning', FINAL: 'neutral' }

/** The kind of a row (design qi-grid "Kind"): Incoming, In-line, Final — said in words, the tone only beside them. */
export function KindTag({ kind }: { kind: Kind }) {
  const t = useDepthT()
  return <Tag tone={KIND_TONE[kind]}>{t(`kind.${kind}`)}</Tag>
}

/** A check's class (critical, major, minor) as a tag with its word. */
export function ClassTag({ klass }: { klass: 'CRITICAL' | 'MAJOR' | 'MINOR' | null }) {
  const t = useDepthT()
  if (!klass) return null
  return <Tag tone={klass === 'CRITICAL' ? 'danger' : klass === 'MAJOR' ? 'warning' : 'neutral'}>{t(`class.${klass}`)}</Tag>
}

/**
 * The page's step-up (a fresh 6-digit code) with this step's words for a `depth:` sentence ("Countersign the correction"),
 * the quality words for the others (sign the result, release): one dialog for the record's every signature.
 */
export function DepthStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit: (code: string) => void; onCancel: () => void }) {
  const t = useT('quality')
  const td = useDepthT()
  const sentence = state.sentence.startsWith('depth:') ? td(state.sentence.slice('depth:'.length)) : state.sentence ? t(state.sentence) : ''
  return (
    <StepUpModal
      open={state.open}
      title={t('stepUp.title')}
      sentence={sentence}
      busy={state.busy}
      error={state.problem ? t(state.problem) : null}
      onSubmit={onSubmit}
      onClose={onCancel}
      confirmLabel={t('stepUp.confirm')}
    />
  )
}
