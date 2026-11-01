'use client'

import { useEffect, type ReactNode } from 'react'
import { Field } from '@nexus/ui/components'
import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { Button, FilterChip, Input, Kbd, RadioCard, Select, Toggle } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { DEFECT_CLASSES, QUALITY_STAGES, type DispositionOutcome } from '@nexus/factory-domain/quality/defects/rules'
import { usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { ListKey } from '../../../../list-frame/model'
import { GarmentZoneMap } from '../zones/GarmentZoneMap'
import type { DefectCode, Library, OutcomeOption } from '../api'
import { OUTCOMES, optionsOf, typedCode, withOutcome, wordsOf, type NewDefectDraft, type NewDispositionDraft } from '../model'

/** The first problem of a draft, said on the primary button before the click (a `defects` key). */
const firstProblem = (problems: Readonly<Record<string, string>>, order: readonly string[]): string | null => {
  for (const field of order) if (problems[field]) return problems[field]!
  return Object.values(problems)[0] ?? null
}

/** A field's problem: once the person typed in it, or after a first try. */
const shownProblem = (problems: Readonly<Record<string, string>>, field: string, touched: boolean, shown: boolean): string | null => (touched || shown ? (problems[field] ?? null) : null)

function ProblemLine({ text }: { text: string | null }) {
  return text ? (
    <span className="fw-df-danger" role="alert">
      {text}
    </span>
  ) : null
}

function DialogKeys() {
  const t = useT('defects')
  return (
    <span className="fw-df-sub fw-df-dialog-keys">
      <Kbd>⌘</Kbd>
      <Kbd>↵</Kbd> {t('dialog.saveKey')}
    </span>
  )
}

/** ⌘Enter runs the dialog's primary (when it may). */
function useCommandEnter(open: boolean, run: (() => void) | null) {
  useEffect(() => {
    if (!open || !run) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        run()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, run])
}

// ---- Add defect -------------------------------------------------------------------------------------------------------------

/**
 * Add defect (design header "Add defect", `c`, `?new=1`): a defect under a category, or a new category (a code without a
 * parent); the code (upper case, the rule said), its words in Italian and English, and for a defect its default class,
 * the zone on the GarmentZoneMap, the stages and "asks for a note". The domain's own checks are said at their fields; the
 * primary is held with the first one.
 */
export function NewDefectDialog({
  open,
  draft,
  problems,
  problem,
  shown,
  library,
  busy,
  onDraft,
  onCreate,
  onClose,
}: {
  open: boolean
  draft: NewDefectDraft
  problems: Readonly<Record<string, string>>
  problem: string | null
  shown: boolean
  library: Library | null
  busy: boolean
  onDraft: (draft: NewDefectDraft) => void
  onCreate: () => void
  onClose: () => void
}) {
  const t = useT('defects')
  const locale = useLocale()
  const isCategory = draft.kind === 'category'
  const held = busy ? t('held.busy') : firstProblem(problems, ['parentId', 'code', 'labelIt', 'labelEn', 'severity', 'zone', 'stages'])
  const heldText = held && busy ? held : held ? t(held) : null
  const set = (change: Partial<NewDefectDraft>) => onDraft({ ...draft, ...change })
  useCommandEnter(open, held ? null : onCreate)
  const categories = (library?.categories ?? []).filter((category) => category.active)
  const at = (field: string, value: string) => shownProblem(problems, field, value.trim() !== '', shown)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(isCategory ? 'new.titleCategory' : 'new.title')}
      size="lg"
      footer={
        <>
          <DialogKeys />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={heldText} onClick={onCreate}>
            {t(isCategory ? 'new.createCategory' : 'new.create')}
          </Button>
        </>
      }
    >
      <div className="fw-df-dialog">
        {problem && <ProblemLine text={t(problem)} />}
        <div className="fw-df-radios" role="radiogroup" aria-label={t('new.kind')}>
          <RadioCard name="defect-kind" checked={!isCategory} selected={!isCategory} onChange={() => set({ kind: 'defect' })} title={t('new.kindDefect')} description={t('new.kindDefectHint')} />
          <RadioCard name="defect-kind" checked={isCategory} selected={isCategory} onChange={() => set({ kind: 'category', parentId: null })} title={t('new.kindCategory')} description={t('new.kindCategoryHint')} />
        </div>
        {!isCategory && (
          <Field label={t('new.category')} hint={categories.length === 0 ? t('new.noCategory') : undefined} error={shownProblem(problems, 'parentId', !!draft.parentId, shown) ? t(problems.parentId!) : undefined}>
            <Select size="sm" value={draft.parentId ?? ''} onChange={(event) => set({ parentId: event.target.value || null })}>
              <option value="">{t('new.pickCategory')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.code} · {wordsOf(category, locale)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('new.code')} hint={t(isCategory ? 'new.codeHintCategory' : 'new.codeHint')} error={at('code', draft.code) ? t(problems.code!) : undefined}>
          <Input size="sm" value={draft.code} maxLength={40} onChange={(event) => set({ code: typedCode(event.target.value) })} />
        </Field>
        <div className="fw-df-two">
          <Field label={t('col.it')} error={at('labelIt', draft.labelIt) ? t(problems.labelIt!) : undefined}>
            <Input size="sm" value={draft.labelIt} maxLength={80} onChange={(event) => set({ labelIt: event.target.value })} />
          </Field>
          <Field label={t('col.en')} error={at('labelEn', draft.labelEn) ? t(problems.labelEn!) : undefined}>
            <Input size="sm" value={draft.labelEn} maxLength={80} onChange={(event) => set({ labelEn: event.target.value })} />
          </Field>
        </div>
        {!isCategory && (
          <>
            <Field label={t('drawer.severity')} hint={t('drawer.severityHint')} error={shownProblem(problems, 'severity', true, shown) ? t(problems.severity!) : undefined}>
              <Select size="sm" value={draft.severity ?? ''} onChange={(event) => set({ severity: (event.target.value || null) as NewDefectDraft['severity'] })}>
                <option value="">{t('severity.pick')}</option>
                {DEFECT_CLASSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {t(`severity.${entry}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('drawer.zone')} hint={t('drawer.zoneHint')}>
              <GarmentZoneMap label={t('new.zone')} value={draft.zone} onChange={(zone) => set({ zone })} compact />
            </Field>
            <Field label={t('drawer.detail')} hint={t('drawer.detailHint')}>
              <span className="fw-df-actions">
                <Toggle size="sm" checked={draft.needsDetail} aria-label={t('drawer.detail')} onChange={(next) => set({ needsDetail: next })} />
                <span>{t(draft.needsDetail ? 'detail.on' : 'detail.off')}</span>
              </span>
            </Field>
          </>
        )}
        <Field label={t('drawer.stages')} hint={t(draft.stages.length === 0 ? 'drawer.stagesEvery' : 'drawer.stagesSome')}>
          <span className="fw-df-chips" role="group" aria-label={t('drawer.stages')}>
            {QUALITY_STAGES.map((stage) => {
              const on = draft.stages.includes(stage)
              return (
                <FilterChip key={stage} pressed={on} onClick={() => set({ stages: on ? draft.stages.filter((entry) => entry !== stage) : [...draft.stages, stage] })}>
                  {t(`stage.${stage}`)}
                </FilterChip>
              )
            })}
          </span>
        </Field>
      </div>
    </Modal>
  )
}

// ---- Add disposition ----------------------------------------------------------------------------------------------------

/**
 * Add disposition: what it decides (the outcome) first, then the stock move and the record it opens that this outcome
 * allows (the API's `outcomes`, which are the domain's rules), re-inspection, the code and words, and the approval rule
 * (a class, and a value only for whoever has the cost grain). Once used these never change: set it inactive and add another.
 */
export function NewDispositionDialog({
  open,
  draft,
  problems,
  problem,
  shown,
  outcomes,
  seesCost,
  busy,
  onDraft,
  onCreate,
  onClose,
}: {
  open: boolean
  draft: NewDispositionDraft
  problems: Readonly<Record<string, string>>
  problem: string | null
  shown: boolean
  outcomes: readonly OutcomeOption[] | null
  seesCost: boolean
  busy: boolean
  onDraft: (draft: NewDispositionDraft) => void
  onCreate: () => void
  onClose: () => void
}) {
  const t = useT('defects')
  const held = busy ? t('held.busy') : firstProblem(problems, ['outcome', 'stockMoveReason', 'followUp', 'code', 'labelIt', 'labelEn', 'approvalAmount'])
  const heldText = held && busy ? held : held ? t(held) : null
  const set = (change: Partial<NewDispositionDraft>) => onDraft({ ...draft, ...change })
  useCommandEnter(open, held ? null : onCreate)
  const options = draft.outcome ? optionsOf(outcomes, draft.outcome) : null
  const at = (field: string, value: string) => shownProblem(problems, field, value.trim() !== '', shown)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('newDisp.title')}
      size="lg"
      footer={
        <>
          <DialogKeys />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={heldText} onClick={onCreate}>
            {t('newDisp.create')}
          </Button>
        </>
      }
    >
      <div className="fw-df-dialog">
        {problem && <ProblemLine text={t(problem)} />}
        <p className="fw-df-sub">{t('newDisp.fixed')}</p>
        <div className="fw-df-radios is-grid" role="radiogroup" aria-label={t('newDisp.outcome')}>
          {OUTCOMES.map((outcome: DispositionOutcome) => (
            <RadioCard
              key={outcome}
              name="disposition-outcome"
              checked={draft.outcome === outcome}
              selected={draft.outcome === outcome}
              onChange={() => onDraft(withOutcome(draft, outcome, outcomes))}
              title={t(`outcome.${outcome}`)}
              description={t(`outcomeHint.${outcome}`)}
            />
          ))}
        </div>
        {shown && problems.outcome && <ProblemLine text={t(problems.outcome)} />}
        {options && (
          <div className="fw-df-two">
            <Field label={t('newDisp.move')} hint={options.moves.length === 1 ? t('newDisp.onlyOne') : undefined}>
              <Select size="sm" value={draft.stockMoveReason ?? ''} disabled={options.moves.length === 1} onChange={(event) => set({ stockMoveReason: (event.target.value || null) as NewDispositionDraft['stockMoveReason'] })}>
                {options.moves.map((move) => (
                  <option key={move ?? 'none'} value={move ?? ''}>
                    {t(move ? `move.${move}` : 'move.none')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('newDisp.followUp')} hint={options.followUps.length === 1 ? t('newDisp.onlyOne') : undefined}>
              <Select size="sm" value={draft.followUp ?? ''} disabled={options.followUps.length === 1} onChange={(event) => set({ followUp: (event.target.value || null) as NewDispositionDraft['followUp'] })}>
                {options.followUps.map((followUp) => (
                  <option key={followUp ?? 'none'} value={followUp ?? ''}>
                    {t(followUp ? `followUp.${followUp}` : 'followUp.none')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {draft.outcome && (
          <Field label={t('col.reinspection')} hint={draft.outcome === 'USE_AS_IS' ? t('disp.reinspectHeld') : undefined}>
            <span className="fw-df-actions">
              <Toggle size="sm" checked={draft.reinspection} disabled={draft.outcome === 'USE_AS_IS'} aria-label={t('col.reinspection')} onChange={(next) => set({ reinspection: next })} />
              <span>{t(draft.reinspection ? 'reinspection.on' : 'reinspection.off')}</span>
            </span>
          </Field>
        )}
        <Field label={t('new.code')} hint={t('newDisp.codeHint')} error={at('code', draft.code) ? t(problems.code!) : undefined}>
          <Input size="sm" value={draft.code} maxLength={40} onChange={(event) => set({ code: typedCode(event.target.value, 'disposition') })} />
        </Field>
        <div className="fw-df-two">
          <Field label={t('col.it')} error={at('labelIt', draft.labelIt) ? t(problems.labelIt!) : undefined}>
            <Input size="sm" value={draft.labelIt} maxLength={80} onChange={(event) => set({ labelIt: event.target.value })} />
          </Field>
          <Field label={t('col.en')} error={at('labelEn', draft.labelEn) ? t(problems.labelEn!) : undefined}>
            <Input size="sm" value={draft.labelEn} maxLength={80} onChange={(event) => set({ labelEn: event.target.value })} />
          </Field>
        </div>
        <div className="fw-df-two">
          <Field label={t('newDisp.approvalSeverity')} hint={t('newDisp.approvalHint')}>
            <Select size="sm" value={draft.approvalSeverity ?? ''} onChange={(event) => set({ approvalSeverity: (event.target.value || null) as NewDispositionDraft['approvalSeverity'] })}>
              <option value="">{t('approval.severity.none')}</option>
              {DEFECT_CLASSES.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`approval.severity.${entry}`)}
                </option>
              ))}
            </Select>
          </Field>
          {seesCost ? (
            <Field label={t('newDisp.approvalAmount')} hint={t('newDisp.amountHint')} error={at('approvalAmount', draft.approvalAmount) ? t(problems.approvalAmount!) : undefined}>
              <Input size="sm" inputMode="decimal" value={draft.approvalAmount} onChange={(event) => set({ approvalAmount: event.target.value })} />
            </Field>
          ) : (
            <Field label={t('newDisp.approvalAmount')}>
              <span className="fw-df-sub">{t('disp.amountHidden')}</span>
            </Field>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ---- Retire, delete, photo, keys -----------------------------------------------------------------------------------------

/**
 * Retire (design df-retire; the DS ActionConfirm speaks English only, so the confirm is composed on the DS Modal): what
 * happens to each code in words — a used code stays on its records and leaves the pickers; a category takes its defects
 * out of the pickers with it.
 */
export function RetireDialog({ open, lines, count, busy, onConfirm, onClose }: { open: boolean; lines: readonly { key: string; params: Record<string, string | number> }[]; count: number; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const t = useT('defects')
  useCommandEnter(open, busy ? null : onConfirm)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('retire.title', { count })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={busy ? t('held.busy') : null} onClick={onConfirm}>
            {t('retire.confirm', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-df-dialog">
        <ul className="fw-df-lines">
          {lines.map((line) => (
            <li key={`${line.key}-${line.params.code}`}>{t(line.key, line.params)}</li>
          ))}
        </ul>
        <p className="fw-df-sub">{t('retire.restore')}</p>
      </div>
    </Modal>
  )
}

/** Delete an unused code (never undone: a used one is retired instead). */
export function DeleteDialog({ open, code, busy, onConfirm, onClose }: { open: boolean; code: DefectCode | null; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const t = useT('defects')
  const locale = useLocale()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('delete.title', { code: code?.code ?? '' })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={onConfirm}>
            {t('delete.confirm')}
          </Button>
        </>
      }
    >
      <p>{t('delete.body', { code: code?.code ?? '', words: code ? wordsOf(code, locale) : '' })}</p>
    </Modal>
  )
}

/** A photo of the code with the DS photo capture (markup on: arrows and circles show the defect). */
export function PhotoDialog({ open, code, heldReason, onCapture, onClose }: { open: boolean; code: DefectCode | null; heldReason: string | null; onCapture: (photo: CapturedPhoto) => void; onClose: () => void }) {
  const t = useT('defects')
  const words = usePhotoWords()
  return (
    <Modal open={open} onClose={onClose} title={t('photo.title', { code: code?.code ?? '' })} size="lg">
      {open && <PhotoCapture label={t('photo.label', { code: code?.code ?? '' })} words={words} onCapture={onCapture} onCancel={onClose} heldReason={heldReason} />}
    </Modal>
  )
}

/** Every key of this page (the footer's icon holds the list's; this is the full list). */
export function KeysDialog({ open, keys, onClose }: { open: boolean; keys: readonly ListKey[]; onClose: () => void }) {
  const t = useT('defects')
  const tl = useT('lists')
  return (
    <Modal open={open} onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-df-keys-list">
        {keys.map((entry) => (
          <div key={entry.keys.join('+')}>
            <dt>
              {entry.keys.map((key): ReactNode => (
                <Kbd key={key}>{key === 'click' ? tl('keys.click') : key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? tl(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
