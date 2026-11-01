'use client'

import { useEffect, useMemo, useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { normalizeLocationCode } from '@nexus/factory-domain/inventory/locations/rules'
import { useT } from '../../../../lib/i18n/provider'
import { LOCATION_KIND_LIST, type LocationKind, type LocationView } from '../../../_shared/stock/api'
import { kindUnder, moveTargets, newPlaceProblems, suggestCode, type NewPlaceForm } from '../model'

/**
 * The three dialogs of Locations (SCR-065, design lc-new, lc-move, lc-archive), shared by the list and the record: New
 * location (parent, code suggested and upper-cased, unique on the site; name; kind), Move under… (only places that are
 * not itself or below it; or the top of the site), and Archive (what it means: an archived place takes no more stock;
 * its history stays). Each calls its action and shows the refusal in this page's words; it fetches nothing.
 */

export type Refusal = { key: string; field?: 'code' | 'name' | 'parent' } | null

export type LocationDialog =
  | { kind: 'new'; parentId: string | null; form?: NewPlaceForm; refusal?: Refusal; tried?: boolean }
  | { kind: 'move'; locationId: string; parentId?: string | null; refusal?: Refusal }
  | { kind: 'archive'; locationId: string; refusal?: Refusal }

export interface DialogActions {
  onCreate?: (form: NewPlaceForm) => Promise<Refusal>
  onMove?: (location: LocationView, parentId: string | null) => Promise<Refusal>
  onArchive?: (location: LocationView) => Promise<Refusal>
}

const TOP = '__top__'

export function LocationDialogs({ dialog, locations, siteName, onClose, actions }: { dialog: LocationDialog | null; locations: readonly LocationView[]; siteName: string; onClose: () => void; actions?: DialogActions }) {
  if (!dialog) return null
  if (dialog.kind === 'new') return <NewLocation key={`new-${dialog.parentId ?? TOP}`} dialog={dialog} locations={locations} siteName={siteName} onClose={onClose} onCreate={actions?.onCreate} />
  const location = locations.find((entry) => entry.id === dialog.locationId)
  if (!location) return null
  if (dialog.kind === 'move') return <MoveLocation key={`move-${location.id}`} dialog={dialog} location={location} locations={locations} siteName={siteName} onClose={onClose} onMove={actions?.onMove} />
  return <ArchiveLocation key={`archive-${location.id}`} dialog={dialog} location={location} onClose={onClose} onArchive={actions?.onArchive} />
}

/** A place in a picker: "N-MAG › N-MAG-A · Scaffale A". */
const placeLabel = (location: LocationView) => `${location.path.join(' › ')} · ${location.name}`

function NewLocation({ dialog, locations, siteName, onClose, onCreate }: { dialog: Extract<LocationDialog, { kind: 'new' }>; locations: readonly LocationView[]; siteName: string; onClose: () => void; onCreate?: DialogActions['onCreate'] }) {
  const t = useT('warehouse-locations')
  const stock = useT('stock')
  const active = useMemo(() => locations.filter((location) => location.status === 'ACTIVE'), [locations])
  const initialParent = active.find((location) => location.id === dialog.parentId) ?? null
  const [form, setForm] = useState<NewPlaceForm>(
    () => dialog.form ?? { parentId: initialParent?.id ?? null, code: suggestCode(initialParent, locations), name: '', kind: kindUnder(initialParent) },
  )
  const [tried, setTried] = useState(!!dialog.tried)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal>(dialog.refusal ?? null)
  const problems = newPlaceProblems(form, locations)
  const shown = (field: 'code' | 'name') => (refusal?.field === field ? t(refusal.key) : tried && problems[field] ? t(problems[field]!) : undefined)
  const first = Object.values(problems)[0]
  const parent = active.find((location) => location.id === form.parentId) ?? null

  const create = async () => {
    setTried(true)
    if (first || !onCreate || busy) return
    setBusy(true)
    const answer = await onCreate({ ...form, code: normalizeLocationCode(form.code), name: form.name.trim() })
    setBusy(false)
    if (answer) setRefusal(answer)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('lc.new.title')}
      subtitle={parent ? t('lc.new.inside', { place: placeLabel(parent) }) : t('lc.new.atTop', { site: siteName })}
      footer={
        <>
          <Button onClick={onClose}>{stock('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void create()} heldReason={busy ? t('lc.busy') : tried && first ? t(first) : null}>
            {t('lc.new.create')}
          </Button>
        </>
      }
    >
      <form
        className="fw-lc-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        {refusal && !refusal.field && <Banner tone="danger" title={t(refusal.key)} />}
        <Field label={t('lc.field.parent')} hint={t('lc.new.parentHint')} error={refusal?.field === 'parent' ? t(refusal.key) : undefined}>
          <Select
            value={form.parentId ?? TOP}
            onChange={(event) => {
              const next = event.target.value === TOP ? null : event.target.value
              const nextParent = active.find((location) => location.id === next) ?? null
              setRefusal(null)
              setForm((current) => ({ ...current, parentId: next, kind: kindUnder(nextParent), code: current.code === suggestCode(parent, locations) ? suggestCode(nextParent, locations) : current.code }))
            }}
          >
            <option value={TOP}>{t('lc.new.top', { site: siteName })}</option>
            {active.map((location) => (
              <option key={location.id} value={location.id}>
                {' '.repeat(location.depth)}
                {placeLabel(location)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="fw-lc-pair">
          <Field label={t('lc.field.code')} required hint={t('lc.new.codeHint')} error={shown('code')}>
            <Input
              value={form.code}
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
              onChange={(event) => {
                setRefusal(null)
                setForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))
              }}
            />
          </Field>
          <Field label={t('lc.field.kind')}>
            <Select value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as LocationKind }))}>
              {LOCATION_KIND_LIST.map((kind) => (
                <option key={kind} value={kind}>
                  {stock(`locationKind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('lc.field.name')} required error={shown('name')}>
          <Input
            value={form.name}
            maxLength={120}
            autoFocus
            onChange={(event) => {
              setRefusal(null)
              setForm((current) => ({ ...current, name: event.target.value }))
            }}
          />
        </Field>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

function MoveLocation({ dialog, location, locations, siteName, onClose, onMove }: { dialog: Extract<LocationDialog, { kind: 'move' }>; location: LocationView; locations: readonly LocationView[]; siteName: string; onClose: () => void; onMove?: DialogActions['onMove'] }) {
  const t = useT('warehouse-locations')
  const stock = useT('stock')
  const targets = useMemo(() => moveTargets(location, locations), [location, locations])
  const [target, setTarget] = useState<string>(dialog.parentId === undefined ? '' : (dialog.parentId ?? TOP))
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal>(dialog.refusal ?? null)
  useEffect(() => setRefusal(null), [target])
  const atTop = location.parentId === null
  const held = busy ? t('lc.busy') : target === '' ? t('lc.move.pick') : null

  const move = async () => {
    if (held || !onMove) return
    setBusy(true)
    const answer = await onMove(location, target === TOP ? null : target)
    setBusy(false)
    if (answer) setRefusal(answer)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('lc.move.title', { code: location.code })}
      subtitle={t('lc.move.now', { place: location.path.slice(0, -1).join(' › ') || t('lc.new.top', { site: siteName }) })}
      footer={
        <>
          <Button onClick={onClose}>{stock('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void move()} heldReason={held}>
            {t('lc.move.do')}
          </Button>
        </>
      }
    >
      <div className="fw-lc-form">
        {refusal && <Banner tone="danger" title={t(refusal.key)} />}
        <Field label={t('lc.move.under')} hint={t('lc.move.hint')}>
          <Select value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="" disabled>
              {t('lc.move.pick')}
            </option>
            {!atTop && <option value={TOP}>{t('lc.new.top', { site: siteName })}</option>}
            {targets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {' '.repeat(entry.depth)}
                {placeLabel(entry)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="fw-lc-note">{t('lc.move.stockStays')}</p>
      </div>
    </Modal>
  )
}

function ArchiveLocation({ dialog, location, onClose, onArchive }: { dialog: Extract<LocationDialog, { kind: 'archive' }>; location: LocationView; onClose: () => void; onArchive?: DialogActions['onArchive'] }) {
  const t = useT('warehouse-locations')
  const stock = useT('stock')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal>(dialog.refusal ?? null)

  const archive = async () => {
    if (busy || !onArchive) return
    setBusy(true)
    const answer = await onArchive(location)
    setBusy(false)
    if (answer) setRefusal(answer)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('lc.archive.title', { code: location.code })}
      footer={
        <>
          <Button onClick={onClose}>{stock('common.cancel')}</Button>
          <Button variant="danger" onClick={() => void archive()} heldReason={busy ? t('lc.busy') : null}>
            {t('lc.archive.do')}
          </Button>
        </>
      }
    >
      <div className="fw-lc-form">
        {refusal && <Banner tone="danger" title={t(refusal.key)} />}
        <p className="fw-lc-note">{t('lc.archive.effect')}</p>
        <p className="fw-lc-note">{t('lc.archive.history')}</p>
      </div>
    </Modal>
  )
}
