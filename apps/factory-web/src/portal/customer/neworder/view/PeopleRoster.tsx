'use client'

import { Clock, FileText, Mail, MoreHorizontal, Shirt, ShieldCheck, UserPlus } from 'lucide-react'
import { Banner, Field, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { FileDropzone, Modal } from '../../../../lib/i18n/ds-parts'
import type { CustomLine, DraftFile, DraftPerson, DraftRecord, MeasureBy } from '../api'
import {
  customTitleOf,
  entriesInOrder,
  entryPeopleOf,
  kindKey,
  MEASURES,
  measureKey,
  peopleInOrder,
  personWhat,
  problemWords,
  rosterLinesOf,
  sheetsOfLine,
  type PersonDraft,
  type PersonField,
} from '../model'
import { useOrderingWords } from '../words'
import { ACCEPT, DraftSheets, type DraftFilesActions, type DraftFilesModel } from './DraftFiles'

/**
 * F-CP-154 (customer page plan C5; 12 §2 part 4 "People & sizes"; review A5, G6; lead pick: no "Saved measurements" in v1): the
 * People and sizes card's body. First each line's pieces as the draft holds them ("Line 1: size grid, 24 pieces", "Line 2: 30 pieces
 * · sizes later", "Line 3, by person: 4 people"); the privacy line (the people's names and measures are personal data, review G6);
 * then, for each by-person line (a described line "one row per person", every made-to-measure line), its roster: Name · Number · How
 * we get the size (Size · Measurement sheet · Sending later) · What is there, a person's problem on their row, ⋯ Change… / Remove,
 * "Add a person", and the line's own measurement sheet — a sheet on the line stands for its roster ("People: in the attached sheet",
 * review A5): a team with one sheet for twelve riders sends without typing twelve names. On live, until the virus scanner runs, the
 * sheet goes by e-mail (the words name the draft and the line). Rows keep their seq: a person never jumps under the cursor. The
 * draft's measurement sheets (all of them, each with where it sits) close the card.
 */

export interface PeopleRosterModel {
  record: DraftRecord
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
  /** The draft's measurement sheets block (its files, the drop area or the e-mail way, "Sending later"). */
  sheets: DraftFilesModel
}

export interface PeopleRosterActions extends DraftFilesActions {
  onAddPerson?: (lineId: string) => void
  onChangePerson?: (lineId: string, personId: string) => void
  onRemovePerson?: (lineId: string, personId: string) => void
}

const MEASURE_ICON: Readonly<Record<MeasureBy, typeof Shirt>> = { SIZE: Shirt, SHEET: FileText, LATER: Clock }

export function PeopleRoster({ model, actions }: { model: PeopleRosterModel; actions?: PeopleRosterActions }) {
  const words = useOrderingWords()
  const { t } = words
  const request = model.record.request
  const entries = entriesInOrder(request)
  const rosters = rosterLinesOf(request)
  return (
    <>
      {entries.length === 0 ? (
        <p className="fw-pno-quiet">{t('draftPage.people.empty')}</p>
      ) : (
        <ul className="fw-pno-peoplelines">
          {entries.map((entry) => {
            const people = entryPeopleOf(entry, t, words.pieces)
            return (
              <li key={entry.line.id} className={people.missing ? 'is-missing' : undefined}>
                <a href={`#${people.target}`}>{people.words}</a>
              </li>
            )
          })}
        </ul>
      )}
      {/* Review G6: the people's names and measures are personal data — said where they are typed. */}
      <p className="fw-pno-quiet fw-pno-privacy">
        <ShieldCheck size={14} aria-hidden /> {t('draftPage.roster.privacy')}
      </p>
      {rosters.map((line) => (
        <LineRoster key={line.id} line={line} model={model} actions={actions} />
      ))}
      {/* F-CP-151: the draft's measurement sheets (body data) and who opens them. */}
      <DraftSheets model={model.sheets} actions={actions} />
    </>
  )
}

/** One by-person line's roster: its people, "Add a person", its own measurement sheet ("People: in the attached sheet"). */
function LineRoster({ line, model, actions }: { line: CustomLine; model: PeopleRosterModel; actions?: PeopleRosterActions }) {
  const words = useOrderingWords()
  const { t, locale } = words
  const request = model.record.request
  const held = model.writeHeld
  const people = peopleInOrder(line.people)
  const onLine = sheetsOfLine(request, line.id)
  const kit = { t, price: () => null, locale }
  const personProblems = line.problems.filter((problem) => problem.personId)
  const title = t('draftPage.roster.title', { seq: line.seq, kind: t(kindKey(line.kind)), title: customTitleOf(line, t, locale) })
  const headingId = `people-${line.id}-title`
  return (
    <section className="fw-pno-roster" id={`people-${line.id}`} tabIndex={-1} aria-labelledby={headingId}>
      <div className="fw-pno-rosterhead">
        <h3 id={headingId} className="fw-pno-h3">
          {title}
        </h3>
        <Button size="sm" variant="secondary" heldReason={held} onClick={() => actions?.onAddPerson?.(line.id)}>
          <UserPlus size={14} aria-hidden /> {t('draftPage.roster.add')}
        </Button>
      </div>
      {people.length > 0 ? (
        <SummaryTable
          label={title}
          density="roomy"
          stackOnPhone
          columns={[t('draftPage.roster.col.name'), t('draftPage.roster.col.number'), t('draftPage.roster.col.how'), t('draftPage.roster.col.what'), t('draftPage.roster.col.more')]}
          widths={['28%', '12%', '26%', undefined, '56px']}
          align={['left', 'left', 'left', 'left', 'right']}
          rows={people.map((person) => ({ id: person.id, cells: personCells(person, line, held, t, actions) }))}
        />
      ) : line.peopleInSheet || onLine.length > 0 ? (
        <p className="fw-pno-insheet">
          <FileText size={14} aria-hidden /> {t('draftPage.roster.inSheet')}
        </p>
      ) : (
        <p className="fw-pno-quiet is-missing">{t('draftPage.roster.empty')}</p>
      )}
      {personProblems.length > 0 ? (
        <ul className="fw-pno-notes">
          {personProblems.map((problem, index) => (
            <li key={index} className="fw-pno-note is-danger">
              <a href={`#person-${problem.personId}`}>
                {people.find((person) => person.id === problem.personId)?.name ?? ''}: {problemWords(problem, request.lines, kit, request.customLines ?? [])}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {onLine.length > 0 ? <p className="fw-pno-quiet">{t('draftPage.roster.sheetOnLine', { names: onLine.map((file) => file.originalName).join(', ') })}</p> : null}
      {model.sheets.open ? (
        (held ?? model.sheets.addHeld) ? (
          <p className="fw-pno-held">{held ?? model.sheets.addHeld}</p>
        ) : (
          <FileDropzone multiple accept={ACCEPT.SHEET} hint={t('draftPage.roster.attach')} onFiles={(files) => actions?.onFiles?.('SHEET', files, line.id)} />
        )
      ) : (
        // D14: on live, until the virus scanner runs — the e-mail way, naming the draft and the line.
        <p className="fw-pno-mailway" role="note">
          <Mail size={16} aria-hidden /> <span>{t('draftPage.roster.attachClosed', { draft: model.sheets.draftName, seq: line.seq })}</span>
        </p>
      )}
    </section>
  )
}

function personCells(person: DraftPerson, line: CustomLine, held: string | null, t: (key: string, params?: Readonly<Record<string, string | number>>) => string, actions?: PeopleRosterActions) {
  const Icon = MEASURE_ICON[person.measureBy]
  const more: MenuItemDef[] = [
    { id: 'change', label: t('draftPage.roster.change'), disabled: held !== null, description: held ?? undefined, onSelect: () => actions?.onChangePerson?.(line.id, person.id) },
    { id: 'remove', label: t('draftPage.roster.remove'), disabled: held !== null, description: held ?? undefined, onSelect: () => actions?.onRemovePerson?.(line.id, person.id) },
  ]
  return [
    // "Show me" on a person's problem lands here (problemPlace: person-<id>).
    <span key="name" id={`person-${person.id}`} tabIndex={-1} className="fw-pno-personname">
      {person.name}
    </span>,
    person.number ?? '—',
    <span key="how" className="fw-pno-measure">
      <Icon size={14} aria-hidden /> {t(measureKey(person.measureBy))}
    </span>,
    person.measureBy === 'LATER' ? (
      <Tag key="what" tone="warning">
        <Clock size={12} aria-hidden /> {personWhat(person, t)}
      </Tag>
    ) : (
      personWhat(person, t)
    ),
    <Menu key="more" align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('draftPage.roster.personMenu', { name: person.name }) }} items={more} />,
  ]
}

// ── the person's window ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PersonDialogModel {
  mode: 'add' | 'change'
  /** The line's place. */
  seq: number
  /** The person's name as saved (a change's title). */
  name: string | null
  draft: PersonDraft
  /** By field (keys). */
  problems: Partial<Record<PersonField, string>>
  showProblems: boolean
  /** The draft's measurement sheets (its own and its lines'): a person measured by a sheet names one of them. */
  sheets: readonly DraftFile[]
  busy: boolean
  /** A refusal in our words (a key), or null. */
  failed: string | null
}

export interface PersonDialogActions {
  onField?: <Key extends keyof PersonDraft>(field: Key, value: PersonDraft[Key]) => void
  onSave?: () => void
  onClose?: () => void
}

/**
 * Add a person / change one (a DS Modal; a bottom sheet on a phone): name, number (optional), how we get the size — Size (typed) ·
 * Measurement sheet (one of this draft's sheets; none yet: said, with the other ways still open) · Sending later —, a note.
 */
export function PersonDialog({ model, actions }: { model: PersonDialogModel; actions?: PersonDialogActions }) {
  const { t } = useOrderingWords()
  const error = (field: PersonField) => (model.showProblems && model.problems[field] ? t(model.problems[field]!) : undefined)
  const title = model.mode === 'change' && model.name ? t('draftPage.person.titleChange', { name: model.name, seq: model.seq }) : t('draftPage.person.titleAdd', { seq: model.seq })
  return (
    <Modal
      open
      onClose={() => (model.busy ? undefined : actions?.onClose?.())}
      sheet
      size="md"
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()} disabled={model.busy}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="primary" heldReason={model.busy ? t('state.saving') : null} onClick={() => actions?.onSave?.()}>
            {t(model.mode === 'add' ? 'draftPage.person.add' : 'draftPage.person.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pno-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onSave?.()
        }}
      >
        {model.failed ? <Banner tone="danger" title={t(model.failed)} /> : null}
        <Field label={t('draftPage.person.name')} required hint={t('draftPage.person.nameHint')} error={error('name')}>
          <Input value={model.draft.name} maxLength={120} autoComplete="off" data-autofocus onChange={(event) => actions?.onField?.('name', event.target.value)} />
        </Field>
        <Field label={t('draftPage.person.number')} hint={t('draftPage.person.numberHint')} error={error('number')}>
          <Input value={model.draft.number} maxLength={10} autoComplete="off" onChange={(event) => actions?.onField?.('number', event.target.value)} />
        </Field>
        <div className="fw-pno-stack">
          <span className="fw-pno-h3">{t('draftPage.person.how')}</span>
          <SegmentedControl
            ariaLabel={t('draftPage.person.how')}
            wrap
            value={model.draft.measureBy}
            onChange={(value) => actions?.onField?.('measureBy', value as MeasureBy)}
            options={MEASURES.map((measure) => ({ value: measure, label: t(measureKey(measure)) }))}
          />
        </div>
        {model.draft.measureBy === 'SIZE' ? (
          <Field label={t('draftPage.person.size')} required hint={t('draftPage.person.sizeHint')} error={error('size')}>
            <Input value={model.draft.size} maxLength={40} autoComplete="off" onChange={(event) => actions?.onField?.('size', event.target.value)} />
          </Field>
        ) : null}
        {model.draft.measureBy === 'SHEET' ? (
          model.sheets.length === 0 ? (
            <p className="fw-pno-held">{t('draftPage.person.noSheets')}</p>
          ) : (
            <Field label={t('draftPage.person.sheet')} required error={error('sheet')}>
              <Select value={model.draft.sheetId} onChange={(event) => actions?.onField?.('sheetId', event.target.value)}>
                <option value="">{t('draftPage.person.sheetChoose')}</option>
                {model.sheets.map((sheet) => (
                  <option key={sheet.id} value={sheet.id}>
                    {sheet.originalName}
                  </option>
                ))}
              </Select>
            </Field>
          )
        ) : null}
        {model.draft.measureBy === 'LATER' ? <p className="fw-pno-quiet">{t('draftPage.person.later')}</p> : null}
        <Field label={t('draftPage.person.note')} error={error('note')}>
          <Input value={model.draft.note} maxLength={1000} onChange={(event) => actions?.onField?.('note', event.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}
