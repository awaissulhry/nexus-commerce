'use client'

import { useMemo } from 'react'
import { Hourglass, Plus, ShieldCheck, X } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { SizeGridEditor, SizeGridView, type SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, SegmentedControl } from '@nexus/ui/primitives'
import { Modal, Textarea, useDsWords } from '../../i18n/ds-parts'
import { INTL_LOCALE } from '../../i18n/locales'
import { CHOICE_LIMITS, piecesOfCells, rowProductOf, type Cells, type ProductRow } from '../model'
import type { DraftChoice } from '../schema'
import { useDraftWords } from '../words'
import { FilesBox, type FilesBoxActions, type FilesBoxModel } from './files'
import { LineRoster, type PeopleRosterActions } from './PeopleRoster'

/**
 * A row's details in a CENTRED window (od-w1.2, R3; 10-design-r1 § 3.5–§ 3.6; the Owner's rule "details in a centred modal, never a
 * drawer"; a bottom sheet on a phone): its Pieces (A total · By size · By person · Not decided yet — ONE save of the row at the
 * draft's version, so a half-typed size run never reaches the server; a custom size is made for each person), its Options (each one's
 * choices + "Not decided yet", a pick saves at once; "Add an option" — names only) and its Files (on a custom-size row a file is a
 * measurement sheet, with the privacy line). Esc closes; the focus goes back to the cell that opened it.
 */

/** The DS size grid's words in the page's language (the part's `size.*`, the stacked layout's from ds-words; the portal's picker too). */
export function useSizeCopy(): Partial<SizeGridCopy> {
  const { t } = useDraftWords()
  const ds = useDsWords()
  return useMemo(
    () => ({
      caption: t('size.caption'),
      colourHeader: t('size.colour'),
      totalHeader: t('size.total'),
      cellName: (colour, size) => t('size.cellName', { colour, size }),
      notOffered: t('size.notOffered'),
      empty: t('size.empty'),
      totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => t('size.totals', { colour, rowTotal, size, columnTotal, grand }),
      notWhole: (cell, max) => t('size.notWhole', { cell, max }),
      cutToMax: (cell, max) => t('size.cutToMax', { cell, max }),
      pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => t('size.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
      issuesHeading: t('size.issues'),
      ...ds.sizeGridStacked,
    }),
    [t, ds.sizeGridStacked],
  )
}

export type PiecesMode = 'TOTAL' | 'SIZES' | 'PEOPLE' | 'NONE'

/** The ways a row may count its pieces: a catalogue row by its size run; a custom size by person; any other row a total or by person. */
export function piecesModesOf(row: Pick<ProductRow, 'catalogue' | 'sizing'>): PiecesMode[] {
  if (row.sizing === 'MADE_TO_MEASURE') return ['PEOPLE']
  return row.catalogue ? ['SIZES', 'NONE'] : ['TOTAL', 'PEOPLE', 'NONE']
}

/**
 * How the Pieces window opens on a row (both hosts): on what the row holds — a row whose pieces are not decided yet opens on "Not
 * decided yet" (od-fx8 W-15), a row in its own words with a size run on its total; a custom size on its people.
 */
export function piecesOpenOf(row: Pick<ProductRow, 'catalogue' | 'sizing' | 'pieces'>): { mode: PiecesMode; total: string; cells: Cells } {
  const modes = piecesModesOf(row)
  const now = row.pieces.mode
  const mode: PiecesMode = modes.includes(now) ? now : now === 'SIZES' && modes.includes('TOTAL') ? 'TOTAL' : modes.includes('NONE') ? 'NONE' : modes[0]!
  const cells: Cells = row.pieces.mode === 'SIZES' ? Object.fromEntries(row.pieces.sizes.map((entry) => [entry.size, entry.quantity])) : {}
  const total = row.pieces.mode === 'TOTAL' || (row.pieces.mode === 'SIZES' && !row.catalogue) ? String(row.pieces.total) : ''
  return { mode, total, cells }
}

export interface PiecesWindowModel {
  row: ProductRow
  mode: PiecesMode
  /** A total as typed. */
  total: string
  /** The size run as typed (a catalogue row). */
  cells: Cells
  /** The row's own roster and sheets (by person). */
  roster: Parameters<typeof LineRoster>[0]['model']
  rosterLine: Parameters<typeof LineRoster>[0]['line'] | null
  busy: boolean
  /** A refusal in the host's words, or null. */
  failed: string | null
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
}

export interface PiecesWindowActions {
  onMode?: (mode: PiecesMode) => void
  onTotal?: (text: string) => void
  onCells?: (cells: Record<string, number>) => void
  onSave?: () => void
  onClose?: () => void
  people?: PeopleRosterActions
}

const MODE_KEY: Readonly<Record<PiecesMode, string>> = { TOTAL: 'pc.total', SIZES: 'pc.bySize', PEOPLE: 'pc.byPerson', NONE: 'state.OPEN' }

export function PiecesWindow({ model, actions }: { model: PiecesWindowModel; actions?: PiecesWindowActions }) {
  const { t } = useDraftWords()
  const row = model.row
  const product = rowProductOf(row) ?? t('state.OPEN')
  return (
    <Modal
      open
      sheet
      size="lg"
      onClose={() => (model.busy ? undefined : actions?.onClose?.())}
      title={t('pc.title', { seq: row.seq, product })}
      footer={
        // od-fx8 W-10: a reader closes it (nothing to save).
        model.writeHeld !== null ? (
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('opt.close')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => actions?.onClose?.()} disabled={model.busy}>
              {t('pc.cancel')}
            </Button>
            <Button variant="primary" heldReason={model.busy ? t('state.saving') : null} onClick={() => actions?.onSave?.()}>
              {t('pc.save')}
            </Button>
          </>
        )
      }
    >
      <PiecesBody model={model} actions={actions} />
    </Modal>
  )
}

/** od-fx2: the Pieces window's body (how it is counted, the total, the size run, the roster), drawn inside its Modal. */
export function PiecesBody({ model, actions }: { model: PiecesWindowModel; actions?: PiecesWindowActions }) {
  const words = useDraftWords()
  const { t, locale } = words
  const copy = useSizeCopy()
  const row = model.row
  const modes = piecesModesOf(row)
  const locked = row.sizing === 'MADE_TO_MEASURE'
  // od-fx8 W-10: a reader reads the window — how it is counted in words, the total, the size run, the people; no field, no save.
  const reading = model.writeHeld !== null
  return (
    <div className="fw-od-dialog">
      {model.failed ? <Banner tone="danger" title={model.failed} /> : null}
      {reading ? <p className="fw-od-held">{model.writeHeld}</p> : null}
      <div className="fw-od-stack">
        <span className="fw-od-label">{t('pc.how')}</span>
        {reading ? (
          <span>{t(MODE_KEY[model.mode])}</span>
        ) : (
          <SegmentedControl
            ariaLabel={t('pc.how')}
            wrap
            value={model.mode}
            onChange={(value) => actions?.onMode?.(value as PiecesMode)}
            options={modes.map((mode) => ({ value: mode, label: t(MODE_KEY[mode]), ...(mode === 'NONE' ? { icon: <Hourglass size={12} aria-hidden /> } : {}) }))}
          />
        )}
        {locked && !reading ? <p className="fw-od-quiet">{t('pc.mtmLocked')}</p> : null}
      </div>
      {model.mode === 'TOTAL' ? (
        reading ? (
          <p>
            <span className="fw-od-label">{t('pc.totalField')}</span> {model.total === '' ? t('state.OPEN') : model.total}
          </p>
        ) : (
          <Field label={t('pc.totalField')} hint={t('pc.totalHint')}>
            <Input value={model.total} inputMode="numeric" maxLength={6} data-autofocus onChange={(event) => actions?.onTotal?.(event.target.value)} />
          </Field>
        )
      ) : null}
      {model.mode === 'SIZES' && row.style ? (
        <div className="fw-od-stack">
          <span className="fw-od-label">
            {t('pc.sizesCaption')} · {t('pc.sizesOf', { style: row.style.code })}
          </span>
          {reading ? (
            <SizeGridView colours={[{ key: row.id, label: row.colour ?? t('state.OPEN'), offered: [...row.offered] }]} sizes={row.offered.map((size) => ({ key: size, label: size }))} value={{ [row.id]: model.cells }} caption={t('pc.sizesOf', { style: row.style.code })} locale={INTL_LOCALE[locale]} copy={copy} />
          ) : (
            <SizeGridEditor
              layout="auto"
              colours={[{ key: row.id, label: row.colour ?? t('state.OPEN'), offered: [...row.offered] }]}
              sizes={row.offered.map((size) => ({ key: size, label: size }))}
              value={{ [row.id]: model.cells }}
              onChange={(next) => actions?.onCells?.({ ...(next[row.id] ?? {}) })}
              issues={[]}
              caption={t('pc.sizesOf', { style: row.style.code })}
              locale={INTL_LOCALE[locale]}
              copy={copy}
            />
          )}
          <p className="fw-od-quiet">{t('cell.total', { pieces: words.pieces(piecesOfCells(model.cells)) })}</p>
        </div>
      ) : null}
      {model.mode === 'PEOPLE' ? (
        // Review G6: the riders' names and measures are personal data — said where they are typed.
        <p className="fw-od-quiet fw-od-privacy">
          <ShieldCheck size={14} aria-hidden /> {t('draftPage.roster.privacy')}
        </p>
      ) : null}
      {model.mode === 'PEOPLE' && model.rosterLine ? <LineRoster line={model.rosterLine} model={model.roster} actions={actions?.people} /> : null}
      {model.mode === 'PEOPLE' && !model.rosterLine ? <p className="fw-od-quiet">{t('draftPage.customLine.peopleHint')}</p> : null}
    </div>
  )
}

export interface OptionsWindowModel {
  row: ProductRow
  /** "Add an option" as typed. */
  topic: string
  typed: string
  /** Why "Add the option" cannot go (a key of the part), or null. */
  addHeld: string | null
  busy: boolean
  failed: string | null
  writeHeld: string | null
}

export interface OptionsWindowActions {
  onPick?: (topic: string, picked: string | null) => void
  onRemove?: (topic: string) => void
  onTopic?: (text: string) => void
  onTyped?: (text: string) => void
  onAdd?: () => void
  onClose?: () => void
}

const OPEN = '\u0000open'

export function OptionsWindow({ model, actions }: { model: OptionsWindowModel; actions?: OptionsWindowActions }) {
  const { t } = useDraftWords()
  const row = model.row
  const product = rowProductOf(row) ?? t('state.OPEN')
  const held = model.writeHeld ?? (model.busy ? t('state.saving') : null)
  return (
    <Modal
      open
      sheet
      size="lg"
      onClose={() => actions?.onClose?.()}
      title={t('opt.title', { seq: row.seq, product })}
      footer={
        <Button variant="secondary" onClick={() => actions?.onClose?.()}>
          {t('opt.close')}
        </Button>
      }
    >
      <div className="fw-od-dialog">
        {model.failed ? <Banner tone="danger" title={model.failed} /> : null}
        {row.choices.length === 0 ? <p className="fw-od-quiet">{t('opt.none')}</p> : null}
        <ul className="fw-od-options">
          {row.choices.map((choice: DraftChoice) => (
            <li key={choice.topic} className="fw-od-option">
              <span className="fw-od-label">{choice.topic}</span>
              <SegmentedControl
                ariaLabel={choice.topic}
                wrap
                size="sm"
                disabled={held !== null}
                value={choice.picked ?? OPEN}
                onChange={(value) => actions?.onPick?.(choice.topic, value === OPEN ? null : value)}
                options={[...choice.options.map((option) => ({ value: option, label: option })), { value: OPEN, label: t('state.OPEN'), icon: <Hourglass size={12} aria-hidden /> }]}
              />
              {model.writeHeld === null ? (
                <Button size="sm" variant="quiet" aria-label={`${t('opt.remove')} · ${choice.topic}`} heldReason={held} onClick={() => actions?.onRemove?.(choice.topic)}>
                  <X size={14} aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {/* od-fx8 W-10: a reader reads the options and their picks; adding one is for who may write. */}
        {model.writeHeld !== null ? <p className="fw-od-held">{model.writeHeld}</p> : null}
        {model.writeHeld !== null ? null : <div className="fw-od-stack fw-od-addoption" role="group" aria-labelledby="od-opt-add">
          <span id="od-opt-add" className="fw-od-h3">
            {t('opt.add')}
          </span>
          <Field label={t('opt.topic')} hint={t('opt.topicHint')}>
            <Input value={model.topic} maxLength={CHOICE_LIMITS.topic} onChange={(event) => actions?.onTopic?.(event.target.value)} />
          </Field>
          <Field label={t('opt.choices')}>
            <Textarea value={model.typed} rows={4} honourRows onChange={(event) => actions?.onTyped?.(event.target.value)} />
          </Field>
          <p className="fw-od-quiet">
            {t('opt.namesOnly')} {t('opt.alwaysOpen')}
          </p>
          <span>
            <Button size="sm" variant="secondary" heldReason={held ?? (model.addHeld ? t(model.addHeld) : null)} onClick={() => actions?.onAdd?.()}>
              <Plus size={14} aria-hidden /> {t('opt.save')}
            </Button>
          </span>
        </div>}
      </div>
    </Modal>
  )
}

export interface RowFilesWindowModel {
  row: ProductRow
  files: FilesBoxModel
}

export function RowFilesWindow({ model, actions, onClose }: { model: RowFilesWindowModel; actions?: FilesBoxActions; onClose?: () => void }) {
  const { t } = useDraftWords()
  const row = model.row
  const custom = row.sizing === 'MADE_TO_MEASURE'
  return (
    <Modal
      open
      sheet
      size="md"
      onClose={() => onClose?.()}
      title={t('rf.title', { seq: row.seq, product: rowProductOf(row) ?? t('state.OPEN') })}
      footer={
        <Button variant="secondary" onClick={() => onClose?.()}>
          {t('opt.close')}
        </Button>
      }
    >
      <div className="fw-od-dialog">
        {/* On a custom-size row a file is a measurement sheet: personal data, said where it goes up (review G6). */}
        {custom ? (
          <p className="fw-od-quiet fw-od-privacy">
            <ShieldCheck size={14} aria-hidden /> {t('draftPage.files.sheetsPrivacy')}
          </p>
        ) : null}
        <FilesBox model={model.files} actions={actions} />
      </div>
    </Modal>
  )
}
