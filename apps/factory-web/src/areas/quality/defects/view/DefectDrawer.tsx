'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Camera, ImageOff, Upload } from 'lucide-react'
import { Drawer } from '@nexus/ui/components'
import { Button, FilterChip, Input, Kbd, Pill, Select, Spinner, TagGlyph, Toggle } from '@nexus/ui/primitives'
import { ColorSwatchPicker, IconPicker } from '../../../../lib/i18n/ds-parts'
import { DEFECT_CLASSES, QUALITY_STAGES } from '@nexus/factory-domain/quality/defects/rules'
import { languageName } from '../../../_shared/reasons/model'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { GarmentZoneMap } from '../zones/GarmentZoneMap'
import type { DefectCategory, DefectCode } from '../api'
import { markKey, otherLanguages, wordsOf, type DefectField, type Mark, type PictureState } from '../model'
import { DrawerBlock, SaveMark } from './parts'

export interface DefectDrawerActions {
  onClose?: () => void
  onStep?: (delta: 1 | -1) => void
  onField?: (code: DefectCode, field: DefectField, value: unknown) => void
  onPicture?: (code: DefectCode, file: File) => void
  onPhoto?: (code: DefectCode) => void
  onRetire?: (code: DefectCode) => void
}

/** A text field that saves when it is left or on Enter (autosave per field), Esc puts it back. */
function WordsField({ id, label, value, disabled, mark, onSave }: { id: string; label: string; value: string; disabled: boolean; mark: Mark | undefined; onSave: (text: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <label className="fw-df-field" htmlFor={id}>
      <span className="fw-df-field-label">
        {label} <SaveMark mark={mark} />
      </span>
      <Input
        id={id}
        size="sm"
        value={text}
        disabled={disabled}
        maxLength={80}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSave(text)
          if (event.key === 'Escape') {
            event.stopPropagation()
            setText(value)
          }
        }}
        onBlur={() => text !== value && onSave(text)}
      />
    </label>
  )
}

/**
 * The defect drawer (design df-drawer: photos, names per language, zone on the GarmentZoneMap, stages) — the DS Drawer in
 * its dock mode, beside the library (the list stays usable): the code's picture (upload, or a photo with the DS photo
 * capture), its words in Italian, English and the other floor languages, its icon and colour (the DS pickers the reason
 * editor uses), and for a defect its default class, the zone, the stages and "asks for a note"; each field saves when it
 * changes, its mark says how. ⌘↑ / ⌘↓ walk the codes the list shows. A category has no class, zone or note.
 */
export function DefectDrawer({
  open,
  code,
  category,
  missing,
  canManage,
  canUpload,
  marks,
  picture,
  pictureSrc,
  hasPrevious,
  hasNext,
  actions,
}: {
  open: boolean
  code: DefectCode | null
  category: DefectCategory | null
  /** `?open=` names a code the library does not hold. */
  missing: boolean
  canManage: boolean
  canUpload: boolean
  marks: Readonly<Record<string, Mark>>
  picture: PictureState
  pictureSrc: string | null
  hasPrevious: boolean
  hasNext: boolean
  actions?: DefectDrawerActions
}) {
  const t = useT('defects')
  const tr = useT('reasons')
  const locale = useLocale()
  const file = useRef<HTMLInputElement>(null)
  const latest = useRef(actions)
  latest.current = actions

  // ⌘↑ / ⌘↓ between the codes (the list's order), while the drawer is open.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        latest.current?.onStep?.(event.key === 'ArrowDown' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const isCategory = code?.parentId === null
  const held = canManage ? null : t('held.noManage')
  const uploadHeld = held ?? (canUpload ? null : t('held.noUpload'))
  const mark = (field: string) => (code ? marks[markKey(code.id, field)] : undefined)
  const field = (name: DefectField, value: unknown) => code && actions?.onField?.(code, name, value)

  return (
    <Drawer
      mode="dock"
      open={open}
      onClose={() => actions?.onClose?.()}
      closeLabel={t('drawer.close')}
      width={440}
      title={code ? `${code.code} · ${wordsOf(code, locale)}` : t('drawer.missingTitle')}
      subtitle={code ? (isCategory ? t('drawer.categorySub', { count: (category?.defects.length ?? 0) }) : t('drawer.defectSub', { category: category ? `${category.code} · ${wordsOf(category, locale)}` : '' })) : undefined}
      footer={
        <span className="fw-df-drawer-foot">
          <Button size="sm" heldReason={hasPrevious ? null : t('drawer.first')} onClick={() => actions?.onStep?.(-1)} aria-label={t('drawer.previous')}>
            <ArrowUp size={13} aria-hidden /> {t('drawer.previous')}
            <span className="fw-df-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↑</Kbd>
            </span>
          </Button>
          <Button size="sm" heldReason={hasNext ? null : t('drawer.last')} onClick={() => actions?.onStep?.(1)} aria-label={t('drawer.next')}>
            <ArrowDown size={13} aria-hidden /> {t('drawer.next')}
            <span className="fw-df-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↓</Kbd>
            </span>
          </Button>
        </span>
      }
    >
      {!code ? (
        <p className="fw-df-sub">{missing ? t('drawer.missing') : t('common.loading')}</p>
      ) : (
        <div className="fw-df-drawer">
          <p className="fw-df-drawer-state">
            {code.active ? <Pill tone="success">{t('status.active')}</Pill> : <Pill tone="neutral">{t('status.retired')}</Pill>}
            <span className="fw-df-sub">{code.usedCount === 0 ? t('used.none') : t('used.count', { count: code.usedCount })}</span>
            <Button size="sm" variant="quiet" heldReason={held} onClick={() => (code.active ? actions?.onRetire?.(code) : field('active', true))}>
              {t(code.active ? 'row.retire' : 'row.restore')}
            </Button>
            <SaveMark mark={mark('active')} />
          </p>
          {held && <p className="fw-df-sub">{held}</p>}

          <DrawerBlock title={t('drawer.picture')} sub={t('drawer.pictureHint')}>
            <div className="fw-df-picture">
              {code.pictureFileId && pictureSrc ? (
                <img className="fw-df-picture-img" src={pictureSrc} alt={t('picture.alt', { code: code.code })} />
              ) : code.pictureFileId ? (
                <span className="fw-df-picture-empty">
                  <Spinner size={14} /> {t('picture.reading')}
                </span>
              ) : (
                <span className="fw-df-picture-empty">
                  <ImageOff size={18} aria-hidden /> {t('picture.noneYet')}
                </span>
              )}
              <span className="fw-df-actions">
                <input
                  ref={file}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="fw-df-file"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => {
                    const chosen = event.target.files?.[0]
                    if (chosen) actions?.onPicture?.(code, chosen)
                    event.target.value = ''
                  }}
                />
                <Button size="sm" heldReason={uploadHeld ?? (picture.uploading ? t('picture.uploading') : null)} onClick={() => file.current?.click()}>
                  <Upload size={13} aria-hidden /> {t(code.pictureFileId ? 'picture.replace' : 'picture.upload')}
                </Button>
                <Button size="sm" heldReason={uploadHeld ?? (picture.uploading ? t('picture.uploading') : null)} onClick={() => actions?.onPhoto?.(code)}>
                  <Camera size={13} aria-hidden /> {t('picture.take')}
                </Button>
                <Button size="sm" variant="quiet" heldReason={held ?? (code.pictureFileId ? null : t('picture.nothingToRemove'))} onClick={() => field('picture', null)}>
                  {t('picture.remove')}
                </Button>
                <SaveMark mark={mark('picture')} />
              </span>
              {picture.uploading && (
                <span className="fw-df-sub" role="status">
                  <Spinner size={12} /> {t('picture.uploading')}
                </span>
              )}
              {picture.problem && (
                <span className="fw-df-danger" role="alert">
                  {t(picture.problem)}
                </span>
              )}
            </div>
          </DrawerBlock>

          <DrawerBlock title={t('drawer.words')} sub={t('drawer.wordsHint')}>
            <WordsField id={`${code.id}-it`} label={t('col.it')} value={code.labelIt} disabled={!canManage} mark={mark('labelIt')} onSave={(text) => field('labelIt', text)} />
            <WordsField id={`${code.id}-en`} label={t('col.en')} value={code.labelEn} disabled={!canManage} mark={mark('labelEn')} onSave={(text) => field('labelEn', text)} />
            {otherLanguages(code).map((language) => (
              <WordsField
                key={language}
                id={`${code.id}-${language}`}
                label={languageName(language, locale)}
                value={code.labelI18n[language] ?? ''}
                disabled={!canManage}
                mark={mark(`lang:${language}`)}
                onSave={(text) => field(`lang:${language}`, text)}
              />
            ))}
          </DrawerBlock>

          <DrawerBlock title={t('drawer.look')} sub={t('drawer.lookHint')}>
            <p className="fw-df-preview">
              <TagGlyph icon={code.icon} color={code.colour} size={28} />
              <span>{wordsOf(code, locale)}</span>
              <SaveMark mark={mark('look')} />
            </p>
            {canManage ? (
              <>
                <IconPicker value={code.icon} color={code.colour} ariaLabel={tr('look.icon')} onChange={(icon) => field('look', { icon })} />
                <span className="fw-df-actions">
                  <ColorSwatchPicker value={code.colour} ariaLabel={tr('look.colour')} onChange={(colour) => field('look', { colour })} />
                  <Button size="sm" variant="quiet" heldReason={code.colour ? null : tr('look.noColourYet')} onClick={() => field('look', { colour: null })}>
                    {tr('look.clearColour')}
                  </Button>
                </span>
              </>
            ) : null}
          </DrawerBlock>

          {!isCategory && (
            <>
              <DrawerBlock title={t('drawer.severity')} sub={t('drawer.severityHint')}>
                <span className="fw-df-actions">
                  <Select size="sm" aria-label={t('col.severityOf', { code: code.code })} value={code.severity ?? ''} disabled={!canManage} onChange={(event) => field('severity', event.target.value)}>
                    {DEFECT_CLASSES.map((entry) => (
                      <option key={entry} value={entry}>
                        {t(`severity.${entry}`)}
                      </option>
                    ))}
                  </Select>
                  <SaveMark mark={mark('severity')} />
                </span>
              </DrawerBlock>
              <DrawerBlock title={t('drawer.zone')} sub={t('drawer.zoneHint')}>
                <GarmentZoneMap label={t('drawer.zoneOf', { code: code.code })} value={code.zone} onChange={(zone) => field('zone', zone)} readOnly={!canManage} compact />
                <SaveMark mark={mark('zone')} />
              </DrawerBlock>
            </>
          )}

          <DrawerBlock title={t('drawer.stages')} sub={t(code.stages.length === 0 ? 'drawer.stagesEvery' : 'drawer.stagesSome')}>
            <span className="fw-df-chips" role="group" aria-label={t('drawer.stages')}>
              {QUALITY_STAGES.map((stage) => {
                const on = code.stages.includes(stage)
                return (
                  <FilterChip key={stage} pressed={on} disabled={!canManage} onClick={() => field('stages', on ? code.stages.filter((entry) => entry !== stage) : [...code.stages, stage])}>
                    {t(`stage.${stage}`)}
                  </FilterChip>
                )
              })}
              <SaveMark mark={mark('stages')} />
            </span>
          </DrawerBlock>

          {!isCategory && (
            <DrawerBlock title={t('drawer.detail')} sub={t('drawer.detailHint')}>
              <span className="fw-df-actions">
                <Toggle size="sm" checked={code.needsDetail} disabled={!canManage} aria-label={t('drawer.detailOf', { code: code.code })} onChange={(next) => field('needsDetail', next)} />
                <span>{t(code.needsDetail ? 'detail.on' : 'detail.off')}</span>
                <SaveMark mark={mark('needsDetail')} />
              </span>
            </DrawerBlock>
          )}

          <DrawerBlock title={t('drawer.order')} sub={t('drawer.orderHint')}>
            <WordsField id={`${code.id}-order`} label={t('drawer.orderLabel')} value={String(code.sortOrder)} disabled={!canManage} mark={mark('sortOrder')} onSave={(text) => field('sortOrder', text)} />
          </DrawerBlock>
        </div>
      )}
    </Drawer>
  )
}
