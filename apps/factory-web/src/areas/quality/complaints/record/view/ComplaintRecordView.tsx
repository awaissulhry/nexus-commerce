'use client'

import { useId, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Link2, MoreHorizontal, Pencil, ScanLine, ShieldAlert, Unlink } from 'lucide-react'
import { Banner, Card, Field, KeyValue, Menu, RecordLayout, type MenuItemDef } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Combobox, EditModeBar, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatNumber } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { Freshness, RecordFrame, Section } from '../../../_shared/parts'
import { COMPLAINT_SEVERITIES, OFFICE_CHANNELS, type Complaint, type ComplaintAction, type ComplaintLinkType, type OfficeChannel } from '../../api'
import { dayAt, evidenceHref, garmentWords, LINK_TYPES, linkSaveHeld, linksHeld, linkTypeHeld, linkTypeKey, personName, primaryAction, recordHref, stepOf, unlinkHeld } from '../../model'
import { AcknowledgeDialog, CategoryTag, ComplaintsMessages, DueText, InstantText, say, SeverityTag, StatusPill, useWords } from '../../view/parts'
import { TriageModal } from '../../view/TriageModal'
import type { ComplaintRecordActions, ComplaintRecordModel, FactsDraft, RecordDialog, RecordTab } from '../view-model'

/**
 * A complaint's record (SCR-113 W2a part; design quality.complaints › Complaint, `?tab=complaint|linked|activity`): the
 * band (‹ Complaints, "CMP-… <summary>", the customer, the category, the status; the primary step by status — Triage,
 * Start investigation, Mark answered, Close — then Create NCR, and ⋯ Add to PPE register, Make a repair, the garment's
 * evidence trail in a new tab, Copy link), the safety alert until the owner acknowledges it, then the tabs: Complaint
 * (the customer's words and photos, what it is about, the triage and the safety state beside them; the facts edited with
 * the EditModeBar), Linked records (NCRs, CAPA, the return, the PPE register entry, shipment, order, the garment and its
 * repairs) and Activity (the record's thread and history). A closed complaint never changes. Fetches nothing.
 */
export function ComplaintRecordView({ model, actions, panels }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions; panels?: ReactNode }) {
  return (
    <ComplaintsMessages>
      <ComplaintRecord model={model} actions={actions} panels={panels} />
    </ComplaintsMessages>
  )
}

function ComplaintRecord({ model, actions, panels }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions; panels?: ReactNode }) {
  const t = useWords()
  const { complaint, prefix } = model
  const tab: RecordTab = model.tab === 'activity' && !panels ? 'complaint' : model.tab
  const base = recordHref(prefix, complaint.id)
  const step = (action: ComplaintAction) => stepOf(complaint, action, model.offline)
  const held = (action: ComplaintAction) => {
    const state = step(action)
    return state.held ? t(state.held) : null
  }
  const primary = primaryAction(complaint.status)
  const evidence = evidenceHref(prefix, complaint.evidence)
  const open = (dialog: RecordDialog) => actions?.onDialog?.(dialog)
  const run = (action: ComplaintAction) => {
    if (action === 'triage') actions?.onTriage?.()
    else if (action === 'startInvestigation' || action === 'reopenInvestigation') open({ kind: 'move', to: 'INVESTIGATING', note: '' })
    else if (action === 'markAnswered') open({ kind: 'move', to: 'ANSWERED', note: '' })
    else if (action === 'close') open({ kind: 'close', reason: '' })
    else if (action === 'acknowledge') open({ kind: 'acknowledge' })
    else if (action === 'register') open({ kind: 'register', risk: complaint.category === 'SAFETY' ? 'ASSESSING' : 'NO' })
    else if (action === 'createNcr') open({ kind: 'ncr', siteId: '', severity: complaint.severity ?? '' })
    else if (action === 'makeRepair') open({ kind: 'repair', siteId: '', received: false })
  }

  const menuStep = (action: ComplaintAction, label: string): MenuItemDef => {
    const reason = held(action)
    return { id: action, label, onSelect: () => run(action), disabled: !!reason, description: reason ?? undefined }
  }
  const moreItems: MenuItemDef[] = [
    menuStep('register', t('action.register')),
    menuStep('makeRepair', t('action.makeRepair')),
    ...(complaint.status === 'ANSWERED' ? [menuStep('reopenInvestigation', t('action.reopenInvestigation'))] : []),
    ...(primary !== 'close' && complaint.status !== 'CLOSED' ? [menuStep('close', t('action.close'))] : []),
    ...(complaint.status !== 'NEW' && complaint.status !== 'CLOSED' ? [menuStep('triage', t('action.retriage'))] : []),
    { id: 'sep', separator: true } as MenuItemDef,
    evidence
      ? { id: 'evidence', label: t('record.evidence'), href: evidence, target: '_blank', icon: <ExternalLink size={14} aria-hidden /> }
      : { id: 'evidence', label: t('record.evidence'), disabled: true, description: t('held.noEvidence') },
    { id: 'link', label: t('record.copyLink'), onSelect: () => actions?.onCopy?.(typeof window === 'undefined' ? base : `${window.location.origin}${base}`) },
    { id: 'number', label: t('row.copy'), onSelect: () => actions?.onCopy?.(complaint.number) },
  ]

  const tabs = [
    { id: 'complaint', label: t('tab.complaint') },
    { id: 'linked', label: t('tab.linked'), count: linkedCount(complaint) },
    ...(panels ? [{ id: 'activity', label: t('tab.activity') }] : []),
  ]

  return (
    <>
      <RecordFrame
        back={{ href: `${prefix}/quality/complaints`, label: t('record.back') }}
        title={
          <>
            <span className="fw-q-code">{complaint.number}</span> · {complaint.summary}
          </>
        }
        meta={
          <span className="fw-q-cell-row">
            <span>{complaint.party.legalName}</span>
            {complaint.customerRef && <span className="fw-q-hint">{t('row.theirRef', { ref: complaint.customerRef })}</span>}
            <Freshness asOf={model.asOf} live={model.live} />
          </span>
        }
        status={
          <span className="fw-q-cell-row">
            <CategoryTag category={complaint.category} />
            <StatusPill status={complaint.status} />
          </span>
        }
        actions={
          <>
            {primary && (
              <Button size="sm" variant="primary" heldReason={held(primary)} onClick={() => run(primary)}>
                {t(`action.${primary}`)}
              </Button>
            )}
            {complaint.status !== 'CLOSED' && (
              <Button size="sm" heldReason={held('createNcr')} onClick={() => run('createNcr')}>
                {t('action.createNcr')}
              </Button>
            )}
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={moreItems} />
          </>
        }
        tabs={tabs}
        active={tab}
        tabHref={(id) => `${base}?tab=${id}`}
        dock={tab === 'activity' ? undefined : panels}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <RecordNotices model={model} actions={actions} held={held} run={run} />
        {tab === 'complaint' && <ComplaintTab model={model} actions={actions} held={held} run={run} />}
        {tab === 'linked' && <LinkedTab model={model} actions={actions} />}
        {tab === 'activity' && panels}
      </RecordFrame>
      <RecordDialogs model={model} actions={actions} />
      {model.triage && <TriageModal model={model.triage} prefix={prefix} actions={actions} />}
    </>
  )
}

const linkedCount = (complaint: Complaint): number =>
  complaint.ncrs.length + complaint.repairs.length + (complaint.register ? 1 : 0) + (complaint.return ? 1 : 0) + (complaint.shipment ? 1 : 0) + (complaint.order ? 1 : 0)

function RecordNotices({ model, actions, held, run }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions; held: (action: ComplaintAction) => string | null; run: (action: ComplaintAction) => void }) {
  const t = useWords()
  const locale = useLocale()
  const complaint = model.complaint
  return (
    <>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        >
          {model.notice.detail ? say(t, model.notice.detail) : null}
        </Banner>
      )}
      {model.offline && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
      {model.changedAt && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatDateTime(model.changedAt, { locale }) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      {complaint.safety.state === 'RAISED' && (
        <Banner
          tone="danger"
          icon={<ShieldAlert size={18} aria-hidden />}
          title={t('record.safetyRaised', { time: formatDateTime(complaint.safety.raisedAt ?? complaint.receivedAt, { locale }) })}
          action={
            <Button size="sm" variant="primary" heldReason={held('acknowledge')} onClick={() => run('acknowledge')}>
              {t('banner.acknowledge')}
            </Button>
          }
        >
          {t('record.safetyRaisedBody')}
        </Banner>
      )}
      {complaint.status === 'CLOSED' && (
        <Banner tone="info" title={t('record.closed', { day: complaint.closedAt ? formatDate(complaint.closedAt, { locale }) : '—' })}>
          {complaint.closeReason}
        </Banner>
      )}
    </>
  )
}

// ---- the Complaint tab -----------------------------------------------------------------------------------------------------

function ComplaintTab({ model, actions, held, run }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions; held: (action: ComplaintAction) => string | null; run: (action: ComplaintAction) => void }) {
  const t = useWords()
  const locale = useLocale()
  const complaint = model.complaint
  const editHeld = held('edit')
  const edit = model.edit
  return (
    <RecordLayout
      asideLabel={t('record.asideLabel')}
      main={
        <div className="fw-q-stack">
          <Section
            id="cmp-words"
            title={t('record.words')}
            sub={t('record.wordsSub', { channel: t(`channel.${complaint.channel}`), time: formatDateTime(complaint.receivedAt, { locale }) })}
            actions={
              edit ? undefined : (
                <Button size="sm" heldReason={editHeld} onClick={() => actions?.onEdit?.(true)}>
                  <Pencil size={13} aria-hidden /> {t('record.edit')}
                </Button>
              )
            }
          >
            {edit ? <FactsForm model={model} actions={actions} /> : <p className="fw-cmp-words">{complaint.description}</p>}
          </Section>
          <Section id="cmp-photos" title={t('photos.title', { count: model.photos.length })} sub={model.can.filesRead ? undefined : t('photos.noRight')}>
            {model.photos.length === 0 ? (
              <p className="fw-q-hint">{t('photos.none')}</p>
            ) : (
              <div className="fw-cmp-photos" role="list" aria-label={t('photos.label', { count: model.photos.length })}>
                {model.photos.map((photo, at) =>
                  photo.src ? (
                    <a key={photo.id} role="listitem" className="fw-cmp-photo" href={photo.src} target="_blank" rel="noreferrer" aria-label={t('photos.open', { n: at + 1 })}>
                      <img src={photo.src} alt={t('photos.alt', { n: at + 1 })} />
                    </a>
                  ) : (
                    <span key={photo.id} role="listitem" className="fw-q-hint">
                      {t('photos.unread', { name: photo.name })}
                    </span>
                  ),
                )}
              </div>
            )}
            <p className="fw-q-hint">{t('photos.addInActivity')}</p>
            <p className="fw-q-hint">{t('mail.intoThread', { number: complaint.number })}</p>
          </Section>
          {!edit && (
            <Section id="cmp-about" title={t('record.about')}>
              <KeyValue
                columns={2}
                labelCase="sentence"
                items={[
                  { label: t('field.customer'), value: complaint.party.legalName, hint: complaint.contact ? `${complaint.contact.name}${complaint.contact.email ? ` · ${complaint.contact.email}` : ''}` : complaint.party.code },
                  { label: t('field.customerRef'), value: complaint.customerRef ?? '—' },
                  { label: t('field.order'), value: complaint.order ? <DocLink href={model.hrefs[`SalesOrder:${complaint.order.id}`]} label={complaint.order.number} /> : '—', hint: orderValue(complaint, model.can.price, locale, t) },
                  { label: t('field.shipment'), value: complaint.shipment ? <DocLink href={model.hrefs[`Shipment:${complaint.shipment.id}`]} label={complaint.shipment.number} /> : '—' },
                  { label: t('field.return'), value: complaint.return?.number ?? '—' },
                  { label: t('field.style'), value: complaint.style ? `${complaint.style.code} · ${complaint.style.name}` : '—', hint: complaint.size ? t('field.sizeValue', { size: complaint.size }) : undefined },
                  { label: t('field.garment'), value: say(t, garmentWords(complaint)) || '—', hint: complaint.garment ? t('garment.found', { day: formatDate(dayAt(complaint.garment.madeOn), { locale }), workOrder: complaint.garment.workOrderNumber, batch: complaint.garment.batchNumber ?? '—' }) : complaint.serial ? t('garment.unknownSerial') : undefined },
                  {
                    label: t('field.evidence'),
                    value: evidenceHref(model.prefix, complaint.evidence) ? (
                      <a className="fw-q-link" href={evidenceHref(model.prefix, complaint.evidence)!} target="_blank" rel="noreferrer">
                        <ExternalLink size={13} aria-hidden /> {t('record.evidence')}
                      </a>
                    ) : (
                      t('held.noEvidence')
                    ),
                  },
                ]}
              />
              {complaint.garment && !complaint.garment.forThisCustomer && <Banner tone="warning" title={t('garment.otherCustomer')} />}
              {complaint.internalNote && (
                <p className="fw-q-hint">
                  <strong>{t('record.internalNote')}</strong> {complaint.internalNote}
                </p>
              )}
            </Section>
          )}
        </div>
      }
      aside={<StatusAside model={model} held={held} run={run} />}
    />
  )
}

function orderValue(complaint: Complaint, price: boolean, locale: ReturnType<typeof useLocale>, t: ReturnType<typeof useWords>): string | undefined {
  if (!complaint.order) return undefined
  if (!price || complaint.order.netAmount === undefined) return t('record.valueNoGrain')
  return t('record.orderValue', { value: formatNumber(complaint.order.netAmount / 100, locale, { style: 'currency', currency: complaint.order.currency }) })
}

function DocLink({ href, label }: { href: string | undefined; label: string }) {
  if (!href) return <span className="fw-q-code">{label}</span>
  return (
    <Link className="fw-q-link fw-q-code" href={href}>
      {label}
    </Link>
  )
}

function StatusAside({ model, held, run }: { model: ComplaintRecordModel; held: (action: ComplaintAction) => string | null; run: (action: ComplaintAction) => void }) {
  const t = useWords()
  const complaint = model.complaint
  const owner = personName(complaint.people, complaint.ownerId)
  const acknowledgedBy = personName(complaint.people, complaint.safety.acknowledgedById)
  return (
    <div className="fw-cmp-aside">
      <Card padded>
        <div className="fw-q-stack">
          <h2 className="fw-cmp-h3">{t('record.triage')}</h2>
          {complaint.status === 'NEW' ? (
            <>
              <p className="fw-q-hint">{t('record.notTriaged')}</p>
              <Button size="sm" variant="primary" heldReason={held('triage')} onClick={() => run('triage')}>
                {t('action.triage')}
              </Button>
            </>
          ) : (
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('field.status'), value: <StatusPill status={complaint.status} /> },
                { label: t('field.category'), value: <CategoryTag category={complaint.category} /> },
                { label: t('field.severity'), value: <SeverityTag severity={complaint.severity} /> },
                { label: t('field.owner'), value: owner ?? '—' },
                { label: t('field.answerDue'), value: <DueText row={complaint} today={model.today} /> },
                { label: t('field.triaged'), value: <InstantText value={complaint.triagedAt} />, hint: personName(complaint.people, complaint.triagedById) ?? undefined },
                ...(complaint.answeredAt ? [{ label: t('field.answered'), value: <InstantText value={complaint.answeredAt} /> }] : []),
              ]}
            />
          )}
        </div>
      </Card>
      <Card padded>
        <div className="fw-q-stack">
          <h2 className="fw-cmp-h3">{t('record.safety')}</h2>
          <p className="fw-q-hint">{t(`safetyState.${complaint.safety.state}`, { name: acknowledgedBy ?? '—' })}</p>
          {complaint.safety.state !== 'NONE' && (
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('field.raised'), value: <InstantText value={complaint.safety.raisedAt} /> },
                { label: t('field.acknowledged'), value: <InstantText value={complaint.safety.acknowledgedAt} />, hint: acknowledgedBy ?? undefined },
              ]}
            />
          )}
          {complaint.safety.state === 'RAISED' && (
            <Button size="sm" variant="primary" heldReason={held('acknowledge')} onClick={() => run('acknowledge')}>
              {t('banner.acknowledge')}
            </Button>
          )}
        </div>
      </Card>
      <Card padded>
        <div className="fw-q-stack">
          <h2 className="fw-cmp-h3">{t('record.register')}</h2>
          {complaint.register ? (
            <Link className="fw-q-link fw-q-code" href={`${model.prefix}/compliance/register/${encodeURIComponent(complaint.register.id)}`}>
              {complaint.register.reference} · {t(`risk.${complaint.register.risk}`)}
            </Link>
          ) : (
            <>
              <p className="fw-q-hint">{model.can.registerView ? t('record.notInRegister') : t('record.registerNoRight')}</p>
              {complaint.status !== 'CLOSED' && (
                <Button size="sm" heldReason={held('register')} onClick={() => run('register')}>
                  {t('action.register')}
                </Button>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  )
}

function FactsForm({ model, actions }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions }) {
  const t = useWords()
  const edit = model.edit!
  const draft = edit.draft
  const set = (patch: Partial<FactsDraft>) => actions?.onEditDraft?.(patch)
  const ids = { words: useId(), ref: useId(), channel: useId(), style: useId(), size: useId(), serial: useId(), batch: useId(), note: useId() }
  const complaint = model.complaint
  const changed =
    draft.description.trim() !== complaint.description ||
    draft.customerRef.trim() !== (complaint.customerRef ?? '') ||
    (draft.channel !== '' && draft.channel !== complaint.channel) ||
    draft.styleId !== (complaint.style?.id ?? '') ||
    draft.size.trim() !== (complaint.size ?? '') ||
    draft.serial.trim() !== (complaint.serial ?? '') ||
    draft.batchNumber.trim() !== (complaint.batchNumber ?? '') ||
    draft.internalNote.trim() !== (complaint.internalNote ?? '')
  const applyHeld = !draft.description.trim() ? t('record.editWordsRequired') : !changed ? t('record.editNothing') : edit.busy ? t('common.working') : model.offline ? t('held.offline') : null
  return (
    <div className="fw-q-stack">
      {edit.problem && <Banner tone="danger" title={t(edit.problem)} />}
      <Field label={t('log.words')} required htmlFor={ids.words}>
        <Textarea id={ids.words} rows={5} value={draft.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <div className="fw-q-form-three">
        <Field label={t('log.ref')} htmlFor={ids.ref}>
          <Input id={ids.ref} value={draft.customerRef} onChange={(event) => set({ customerRef: event.target.value })} />
        </Field>
        <Field label={t('log.channel')} htmlFor={ids.channel}>
          <Select id={ids.channel} value={draft.channel} onChange={(event) => set({ channel: event.target.value as OfficeChannel })}>
            {draft.channel === '' && <option value="">{t(`channel.${complaint.channel}`)}</option>}
            {OFFICE_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {t(`channel.${channel}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.style')} hint={model.styles === null ? t('triage.styleNoList') : undefined} htmlFor={ids.style}>
          <Select id={ids.style} value={draft.styleId} onChange={(event) => set({ styleId: event.target.value })} disabled={model.styles === null}>
            <option value="">{t('log.none')}</option>
            {complaint.style && !(model.styles ?? []).some((style) => style.id === complaint.style!.id) && <option value={complaint.style.id}>{`${complaint.style.code} · ${complaint.style.name}`}</option>}
            {(model.styles ?? []).map((style) => (
              <option key={style.id} value={style.id}>
                {`${style.code} · ${style.name}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.size')} htmlFor={ids.size}>
          <Input id={ids.size} value={draft.size} onChange={(event) => set({ size: event.target.value })} />
        </Field>
        <Field label={t('log.serial')} htmlFor={ids.serial}>
          <Input id={ids.serial} value={draft.serial} onChange={(event) => set({ serial: event.target.value })} />
        </Field>
        <Field label={t('field.batch')} htmlFor={ids.batch}>
          <Input id={ids.batch} value={draft.batchNumber} onChange={(event) => set({ batchNumber: event.target.value })} />
        </Field>
      </div>
      <Field label={t('log.note')} hint={t('log.noteHint')} htmlFor={ids.note}>
        <Textarea id={ids.note} rows={2} value={draft.internalNote} onChange={(event) => set({ internalNote: event.target.value })} />
      </Field>
      <EditModeBar
        message={changed ? t('record.editUnsaved') : t('record.editNothing')}
        count={changed ? 1 : 0}
        onDiscard={() => actions?.onEdit?.(false)}
        onApply={() => actions?.onEditSave?.()}
        applyLabel={t('record.editSave')}
        busy={edit.busy}
        applyHeldReason={applyHeld}
        saveShortcut
      />
    </div>
  )
}

// ---- Linked records ---------------------------------------------------------------------------------------------------------

function LinkedTab({ model, actions }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions }) {
  const t = useWords()
  const complaint = model.complaint
  const prefix = model.prefix
  // B-W2b-17 (design cmp-links "Link… / Unlink"): Link… for the complaint's facts and NCRs; Unlink on each linked one.
  const linkHeldKey = linksHeld(complaint, model.can, model.offline)
  const unlink = (type: ComplaintLinkType, recordId: string, label: string) => {
    const reason = unlinkHeld(complaint, type, model.can, { raisedFrom: type === 'Nonconformance' && (model.raisedFrom ?? []).includes(recordId), offline: model.offline })
    return (
      <Button size="xs" variant="ghost" heldReason={reason ? t(reason) : null} onClick={() => actions?.onDialog?.({ kind: 'unlink', type, recordId, label })} aria-label={t('links.unlinkOf', { label })}>
        <Unlink size={13} aria-hidden /> {t('links.unlink')}
      </Button>
    )
  }
  const withUnlink = (node: ReactNode, type: ComplaintLinkType, recordId: string, label: string) =>
    complaint.status === 'CLOSED' ? (
      node
    ) : (
      <span className="fw-cmp-link-row">
        {node}
        {unlink(type, recordId, label)}
      </span>
    )
  const group = (id: string, title: string, items: readonly { key: string; node: ReactNode }[], empty: string) => (
    <section key={id} className="fw-cmp-link-group" aria-labelledby={`cmp-links-${id}`}>
      <h3 className="fw-cmp-h3" id={`cmp-links-${id}`}>
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="fw-q-hint">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.key}>{item.node}</li>
          ))}
        </ul>
      )}
    </section>
  )
  const link = (href: string, label: string, sub?: string) => (
    <span className="fw-q-cell-row">
      <Link className="fw-q-link fw-q-code" href={href}>
        {label}
      </Link>
      {sub && <span className="fw-q-hint">{sub}</span>}
    </span>
  )
  const evidence = evidenceHref(prefix, complaint.evidence)
  const href = (type: string, id: string) => model.hrefs[`${type}:${id}`] ?? `${prefix}/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
  return (
    <Card padded>
      <div className="fw-cmp-links-head">
        <p className="fw-q-hint">{t(complaint.status === 'CLOSED' ? 'links.closed' : 'links.intro')}</p>
        {complaint.status !== 'CLOSED' && (
          <Button size="sm" heldReason={linkHeldKey ? t(linkHeldKey) : null} onClick={() => actions?.onDialog?.({ kind: 'link', type: '', recordId: '', serial: '' })}>
            <Link2 size={14} aria-hidden /> {t('links.link')}
          </Button>
        )}
      </div>
      <div className="fw-cmp-links">
        {group(
          'ncr',
          t('linked.ncr'),
          complaint.ncrs.map((ncr) => ({ key: ncr.id, node: withUnlink(link(href('Nonconformance', ncr.id), ncr.number, (model.raisedFrom ?? []).includes(ncr.id) ? `${t(`linked.stage.${ncr.stage}`)} · ${t('links.raisedFrom')}` : t(`linked.stage.${ncr.stage}`)), 'Nonconformance', ncr.id, ncr.number) })),
          model.can.ncrView ? t('linked.ncrNone') : t('linked.ncrNoRight'),
        )}
        {group('capa', t('linked.capa'), [], t('linked.capaLater'))}
        {group(
          'register',
          t('linked.register'),
          complaint.register ? [{ key: complaint.register.id, node: link(`${prefix}/compliance/register/${encodeURIComponent(complaint.register.id)}`, complaint.register.reference, t(`risk.${complaint.register.risk}`)) }] : [],
          model.can.registerView ? t('record.notInRegister') : t('record.registerNoRight'),
        )}
        {group(
          'return',
          t('linked.return'),
          complaint.return ? [{ key: complaint.return.id, node: withUnlink(link(href('ReturnAuthorisation', complaint.return.id), complaint.return.number), 'ReturnAuthorisation', complaint.return.id, complaint.return.number) }] : [],
          t('linked.none'),
        )}
        {group(
          'shipment',
          t('linked.shipment'),
          complaint.shipment ? [{ key: complaint.shipment.id, node: withUnlink(link(href('Shipment', complaint.shipment.id), complaint.shipment.number), 'Shipment', complaint.shipment.id, complaint.shipment.number) }] : [],
          t('linked.none'),
        )}
        {group(
          'order',
          t('linked.order'),
          complaint.order ? [{ key: complaint.order.id, node: withUnlink(link(href('SalesOrder', complaint.order.id), complaint.order.number), 'SalesOrder', complaint.order.id, complaint.order.number) }] : [],
          t('linked.none'),
        )}
        {group(
          'garment',
          t('linked.garment'),
          evidence || complaint.serial
            ? [
                {
                  key: 'evidence',
                  node: (() => {
                    const words = say(t, garmentWords(complaint))
                    const node = evidence ? (
                      <a className="fw-q-link" href={evidence} target="_blank" rel="noreferrer">
                        <ExternalLink size={13} aria-hidden /> {words}
                      </a>
                    ) : (
                      <span>{words}</span>
                    )
                    // The garment's serial is unlinked by name (the facts' serial; its id is not on the complaint).
                    return complaint.serial ? withUnlink(node, 'GarmentSerial', '', complaint.serial) : node
                  })(),
                },
              ]
            : [],
          t('held.noEvidence'),
        )}
        {group(
          'repairs',
          t('linked.repairs'),
          complaint.repairs.map((repair) => ({ key: repair.id, node: link(href('RepairOrder', repair.id), repair.number, t(`linked.repairStage.${repair.stage}`)) })),
          model.can.repairsView ? t('linked.repairsNone') : t('linked.repairsNoRight'),
        )}
      </div>
    </Card>
  )
}

// ---- the dialogs ------------------------------------------------------------------------------------------------------------

function RecordDialogs({ model, actions }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions }) {
  const t = useWords()
  const dialog = model.dialog
  const ids = { note: useId(), reason: useId(), risk: useId(), site: useId(), severity: useId() }
  const close = () => actions?.onDialog?.(null)
  if (!dialog) return null
  if (dialog.kind === 'acknowledge')
    return <AcknowledgeDialog open number={model.complaint.number} busy={model.dialogBusy} problem={model.dialogProblem} onConfirm={(note) => actions?.onDialogSubmit?.(note)} onClose={close} />
  const busy = model.dialogBusy ? t('common.working') : model.offline ? t('held.offline') : null
  let title = ''
  let body: ReactNode = null
  let held: string | null = busy
  let confirm = ''
  if (dialog.kind === 'move') {
    title = t(dialog.to === 'ANSWERED' ? 'move.answeredTitle' : model.complaint.status === 'ANSWERED' ? 'move.reopenTitle' : 'move.investigateTitle', { number: model.complaint.number })
    confirm = t(dialog.to === 'ANSWERED' ? 'action.markAnswered' : model.complaint.status === 'ANSWERED' ? 'action.reopenInvestigation' : 'action.startInvestigation')
    body = (
      <>
        <p className="fw-q-intro">{t(dialog.to === 'ANSWERED' ? 'move.answeredBody' : 'move.investigateBody')}</p>
        <Field label={t('move.note')} hint={t(dialog.to === 'ANSWERED' ? 'move.answeredNoteHint' : 'move.noteHint')} htmlFor={ids.note}>
          <Textarea id={ids.note} rows={3} value={dialog.note} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
        </Field>
      </>
    )
  } else if (dialog.kind === 'close') {
    title = t('closeDialog.title', { number: model.complaint.number })
    confirm = t('action.close')
    held = held ?? (dialog.reason.trim() ? null : t('closeDialog.reasonRequired'))
    body = (
      <>
        <p className="fw-q-intro">{t('closeDialog.body')}</p>
        <Field label={t('closeDialog.reason')} required hint={t('closeDialog.reasonHint')} htmlFor={ids.reason}>
          <Textarea id={ids.reason} rows={3} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
        </Field>
      </>
    )
  } else if (dialog.kind === 'link') {
    title = t('links.title', { number: model.complaint.number })
    confirm = t('links.save')
    const saveHeld = linkSaveHeld(model.complaint, dialog, model.can)
    held = held ?? (saveHeld ? t(saveHeld.key, saveHeld.params) : null)
    body = <LinkBody model={model} actions={actions} dialog={dialog} />
  } else if (dialog.kind === 'unlink') {
    title = t('links.unlinkTitle', { label: dialog.label })
    confirm = t('links.unlink')
    body = <p className="fw-q-intro">{t(`links.unlinkBody.${dialog.type}`, { label: dialog.label, number: model.complaint.number })}</p>
  } else if (dialog.kind === 'register') {
    title = t('registerDialog.title', { number: model.complaint.number })
    confirm = t('action.register')
    body = (
      <>
        <p className="fw-q-intro">{t('registerDialog.body', { style: model.complaint.style ? `${model.complaint.style.code} · ${model.complaint.style.name}` : '—' })}</p>
        <Field label={t('triage.risk')} hint={t('registerDialog.riskHint')} htmlFor={ids.risk}>
          <Select id={ids.risk} value={dialog.risk} onChange={(event) => actions?.onDialog?.({ ...dialog, risk: event.target.value as 'NO' | 'ASSESSING' | 'YES' })}>
            {(['NO', 'ASSESSING', 'YES'] as const).map((risk) => (
              <option key={risk} value={risk}>
                {t(`risk.${risk}`)}
              </option>
            ))}
          </Select>
        </Field>
      </>
    )
  } else {
    const ncr = dialog.kind === 'ncr'
    title = t(ncr ? 'ncrDialog.title' : 'repairDialog.title', { number: model.complaint.number })
    confirm = t(ncr ? 'action.createNcr' : 'action.makeRepair')
    const siteFromShipment = ncr && !!model.complaint.shipment
    held = held ?? (ncr && dialog.kind === 'ncr' && !dialog.severity ? t('ncrDialog.severityRequired') : null)
    body = (
      <>
        <p className="fw-q-intro">{t(ncr ? 'ncrDialog.body' : 'repairDialog.body')}</p>
        <Field
          label={t('dialog.site')}
          hint={siteFromShipment ? t('ncrDialog.siteFromShipment') : model.sites === null ? t('dialog.siteNoList') : t(ncr ? 'ncrDialog.siteHint' : 'repairDialog.siteHint')}
          htmlFor={ids.site}
        >
          <Select id={ids.site} value={dialog.siteId} onChange={(event) => actions?.onDialog?.({ ...dialog, siteId: event.target.value })} disabled={model.sites === null}>
            <option value="">{siteFromShipment || !ncr ? t('dialog.siteDefault') : t('triage.choose')}</option>
            {(model.sites ?? []).map((site) => (
              <option key={site.id} value={site.id}>
                {`${site.code} · ${site.name}`}
              </option>
            ))}
          </Select>
        </Field>
        {dialog.kind === 'ncr' && (
          <Field label={t('triage.severity')} required htmlFor={ids.severity}>
            <Select id={ids.severity} value={dialog.severity} onChange={(event) => actions?.onDialog?.({ ...dialog, severity: event.target.value as typeof dialog.severity })}>
              <option value="">{t('triage.choose')}</option>
              {COMPLAINT_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {t(`severity.${severity}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {dialog.kind === 'repair' && (
          <Checkbox checked={dialog.received} onChange={(event) => actions?.onDialog?.({ ...dialog, received: event.target.checked })} label={t('repairDialog.received')} />
        )}
      </>
    )
  }
  return (
    <Modal
      open
      onClose={close}
      title={title}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDialogSubmit?.()}>
            {model.dialogBusy ? <Spinner size={12} /> : null} {confirm}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        {body}
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
      </div>
    </Modal>
  )
}

// ---- B-W2b-17: Link… (design cmp-links) --------------------------------------------------------------------------------------

function LinkBody({ model, actions, dialog }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions; dialog: Extract<RecordDialog, { kind: 'link' }> }) {
  const t = useWords()
  const ids = { type: useId(), record: useId(), serial: useId() }
  const set = (patch: Partial<Extract<RecordDialog, { kind: 'link' }>>) => actions?.onDialog?.({ ...dialog, ...patch })
  const options = model.linkOptions && model.linkOptions.type === dialog.type ? model.linkOptions : null
  const named = (type: ComplaintLinkType): string | null => {
    const complaint = model.complaint
    if (type === 'SalesOrder') return complaint.order?.number ?? null
    if (type === 'Shipment') return complaint.shipment?.number ?? null
    if (type === 'ReturnAuthorisation') return complaint.return?.number ?? null
    if (type === 'GarmentSerial') return complaint.serial
    return null
  }
  return (
    <>
      <p className="fw-q-intro">{t('links.body')}</p>
      <Field label={<span id={`${ids.type}-label`}>{t('links.what')}</span>} required>
        <div role="radiogroup" aria-labelledby={`${ids.type}-label`} className="fw-cmp-link-types">
          {LINK_TYPES.map((type) => {
            const reason = linkTypeHeld(type, model.can)
            const already = named(type)
            return (
              <RadioCard
                key={type}
                variant="row"
                name={ids.type}
                value={type}
                checked={dialog.type === type}
                selected={dialog.type === type}
                disabled={!!reason}
                onChange={() => set({ type, recordId: '', serial: '' })}
                title={t(linkTypeKey(type))}
                description={reason ? t(reason) : already ? t('links.namedAlready', { label: already }) : t(`links.typeHint.${type}`)}
              />
            )
          })}
        </div>
      </Field>
      {dialog.type === 'GarmentSerial' && (
        <Field label={t('links.serial')} hint={t('links.serialHint')} htmlFor={ids.serial} required>
          <Input id={ids.serial} value={dialog.serial} leadingIcon={<ScanLine size={14} aria-hidden />} onChange={(event) => set({ serial: event.target.value })} autoComplete="off" />
        </Field>
      )}
      {dialog.type !== '' && dialog.type !== 'GarmentSerial' && (
        <Field
          label={<span id={`${ids.record}-label`}>{t(`links.pick.${dialog.type}`)}</span>}
          required
          hint={options === null ? t('links.reading') : options.problem ? undefined : options.items && options.items.length === 0 ? t(`links.noneToPick.${dialog.type}`) : t(`links.pickHint.${dialog.type}`)}
          error={options?.problem ? t(options.problem) : undefined}
        >
          {options?.items && options.items.length > 0 ? (
            <Combobox
              options={options.items.map((item) => ({ value: item.id, label: item.sub ? `${item.label} · ${item.sub}` : item.label }))}
              value={dialog.recordId}
              onChange={(value) => set({ recordId: value })}
              placeholder={t('links.search')}
              labelledBy={`${ids.record}-label`}
            />
          ) : (
            <Input disabled value="" readOnly aria-labelledby={`${ids.record}-label`} />
          )}
        </Field>
      )}
    </>
  )
}
