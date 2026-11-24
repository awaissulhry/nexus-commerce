'use client'

import { Folder, FolderKanban, Info, Lock, MoreVertical, Search } from 'lucide-react'
import Link from 'next/link'
import { useId } from 'react'
import { DetailPopover, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tooltip } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { drawnRows, HEAD_KEYS, headLine, inProjectWords, menuRows, waitingWords, type DockWidth, type HeadDoor, type HeadModel, type ThreadView } from '../model'
import { HeadTitleProvider } from './HeadPick' // tw- fx2 (G-21): the pick's title is this thread's record label
import { useHeadPick } from './HeadPick'
// B-TH-288: "Search in the thread".
import { ThreadSearch, type ThreadSearchActions } from './ThreadSearch'
import '../head.css'

export const HEAD_NS = 'record-thread-head'

export interface HeadActions {
  /** An R-ACT door: the container opens the EXISTING dialog of record-panels (TaskNewDialog, AskDialog, InviteDialog, the Followers popover, RemindMeDialog) or follows / mutes. */
  onDoor?: (door: HeadDoor) => void
  onView?: (view: ThreadView) => void
  /** A width, 'hide' (⌘J) or 'reset' (back to 40 %). */
  onWidth?: (width: DockWidth | 'hide' | 'reset') => void
  onPrint?: () => void
  /** "Close thread…": the container opens "Close thread?" (popups/Confirms). */
  onCloseThread?: () => void
  onReopen?: () => void
  /** B-TH-229: "Change owner…" — the container opens the picker of the office people who read the thread. */
  onOwner?: () => void
  // ---- B-TH-288: "Mark done" (true) / "Open again" (false); "Search in the thread" opened or closed, and its field's actions.
  onDone?: (done: boolean) => void
  onSearch?: (open: boolean) => void
  search?: ThreadSearchActions
  // ---- end B-TH-288
  /** tw- W2.1: the Files icon — the record's Files window (or, on the order, its Files tab). */
  onFiles?: () => void
}

/**
 * The thread's Head (B-TH-209, T1; tw- W2.1 THE THREAD REBUILD, 10-design §8; P0-B1, P0-B4, P8, P12): ONE row of two lines — the title
 * (the record, or the dock's pick: ONE menu, one label per thread) with ONE line under it (closed · done · the View with Show all ·
 * offline · who answers next, how long, the owner; "In project: …") — and at the right only Files (its count) · Search · ⓘ (the keys,
 * the ONE place for key hints) · ⋮ (every other tool, in one order, the counts said on their rows, held rows with why: R-ACT). Every
 * control stays inside a 433 px dock. Draws one view model, fetches nothing; the container (B-TH-300) loads it and opens the dialogs.
 */
export function RecordThreadHead({ model, actions }: { model: HeadModel; actions?: HeadActions }) {
  return (
    <WithMessages namespaces={[HEAD_NS, 'record-thread-card' /* tw- W2.4: a search hit's writer */]}>
      <Head model={model} actions={actions} />
    </WithMessages>
  )
}

/** tw- W2.1: the Files icon with its count ("Files (4)" for a screen reader); the same part wherever a head shows files. */
export function HeadFiles({ count, onFiles }: { count: number; onFiles?: (() => void) | undefined }) {
  return (
    <WithMessages namespaces={[HEAD_NS]}>
      <FilesButton count={count} onFiles={onFiles} />
    </WithMessages>
  )
}

function FilesButton({ count, onFiles }: { count: number; onFiles?: (() => void) | undefined }) {
  const t = useT(HEAD_NS)
  return (
    <Button size="sm" variant="quiet" className="fw-rth-files" aria-label={t('files.label', { count })} onClick={() => onFiles?.()}>
      <Folder size={18} aria-hidden />
      {count > 0 && <span className="fw-rth-files-n">{count > 99 ? '99+' : count}</span>}
    </Button>
  )
}

function Head({ model, actions }: { model: HeadModel; actions?: HeadActions | undefined }) {
  const t = useT(HEAD_NS)
  const locale = useLocale()
  const pick = useHeadPick()
  const place = { locale, ...(model.timeZone ? { timeZone: model.timeZone } : {}) }
  const compact = model.compact ?? false
  const role = model.party?.role ?? 'customer'
  const words = (row: { key: string; params?: Readonly<Record<string, string | number>> }) => t(row.key, dated(row.params, place))
  const viewWord = (view: ThreadView) => (view === 'shared' ? t(`view.shared.${role}`) : t(`view.${view}`))

  // ── the ⋮: ONE order (model.menuRows), the counts on their rows, held rows with why (R-ACT), no other line under a row ──
  const items: MenuItemDef[] = []
  let group: string | null = null
  for (const row of drawnRows(menuRows(model))) { // tw- fx2 (G-4, G-5): only the rows the reader may use
    const next = row.kind === 'view' ? 'views' : row.kind === 'width' ? 'width' : row.kind === 'print' || row.kind === 'close' || row.kind === 'reopen' ? 'end' : 'doors'
    if (group !== null && group !== next) items.push({ id: `sep-${next}`, separator: true })
    if (group !== next && next === 'views') items.push({ id: 'views-heading', heading: true, label: t('view.label') })
    if (group !== next && next === 'width') items.push({ id: 'width-heading', heading: true, label: t('width.title') })
    group = next
    if (row.kind === 'view') items.push({ id: `view-${row.view}`, label: viewWord(row.view), checked: row.checked, onSelect: () => actions?.onView?.(row.view) })
    else if (row.kind === 'done') items.push({ id: 'done', label: t(row.done ? 'act.openAgain' : 'act.done'), disabled: row.held !== null, ...(row.held ? { description: words(row.held) } : {}), onSelect: () => actions?.onDone?.(!row.done) })
    else if (row.kind === 'door') items.push({ id: row.door, label: row.count ? `${words(row.label)} · ${words(row.count)}` : words(row.label), disabled: row.held !== null, ...(row.held ? { description: words(row.held) } : {}), onSelect: () => actions?.onDoor?.(row.door) })
    else if (row.kind === 'owner') items.push({ id: 'owner', label: t('owner.change'), disabled: row.held !== null, ...(row.held ? { description: words(row.held) } : {}), onSelect: () => actions?.onOwner?.() })
    else if (row.kind === 'width') items.push({ id: `width-${row.width}`, label: t(`width.${row.width}`), ...(row.width === 'hide' || row.width === 'reset' ? {} : { checked: row.checked }), onSelect: () => actions?.onWidth?.(row.width) })
    else if (row.kind === 'print') items.push({ id: 'print', label: t('act.print'), onSelect: () => actions?.onPrint?.() })
    else if (row.kind === 'close') items.push({ id: 'close', label: t('act.close'), tone: 'danger', onSelect: () => actions?.onCloseThread?.() })
    else items.push({ id: 'reopen', label: t('act.reopen'), onSelect: () => actions?.onReopen?.() })
  }

  // B-TH-288 (T1-F08): the search field lies over the Head row while it is open.
  if (model.search?.open) {
    return (
      <div className={`fw-rth is-searching${compact ? ' is-compact' : ''}`} role="group" aria-label={t('label', { record: model.record })}>
        <ThreadSearch record={model.record} model={model.search} actions={{ ...actions?.search, onClose: () => actions?.onSearch?.(false) }} />
      </div>
    )
  }

  const line = headLine(model)
  const inProject = compact ? null : inProjectWords(model.projects) // B-TH-251
  return (
    <div className={`fw-rth${compact ? ' is-compact' : ''}`} role="group" aria-label={t('label', { record: model.record })}>
      <div className="fw-rth-titleblock">
        <div className="fw-rth-title">{pick ? <HeadTitleProvider title={model.pickTitle === undefined ? model.record : model.pickTitle}>{pick}</HeadTitleProvider> : <span className="fw-rth-title-words">{model.record}</span>}</div>
        {(line || inProject) && (
          <p className="fw-rth-line">
            {line && <LineWords line={line} model={model} role={role} viewWord={viewWord} onShowAll={() => actions?.onView?.('all')} />}
            {/* B-TH-251 (PROJ.linked-F05): "In project: FW27 airbag line" (+2: the tooltip names them all); never a project the reader may not open. */}
            {inProject && (
              <Tooltip label={inProject.more > 0 ? t('project.all', { names: inProject.all }) : `${inProject.first.number} ${inProject.first.label}`} portal>
                <Link className="fw-rth-project" href={inProject.first.href} aria-label={inProject.more > 0 ? t('project.labelMore', { name: inProject.first.label, count: inProject.more }) : t('project.in', { name: inProject.first.label })}>
                  <FolderKanban size={12} aria-hidden />
                  <span className="fw-rth-project-name">{t('project.in', { name: inProject.first.label })}</span>
                  {inProject.more > 0 && <span className="fw-rth-project-more">{t('project.more', { count: inProject.more })}</span>}
                </Link>
              </Tooltip>
            )}
          </p>
        )}
      </div>
      <div className="fw-rth-tools">
        {model.files && <FilesButton count={model.files.count} onFiles={actions?.onFiles} />}
        {model.search && (
          <Button size="sm" variant="quiet" className="icon" aria-label={t('search.open')} aria-keyshortcuts="/" onClick={() => actions?.onSearch?.(true)}>
            <Search size={18} aria-hidden />
          </Button>
        )}
        {/* P8: the ONE ⓘ — the only place key hints live (PR-14, S12). */}
        <DetailPopover trigger={<Info size={18} aria-hidden />} triggerLabel={t('keys.title')} triggerClassName="nds-btn sm quiet icon fw-rth-keys" label={t('keys.title')} hoverDelay={0}>
          <dl className="fw-rth-keylist">
            {HEAD_KEYS.map((row) => (
              <div key={row.key} className="fw-rth-keyrow">
                <dt>
                  <kbd className="nds-kbd">{typeof row.glyph === 'string' ? row.glyph : t(row.glyph.key)}</kbd>
                </dt>
                <dd>{t(row.key)}</dd>
              </div>
            ))}
          </dl>
        </DetailPopover>
        <Menu align="right" className="fw-rth-menu" label={<MoreVertical size={18} aria-hidden />} items={items} triggerProps={{ className: 'nds-btn sm quiet icon', 'aria-label': t('more.label') }} />
      </div>
    </div>
  )
}

/** The head's ONE line, in words (10-design §8; P9: today's side words; the owner reuses `owner.label`). */
function LineWords({ line, model, role, viewWord, onShowAll }: { line: NonNullable<ReturnType<typeof headLine>>; model: HeadModel; role: string; viewWord: (view: ThreadView) => string; onShowAll: () => void }) {
  const t = useT(HEAD_NS)
  const locale = useLocale()
  const tipId = useId()
  const place = { locale, ...(model.timeZone ? { timeZone: model.timeZone } : {}) }
  if (line.kind === 'closed') {
    return (
      <span className="fw-rth-linepart">
        <Lock size={12} aria-hidden />
        {line.by ? t('closed.by', { name: line.by, date: formatDate(line.at, place) }) : t('closed.noName', { date: formatDate(line.at, place) })}
      </span>
    )
  }
  if (line.kind === 'done') return <span className="fw-rth-linepart">{line.by ? t('done.by', { name: line.by, date: formatDate(line.at, place) }) : t('done.noName', { date: formatDate(line.at, place) })}</span>
  if (line.kind === 'view') {
    return (
      <>
        <span className="fw-rth-linepart">{t('viewShowing', { view: viewWord(line.view) })}</span>
        <span aria-hidden="true">·</span>
        <button type="button" className="fw-rth-linkbtn" onClick={onShowAll}>
          {t('viewShowAll')}
        </button>
      </>
    )
  }
  if (line.kind === 'offline') return <span className="fw-rth-linepart">{t('offline', { time: formatTime(line.asOf, place) })}</span>
  // Waiting: the API's ONE rule (working time on the company calendar, amber only while it waits on us past its threshold); the rule
  // itself in the tooltip; then who owns it.
  const answers = line.answers
  const wait = answers ? waitingWords(answers, model.now) : null
  const waiting = answers && wait ? (answers.on === 'us' ? t('answers.us', { wait: t(wait.key, { n: wait.n }) }) : t(`answers.${role}`, { wait: t(wait.key, { n: wait.n }) })) : null
  const when = answers ? `${formatDate(answers.since, place)} ${formatTime(answers.since, place)}` : ''
  const tip = answers
    ? answers.workingMinutes === undefined
      ? t(answers.on === 'us' ? 'answers.tipUs' : 'answers.tipParty', { party: model.party?.name ?? '', when })
      : [t(answers.on === 'us' ? 'rule.sinceUs' : `rule.since.${role}`, { when }), t(answers.calendar ? 'rule.working' : 'rule.clock'), answers.on === 'us' ? t('rule.amber', { count: answers.thresholdDays ?? 1 }) : t('rule.notAmber')].join(' ')
    : null
  const owner = line.owner
  const ownerWords = owner === undefined ? null : owner ? t('owner.label', { name: owner.active ? owner.name : t('owner.inactive', { name: owner.name }) }) : t('owner.nobody')
  return (
    <>
      {waiting && tip && (
        <Tooltip label={tip} portal>
          <span className={`fw-rth-linepart is-wait${answers?.amber ? ' is-amber' : ''}`} tabIndex={0} aria-describedby={tipId}>
            {waiting}
            <span id={tipId} className="nds-vh">
              {tip}
            </span>
          </span>
        </Tooltip>
      )}
      {waiting && ownerWords && <span className="fw-rth-linesep is-owner" aria-hidden="true">·</span>}
      {ownerWords && <span className="fw-rth-linepart is-owner">{ownerWords}</span>}
    </>
  )
}

/** A `{at}` value (an instant) said as a day in the page's language; other values as they are. */
function dated(params: Readonly<Record<string, string | number>> | undefined, place: { locale: 'it' | 'en'; timeZone?: string }): Record<string, string | number> | undefined {
  if (!params) return undefined
  const out: Record<string, string | number> = { ...params }
  if (typeof out.at === 'string') out.at = formatDate(out.at, place)
  return out
}
