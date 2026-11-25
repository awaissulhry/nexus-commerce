'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, Eye, RefreshCw, WifiOff } from 'lucide-react'
import { Banner, Card, Field, type MenuItemDef } from '@nexus/ui/components'
import { SaveStatus, type SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { DateField, Textarea, useDsWords } from '../../i18n/ds-parts'
import { ListKeysInfo } from '../../../list-frame/ListKeysInfo'
import type { DraftFilePart } from '../schema'
import {
  draftBannerOf,
  draftFilesOf,
  draftMailName,
  filesAddHeld,
  LATER_PART_OF,
  laterToggleOf,
  problemPlace,
  problemWords,
  savedWords,
  shipToOptions,
  uploadsOpenOf,
  type DraftChip,
  type DraftPart,
  type DraftView,
  type HeaderDraft,
  type HeaderField,
} from '../model'
import { DraftDoorProvider, useDraftWords, type DraftDoor } from '../words'
import { DraftFilesCard, type DraftFilesActions, type DraftFilesModel, type UploadRow } from './DraftFiles'
import { LinesSection, type LinesActions } from './LinesSection'
import { DraftChecklist, PartHeading } from './parts'
import { PeopleRoster, type PeopleRosterActions } from './PeopleRoster'

/**
 * The ONE draft order's page body (THE SIMPLE ORDER START, od-w1.1 — moved out of the portal's `NewOrderView`, F-CP-150…154): ONE
 * banner by weight, the meta line (who reads it, when it was saved), the checklist strip, the host's panels, the part cards — What you
 * need (the lines, "Add a line ▾"), Logos ‖ References, People and sizes, Date and delivery ‖ Notes —, the host's own cards, the keys
 * in ONE information icon at the foot. No frame, no band, no thread, no price: each host draws its frame around it (the portal's
 * record frame, the office's), gives its commands through `actions` and its own cards through `cards` (money lives only there).
 * `kind` picks the door's whole word set.
 */

export interface DraftPageModel {
  /** The draft without a single price (`draftViewOf`). */
  draft: DraftView
  /** Today in the site's zone: the earliest requested date. */
  today: string
  header: HeaderDraft
  /** Field → a key of the part's words. */
  headerErrors: Partial<Record<HeaderField, string>>
  save: SaveStatusState
  cells: Readonly<Record<string, Readonly<Record<string, number>>>>
  notes: Readonly<Record<string, string>>
  saving: readonly string[]
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
  /** "Add a new address": held with the reason (words), or null. */
  addAddressHeld: string | null
  /** A refusal in the host's words, or null. */
  problem: string | null
  /** The draft changed elsewhere while something was typed here. */
  stale: boolean
  /** Who changed it meanwhile (a name), or null. */
  staleBy?: string | null
  notice: { lines: readonly string[]; undo: boolean } | null
  /** The problems are listed (after Show me). */
  showProblems: boolean
  offlineSince: string | null
  /** The checklist strip (the host counts its own parts). */
  chips: readonly DraftChip[]
  /** "Add a line ▾": the host's ways in. */
  addLine: readonly MenuItemDef[]
  /** The files going up now, or that did not go (their words). */
  uploads?: readonly UploadRow[]
  /** The keys of the page (the ONE information icon at the foot). */
  keys: readonly { keys: string[]; words: string }[]
}

export interface DraftPageActions {
  onHeader?: (field: HeaderField, value: string) => void
  onHeaderLeave?: (field: HeaderField) => void
  onAddAddress?: () => void
  onShowMe?: () => void
  onUndo?: () => void
  onDismissNotice?: () => void
  onReload?: () => void
  onRetrySave?: () => void
  onChip?: (target: string) => void
  files?: DraftFilesActions
  lines?: LinesActions
  people?: PeopleRosterActions
}

export function DraftPage({ kind, model, actions, panels, cards, dialogs, onSendKey }: { kind: DraftDoor; model: DraftPageModel; actions?: DraftPageActions; panels?: ReactNode; cards?: ReactNode; dialogs?: ReactNode; onSendKey?: () => void }) {
  return (
    <DraftDoorProvider door={kind}>
      <DraftBody model={model} actions={actions} panels={panels} cards={cards} onSendKey={onSendKey} />
      {dialogs}
    </DraftDoorProvider>
  )
}

function DraftBody({ model, actions, panels, cards, onSendKey }: { model: DraftPageModel; actions?: DraftPageActions; panels?: ReactNode; cards?: ReactNode; onSendKey?: () => void }) {
  const words = useDraftWords()
  const { t } = words
  const ds = useDsWords()
  const request = model.draft.request
  const chip = (part: DraftPart): DraftChip => model.chips.find((entry) => entry.part === part)!
  const kind = draftBannerOf({ offline: model.offlineSince !== null, stale: model.stale, refused: model.problem !== null, notice: model.notice !== null, problems: request.problems.length })
  const kit = { t, price: () => null, locale: words.locale }
  const files = draftFilesOf(request)
  const capKey = filesAddHeld(request, { preview: false, offline: false, busy: false })
  const filesModel = (part: DraftFilePart): DraftFilesModel => {
    const later = laterToggleOf(request, LATER_PART_OF[part])
    return {
      part,
      files: part === 'LOGO' ? files.logos : part === 'REFERENCE' ? files.references : files.sheets,
      lines: request.lines,
      uploading: model.uploads ?? [],
      open: uploadsOpenOf(request),
      addHeld: model.writeHeld ?? (capKey ? t(capKey) : null),
      removeHeld: model.writeHeld,
      later: later ? { on: later.on, held: model.writeHeld } : null,
      draftName: draftMailName(request, t),
    }
  }
  return (
    <div
      className="fw-od fw-od-draft"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSendKey) {
          event.preventDefault()
          onSendKey()
        }
      }}
    >
      {/* ONE banner, by weight. */}
      {kind === 'offline' && model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: words.time(model.offlineSince) })} /> : null}
      {kind === 'stale' ? (
        <Banner
          tone="warning"
          title={t('draft.stale')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              <RefreshCw size={14} aria-hidden /> {t('draft.reload')}
            </Button>
          }
        >
          {model.staleBy ? <p>{t('draftPage.changedBy', { name: model.staleBy })}</p> : null}
        </Banner>
      ) : null}
      {kind === 'refused' && model.problem ? <Banner tone="danger" title={model.problem} /> : null}
      {kind === 'notice' && model.notice ? (
        <Banner
          tone="success"
          title={model.notice.lines[0]}
          action={
            <span className="fw-od-buttons">
              {model.notice.undo ? (
                <Button size="sm" variant="secondary" heldReason={model.writeHeld} onClick={() => actions?.onUndo?.()}>
                  {t('notice.undo')}
                </Button>
              ) : null}
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('notice.hide')}
              </Button>
            </span>
          }
        >
          {model.notice.lines.length > 1 ? (
            <ul className="fw-od-notes">
              {model.notice.lines.slice(1).map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      {kind === 'problems' ? (
        <Banner
          tone="warning"
          icon={<AlertTriangle size={16} aria-hidden />}
          title={t('draftPage.problems', { count: request.problems.length })}
          action={
            <Button size="sm" variant="secondary" onClick={() => actions?.onShowMe?.()}>
              {t('summary.showMe')}
            </Button>
          }
        >
          {model.showProblems ? (
            <ul className="fw-od-notes">
              {request.problems.map((problem, index) => (
                <li key={index} className="fw-od-note is-danger">
                  <a href={`#${problemPlace(problem)}`}>{problemWords(problem, request.lines, kit, request.customLines ?? [])}</a>
                </li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      <div className="fw-od-draftmeta">
        <span className="fw-od-shared">
          <Eye size={14} aria-hidden /> {t('draftPage.shared')}
        </span>
        {model.save.kind === 'saving' || model.save.kind === 'failed' ? (
          <SaveStatus state={model.save} formatTime={words.time} labels={ds.saveStatus} onRetry={actions?.onRetrySave} retryHeld={model.writeHeld} />
        ) : (
          <span className="fw-od-quiet" role="status">
            {savedWords(request, t, words.time)}
          </span>
        )}
      </div>
      <DraftChecklist chips={model.chips} onChip={actions?.onChip} />
      {panels}
      <Card padded>
        <LinesSection model={{ draft: model.draft, cells: model.cells, notes: model.notes, saving: model.saving, writeHeld: model.writeHeld, chip: chip('NEED'), addLine: model.addLine }} actions={actions?.lines} />
      </Card>
      {/* F-CP-151: 2 Logos beside 3 References; the measurement sheets inside 4 People and sizes. */}
      <div className="fw-od-pair">
        <DraftFilesCard chip={chip('LOGOS')} model={filesModel('LOGO')} actions={actions?.files} />
        <DraftFilesCard chip={chip('REFERENCES')} model={filesModel('REFERENCE')} actions={actions?.files} />
      </div>
      <Card padded>
        <section className="fw-od-section" id={chip('PEOPLE').target} tabIndex={-1} aria-labelledby="part-people-title">
          <PartHeading chip={chip('PEOPLE')} id="part-people-title" />
          <PeopleRoster model={{ draft: model.draft, writeHeld: model.writeHeld, sheets: filesModel('SHEET') }} actions={{ ...actions?.files, ...actions?.people }} />
        </section>
      </Card>
      <div className="fw-od-pair">
        <DateCard model={model} actions={actions} chip={chip('DATE')} />
        <NotesCard model={model} actions={actions} chip={chip('NOTES')} />
      </div>
      {cards}
      {/* review G3: the page's keys in ONE information icon at its foot, never as hints above the cards. */}
      <div className="fw-od-draftfoot">
        <ListKeysInfo keys={model.keys.map((entry) => ({ keys: entry.keys, does: entry.words }))} />
      </div>
    </div>
  )
}

/** 5 Date and delivery: their PO, the date wanted, ship-to with "Add a new address" — each saved on leaving the field. */
function DateCard({ model, actions, chip }: { model: DraftPageModel; actions?: DraftPageActions; chip: DraftChip }) {
  const { t } = useDraftWords()
  const options = shipToOptions(model.draft.addresses, model.header.shipToAddressId || null)
  const chosen = options.find((option) => option.id === model.header.shipToAddressId)
  const error = (field: HeaderField) => (model.headerErrors[field] ? t(model.headerErrors[field]!) : undefined)
  const held = model.writeHeld !== null
  return (
    <Card padded>
      <section className="fw-od-section" id={chip.target} tabIndex={-1} aria-labelledby="head-title">
        <PartHeading chip={chip} id="head-title" />
        <div className="fw-od-fields">
          <Field label={t('head.date')} hint={t('head.dateHint')} error={error('requestedDate')}>
            <DateField
              value={model.header.requestedDate}
              min={model.today}
              clearable
              disabled={held}
              onChange={(value) => {
                actions?.onHeader?.('requestedDate', value)
                actions?.onHeaderLeave?.('requestedDate')
              }}
            />
          </Field>
          <Field label={t('head.ref')} hint={t('head.refHint')} error={error('customerRef')}>
            <Input value={model.header.customerRef} maxLength={100} disabled={held} onChange={(event) => actions?.onHeader?.('customerRef', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('customerRef')} />
          </Field>
          <div className="fw-od-field-wide">
            <Field
              label={t('head.shipTo')}
              hint={chosen?.state === 'WAITING' ? t('head.shipToWaiting') : chosen?.state === 'ARCHIVED' ? t('head.shipToGone') : options.length === 0 ? t('head.shipToNone') : t('head.shipToHint')}
              error={error('shipToAddressId')}
            >
              <div className="fw-od-shipto">
                <Select
                  value={model.header.shipToAddressId}
                  disabled={held}
                  onChange={(event) => {
                    actions?.onHeader?.('shipToAddressId', event.target.value)
                    actions?.onHeaderLeave?.('shipToAddressId')
                  }}
                >
                  <option value="">{t('head.shipToChoose')}</option>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {[option.name, option.line].filter(Boolean).join(' — ')}
                      {option.isDefault ? ` (${t('head.default')})` : option.state === 'WAITING' ? ` (${t('head.waiting')})` : option.state === 'ARCHIVED' ? ` (${t('head.archived')})` : ''}
                    </option>
                  ))}
                </Select>
                <Button variant="secondary" heldReason={model.addAddressHeld} onClick={() => actions?.onAddAddress?.()}>
                  {t('head.addAddress')}
                </Button>
              </div>
            </Field>
          </div>
        </div>
      </section>
    </Card>
  )
}

/** 7 Notes: their note to us (saved on leaving the field). */
function NotesCard({ model, actions, chip }: { model: DraftPageModel; actions?: DraftPageActions; chip: DraftChip }) {
  const { t } = useDraftWords()
  const error = model.headerErrors.note ? t(model.headerErrors.note) : undefined
  return (
    <Card padded>
      <section className="fw-od-section" id={chip.target} tabIndex={-1} aria-labelledby="part-notes-title">
        <PartHeading chip={chip} id="part-notes-title" />
        <Field label={t('head.note')} hint={t('head.noteHint')} error={error}>
          <Textarea value={model.header.note} rows={4} maxLength={4000} disabled={model.writeHeld !== null} onChange={(event) => actions?.onHeader?.('note', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('note')} />
        </Field>
      </section>
    </Card>
  )
}
