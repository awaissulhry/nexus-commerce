'use client'

import { useCallback, useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import { DetailPopover } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Tag } from '@nexus/ui/primitives'
import { CellSaveMark, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { FooterDay, LimitWarning, RosterCell, ShiftChoice } from '../api'
import { hoursWords, overtimeOfCell, shiftLetter, toneOf, windowClock, warningWords } from '../model'
import type { Mark } from '../view-model'
import { useShiftWords } from './parts'

/**
 * ShiftCell (design people.shifts sec:roster; an area part, composed): one person's day. The default shift is faint, an
 * exception bold; a draft carries its dot (the workers do not see it yet); planned overtime reads "+2 h", an absence from
 * Attendance is a read-only tag (with no reason beyond the holiday or permit code), a cell that breaks a limit takes a tone
 * and the button that opens "Why this warning". Colour never says anything alone: each mark has its words.
 */

export interface ShiftCellProps {
  cell: RosterCell
  choices: readonly ShiftChoice[]
  /** The month view: a letter in a narrow column. */
  compact: boolean
  mark?: Mark | undefined
  /** Back to the grid's cell when the popover closes by Esc. */
  onReturn?: (() => void) | undefined
  whyId?: string
  whyOpen?: boolean
}

export function ShiftCell({ cell, choices, compact, mark, onReturn, whyId, whyOpen }: ShiftCellProps) {
  const t = useShiftWords()
  const shift = cell.value?.kind === 'WORK' ? cell.value.shift : null
  const off = cell.value?.kind === 'OFF'
  const overtime = overtimeOfCell(cell.overtime)
  const draft = cell.entry?.status === 'DRAFT'
  const tone = toneOf(cell.warnings)
  const name = shift
    ? compact
      ? shiftLetter(shift, choices)
      : (shift.label ?? windowClock(shift))
    : off
      ? compact
        ? t('cell.offLetter')
        : t('cell.off')
      : cell.issue === 'NOT_EMPLOYED'
        ? '—'
        : cell.issue === 'AFTER_LAST_DAY'
          ? t('cell.afterLastDay')
          : cell.issue === 'SEVERAL_SHIFTS'
            ? t(compact ? 'cell.pickLetter' : 'cell.pick')
            : compact
              ? '?'
              : t('cell.none')
  const words = [
    shift ? `${shift.label ? `${shift.label} ` : ''}${windowClock(shift)}` : off ? t('cell.off') : t(cell.issue ? `cell.issue.${cell.issue}` : 'cell.none'),
    cell.source === 'DEFAULT' ? t('cell.sourceDefault') : cell.source === 'ROSTER' ? t('cell.sourceRoster') : null,
    draft ? t('cell.draft') : null,
    overtime ? t(overtime.approved ? 'cell.overtimeApproved' : 'cell.overtimeAsked', { hours: hoursWords(overtime.minutes) }) : null,
    cell.absence ? absenceText(t, cell.absence) : null,
    cell.open ? null : t('cell.closed'),
  ].filter(Boolean)
  const classes = ['fw-rs-cell', cell.source === 'ROSTER' ? 'is-roster' : cell.source === 'DEFAULT' ? 'is-default' : 'is-none', off ? 'is-off' : '', compact ? 'is-compact' : ''].filter(Boolean).join(' ')
  return (
    <span className={classes} aria-label={words.join(' · ')}>
      <span className="fw-rs-main">
        <span className="fw-rs-name">{name}</span>
        {draft && (
          <span className="fw-rs-draft" role="img" aria-label={t('cell.draft')}>
            •
          </span>
        )}
        {tone !== 'none' && <WhyWarning warnings={cell.warnings} id={whyId} open={whyOpen} onReturn={onReturn} />}
        {mark && mark.state !== 'saved' && mark.state !== 'refused' && <CellSaveMark state={mark.state} />}
      </span>
      {(shift || overtime || cell.absence) && (
        <span className="fw-rs-sub">
          {shift && !compact && shift.label && <span>{windowClock(shift)}</span>}
          {overtime && (
            <b className={overtime.approved ? 'fw-rs-ot is-approved' : 'fw-rs-ot'}>
              +{compact ? Math.round(overtime.minutes / 60) : hoursWords(overtime.minutes)}
            </b>
          )}
          {cell.absence && !compact && <Tag tone="info">{absenceText(t, cell.absence)}</Tag>}
          {cell.absence && compact && <b className="fw-rs-absent">{(cell.absence.code ?? t(`absence.${cell.absence.kind}`)).charAt(0)}</b>}
        </span>
      )}
    </span>
  )
}

function absenceText(t: ReturnType<typeof useShiftWords>, absence: NonNullable<RosterCell['absence']>): string {
  return absence.kind === 'ABSENT' ? t('absence.ABSENT') : `${t(`absence.${absence.kind}`)}${absence.code ? ` ${absence.code}` : ''}`
}

/** Why this warning (pop:cell-why): each limit in words with its law; a held one says so. */
export function WhyWarning({ warnings, id, open, onReturn }: { warnings: readonly LimitWarning[]; id?: string | undefined; open?: boolean | undefined; onReturn?: (() => void) | undefined }) {
  const t = useShiftWords()
  const locale = useLocale()
  const ds = useDsWords()
  const held = warnings.some((warning) => warning.level === 'BLOCK')
  const lines = useMemo(() => warnings.map((warning) => ({ warning, words: warningWords(warning, locale) })), [warnings, locale])
  const label = t('why.title')
  return (
    <span className="fw-rs-why" data-why={id}>
      <DetailPopover
        trigger={<TriangleAlert size={12} aria-hidden />}
        triggerLabel={`${label}: ${lines.map((line) => t(line.words.key, line.words.params)).join(' · ')}`}
        triggerClassName={held ? 'fw-rs-why-trigger is-block' : 'fw-rs-why-trigger'}
        label={label}
        hoverDelay={300}
        {...(onReturn ? { returnFocus: onReturn } : {})}
        {...(open ? { open: true } : {})}
      >
        <div className="fw-rs-why-panel">
          <p className="fw-rs-why-title">{label}</p>
          <ul className="fw-pp-list">
            {lines.map(({ warning, words }) => (
              <li key={`${warning.rule}-${warning.date}-${JSON.stringify(warning.values)}`}>
                <span>{t(words.key, words.params)}</span>{' '}
                <LawRef law={warning.law} plain={t(`law.${warning.rule}`)} labels={ds.lawRef} />
                <p className="fw-pp-hint">{t(warning.level === 'BLOCK' ? 'why.block' : 'why.warn')}</p>
              </li>
            ))}
          </ul>
        </div>
      </DetailPopover>
    </span>
  )
}

/** A line's foot cell: people per shift that day (a count of the plan, never a name). */
export function FootCell({ day, choices, compact }: { day: FooterDay | undefined; choices: readonly ShiftChoice[]; compact: boolean }) {
  const t = useShiftWords()
  const text = useCallback(
    (entry: FooterDay['shifts'][number]) => t('foot.shift', { name: entry.label ?? windowClock(entry), count: entry.people }),
    [t],
  )
  if (!day) return <span className="fw-rs-foot">—</span>
  const working = day.shifts.reduce((sum, entry) => sum + entry.people, 0)
  const said = [...day.shifts.map(text), ...(day.off > 0 ? [t('foot.off', { count: day.off })] : []), ...(day.none > 0 ? [t('foot.none', { count: day.none })] : [])].join(' · ')
  return (
    <span className="fw-rs-foot" aria-label={said} title={said}>
      {compact ? (
        <b>{working}</b>
      ) : day.shifts.length === 0 ? (
        <span>{day.none > 0 ? t('foot.none', { count: day.none }) : t('foot.off', { count: day.off })}</span>
      ) : (
        day.shifts.map((entry) => (
          <span key={`${entry.label}-${entry.startMinute}`}>
            {shiftLetter(entry, choices)} <b>{entry.people}</b>
          </span>
        ))
      )}
    </span>
  )
}
