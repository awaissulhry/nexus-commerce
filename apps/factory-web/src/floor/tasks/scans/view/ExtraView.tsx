'use client'

import { Hammer, Shirt, TriangleAlert, Users, Workflow, MessageSquareText } from 'lucide-react'
import type { ReactNode } from 'react'
import { FloorTile, FloorTileGrid } from '@nexus/ui/floor'
import { Field } from '@nexus/ui/components'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { HeldLine, ProblemState, TaskCard, TaskLine } from '../../shared/view/TaskParts'
import type { TaskProblem } from '../../shared/task-api'
import { EXTRA_NOTE, type ExtraChoices, type ExtraDraft, type ExtraReasonCode } from '../extra'
import type { BundleCard } from '../model'

/**
 * SCR-090 "Add an unplanned operation" (B-W2b-82; MES-086): the team leader picks a library operation the work order lacks and
 * says why. Online only (held with the reason): the list is the office's. Standard minutes are no money; `pays` is a word.
 */

export type ExtraAction = { type: 'extraOperation'; id: string } | { type: 'extraReason'; code: ExtraReasonCode } | { type: 'extraWords'; words: string }

const TILE_LOOK: Readonly<Record<ExtraReasonCode, { icon: ReactNode; tone: 'danger' | 'warning' | 'info' | 'neutral' }>> = {
  QUALITY_FIX: { icon: <Hammer />, tone: 'warning' },
  MATERIAL_ISSUE: { icon: <TriangleAlert />, tone: 'warning' },
  CUSTOMER_CHANGE: { icon: <Users />, tone: 'info' },
  MISSING_FROM_ROUTING: { icon: <Workflow />, tone: 'info' },
  OTHER: { icon: <MessageSquareText />, tone: 'neutral' },
}

export function ExtraBody({ card, choices, draft, problem, busy, online, t, send }: { card: BundleCard; choices: ExtraChoices | null; draft: ExtraDraft; problem: TaskProblem | null; busy: boolean; online: boolean; t: Translate; send: (action: ExtraAction) => void }) {
  const locale = useLocale()
  const words = useReasonWords()
  const picked = choices?.operations.find((operation) => operation.id === draft.operationId) ?? null
  const tiles: ReasonTile[] = (choices?.reasons ?? []).map((reason) => ({ id: reason.code, label: locale === 'it' ? reason.label.it : reason.label.en, ...TILE_LOOK[reason.code] }))
  const needsWords = choices?.reasons.find((reason) => reason.code === draft.reason)?.needsNote ?? false
  return (
    <div className="fw-task-split">
      <div className="fw-floor-stack">
        <TaskCard icon={<Shirt />} type={t('extra.title')} code={card.workOrder.number} id="fw-scans-extra-subject" />
        {!online ? <HeldLine text={t('extra.offline')} /> : null}
        {problem ? <ProblemState problem={problem} /> : null}
        {online && choices === null && !problem ? (
          <p className="fw-floor-muted" aria-busy="true">
            {t('extra.loading')}
          </p>
        ) : null}
        {choices && choices.operations.length === 0 ? <TaskLine tone="info" icon={<Workflow />}>{t('extra.empty')}</TaskLine> : null}
        {choices && choices.operations.length > 0 ? (
          <FloorTileGrid label={t('extra.operation')} columns={2}>
            {choices.operations.map((operation) => (
              <FloorTile
                key={operation.id}
                icon={<Workflow />}
                label={`${operation.code} · ${operation.name}`}
                hint={t('extra.minutes', { minutes: operation.standardMinutes })}
                tone={operation.id === draft.operationId ? 'primary' : 'neutral'}
                current={operation.id === draft.operationId}
                onPress={() => send({ type: 'extraOperation', id: operation.id })}
              />
            ))}
          </FloorTileGrid>
        ) : null}
      </div>
      <div className="fw-floor-stack">
        {tiles.length > 0 ? <ReasonGrid label={t('extra.why')} reasons={tiles} value={draft.reason} onChange={(id) => send({ type: 'extraReason', code: id as ExtraReasonCode })} words={words} locale={INTL_LOCALE[locale]} /> : null}
        {needsWords ? (
          <Field label={t('extra.words')} htmlFor="fw-scans-extra-words">
            <Textarea id="fw-scans-extra-words" value={draft.words} limit={EXTRA_NOTE.max} maxLength={EXTRA_NOTE.max} rows={2} onChange={(event) => send({ type: 'extraWords', words: event.target.value })} />
          </Field>
        ) : null}
        {picked?.pays === 'OFF_STANDARD' ? (
          <TaskLine tone="warning" icon={<TriangleAlert />}>
            {t('extra.noRate')}
          </TaskLine>
        ) : null}
        {busy ? (
          <p className="fw-floor-muted" aria-busy="true">
            {t('extra.adding')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
