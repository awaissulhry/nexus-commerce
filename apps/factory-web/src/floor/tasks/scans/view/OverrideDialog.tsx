'use client'

import { ArrowLeft, Clock, CloudOff, ListChecks, MessageSquareText, Pencil, UsersRound, Wrench, X } from 'lucide-react'
import { FloorButton, PinPad, ScanInput } from '@nexus/ui/floor'
import { Field } from '@nexus/ui/components'
import { FloorNamePicker } from '@nexus/ui/floor/FloorNamePicker/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import type { ReactNode } from 'react'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { TaskLine } from '../../shared/view/TaskParts'
import type { OverrideTile } from '../checks'

/**
 * SCR-090's pop-up "Team leader override" (design pop:operation.override): what is being overridden, a reason tile, then the team
 * leader's own badge or name and their PIN; the sixth digit signs. The PIN goes to the server and nowhere else: it is never drawn
 * or kept. Only online (the server checks it), and never the person's own work: the words of a refusal stay in the pop-up, the
 * operator stays signed in. Digits type; Esc cancels.
 */

const TILE_ICON: Readonly<Record<string, ReactNode>> = { COUNTED_AGAIN: <ListChecks />, EARLIER_LATE: <Clock />, COVERING_LINE: <UsersRound />, BACK_FROM_REWORK: <Wrench />, OTHER: <MessageSquareText /> }

export type OverrideProblem = 'wrong' | 'self' | 'notLead' | 'note' | 'locked' | 'unavailable' | null

export interface OverrideModel {
  /** What is signed: the bundle, its operation, the good pieces of a report. */
  readonly subject: { readonly code: string; readonly seq: number; readonly good?: number }
  /** What is being overridden (the screen's words for a code it knows). */
  readonly lines: readonly { readonly code: string; readonly message: string }[]
  readonly reasons: readonly OverrideTile[]
  readonly reasonCode: string | null
  readonly words: string
  /** Who signs: a badge read, or a name picked. */
  readonly lead: { readonly kind: 'badge'; readonly code: string } | { readonly kind: 'name'; readonly workerId: string; readonly name: string } | null
  /** The names to pick from (the site's roster), when the team leader has no badge at hand. */
  readonly people: readonly { readonly id: string; readonly name: string }[]
  readonly picking: boolean
  readonly busy: boolean
  readonly problem: OverrideProblem
  readonly offline: boolean
}

export type OverrideAction = { type: 'overrideClose' } | { type: 'overrideReason'; code: string | null } | { type: 'overrideWords'; words: string } | { type: 'overrideBadge'; code: string } | { type: 'overrideNames'; open: boolean } | { type: 'overrideName'; workerId: string; name: string } | { type: 'overrideLeadBack' } | { type: 'overrideSign'; pin: string }

/** "Other" asks a few words (the API refuses fewer than three). */
export const overrideReady = (model: Pick<OverrideModel, 'reasons' | 'reasonCode' | 'words'>): boolean => {
  const reason = model.reasons.find((entry) => entry.code === model.reasonCode)
  return Boolean(reason) && (!reason!.needsNote || model.words.trim().length >= 3)
}

export function OverrideDialog({ model, send, words: lineWords }: { model: OverrideModel | null; send: (action: OverrideAction) => void; /** A check's words: the screen's own for a code it knows. */ words: (code: string, message: string) => string }) {
  const t = useT('floor-scans')
  const shared = useT('floor-tasks')
  const locale = useLocale()
  const words = useReasonWords()
  const names = useDsWords().floorNamePicker
  const tiles: ReasonTile[] = (model?.reasons ?? []).map((reason) => ({ id: reason.code, label: locale === 'it' ? reason.label.it : reason.label.en, icon: TILE_ICON[reason.code] ?? <MessageSquareText />, tone: 'primary' }))
  const picked = model?.reasons.find((entry) => entry.code === model.reasonCode) ?? null
  const ready = model ? overrideReady(model) : false
  const summary = model ? (
    <>
      <p className="fw-floor-dialog-line">
        <strong>
          <span className="fw-floor-code">{model.subject.code}</span> · {t('opShort', { seq: model.subject.seq })}
          {model.subject.good !== undefined ? ` · ${t('count.good', { count: model.subject.good })}` : ''}
        </strong>
      </p>
      {model.lines.map((line) => (
        <p key={line.code} className="fw-floor-dialog-line">
          {lineWords(line.code, line.message)}
        </p>
      ))}
      {model.offline ? (
        <TaskLine tone="warning" icon={<CloudOff />}>
          {t('override.offline')}
        </TaskLine>
      ) : null}
      {picked ? (
        <div className="fw-scans-override-why">
          <span>{t('override.because', { reason: locale === 'it' ? picked.label.it : picked.label.en })}</span>
          <FloorButton size="md" variant="secondary" icon={<Pencil />} heldReason={model.busy ? shared('pin.busy') : null} onClick={() => send({ type: 'overrideReason', code: null })}>
            {t('override.change')}
          </FloorButton>
        </div>
      ) : null}
    </>
  ) : null
  const cancel = (
    <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => send({ type: 'overrideClose' })}>
      {t('override.cancel')}
    </FloorButton>
  )
  return (
    <Modal open={Boolean(model)} onClose={() => send({ type: 'overrideClose' })} title={t('override.title')} size="xl" className="fw-floor-dialog">
      {model && ready && model.lead ? (
        // The last job: the PIN. The pad beside what it signs, so all of it fits a tablet without scrolling.
        <div className="fw-floor-dialog-body fw-scans-override-sign">
          <div className="fw-scans-override">
            {summary}
            <p className="fw-floor-dialog-line">{model.lead.kind === 'name' ? t('override.signsName', { name: model.lead.name }) : t('override.signsBadge')}</p>
            <FloorButton size="lg" variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'overrideLeadBack' })}>
              {t('override.otherLead')}
            </FloorButton>
            {cancel}
          </div>
          <PinPad
            label={t('override.pin')}
            enteredLabel={(entered, total) => shared('pin.entered', { entered, total })}
            clearLabel={shared('pin.clear')}
            backLabel={shared('pin.back')}
            busy={model.busy}
            locked={model.problem === 'locked'}
            message={model.problem ? t(`override.problem.${model.problem}`) : model.busy ? shared('pin.busy') : undefined}
            messageTone={model.problem ? 'danger' : 'info'}
            onSubmit={(pin) => send({ type: 'overrideSign', pin })}
            autoFocus
          />
        </div>
      ) : model ? (
        <div className="fw-floor-dialog-body fw-scans-override">
          {summary}
          {!picked ? <ReasonGrid label={t('override.reason')} reasons={tiles} value={model.reasonCode} onChange={(id) => send({ type: 'overrideReason', code: id })} words={words} locale={INTL_LOCALE[locale]} /> : null}
          {picked?.needsNote ? (
            <Field label={t('override.words')} htmlFor="fw-scans-override-words">
              <Textarea id="fw-scans-override-words" value={model.words} limit={200} maxLength={200} rows={2} onChange={(event) => send({ type: 'overrideWords', words: event.target.value })} />
            </Field>
          ) : null}
          {ready && !model.picking ? (
            <>
              <ScanInput label={t('override.badge')} hint={t('override.badgeHint')} scannedLabel={() => t('override.badgeRead')} acceptTyped={false} keepFocus={false} disabled={model.offline} onScan={(code) => send({ type: 'overrideBadge', code })} />
              {model.people.length > 0 ? (
                <FloorButton size="lg" variant="secondary" icon={<UsersRound />} heldReason={model.offline ? t('override.offline') : null} onClick={() => send({ type: 'overrideNames', open: true })}>
                  {t('override.byName')}
                </FloorButton>
              ) : null}
            </>
          ) : null}
          {ready && model.picking ? (
            <>
              <FloorNamePicker label={t('override.pickName')} people={model.people} onPick={(id, person) => send({ type: 'overrideName', workerId: id, name: person.name })} locale={locale} labels={names} />
              <FloorButton size="lg" variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'overrideNames', open: false })}>
                {t('override.useBadge')}
              </FloorButton>
            </>
          ) : null}
          <div className="fw-floor-dialog-actions">{cancel}</div>
        </div>
      ) : null}
    </Modal>
  )
}
