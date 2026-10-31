'use client'

import { useEffect, useState, type ReactNode } from 'react'
import {
  ActionConfirm, AsOf, Card, Combobox, ConfirmPhraseField, Countdown, DateField, DateRangePicker, DateTimeField, FileDropzone, JobProgress,
  MediaStrip, Modal, Timeline, type DateRange,
} from '@nexus/ui/components'
import { DetailModal, EditModeBar, PageHeader, PreferencesModal, ReviewChangesModal, StepUpModal, type PreferencesValue } from '@nexus/ui/patterns'
import { Button, ColorSwatchPicker, IconPicker, Textarea } from '@nexus/ui/primitives'
import { CellSaveMark, GridDensityToggle } from '@nexus/ui/grid'
import { WithMessages } from '../../../../record-panels/i18n'
import { useDsLabels } from '../../ds-labels'
import { useT } from '../../provider'
import './ds-words-lab.css'

/**
 * The DS words lab (`/design/ds-words`, B-W2b-04): every design-system part that speaks, drawn with `useDsLabels()` —
 * the `ds-words` catalogue as each part's `labels` — in the gallery's language. A case opens one dialog; in the
 * browser every part works for real (pick a date, type the phrase, drop a wrong file, tick, Save). Made-up data only.
 */
export type DsWordsDialog = 'review' | 'review-done' | 'review-reading' | 'detail' | 'step-up' | 'step-up-refused' | 'confirm' | 'preferences' | 'modal'

export interface DsWordsLabModel {
  /** The dialog open at the start (the page's buttons open the others). */
  open?: DsWordsDialog
}

const READ_AT = '2026-10-31T08:40:00Z'
const REPLY_DUE = '2027-01-15T09:00:00Z'
const DETAIL_IDS = ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4']
const COLUMN_KEYS = Array.from({ length: 14 }, (_, i) => `c${i + 1}`)

export function DsWordsLab({ model }: { model: DsWordsLabModel }) {
  return (
    <WithMessages namespaces={['ds-words', 'ds-lab']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card padded header={title} className="fw-dsw-card">
      <div className="fw-dsw-parts">{children}</div>
    </Card>
  )
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fw-dsw-part">
      <span className="fw-dsw-label">{label}</span>
      {children}
    </div>
  )
}

function Lab({ model }: { model: DsWordsLabModel }) {
  const ds = useDsLabels()
  const t = useT('ds-lab')
  const [open, setOpen] = useState<DsWordsDialog | null>(model.open ?? null)
  useEffect(() => setOpen(model.open ?? null), [model.open])
  const close = () => setOpen(null)

  const [due, setDue] = useState('')
  const [ends, setEnds] = useState('')
  const [period, setPeriod] = useState<DateRange>({ start: new Date(2026, 9, 1), end: new Date(2026, 9, 20) })
  const [customer, setCustomer] = useState('')
  const [note, setNote] = useState('')
  const [phrase, setPhrase] = useState('')
  const [icon, setIcon] = useState<string | null>('star')
  const [colour, setColour] = useState<string | null>(null)
  const [density, setDensity] = useState<'compact' | 'cozy' | 'spacious'>('cozy')
  const [startedAt] = useState(() => Date.now())
  const [current, setCurrent] = useState(DETAIL_IDS[0]!)
  const changed = [due, ends, customer, note].filter(Boolean).length

  const columns = COLUMN_KEYS.map((key, i) => ({ key, label: t('prefs.column', { n: i + 1 }), group: i < 7 ? t('prefs.identity') : t('prefs.money'), ...(i === 0 ? { locked: true } : {}) }))
  const [prefs, setPrefs] = useState<PreferencesValue>({ visibleColumns: ['c1', 'c2', 'c3', 'c8'], lockedColumns: ['c2'], stickyFirstColumn: true, stickyLastColumn: false, pageSize: 50, sortBy: 'c3', sortDir: 'desc', rowGroups: [], aggregations: {} })

  const changes = [
    { id: 'a', where: t('review.list'), what: t('review.level'), now: t('review.watch'), next: t('review.act'), raise: true },
    { id: 'b', where: t('review.list'), what: t('review.discount'), now: '5%', next: '8%' },
  ]
  const reviewState = open === 'review-done'
    ? { phase: 'done' as const, results: { a: { ok: true, words: t('review.act') }, b: { ok: false, words: t('review.refused') } } }
    : open === 'review-reading' ? { phase: 'reading' as const } : { phase: 'ready' as const }

  return (
    <main id="main-content" className="fw-dsw">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <Section title={t('section.fields')}>
        <Part label={t('field.due')}><DateField value={due} onChange={setDue} ariaLabel={t('field.due')} locale={ds.dateRange.locale} labels={ds.dateField} /></Part>
        <Part label={t('field.ends')}><DateTimeField value={ends} onChange={setEnds} ariaLabel={t('field.ends')} locale={ds.dateRange.locale} labels={ds.dateTimeField} /></Part>
        <Part label={t('field.period')}><DateRangePicker value={period} onChange={setPeriod} labels={ds.dateRange} /></Part>
        <Part label={t('field.customer')}>
          <Combobox options={[{ value: 'alfa', label: 'Demo Alfa S.r.l.' }, { value: 'beta', label: 'Demo Beta S.p.A.' }]} value={customer} onChange={setCustomer} labels={ds.combobox} />
        </Part>
        <Part label={t('field.note')}>
          <Textarea aria-label={t('field.note')} rows={3} honourRows limit={200} value={note} onChange={(e) => setNote(e.target.value)} labels={ds.textarea} />
        </Part>
        <Part label={t('field.confirm')}><ConfirmPhraseField phrase="DEMO-7" value={phrase} onChange={setPhrase} labels={ds.confirmPhrase} /></Part>
      </Section>

      <Section title={t('section.time')}>
        <Part label={t('timeline.label')}>
          <Timeline label={t('timeline.label')} labels={ds.timeline} steps={[
            { key: 'received', label: t('timeline.received'), tone: 'success', at: '2026-10-28T09:00:00Z' },
            { key: 'deposit', label: t('timeline.deposit'), tone: 'info', at: READ_AT },
            { key: 'customs', label: t('timeline.customs'), tone: 'danger', at: '2026-10-30T15:00:00Z' },
            { key: 'shipped', label: t('timeline.shipped'), tone: 'neutral', at: null },
          ]} />
        </Part>
        <Part label={t('asOf.label')}><AsOf at={READ_AT} labels={ds.asOf} /></Part>
        <Part label={t('countdown.label')}><Countdown to={REPLY_DUE} labels={ds.countdown} /></Part>
        <Part label={t('job.label')}>
          <JobProgress label={t('job.label')} value={120} max={400} detail={t('job.detail', { done: 120, total: 400 })} startedAt={startedAt} labels={ds.jobProgress} />
        </Part>
      </Section>

      <Section title={t('section.files')}>
        <Part label={t('media.files')}>
          <FileDropzone onFiles={() => {}} accept=".pdf,.csv" maxBytes={5 * 1024 * 1024} labels={ds.fileDropzone} />
        </Part>
        <Part label={t('media.label')}>
          <MediaStrip label={t('media.label')} onReorder={() => {}} labels={ds.mediaStrip}
            items={[{ id: 'f', type: 'IMAGE', alt: t('media.front') }, { id: 'b', type: 'IMAGE', alt: t('media.back'), muted: true }, { id: 'v', type: 'VIDEO' }]} />
        </Part>
      </Section>

      <Section title={t('section.grid')}>
        <Part label={t('field.icon')}><IconPicker value={icon} onChange={setIcon} labels={ds.iconPicker} /></Part>
        <Part label={t('field.colour')}><ColorSwatchPicker value={colour} onChange={setColour} labels={ds.colorSwatch} /></Part>
        <Part label={t('field.density')}><GridDensityToggle value={density} onChange={setDensity} labels={ds.density} /></Part>
        <Part label={t('field.marks')}>
          <span className="fw-dsw-marks">
            <CellSaveMark state="saving" labels={ds.cellSaveMark} />
            <CellSaveMark state="waiting" labels={ds.cellSaveMark} />
            <CellSaveMark state="unknown" labels={ds.cellSaveMark} />
          </span>
        </Part>
      </Section>

      <Section title={t('section.dialogs')}>
        <div className="fw-dsw-buttons">
          <Button onClick={() => setOpen('review')}>{t('open.review')}</Button>
          <Button onClick={() => setOpen('detail')}>{t('open.detail')}</Button>
          <Button onClick={() => setOpen('step-up')}>{t('open.stepUp')}</Button>
          <Button onClick={() => setOpen('confirm')}>{t('open.confirm')}</Button>
          <Button onClick={() => setOpen('preferences')}>{t('open.preferences')}</Button>
          <Button onClick={() => setOpen('modal')}>{t('open.modal')}</Button>
        </div>
      </Section>

      <Section title={t('section.editing')}>
        <p className="fw-dsw-note">{t('edit.message')}</p>
        <EditModeBar count={changed} onDiscard={() => { setDue(''); setEnds(''); setCustomer(''); setNote('') }} onApply={() => {}} saveShortcut={changed > 0} labels={ds.editModeBar} />
      </Section>

      <ReviewChangesModal open={open === 'review' || open === 'review-done' || open === 'review-reading'} onClose={close} changes={changes} state={reviewState}
        summary={t('review.summary')} onSave={() => setOpen('review-done')} onUndo={close} doneVerb={ds.reviewDoneVerb} labels={ds.review} />

      <DetailModal open={open === 'detail'} onClose={close} title={t('detail.title', { code: current })} labels={ds.detail}
        tabs={[{ id: 'overview', label: t('detail.overview') }, { id: 'history', label: t('detail.history') }]}
        nav={{ ids: DETAIL_IDS, current, onGo: setCurrent }}>
        <p>{t('detail.body')}</p>
      </DetailModal>

      <StepUpModal open={open === 'step-up' || open === 'step-up-refused'} title={t('stepUp.title')} sentence={t('stepUp.sentence')} busy={false}
        error={open === 'step-up-refused' ? t('stepUp.refused') : null} onSubmit={() => setOpen('step-up-refused')} onClose={close} labels={ds.stepUp} />

      {open === 'confirm' && (
        <ActionConfirm onCancel={close} onConfirm={close} labels={ds.actionConfirm} impact={{
          title: t('confirm.title'), level: 'type-to-confirm', reach: 'local-destructive', confirmPhrase: 'DEMO-7', subject: { kind: 'external-id', value: 'DEMO-7' },
          asOf: READ_AT, consequences: [t('confirm.consequence')], reversal: { verb: t('confirm.verb'), fidelity: 'none' },
          findings: [{ label: t('confirm.finding'), severity: 'info' }, { label: t('confirm.unknown'), severity: 'unknown' }],
          sideEffects: [t('confirm.sideEffect')], acknowledge: t('confirm.acknowledge'), confirmLabel: t('confirm.verb'),
        }} />
      )}

      <PreferencesModal open={open === 'preferences'} onClose={close} value={prefs} onConfirm={(next) => { setPrefs(next); close() }} allColumns={columns}
        defaultVisible={['c1', 'c2', 'c3']} groupByOptions={[{ key: 'c3', label: columns[2]!.label }, { key: 'c4', label: columns[3]!.label }]}
        aggregationOptions={[{ key: 'c8', label: columns[7]!.label, funcs: ['sum', 'avg', 'max'] }]} bulkPick labels={ds.preferences} />

      <Modal open={open === 'modal'} onClose={close} title={t('modal.title')} labels={ds.modal}>
        <p>{t('modal.body')}</p>
      </Modal>
    </main>
  )
}
