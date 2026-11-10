'use client'

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { MachineClassChoice, Setting } from '../api'
import { classLabel, emptySetting, SETTING_LIMITS, settingProblems, type SettingDraft, type SettingField } from '../model'
import '../depth.css'

/**
 * Machine and stitch settings (design products.operations › Machine & settings: needle, stitches per cm, thread ticket,
 * attachment; PRD-118), shared by the operation's tab and a routing step's settings dialog: the list in its order, each
 * setting a card (machine class, stitch type, needle, thread, stitches per cm, tension, foot or attachment, notes), at most
 * ten, moved up and down, added and removed. Words come from the `products-operations-depth` catalogue. It fetches nothing.
 */
export function SettingsEditor({
  drafts,
  onDrafts,
  classes,
  current,
  shown,
  idPrefix,
}: {
  drafts: readonly SettingDraft[]
  onDrafts: (next: SettingDraft[]) => void
  /** The machine classes to pick from (null while unread; [] without plant.view). */
  classes: readonly MachineClassChoice[] | null
  /** The list as stored (a class it names stays offered while switched off or unreadable). */
  current: readonly Setting[]
  /** Show each field's problem (after a first Save). */
  shown: boolean
  /** A prefix for the field ids (two editors on one page). */
  idPrefix: string
}) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  const problems = settingProblems(drafts)
  const set = (index: number, patch: Partial<SettingDraft>) => onDrafts(drafts.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)))
  const move = (index: number, delta: -1 | 1) => {
    const next = [...drafts]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onDrafts(next)
  }
  const add = () => onDrafts([...drafts, emptySetting(`${idPrefix}-new-${Date.now()}`)])
  const full = drafts.length >= SETTING_LIMITS.perList
  const error = (index: number, field: SettingField) => (shown && problems[index]?.[field] ? t(problems[index]![field]!) : undefined)
  // The classes offered: the active ones, and any the stored list names (kept while switched off or unreadable).
  const offered = [...(classes ?? [])]
  for (const setting of current) if (setting.machineClass && !offered.some((choice) => choice.id === setting.machineClass!.id)) offered.push({ id: setting.machineClass.id, code: setting.machineClass.code, labelIt: setting.machineClass.label.it, labelEn: setting.machineClass.label.en })

  return (
    <div className="fw-opd-stack">
      {drafts.length === 0 ? (
        <EmptyState title={t('settings.empty.title')} description={t('settings.empty.body')} />
      ) : (
        <ol className="fw-opd-settings" aria-label={t('settings.listLabel')}>
          {drafts.map((draft, index) => (
            <li key={draft.key} className="fw-opd-setting">
              <div className="fw-opd-setting-head">
                <b>{t('settings.number', { n: index + 1 })}</b>
                <span className="fw-opd-inline">
                  <Button size="sm" variant="quiet" heldReason={index === 0 ? t('settings.held.first') : null} onClick={() => move(index, -1)} aria-label={t('settings.moveUp', { n: index + 1 })}>
                    <ArrowUp size={13} aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" heldReason={index === drafts.length - 1 ? t('settings.held.last') : null} onClick={() => move(index, 1)} aria-label={t('settings.moveDown', { n: index + 1 })}>
                    <ArrowDown size={13} aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => onDrafts(drafts.filter((_, at) => at !== index))} aria-label={t('settings.remove', { n: index + 1 })} title={t('settings.remove', { n: index + 1 })}>
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </span>
              </div>
              {shown && problems[index]?.row && <p className="fw-opd-hint fw-opd-danger">{t(problems[index]!.row!)}</p>}
              <div className="fw-opd-form">
                <Field label={t('settings.field.machineClass')} hint={classes !== null && classes.length === 0 && offered.length === 0 ? t('settings.classesUnread') : undefined}>
                  <Select value={draft.machineClassId} disabled={classes === null} onChange={(event) => set(index, { machineClassId: event.target.value })}>
                    <option value="">{t('settings.noClass')}</option>
                    {offered.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.code} · {classLabel(choice, locale)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('settings.field.stitchType')} hint={t('settings.hint.stitchType')} error={error(index, 'stitchType')}>
                  <Input value={draft.stitchType} maxLength={SETTING_LIMITS.stitchType} onChange={(event) => set(index, { stitchType: event.target.value })} />
                </Field>
                <Field label={t('settings.field.needle')} hint={t('settings.hint.needle')} error={error(index, 'needle')}>
                  <Input value={draft.needle} maxLength={SETTING_LIMITS.text} onChange={(event) => set(index, { needle: event.target.value })} />
                </Field>
                <Field label={t('settings.field.thread')} hint={t('settings.hint.thread')} error={error(index, 'thread')}>
                  <Input value={draft.thread} maxLength={SETTING_LIMITS.text} onChange={(event) => set(index, { thread: event.target.value })} />
                </Field>
                <Field label={t('settings.field.stitchesPerCm')} error={error(index, 'stitchesPerCm')}>
                  <Input inputMode="decimal" value={draft.stitchesPerCm} suffix={t('settings.perCm')} onChange={(event) => set(index, { stitchesPerCm: event.target.value })} />
                </Field>
                <Field label={t('settings.field.tension')} error={error(index, 'tension')}>
                  <Input value={draft.tension} maxLength={SETTING_LIMITS.text} onChange={(event) => set(index, { tension: event.target.value })} />
                </Field>
                <Field label={t('settings.field.foot')} hint={t('settings.hint.foot')} error={error(index, 'foot')}>
                  <Input value={draft.foot} maxLength={SETTING_LIMITS.text} onChange={(event) => set(index, { foot: event.target.value })} />
                </Field>
                <div className="fw-opd-span">
                  <Field label={t('settings.field.notes')} error={error(index, 'notes')}>
                    <Textarea value={draft.notes} rows={2} maxLength={SETTING_LIMITS.notes} onChange={(event) => set(index, { notes: event.target.value })} />
                  </Field>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <span className="fw-opd-row">
        <Button size="sm" heldReason={full ? t('settings.held.full', { count: SETTING_LIMITS.perList }) : null} onClick={add}>
          <Plus size={13} aria-hidden /> {t('settings.add')}
        </Button>
      </span>
    </div>
  )
}

/** The settings as text (read only: no right, an archived operation, a released routing): each setting's fields and its tablet line. */
export function SettingsList({ settings }: { settings: readonly Setting[] }) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  if (settings.length === 0) return <EmptyState title={t('settings.empty.title')} description={t('settings.empty.bodyRead')} />
  const text = (value: string | null) => value ?? '—'
  return (
    <ol className="fw-opd-settings" aria-label={t('settings.listLabel')}>
      {settings.map((setting, index) => (
        <li key={setting.id} className="fw-opd-setting">
          <div className="fw-opd-setting-head">
            <b>{t('settings.number', { n: index + 1 })}</b>
            {setting.machineClass && !setting.machineClass.active && <Tag tone="warning">{t('settings.classOff')}</Tag>}
          </div>
          <p className="fw-opd-hint">{setting.line[locale]}</p>
          <KeyValue
            dense
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('settings.field.machineClass'), value: setting.machineClass ? `${setting.machineClass.code} · ${setting.machineClass.label[locale]}` : '—' },
              { label: t('settings.field.stitchType'), value: text(setting.stitchType) },
              { label: t('settings.field.needle'), value: text(setting.needle) },
              { label: t('settings.field.thread'), value: text(setting.thread) },
              { label: t('settings.field.stitchesPerCm'), value: setting.stitchesPerCm ? t('settings.stitches', { value: locale === 'it' ? setting.stitchesPerCm.replace('.', ',') : setting.stitchesPerCm }) : '—' },
              { label: t('settings.field.tension'), value: text(setting.tension) },
              { label: t('settings.field.foot'), value: text(setting.foot) },
              { label: t('settings.field.notes'), value: text(setting.notes) },
            ]}
          />
        </li>
      ))}
    </ol>
  )
}
