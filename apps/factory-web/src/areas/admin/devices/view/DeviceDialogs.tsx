'use client'

import { useEffect, useState } from 'react'
import { Banner, Field, Stepper } from '@nexus/ui/components'
import { phraseMatches } from '@nexus/ui/components'
import { QrCode } from '@nexus/ui/components/QrCode/index'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Countdown, Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { DEVICE_KINDS, PRINTER_KINDS, PRINTER_STATUSES, type Device, type DeviceKind, type Printer, type PrinterKind, type PrinterStatus } from '../../shared/api'
import { enrolProblems, printerDraft, printerProblems, suggestDeviceName, type EnrolDraft, type EnrolModel, type PrinterDialog, type PrinterDraft, type SiteChoice } from '../model'

/**
 * The Devices dialogs (design 02 admin.devices pop-ups): Enrol a device (a stepper: where it will work → scan this on the
 * tablet, with the one-time QR code and a 15-minute countdown, waiting for the tablet live → ready), Printer (add or
 * change one, with its label stock), and Revoke (typed device name; it ends the device's session at once).
 */

const STEPS = ['where', 'scan', 'ready'] as const

export function EnrolWizard({
  model,
  sites,
  busy,
  problem,
  onClose,
  onCreate,
  onRenew,
}: {
  model: EnrolModel | null | undefined
  sites: readonly SiteChoice[]
  busy: boolean
  problem: string | null
  onClose: () => void
  onCreate?: (draft: EnrolDraft) => Promise<boolean>
  onRenew?: (device: Device) => void
}) {
  const t = useT('admin')
  const first = model?.step === 'where' ? (model.siteId ?? sites[0]?.id ?? '') : (sites[0]?.id ?? '')
  const blank = (siteId: string): EnrolDraft => ({ siteId, stationId: '', name: '', kind: 'TABLET' })
  const [draft, setDraft] = useState<EnrolDraft>(() => blank(first))
  const [named, setNamed] = useState(false)
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (model?.step === 'where') {
      setDraft(blank(model.siteId ?? sites[0]?.id ?? ''))
      setNamed(false)
      setTried(false)
    }
    // The dialog opens fresh for each enrolment.
  }, [model?.step])
  if (!model) return null
  const site = sites.find((item) => item.id === draft.siteId)
  const problems = enrolProblems(draft)
  const ready = Object.keys(problems).length === 0
  const index = STEPS.indexOf(model.step)
  const submit = () => {
    setTried(true)
    if (ready && !busy) void onCreate?.(draft)
  }
  const deviceName = model.step === 'where' ? '' : model.device.name

  return (
    <Modal
      open
      onClose={onClose}
      title={t('devices.enrol')}
      size="md"
      busy={busy}
      footer={
        model.step === 'where' ? (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={submit} heldReason={tried && !ready ? t('form.fixFirst', { count: Object.keys(problems).length }) : busy ? t('common.saving') : null}>
              {t('devices.enrolCreate')}
            </Button>
          </>
        ) : model.step === 'scan' ? (
          <>
            {(model.expired || model.enrolment === null) && (
              <Button onClick={() => onRenew?.(model.device)} heldReason={busy ? t('common.saving') : null}>
                {t('devices.newCode')}
              </Button>
            )}
            <Button onClick={onClose}>{t('devices.enrolLater')}</Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        )
      }
    >
      <div className="fw-adm-modal-body">
        <Stepper steps={STEPS.map((step) => ({ key: step, label: t(`devices.step.${step}`) }))} current={index} />
        {problem && <Banner tone="danger" title={t(problem)} />}
        {model.step === 'where' && (
          <form
            className="fw-adm-modal-body"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <Field label={t('devices.field.site')} required error={tried && problems.siteId ? t(problems.siteId) : undefined}>
              <Select autoFocus value={draft.siteId} onChange={(event) => setDraft({ ...draft, siteId: event.target.value, stationId: '' })}>
                {sites.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('devices.field.station')} hint={t('devices.field.stationHint')}>
              <Select
                value={draft.stationId}
                onChange={(event) => {
                  const stationId = event.target.value
                  const station = site?.stations.find((item) => item.id === stationId)
                  setDraft({ ...draft, stationId, name: named ? draft.name : suggestDeviceName(t(`devices.kind.${draft.kind}`), station?.name) })
                }}
              >
                <option value="">{t('devices.noStation')}</option>
                {(site?.stations ?? []).map((station) => (
                  <option key={station.id} value={station.id}>
                    {station.code} · {station.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="fw-adm-form">
              <Field label={t('devices.field.name')} required error={tried && problems.name ? t(problems.name) : undefined}>
                <Input
                  value={draft.name}
                  onChange={(event) => {
                    setNamed(true)
                    setDraft({ ...draft, name: event.target.value })
                  }}
                />
              </Field>
              <Field label={t('devices.field.kind')}>
                <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as DeviceKind })}>
                  {DEVICE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`devices.kind.${kind}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="fw-adm-hint">{t('devices.modeLater')}</p>
          </form>
        )}
        {model.step === 'scan' && (
          <>
            {model.enrolment === null ? (
              <Banner tone="warning" title={t('devices.codeRepeat')} />
            ) : model.expired ? (
              <Banner tone="warning" title={t('devices.codeExpired')} />
            ) : (
              <>
                <p className="fw-adm-intro">{t('devices.scanBody', { name: deviceName })}</p>
                <QrCode
                  value={model.enrolment.url}
                  code={model.enrolment.url}
                  label={t('devices.qrLabel', { name: deviceName })}
                  size={200}
                  labels={{ copy: t('reveal.copy'), copied: t('reveal.copied'), copyFailed: t('reveal.copyFailed'), loading: t('reveal.drawing'), tooLong: t('reveal.tooLong') }}
                />
                <p className="fw-adm-cell-row">
                  <Countdown to={model.enrolment.expiresAt} label={(left) => t('devices.expiresIn', { left })} doneLabel={t('devices.codeExpired')} />
                </p>
                <p className="fw-adm-loading" role="status">
                  <Spinner size={14} /> {t('devices.waiting')}
                </p>
              </>
            )}
          </>
        )}
        {model.step === 'ready' && (
          <Banner tone="success" title={t('devices.ready', { name: model.device.name })}>
            <ul className="fw-adm-guards">
              <li>{t('devices.readyKiosk')}</li>
              <li>{t('devices.readyCharge')}</li>
              <li>{t('devices.readyWorkers')}</li>
            </ul>
          </Banner>
        )}
      </div>
    </Modal>
  )
}

export function PrinterModal({
  dialog,
  printers,
  sites,
  busy,
  problem,
  onClose,
  onSave,
}: {
  dialog: PrinterDialog | null | undefined
  printers: readonly Printer[]
  sites: readonly SiteChoice[]
  busy: boolean
  problem: string | null
  onClose: () => void
  onSave?: (draft: PrinterDraft, printer: Printer | null) => Promise<boolean>
}) {
  const t = useT('admin')
  const printer = dialog?.kind === 'edit' ? (printers.find((item) => item.id === dialog.printerId) ?? null) : null
  const [draft, setDraft] = useState<PrinterDraft>(() => printerDraft(printer, (dialog?.kind === 'new' ? dialog.siteId : null) ?? sites[0]?.id ?? ''))
  const [tried, setTried] = useState(false)
  useEffect(() => {
    setDraft(printerDraft(printer, (dialog?.kind === 'new' ? dialog.siteId : null) ?? sites[0]?.id ?? ''))
    setTried(false)
  }, [dialog])
  if (!dialog) return null
  const creating = dialog.kind === 'new'
  const taken = printers.filter((item) => item.siteId === draft.siteId).map((item) => item.code)
  const problems = printerProblems(draft, taken, creating)
  const ready = Object.keys(problems).length === 0
  const shown = (field: string) => (tried && problems[field] ? t(problems[field]!) : undefined)
  const submit = () => {
    setTried(true)
    if (ready && !busy) void onSave?.({ ...draft, code: draft.code.trim().toUpperCase() }, printer)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={creating ? t('printers.add') : t('printers.editTitle', { code: printer?.code ?? '' })}
      size="md"
      busy={busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={tried && !ready ? t('form.fixFirst', { count: Object.keys(problems).length }) : busy ? t('common.saving') : null}>
            {t('printers.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-adm-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            submit()
          }
        }}
      >
        {problem && <Banner tone="danger" title={t(problem)} />}
        <div className="fw-adm-form">
          <Field label={t('devices.field.site')} required error={shown('siteId')}>
            <Select value={draft.siteId} disabled={!creating} onChange={(event) => setDraft({ ...draft, siteId: event.target.value })}>
              {sites.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('org.field.code')} required error={shown('code')} hint={creating ? t('printers.form.codeHint') : undefined}>
            <Input autoFocus={creating} className="fw-adm-code" readOnly={!creating} value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('org.col.name')} required error={shown('name')}>
            <Input autoFocus={!creating} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label={t('org.col.kind')} hint={creating ? undefined : t('printers.form.kindFixed')}>
            <Select value={draft.kind} disabled={!creating} onChange={(event) => setDraft({ ...draft, kind: event.target.value as PrinterKind })}>
              {PRINTER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`printers.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('printers.col.relay')} hint={t('printers.form.relayHint')}>
            <Input value={t('printers.relay.FAKE')} readOnly />
          </Field>
          <Field label={t('printers.form.target')} required hint={t('printers.form.targetHint')} error={shown('relayTarget')}>
            <Input value={draft.relayTarget} placeholder="label-printer-1:9100" onChange={(event) => setDraft({ ...draft, relayTarget: event.target.value })} />
          </Field>
          {draft.kind === 'LABEL_ZPL' && (
            <>
              <Field label={t('printers.form.width')} error={shown('labelWidthMm')}>
                <Input inputMode="numeric" value={draft.labelWidthMm} suffix="mm" onChange={(event) => setDraft({ ...draft, labelWidthMm: event.target.value })} />
              </Field>
              <Field label={t('printers.form.height')} error={shown('labelHeightMm')}>
                <Input inputMode="numeric" value={draft.labelHeightMm} suffix="mm" onChange={(event) => setDraft({ ...draft, labelHeightMm: event.target.value })} />
              </Field>
              <Field label={t('printers.form.dpiLabel')} error={shown('dpi')}>
                <Select value={draft.dpi} onChange={(event) => setDraft({ ...draft, dpi: event.target.value })}>
                  {['203', '300', '600'].map((dpi) => (
                    <option key={dpi} value={dpi}>
                      {dpi} dpi
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          {!creating && (
            <Field label={t('org.col.status')} hint={t('printers.form.statusHint')}>
              <Select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as PrinterStatus })}>
                {PRINTER_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(`printers.status.${status}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <p className="fw-adm-hint">{t('printers.form.testLater')}</p>
      </form>
    </Modal>
  )
}

export function RevokeConfirm({ device, busy, problem, onClose, onRevoke }: { device: Device | null; busy: boolean; problem: string | null; onClose: () => void; onRevoke?: (device: Device) => Promise<boolean> }) {
  const t = useT('admin')
  const [typed, setTyped] = useState('')
  useEffect(() => setTyped(''), [device?.id])
  if (!device) return null
  const match = phraseMatches(typed, device.name)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('devices.revoke.title', { name: device.name })}
      size="sm"
      busy={busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={!match ? t('devices.revoke.typeFirst') : busy ? t('common.saving') : null} onClick={() => void onRevoke?.(device)}>
            {t('devices.revoke.go')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {problem && <Banner tone="danger" title={t(problem)} />}
        <p className="fw-adm-intro">{t(device.inUse ? 'devices.revoke.bodyInUse' : 'devices.revoke.body')}</p>
        <Field label={t('devices.revoke.type', { name: device.name })} hint={typed === '' ? t('devices.revoke.hint') : match ? t('devices.revoke.matches') : t('devices.revoke.noMatch')}>
          <Input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && match && void onRevoke?.(device)} />
        </Field>
      </div>
    </Modal>
  )
}
