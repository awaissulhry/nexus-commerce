'use client'

/**
 * FloorChecklist — grouped pass / fail checks on a floor tablet (B-W2b-78, design part FloorChecklist): the final
 * inspection's groups (labels, garment, armour, packaging), first piece, cutting, incoming components, an operation's
 * steps, a machine job.
 *
 *   <FloorChecklist groups={groups} answers={answers} reasons={defectTiles}
 *                   onPass={(id) => record(id, 'pass')} onFail={(id, { reasonId, photo }) => record(id, 'fail', reasonId, photo)}
 *                   onPassGroup={(groupId, ids) => recordMany(ids)} renderPhoto={(step) => <PhotoCapture … onCapture={step.done} />}
 *                   action={{ label: 'Sign the result', onClick: toSign }} labels={ds.floorChecklist} reasonWords={floor.reasons} />
 *
 * - Groups as a strip of big buttons (name, state icon AND word); one group's checks at a time — one job per screen.
 *   Each check: its icon or example photo, the words, a hint, the answer in words (who and when, when the app gives
 *   them), then Pass and Fail (`aria-pressed`). A required check is the default; an optional one says so.
 * - "Group passes" passes every check of the group not answered yet (after looking: one tap per group), then the next
 *   group that is not done opens.
 * - Fail asks why — the reason tiles (`ReasonGrid`: the check's, the group's or the checklist's) — then a photo when
 *   asked (`photo`, or a reason marked `photoNeeded`): the app draws its camera in `renderPhoto` and calls `done`.
 *   Only then is `onFail` called. Back and Cancel at each step.
 * - The main action (`action`) is held — focusable, announced, inert — until every required check is answered, with
 *   what is left in words on screen (`checklistHeld`; a host with its own action bar holds it the same way).
 * - `heldReason` holds every button with the reason on screen. A check's own `heldReason` holds it alone.
 * - Each tap is said once in a polite region ("Care label: passed").
 * - Sized by the density: inside `data-density="floor"` every target is glove-sized (56 px, 48 px apart). Data in,
 *   events out: the app records each answer (online or through the floor queue).
 */
import { createElement, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronLeft, CircleDashed, CircleDot, X } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { FloorButton } from '../FloorButton'
import { ReasonGrid } from '../ReasonGrid/ReasonGrid'
import type { ReasonGridWords, ReasonTile } from '../ReasonGrid/reasonGridModel'
import { FLOOR_CHECKLIST_LABELS, type FloorChecklistLabels } from './FloorChecklistLabels'
import {
  checklistHeld,
  checklistProgress,
  groupPassIds,
  groupState,
  isRequired,
  nextOpenGroup,
  type ChecklistGroupState,
  type ChecklistResult,
} from './floorChecklistModel'
import '../floor.css'
import './floorChecklist.css'

export interface FloorChecklistItem {
  id: string
  /** The check in the worker's words ("CE mark"). */
  label: string
  /** A second line ("on the inside collar label"). */
  hint?: string
  /** The app's icon for the check. */
  icon?: ReactNode
  /** An example photo (its address): what right looks like. Drawn instead of the icon. */
  photo?: string
  /** Default true. */
  required?: boolean
  /** Why this check cannot be answered now. */
  heldReason?: string | null
  /** The reasons a fail may have (else the group's, else the checklist's). */
  reasons?: readonly ReasonTile[]
}

export interface FloorChecklistGroup {
  id: string
  label: string
  icon?: ReactNode
  items: readonly FloorChecklistItem[]
  reasons?: readonly ReasonTile[]
}

export interface FloorChecklistAnswer {
  result: ChecklistResult
  /** The reason a fail was given. */
  reasonId?: string
  /** Its words, as recorded. */
  reasonLabel?: string
  /** A photo was taken with the fail. */
  photo?: boolean
  /** Who answered (a step of an operation: who and when, MES-102). */
  by?: string
  /** When, written in the site's time. */
  at?: string
}

export interface FloorChecklistFail {
  reasonId?: string
  /** What the app's camera handed to `done`. */
  photo?: unknown
}

export interface FloorChecklistPhotoStep {
  itemId: string
  item: FloorChecklistItem
  reasonId?: string
  /** No skipping: the reason or the setting needs a photo. */
  required: boolean
  /** The photo is taken (the app uploads it, online or through the queue): records the fail. */
  done: (photo?: unknown) => void
  cancel: () => void
}

export interface FloorChecklistAction {
  label: string
  icon?: ReactNode
  onClick: () => void
  busy?: boolean
  busyLabel?: string
}

export interface FloorChecklistProps {
  groups: readonly FloorChecklistGroup[]
  answers: Readonly<Record<string, FloorChecklistAnswer | undefined>>
  onPass: (itemId: string) => void
  onFail: (itemId: string, fail: FloorChecklistFail) => void
  /** "Group passes": the checks it passes (not answered, not held). */
  onPassGroup: (groupId: string, itemIds: string[]) => void
  /** The open group, when the app keeps it. */
  group?: string
  defaultGroup?: string
  onGroupChange?: (groupId: string) => void
  /** The reasons any fail may have (a check's or a group's own come first). */
  reasons?: readonly ReasonTile[]
  /** Ask a photo after a fail: `off`, `optional` (default when `renderPhoto` is given) or `required`. */
  photo?: 'off' | 'optional' | 'required'
  /** The app's camera for the photo step (PhotoCapture). */
  renderPhoto?: (step: FloorChecklistPhotoStep) => ReactNode
  /** The main action, held until every required check is answered. */
  action?: FloorChecklistAction
  /** Holds every button, with the reason on screen. */
  heldReason?: string | null
  title?: ReactNode
  /** The level of the title and the group's name (default 2; the group's is one more). */
  headingLevel?: 2 | 3
  labels?: Partial<FloorChecklistLabels>
  /** The reason tiles' words (ReasonGrid). */
  reasonWords?: Partial<ReasonGridWords>
  /** For the reason tiles' numbers. */
  locale?: string
  id?: string
}

type Failing = { itemId: string; step: 'reason' | 'photo'; reasonId?: string; photoNeeded?: boolean }

const STATE_ICON: Record<ChecklistGroupState, typeof Check> = { open: CircleDashed, partly: CircleDot, passed: Check, failed: X }

export function FloorChecklist(props: FloorChecklistProps) {
  const { groups, answers, labels } = props
  const lw = mergeLabels(FLOOR_CHECKLIST_LABELS, labels)
  const auto = useId()
  const titleId = `${auto}-title`
  const groupTitleId = `${auto}-group`
  const [own, setOwn] = useState(props.defaultGroup ?? groups[0]?.id)
  const activeId = props.group ?? own
  const group = groups.find((g) => g.id === activeId) ?? groups[0]
  const [failing, setFailing] = useState<Failing | null>(null)
  const [said, setSaid] = useState('')
  const photoMode = props.photo ?? (props.renderPhoto ? 'optional' : 'off')
  const held = props.heldReason?.trim() ? props.heldReason : null
  const H = `h${props.headingLevel ?? 2}` as 'h2'
  const H2 = `h${(props.headingLevel ?? 2) + 1}` as 'h3'

  // The focus follows the steps: the question when a step opens, the check's Fail button when the list comes back.
  const askRef = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const backTo = useRef<string | null>(null)
  useEffect(() => {
    if (failing) askRef.current?.focus()
    else if (backTo.current) {
      const id = backTo.current
      backTo.current = null
      const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-item]') ?? []).find((el) => el.dataset.item === id)
      row?.querySelector<HTMLElement>('.nds-fcl-buttons button:last-of-type')?.focus()
    }
    // Runs when the step changes (not on every answer), so a tap in the list keeps its own focus.
  }, [failing?.itemId, failing?.step])

  // A failing check that went away (the list changed) closes the fail step.
  const failingItem = failing ? groups.flatMap((g) => g.items.map((item) => ({ item, group: g }))).find((e) => e.item.id === failing.itemId) : undefined
  useEffect(() => {
    if (failing && !failingItem) setFailing(null)
  }, [failing, failingItem])

  const choose = (id: string) => {
    if (props.group === undefined) setOwn(id)
    props.onGroupChange?.(id)
  }

  const pass = (item: FloorChecklistItem) => {
    props.onPass(item.id)
    setSaid(lw.announcePass(item.label))
  }

  const commit = (itemId: string, fail: FloorChecklistFail) => {
    const item = failingItem?.item ?? groups.flatMap((g) => g.items).find((i) => i.id === itemId)
    props.onFail(itemId, fail)
    setFailing(null)
    if (item) setSaid(lw.announceFail(item.label))
  }

  const reasonsOf = (item: FloorChecklistItem, owner?: FloorChecklistGroup) => item.reasons ?? owner?.reasons ?? props.reasons ?? []

  const startFail = (item: FloorChecklistItem, owner: FloorChecklistGroup) => {
    backTo.current = item.id
    if (reasonsOf(item, owner).length) setFailing({ itemId: item.id, step: 'reason' })
    else if (props.renderPhoto && photoMode !== 'off') setFailing({ itemId: item.id, step: 'photo' })
    else commit(item.id, {})
  }

  const passGroup = (owner: FloorChecklistGroup) => {
    const ids = groupPassIds(owner, answers)
    if (!ids.length) return
    props.onPassGroup(owner.id, ids)
    setSaid(lw.announceGroup(owner.label, ids.length))
    // The next group not done, as the answers will be once these are recorded.
    const after = { ...answers, ...Object.fromEntries(ids.map((id) => [id, { result: 'pass' as const }])) }
    const next = nextOpenGroup(groups, after, owner.id)
    if (next && next !== owner.id) choose(next)
  }

  // One live region for both steps (the same place in the tree, so it is never remounted and a word is never lost).
  const live = (
    <span className="nds-fcl-sr" role="status">
      {said}
    </span>
  )

  // ---- the fail step: why, then (when asked) a photo ----
  if (failing && failingItem) {
    const { item, group: owner } = failingItem
    const reasons = reasonsOf(item, owner)
    const tiles = held ? reasons.map((r) => ({ ...r, heldReason: held })) : reasons
    const photoRequired = photoMode === 'required' || failing.photoNeeded === true
    return (
      <>
        <section id={props.id} className="nds-fcl" data-failing={failing.step} aria-labelledby={titleId}>
          <H id={titleId} ref={askRef} tabIndex={-1} className="nds-fcl-ask">
            {failing.step === 'reason' ? lw.whatIsWrong(item.label) : lw.photo(item.label)}
          </H>
          {held ? <p className="nds-fcl-held">{held}</p> : null}
          {failing.step === 'reason' ? (
            <ReasonGrid
              label={lw.reasons}
              hideLabel
              reasons={tiles}
              value={failing.reasonId ?? null}
              locale={props.locale}
              words={props.reasonWords}
              onChange={(reasonId, tile) => {
                const needsPhoto = photoMode === 'required' || tile.photoNeeded === true
                if (props.renderPhoto && (photoMode !== 'off' || tile.photoNeeded)) setFailing({ itemId: item.id, step: 'photo', reasonId, photoNeeded: needsPhoto })
                else commit(item.id, { reasonId })
              }}
            />
          ) : (
            <>
              {photoRequired ? <p className="nds-fcl-note">{lw.photoNeeded}</p> : null}
              {props.renderPhoto?.({
                itemId: item.id,
                item,
                reasonId: failing.reasonId,
                required: photoRequired,
                done: (photo) => commit(item.id, { reasonId: failing.reasonId, photo }),
                cancel: () => setFailing(null),
              })}
            </>
          )}
          <div className="nds-fcl-row">
            {failing.step === 'photo' && reasons.length ? (
              <FloorButton variant="secondary" icon={<ChevronLeft />} onClick={() => setFailing({ itemId: item.id, step: 'reason', reasonId: failing.reasonId })}>
                {lw.back}
              </FloorButton>
            ) : null}
            {failing.step === 'photo' && !photoRequired ? (
              <FloorButton variant="secondary" heldReason={held} onClick={() => commit(item.id, { reasonId: failing.reasonId })}>
                {lw.skipPhoto}
              </FloorButton>
            ) : null}
            <FloorButton variant="quiet" onClick={() => setFailing(null)}>
              {lw.cancel}
            </FloorButton>
          </div>
        </section>
        {live}
      </>
    )
  }

  const progress = checklistProgress(groups, answers)
  const mainHeld = checklistHeld(groups, answers, lw)
  const state = group ? groupState(group, answers) : 'open'
  const passIds = group ? groupPassIds(group, answers) : []
  const answeredHere = group ? group.items.filter((item) => answers[item.id] !== undefined).length : 0

  return (
    <>
      <section ref={listRef} id={props.id} className="nds-fcl" aria-labelledby={props.title ? titleId : undefined}>
        {props.title ? (
          <H id={titleId} className="nds-fcl-title">
            {props.title}
          </H>
        ) : null}
        <p className="nds-fcl-progress">
          {groups.length > 1 ? lw.progress(progress.groupsDone, progress.groups) : lw.checked(progress.answered, progress.total)}
          {progress.failed ? <span className="nds-fcl-failed"> · {lw.failedCount(progress.failed)}</span> : null}
        </p>
        {held ? <p className="nds-fcl-held">{held}</p> : null}
        {groups.length > 1 ? (
          <div className="nds-fcl-groups" role="group" aria-label={lw.groups}>
            {groups.map((g) => {
              const gs = groupState(g, answers)
              const current = g.id === group?.id
              return (
                <FloorButton
                  key={g.id}
                  size="md"
                  variant={current ? 'primary' : gs === 'failed' ? 'danger' : gs === 'passed' ? 'success' : 'secondary'}
                  icon={gs === 'open' && g.icon ? g.icon : createElement(STATE_ICON[gs])}
                  aria-pressed={current}
                  onClick={() => choose(g.id)}
                >
                  {g.label}
                  <span className="nds-fcl-group-state"> · {lw.states[gs]}</span>
                </FloorButton>
              )
            })}
          </div>
        ) : null}
        {group ? (
          <section className="nds-fcl-group" data-state={state} aria-labelledby={groupTitleId}>
            <div className="nds-fcl-group-head">
              {group.icon ? (
                <span className="nds-fcl-group-icon" aria-hidden>
                  {group.icon}
                </span>
              ) : null}
              <H2 id={groupTitleId} className="nds-fcl-group-title">
                {group.label}
              </H2>
              <span className="nds-fcl-group-count">
                {lw.checked(answeredHere, group.items.length)} · {lw.states[state]}
              </span>
              <FloorButton size="md" variant="success" icon={<Check />} heldReason={held ?? (passIds.length ? null : lw.groupAnswered)} onClick={() => passGroup(group)}>
                {lw.groupPasses}
              </FloorButton>
            </div>
            <ul className="nds-fcl-items">
              {group.items.map((item) => {
                const answer = answers[item.id]
                const itemHeld = held ?? (item.heldReason?.trim() ? item.heldReason : null)
                const who = [answer?.by, answer?.at].filter(Boolean).join(' · ')
                const words =
                  answer?.result === 'pass'
                    ? lw.passed
                    : answer?.result === 'fail'
                      ? [answer.reasonLabel ? lw.failedBecause(answer.reasonLabel) : lw.failed, answer.photo ? lw.withPhoto : null].filter(Boolean).join(' · ')
                      : isRequired(item)
                        ? lw.notChecked
                        : `${lw.notChecked} · ${lw.optional}`
                return (
                  <li key={item.id} className="nds-fcl-item" data-item={item.id} data-result={answer?.result ?? 'none'}>
                    {item.photo || item.icon ? (
                      <span className="nds-fcl-visual" aria-hidden>
                        {item.photo ? <img src={item.photo} alt="" /> : item.icon}
                      </span>
                    ) : null}
                    <span className="nds-fcl-text">
                      <span className="nds-fcl-label">{item.label}</span>
                      {item.hint ? <span className="nds-fcl-hint">{item.hint}</span> : null}
                      <span className="nds-fcl-answer">
                        {answer?.result === 'pass' ? (
                          <Check aria-hidden className="nds-fcl-answer-icon" />
                        ) : answer?.result === 'fail' ? (
                          <X aria-hidden className="nds-fcl-answer-icon" />
                        ) : null}
                        {words}
                        {who ? ` · ${who}` : null}
                      </span>
                      {item.heldReason?.trim() && !held ? <span className="nds-fcl-item-held">{item.heldReason}</span> : null}
                    </span>
                    <span className="nds-fcl-buttons">
                      <FloorButton
                        variant={answer?.result === 'pass' ? 'success' : 'secondary'}
                        icon={<Check />}
                        aria-pressed={answer?.result === 'pass'}
                        heldReason={itemHeld}
                        onClick={() => pass(item)}
                      >
                        {lw.pass}
                      </FloorButton>
                      <FloorButton
                        variant={answer?.result === 'fail' ? 'danger' : 'secondary'}
                        icon={<X />}
                        aria-pressed={answer?.result === 'fail'}
                        heldReason={itemHeld}
                        onClick={() => startFail(item, group)}
                      >
                        {lw.fail}
                      </FloorButton>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
        {props.action ? (
          <div className="nds-fcl-action">
            <FloorButton
              size="lg"
              variant="primary"
              block
              icon={props.action.icon}
              heldReason={mainHeld ?? held ?? (props.action.busy ? (props.action.busyLabel ?? props.action.label) : null)}
              onClick={props.action.onClick}
            >
              {props.action.busy && props.action.busyLabel ? props.action.busyLabel : props.action.label}
            </FloorButton>
            {mainHeld ? <p className="nds-fcl-held">{mainHeld}</p> : null}
          </div>
        ) : null}
      </section>
      {live}
    </>
  )
}
