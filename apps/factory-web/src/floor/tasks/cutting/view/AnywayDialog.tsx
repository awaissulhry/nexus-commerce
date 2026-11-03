'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Building2, Eye, Layers, MessageSquareText, PackageX, Ruler, UsersRound, X } from 'lucide-react'
import { FloorButton, PinPad, ScanInput } from '@nexus/ui/floor'
import { Field } from '@nexus/ui/components'
import { FloorNamePicker } from '@nexus/ui/floor/FloorNamePicker/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { TaskLine } from '../../shared/view/TaskParts'
import { ANYWAY_REASONS, anywayReady, type AnywayProblem, type CheckWarning } from '../model'
import { mmWords, warningWords } from './check-words'

/**
 * SCR-094's pop-up "Cut anyway?" (design pop:hidecut.override, B-W2b-110 on B-W2b-103): what differs (each standing warning
 * in words), what the signature records (one set of the size picked, from this hide, for this work order), a reason tile
 * (OTHER asks a few words), then the lead's badge or name and their PIN; the sixth digit signs. Online only: the office checks
 * the PIN, the queue never carries it; the PIN goes in that one request and is never drawn or kept. A refusal of the
 * signature stays in the pop-up (the cutter stays signed in). Digits type; Esc cancels.
 */

const TILE_ICON: Readonly<Record<string, ReactNode>> = { CHECKED_BY_EYE: <Eye />, HIDDEN_PARTS: <Layers />, NO_OTHER_HIDE: <PackageX />, OFFICE_AGREED: <Building2 />, OTHER: <MessageSquareText /> }

export interface AnywayModel {
  readonly hideCode: string
  readonly workOrderNumber: string
  /** The size of the set the signature records first. */
  readonly size: string
  /** The warnings that stand (what the lead signs for). */
  readonly warnings: readonly CheckWarning[]
  /** The thickness measured at this table (mm), when there is one: it goes with the cut. */
  readonly measuredMm: string | null
  readonly reasonCode: string | null
  readonly words: string
  /** Who signs: a badge read, or a name picked. */
  readonly lead: { readonly kind: 'badge'; readonly code: string } | { readonly kind: 'name'; readonly workerId: string; readonly name: string } | null
  /** The site's people, to pick a lead by name when no badge is at hand. */
  readonly people: readonly { readonly id: string; readonly name: string }[]
  readonly picking: boolean
  readonly busy: boolean
  readonly problem: AnywayProblem
}

export type AnywayAction =
  | { type: 'anywayClose' }
  | { type: 'anywayReason'; code: string | null }
  | { type: 'anywayWords'; words: string }
  | { type: 'anywayBadge'; code: string }
  | { type: 'anywayNames'; open: boolean }
  | { type: 'anywayName'; workerId: string; name: string }
  | { type: 'anywayLeadBack' }
  | { type: 'anywaySign'; pin: string }

export function AnywayDialog({ model, send }: { model: AnywayModel | null; send: (action: AnywayAction) => void }) {
  const t = useT('floor-cutting')
  const shared = useT('floor-tasks')
  const locale = useLocale()
  const reasonWords = useReasonWords()
  const names = useDsWords().floorNamePicker
  const label = (reason: (typeof ANYWAY_REASONS)[number]) => (locale === 'it' ? reason.label.it : reason.label.en)
  const tiles: ReasonTile[] = ANYWAY_REASONS.map((reason) => ({ id: reason.code, label: label(reason), icon: TILE_ICON[reason.code] ?? <MessageSquareText />, tone: 'primary' }))
  const picked = model ? (ANYWAY_REASONS.find((reason) => reason.code === model.reasonCode) ?? null) : null
  const ready = model ? anywayReady(model.reasonCode, model.words) : false

  const summary = model ? (
    <>
      <p className="fw-floor-dialog-line">
        <strong>{t('anyway.dialog.signs', { size: model.size, hide: model.hideCode, number: model.workOrderNumber })}</strong>
      </p>
      <section className="fw-cut-anyway-what" aria-label={t('anyway.dialog.what')}>
        <p className="fw-floor-subtitle">{t('anyway.dialog.what')}</p>
        <ul className="fw-cut-anyway-list">
          {model.warnings.map((warning) => (
            <li key={`${warning.kind}-${warning.code}`}>{warningWords(t, warning, { number: model.workOrderNumber, locale })}</li>
          ))}
        </ul>
      </section>
      {model.measuredMm ? (
        <TaskLine tone="info" icon={<Ruler />}>
          {t('anyway.dialog.measured', { value: mmWords(model.measuredMm, locale) })}
        </TaskLine>
      ) : null}
      {picked ? (
        <div className="fw-cut-anyway-why">
          <span>{t('anyway.dialog.because', { reason: label(picked) })}</span>
          <FloorButton size="md" variant="secondary" heldReason={model.busy ? shared('pin.busy') : null} onClick={() => send({ type: 'anywayReason', code: null })}>
            {t('anyway.dialog.change')}
          </FloorButton>
        </div>
      ) : null}
    </>
  ) : null

  const cancel = (
    <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => send({ type: 'anywayClose' })}>
      {t('anyway.dialog.cancel')}
    </FloorButton>
  )

  return (
    <Modal open={Boolean(model)} onClose={() => send({ type: 'anywayClose' })} title={t('anyway.dialog.title')} size="xl" className="fw-floor-dialog">
      {model && ready && model.lead ? (
        // The last job: the lead's PIN, beside what it signs, so all of it fits a tablet without scrolling.
        <div className="fw-floor-dialog-body fw-cut-anyway-sign">
          <div className="fw-cut-anyway">
            {summary}
            <p className="fw-floor-dialog-line">{model.lead.kind === 'name' ? t('anyway.dialog.signsName', { name: model.lead.name }) : t('anyway.dialog.signsBadge')}</p>
            <FloorButton size="lg" variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'anywayLeadBack' })}>
              {t('anyway.dialog.otherLead')}
            </FloorButton>
            {cancel}
          </div>
          <PinPad
            label={t('anyway.dialog.pin')}
            enteredLabel={(entered, total) => shared('pin.entered', { entered, total })}
            clearLabel={shared('pin.clear')}
            backLabel={shared('pin.back')}
            busy={model.busy}
            locked={model.problem === 'locked'}
            message={model.problem ? t(`anyway.problem.${model.problem}`) : model.busy ? shared('pin.busy') : undefined}
            messageTone={model.problem ? 'danger' : 'info'}
            onSubmit={(pin) => send({ type: 'anywaySign', pin })}
            autoFocus
          />
        </div>
      ) : model ? (
        <div className="fw-floor-dialog-body fw-cut-anyway">
          {summary}
          {model.problem === 'note' ? (
            <TaskLine tone="danger" icon={<MessageSquareText />} alert>
              {t('anyway.problem.note')}
            </TaskLine>
          ) : null}
          {!picked ? <ReasonGrid label={t('anyway.dialog.reason')} reasons={tiles} value={model.reasonCode} onChange={(id) => send({ type: 'anywayReason', code: id })} words={reasonWords} locale={INTL_LOCALE[locale]} /> : null}
          {picked?.needsNote ? (
            <Field label={t('anyway.dialog.words')} htmlFor="fw-cut-anyway-words">
              <Textarea id="fw-cut-anyway-words" value={model.words} limit={200} maxLength={200} rows={2} onChange={(event) => send({ type: 'anywayWords', words: event.target.value })} />
            </Field>
          ) : null}
          {ready && !model.picking ? (
            <>
              <ScanInput label={t('anyway.dialog.badge')} hint={t('anyway.dialog.badgeHint')} scannedLabel={() => t('anyway.dialog.badgeRead')} acceptTyped={false} keepFocus={false} onScan={(code) => send({ type: 'anywayBadge', code })} />
              {model.people.length > 0 ? (
                <FloorButton size="lg" variant="secondary" icon={<UsersRound />} onClick={() => send({ type: 'anywayNames', open: true })}>
                  {t('anyway.dialog.byName')}
                </FloorButton>
              ) : null}
            </>
          ) : null}
          {ready && model.picking ? (
            <>
              <FloorNamePicker label={t('anyway.dialog.pickName')} people={model.people} onPick={(id, person) => send({ type: 'anywayName', workerId: id, name: person.name })} locale={locale} labels={names} />
              <FloorButton size="lg" variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'anywayNames', open: false })}>
                {t('anyway.dialog.useBadge')}
              </FloorButton>
            </>
          ) : null}
          <div className="fw-floor-dialog-actions">{cancel}</div>
        </div>
      ) : null}
    </Modal>
  )
}
