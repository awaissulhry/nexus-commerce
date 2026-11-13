'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Spinner, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ITEM_KIND_CHOICES, type CountItemKind } from '../../api'
import { startsLater, TIME_ZONE, type CountsCan } from '../../model'
import { say, useWords } from '../../parts'
import type { NewCountActions, NewCountModel, SiteChoice } from '../../view-model'
// B-W2b-320 (cn-new W2b): the ABC class in the scope and the freeze.
import type { AbcClass } from '../../depth/api'
import { ABC_CHOICES, classCount } from '../../depth/model'
import { useCountsDepthWords } from '../../depth/view/DueCounts'

/**
 * New count (design warehouse.counts/pop:cn-new, opened by the band's primary button or `c`): the kind (a cycle count, or
 * the year-end physical inventory as of 31 December of a year, c.c. art. 2217), the site, the scope (a location and
 * everything under it, a material and one of its lots, a kind of material; none: the whole site), the counters' team, a
 * note, and whether counting starts at once (the expected quantities frozen now). A year-end inventory starts on its
 * date or after it: "Start now" is held with that reason before. B-W2b-320: the scope's ABC class of materials (a cycle
 * count of the class starts at once and names no single material or lot) and the freeze (the counted lines hold their
 * moves until each is counted; on by default). Esc closes; the focus returns to the opener.
 */
export function NewCountDialog({ model, sites, can, actions }: { model: NewCountModel; sites: SiteChoice[]; can: CountsCan; actions?: NewCountActions }) {
  const t = useWords()
  const { t: td } = useCountsDepthWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const draft = model.draft
  const byClass = classCount(draft)
  const scopeId = useId()
  const [query, setQuery] = useState(draft.item ? `${draft.item.code}` : '')
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onFind?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])

  const yearEnd = draft.kind === 'YEAR_END'
  const inventoryDate = `${draft.year}-12-31`
  const dateWords = formatDate(inventoryDate, place)
  const later = yearEnd && startsLater(inventoryDate, new Date(model.now))
  const held = !can.manage ? t('held.noManage') : !draft.siteId ? t('new.held.site') : model.busy ? t('held.busy') : null
  const startHeld = later ? t('new.startLater', { date: dateWords }) : null
  const create = () => {
    if (!held) actions?.onCreate?.()
  }

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('new.title')}
      size="lg"
      footer={
        <>
          <span className="fw-cn-hint">{draft.start && !later ? t('new.footStart') : t('new.footDraft')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {t('stock:common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('new.create')}
          </Button>
        </>
      }
    >
      <form
        className="fw-cn-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          create()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={say(t, model.problem) ?? ''} />}
        <div className="fw-cn-form" role="radiogroup" aria-label={t('new.kind')}>
          <RadioCard
            name="count-kind"
            value="CYCLE"
            checked={!yearEnd}
            selected={!yearEnd}
            onChange={() => actions?.onDraft?.({ kind: 'CYCLE' })}
            title={t('kind.CYCLE')}
            description={t('new.cycleHint')}
          />
          <RadioCard
            name="count-kind"
            value="YEAR_END"
            checked={yearEnd}
            selected={yearEnd}
            onChange={() => actions?.onDraft?.({ kind: 'YEAR_END', start: false, abcClass: null })}
            title={t('kind.YEAR_END')}
            description={t('new.yearEndHint')}
          />
        </div>

        <div className="fw-cn-form">
          <Field label={t('new.site')} required>
            <Select value={draft.siteId ?? ''} onChange={(event) => actions?.onDraft?.({ siteId: event.target.value || null, locationId: null, lotId: null })}>
              {sites.length !== 1 && <option value="">{t('new.pickSite')}</option>}
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {`${site.code} · ${site.name}`}
                </option>
              ))}
            </Select>
          </Field>
          {yearEnd ? (
            <Field label={t('new.inventoryDate')} hint={t('new.inventoryDateHint')}>
              <Select value={String(draft.year)} onChange={(event) => actions?.onDraft?.({ year: Number(event.target.value) })}>
                {model.years.map((year) => (
                  <option key={year} value={year}>
                    {formatDate(`${year}-12-31`, place)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={t('new.team')} hint={t('new.teamHint')}>
              <Input value={draft.team} maxLength={120} onChange={(event) => actions?.onDraft?.({ team: event.target.value })} />
            </Field>
          )}
        </div>

        <div className="fw-cn-form" role="group" aria-labelledby={scopeId}>
          <p className="fw-cn-h3 wide" id={scopeId}>
            {t('new.scope')}
          </p>
          <Field label={t('new.location')} hint={t('new.locationHint')}>
            <Select value={draft.locationId ?? ''} disabled={!draft.siteId || model.places === null} onChange={(event) => actions?.onDraft?.({ locationId: event.target.value || null })}>
              <option value="">{t('new.wholeSite')}</option>
              {(model.places ?? []).map((place) => (
                <option key={place.id} value={place.id}>
                  {`${' '.repeat(place.depth)}${place.code} · ${place.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.itemKind')}>
            <Select value={draft.itemKind ?? ''} onChange={(event) => actions?.onDraft?.({ itemKind: (event.target.value || null) as CountItemKind | null })}>
              <option value="">{t('new.anyKind')}</option>
              {ITEM_KIND_CHOICES.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`itemKind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          {!yearEnd && (
            <Field label={td('cd.new.class')} hint={byClass ? td('cd.new.classStarts') : td('cd.new.classHint')}>
              <Select value={draft.abcClass ?? ''} onChange={(event) => actions?.onDraft?.({ abcClass: (event.target.value || null) as AbcClass | null, ...(event.target.value ? { item: null, lotId: null, start: true } : {}) })}>
                <option value="">{td('cd.form.anyClass')}</option>
                {ABC_CHOICES.map((abc) => (
                  <option key={abc} value={abc}>
                    {td('cd.scope.class', { abc })}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('new.material')} hint={byClass ? td('cd.new.classNoItem') : can.materials ? t('new.materialHint') : t('new.noMaterials')}>
            <Input
              type="search"
              leadingIcon={model.searching ? <Spinner size={12} /> : <Search size={13} aria-hidden />}
              disabled={!can.materials || byClass}
              placeholder={t('new.materialSearch')}
              value={query}
              onChange={(event) => {
                typed.current = true
                setQuery(event.target.value)
                if (event.target.value.trim() === '') actions?.onDraft?.({ item: null, lotId: null })
              }}
            />
          </Field>
          <Field label={t('new.materialPick')}>
            <Select
              value={draft.item?.id ?? ''}
              disabled={!model.found || model.found.length === 0 || byClass}
              onChange={(event) => actions?.onDraft?.({ item: model.found?.find((item) => item.id === event.target.value) ?? null, lotId: null })}
            >
              <option value="">{model.found === null ? t('new.searchFirst') : model.found.length === 0 ? t('new.noneFound') : t('new.anyMaterial')}</option>
              {draft.item && !model.found?.some((item) => item.id === draft.item?.id) && <option value={draft.item.id}>{`${draft.item.code} · ${draft.item.name}`}</option>}
              {(model.found ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {`${item.code} · ${item.name}`}
                </option>
              ))}
            </Select>
          </Field>
          {draft.item && !byClass && draft.item.tracking !== 'NONE' && (
            <Field label={t('new.lot')} hint={t('new.lotHint')}>
              <Select value={draft.lotId ?? ''} disabled={model.lots === null} onChange={(event) => actions?.onDraft?.({ lotId: event.target.value || null })}>
                <option value="">{t('new.anyLot')}</option>
                {(model.lots ?? []).map((lot) => (
                  <option key={lot.id} value={lot.id}>
                    {lot.code}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <p className="fw-cn-hint wide">{t('new.scopeHint')}</p>
        </div>

        <div className="fw-cn-form">
          {yearEnd && (
            <Field label={t('new.team')} hint={t('new.teamHint')}>
              <Input value={draft.team} maxLength={120} onChange={(event) => actions?.onDraft?.({ team: event.target.value })} />
            </Field>
          )}
          <Field label={t('new.note')} className="wide">
            <Textarea value={draft.note} maxLength={1000} rows={2} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
          </Field>
          <div className="wide fw-cn-row">
            <Toggle checked={(draft.start || byClass) && !later} disabled={later || byClass} onChange={(next: boolean) => actions?.onDraft?.({ start: next })} aria-label={t('new.start')} />
            <span className="fw-st-cell">
              <span>{t('new.start')}</span>
              <span className="fw-cn-hint">{startHeld ?? (byClass ? td('cd.new.classStarts') : t('new.startHint'))}</span>
            </span>
          </div>
          <div className="wide fw-cn-row">
            <Toggle checked={draft.freeze ?? false} onChange={(next: boolean) => actions?.onDraft?.({ freeze: next })} aria-label={td('cd.new.freeze')} />
            <span className="fw-st-cell">
              <span>{td('cd.new.freeze')}</span>
              <span className="fw-cn-hint">{td('cd.new.freezeHint')}</span>
            </span>
          </div>
        </div>
        {yearEnd && <p className="fw-cn-hint">{t('new.yearEndLaw', { date: dateWords })}</p>}
      </form>
    </Modal>
  )
}
