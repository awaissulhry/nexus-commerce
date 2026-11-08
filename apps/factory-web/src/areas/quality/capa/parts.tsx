'use client'

import { useMemo, type ReactNode } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { CellSaveMark, Modal, useDsWords } from '../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { INTL_LOCALE } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { listKeys, type ListKey } from '../../../list-frame/model'
import { QualityMessages } from '../_shared/parts'
import type { CapaPriority, CapaStatus, CapaType } from './api'
import { CAPA_NAMESPACE, stageTone, type Say } from './model'
import './capa.css'

/**
 * The parts every Corrective actions screen draws (SCR-146 list and board, the record, the 8D window), from DS parts only;
 * nothing here fetches.
 */

/** The screen's catalogue plus the quality words, the list frame's, the record panels' and the board view's. */
export function CapaMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={[CAPA_NAMESPACE, 'boardview-kit']}>{children}</QualityMessages>
}

const STAGE_PARAMS = new Set(['stage', 'from', 'to'])

/** Words with their parameters in the reader's language (a stage, a status, a type in words). */
export function sayWith(t: Translate, words: Say | null | undefined): string | null {
  if (!words) return null
  const params: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(words.params ?? {})) {
    if (STAGE_PARAMS.has(name) && typeof value === 'string') params[name] = t(`stage.${value}`)
    else if (name === 'status' && typeof value === 'string') params[name] = t(`actionStatus.${value}`)
    else if (name === 'type' && typeof value === 'string') params[name] = t(`type.${value}`)
    else params[name] = value
  }
  return t(words.key, params)
}

export interface CapaWords {
  t: Translate
  say: (words: Say | null | undefined) => string | null
  locale: string
}

export function useCapaWords(): CapaWords {
  const t = useT(CAPA_NAMESPACE)
  const locale = INTL_LOCALE[useLocale()]
  return useMemo(() => ({ t, locale, say: (words: Say | null | undefined) => sayWith(t, words) }), [t, locale])
}

export function StagePill({ stage }: { stage: CapaStatus }) {
  const { t } = useCapaWords()
  return <Pill tone={stageTone(stage)}>{t(`stage.${stage}`)}</Pill>
}

export function TypeTag({ type }: { type: CapaType }) {
  const { t } = useCapaWords()
  return <Tag tone={type === 'EIGHT_D' ? 'info' : 'neutral'}>{t(`type.${type}`)}</Tag>
}

export function PriorityTag({ priority }: { priority: CapaPriority }) {
  const { t } = useCapaWords()
  return <Tag tone={priority === 'HIGH' ? 'danger' : priority === 'LOW' ? 'neutral' : 'info'}>{t(`priority.${priority}`)}</Tag>
}

/** A receipt or a refusal above the work: our words, the lines in our words under them, an optional link. */
export interface CapaNotice {
  readonly say: Say
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly lines?: readonly Say[]
  readonly link?: { readonly href: string; readonly label: Say } | null
}

export function NoticeLine({ notice, onDismiss }: { notice: CapaNotice | null | undefined; onDismiss?: () => void }) {
  const { say } = useCapaWords()
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
    </Banner>
  )
}

/** The keys of a page (`?`): the same list as the footer's keys icon. */
export function KeysDialog({ own, withSelection = true, frame = true, onClose }: { own: readonly ListKey[]; withSelection?: boolean; frame?: boolean; onClose: () => void }) {
  const { t } = useCapaWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-capa-keys">
        {(frame ? listKeys(own, withSelection) : own).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

export type CellState = { readonly state: 'saving' } | { readonly state: 'saved' } | { readonly state: 'failed' }

/** A cell's save: the DS mark while it saves, a tick once saved, a mark with words when it failed. */
export function CellMark({ cell }: { cell: CellState | undefined }) {
  const { t } = useCapaWords()
  const ds = useDsWords()
  if (!cell) return null
  if (cell.state === 'saving') return <CellSaveMark state="saving" labels={ds.cellSaveMark} />
  if (cell.state === 'saved') return <Check size={13} className="fw-capa-ok" role="img" aria-label={t('cell.saved')} />
  return <AlertCircle size={13} className="fw-capa-bad" role="img" aria-label={t('cell.failed')} />
}

/** A person by id in words: their name, "you", or "another person" (a name the reader may not see). */
export function personWords(people: readonly { id: string; name: string }[] | null | undefined, id: string | null | undefined, me: string, t: Translate): string {
  if (!id) return t('common.nobody')
  const found = people?.find((person) => person.id === id)
  if (!found) return t('common.unknownPerson')
  return id === me ? t('common.me', { name: found.name }) : found.name
}
