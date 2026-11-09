import { createElement, Fragment, useMemo, type ReactNode } from 'react'
import type {
  ActionConfirmLabels, AsOfLabels, ComboboxLabels, ConfirmPhraseFieldLabels, CountdownLabels, DateFieldLabels, DateRangePickerLabels,
  DateTimeFieldLabels, FileDropzoneLabels, JobProgressLabels, MediaStripLabels, ModalLabels, TimelineLabels,
} from '@nexus/ui/components'
import type { DetailModalLabels, EditModeBarLabels, PreferencesModalLabels, ReviewChangesLabels, StepUpModalLabels } from '@nexus/ui/patterns'
import type { ColorSwatchPickerLabels, IconPickerLabels, TextareaLabels } from '@nexus/ui/primitives'
import type { CellSaveMarkLabels, GridDensityToggleLabels } from '@nexus/ui/grid'
// B-W2b-09: the shared parts the W2a screens composed (each its own entry point).
import type { FileRowLabels } from '@nexus/ui/components'
import type { SaveStatusLabels } from '@nexus/ui/components/SaveStatus/index'
import type { SelectableCardLabels } from '@nexus/ui/components/SelectableCard/index'
import type { RecordNavLabels } from '@nexus/ui/patterns/record-nav/index'
import type { CheckListLabels } from '@nexus/ui/patterns/checklist/index'
import type { TraceTreeLabels } from '@nexus/ui/patterns/trace-tree/index'
import type { PrintViewLabels } from '@nexus/ui/patterns/print-view/index'
import type { MarginMeterLabels } from '@nexus/ui/charts/margin-meter/index'
import type { WaterfallLabels } from '@nexus/ui/charts/waterfall/index'
import type { BarListLabels } from '@nexus/ui/charts/bar-list/index'
import type { CardListLabels } from '@nexus/ui/grid/card-list/index'
// B-W2b-28: the floor and people parts (each its own entry point).
import type { FloorElapsedLabels } from '@nexus/ui/floor/FloorElapsed/index'
import type { FloorCardLabels } from '@nexus/ui/floor/FloorCard/index'
import type { FloorNamePickerLabels } from '@nexus/ui/floor/FloorNamePicker/index'
import type { FloorListUpdatesLabels } from '@nexus/ui/floor/FloorListUpdates/index'
import type { ReadAloudLabels } from '@nexus/ui/floor/ReadAloud/index'
import type { PinSignBlockLabels } from '@nexus/ui/components/PinSignBlock/index'
import type { LawRefLabels } from '@nexus/ui/components/LawRef/index'
import type { LegalGateLabels } from '@nexus/ui/components/LegalGate/index'
import type { PrivacyNoteLabels } from '@nexus/ui/components/PrivacyNote/index'
import type { ProtectedValueLabels } from '@nexus/ui/components/ProtectedValue/index'
import type { DayStripLabels } from '@nexus/ui/components/DayStrip/index'
import type { DueCellLabels } from '@nexus/ui/components/DueCell/index'
import type { DocumentSealLabels } from '@nexus/ui/components/DocumentSeal/index'
// B-W2b-78: the quality and floor parts (each its own entry point).
import type { GateExplainerLabels } from '@nexus/ui/components/GateExplainer/index'
import type { SignOffPanelLabels } from '@nexus/ui/components/SignOffPanel/index'
import type { LimitMeterLabels } from '@nexus/ui/components/LimitMeter/index'
import type { FloorChecklistLabels } from '@nexus/ui/floor/FloorChecklist/index'
// B-W2b-155: the portal and link parts (each its own entry point).
import type { EndStateLabels } from '@nexus/ui/components/EndState/index'
import type { CodeInputLabels } from '@nexus/ui/components/CodeInput/index'
import type { RefPairLabels } from '@nexus/ui/components/RefPair/index'
import type { MilestoneTrackerLabels } from '@nexus/ui/components/MilestoneTracker/index'
import type { PaymentPanelLabels } from '@nexus/ui/components/PaymentPanel/index'
import type { ActionListLabels } from '@nexus/ui/patterns/ActionList/index'
import type { PartnerThreadLabels } from '@nexus/ui/patterns/PartnerThread/index'
import type { LineResponseListLabels } from '@nexus/ui/patterns/LineResponseList/index'
import type { PortalActionBarLabels } from '@nexus/ui/patterns/PortalActionBar/index'
import type { SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
// B-W2b-207: the product parts (each its own entry point).
import type { VersionCompareLabels } from '@nexus/ui/patterns/VersionCompare/index'
import type { RuleBuilderLabels } from '@nexus/ui/patterns/RuleBuilder/index'
import type { SizeColumnsLabels } from '@nexus/ui/grid/size-columns/index'
import type { GarmentZoneMapLabels } from '@nexus/ui/components/GarmentZoneMap/index'
import { formatDateTime, formatNumber, DEFAULT_TIME_ZONE } from './format'
import { INTL_LOCALE, type Locale } from './locales'
import type { Translate } from './messages'
import { useLocale, useT } from './provider'

/**
 * The design system's own words in the person's language (B-W2b-04): every DS part that speaks takes a `labels` prop,
 * and this turns the ONE catalogue `messages/<locale>/ds-words.json` into each part's labels — so a screen passes
 * `labels={ds.modal}`, `labels={ds.review}` … instead of composing a stand-in because the part spoke English. The
 * English catalogue says the DS's own English words (a test holds them equal; numbers take the language's separators),
 * so an English page reads as before.
 *
 *   const ds = useDsLabels()          // inside <WithMessages namespaces={['ds-words']}> (the layouts load `shell` only)
 *   <EditModeBar count={n} onApply={save} labels={ds.editModeBar} />
 *
 * Times: `asOf.ago` / `asOf.when` write in the page's language and the site's time zone (DEFAULT_TIME_ZONE unless
 * given). Numbers in the Textarea counter use the language's separators.
 */
export interface DsLabels {
  modal: ModalLabels
  editModeBar: EditModeBarLabels
  review: ReviewChangesLabels
  /** The verb the review's Done line counts under by default, for `doneVerb` ("salvate"). */
  reviewDoneVerb: string
  detail: DetailModalLabels
  stepUp: StepUpModalLabels
  actionConfirm: ActionConfirmLabels
  cellSaveMark: CellSaveMarkLabels
  dateField: DateFieldLabels
  dateTimeField: DateTimeFieldLabels
  dateRange: DateRangePickerLabels
  asOf: AsOfLabels
  timeline: TimelineLabels
  countdown: CountdownLabels
  preferences: PreferencesModalLabels
  density: GridDensityToggleLabels
  jobProgress: JobProgressLabels
  iconPicker: IconPickerLabels
  colorSwatch: ColorSwatchPickerLabels
  fileDropzone: FileDropzoneLabels
  mediaStrip: MediaStripLabels
  combobox: ComboboxLabels
  confirmPhrase: ConfirmPhraseFieldLabels
  textarea: TextareaLabels
  // B-W2b-09
  fileRow: FileRowLabels
  saveStatus: SaveStatusLabels
  /** The same words as `detail` (one Prev / Next rule for modals and pages). */
  recordNav: RecordNavLabels
  checkList: CheckListLabels
  traceTree: TraceTreeLabels
  printView: PrintViewLabels
  marginMeter: MarginMeterLabels
  waterfall: WaterfallLabels
  barList: BarListLabels
  selectableCard: SelectableCardLabels
  cardList: CardListLabels
  // B-W2b-28
  floorElapsed: FloorElapsedLabels
  floorCard: FloorCardLabels
  floorNamePicker: FloorNamePickerLabels
  floorListUpdates: FloorListUpdatesLabels
  readAloud: ReadAloudLabels
  pinSignBlock: PinSignBlockLabels
  lawRef: LawRefLabels
  legalGate: LegalGateLabels
  privacyNote: PrivacyNoteLabels
  protectedValue: ProtectedValueLabels
  dayStrip: DayStripLabels
  dueCell: DueCellLabels
  documentSeal: DocumentSealLabels
  // B-W2b-78
  gateExplainer: GateExplainerLabels
  signOffPanel: SignOffPanelLabels
  limitMeter: LimitMeterLabels
  floorChecklist: FloorChecklistLabels
  // B-W2b-155
  endState: EndStateLabels
  codeInput: CodeInputLabels
  refPair: RefPairLabels
  milestoneTracker: MilestoneTrackerLabels
  paymentPanel: PaymentPanelLabels
  actionList: ActionListLabels
  partnerThread: PartnerThreadLabels
  lineResponseList: LineResponseListLabels
  portalActionBar: PortalActionBarLabels
  /** The stacked size grid's words: spread into the grid's `copy` with the area's own (`{ ...words, ...ds.sizeGridStacked }`). */
  sizeGridStacked: Pick<SizeGridCopy, 'colourPicker' | 'colourTab' | 'sizeHeader' | 'leftHeader' | 'quantityHeader' | 'left' | 'less' | 'more' | 'atZero' | 'atMax' | 'stackTotals'>
  // B-W2b-207
  versionCompare: VersionCompareLabels
  ruleBuilder: RuleBuilderLabels
  sizeColumns: SizeColumnsLabels
  garmentZoneMap: GarmentZoneMapLabels
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** "2 minuti fa", "tra 3 ore": the DS `ago` ladder (seconds … weeks under 13 … years) in the page's language. */
export function relativeTime(iso: string, now: number, locale: Locale): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return iso
  const delta = at - now
  const abs = Math.abs(delta)
  const rtf = new Intl.RelativeTimeFormat(INTL_LOCALE[locale], { numeric: 'auto' })
  if (abs < MINUTE) return rtf.format(Math.round(delta / 1000), 'second')
  if (abs < HOUR) return rtf.format(Math.round(delta / MINUTE), 'minute')
  if (abs < DAY) return rtf.format(Math.round(delta / HOUR), 'hour')
  if (abs < WEEK) return rtf.format(Math.round(delta / DAY), 'day')
  if (abs < 13 * WEEK) return rtf.format(Math.round(delta / WEEK), 'week')
  if (abs < 365 * DAY) return rtf.format(Math.round(delta / (30 * DAY)), 'month')
  return rtf.format(Math.round(delta / (365 * DAY)), 'year')
}

/** A sentence with one value in bold ("**3** modifiche non salvate"), the value found where the text says it. */
function withBold(text: string, value: number): ReactNode {
  const shown = String(value)
  const at = text.indexOf(shown)
  if (at < 0) return text
  return createElement(Fragment, null, text.slice(0, at), createElement('b', null, value), text.slice(at + shown.length))
}

/** A sentence with a part in its place ("Digita **SKU-1** esattamente per confermare"). */
function withPart(text: string, name: string, part: ReactNode): ReactNode {
  const marker = `{${name}}`
  const at = text.indexOf(marker)
  if (at < 0) return text
  return createElement(Fragment, null, text.slice(0, at), part, text.slice(at + marker.length))
}

const TAG_ICONS = ['star', 'heart', 'flag', 'bookmark', 'sparkles', 'zap', 'flame', 'snowflake', 'sun', 'leaf', 'gift', 'package', 'box', 'truck', 'shirt', 'award', 'crown', 'gem', 'shield', 'alert', 'clock', 'calendar', 'percent', 'camera']
const SWATCHES = ['Blue', 'Green', 'Emerald', 'Lime', 'Amber', 'Orange', 'Red', 'Rose', 'Pink', 'Fuchsia', 'Purple', 'Violet', 'Indigo', 'Teal', 'Stone', 'Grey']
const PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['Today', 'today'], ['Yesterday', 'yesterday'], ['This Week', 'thisWeek'], ['Last Week', 'lastWeek'],
  ['This Month', 'thisMonth'], ['Last Month', 'lastMonth'], ['Last 3 Months', 'last3Months'], ['Last 12 Months', 'last12Months'],
]
const MEDIA_TYPES: Readonly<Record<string, string>> = { IMAGE: 'IMAGE', VIDEO: 'VIDEO', EXTERNAL_VIDEO: 'EXTERNAL_VIDEO', MODEL_3D: 'MODEL_3D', MODEL3D: 'MODEL_3D', AUDIO: 'AUDIO', DOC: 'DOC' }

/** Every DS part's labels from the `ds-words` catalogue's translator (`t` = `useT('ds-words')`). */
export function dsLabels(t: Translate, locale: Locale, timeZone: string = DEFAULT_TIME_ZONE): DsLabels {
  const num = (n: number) => formatNumber(n, locale)
  const asOf: AsOfLabels = {
    notChecked: t('asOf.notChecked'),
    never: t('asOf.never'),
    ago: (iso, now) => relativeTime(iso, now ?? Date.now(), locale),
    when: (iso) => formatDateTime(iso, { locale, timeZone }),
  }
  const dateField: DateFieldLabels = {
    weekdays: t('date.weekdays').split(','),
    previousMonth: t('date.previousMonth'),
    nextMonth: t('date.nextMonth'),
    pickDate: t('date.pickDate'),
    notSet: t('date.notSet'),
    clear: t('date.clear'),
  }
  const confirmPhrase: ConfirmPhraseFieldLabels = {
    typeToConfirm: (phrase) => withPart(t('confirmPhrase.typeToConfirm'), 'phrase', phrase),
    states: { empty: t('confirmPhrase.empty'), partial: t('confirmPhrase.partial'), mismatch: t('confirmPhrase.mismatch'), match: t('confirmPhrase.match') },
  }
  const close = t('modal.close')
  const p = (key: string, params?: Record<string, string | number>) => t(`preferences.${key}`, params)
  const r = (key: string, params?: Record<string, string | number>) => t(`review.${key}`, params)
  const d = (key: string, params?: Record<string, string | number>) => t(`detail.${key}`, params)
  return {
    modal: { close },
    editModeBar: {
      region: t('editModeBar.region'),
      unsaved: (count) => withBold(t('editModeBar.unsaved', { count }), count),
      unsavedNoCount: t('editModeBar.unsavedNoCount'),
      saveWith: t('editModeBar.saveWith'),
      discard: t('editModeBar.discard'),
      apply: t('editModeBar.apply'),
    },
    review: {
      title: (count) => r('title', { count }),
      save: (count) => r('save', { count }),
      saving: r('saving'),
      savingOf: (done, count) => r('savingOf', { done, count }),
      cancel: r('cancel'),
      done: r('done'),
      undo: r('undo'),
      undoing: r('undoing'),
      heldReading: r('heldReading'),
      heldFailed: r('heldFailed'),
      heldSaving: r('heldSaving'),
      heldSaved: r('heldSaved'),
      heldNothing: r('heldNothing'),
      heldProblem: r('heldProblem'),
      heldProblems: r('heldProblems'),
      heldTick: r('heldTick'),
      ack: (count) => r('ack', { count }),
      where: r('where'),
      what: r('what'),
      now: r('now'),
      next: r('next'),
      result: r('result'),
      note: r('note'),
      to: ` ${r('to')} `,
      raiseNote: r('raiseNote'),
      counted: (count, verb) => r('counted', { count, verb }),
      notCounted: (count, verb) => r('notCounted', { count, verb }),
      nothing: (verb) => r('nothing', { verb }),
      changesNot: (count, verb) => r('changesNot', { count, verb }),
      whatWas: (verb) => r('whatWas', { verb }),
      reading: r('reading'),
      failedTitle: r('failedTitle'),
      failedBody: r('failedBody'),
      tryAgain: r('tryAgain'),
      conflictsTitle: r('conflictsTitle'),
      conflict: (label, was, now) => r('conflict', { label, was, now }),
      problemsTitle: r('problemsTitle'),
      close,
    },
    reviewDoneVerb: r('doneVerb'),
    detail: {
      noun: d('noun'),
      previous: (noun) => d('previous', { noun }),
      next: (noun) => d('next', { noun }),
      moveBetween: (noun) => d('moveBetween', { noun }),
      position: (place, total) => d('position', { place: num(place), total: num(total) }),
      notInTable: (noun) => d('notInTable', { noun }),
      first: (noun, onPage) => d(onPage ? 'firstOnPage' : 'first', { noun }),
      last: (noun, onPage) => d(onPage ? 'lastOnPage' : 'last', { noun }),
      tabs: d('tabs'),
      reading: d('reading'),
      tryAgain: d('tryAgain'),
      close,
    },
    stepUp: {
      cancel: t('stepUp.cancel'),
      confirm: t('stepUp.confirm'),
      checking: t('stepUp.checking'),
      code: t('stepUp.code'),
      codeHint: t('stepUp.codeHint'),
      close,
    },
    actionConfirm: {
      subject: (kind) => t(`actionConfirm.subject.${kind === 'external-id' ? 'externalId' : kind}`),
      cancel: t('actionConfirm.cancel'),
      confirm: t('actionConfirm.confirm'),
      checked: t('actionConfirm.checked'),
      whatChanges: t('actionConfirm.whatChanges'),
      whatFound: t('actionConfirm.whatFound'),
      notChecked: t('actionConfirm.notChecked'),
      alsoHappens: t('actionConfirm.alsoHappens'),
      continueElsewhere: t('actionConfirm.continueElsewhere'),
      item: t('actionConfirm.item'),
      before: t('actionConfirm.before'),
      after: t('actionConfirm.after'),
      reversal: {
        unchecked: t('actionConfirm.reversalUnchecked'),
        none: t('actionConfirm.reversalNone'),
        exact: (verb) => t('actionConfirm.reversalExact', { verb }),
        lossy: (verb) => t('actionConfirm.reversalLossy', { verb }),
      },
      close,
      asOf,
      confirmPhrase,
    },
    cellSaveMark: { saving: t('cellSaveMark.saving'), waiting: t('cellSaveMark.waiting'), unknown: t('cellSaveMark.unknown') },
    dateField,
    dateTimeField: {
      dateAndTime: t('dateTime.dateAndTime'),
      date: t('dateTime.date'),
      time: t('dateTime.time'),
      notChosen: t('dateTime.notChosen'),
      chooseDate: t('dateTime.chooseDate'),
      timePlaceholder: t('dateTime.timePlaceholder'),
      dateField,
    },
    dateRange: {
      locale: INTL_LOCALE[locale],
      weekdays: dateField.weekdays,
      previousMonth: dateField.previousMonth,
      nextMonth: dateField.nextMonth,
      presets: Object.fromEntries(PRESETS.map(([label, key]) => [label, t(`dateRange.preset.${key}`)])),
    },
    asOf,
    timeline: { needsAttention: t('timeline.needsAttention'), problem: t('timeline.problem'), notYet: t('timeline.notYet'), asOf },
    countdown: {
      in: (left) => t('countdown.in', { left }),
      now: t('countdown.now'),
      second: t('countdown.second'),
      minute: t('countdown.minute'),
      hour: t('countdown.hour'),
      day: t('countdown.day'),
    },
    preferences: {
      title: p('title'), columns: p('columns'), reset: p('reset'), saveAsView: p('saveAsView'), update: (view) => p('update', { view }),
      saveAsViewGroup: p('saveAsViewGroup'), viewName: p('viewName'), saveView: p('saveView'), cancel: p('cancel'), reloadSaved: p('reloadSaved'),
      saving: p('saving'), save: p('save'), sections: p('sections'), tabColumns: p('tabColumns'), tabGrouping: p('tabGrouping'), tabDisplay: p('tabDisplay'),
      close,
      rowsPerPage: p('rowsPerPage'), sticky: p('sticky'), stickyHelp: p('stickyHelp'), pinFirst: p('pinFirst'), pinLast: p('pinLast'),
      sortOrder: p('sortOrder'), descending: p('descending'), ascending: p('ascending'),
      tickHint: p('tickHint'), quickPicks: p('quickPicks'), all: p('all'), everyColumn: p('everyColumn'), none: p('none'), onlyLocked: p('onlyLocked'),
      filterPlaceholder: p('filterPlaceholder'), filter: (list) => p('filter', { list: locale === 'en' ? list.toLowerCase() : list }),
      matchCount: (matches, total) => p('matchCount', { matches: num(matches), total: num(total) }), columnCount: (total) => p('columnCount', { total: num(total) }),
      expandAll: p('expandAll'), collapseAll: p('collapseAll'), selectEveryGroup: p('selectEveryGroup'), selectMatchingGroup: p('selectMatchingGroup'),
      selectAll: p('selectAll'), clearAll: p('clearAll'), selectMatches: (count) => p('selectMatches', { count }), clearMatches: (count) => p('clearMatches', { count }),
      noMatch: (query) => p('noMatch', { query }), groupShown: (shown, total) => p('groupShown', { shown, total }), groupMatches: (count) => p('groupMatches', { count }),
      groupToggle: (add, matching, group) => p(`${add ? 'add' : 'remove'}${matching ? 'Matching' : 'Every'}`, { group }),
      clear: p('clear'), locked: p('locked'), fixed: p('fixed'), fixedColumns: p('fixedColumns'), lockedByGrid: p('lockedByGrid'),
      lockedAt: (side) => p(side === 'right' ? 'lockedRight' : 'lockedLeft'), alwaysShown: p('alwaysShown'), alwaysShownHint: p('alwaysShownHint'),
      inView: p('inView'), inViewCount: (shown, total) => p('inViewCount', { shown, total }), viewHelp: p('viewHelp'), viewHelpGroups: p('viewHelpGroups'),
      dragColumn: (column) => p('dragColumn', { column }), dragGroup: (group) => p('dragGroup', { group }), selectForBulk: (column) => p('selectForBulk', { column }),
      moveUp: (column) => p('moveUp', { column }), moveDown: (column) => p('moveDown', { column }),
      moveGroupUp: (group) => p('moveGroupUp', { group }), moveGroupDown: (group) => p('moveGroupDown', { group }),
      lockColumn: (column) => p('lockColumn', { column }), unlockColumn: (column) => p('unlockColumn', { column }), lockHint: p('lockHint'), unlockHint: p('unlockHint'),
      removeColumn: (column) => p('removeColumn', { column }), pinned: p('pinned'), pinnedRight: p('pinnedRight'), pinnedColumns: p('pinnedColumns'),
      pinnedRightColumns: p('pinnedRightColumns'), selectAllInView: p('selectAllInView'), selectMatchingInView: p('selectMatchingInView'),
      selectBulk: p('selectBulk'), selectBulkMatching: p('selectBulkMatching'), selectedActions: p('selectedActions'),
      selected: (count) => p('selected', { count }), hiddenFromList: (count) => p('hiddenFromList', { count }), clearSelection: p('clearSelection'),
      moveToGroupLabel: p('moveToGroupLabel'), moveToGroup: p('moveToGroup'), show: p('show'), hide: p('hide'), pin: p('pin'), unpin: p('unpin'),
      resetGroup: p('resetGroup'), groupInView: (group) => p('groupInView', { group }),
      selectGroupInView: (group, matching) => p(matching ? 'selectGroupInViewMatching' : 'selectGroupInView', { group }),
      groupCount: (shown, total, pinned) => p(pinned > 0 ? 'groupCountPinned' : 'groupCount', { shown, total, pinned }),
      groupCountTitle: (shown, total, pinned) => p(pinned ? 'groupCountTitlePinned' : 'groupCountTitle', { shown, total, pinned }),
      groupEmpty: p('groupEmpty'), pinnedAbove: (count) => p('pinnedAbove', { count }), noScrolling: p('noScrolling'), showMatches: p('showMatches'),
      showGroup: p('showGroup'), noViewMatch: (query) => p('noViewMatch', { query }),
      dragInstructions: p('dragInstructions'), dragPicked: (item) => p('dragPicked', { item }), dragOver: (item, over) => p('dragOver', { item, over }),
      dragNowhere: (item) => p('dragNowhere', { item }), dragDropped: (item, over) => p('dragDropped', { item, over }), dragPutBack: (item) => p('dragPutBack', { item }),
      dragCancelled: (item) => p('dragCancelled', { item }),
      rowGroups: p('rowGroups'), rowGroupsHelp: p('rowGroupsHelp'), noGrouping: p('noGrouping'), stopGrouping: (column) => p('stopGrouping', { column }),
      groupable: p('groupable'), allGroupableUsed: p('allGroupableUsed'), groupBy: (column) => p('groupBy', { column }),
      totals: p('totals'), totalsHelp: p('totalsHelp'), noTotals: p('noTotals'), totalFor: (column) => p('totalFor', { column }),
      removeTotal: (column) => p('removeTotal', { column }), totalable: p('totalable'), allTotalsUsed: p('allTotalsUsed'), addTotal: (column) => p('addTotal', { column }),
      aggregates: { sum: p('aggregate.sum'), avg: p('aggregate.avg'), min: p('aggregate.min'), max: p('aggregate.max'), count: p('aggregate.count') },
    },
    density: { compact: t('density.compact'), cozy: t('density.cozy'), spacious: t('density.spacious') },
    jobProgress: { elapsed: (time) => t('jobProgress.elapsed', { time }) },
    iconPicker: {
      group: t('iconPicker.group'),
      none: t('iconPicker.none'),
      names: Object.fromEntries(TAG_ICONS.map((id) => [id, t(`iconPicker.name.${id}`)])),
    },
    colorSwatch: {
      group: t('colorSwatch.group'),
      names: Object.fromEntries(SWATCHES.map((name) => [name, t(`colorSwatch.name.${name}`)])),
    },
    fileDropzone: {
      prompt: t('fileDropzone.prompt'),
      unsupported: (accepts) => t('fileDropzone.unsupported', { accepts }),
      anyType: t('fileDropzone.anyType'),
      tooLarge: (name, max) => t('fileDropzone.tooLarge', { name, max }),
      hintWithSize: (accepts, max) => t('fileDropzone.hintWithSize', { accepts, max }),
      hintSizeOnly: (max) => t('fileDropzone.hintSizeOnly', { max }),
    },
    mediaStrip: {
      items: (label, count) => t('mediaStrip.items', { label, count }),
      type: (type) => t(`mediaStrip.type.${MEDIA_TYPES[type] ?? 'FILE'}`),
      shared: t('mediaStrip.shared'),
      reorderHint: t('mediaStrip.reorderHint'),
      position: (name, place, count) => t('mediaStrip.position', { name, place, count }),
      add: t('mediaStrip.add'),
    },
    combobox: { search: t('combobox.search'), noMatches: t('combobox.noMatches') },
    confirmPhrase,
    textarea: {
      counter: (used, limit) => t('textarea.counter', { used: num(used), limit: num(limit) }),
      tooLong: (over) => t('textarea.tooLong', { count: over, n: num(over) }),
    },
    // B-W2b-09 — the shared parts the W2a screens composed.
    fileRow: { replace: t('fileRow.replace'), remove: t('fileRow.remove') },
    saveStatus: {
      saved: t('saveStatus.saved'),
      savedAt: (time) => t('saveStatus.savedAt', { time }),
      saving: t('saveStatus.saving'),
      failed: (count) => t('saveStatus.failed', { count }),
      retry: t('saveStatus.retry'),
      unsaved: t('saveStatus.unsaved'),
      unsavedCount: (count) => t('saveStatus.unsavedCount', { count }),
      offline: t('saveStatus.offline'),
      offlineCount: (count) => t('saveStatus.offlineCount', { count }),
      region: t('saveStatus.region'),
    },
    recordNav: {
      noun: d('noun'),
      previous: (noun) => d('previous', { noun }),
      next: (noun) => d('next', { noun }),
      moveBetween: (noun) => d('moveBetween', { noun }),
      position: (place, total) => d('position', { place: num(place), total: num(total) }),
      notInTable: (noun) => d('notInTable', { noun }),
      first: (noun, onPage) => d(onPage ? 'firstOnPage' : 'first', { noun }),
      last: (noun, onPage) => d(onPage ? 'lastOnPage' : 'last', { noun }),
    },
    checkList: {
      states: {
        pass: t('checkList.state.pass'), warning: t('checkList.state.warning'), fail: t('checkList.state.fail'),
        checking: t('checkList.state.checking'), skipped: t('checkList.state.skipped'), unknown: t('checkList.state.unknown'),
      },
      allPass: (total) => t('checkList.allPass', { count: total }),
      // The plural follows the open checks (Italian "1 controllo aperto su 5"); one check alone has its own sentence.
      open: (open, total) => (total === 1 ? t('checkList.openOnly') : t('checkList.open', { count: open, total })),
      checking: t('checkList.checking'),
      button: (action, open) => t('checkList.button', { action, count: open }),
      held: (open, names) => t('checkList.held', { count: open, names }),
      join: (names) => names.join(t('checkList.join')),
      none: t('checkList.none'),
    },
    traceTree: {
      possible: t('traceTree.possible'),
      possibleCount: (count) => t('traceTree.possibleCount', { count }),
      levels: t('traceTree.levels'),
      tick: (name) => t('traceTree.tick', { name }),
      selected: (count) => t('traceTree.selected', { count }),
      keys: t('traceTree.keys'),
      empty: t('traceTree.empty'),
    },
    printView: {
      print: t('printView.print'),
      back: t('printView.back'),
      printedBy: (person, when) => t('printView.printedBy', { person, when }),
      printedOn: (when) => t('printView.printedOn', { when }),
      filters: (list) => t('printView.filters', { list }),
      filter: (label, value) => t('printView.filter', { label, value }),
      join: t('printView.join'),
      noFilters: t('printView.noFilters'),
      strip: t('printView.strip'),
    },
    marginMeter: {
      label: t('marginMeter.label'),
      underFloor: (value, floor) => t('marginMeter.underFloor', { value, floor }),
      underTarget: (value, target) => t('marginMeter.underTarget', { value, target }),
      onTarget: (value, target) => t('marginMeter.onTarget', { value, target }),
      overFloor: (value, floor) => t('marginMeter.overFloor', { value, floor }),
      plain: (value) => t('marginMeter.plain', { value }),
      unknown: t('marginMeter.unknown'),
      floorMark: (floor) => t('marginMeter.floorMark', { floor }),
      targetMark: (target) => t('marginMeter.targetMark', { target }),
    },
    waterfall: {
      up: (amount) => t('waterfall.up', { amount }),
      down: (amount) => t('waterfall.down', { amount }),
      stepName: (label, amount, total) => t('waterfall.stepName', { label, amount, total }),
      totalName: (label, amount) => t('waterfall.totalName', { label, amount }),
      open: (label) => t('waterfall.open', { label }),
      empty: t('waterfall.empty'),
    },
    barList: {
      name: t('barList.name'),
      value: t('barList.value'),
      unknown: t('barList.unknown'),
      parts: (parts) => parts.map((part) => t('barList.part', { label: part.label, value: part.value })).join(t('barList.partsJoin')),
      pick: (label, value) => t('barList.pick', { label, value }),
      empty: t('barList.empty'),
    },
    selectableCard: { selected: t('selectableCard.selected') },
    cardList: {
      select: t('cardList.select'),
      done: t('cardList.done'),
      selectAll: t('cardList.selectAll'),
      selected: (count) => t('cardList.selected', { count }),
      selectOne: (name) => t('cardList.selectOne', { name }),
      nothingToSelect: t('cardList.nothingToSelect'),
      sortBy: t('cardList.sortBy'),
      listOrder: t('cardList.listOrder'),
      ascending: (column) => t('cardList.ascending', { column }),
      descending: (column) => t('cardList.descending', { column }),
      reading: t('cardList.reading'),
    },
    ...floorPeopleLabels(t),
    ...qualityFloorLabels(t),
    ...portalLinkLabels(t),
    ...productPartsLabels(t),
  }
}

/** B-W2b-28 — the floor and people parts' words (`ds-words`: floorElapsed … documentSeal). */
function floorPeopleLabels(t: Translate): Pick<
  DsLabels,
  | 'floorElapsed' | 'floorCard' | 'floorNamePicker' | 'floorListUpdates' | 'readAloud' | 'pinSignBlock' | 'lawRef' | 'legalGate'
  | 'privacyNote' | 'protectedValue' | 'dayStrip' | 'dueCell' | 'documentSeal'
> {
  const k = (part: string) => (key: string, params?: Record<string, string | number>) => t(`${part}.${key}`, params)
  const fe = k('floorElapsed')
  const fc = k('floorCard')
  const np = k('floorNamePicker')
  const lu = k('floorListUpdates')
  const ra = k('readAloud')
  const ps = k('pinSignBlock')
  const lr = k('lawRef')
  const lg = k('legalGate')
  const pn = k('privacyNote')
  const pv = k('protectedValue')
  const dsk = k('dayStrip')
  const dc = k('dueCell')
  const seal = k('documentSeal')
  return {
    floorElapsed: {
      minutes: (count) => fe('minutes', { count }),
      hours: (count) => fe('hours', { count }),
      underMinute: fe('underMinute'),
      join: (hours, minutes) => fe('join', { hours, minutes }),
      over: (time) => fe('over', { time }),
      paused: fe('paused'),
      overWord: fe('overWord'),
      hourUnit: fe('hourUnit'),
      minuteUnit: fe('minuteUnit'),
    },
    floorCard: { cachedAt: (time) => fc('cachedAt', { time }), facts: fc('facts'), flags: fc('flags'), status: fc('status') },
    floorNamePicker: {
      recent: np('recent'),
      letters: np('letters'),
      jumpTo: (letter) => np('jumpTo', { letter }),
      noneFor: (letter) => np('noneFor', { letter }),
      empty: np('empty'),
    },
    floorListUpdates: {
      changed: (count) => (count <= 0 ? lu('changedUnknown') : lu('changed', { count })),
      show: lu('show'),
      announce: lu('announce'),
    },
    readAloud: { read: ra('read'), stop: ra('stop'), voice: (name) => ra('voice', { name }) },
    pinSignBlock: {
      meaningTitle: ps('meaningTitle'),
      signingAs: (name) => ps('signingAs', { name }),
      notYou: ps('notYou'),
      records: ps('records'),
      pin: ps('pin'),
      entered: (entered, total) => ps('entered', { entered, total }),
      clear: ps('clear'),
      back: ps('back'),
      busy: ps('busy'),
      cancel: ps('cancel'),
    },
    lawRef: { about: (law) => lr('about', { law }), official: lr('official'), newTab: lr('newTab') },
    legalGate: {
      states: { met: lg('states.met'), missing: lg('states.missing'), expired: lg('states.expired'), unknown: lg('states.unknown') },
      recordedBy: (who, when) => (when ? lg('recordedByAt', { who, when }) : lg('recordedBy', { who })),
      notRecorded: lg('notRecorded'),
      record: lg('record'),
      summary: (met, total) => lg('summary', { met, total }),
      onFolded: (since) => (since ? lg('onFoldedSince', { since }) : lg('onFolded')),
      onButOpen: (count) => lg('onButOpen', { count }),
      show: lg('show'),
      hide: lg('hide'),
      list: lg('list'),
      held: (count, names) => lg('held', { count, names: names.join(lg('namesJoin')) }),
      none: lg('none'),
    },
    privacyNote: {
      levels: { line: pn('levels.line'), team: pn('levels.team'), individual: pn('levels.individual'), protected: pn('levels.protected') },
      recorded: pn('recorded'),
      region: pn('region'),
    },
    protectedValue: {
      restricted: pv('restricted'),
      show: pv('show'),
      showNote: pv('showNote'),
      opening: pv('opening'),
      recordedAt: (time) => pv('recordedAt', { time }),
      recorded: pv('recorded'),
      hide: pv('hide'),
      failed: pv('failed'),
      retry: pv('retry'),
    },
    dayStrip: {
      kinds: { work: dsk('kinds.work'), break: dsk('kinds.break'), absence: dsk('kinds.absence'), overtime: dsk('kinds.overtime'), idle: dsk('kinds.idle') },
      events: {
        in: dsk('events.in'),
        out: dsk('events.out'),
        'auto-out': dsk('events.autoOut'),
        manual: dsk('events.manual'),
        'forgot-badge': dsk('events.forgotBadge'),
        other: dsk('events.other'),
      },
      shift: (from, to) => dsk('shift', { from, to }),
      span: (what, from, to) => dsk('span', { what, from, to }),
      at: (what, time) => dsk('at', { what, time }),
      flagged: dsk('flagged'),
      anomaly: dsk('anomaly'),
      textTitle: dsk('textTitle'),
      legend: dsk('legend'),
      shiftKey: dsk('shiftKey'),
      anomalyKey: dsk('anomalyKey'),
    },
    dueCell: {
      overdue: (count) => dc('overdue', { count }),
      today: dc('today'),
      dueIn: (count) => dc('dueIn', { count }),
      validUntil: (date) => dc('validUntil', { date }),
      needed: dc('needed'),
      done: dc('done'),
      doneOn: (date) => dc('doneOn', { date }),
      none: dc('none'),
    },
    documentSeal: {
      version: seal('version'),
      fingerprint: seal('fingerprint'),
      sealedAt: seal('sealedAt'),
      source: seal('source'),
      sealedBy: seal('sealedBy'),
      signers: seal('signers'),
      signedOn: (date) => seal('signedOn', { date }),
      waiting: seal('waiting'),
      signedCount: (signed, total) => seal('signedCount', { signed, total }),
      verify: seal('verify'),
      verifyNote: seal('verifyNote'),
      reading: seal('reading'),
      match: (file) => seal('match', { file }),
      mismatch: (file) => seal('mismatch', { file }),
      failed: seal('failed'),
      copy: seal('copy'),
      copied: seal('copied'),
      copyFailed: seal('copyFailed'),
      region: seal('region'),
    },
  }
}

/** B-W2b-155 — the portal and link parts' words (`ds-words`: endState … lineResponseList, sizeGridStacked). */
function portalLinkLabels(t: Translate): Pick<
  DsLabels,
  | 'endState' | 'codeInput' | 'refPair' | 'milestoneTracker' | 'paymentPanel' | 'actionList' | 'partnerThread' | 'lineResponseList'
  | 'portalActionBar' | 'sizeGridStacked'
> {
  const k = (part: string) => (key: string, params?: Record<string, string | number>) => t(`${part}.${key}`, params)
  const es = k('endState')
  const ci = k('codeInput')
  const rp = k('refPair')
  const mt = k('milestoneTracker')
  const pp = k('paymentPanel')
  const al = k('actionList')
  const pt = k('partnerThread')
  const lr = k('lineResponseList')
  const pab = k('portalActionBar')
  const sg = k('sizeGridStacked')
  return {
    endState: {
      next: es('next'),
      receipt: es('receipt'),
      reference: es('reference'),
      copyReference: (value) => es('copyReference', { value }),
      copied: es('copied'),
      copyFailed: es('copyFailed'),
      yourCopy: es('yourCopy'),
      yourCopyNamed: (file) => es('yourCopyNamed', { file }),
      contact: es('contact'),
      emailTo: (name) => es('emailTo', { name }),
      callTo: (name) => es('callTo', { name }),
      busy: es('busy'),
    },
    codeInput: {
      label: ci('label'),
      hint: (length) => ci('hint', { length }),
      triesLeft: (count) => ci('triesLeft', { count }),
      checking: ci('checking'),
      resendIn: (left) => ci('resendIn', { left }),
      resend: ci('resend'),
      resending: ci('resending'),
      resent: ci('resent'),
    },
    refPair: {
      theirs: rp('theirs'),
      ours: rp('ours'),
      copy: (value) => rp('copy', { value }),
      copied: rp('copied'),
      copyFailed: rp('copyFailed'),
      pair: (theirs, ours) => rp('pair', { theirs, ours }),
    },
    milestoneTracker: {
      list: mt('list'),
      states: { done: mt('states.done'), partly: mt('states.partly'), current: mt('states.current'), todo: mt('states.todo'), skipped: mt('states.skipped') },
      doneOn: (date) => mt('doneOn', { date }),
      partlyOn: (date) => mt('partlyOn', { date }),
      usually: (date) => mt('usually', { date }),
      stepOf: (step, total) => mt('stepOf', { step, total }),
      promised: (date) => mt('promised', { date }),
      moved: (count) => mt('moved', { count }),
      history: mt('history'),
      move: (on, from, to) => mt('move', { on, from, to }),
      set: (on, to) => mt('set', { on, to }),
    },
    paymentPanel: {
      amount: pp('amount'),
      method: pp('method'),
      start: pp('start'),
      pay: (amount) => pp('pay', { amount }),
      pickMethod: pp('pickMethod'),
      starting: pp('starting'),
      paying: (provider) => (provider ? pp('payingTo', { provider }) : pp('paying')),
      waiting: pp('waiting'),
      busy: pp('busy'),
      failedTitle: pp('failedTitle'),
      retry: pp('retry'),
      succeededTitle: pp('succeededTitle'),
      fields: (provider) => (provider ? pp('fieldsBy', { provider }) : pp('fields')),
      secure: (provider) => (provider ? pp('secureTo', { provider }) : pp('secure')),
    },
    actionList: {
      empty: al('empty'),
      groupCount: (count) => al('groupCount', { count }),
      overdue: (date) => (date ? al('overdueSince', { date }) : al('overdue')),
      dueIn: (left) => al('dueIn', { left }),
      dueNow: al('dueNow'),
      dueOn: (date) => al('dueOn', { date }),
      undo: al('undo'),
      busy: al('busy'),
    },
    partnerThread: {
      title: pt('title'),
      conversation: pt('conversation'),
      you: pt('you'),
      yourTeam: pt('yourTeam'),
      channels: { email: pt('channels.email'), portal: pt('channels.portal'), app: pt('channels.app') },
      messageFrom: (who, time) => pt('messageFrom', { who, time }),
      attachments: pt('attachments'),
      empty: pt('empty'),
      loading: pt('loading'),
      failed: pt('failed'),
      retry: pt('retry'),
      earlier: pt('earlier'),
      reading: pt('reading'),
      composer: pt('composer'),
      send: pt('send'),
      sending: pt('sending'),
      emptyHeld: pt('emptyHeld'),
      attach: pt('attach'),
      attachHint: pt('attachHint'),
      attached: (count) => pt('attached', { count }),
    },
    lineResponseList: {
      list: lr('list'),
      line: (seq) => lr('line', { seq }),
      asked: lr('asked'),
      yourAnswer: lr('yourAnswer'),
      askedValue: (quantity, unit, date) => lr('askedValue', { quantity, unit, date }),
      delivery: (quantity, unit, date) => lr('delivery', { quantity, unit, date }),
      answerAsAsked: lr('answerAsAsked'),
      answerOther: (quantity, unit, date) => lr('answerOther', { quantity, unit, date }),
      answerSplit: (first, second) => lr('answerSplit', { first, second }),
      answerCannot: lr('answerCannot'),
      answerSubstitute: (what, delivery) => lr('answerSubstitute', { what, delivery }),
      answerChange: lr('answerChange'),
      reason: (reason) => lr('reason', { reason }),
      changeSaid: (words) => lr('changeSaid', { words }),
      changes: {
        LATER: lr('changes.LATER'), EARLIER: lr('changes.EARLIER'), LESS: lr('changes.LESS'), MORE: lr('changes.MORE'),
        SPLIT: lr('changes.SPLIT'), CANNOT: lr('changes.CANNOT'), SUBSTITUTE: lr('changes.SUBSTITUTE'), CHANGE: lr('changes.CHANGE'),
      },
      locked: lr('locked'),
      change: lr('change'),
      changeAria: (seq) => lr('changeAria', { seq }),
      asAskedAgain: lr('asAskedAgain'),
      asAskedAgainAria: (seq) => lr('asAskedAgainAria', { seq }),
      allAsAsked: lr('allAsAsked'),
      allAsAskedHeld: lr('allAsAskedHeld'),
      review: (summary) => lr('review', { summary }),
      summary: {
        allAsAsked: (count) => lr('summary.allAsAsked', { count }),
        asAsked: (count) => lr('summary.asAsked', { count }),
        later: (count) => lr('summary.later', { count }),
        earlier: (count) => lr('summary.earlier', { count }),
        quantity: (count) => lr('summary.quantity', { count }),
        split: (count) => lr('summary.split', { count }),
        cannot: (count) => lr('summary.cannot', { count }),
        substitute: (count) => lr('summary.substitute', { count }),
        change: (count) => lr('summary.change', { count }),
      },
      summaryJoin: lr('summaryJoin'),
      sheetTitle: (seq) => lr('sheetTitle', { seq }),
      kind: lr('kind'),
      kinds: {
        AS_ASKED: lr('kinds.AS_ASKED'), OTHER: lr('kinds.OTHER'), SPLIT: lr('kinds.SPLIT'), CANNOT: lr('kinds.CANNOT'),
        SUBSTITUTE: lr('kinds.SUBSTITUTE'), CHANGE: lr('kinds.CHANGE'),
      },
      kindHints: {
        OTHER: lr('kindHints.OTHER'), SPLIT: lr('kindHints.SPLIT'), CANNOT: lr('kindHints.CANNOT'),
        SUBSTITUTE: lr('kindHints.SUBSTITUTE'), CHANGE: lr('kindHints.CHANGE'),
      },
      quantity: (unit) => lr('quantity', { unit }),
      date: lr('date'),
      substituteKeep: lr('substituteKeep'),
      first: lr('first'),
      second: lr('second'),
      substituteChoice: lr('substituteChoice'),
      substituteChoiceNone: lr('substituteChoiceNone'),
      substitute: lr('substitute'),
      substituteHint: lr('substituteHint'),
      reasonField: lr('reasonField'),
      reasonOptional: lr('reasonOptional'),
      changeField: lr('changeField'),
      reasonHint: lr('reasonHint'),
      save: lr('save'),
      cancel: lr('cancel'),
      problems: {
        nothing: lr('problems.nothing'),
        same: lr('problems.same'),
        sameDay: lr('problems.sameDay'),
        quantityNumber: lr('problems.quantityNumber'),
        quantityPositive: lr('problems.quantityPositive'),
        dateMissing: lr('problems.dateMissing'),
        datePast: lr('problems.datePast'),
        dateFar: lr('problems.dateFar'),
        reasonMissing: lr('problems.reasonMissing'),
        changeMissing: lr('problems.changeMissing'),
        reasonLong: (max) => lr('problems.reasonLong', { max }),
        substituteMissing: lr('problems.substituteMissing'),
        substituteLong: (max) => lr('problems.substituteLong', { max }),
      },
    },
    portalActionBar: { region: pab('region'), busy: pab('busy') },
    sizeGridStacked: {
      colourPicker: sg('colourPicker'),
      colourTab: (colour, total) => sg('colourTab', { colour, total }),
      sizeHeader: sg('sizeHeader'),
      leftHeader: sg('leftHeader'),
      quantityHeader: sg('quantityHeader'),
      left: (count) => sg('left', { count }),
      less: (cell) => sg('less', { cell }),
      more: (cell) => sg('more', { cell }),
      atZero: sg('atZero'),
      atMax: (max) => sg('atMax', { max }),
      stackTotals: ({ colour, total, grand }) => sg('stackTotals', { colour, total, grand }),
    },
  }
}

/** B-W2b-78 — the quality and floor parts' words (`ds-words`: gateExplainer, signOffPanel, limitMeter, floorChecklist). */
function qualityFloorLabels(t: Translate): Pick<DsLabels, 'gateExplainer' | 'signOffPanel' | 'limitMeter' | 'floorChecklist'> {
  const k = (part: string) => (key: string, params?: Record<string, string | number>) => t(`${part}.${key}`, params)
  const ge = k('gateExplainer')
  const so = k('signOffPanel')
  const lm = k('limitMeter')
  const fc = k('floorChecklist')
  const rule = (kind: string) => ({ met: so(`rules.${kind}.met`), broken: so(`rules.${kind}.broken`), unknown: so(`rules.${kind}.unknown`) })
  return {
    gateExplainer: {
      states: { pass: ge('states.pass'), fail: ge('states.fail'), unknown: ge('states.unknown'), notNeeded: ge('states.notNeeded') },
      verdicts: { open: ge('verdicts.open'), held: ge('verdicts.held'), unknown: ge('verdicts.unknown') },
      summary: (passed, total) => ge('summary', { passed, total }),
      who: (who) => ge('who', { who }),
      how: (how) => ge('how', { how }),
      override: ge('override'),
      overrideWho: (who) => ge('overrideWho', { who }),
      asOf: (when) => ge('asOf', { when }),
      list: ge('list'),
      fix: ge('fix'),
      empty: ge('empty'),
      showWhy: (line) => ge('showWhy', { line }),
      none: ge('none'),
      held: (count, names) => ge('held', { count, names: names.join(ge('namesJoin')) }),
      unknownHeld: (count, names) => ge('unknownHeld', { count, names: names.join(ge('namesJoin')) }),
      now: (value) => ge('now', { value }),
      allMet: (count) => ge('allMet', { count }),
      more: (count) => ge('more', { count }),
    },
    signOffPanel: {
      title: so('title'),
      states: { signed: so('states.signed'), waiting: so('states.waiting'), held: so('states.held'), rejected: so('states.rejected'), notNeeded: so('states.notNeeded') },
      methods: { pin: so('methods.pin'), code: so('methods.code'), typed: so('methods.typed') },
      ruleStates: { met: so('ruleStates.met'), broken: so('ruleStates.broken'), unknown: so('ruleStates.unknown') },
      signedBy: (who, role) => (role ? so('signedByRole', { who, role }) : so('signedBy', { who })),
      rejectedBy: (who) => so('rejectedBy', { who }),
      whoMay: (who) => so('whoMay', { who }),
      fingerprint: so('fingerprint'),
      summary: (signed, total) => so('summary', { signed, total }),
      complete: so('complete'),
      rejectedSummary: so('rejectedSummary'),
      steps: so('steps'),
      step: (n) => so('step', { n }),
      afterStep: (step, label) => so('afterStep', { step, label }),
      rules: { maker: rule('maker'), fourEyes: rule('fourEyes'), authorNotApprover: rule('authorNotApprover'), other: rule('other') },
    },
    limitMeter: {
      verdicts: {
        pass: lm('verdicts.pass'),
        fail: lm('verdicts.fail'),
        belowDetection: lm('verdicts.belowDetection'),
        inconclusive: lm('verdicts.inconclusive'),
        notMeasured: lm('verdicts.notMeasured'),
        noLimit: lm('verdicts.noLimit'),
      },
      tolerance: { pass: lm('tolerance.pass'), over: lm('tolerance.over'), under: lm('tolerance.under'), notMeasured: lm('tolerance.notMeasured') },
      limit: (limit) => lm('limit', { limit }),
      minimum: (limit) => lm('minimum', { limit }),
      belowLoq: (loq) => lm('belowLoq', { loq }),
      loq: (loq) => lm('loq', { loq }),
      nominal: (nominal, minus, plus, symmetric) => (symmetric ? lm('nominalSymmetric', { nominal, plus }) : lm('nominalAsymmetric', { nominal, minus, plus })),
      overBy: (by) => lm('overBy', { by }),
      underBy: (by) => lm('underBy', { by }),
      cellOf: (value, limit) => lm('cellOf', { value, limit }),
    },
    floorChecklist: {
      groups: fc('groups'),
      states: { open: fc('states.open'), partly: fc('states.partly'), passed: fc('states.passed'), failed: fc('states.failed') },
      passed: fc('passed'),
      failed: fc('failed'),
      notChecked: fc('notChecked'),
      failedBecause: (reason) => fc('failedBecause', { reason }),
      withPhoto: fc('withPhoto'),
      optional: fc('optional'),
      pass: fc('pass'),
      fail: fc('fail'),
      groupPasses: fc('groupPasses'),
      groupAnswered: fc('groupAnswered'),
      progress: (done, total) => fc('progress', { done, total }),
      checked: (answered, total) => fc('checked', { answered, total }),
      failedCount: (count) => fc('failedCount', { count }),
      whatIsWrong: (item) => fc('whatIsWrong', { item }),
      reasons: fc('reasons'),
      photo: (item) => fc('photo', { item }),
      photoNeeded: fc('photoNeeded'),
      skipPhoto: fc('skipPhoto'),
      back: fc('back'),
      cancel: fc('cancel'),
      announcePass: (item) => fc('announcePass', { item }),
      announceFail: (item) => fc('announceFail', { item }),
      announceGroup: (group, count) => fc('announceGroup', { group, count }),
      left: (count, names) => fc('left', { count, names: names.join(fc('namesJoin')) }),
      none: fc('none'),
    },
  }
}

/** B-W2b-207 — the product parts' words (`ds-words`: versionCompare, ruleBuilder, sizeColumns, garmentZoneMap). */
function productPartsLabels(t: Translate): Pick<DsLabels, 'versionCompare' | 'ruleBuilder' | 'sizeColumns' | 'garmentZoneMap'> {
  const k = (part: string) => (key: string, params?: Record<string, string | number>) => t(`${part}.${key}`, params)
  const vc = k('versionCompare')
  const rb = k('ruleBuilder')
  const sc = k('sizeColumns')
  const gz = k('garmentZoneMap')
  const op = (name: string) => (field: string, value: string) => rb(`operators.${name}`, { field, value })
  const list = (values: readonly string[], join: 'or' | 'nor') =>
    values.length <= 1 ? (values[0] ?? '') : `${values.slice(0, -1).join(rb('listComma'))} ${rb(join === 'or' ? 'listOr' : 'listNor')} ${values[values.length - 1]}`
  return {
    versionCompare: {
      kinds: { added: vc('kinds.added'), removed: vc('kinds.removed'), changed: vc('kinds.changed'), unchanged: vc('kinds.unchanged') },
      title: (before, after) => vc('title', { before, after }),
      field: vc('field'),
      none: vc('none'),
      notIn: (version) => vc('notIn', { version }),
      sizes: vc('sizes'),
      sizeChange: (size, from, to, delta) => (delta ? vc('sizeChangeDelta', { size, from, to, delta }) : vc('sizeChange', { size, from, to })),
      totals: vc('totals'),
      summary: (added, removed, changed) =>
        [added ? vc('summaryAdded', { count: added }) : null, removed ? vc('summaryRemoved', { count: removed }) : null, changed ? vc('summaryChanged', { count: changed }) : null]
          .filter(Boolean)
          .join(vc('summaryJoin')) || vc('summaryNone'),
      same: vc('same'),
      showUnchanged: (count) => vc('showUnchanged', { count }),
      hideUnchanged: vc('hideUnchanged'),
      useAsNote: vc('useAsNote'),
      nothingToNote: vc('nothingToNote'),
      noteHead: (before, after) => vc('noteHead', { before, after }),
      noteAdded: (line) => vc('noteAdded', { line }),
      noteRemoved: (line) => vc('noteRemoved', { line }),
      noteChanged: (line, parts) => vc('noteChanged', { line, parts }),
      noteField: (field, from, to) => vc('noteField', { field, from, to }),
      noteSize: (size, from, to) => vc('noteSize', { size, from, to }),
      noteTotal: (total, from, to) => vc('noteTotal', { total, from, to }),
      join: vc('join'),
    },
    ruleBuilder: {
      operators: { eq: op('eq'), ne: op('ne'), lt: op('lt'), lte: op('lte'), gt: op('gt'), gte: op('gte'), in: op('in'), notIn: op('notIn'), contains: op('contains'), isTrue: op('isTrue'), isFalse: op('isFalse') },
      operatorNames: {
        eq: rb('operatorNames.eq'),
        ne: rb('operatorNames.ne'),
        lt: rb('operatorNames.lt'),
        lte: rb('operatorNames.lte'),
        gt: rb('operatorNames.gt'),
        gte: rb('operatorNames.gte'),
        in: rb('operatorNames.in'),
        notIn: rb('operatorNames.notIn'),
        contains: rb('operatorNames.contains'),
        isTrue: rb('operatorNames.isTrue'),
        isFalse: rb('operatorNames.isFalse'),
      },
      combinator: rb('combinator'),
      all: rb('all'),
      any: rb('any'),
      and: rb('and'),
      or: rb('or'),
      list,
      withUnit: (value, unit) => rb('withUnit', { value, unit }),
      row: (n) => rb('row', { n }),
      fieldOf: (n) => rb('fieldOf', { n }),
      operatorOf: (n) => rb('operatorOf', { n }),
      valueOf: (n) => rb('valueOf', { n }),
      pickField: rb('pickField'),
      pickOperator: rb('pickOperator'),
      pickValue: rb('pickValue'),
      addRow: rb('addRow'),
      removeRow: (n) => rb('removeRow', { n }),
      lastRow: rb('lastRow'),
      maxRows: (max) => rb('maxRows', { max }),
      preview: rb('preview'),
      unfinished: (n) => rb('unfinished', { n }),
      noRows: rb('noRows'),
      rowProblem: (n, problem) => rb('rowProblem', { n, problem }),
      problems: {
        field: rb('problems.field'),
        fieldHeld: rb('problems.fieldHeld'),
        operator: rb('problems.operator'),
        value: rb('problems.value'),
        number: rb('problems.number'),
        choice: rb('problems.choice'),
        range: (min, max) =>
          min !== null && max !== null ? rb('problems.rangeBoth', { min, max }) : min !== null ? rb('problems.rangeMin', { min }) : rb('problems.rangeMax', { max: max ?? '' }),
      },
      apply: rb('apply'),
    },
    sizeColumns: {
      missing: sc('missing'),
      notNeeded: sc('notNeeded'),
      baseHeader: (size) => sc('baseHeader', { size }),
      headerTooltip: (size, unit, base) => [sc('headerSize', { size }), unit, base ? sc('headerBase') : null].filter(Boolean).join(sc('partsJoin')),
      cellTooltip: (size, value, unit, typed) =>
        [value === null ? sc('cellMissing', { size }) : sc('cellValue', { size, value: [value, unit].filter(Boolean).join(' ') }), typed ? sc('cellTyped') : null].filter(Boolean).join(sc('partsJoin')),
      group: (unit) => (unit ? sc('group', { unit }) : sc('groupNoUnit')),
      notNumber: (size, text) => sc('notNumber', { size, text }),
      fillTitle: sc('fillTitle'),
      fillBase: (size, value) => sc('fillBase', { size, value }),
      fillIncrement: sc('fillIncrement'),
      fillIncrementHint: sc('fillIncrementHint'),
      fillKeep: (count) => sc('fillKeep', { count }),
      fillChanges: (count) => sc('fillChanges', { count }),
      fillChange: (size, from, to) => (from === null ? sc('fillChangeMissing', { size, to }) : sc('fillChange', { size, from, to })),
      fillApply: sc('fillApply'),
      fillCancel: sc('fillCancel'),
      fillNoBase: sc('fillNoBase'),
      fillBaseMissing: (size) => sc('fillBaseMissing', { size }),
      fillNotNumber: sc('fillNotNumber'),
      fillNoIncrement: sc('fillNoIncrement'),
      fillBelowZero: (size) => sc('fillBelowZero', { size }),
      fillNothing: sc('fillNothing'),
    },
    garmentZoneMap: {
      picked: (zone) => gz('picked', { zone }),
      nonePicked: gz('nonePicked'),
      elsewhere: gz('elsewhere'),
      list: gz('list'),
      none: gz('none'),
      clear: gz('clear'),
      nothingToClear: gz('nothingToClear'),
      hint: gz('hint'),
      figures: { front: gz('figures.front'), back: gz('figures.back'), trousers: gz('figures.trousers') },
      marks: gz('marks'),
      marksZone: gz('marksZone'),
      marksValue: gz('marksValue'),
      marked: (zone, words) => (words ? gz('marked', { zone, words }) : zone),
    },
  }
}

/** The DS parts' labels in the page's language, from the `ds-words` catalogue (wrap the screen in its WithMessages). */
export function useDsLabels(timeZone?: string): DsLabels {
  const t = useT('ds-words')
  const locale = useLocale()
  return useMemo(() => dsLabels(t, locale, timeZone), [t, locale, timeZone])
}
