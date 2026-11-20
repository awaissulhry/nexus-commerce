'use client'

import { useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { RadioCard, Select } from '@nexus/ui/primitives'
import { STAGE_SET_NOTE_MAX, STAGE_SET_REASON_CODES } from '@nexus/factory-domain/production-brand/stage-set'
import { ActionConfirm, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import type { PlainStage } from '../../../../../../lib/production/model'
import type { Order } from '../../../api'
import type { Phrase } from '../../../model'
import type { Words } from '../../overview/api'
import { readOf, say } from '../../overview/model'
import { clearLinesOf, stageByHandHeld, stageByHandStartOf, stageDialogLinesOf, type DialogLine } from '../../overview/stage-by-hand'
import type { HandWords } from '../../overview/where'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { Frame } from '../Dialogs'

/**
 * F-MS-103 (set the stage by hand, 04 §3; review R3b, R8, R9, R18, R20) — "Where it is now"'s two dialogs, in the page's one dialog slot
 * (`stageByHand`, `stageClear`; the Where card mounts them, as the credit strip's). ONE dialog sets and changes the stage by hand (the
 * page's Frame, DS Modal): the stages as DS RadioCard rows (what the floor's counts already did, where the floor is now and Ready to
 * ship never picked, with their words; Change… pre-picks the stage set), the reason (DS Select), the office's note (DS Textarea, one
 * line of at most 200 characters: never name a person on the floor), then the lines the customer side follows. Clear… is the DS
 * ActionConfirm. Keyboard: Tab, the arrow keys in the radios (native), Esc closes (not while it goes), ⌘↵ / Ctrl↵ sends through the
 * Go button's aria-keyshortcuts (Frame) — no key hint text anywhere. A refusal is said inside the dialog; what was typed stays.
 */

/** The row's, the door's and the dialogs' words: the orders catalogue, production's (`ns`), or the domain's own words. */
export function useSayHand(): (words: HandWords | null | undefined) => string | null {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  return (words) => (!words ? null : 'key' in words ? (words.ns === 'production' ? w.t(words.key, words.params) : t(words.key, words.params)) : say(words, locale))
}

/** A dialog line in the page's language: a stage in the office's words, what the customer reads in its own, the minutes. */
function useLineText(): (line: DialogLine) => string {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  return (line) => t(line.key, { ...(line.stage ? { stage: w.t(`parts.stage.${line.stage}`) } : {}), ...(line.customer ? { customer: say(line.customer, locale) } : {}), ...(line.minutes !== undefined ? { minutes: line.minutes } : {}) })
}

export function StageHandDialogs({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const dialog = model.dialog
  if (dialog?.kind === 'stageByHand') return <StageByHandDialog key={dialog.mode} order={order} model={model} actions={actions} mode={dialog.mode} refused={dialog.refused ?? null} />
  if (dialog?.kind === 'stageClear') return <StageClearDialog model={model} actions={actions} refused={dialog.refused ?? null} />
  return null
}

function StageByHandDialog({ order, model, actions, mode, refused }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; mode: 'set' | 'change'; refused: Phrase | Words | null }) {
  const t = useT('orders')
  const w = useProductionWords()
  const sayHand = useSayHand()
  const lineText = useLineText()
  const start = stageByHandStartOf(mode, readOf(model.production)?.headline ?? null)
  const [pick, setPick] = useState<PlainStage | null>(start.pick)
  const [reasonCode, setReasonCode] = useState<string>(model.draft?.reasonCode ?? start.reasonCode)
  const [note, setNote] = useState<string>(model.draft?.reason ?? start.note)
  const held = stageByHandHeld({ rows: start.rows, stage: pick, reasonCode, note, busy: model.busy })
  const go = () => {
    if (!held) actions?.stageHand?.onSet?.({ mode, stage: pick, reasonCode, note })
  }
  return (
    <Frame
      title={t(start.changing ? 'where.manual.changeTitle' : 'where.manual.title', { number: order.number })}
      held={sayHand(held)}
      go={go}
      goLabel={model.busy ? t('common.working') : t(start.changing ? 'where.manual.changeGo' : 'where.manual.go')}
      onClose={() => !model.busy && actions?.onDialog?.(null)}
      problem={refused ? <Banner tone="danger" title={sayHand(refused) ?? ''} /> : null}
    >
      <p className="fw-so-hint">{t('where.manual.body')}</p>
      <fieldset className="fw-so-choices">
        <legend className="fw-so-legend">{t('where.manual.pick')}</legend>
        {start.rows.map((row) => (
          <RadioCard
            key={row.stage}
            variant="row"
            name="fw-so-hand-stage"
            value={row.stage}
            checked={pick === row.stage}
            selected={pick === row.stage}
            disabled={row.disabled}
            onChange={() => setPick(row.stage)}
            title={w.t(`parts.stage.${row.stage}`)}
            description={sayHand(row.note) ?? undefined}
          />
        ))}
      </fieldset>
      <Field label={t('where.manual.reason')}>
        <Select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} aria-label={t('where.manual.reason')}>
          <option value="">{w.t('raise.reasonPick')}</option>
          {STAGE_SET_REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {t(`where.manual.reasons.${code}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={w.t('raise.note')} hint={t('where.manual.noteHint', { max: STAGE_SET_NOTE_MAX })} required={reasonCode === 'OTHER'}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={STAGE_SET_NOTE_MAX} />
      </Field>
      {stageDialogLinesOf({ hand: start.hand, pick }).map((line) => (
        <p key={line.key} className="fw-so-hint">
          {lineText(line)}
        </p>
      ))}
    </Frame>
  )
}

/**
 * Clear… — back to the floor's stage (the DS ActionConfirm): what the customer was told of the stage, as the API's notice says it
 * (B-MS-008, ms-fx1: a notice still waiting its window — not told yet and now never is; told — not told it again; never told — and not
 * told now); then the floor's stage it reads now, with no notice. A refusal holds the
 * confirm with its words (the stage was read again: Cancel, and the card says where it stands now).
 */
function StageClearDialog({ model, actions, refused }: { model: OrderRecordModel; actions?: OrderRecordActions; refused: Phrase | Words | null }) {
  const t = useT('orders')
  const w = useProductionWords()
  const sayHand = useSayHand()
  const lineText = useLineText()
  const headline = readOf(model.production)?.headline ?? null
  const floor = headline?.stage?.byHand?.floor?.code ?? null
  const lines = clearLinesOf(headline, Date.now()) ?? []
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        title: t('where.manual.clearTitle'),
        confirmLabel: model.busy ? t('common.working') : floor ? t('where.manual.clearGo', { stage: w.t(`parts.stage.${floor}`) }) : t('where.manual.clearGoPlain'),
        consequences: lines.map(lineText),
        ...(refused ? { refusal: { reason: sayHand(refused) ?? '' } } : {}),
      }}
      onConfirm={() => !model.busy && actions?.stageHand?.onClear?.()}
      onCancel={() => !model.busy && actions?.onDialog?.(null)}
    />
  )
}
