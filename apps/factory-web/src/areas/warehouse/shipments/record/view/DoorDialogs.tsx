'use client'

import { useState } from 'react'
import { Field } from '@nexus/ui/components'
import { Checkbox, Select } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { DepthDialog } from '../../queue/shared/DepthDialog'
import { useDoorWords } from '../../queue/shared/door-words'
import { REASON_LIMITS } from '../../queue/move/model'
import type { Shipment } from '../../api'
import type { CarrierReturn } from '../doors-api'
import { ddtRequiredHeld, defaultPlaceOf, receiveHeld, type DdtRequiredForm, type ReceiveForm } from '../doors'

/**
 * F-OS-203 (order SHIPMENTS tab, 10-design §7 D7; 18-lead-settles L3, L6) — two windows Warehouse and the order's Shipments tab share
 * (ONE component each, mounted by ShipmentDoor.tsx on both pages): This shipment travels without a DDT… / Put back the DDT, and
 * Receive the garments back…. Each says what happens, what the customer sees, what never changes, and asks why. Centred, never a
 * drawer; ⌘↵ confirms; a refusal is said inside. The words come in the page's catalogues (`order-shipments`, Warehouse's).
 */

export function DdtRequiredDialog({ shipment, busy, problem, onGo, onClose }: { shipment: Shipment; busy: boolean; problem: string | null; onGo: (form: DdtRequiredForm) => void; onClose: () => void }) {
  const { t, say } = useDoorWords()
  const [form, setForm] = useState<DdtRequiredForm>({ ticked: false, reason: '' })
  const without = shipment.ddtRequired
  return (
    <DepthDialog
      title={without ? t('door.ddt.title', { number: shipment.number }) : t('door.ddt.backTitle', { number: shipment.number })}
      held={say(ddtRequiredHeld(shipment, form, busy))}
      onGo={() => onGo(form)}
      goLabel={without ? t('door.ddt.go') : t('door.ddt.backGo')}
      onClose={onClose}
      problem={problem}
    >
      {without ? (
        <>
          <p className="fw-sh-hint">{t('door.ddt.what')}</p>
          <Checkbox label={t('door.ddt.tick')} checked={form.ticked} onChange={(event) => setForm((current) => ({ ...current, ticked: event.target.checked }))} />
          <p className="fw-sh-hint">{t('door.ddt.hint')}</p>
          <p className="fw-sh-hint">{t('door.ddt.told')}</p>
          <p className="fw-sh-hint">{t('door.ddt.never')}</p>
        </>
      ) : (
        <p className="fw-sh-hint">{t('door.ddt.backWhat')}</p>
      )}
      <Field label={t('door.why')} required hint={t('door.officeOnly')}>
        <Textarea rows={2} limit={REASON_LIMITS.max} value={form.reason} onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))} />
      </Field>
      <p className="fw-sh-hint">{t('door.audit')}</p>
    </DepthDialog>
  )
}

export function ReceiveBackDialog({ read, busy, problem, onGo, onClose }: { read: CarrierReturn; busy: boolean; problem: string | null; onGo: (form: ReceiveForm) => void; onClose: () => void }) {
  const { t, say } = useDoorWords()
  const [form, setForm] = useState<ReceiveForm>(() => ({ locationId: defaultPlaceOf(read), note: '' }))
  return (
    <DepthDialog title={t('door.receive.title', { number: read.number })} held={say(receiveHeld(read, form, busy))} onGo={() => onGo(form)} goLabel={t('door.receive.go', { count: read.garments })} onClose={onClose} problem={problem}>
      <p className="fw-sh-hint">{t('door.receive.what', { count: read.garments })}</p>
      {read.cells.length > 0 ? (
        <ul className="fw-sh-list">
          {read.cells.map((cell) => (
            <li key={cell.cellId}>
              {cell.label} · {cell.garments}
            </li>
          ))}
        </ul>
      ) : null}
      {read.places.length > 1 ? (
        <Field label={t('door.receive.place')} required>
          <Select size="sm" value={form.locationId ?? ''} onChange={(event) => setForm((current) => ({ ...current, locationId: event.target.value || null }))}>
            <option value="">{t('door.receive.pickPlace')}</option>
            {read.places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.code} · {place.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label={t('door.wordsOptional')} hint={t('door.officeOnly')}>
        <Textarea rows={2} limit={REASON_LIMITS.max} value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} />
      </Field>
      <p className="fw-sh-hint">{t('door.receive.then')}</p>
    </DepthDialog>
  )
}
