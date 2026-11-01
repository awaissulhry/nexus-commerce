'use client'

import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import {
  ActionConfirm as DsActionConfirm,
  AsOf as DsAsOf,
  Combobox as DsCombobox,
  ConfirmPhraseField as DsConfirmPhraseField,
  Countdown as DsCountdown,
  DateField as DsDateField,
  DateRangePicker as DsDateRangePicker,
  DateTimeField as DsDateTimeField,
  FileDropzone as DsFileDropzone,
  FileRow as DsFileRow,
  JobProgress as DsJobProgress,
  MediaStrip as DsMediaStrip,
  Modal as DsModal,
  Timeline as DsTimeline,
} from '@nexus/ui/components'
import {
  DetailModal as DsDetailModal,
  EditModeBar as DsEditModeBar,
  PreferencesModal as DsPreferencesModal,
  ReviewChangesModal as DsReviewChangesModal,
  ReviewChangesPanel as DsReviewChangesPanel,
  StepUpModal as DsStepUpModal,
} from '@nexus/ui/patterns'
import { ColorSwatchPicker as DsColorSwatchPicker, IconPicker as DsIconPicker, Textarea as DsTextarea } from '@nexus/ui/primitives'
import { CellSaveMark as DsCellSaveMark, GridDensityToggle as DsGridDensityToggle } from '@nexus/ui/grid'
import { dsLabels, type DsLabels } from './ds-labels'
import { CATALOGUE, createTranslator } from './messages'
import { DEFAULT_LOCALE, type Locale } from './locales'
import { useLocale } from './provider'

/**
 * The design system's speaking parts in the person's language, wired once (B-W2b-18). Each export here IS the DS part —
 * the same component, the same props — with its `labels` filled from the ONE `ds-words` catalogue in the page's
 * language (B-W2b-04's `dsLabels`), so a screen imports `DateField` from here instead of `@nexus/ui/components` and never
 * shows the DS's English on an Italian page, and never forgets a part. Nothing else changes:
 *
 *   import { DateField, Modal } from '../../../lib/i18n/ds-parts'
 *   <DateField value={day} onChange={setDay} />          // weekday letters, month names, "Scegli una data" …
 *
 * - Words the screen passes still WIN: its own word props (`title`, `confirmLabel`, `placeholder` …) as before, and its
 *   own `labels` over the catalogue's, key by key.
 * - DateField / DateTimeField take the language's `locale` (month names) unless the screen gives one; the review's
 *   Done line counts under the catalogue's verb unless the screen gives `doneVerb`.
 * - The words come straight from the catalogue (no `WithMessages` needed): every view, the Office, the Floor and the
 *   links pages, reads them the same way. Times (AsOf) are written in the site's zone (Europe/Rome by default).
 *
 * New speaking DS parts: add the wiring here when a screen uses the part (its words are in ds-words.json already, by the
 * DS step's rule). The design labs keep passing `labels={ds.x}` explicitly: they show the mapping.
 */

const CACHE = new Map<Locale, DsLabels>()

/** Every DS part's words in this language (built once per language). */
export function dsWordsFor(locale: Locale): DsLabels {
  let words = CACHE.get(locale)
  if (!words) {
    const catalogue = CATALOGUE[locale] ?? CATALOGUE[DEFAULT_LOCALE]
    words = dsLabels(createTranslator(locale, catalogue['ds-words'] ?? {}), locale)
    CACHE.set(locale, words)
  }
  return words
}

/** The DS words of the page's language (no catalogue provider needed). */
export function useDsWords(): DsLabels {
  return dsWordsFor(useLocale())
}

/** The catalogue's words with the screen's own over them, key by key. */
function own<T extends object>(words: T, given: Partial<T> | undefined | null): T {
  return given ? { ...words, ...given } : words
}

export const Modal = (props: ComponentPropsWithoutRef<typeof DsModal>) => <DsModal {...props} labels={own(useDsWords().modal, props.labels)} />
export const DetailModal: typeof DsDetailModal = (props) => <DsDetailModal {...props} labels={own(useDsWords().detail, props.labels)} />
export const StepUpModal: typeof DsStepUpModal = (props) => <DsStepUpModal {...props} labels={own(useDsWords().stepUp, props.labels)} />
export const ReviewChangesModal: typeof DsReviewChangesModal = (props) => {
  const ds = useDsWords()
  return <DsReviewChangesModal {...props} doneVerb={props.doneVerb ?? ds.reviewDoneVerb} labels={own(ds.review, props.labels)} />
}
export const ReviewChangesPanel: typeof DsReviewChangesPanel = (props) => <DsReviewChangesPanel {...props} labels={own(useDsWords().review, props.labels)} />
export const ActionConfirm: typeof DsActionConfirm = (props) => <DsActionConfirm {...props} labels={own(useDsWords().actionConfirm, props.labels)} />
export const ConfirmPhraseField: typeof DsConfirmPhraseField = (props) => <DsConfirmPhraseField {...props} labels={own(useDsWords().confirmPhrase, props.labels)} />
export const EditModeBar: typeof DsEditModeBar = (props) => <DsEditModeBar {...props} labels={own(useDsWords().editModeBar, props.labels)} />
export const DateField: typeof DsDateField = (props) => {
  const ds = useDsWords()
  return <DsDateField {...props} locale={props.locale ?? ds.dateRange.locale} labels={own(ds.dateField, props.labels)} />
}
export const DateTimeField: typeof DsDateTimeField = (props) => {
  const ds = useDsWords()
  return <DsDateTimeField {...props} locale={props.locale ?? ds.dateRange.locale} labels={own(ds.dateTimeField, props.labels)} />
}
export const DateRangePicker: typeof DsDateRangePicker = (props) => <DsDateRangePicker {...props} labels={own(useDsWords().dateRange, props.labels)} />
export const AsOf: typeof DsAsOf = (props) => <DsAsOf {...props} labels={own(useDsWords().asOf, props.labels)} />
export const Countdown: typeof DsCountdown = (props) => <DsCountdown {...props} labels={own(useDsWords().countdown, props.labels)} />
export const Timeline: typeof DsTimeline = (props) => <DsTimeline {...props} labels={own(useDsWords().timeline, props.labels)} />
export const FileDropzone: typeof DsFileDropzone = (props) => <DsFileDropzone {...props} labels={own(useDsWords().fileDropzone, props.labels)} />
export const FileRow: typeof DsFileRow = (props) => <DsFileRow {...props} labels={own(useDsWords().fileRow, props.labels)} />
export const Combobox: typeof DsCombobox = (props) => <DsCombobox {...props} labels={own(useDsWords().combobox, props.labels)} />
export const MediaStrip: typeof DsMediaStrip = (props) => <DsMediaStrip {...props} labels={own(useDsWords().mediaStrip, props.labels)} />
export const JobProgress: typeof DsJobProgress = (props) => <DsJobProgress {...props} labels={own(useDsWords().jobProgress, props.labels)} />
export const PreferencesModal: typeof DsPreferencesModal = (props) => <DsPreferencesModal {...props} labels={own(useDsWords().preferences, props.labels)} />
export const IconPicker: typeof DsIconPicker = (props) => <DsIconPicker {...props} labels={own(useDsWords().iconPicker, props.labels)} />
export const ColorSwatchPicker: typeof DsColorSwatchPicker = (props) => <DsColorSwatchPicker {...props} labels={own(useDsWords().colorSwatch, props.labels)} />
export const CellSaveMark: typeof DsCellSaveMark = (props) => <DsCellSaveMark {...props} labels={own(useDsWords().cellSaveMark, props.labels)} />
export const GridDensityToggle = (props: ComponentPropsWithoutRef<typeof DsGridDensityToggle>) => <DsGridDensityToggle {...props} labels={own(useDsWords().density, props.labels)} />

/** The DS Textarea (its counter's words); the ref reaches the text box. */
export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<typeof DsTextarea>>(function Textarea(props, ref) {
  return <DsTextarea ref={ref} {...props} labels={own(useDsWords().textarea, props.labels)} />
})
