'use client'

import { useMemo } from 'react'
import { AlertTriangle, Info, MoreHorizontal, Plus, ShoppingBag } from 'lucide-react'
import { EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SizeGridEditor, type SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { Field } from '@nexus/ui/components'
import { useDsWords } from '../../i18n/ds-parts'
import { INTL_LOCALE } from '../../i18n/locales'
import type { DraftView, DraftViewCustomLine, DraftViewLine } from '../model'
import { columnsOf, fromOrderText, noticeTone, noticeWords, piecesOfCells, problemWords, type Cells } from '../model'
import { useDraftWords } from '../words'
// F-CP-150: the lines are part 1 of the draft ("What you need"): the part's heading and "Add a line ▾" (the ways in).
import { ChevronDown } from 'lucide-react'
import { type DraftChip } from '../model'
import { PartHeading } from './parts'
// ---- F-CP-154 (customer page plan C5; 12 §2 part 1): lines of every kind — From the catalogue · Described by you · Made to measure.
import { Banner } from '@nexus/ui/components'
import { SegmentedControl } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../i18n/ds-parts'
import type { CustomLineKind, MadeToMeasure } from '../schema'
import { customDetailWords, customTitleOf, entriesInOrder, kindKey, type CustomLineDraft, type CustomLineField } from '../model'
import { KindTag } from './parts'
// ---- end F-CP-154

/**
 * sec:lines (design portal.customer.neworder "One line per style and colourway, with the whole size run in one grid"): each
 * line a card — the style (our code, name, your code), the colourway (offered colours only), the DS SizeGridEditor (the
 * sizes offered; stacked on a phone, `layout="auto"`; arrows between cells, Enter down, Esc restores; a block pasted from a
 * spreadsheet), pieces, the line's problems and a reorder's differences in our words, ⋯ Remove line (with Undo). Empty: "No lines
 * yet…". od-w1.1: no price here (money wall) — a price holder reads the list price and the amount in the host's own price card.
 */

export interface LinesModel {
  /** The draft without a single price (`draftViewOf`). */
  draft: DraftView
  /** Typed sizes not saved yet, by line. */
  cells: Readonly<Record<string, Cells>>
  /** Typed notes not saved yet, by line. */
  notes: Readonly<Record<string, string>>
  /** Lines being saved. */
  saving: readonly string[]
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
  // ---- F-CP-150: part 1's chip (its state on the heading) and "Add a line ▾": the ways in (Pick styles, Reorder — held with why
  // for a colleague whose access shows no orders —, Upload a sheet; the described and made-to-measure kinds come with F-CP-154).
  chip: DraftChip
  addLine: readonly MenuItemDef[]
  // ---- end F-CP-150
}

export interface LinesActions {
  onCells?: (lineId: string, cells: Record<string, number>) => void
  /** Focus left the line: save what was typed. */
  onLeave?: (lineId: string) => void
  onNote?: (lineId: string, note: string) => void
  onColour?: (lineId: string, colourwayId: string) => void
  onRemove?: (lineId: string) => void
  /** Leave a size no longer offered out of the line (and save it). */
  onDropSize?: (lineId: string, size: string) => void
  /** F-CP-154: change a described or made-to-measure line (its window). A line of any kind goes out with `onRemove`. */
  onChangeCustom?: (lineId: string) => void
}

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

export function LinesSection({ model, actions }: { model: LinesModel; actions?: LinesActions }) {
  const words = useDraftWords()
  const { t } = words
  const request = model.draft.request
  return (
    <section className="fw-od-section" id="lines" tabIndex={-1} aria-labelledby="lines-title">
      {/* F-CP-150: part 1 "What you need" — its state, and "Add a line ▾" with the ways in. */}
      <PartHeading
        chip={model.chip}
        id="lines-title"
        action={
          model.writeHeld ? (
            <Button size="sm" variant="secondary" heldReason={model.writeHeld}>
              <Plus size={14} aria-hidden /> {t('draftPage.addLine')}
            </Button>
          ) : (
            <Menu
              align="right"
              label={
                <span className="fw-od-menulabel">
                  <Plus size={14} aria-hidden /> {t('draftPage.addLine')} <ChevronDown size={14} aria-hidden />
                </span>
              }
              triggerProps={{ className: 'nds-btn sm secondary' }}
              items={[...model.addLine]}
            />
          )
        }
      />
      {entriesInOrder(request).length === 0 ? (
        <EmptyState icon={<ShoppingBag size={24} aria-hidden />} title={t('lines.empty')} description={t('lines.emptyBody')} />
      ) : (
        <ol className="fw-od-lines">
          {/* F-CP-150: by seq — a row never jumps under the cursor when the draft is read again. F-CP-154: every kind in ONE order. */}
          {entriesInOrder(request).map((entry) => (
            <li key={entry.line.id}>{entry.kind === 'CATALOGUE' ? <LineCard line={entry.line} model={model} actions={actions} /> : <CustomLineCard line={entry.line} model={model} actions={actions} />}</li>
          ))}
        </ol>
      )}
    </section>
  )
}

function LineCard({ line, model, actions }: { line: DraftViewLine; model: LinesModel; actions?: LinesActions }) {
  const words = useDraftWords()
  const { t, locale } = words
  const copy = useSizeCopy()
  const request = model.draft.request
  const typed = model.cells[line.id]
  const cells: Cells = typed ?? Object.fromEntries(line.sizes.map((row) => [row.size, row.quantity]))
  const columns = columnsOf(line)
  // od-w1.1: no figure of money in the shared part — a price problem or notice reads its words without the amounts.
  const kit = { t, price: () => null }
  const shownPieces = piecesOfCells(cells)
  // A size no longer offered has no cell to type into: its problem says so with "Leave size 62 out".
  const lineProblems = line.problems
  const discontinued = line.problems.some((problem) => problem.code === 'COLOUR_DISCONTINUED')
  const empty = shownPieces === 0
  const more: MenuItemDef[] = [{ id: 'remove', label: t('lines.remove'), disabled: model.writeHeld !== null, description: model.writeHeld ?? undefined, onSelect: () => actions?.onRemove?.(line.id) }]
  const title = `${line.style.code} · ${line.style.name}`
  return (
    // F-CP-150: a row of part 1's card (the card is the part; a line is no card of its own).
    <div className="fw-od-linecard">
      <div
        className="fw-od-line"
        id={`line-${line.id}`}
        tabIndex={-1}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) actions?.onLeave?.(line.id)
        }}
      >
        <div className="fw-od-linehead">
          <div className="fw-od-linetitle">
            <span className="fw-od-linename">
              {t('lines.lineTitle', { seq: line.seq, title })} <KindTag kind="CATALOGUE" /> {/* F-CP-154 */}
            </span>
            <span className="fw-od-quiet">
              {line.colourway.name} ({line.colourway.code})
              {/* B-TH-304: the customer's own order number, never the office's series. */}
              {line.source ? ` · ${fromOrderText(line.source, t, words.day)}` : ''}
            </span>
          </div>
          <div className="fw-od-lineactions">
            {line.colours.length > 1 || discontinued ? (
              <Field label={t('lines.colour')}>
                <Select value={line.colourway.id} disabled={model.writeHeld !== null} onChange={(event) => actions?.onColour?.(line.id, event.target.value)}>
                  {discontinued && !line.colours.some((colour) => colour.id === line.colourway.id) ? <option value={line.colourway.id}>{t('lines.colourGone', { colour: line.colourway.name })}</option> : null}
                  {line.colours.map((colour) => (
                    <option key={colour.id} value={colour.id}>
                      {colour.name} ({colour.code})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('lines.menu', { seq: line.seq }) }} items={more} />
          </div>
        </div>
        {line.notices.length > 0 || lineProblems.length > 0 ? (
          <ul className="fw-od-notes">
            {lineProblems.map((problem, index) => (
              <li key={`p${index}`} className="fw-od-note is-danger">
                <AlertTriangle size={14} aria-hidden /> {problemWords(problem, request.lines, kit)}
                {problem.code === 'SIZE_NOT_OFFERED' && problem.size ? (
                  <Button size="sm" variant="quiet" heldReason={model.writeHeld} onClick={() => actions?.onDropSize?.(line.id, problem.size!)}>
                    {t('lines.dropSize', { size: problem.size })}
                  </Button>
                ) : null}
              </li>
            ))}
            {line.notices
              .filter((notice) => notice.code !== 'PRICE_CHANGED' || !line.problems.some((problem) => problem.code === 'PRICE_CHANGED'))
              .map((notice, index) => (
                <li key={`n${index}`} className={`fw-od-note is-${noticeTone(notice.code)}`}>
                  <Info size={14} aria-hidden /> {noticeWords(notice.code, { style: line.style.code, colour: line.colourway.name }, kit)}
                </li>
              ))}
          </ul>
        ) : null}
        <SizeGridEditor
          layout="auto"
          colours={[{ key: line.id, label: line.colourway.name, offered: line.offered }]}
          sizes={columns.map((size) => ({ key: size, label: size }))}
          value={{ [line.id]: cells }}
          onChange={(next) => actions?.onCells?.(line.id, { ...(next[line.id] ?? {}) })}
          issues={empty ? [{ colour: line.id, message: t('lines.held.empty'), tone: 'warning' as const }] : []}
          caption={t('lines.gridCaption', { title, colour: line.colourway.name })}
          locale={INTL_LOCALE[locale]}
          copy={copy}
        />
        <div className="fw-od-linefoot">
          <Field label={t('lines.note')} hint={t('lines.noteHint')}>
            <Input value={model.notes[line.id] ?? line.note ?? ''} maxLength={1000} disabled={model.writeHeld !== null} onChange={(event) => actions?.onNote?.(line.id, event.target.value)} />
          </Field>
          <dl className="fw-od-figures">
            <div>
              <dt>{t('lines.pieces')}</dt>
              <dd>{words.pieces(shownPieces)}</dd>
            </div>
          </dl>
        </div>
        {model.saving.includes(line.id) ? <p className="fw-od-quiet" role="status">{t('state.saving')}</p> : null}
      </div>
    </div>
  )
}

// ---- F-CP-154 (customer page plan C5; 12 §2 part 1; B-CP-075): a line in the customer's own words, and its window --------------
/**
 * A described or made-to-measure line: its kind, its words (or garment type), colours in words, the style it names, its quantities
 * ("30 pieces · sizes later", "By person · 4 people", "By person · People: in the attached sheet"), its problems in our words, and ⋯
 * Change… / Remove line. Its people live in part 4 (People and sizes).
 */
function CustomLineCard({ line, model, actions }: { line: DraftViewCustomLine; model: LinesModel; actions?: LinesActions }) {
  const words = useDraftWords()
  const { t, locale } = words
  const request = model.draft.request
  const kit = { t, price: () => null, locale }
  const held = model.writeHeld
  const more: MenuItemDef[] = [
    { id: 'change', label: t('draftPage.line.change'), disabled: held !== null, description: held ?? undefined, onSelect: () => actions?.onChangeCustom?.(line.id) },
    { id: 'remove', label: t('lines.remove'), disabled: held !== null, description: held ?? undefined, onSelect: () => actions?.onRemove?.(line.id) },
  ]
  const style = line.style ? `${line.style.code} ${line.style.name}`.trim() : null
  return (
    <div className="fw-od-linecard">
      <div className="fw-od-line" id={`line-${line.id}`} tabIndex={-1}>
        <div className="fw-od-linehead">
          <div className="fw-od-linetitle">
            <span className="fw-od-linename">
              {t('lines.lineTitle', { seq: line.seq, title: customTitleOf(line, t, locale) })} <KindTag kind={line.kind} />
            </span>
            <span className="fw-od-quiet">{customDetailWords(line, t, words.pieces)}</span>
          </div>
          <div className="fw-od-lineactions">
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('draftPage.line.menu', { seq: line.seq }) }} items={more} />
          </div>
        </div>
        {line.description && line.description.trim().includes('\n') ? <p className="fw-od-ownwords">{line.description}</p> : null}
        {line.colourText || style || line.note ? (
          <ul className="fw-od-linefacts">
            {line.colourText ? <li>{t('draftPage.line.colours', { colours: line.colourText })}</li> : null}
            {style ? <li>{t(line.kind === 'MADE_TO_MEASURE' ? 'draftPage.line.madeFrom' : 'draftPage.line.ownStyle', { style })}</li> : null}
            {line.note ? <li>{t('lines.note')}: {line.note}</li> : null}
          </ul>
        ) : null}
        {line.problems.filter((problem) => !problem.personId).length > 0 ? (
          <ul className="fw-od-notes">
            {line.problems
              .filter((problem) => !problem.personId)
              .map((problem, index) => (
                <li key={index} className="fw-od-note is-danger">
                  <AlertTriangle size={14} aria-hidden /> {problemWords(problem, request.lines, kit, request.customLines ?? [])}
                </li>
              ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

export interface CustomLineDialogModel {
  mode: 'add' | 'change'
  kind: CustomLineKind
  /** The line's place (a change). */
  seq: number | null
  draft: CustomLineDraft
  /** By field (keys). */
  problems: Partial<Record<CustomLineField, string>>
  showProblems: boolean
  /** The styles it may name: a described line its own label's, a made-to-measure line any of its catalogue. */
  styles: { state: 'loading' | 'error' | 'ready'; rows: readonly { readonly id: string; readonly code: string; readonly name: string }[] }
  garmentTypes: MadeToMeasure['garmentTypes']
  busy: boolean
  /** A refusal in the host's words (od-w1.1: the host says it in its own catalogue), or null. */
  failed: string | null
}

export interface CustomLineDialogActions {
  onField?: <Key extends keyof CustomLineDraft>(field: Key, value: CustomLineDraft[Key]) => void
  onSave?: () => void
  onClose?: () => void
}

/**
 * "Describe what you need" / "A made-to-measure line" (a DS Modal; a bottom sheet on a phone): the words, colours in words, the style it
 * names (optional), and how many — a total ("sizes may follow") or one row per person. Made to measure: a garment type, always one row
 * per person (the people go in People and sizes). Esc closes; the focus goes back to the opener; Save says why it cannot.
 */
export function CustomLineDialog({ model, actions }: { model: CustomLineDialogModel; actions?: CustomLineDialogActions }) {
  const words = useDraftWords()
  const { t, locale } = words
  const mtm = model.kind === 'MADE_TO_MEASURE'
  const error = (field: CustomLineField) => (model.showProblems && model.problems[field] ? t(model.problems[field]!) : undefined)
  const title = model.mode === 'change' && model.seq !== null ? t('draftPage.customLine.titleChange', { seq: model.seq, kind: t(kindKey(model.kind)) }) : t(mtm ? 'draftPage.customLine.titleMtm' : 'draftPage.customLine.titleDescribed')
  return (
    <Modal
      open
      onClose={() => (model.busy ? undefined : actions?.onClose?.())}
      sheet
      size="lg"
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()} disabled={model.busy}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="primary" heldReason={model.busy ? t('state.saving') : null} onClick={() => actions?.onSave?.()}>
            {t(model.mode === 'add' ? 'draftPage.customLine.add' : 'draftPage.customLine.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-od-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onSave?.()
        }}
      >
        {model.failed ? <Banner tone="danger" title={model.failed} /> : null}
        {mtm ? (
          <Field label={t('draftPage.customLine.garment')} required error={error('garmentType')}>
            <Select value={model.draft.garmentType} data-autofocus onChange={(event) => actions?.onField?.('garmentType', event.target.value)}>
              <option value="">{t('draftPage.customLine.garmentChoose')}</option>
              {model.garmentTypes.map((type) => (
                <option key={type.code} value={type.code}>
                  {type.words[locale]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label={t(mtm ? 'draftPage.customLine.descriptionMtm' : 'draftPage.customLine.description')} required={!mtm} hint={t('draftPage.customLine.descriptionHint')} error={error('description')}>
          <Textarea value={model.draft.description} rows={4} maxLength={2000} {...(mtm ? {} : { 'data-autofocus': true })} onChange={(event) => actions?.onField?.('description', event.target.value)} />
        </Field>
        <Field label={t('draftPage.customLine.colours')} hint={t('draftPage.customLine.coloursHint')} error={error('colourText')}>
          <Input value={model.draft.colourText} maxLength={200} onChange={(event) => actions?.onField?.('colourText', event.target.value)} />
        </Field>
        <Field
          label={t(mtm ? 'draftPage.customLine.styleMtm' : 'draftPage.customLine.style')}
          hint={model.styles.state === 'loading' ? t('draftPage.customLine.stylesLoading') : model.styles.state === 'error' ? t('draftPage.customLine.stylesFailed') : t(mtm ? 'draftPage.customLine.styleMtmHint' : 'draftPage.customLine.styleHint')}
        >
          <Select value={model.draft.styleId} disabled={model.styles.state !== 'ready'} onChange={(event) => actions?.onField?.('styleId', event.target.value)}>
            <option value="">{t('draftPage.customLine.noStyle')}</option>
            {model.styles.rows.map((style) => (
              <option key={style.id} value={style.id}>
                {style.code} · {style.name}
              </option>
            ))}
          </Select>
        </Field>
        {mtm ? (
          <p className="fw-od-quiet">{t('draftPage.customLine.mtmPeople')}</p>
        ) : (
          <div className="fw-od-stack">
            <span className="fw-od-h3">{t('draftPage.customLine.how')}</span>
            <SegmentedControl
              ariaLabel={t('draftPage.customLine.how')}
              wrap
              value={model.draft.byPerson ? 'people' : 'total'}
              onChange={(value) => actions?.onField?.('byPerson', value === 'people')}
              options={[
                { value: 'total', label: t('draftPage.customLine.howTotal') },
                { value: 'people', label: t('draftPage.customLine.howPeople') },
              ]}
            />
            {model.draft.byPerson ? (
              <p className="fw-od-quiet">{t('draftPage.customLine.peopleHint')}</p>
            ) : (
              <Field label={t('draftPage.customLine.total')} hint={t('draftPage.customLine.totalHint')} error={error('total')}>
                <Input value={model.draft.total} inputMode="numeric" maxLength={6} onChange={(event) => actions?.onField?.('total', event.target.value)} />
              </Field>
            )}
          </div>
        )}
        <Field label={t('draftPage.customLine.note')} error={error('note')}>
          <Input value={model.draft.note} maxLength={1000} onChange={(event) => actions?.onField?.('note', event.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}
// ---- end F-CP-154
