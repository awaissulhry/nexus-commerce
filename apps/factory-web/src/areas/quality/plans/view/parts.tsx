'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Spinner, TokenChip } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { QualityMessages } from '../../_shared/parts'
import type { StepUpState } from '../../_shared/hooks'
import type { Read } from '../../_shared/model'
import type { PickOption } from '../api'
import { GARMENT_CATEGORIES, MATERIAL_CATEGORIES, type ChipKind, type PlanStage } from '../constants'
import { chipHref, chipKey, planState, type ChipDraft, type Problem, type Words } from '../model'
import type { PlanRow } from '../api'
import '../plans.css'

/**
 * The parts the screens of Inspection plans & AQL share (SCR-077, SCR-077-plan, SCR-077-print): the catalogues, words from
 * keys, the plan's state, chips read and edited, the step-up dialog in this page's words, the keys dialog. Draw only.
 */

/** The page's catalogues (QualityMessages adds `quality`, `lists`, `records`). */
export const PLANS_NAMESPACES = ['quality-plans', 'quality-aql'] as const

export function PlansMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={PLANS_NAMESPACES}>{children}</QualityMessages>
}

/** Words from a key and its values; a value that is itself a key of this catalogue (`stage.FINAL`) is said too. */
export function useSay(): (words: Words | null | undefined) => string {
  const t = useT('quality-plans')
  return (words) => {
    if (!words) return ''
    const params: Record<string, string | number> = {}
    for (const [name, value] of Object.entries(words.params ?? {})) params[name] = typeof value === 'string' && /^(stage|class|type|kind|category|event|frequency)\.[A-Z_]+$/.test(value) ? t(value) : value
    return t(words.key, params)
  }
}

/** The first problem at a path (or under it), in words; null when there is none. */
export function problemAt(problems: readonly Problem[], path: string, shown = true): Problem | null {
  if (!shown) return null
  return problems.find((entry) => entry.path === path || entry.path.startsWith(`${path}/`)) ?? null
}

/** A plan's state: Approved / Draft / Retired, and "Waiting approval" when its draft was submitted. */
export function PlanStatePill({ row }: { row: PlanRow }) {
  const t = useT('quality-plans')
  const say = useSay()
  const state = planState(row)
  return (
    <span className="fw-qp-state">
      <Pill tone={state.tone}>{say(state.status)}</Pill>
      {state.waiting && <Pill tone="warning">{t('status.waiting')}</Pill>}
    </span>
  )
}

/** A chip in words: "Category · Jackets", "Style · JKT-01 Moto jacket". */
export function useChipText(): (chip: Pick<ChipDraft, 'kind' | 'value' | 'label'>) => string {
  const t = useT('quality-plans')
  return (chip) => `${t(`kind.${chip.kind}`)} · ${chip.kind === 'CATEGORY' ? t(`category.${chip.value}`) : chip.label === '?' ? t('chips.outOfSight') : chip.label}`
}

/** "Applies to" read: the chips, or "everything of its stage". */
export function ChipsLine({ chips, prefix, links = false, empty }: { chips: readonly ChipDraft[]; prefix: string; links?: boolean; empty?: string }) {
  const t = useT('quality-plans')
  const text = useChipText()
  if (chips.length === 0) return <span className="fw-qp-muted">{empty ?? t('chips.everything')}</span>
  return (
    <span className="fw-qp-chips">
      {chips.map((chip) => {
        const href = links ? chipHref(prefix, chip) : null
        return (
          <TokenChip key={chipKey(chip)}>
            {href ? (
              <Link href={href} className="fw-qp-chip-link">
                {text(chip)}
              </Link>
            ) : (
              text(chip)
            )}
          </TokenChip>
        )
      })}
    </span>
  )
}

/** The search of a chip's record: what was typed and what the list answered. */
export interface ChipSearch {
  readonly kind: ChipKind
  readonly q: string
  /** The matches of a record's list; null for a category (picked from the list here) or before anything is typed. */
  readonly read: Read<PickOption[]> | null
}

export interface ChipEditorProps {
  /** The field's name ("Applies to"). */
  label: string
  chips: readonly ChipDraft[]
  /** The kinds offered (the event's, or the stage's). */
  kinds: readonly ChipKind[]
  /** The kinds whose list the person may read (else the kind says why). */
  pickable: (kind: ChipKind) => boolean
  stage?: PlanStage | null
  prefix: string
  search: ChipSearch | null
  problems?: readonly Problem[]
  path?: string
  disabled?: boolean
  onChange: (chips: ChipDraft[]) => void
  /** The kind picked, or words typed: the container reads the record's list (a category needs no read). */
  onSearch: (kind: ChipKind, q: string) => void
}

/**
 * Applies-to chips (design "Rule chips by style, category, material, supplier, operation, customer"): each chip a DS
 * TokenChip with its remove; add one by its kind — a category from the list, a record found by its code or name (the
 * container searches that record's own list; this part fetches nothing).
 */
export function ChipEditor({ label, chips, kinds, pickable, stage, prefix, search, problems = [], path = 'appliesTo', disabled, onChange, onSearch }: ChipEditorProps) {
  const t = useT('quality-plans')
  const say = useSay()
  const text = useChipText()
  const kind: ChipKind = search?.kind ?? (kinds.includes('CATEGORY') ? 'CATEGORY' : (kinds[0] ?? 'STYLE'))
  const taken = new Set(chips.map(chipKey))
  const add = (chip: ChipDraft) => !taken.has(chipKey(chip)) && onChange([...chips, chip])
  const categories = stage === 'INCOMING' ? [...MATERIAL_CATEGORIES, ...GARMENT_CATEGORIES] : [...GARMENT_CATEGORIES, ...MATERIAL_CATEGORIES]
  const listProblem = problemAt(problems, path)
  return (
    <fieldset className="fw-qp-chip-editor" disabled={disabled}>
      <legend className="fw-qp-legend">{label}</legend>
      <div className="fw-qp-chips" aria-live="polite">
        {chips.length === 0 && <span className="fw-qp-muted">{t('chips.everything')}</span>}
        {chips.map((chip, index) => {
          const href = chipHref(prefix, chip)
          const wrong = problemAt(problems, `${path}/${index}`)
          return (
            <TokenChip key={chipKey(chip)} removeLabel={t('chips.remove', { chip: text(chip) })} onRemove={disabled ? undefined : () => onChange(chips.filter((_, at) => at !== index))}>
              {href ? <Link href={href}>{text(chip)}</Link> : text(chip)}
              {wrong && <span className="fw-qp-chip-problem"> — {say(wrong)}</span>}
            </TokenChip>
          )
        })}
      </div>
      {listProblem && !/\/\d+/.test(listProblem.path.slice(path.length)) && <p className="fw-qp-problem">{say(listProblem)}</p>}
      {!disabled && (
        <div className="fw-qp-chip-add">
          <Field label={t('chips.kind')}>
            <Select
              value={kind}
              onChange={(event) => onSearch(event.target.value as ChipKind, '')}
            >
              {kinds.map((entry) => (
                <option key={entry} value={entry} disabled={!pickable(entry)}>
                  {pickable(entry) ? t(`kind.${entry}`) : t('chips.kindHeld', { kind: t(`kind.${entry}`) })}
                </option>
              ))}
            </Select>
          </Field>
          {kind === 'CATEGORY' ? (
            <Field label={t('chips.category')}>
              <Select
                value=""
                onChange={(event) => {
                  const value = event.target.value
                  if (value) add({ kind: 'CATEGORY', value, label: value })
                }}
              >
                <option value="">{t('chips.pickCategory')}</option>
                {categories.map((code) => (
                  <option key={code} value={code} disabled={taken.has(`CATEGORY|${code}`)}>
                    {t(`category.${code}`)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <>
              <Field label={t('chips.find', { kind: t(`kind.${kind}`) })}>
                <Input value={search?.q ?? ''} placeholder={t('chips.findHint')} onChange={(event) => onSearch(kind, event.target.value)} />
              </Field>
              <Field label={t('chips.matches')}>
                <Select
                  value=""
                  disabled={!search?.read?.value || search.read.value!.length === 0}
                  onChange={(event) => {
                    const option = search?.read?.value?.find((entry) => entry.id === event.target.value)
                    if (option) add({ kind, value: option.id, label: option.label })
                  }}
                >
                  <option value="">
                    {!search?.read
                      ? t('chips.typeFirst')
                      : search.read.value === null && search.read.problem === null
                        ? t('chips.searching')
                        : search.read.problem
                          ? t(search.read.problem)
                          : search.read.value!.length === 0
                            ? t('chips.noMatch')
                            : t('chips.pick', { count: search.read.value!.length })}
                  </option>
                  {(search?.read?.value ?? []).map((option) => (
                    <option key={option.id} value={option.id} disabled={taken.has(`${kind}|${option.id}`)}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {search?.read && search.read.value === null && search.read.problem === null && <Spinner size={14} />}
            </>
          )}
        </div>
      )}
    </fieldset>
  )
}

/** The DS StepUpModal in this page's words (what the code allows; the refusal of a code). */
export function PlansStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit: (code: string) => void; onCancel: () => void }) {
  const t = useT('quality-plans')
  const q = useT('quality')
  return (
    <StepUpModal
      open={state.open}
      title={t('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? q(state.problem) : null}
      onSubmit={onSubmit}
      onClose={onCancel}
      confirmLabel={t('stepUp.confirm')}
    />
  )
}

/** ⋯ Keyboard shortcuts: the page's own keys (the lists' keys are in their footer's icon). */
export function KeysDialog({ open, keys, onClose }: { open: boolean; keys: readonly { keys: string; does: string }[]; onClose: () => void }) {
  const t = useT('quality-plans')
  return (
    <Modal open={open} onClose={onClose} title={t('keys.title')} size="sm" footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <dl className="fw-qp-keys">
        {keys.map((entry) => (
          <div key={entry.keys}>
            <dt>
              <kbd>{entry.keys}</kbd>
            </dt>
            <dd>{entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}

/** A section heading with a sentence under it and actions on the right. */
export function SectionHead({ id, title, sub, actions }: { id?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-qp-section-head">
      <div className="fw-qp-section-title">
        <h2 id={id}>{title}</h2>
        {sub && <p className="fw-qp-muted">{sub}</p>}
      </div>
      {actions && <div className="fw-qp-actions">{actions}</div>}
    </div>
  )
}

export const AddIcon = () => <Plus size={14} aria-hidden />
