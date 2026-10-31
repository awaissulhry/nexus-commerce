'use client'

import { useMemo, type ReactNode } from 'react'
import { Banner, Countdown, Modal, ProgressBar } from '@nexus/ui/components'
import { StepUpModal } from '@nexus/ui/patterns'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { INTL_LOCALE } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { listKeys, type ListKey } from '../../../list-frame/model'
import type { StepUpState } from '../_shared/hooks'
import { QualityMessages } from '../_shared/parts'
import type { NcrStage, NcrSummary, Severity } from './api'
import { decidedOf, quantityText, SEVERITY_TONE, STAGE_TONE, type Say } from './model'
import './ncr.css'

/**
 * The parts every Nonconformances screen draws (SCR-144 list and board, SCR-145 the NCR record), from design-system parts
 * only; nothing here fetches. Composed here where the design names a DS part that does not exist yet (named in the step
 * notes): the closing Checklist (the quality screens' CheckList), the SignOffPanel (the close dialog's note + the DS
 * step-up), the GarmentZoneMap (a zone picker in words), the "decided" mini bar (ProgressBar + words).
 */

export const NCR_NAMESPACE = 'ncr'

/** The screen's catalogue plus the quality words, the list frame's, the record panels' and the board view's. */
export function NcrMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={[NCR_NAMESPACE, 'boardview-kit']}>{children}</QualityMessages>
}

const QUANTITY_PARAMS = new Set(['affected', 'decided', 'left', 'quantity', 'suspect'])
const STAGE_PARAMS = new Set(['stage', 'from', 'to'])

/**
 * Words with their parameters (`Say`) in the reader's language: a quantity in its number format, a unit and a stage in
 * words. Everything the screen says goes through here or `t`.
 */
export function sayWith(t: Translate, locale: string, words: Say | null | undefined): string | null {
  if (!words) return null
  const params: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(words.params ?? {})) {
    if (QUANTITY_PARAMS.has(name) && typeof value === 'string') params[name] = quantityText(value, locale)
    else if (name === 'unit' && typeof value === 'string') params[name] = t(`uom.${value}`)
    else if (STAGE_PARAMS.has(name) && typeof value === 'string') params[name] = t(`stage.${value}`)
    else params[name] = value
  }
  return t(words.key, params)
}

/** The screen's translator and its `say`. */
export function useNcrWords(): { t: Translate; say: (words: Say | null | undefined) => string | null; locale: string } {
  const t = useT(NCR_NAMESPACE)
  const locale = INTL_LOCALE[useLocale()]
  return useMemo(() => ({ t, locale, say: (words: Say | null | undefined) => sayWith(t, locale, words) }), [t, locale])
}

export function StagePill({ stage }: { stage: NcrStage }) {
  const { t } = useNcrWords()
  return <Pill tone={STAGE_TONE[stage]}>{t(`stage.${stage}`)}</Pill>
}

export function SeverityTag({ severity }: { severity: Severity }) {
  const { t } = useNcrWords()
  return <Tag tone={SEVERITY_TONE[severity]}>{t(`severity.${severity}`)}</Tag>
}

/** "28 of 40 pcs decided · 12 left" with its bar (design ncr-grid "mini bar"; ncr-disp "Bar"). */
export function DecidedBar({ ncr, compact = false }: { ncr: Pick<NcrSummary, 'quantityAffected' | 'decided' | 'uom'>; compact?: boolean }) {
  const { say } = useNcrWords()
  const decided = decidedOf(ncr)
  const words = say(decided.say)
  return (
    <span className={compact ? 'fw-ncr-bar is-compact' : 'fw-ncr-bar'}>
      <ProgressBar ariaLabel={words ?? undefined} value={decided.percent} tone={decided.all ? 'complete' : decided.percent ? 'partial' : 'missing'} height={compact ? 5 : 7} />
      <span className="fw-q-hint fw-q-num">{words}</span>
    </span>
  )
}

/** The quantity affected and suspect in the NCR's unit ("40 pcs · 12 suspect"). */
export function QuantityText({ ncr }: { ncr: Pick<NcrSummary, 'quantityAffected' | 'quantitySuspect' | 'uom'> }) {
  const { t, locale } = useNcrWords()
  const affected = `${quantityText(ncr.quantityAffected, locale)} ${t(`uom.${ncr.uom}`)}`
  return <span className="fw-q-num">{ncr.quantitySuspect && Number(ncr.quantitySuspect) > 0 ? t('quantity.withSuspect', { affected, suspect: quantityText(ncr.quantitySuspect, locale) }) : affected}</span>
}

/** The containment due time: a countdown while it runs, "overdue" once passed, nothing once contained. */
export function ContainmentDue({ ncr, now }: { ncr: Pick<NcrSummary, 'stage' | 'containmentDueAt' | 'containmentOverdue'>; now: string }) {
  const { t } = useNcrWords()
  if (ncr.stage !== 'OPEN' || !ncr.containmentDueAt) return <span className="fw-q-hint">—</span>
  if (ncr.containmentOverdue || new Date(ncr.containmentDueAt).getTime() <= new Date(now).getTime()) return <Tag tone="danger">{t('due.overdue')}</Tag>
  return <Countdown to={ncr.containmentDueAt} now={new Date(now).getTime()} label={(left) => t('due.in', { left })} doneLabel={t('due.overdue')} announce={false} />
}

/** One notice above the work: our words, the API's sentences under them when it sent facts. */
export interface NcrNotice {
  readonly say: Say
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly detail?: readonly string[]
  /** B-W2b-17: lines in our words (the refused NCRs of a bulk owner change), shown before the detail lines. */
  readonly lines?: readonly Say[]
  readonly link?: { readonly href: string; readonly label: Say } | null
}

export function NoticeLine({ notice, onDismiss }: { notice: NcrNotice | null | undefined; onDismiss?: () => void }) {
  const { say } = useNcrWords()
  const q = useT('quality')
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={say(notice.say) ?? ''}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {q('common.dismiss')}
          </Button>
        ) : undefined
      }
    >
      {notice.link && (
        <a className="fw-q-link" href={notice.link.href}>
          {say(notice.link.label)}
        </a>
      )}
      {notice.lines && notice.lines.length > 0 && (
        <ul className="fw-q-lines">
          {notice.lines.map((line, index) => (
            <li key={`${line.key}:${index}`}>{say(line)}</li>
          ))}
        </ul>
      )}
      {notice.detail && notice.detail.length > 0 && (
        <ul className="fw-q-lines">
          {notice.detail.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** The keys of a page (`?`): the same list as the footer's keys icon; `frame` false (the board): the page's own only. */
export function KeysDialog({ own, withSelection = true, frame = true, onClose }: { own: readonly ListKey[]; withSelection?: boolean; frame?: boolean; onClose: () => void }) {
  const { t } = useNcrWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-ncr-keys">
        {(frame ? listKeys(own, withSelection) : own).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** A garment zone in words; a code outside the map (an older or a typed one) as it is, never a key. */
export function zoneWords(t: Translate, zone: string | null | undefined): string | null {
  if (!zone) return null
  const words = t(`zone.${zone}`)
  return words === `zone.${zone}` ? zone : words
}

/** A source record in words ("Inspection", "Lot") from its API type. */
export const recordTypeKey = (type: string): string => `recordType.${type}`

/**
 * The DS step-up dialog in this screen's words (closing an NCR is an e-signature): the sentence is an `ncr` key, the
 * title and a refused code's words the quality screens' (`quality` stepUp.*). The DS dialog's own field words are still
 * English (the open Modal/StepUpModal gap, named in the notes).
 */
export function NcrStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit: (code: string) => void; onCancel: () => void }) {
  const { t } = useNcrWords()
  const q = useT('quality')
  return (
    <StepUpModal
      open={state.open}
      title={q('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? q(state.problem) : null}
      onSubmit={onSubmit}
      onClose={onCancel}
      confirmLabel={t('close.submit')}
    />
  )
}
