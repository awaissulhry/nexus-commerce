'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { FileText, Home, Settings, ShoppingCart } from 'lucide-react'
import { Card, Field } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { Button, Input } from '@nexus/ui/primitives'
import { densityAttrs } from '@nexus/ui/tokens/density'
import { brandingAttrs, brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import { SizeGridEditor, type SizeGridColour, type SizeGridSize } from '@nexus/ui/grid/size-grid/index'
import { BottomBar, type BottomBarLinkProps } from '@nexus/ui/components/BottomBar/index'
import type { AreaNav } from '@nexus/ui/patterns/shell/area-nav'
import { EndState } from '@nexus/ui/components/EndState/index'
import { CodeInput } from '@nexus/ui/components/CodeInput/index'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { MilestoneTracker, type MilestoneStep } from '@nexus/ui/components/MilestoneTracker/index'
import { PaymentPanel, type PaymentState } from '@nexus/ui/components/PaymentPanel/index'
import { ActionList, type ActionGroup } from '@nexus/ui/patterns/ActionList/index'
import { PartnerThread, type PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { LineResponseList, lineResponseOutcome, type LineDraft, type LineRequest } from '@nexus/ui/patterns/LineResponseList/index'
import { PortalActionBar } from '@nexus/ui/patterns/PortalActionBar/index'
import { WithMessages } from '../../../../record-panels/i18n'
import { Modal } from '../../../i18n/ds-parts'
import { useDsLabels } from '../../../i18n/ds-labels'
import { formatDate } from '../../../i18n/format'
import { INTL_LOCALE, type Locale } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import { sizeGridCopy } from '../../../../areas/production/_shared/grid-copy'
import './ds-portal-lab.css'

/**
 * The portal and link parts lab (`/design/ds-portal-parts`, B-W2b-155): every part this step put in the design system,
 * drawn with the `ds-words` catalogue as their `labels` in the gallery's language, at the portal's comfortable density,
 * unbranded or inside a branded subtree with `brandPortals` on (so the pop-ups take the brand too). In the browser each
 * part works for real: type the demo code, ask for a new link, confirm and undo, sign in the sheet, answer the PO lines,
 * post in the conversation, pay with the test provider, step the sizes. Made-up data only.
 */
export interface DsPortalLabModel {
  /** One group alone, or every part. */
  show?: 'all' | 'end' | 'code' | 'refs' | 'actions' | 'lines' | 'thread' | 'pay' | 'sizes' | 'popups' | 'bar'
  /** Inside a branded subtree, with the brand on `<body>` for the pop-ups. */
  brand?: boolean
  end?: 'accepted' | 'dead' | 'error'
  code?: 'idle' | 'wrong' | 'locked'
  actions?: 'some' | 'empty'
  lines?: 'edit' | 'answered'
  thread?: 'ready' | 'readonly' | 'error'
  pay?: 'idle' | 'waiting' | 'failed' | 'held'
  /** The pop-up starts open. */
  sheet?: boolean
  /** The phone action bar: ready or held. */
  bar?: 'ready' | 'held'
}

/** A fictional partner brand: a burgundy that passes every pair in light, and a light pink for dark. */
const BRAND = checkBranding({ name: 'Atelier Demo', accent: '#7a1f3d', accentDark: '#f2a7bb' })
const DEMO_CODE = '135790'
const TODAY = '2026-11-07'
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function DsPortalLab({ model }: { model: DsPortalLabModel }) {
  return (
    <WithMessages namespaces={['ds-words', 'ds-portal-lab', 'production']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card padded header={title} className="fw-dpl-card">
      {children}
    </Card>
  )
}

function Lab({ model }: { model: DsPortalLabModel }) {
  const t = useT('ds-portal-lab')
  const show = model.show ?? 'all'
  const on = (group: NonNullable<DsPortalLabModel['show']>) => show === 'all' || show === group
  // D24: a branded screen puts the brand on <body> while it is shown, so every pop-up draws it too.
  useEffect(() => (model.brand ? brandPortals(BRAND) : undefined), [model.brand])
  const body = (
    <main id="main-content" className="fw-dpl" {...densityAttrs('comfortable')}>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {model.brand ? (
        <p className="fw-dpl-brand">
          <strong>{t('brandName')}</strong> <span>{t('brandLine', { name: BRAND.name })}</span>
        </p>
      ) : null}
      <div className="fw-dpl-grid">
        {on('end') ? (
          <Section title={t('section.end')}>
            <EndStates model={model} single={show === 'end'} />
          </Section>
        ) : null}
        {on('code') ? (
          <Section title={t('section.code')}>
            <CodeLab model={model} />
          </Section>
        ) : null}
        {on('refs') ? (
          <Section title={t('section.refs')}>
            <RefsLab />
          </Section>
        ) : null}
        {on('actions') ? (
          <Section title={t('section.actions')}>
            <ActionsLab model={model} />
          </Section>
        ) : null}
        {on('lines') ? (
          <div className="fw-dpl-span">
            <Section title={t('section.lines')}>
              <LinesLab model={model} />
            </Section>
          </div>
        ) : null}
        {on('thread') ? (
          <Section title={t('section.thread')}>
            <ThreadLab model={model} />
          </Section>
        ) : null}
        {on('pay') ? (
          <Section title={t('section.pay')}>
            <PayLab model={model} />
          </Section>
        ) : null}
        {on('sizes') ? (
          <Section title={t('section.sizes')}>
            <SizesLab />
          </Section>
        ) : null}
        {on('popups') ? (
          <Section title={t('section.popups')}>
            <PopupLab model={model} />
          </Section>
        ) : null}
        {show === 'bar' ? (
          <div className="fw-dpl-span">
            <Section title={t('section.bar')}>
              <BarLab model={model} />
            </Section>
          </div>
        ) : null}
      </div>
    </main>
  )
  return model.brand ? <div {...brandingAttrs(BRAND)}>{body}</div> : body
}

/* ── end states ─────────────────────────────────────────────────────────────────────────────── */

function EndStates({ model, single }: { model: DsPortalLabModel; single: boolean }) {
  const t = useT('ds-portal-lab')
  const ds = useDsLabels()
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(false)
  const contact = { name: 'Marco Demo', detail: t('end.contactDetail'), email: 'marco@factory.example', phone: '+39 0721 000 000' }
  const which = model.end
  const accepted = (
    <EndState
      tone="success"
      title={t('end.acceptedTitle')}
      body={t('end.acceptedBody')}
      next={[t('end.next1'), t('end.next2')]}
      facts={[
        { label: t('end.acceptedBy'), value: 'Anna Rossi' },
        { label: t('end.acceptedAt'), value: '07/11/2026, 10:42' },
        { label: t('end.document'), value: 'Q-2026-0042' },
        { label: t('end.terms'), value: t('end.termsValue') },
      ]}
      reference={{ value: 'Q-2026-0042' }}
      copy={{ href: '#your-copy', fileName: 'Q-2026-0042.pdf' }}
      actions={[{ label: t('end.portal'), href: '#portal', variant: 'primary' }]}
      contact={contact}
      focusOnMount={single}
      labels={ds.endState}
    />
  )
  const dead = (
    <EndState
      tone="neutral"
      title={t('end.deadTitle')}
      body={asked ? t('end.askedBody') : t('end.deadBody')}
      actions={[
        {
          label: t('end.ask'),
          variant: 'primary',
          busy,
          done: asked ? t('end.asked') : null,
          onClick: () => {
            setBusy(true)
            void wait(600).then(() => {
              setBusy(false)
              setAsked(true)
            })
          },
        },
      ]}
      contact={{ name: 'Pelletteria Demo', email: 'info@factory.example' }}
      focusOnMount={single}
      labels={ds.endState}
    />
  )
  const error = (
    <EndState tone="danger" title={t('end.errorTitle')} body={t('end.errorBody')} actions={[{ label: t('end.retry'), onClick: () => {} }]} contact={contact} focusOnMount={single} labels={ds.endState} />
  )
  if (which === 'accepted') return accepted
  if (which === 'dead') return dead
  if (which === 'error') return error
  return (
    <div className="fw-dpl-stack">
      {accepted}
      {dead}
    </div>
  )
}

/* ── sign-in code ───────────────────────────────────────────────────────────────────────────── */

function CodeLab({ model }: { model: DsPortalLabModel }) {
  const t = useT('ds-portal-lab')
  const ds = useDsLabels()
  const start = model.code ?? 'idle'
  const [code, setCode] = useState(start === 'wrong' ? '111111' : '')
  const [tries, setTries] = useState(start === 'wrong' ? 1 : start === 'locked' ? 0 : 3)
  const [wrong, setWrong] = useState(start === 'wrong')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)
  const [resendAt, setResendAt] = useState<number | null>(null)
  const [resending, setResending] = useState(false)
  const [sent, setSent] = useState(false)
  useEffect(() => setResendAt(Date.now() + 30_000), [])
  const check = (value: string) => {
    setBusy(true)
    setWrong(false)
    void wait(700).then(() => {
      setBusy(false)
      if (value === DEMO_CODE) setOk(true)
      else {
        setWrong(true)
        setTries((n) => Math.max(0, n - 1))
      }
    })
  }
  return (
    <div className="fw-dpl-stack">
      <p className="fw-dpl-note">{t('code.demo')}</p>
      <CodeInput
        value={code}
        onChange={(value) => {
          setCode(value)
          if (wrong) setWrong(false)
        }}
        onComplete={check}
        label={t('code.label')}
        hint={t('code.hint')}
        error={wrong ? t('code.wrong') : null}
        triesLeft={wrong || tries < 3 ? tries : null}
        heldReason={tries <= 0 ? t('code.locked') : null}
        busy={busy}
        resend={{
          availableAt: resendAt,
          busy: resending,
          sent,
          onResend: () => {
            setResending(true)
            void wait(600).then(() => {
              setResending(false)
              setSent(true)
              setTries(3)
              setWrong(false)
              setCode('')
              setResendAt(Date.now() + 30_000)
            })
          },
        }}
        labels={ds.codeInput}
        countdownLabels={ds.countdown}
      />
      {ok ? (
        <p className="fw-dpl-ok" role="status">
          {t('code.ok')}{' '}
          <Button
            size="sm"
            variant="link"
            onClick={() => {
              setOk(false)
              setCode('')
            }}
          >
            {t('code.again')}
          </Button>
        </p>
      ) : null}
    </div>
  )
}

/* ── references and progress ────────────────────────────────────────────────────────────────── */

function RefsLab() {
  const t = useT('ds-portal-lab')
  const ds = useDsLabels()
  const [search, setSearch] = useState('4500')
  const order: MilestoneStep[] = [
    { id: 'REQUESTED', label: t('refs.requested'), state: 'done', date: '28/10' },
    { id: 'CONFIRMED', label: t('refs.confirmed'), state: 'done', date: '30/10' },
    { id: 'IN_PRODUCTION', label: t('refs.production'), state: 'todo', current: true, expected: '12/11' },
    { id: 'READY', label: t('refs.ready'), state: 'todo', expected: '14/11' },
    { id: 'SHIPPED', label: t('refs.shipped'), state: 'todo' },
    { id: 'DELIVERED', label: t('refs.delivered'), state: 'todo' },
  ]
  const ret: MilestoneStep[] = [
    { id: 'REQUESTED', label: t('refs.requested'), state: 'done', date: '02/11' },
    { id: 'AUTHORISED', label: t('refs.authorised'), state: 'done', date: '03/11' },
    { id: 'BACK', label: t('refs.back'), state: 'partly', date: '06/11', note: t('refs.partly') },
    { id: 'INSPECTED', label: t('refs.inspected'), state: 'current' },
    { id: 'OUTCOME', label: t('refs.outcome'), state: 'todo' },
  ]
  return (
    <div className="fw-dpl-stack">
      <Field label={t('refs.search')}>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
      </Field>
      <RefPair theirs="4500-1234" theirsLabel={t('refs.yourPo')} ours="SO-2026-0042" oursLabel={t('refs.ourOrder')} match={search} labels={ds.refPair} />
      <RefPair theirs="PO-ACME-77" ours="SO-2026-0043" layout="stacked" size="sm" match={search} labels={ds.refPair} />
      <MilestoneTracker
        steps={order}
        label={t('refs.orderSteps')}
        promise={{ date: '14/11/2026', history: [{ on: '30/10', to: '10/11/2026' }, { on: '04/11', from: '10/11/2026', to: '14/11/2026', reason: t('refs.reason1') }] }}
        labels={ds.milestoneTracker}
      />
      <MilestoneTracker steps={ret} layout="vertical" label={t('refs.returnSteps')} labels={ds.milestoneTracker} />
      <div className="fw-dpl-row">
        <span className="fw-dpl-label">{t('refs.inRow')}</span>
        <MilestoneTracker steps={order} layout="compact" label={t('refs.orderSteps')} labels={ds.milestoneTracker} />
      </div>
    </div>
  )
}

/* ── what waits for you ─────────────────────────────────────────────────────────────────────── */

function ActionsLab({ model }: { model: DsPortalLabModel }) {
  const t = useT('ds-portal-lab')
  const ds = useDsLabels()
  // The server and the first client render share one fixed clock (no hydration mismatch); the real one after mount.
  const [base, setBase] = useState(() => Date.parse(`${TODAY}T08:00:00Z`))
  useEffect(() => setBase(Date.now()), [])
  const [confirmed, setConfirmed] = useState(false)
  const [signed, setSigned] = useState(false)
  const [signing, setSigning] = useState(false)
  const [busy, setBusy] = useState(false)
  const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString()
  const groups: ActionGroup[] =
    model.actions === 'empty'
      ? []
      : [
          {
            id: 'orders',
            label: t('actions.orders'),
            items: [
              {
                id: 'confirm',
                title: t('actions.confirm'),
                record: <RefPair theirs="4500-1234" ours="PO-2026-0101" size="sm" copy={false} labels={ds.refPair} />,
                meta: t('actions.askedBy'),
                due: { at: iso(5 * 3_600_000), state: 'soon' },
                verb: {
                  label: t('actions.confirmVerb'),
                  kind: 'inline',
                  busy,
                  onRun: () => {
                    setBusy(true)
                    void wait(500).then(() => {
                      setBusy(false)
                      setConfirmed(true)
                    })
                  },
                },
                done: confirmed ? { words: t('actions.confirmed'), onUndo: () => setConfirmed(false) } : null,
              },
            ],
          },
          {
            id: 'documents',
            label: t('actions.documents'),
            items: [
              {
                id: 'sign',
                title: t('actions.sign'),
                due: { at: iso(-4 * 86_400_000), state: 'overdue', text: '03/11/2026' },
                verb: { label: t('actions.signVerb'), kind: 'dialog', onRun: () => setSigning(true) },
                done: signed ? { words: t('actions.signed') } : null,
              },
            ],
          },
          {
            id: 'notices',
            label: t('actions.notices'),
            items: [
              {
                id: 'notice',
                title: t('actions.notice'),
                due: { at: iso(5 * 86_400_000), state: 'later', text: '12/11/2026' },
                verb: { label: t('actions.noticeVerb'), kind: 'link', href: '#ship-notice' },
              },
            ],
          },
        ]
  return (
    <>
      <ActionList groups={groups} now={base} labels={ds.actionList} countdownLabels={ds.countdown} />
      <Modal
        open={signing}
        sheet
        onClose={() => setSigning(false)}
        title={t('actions.dialogTitle')}
        footer={
          <>
            <Button onClick={() => setSigning(false)}>{t('actions.cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setSigning(false)
                setSigned(true)
              }}
            >
              {t('actions.dialogSign')}
            </Button>
          </>
        }
      >
        <p className="fw-dpl-note">{t('actions.dialogBody')}</p>
      </Modal>
    </>
  )
}

/* ── answer a purchase order ────────────────────────────────────────────────────────────────── */

/** The page's own parse of a typed quantity in its language ("1.200,5" in Italian) → a plain decimal. */
const parseQuantity = (locale: Locale) => (text: string) => {
  const raw = text.trim().replace(/\s/g, '')
  const plain = locale === 'it' ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '')
  return /^\d+(\.\d+)?$/.test(plain) ? plain : null
}

function LinesLab({ model }: { model: DsPortalLabModel }) {
  const t = useT('ds-portal-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const day = (iso: string) => formatDate(`${iso}T12:00:00Z`, { locale })
  const lines: LineRequest[] = [
      { id: 'l1', seq: 10, title: t('lines.l1'), details: [t('lines.l1grade'), t('lines.l1thick'), t('lines.l1batch')], tags: [{ label: t('lines.crvi'), tone: 'info' }], asked: { quantity: '120', unit: t('lines.unitM2'), date: '2026-12-03', dateText: day('2026-12-03') } },
      { id: 'l2', seq: 20, title: t('lines.l2'), substitutes: [{ id: 'LIN-05', label: t('lines.l2sub') }], asked: { quantity: '300', unit: t('lines.unitM'), date: '2026-12-10', dateText: day('2026-12-10') } },
      { id: 'l3', seq: 30, title: t('lines.l3'), asked: { quantity: '50', unit: t('lines.unitPcs'), date: '2026-11-20', dateText: day('2026-11-20') } },
  ]
  const preset: Record<string, LineDraft> =
    model.lines === 'answered'
      ? { l2: { kind: 'OTHER', date: '2026-12-17', quantity: '', reason: t('lines.reasonLate') }, l3: { kind: 'CANNOT', reason: t('lines.reasonCannot') } }
      : {}
  const [answers, setAnswers] = useState<Record<string, LineDraft | undefined>>(preset)
  const [send, setSend] = useState<'idle' | 'busy' | 'done'>(model.lines === 'answered' ? 'done' : 'idle')
  const outcome = lineResponseOutcome(lines, answers)
  const editable = send !== 'done'
  return (
    <div className="fw-dpl-stack">
      <LineResponseList
        lines={lines}
        answers={answers}
        editable={editable}
        onAnswer={(id, draft) => setAnswers((all) => ({ ...all, [id]: draft ?? undefined }))}
        onAllAsAsked={() => setAnswers({})}
        kinds={['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT', 'SUBSTITUTE', 'CHANGE']}
        today={TODAY}
        parseQuantity={parseQuantity(locale)}
        formatDate={day}
        locale={INTL_LOCALE[locale]}
        labels={ds.lineResponseList}
        modalLabels={ds.modal}
        textareaLabels={ds.textarea}
        dateFieldLabels={ds.dateField}
      />
      {send === 'done' ? (
        <p className="fw-dpl-ok" role="status">
          {t('lines.sent')}{' '}
          <Button size="sm" variant="link" onClick={() => setSend('idle')}>
            {t('lines.again')}
          </Button>
        </p>
      ) : (
        <PortalActionBar
          inline
          action={{
            label: outcome === 'CONFIRMED' ? t('lines.confirmAll') : outcome === 'DECLINED' ? t('lines.decline') : t('lines.send'),
            variant: outcome === 'DECLINED' ? 'danger' : 'primary',
            busy: send === 'busy',
            onClick: () => {
              setSend('busy')
              void wait(700).then(() => setSend('done'))
            },
          }}
          labels={ds.portalActionBar}
        />
      )}
    </div>
  )
}

/* ── conversation ───────────────────────────────────────────────────────────────────────────── */

function ThreadLab({ model }: { model: DsPortalLabModel }) {
  const t = useT('ds-portal-lab')
  const ds = useDsLabels()
  const older: PartnerMessage = { id: 'm0', side: 'company', channel: 'email', author: { name: 'Marco Demo', mine: false }, body: t('thread.m0'), at: '2026-11-03T08:10:00Z', atText: '03/11/2026, 09:10' }
  const [messages, setMessages] = useState<PartnerMessage[]>(() => [
    { id: 'm1', side: 'company', channel: 'email', author: { name: 'Marco Demo', mine: false }, body: t('thread.m1'), attachments: [{ id: 'f1', name: t('thread.file1'), size: '84 KB', href: '#po-pdf' }], at: '2026-11-04T08:42:00Z', atText: '04/11/2026, 09:42' },
    { id: 'm2', side: 'partner', channel: 'portal', author: { name: 'Anna Rossi', mine: true }, body: t('thread.m2'), at: '2026-11-04T09:15:00Z', atText: '04/11/2026, 10:15' },
    { id: 'm3', side: 'company', channel: 'app', author: { name: null, mine: false }, body: t('thread.m3'), at: '2026-11-04T10:02:00Z', atText: '04/11/2026, 11:02' },
  ])
  const [loadedOlder, setLoadedOlder] = useState(false)
  const [text, setText] = useState('')
  const [attached, setAttached] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<'ready' | 'error'>(model.thread === 'error' ? 'error' : 'ready')
  const files = [
    { id: 'f1', name: t('thread.file1') },
    { id: 'f2', name: t('thread.file2') },
  ]
  return (
    <PartnerThread
      title={t('thread.title')}
      record={<RefPair theirs="4500-1234" ours="PO-2026-0101" labels={ds.refPair} />}
      companyName="Pelletteria Demo"
      messages={loadedOlder ? [older, ...messages] : messages}
      state={state}
      onRetry={() => setState('ready')}
      loadMore={loadedOlder ? null : { onClick: () => setLoadedOlder(true) }}
      composer={{
        value: text,
        onChange: setText,
        busy,
        heldReason: model.thread === 'readonly' ? t('thread.readonly') : null,
        hint: t('thread.hint'),
        files,
        attached,
        onAttach: setAttached,
        limit: 2000,
        onSend: () => {
          setBusy(true)
          void wait(500).then(() => {
            setMessages((all) => [
              ...all,
              {
                id: `m${all.length + 10}`,
                side: 'partner',
                channel: 'portal',
                author: { name: 'Anna Rossi', mine: true },
                body: text.trim(),
                attachments: files.filter((f) => attached.includes(f.id)).map((f) => ({ ...f, href: '#file' })),
                at: new Date().toISOString(),
                atText: t('thread.now'),
              },
            ])
            setText('')
            setAttached([])
            setBusy(false)
          })
        },
      }}
      labels={ds.partnerThread}
      textareaLabels={ds.textarea}
    />
  )
}

/* ── pay online ─────────────────────────────────────────────────────────────────────────────── */

function PayLab({ model }: { model: DsPortalLabModel }) {
  const t = useT('ds-portal-lab')
  const ds = useDsLabels()
  const start: PaymentState = model.pay === 'waiting' ? 'waiting' : model.pay === 'failed' ? 'failed' : 'idle'
  const [state, setState] = useState<PaymentState>(start)
  const [method, setMethod] = useState<string>('card')
  const settle = (ok: boolean) => {
    setState('waiting')
    void wait(1500).then(() => setState(ok ? 'succeeded' : 'failed'))
  }
  return (
    <PaymentPanel
      amount={t('pay.amount')}
      purpose={t('pay.purpose')}
      providerName={t('pay.provider')}
      methods={[
        { id: 'card', label: t('pay.card'), description: t('pay.cardHint') },
        { id: 'sepa', label: t('pay.sepa'), description: t('pay.sepaHint') },
      ]}
      method={method}
      onMethod={setMethod}
      state={state}
      heldReason={model.pay === 'held' ? t('pay.held') : null}
      onStart={() => {
        setState('starting')
        void wait(600).then(() => setState('ready'))
      }}
      fields={
        <div className="fw-dpl-fake">
          <p className="fw-dpl-note">{t('pay.fakeNote')}</p>
          <div className="fw-dpl-buttons">
            <Button variant="primary" onClick={() => settle(true)}>
              {t('pay.succeed')}
            </Button>
            <Button onClick={() => settle(false)}>{t('pay.decline')}</Button>
          </div>
        </div>
      }
      failure={state === 'failed' ? t('pay.declined') : null}
      onRetry={() => setState('idle')}
      succeeded={{ words: t('pay.paid'), receipt: t('pay.receipt') }}
      labels={ds.paymentPanel}
    />
  )
}

/* ── order by size on a phone ───────────────────────────────────────────────────────────────── */

function SizesLab() {
  const t = useT('ds-portal-lab')
  const production = useT('production')
  const ds = useDsLabels()
  const locale = useLocale()
  const sizes: SizeGridSize[] = ['XS', 'S', 'M', 'L', 'XL'].map((k) => ({ key: k, label: k }))
  const colours: SizeGridColour[] = [
    { key: 'blk', label: t('sizes.black'), swatch: 'black' },
    { key: 'tan', label: t('sizes.tan'), swatch: 'peru', offered: ['S', 'M', 'L'] },
    { key: 'brg', label: t('sizes.burgundy'), swatch: 'maroon' },
  ]
  const [value, setValue] = useState<Record<string, Record<string, number>>>({ blk: { S: 4, M: 8, L: 6 }, tan: { M: 5 } })
  return (
    <SizeGridEditor
      layout="stacked"
      colours={colours}
      sizes={sizes}
      value={value}
      onChange={setValue}
      left={{ blk: { XS: 0, S: 12, M: 20, L: 9, XL: 3 }, tan: { S: 6, M: 4, L: 2 }, brg: { XS: 2, S: 5, M: 7, L: 7, XL: 1 } }}
      issues={(value.tan?.M ?? 0) > 4 ? [{ colour: 'tan', size: 'M', message: t('sizes.issue'), tone: 'warning' }] : []}
      caption={t('sizes.caption')}
      locale={INTL_LOCALE[locale]}
      copy={{ ...sizeGridCopy(production), ...ds.sizeGridStacked }}
    />
  )
}

/* ── pop-ups ────────────────────────────────────────────────────────────────────────────────── */

function PopupLab({ model }: { model: DsPortalLabModel }) {
  const t = useT('ds-portal-lab')
  const [open, setOpen] = useState(model.sheet ?? false)
  const [ref, setRef] = useState('')
  return (
    <div className="fw-dpl-stack">
      <div className="fw-dpl-buttons">
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t('popups.open')}
        </Button>
      </div>
      <Modal
        open={open}
        sheet
        onClose={() => setOpen(false)}
        title={t('popups.title')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('popups.cancel')}</Button>
            <Button variant="primary" heldReason={ref.trim() ? null : t('popups.held')} onClick={() => setOpen(false)}>
              {t('popups.save')}
            </Button>
          </>
        }
      >
        <div className="fw-dpl-stack">
          <p className="fw-dpl-note">{t('popups.body')}</p>
          <Field label={t('popups.field')}>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

/* ── the phone action bar ───────────────────────────────────────────────────────────────────── */

function LabLink({ href, className, children, ...rest }: BottomBarLinkProps) {
  return (
    <a href={`#${href.replace(/^\//, '')}`} className={className} {...rest}>
      {children}
    </a>
  )
}

function BarLab({ model }: { model: DsPortalLabModel }) {
  const t = useT('ds-portal-lab')
  const ds = useDsLabels()
  const nav: AreaNav = {
    view: 'portal',
    areas: [
      { id: 'home', label: t('bar.home'), href: '/home', icon: Home, phone: 'tab' },
      { id: 'orders', label: t('bar.orders'), href: '/orders', icon: ShoppingCart, phone: 'tab' },
      { id: 'documents', label: t('bar.documents'), href: '/documents', icon: FileText, phone: 'tab' },
      { id: 'account', label: t('bar.account'), href: '/account', icon: Settings, phone: 'tab' },
    ],
  }
  return (
    <div className="fw-dpl-stack">
      <p className="fw-dpl-note">{t('bar.note')}</p>
      <p className="fw-dpl-strong">{t('bar.record')}</p>
      {[10, 30, 40, 50, 60, 70].map((n) => (
        <p key={n} className="fw-dpl-line">
          {t('bar.line', { n })}
        </p>
      ))}
      <PortalActionBar
        action={{ label: t('bar.send'), heldReason: model.bar === 'held' ? t('bar.held') : null, onClick: () => {} }}
        labels={ds.portalActionBar}
      />
      <BottomBar
        nav={nav}
        pathname="/orders"
        LinkComponent={LabLink}
        labels={{ navigation: t('bar.nav'), more: t('bar.more'), count: (count) => t('bar.waiting', { count }), currentInside: t('bar.inside') }}
      />
    </div>
  )
}
