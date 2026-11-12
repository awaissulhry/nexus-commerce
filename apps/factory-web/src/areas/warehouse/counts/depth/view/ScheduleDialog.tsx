'use client'

import { useMemo } from 'react'
import { Archive, MoreHorizontal, Pencil, Plus, RotateCcw } from 'lucide-react'
import { Banner, EmptyState, Field, Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { ITEM_KIND_CHOICES, type CountItemKind } from '../../api'
import type { CountsCan } from '../../model'
import type { PlaceChoice, SiteChoice } from '../../view-model'
import type { AbcClass, Schedule } from '../api'
import { ABC_CHOICES, DUE_TONE, dueWords, scheduleFormProblems, scheduleSaveHeld, scopeParts } from '../model'
import type { CountSchedulesActions, SchedulesDialog } from '../use-count-schedules'
import { useCountsDepthWords } from './DueCounts'

/**
 * B-W2b-320 — Count schedule (design warehouse.counts page.h "Count schedule (W2b)", SCM-227): the site's schedules on the
 * shared list frame (active, or all with the retired ones), each with what it counts (a location and what is inside it, an
 * ABC class of materials by issue value, a kind of material), every how many days, the next count and when it was last
 * counted; New schedule and Edit (the domain's own check before it is sent), Retire and Reactivate. A count started from
 * the Due counts section (or any count that covers it) moves the next date on when it is applied.
 */
export function ScheduleDialog({ model, can, sites, places, timeZone, actions }: { model: SchedulesDialog; can: CountsCan; sites: readonly SiteChoice[]; places: PlaceChoice[] | null; timeZone: string; actions?: CountSchedulesActions }) {
  const { t, say } = useCountsDepthWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const form = model.form
  const columns = useMemo<ColDef<Schedule>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<Schedule>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{data.name}</span>
          <span className="fw-st-sub">{scopeParts(data).map((part) => t(part.key, part.params)).join(' · ')}</span>
        </span>
      ) : null
    const DueCell = ({ data }: ICellRendererParams<Schedule>) =>
      data ? (
        <span className="fw-st-cell">
          <span>
            <Pill tone={DUE_TONE[data.due]}>{say(dueWords(data))}</Pill>
          </span>
          <span className="fw-st-sub">{data.active ? formatDate(`${data.nextDueOn}T12:00:00Z`, place) : '—'}</span>
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<Schedule>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('cd.due.rowMenu', { name: data.name }) }}
          items={[
            { id: 'edit', label: t('cd.schedule.edit'), icon: <Pencil size={13} aria-hidden />, disabled: !can.manage, description: can.manage ? undefined : t('cd.held.noManage'), onSelect: () => actions?.onEditSchedule?.(data) },
            data.active
              ? { id: 'retire', label: t('cd.schedule.retire'), icon: <Archive size={13} aria-hidden />, disabled: !can.manage, description: can.manage ? undefined : t('cd.held.noManage'), onSelect: () => actions?.onRetire?.(data, false) }
              : { id: 'reactivate', label: t('cd.schedule.reactivate'), icon: <RotateCcw size={13} aria-hidden />, disabled: !can.manage, description: can.manage ? undefined : t('cd.held.noManage'), onSelect: () => actions?.onRetire?.(data, true) },
          ]}
        />
      ) : null
    return [
      { colId: 'name', headerName: t('cd.due.col.name'), minWidth: 220, flex: 1.8, cellRenderer: NameCell },
      { colId: 'every', headerName: t('cd.due.col.every'), minWidth: 110, flex: 0.6, valueGetter: (params) => (params.data ? t('cd.due.everyDays', { count: params.data.everyDays }) : '') },
      { colId: 'last', headerName: t('cd.due.col.last'), minWidth: 120, flex: 0.7, valueGetter: (params) => (params.data?.lastCountedOn ? formatDate(`${params.data.lastCountedOn}T12:00:00Z`, place) : t('cd.due.never')) },
      { colId: 'due', headerName: t('cd.schedule.col.next'), minWidth: 160, flex: 0.9, cellRenderer: DueCell },
      { colId: 'more', headerName: t('cd.due.col.actions'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, say, place.locale, place.timeZone, can.manage, actions])

  const problems = form ? scheduleFormProblems(form) : {}
  const held = form ? say(scheduleSaveHeld(form, can, model.busy)) : null
  const save = () => {
    if (!held) actions?.onSaveSchedule?.()
  }
  const items = model.list.items
  return (
    <Modal
      open
      onClose={() => actions?.onSchedules?.(false)}
      title={form ? t(form.id ? 'cd.form.editTitle' : 'cd.form.newTitle') : t('cd.schedule.title')}
      size="xl"
      footer={
        form ? (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onCancelSchedule?.()}>
              {t('cd.common.back')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
              {model.busy ? <Spinner size={12} /> : null} {t('cd.form.save')}
            </Button>
          </>
        ) : (
          <>
            <span className="fw-cn-hint">{t('cd.schedule.foot')}</span>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onSchedules?.(false)}>
              {t('cd.common.close')}
            </Button>
          </>
        )
      }
    >
      <div className="fw-cn-dialog">
        {model.problem && <Banner tone="danger" title={say(model.problem) ?? ''} />}
        {form ? (
          <form
            className="fw-cn-form"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                save()
              }
            }}
          >
            <Field label={t('cd.form.site')} required error={problems.site ? say(problems.site) : undefined}>
              <Select value={form.siteId ?? ''} disabled={!!form.id} onChange={(event) => actions?.onScheduleDraft?.({ siteId: event.target.value || null, locationId: null })}>
                {sites.length !== 1 && <option value="">{t('cd.form.pickSite')}</option>}
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {`${site.code} · ${site.name}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('cd.form.name')} required error={form.name.trim() === '' ? undefined : problems.name ? say(problems.name) : undefined}>
              <Input value={form.name} maxLength={200} onChange={(event) => actions?.onScheduleDraft?.({ name: event.target.value })} />
            </Field>
            <p className="fw-cn-h3 wide">{t('cd.form.what')}</p>
            <Field label={t('cd.form.location')} hint={t('cd.form.locationHint')}>
              <Select value={form.locationId ?? ''} disabled={!form.siteId || places === null} onChange={(event) => actions?.onScheduleDraft?.({ locationId: event.target.value || null })}>
                <option value="">{t('cd.form.anyPlace')}</option>
                {(places ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {`${'  '.repeat(entry.depth)}${entry.code} · ${entry.name}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('cd.form.class')} hint={t('cd.form.classHint')}>
              <Select value={form.abcClass ?? ''} onChange={(event) => actions?.onScheduleDraft?.({ abcClass: (event.target.value || null) as AbcClass | null })}>
                <option value="">{t('cd.form.anyClass')}</option>
                {ABC_CHOICES.map((abc) => (
                  <option key={abc} value={abc}>
                    {t('cd.scope.class', { abc })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('cd.form.kind')}>
              <Select value={form.itemKind ?? ''} onChange={(event) => actions?.onScheduleDraft?.({ itemKind: (event.target.value || null) as CountItemKind | null })}>
                <option value="">{t('cd.form.anyKind')}</option>
                {ITEM_KIND_CHOICES.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`cd.scope.kind.${kind}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {problems.scope && <p className="fw-cn-hint wide">{say(problems.scope)}</p>}
            <Field label={t('cd.form.every')} required hint={t('cd.form.everyHint')} error={problems.everyDays ? say(problems.everyDays) : undefined}>
              <Input value={form.everyDays} inputMode="numeric" maxLength={3} onChange={(event) => actions?.onScheduleDraft?.({ everyDays: event.target.value })} />
            </Field>
            <Field label={t('cd.form.next')} hint={t('cd.form.nextHint')} error={problems.nextDueOn ? say(problems.nextDueOn) : undefined}>
              <DateField value={form.nextDueOn} onChange={(value) => actions?.onScheduleDraft?.({ nextDueOn: value })} />
            </Field>
            <Field label={t('cd.form.note')} className="wide" error={problems.note ? say(problems.note) : undefined}>
              <Textarea value={form.note} maxLength={1000} rows={2} onChange={(event) => actions?.onScheduleDraft?.({ note: event.target.value })} />
            </Field>
          </form>
        ) : (
          <>
            <div className="fw-cn-head">
              <SegmentedControl
                ariaLabel={t('cd.schedule.filter')}
                size="sm"
                value={model.filter}
                onChange={(value) => actions?.onSchedulesFilter?.(value as 'true' | 'all')}
                options={[
                  { value: 'true', label: t('cd.schedule.active') },
                  { value: 'all', label: t('cd.schedule.all') },
                ]}
              />
              <Button size="sm" variant="primary" heldReason={can.manage ? null : t('cd.held.noManage')} onClick={() => actions?.onNewSchedule?.()}>
                <Plus size={13} aria-hidden /> {t('cd.schedule.new')}
              </Button>
            </div>
            <ListFrame<Schedule>
              label={t('cd.schedule.tableLabel')}
              rows={model.list.problem ? [] : items}
              rowId={(row) => row.id}
              columns={columns}
              count={items ? t('cd.schedule.count', { count: items.length }) : '—'}
              listKey={null}
              onOpen={(row) => can.manage && actions?.onEditSchedule?.(row)}
              state={
                model.list.problem ? (
                  <EmptyState title={t('cd.schedule.failed')} description={t('cd.common.tryAgainLater')} action={<Button size="sm" onClick={() => actions?.onSchedulesFilter?.(model.filter)}>{t('cd.common.retry')}</Button>} />
                ) : items && items.length === 0 ? (
                  <EmptyState title={t('cd.schedule.empty')} description={t('cd.schedule.emptyBody')} />
                ) : undefined
              }
            />
          </>
        )}
      </div>
    </Modal>
  )
}
