'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Layers, Package, Scissors } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { Button } from '@nexus/ui/primitives'
import { densityAttrs, displayDensityAttrs } from '@nexus/ui/tokens/density'
import { FloorList, FloorListRow } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { FloorNamePicker, type FloorPerson } from '@nexus/ui/floor/FloorNamePicker/index'
import { FloorListUpdates, useFloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { PinSignBlock } from '@nexus/ui/components/PinSignBlock/index'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { LegalGate, type LegalGateItem } from '@nexus/ui/components/LegalGate/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { ProtectedValue } from '@nexus/ui/components/ProtectedValue/index'
import { DayStrip } from '@nexus/ui/components/DayStrip/index'
import { DueCell, dueComparator, type DueValue } from '@nexus/ui/components/DueCell/index'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { WithMessages } from '../../../../record-panels/i18n'
import { useDsLabels } from '../../../i18n/ds-labels'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatTime } from '../../../i18n/format'
import { INTL_LOCALE } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import './ds-floor-lab.css'

/**
 * The floor and people parts lab (`/design/ds-floor-parts`, B-W2b-28): every part this step put in the design system,
 * drawn with the `ds-words` catalogue as their `labels` in the gallery's language. The floor parts sit inside a
 * `data-density="floor"` box (tablet and glove sizes), the line-TV sample inside the display tier (D26), the people parts
 * at the console's size. In the browser each part works for real: pick a name, let the list change and Show it, sign with
 * the demo PIN, open the protected value, verify the demo file. Made-up data only.
 */
export interface DsFloorLabModel {
  /** One group alone, or every part. */
  show?: 'all' | 'floor' | 'people' | 'display'
  card?: 'live' | 'cached'
  names?: 'ready' | 'offline' | 'empty'
  /** The floor list starts with rows waiting. */
  listChanged?: boolean
  sign?: 'idle' | 'locked' | 'held' | 'done'
  gate?: 'off' | 'on' | 'on-open'
  /** The person holds the health role (ProtectedValue). Default true. */
  role?: boolean
}

/** The demo PIN the lab accepts (made up; shown on screen). */
const DEMO_PIN = '246810'
/** The demo file the seal was made from, and its SHA-256 (computed once, by `shasum -a 256`). */
const DEMO_FILE = 'Nexus Factory demo document: LUL calendar, October 2026. Made-up data.\n'
const DEMO_SHA = '0b00b462fe392b8669ea5dcea35fe681daf365a1920525c0b0884c39a2606312'
const TODAY = '2026-11-03'
const at = (hhmmUtc: string) => `${TODAY}T${hhmmUtc}:00Z`

const PEOPLE: FloorPerson[] = [
  { id: 'p1', name: 'Marta Demo' },
  { id: 'p2', name: 'Luca Esempio' },
  { id: 'p3', name: 'Anna Campione' },
  { id: 'p4', name: 'Paolo Prova' },
  { id: 'p5', name: 'Sara Test' },
  { id: 'p6', name: 'Élodie Bozza' },
  { id: 'p7', name: 'Giulia Modello' },
  { id: 'p8', name: 'Andrea Fittizio' },
  { id: 'p9', name: 'Ioana Demo' },
  { id: 'p10', name: 'Karim Esempio' },
]

interface Bundle {
  id: string
  code: string
  op: 'sew' | 'cut' | 'pack'
  pieces: number
  status: 'ready' | 'waiting' | 'done'
}
const BUNDLES: Bundle[] = [
  { id: 'b1', code: 'B-000121', op: 'sew', pieces: 20, status: 'ready' },
  { id: 'b2', code: 'B-000122', op: 'cut', pieces: 12, status: 'waiting' },
  { id: 'b3', code: 'B-000123', op: 'pack', pieces: 30, status: 'ready' },
]
const BUNDLES_CHANGED: Bundle[] = [
  { id: 'b1', code: 'B-000121', op: 'sew', pieces: 20, status: 'done' },
  { id: 'b4', code: 'B-000124', op: 'sew', pieces: 16, status: 'ready' },
  { id: 'b2', code: 'B-000122', op: 'cut', pieces: 12, status: 'waiting' },
  { id: 'b3', code: 'B-000123', op: 'pack', pieces: 30, status: 'ready' },
]

export function DsFloorLab({ model }: { model: DsFloorLabModel }) {
  return (
    <WithMessages namespaces={['ds-words', 'ds-floor-lab']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <Card padded header={title} className="fw-dfl-card">
      {note ? <p className="fw-dfl-note">{note}</p> : null}
      {children}
    </Card>
  )
}

function Part({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'fw-dfl-part fw-dfl-span' : 'fw-dfl-part'}>
      <span className="fw-dfl-label">{label}</span>
      {children}
    </div>
  )
}

function Lab({ model }: { model: DsFloorLabModel }) {
  const t = useT('ds-floor-lab')
  const show = model.show ?? 'all'
  return (
    <main id="main-content" className="fw-dfl">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {show === 'all' || show === 'floor' ? (
        <Section title={t('section.floor')} note={t('section.floorNote')}>
          <div className="fw-dfl-floor fw-dfl-grid" {...densityAttrs('floor')}>
            <FloorParts model={model} />
          </div>
        </Section>
      ) : null}
      {show === 'all' || show === 'people' ? (
        <Section title={t('section.people')}>
          <div className="fw-dfl-grid">
            <PeopleParts model={model} />
          </div>
        </Section>
      ) : null}
      {show === 'all' || show === 'display' ? (
        <Section title={t('section.display')} note={t('section.displayNote')}>
          <DisplayLab />
        </Section>
      ) : null}
    </main>
  )
}

/* ── the floor parts ───────────────────────────────────────────────────────────────────────────── */

function FloorParts({ model }: { model: DsFloorLabModel }) {
  const t = useT('ds-floor-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const [base] = useState(() => Date.now())
  const [picked, setPicked] = useState<string | null>(null)
  const cached = model.card === 'cached'
  const names = model.names ?? 'ready'

  return (
    <>
      <Part label={t('part.card')}>
        <FloorCard
          icon={<Layers />}
          kind={t('card.kind')}
          code="B-000123"
          title={t('card.title')}
          status={{ label: t('card.ready'), tone: 'success' }}
          facts={[
            { id: 'pieces', label: t('card.pieces'), value: 20 },
            { id: 'op', label: t('card.op'), value: t('card.opValue') },
            { id: 'size', label: t('card.size'), value: 'M' },
            { id: 'colour', label: t('card.colour'), value: t('card.colourValue') },
            { id: 'short', label: t('card.short'), value: t('card.shortValue'), tone: 'danger' },
            { id: 'order', label: t('card.order'), value: 'WO-0042' },
          ]}
          flags={[{ id: 'qc', label: t('card.flagCheck'), tone: 'warning' }]}
          asOf={cached ? at('09:42') : null}
          formatTime={(iso) => formatTime(iso, { locale })}
          locale={INTL_LOCALE[locale]}
          labels={ds.floorCard}
        />
      </Part>
      <Part label={t('part.elapsed')}>
        <div className="fw-dfl-elapsed">
          <FloorElapsed label={t('elapsed.running')} since={base - 12 * 60_000 - 7_000} labels={ds.floorElapsed} />
          <FloorElapsed label={t('elapsed.call')} since={base - 6 * 60_000} warnAfterMs={5 * 60_000} dangerAfterMs={10 * 60_000} size="md" labels={ds.floorElapsed} />
          <FloorElapsed label={t('elapsed.today')} since={base - (7 * 60 + 42) * 60_000} precision="minutes" size="md" labels={ds.floorElapsed} />
          <FloorElapsed label={t('elapsed.break')} until={base - 45_000} size="md" labels={ds.floorElapsed} />
          <FloorElapsed label={t('elapsed.paused')} carriedMs={4 * 60_000} paused size="md" labels={ds.floorElapsed} />
        </div>
      </Part>
      <Part label={t('part.names')} wide>
        <FloorNamePicker
          label={t('names.label')}
          people={names === 'empty' ? [] : PEOPLE}
          recentIds={['p3', 'p1']}
          onPick={(_, p) => setPicked(p.name)}
          heldReason={names === 'offline' ? t('names.offline') : null}
          locale={INTL_LOCALE[locale]}
          labels={ds.floorNamePicker}
        />
        {picked ? <p className="fw-dfl-note" role="status">{t('names.picked', { name: picked })}</p> : null}
      </Part>
      <Part label={t('part.list')}>
        <ListLab startChanged={!!model.listChanged} />
      </Part>
      <Part label={t('part.read')}>
        <ReadAloudButton text={t('read.text')} lang={INTL_LOCALE[locale]} labels={ds.readAloud} />
        <p className="fw-dfl-note">{t('read.note')}</p>
      </Part>
      <Part label={t('part.sign')} wide>
        <SignLab start={model.sign ?? 'idle'} />
      </Part>
    </>
  )
}

function ListLab({ startChanged }: { startChanged: boolean }) {
  const t = useT('ds-floor-lab')
  const ds = useDsLabels()
  const [incoming, setIncoming] = useState<Bundle[]>(BUNDLES)
  useEffect(() => {
    if (startChanged) setIncoming(BUNDLES_CHANGED)
  }, [startChanged])
  const live = useFloorListUpdates(incoming, { key: (b) => b.id, version: (b) => b.status })
  const icon = (op: Bundle['op']) => (op === 'cut' ? <Scissors /> : op === 'pack' ? <Package /> : <Layers />)
  return (
    <div className="fw-dfl-stack">
      <FloorList label={t('list.label')} updates={<FloorListUpdates pending={live.pending} onShow={live.show} labels={ds.floorListUpdates} />}>
        {(live.rows ?? []).map((b) => (
          <FloorListRow
            key={b.id}
            icon={icon(b.op)}
            title={b.code}
            meta={t(`list.op.${b.op}`)}
            status={t(`list.status.${b.status}`)}
            tone={b.status === 'done' ? 'success' : b.status === 'waiting' ? 'warning' : 'primary'}
            count={b.pieces}
            countLabel={t('list.pieces')}
          />
        ))}
      </FloorList>
      <div className="fw-dfl-buttons">
        <Button size="sm" onClick={() => setIncoming(incoming === BUNDLES ? BUNDLES_CHANGED : BUNDLES)}>
          {t('list.simulate')}
        </Button>
      </div>
    </div>
  )
}

function SignLab({ start }: { start: NonNullable<DsFloorLabModel['sign']> }) {
  const t = useT('ds-floor-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const [state, setState] = useState<'idle' | 'busy' | 'done'>(start === 'done' ? 'done' : 'idle')
  const [wrong, setWrong] = useState(start === 'locked' ? 3 : 0)
  const [signedAt, setSignedAt] = useState<string>(at('09:42'))
  const locked = wrong >= 3
  const sign = (pin: string) => {
    if (pin !== DEMO_PIN) {
      setWrong((n) => n + 1)
      return
    }
    setState('busy')
    setTimeout(() => {
      setSignedAt(new Date().toISOString())
      setState('done')
    }, 600)
  }
  const message = locked ? t('sign.locked') : wrong > 0 ? t('sign.wrong', { count: 3 - wrong }) : undefined
  return (
    <div className="fw-dfl-stack">
      <PinSignBlock
        title={t('sign.title')}
        summary={<p className="fw-dfl-summary">{t('sign.summary')}</p>}
        meaning={t('sign.meaning')}
        signer={{ name: 'Marta Demo', detail: t('sign.detail') }}
        onNotYou={() => {}}
        onSign={sign}
        onCancel={() => {}}
        state={state}
        locked={locked}
        heldReason={start === 'held' ? t('sign.held') : null}
        message={message}
        done={<p>{t('sign.done', { time: formatTime(signedAt, { locale }) })}</p>}
        labels={ds.pinSignBlock}
      />
      {state !== 'done' ? <p className="fw-dfl-note">{t('sign.demo', { pin: DEMO_PIN })}</p> : null}
    </div>
  )
}

/* ── the people parts ──────────────────────────────────────────────────────────────────────────── */

const LAWS = {
  statuto: { law: 'L. 300/1970 art. 4', href: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:1970-05-20;300' },
  training: { law: 'D.Lgs. 81/2008 art. 37', href: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2008-04-09;81' },
  gdpr: { law: 'GDPR art. 9', href: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj' },
  piece: { law: 'c.c. art. 2101', href: null },
} as const

function PeopleParts({ model }: { model: DsFloorLabModel }) {
  const t = useT('ds-floor-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const law = (key: keyof typeof LAWS) => ({ ...LAWS[key], plain: t(`law.${key}`) })
  const lawChip = (key: keyof typeof LAWS) => <LawRef {...law(key)} labels={ds.lawRef} />
  const gate = model.gate ?? 'off'
  const recordedAt = formatDate(at('09:00'), { locale })
  const items: LegalGateItem[] = [
    { id: 'basis', label: t('gate.basis'), state: 'met', law: law('statuto'), recordedBy: 'Persona Demo', recordedAt },
    { id: 'notice', label: t('gate.notice'), state: gate === 'off' ? 'missing' : 'met', detail: t('gate.noticeDetail', { done: gate === 'off' ? 14 : 16, total: 16 }), href: '/design/ds-floor-parts/gate-on', linkLabel: t('gate.noticeLink') },
    { id: 'scheme', label: t('gate.scheme'), state: 'met', recordedBy: 'Persona Demo', recordedAt },
    { id: 'rates', label: t('gate.rates'), state: gate === 'off' ? 'unknown' : 'met', law: law('piece') },
    { id: 'codes', label: t('gate.codes'), state: gate === 'off' ? 'missing' : gate === 'on-open' ? 'expired' : 'met' },
  ]
  const [started, setStarted] = useState(false)
  const courses = useMemo(
    () =>
      ([
        { id: 'c1', name: t('due.general'), value: { due: '2029-02-12' } },
        { id: 'c2', name: t('due.supervisor'), value: { due: '2026-10-20' } },
        { id: 'c3', name: t('due.firstAid'), value: { due: '2026-11-15' } },
        { id: 'c4', name: t('due.fire'), value: { state: 'needed' } },
        { id: 'c5', name: t('due.forklift'), value: { state: 'done', doneOn: '2026-10-28' } },
      ] as { id: string; name: string; value: DueValue }[]).sort((a, b) => dueComparator({ today: TODAY })(a.value, b.value)),
    [t],
  )

  return (
    <>
      <Part label={t('part.privacy')} wide>
        <div className="fw-dfl-stack">
          <PrivacyNote level="line" text={t('privacy.lineText')} whoMore={t('privacy.who')} law={lawChip('statuto')} labels={ds.privacyNote} />
          <PrivacyNote level="individual" recorded whoMore={t('privacy.individualWho')} labels={ds.privacyNote} />
          <PrivacyNote level="protected" variant="panel" recorded whoMore={t('privacy.protectedWho')} law={lawChip('gdpr')} labels={ds.privacyNote} />
        </div>
      </Part>
      <Part label={t('part.law')}>
        <p className="fw-dfl-sentence">
          {t('law.sentence')} {lawChip('training')}
        </p>
      </Part>
      <Part label={t('part.protected')}>
        <ProtectedLab role={model.role !== false} />
      </Part>
      <Part label={t('part.gate')} wide>
        <LegalGate
          title={t('gate.title')}
          items={items}
          on={gate !== 'off'}
          onSince={gate !== 'off' ? formatDate(`${TODAY}T08:00:00Z`, { locale }) : undefined}
          action={{ label: t('gate.start'), onClick: () => setStarted(true) }}
          labels={ds.legalGate}
          lawLabels={ds.lawRef}
        />
        {started ? <p className="fw-dfl-note" role="status">{t('gate.started')}</p> : null}
      </Part>
      <Part label={t('part.day')} wide>
        <DayLab />
      </Part>
      <Part label={t('part.due')}>
        <ul className="fw-dfl-due">
          {courses.map((c) => (
            <li key={c.id}>
              <span>{c.name}</span>
              <DueCell value={c.value} today={TODAY} formatDate={(d) => formatDate(`${d}T12:00:00Z`, { locale })} labels={ds.dueCell} />
            </li>
          ))}
        </ul>
        <p className="fw-dfl-note">{t('due.note')}</p>
      </Part>
      <Part label={t('part.seal')}>
        <DocumentSeal
          title={t('seal.title')}
          version="v1"
          sha256={DEMO_SHA}
          sealedAt={formatDateTime(`2026-11-01T17:02:00Z`, { locale })}
          timestampSource={t('seal.source')}
          sealedBy="Persona Demo"
          signers={[
            { id: 's1', name: 'Persona Demo', role: t('seal.hr'), signedAt: formatDate('2026-11-01T17:05:00Z', { locale }) },
            { id: 's2', name: 'Consulente Demo', role: t('seal.consultant') },
          ]}
          labels={ds.documentSeal}
        />
        <a className="fw-dfl-download" href={`data:text/plain;charset=utf-8,${encodeURIComponent(DEMO_FILE)}`} download="lul-demo-2026-10.txt">
          {t('seal.download')}
        </a>
      </Part>
    </>
  )
}

function ProtectedLab({ role }: { role: boolean }) {
  const t = useT('ds-floor-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const [value, setValue] = useState<string | undefined>(undefined)
  const [opening, setOpening] = useState(false)
  const [viewedAt, setViewedAt] = useState<string | undefined>(undefined)
  const open = () => {
    setOpening(true)
    setTimeout(() => {
      setValue(t('protected.value'))
      setViewedAt(formatTime(new Date(), { locale }))
      setOpening(false)
    }, 500)
  }
  return (
    <ProtectedValue
      label={t('protected.label')}
      allowed={role}
      value={value}
      onOpen={open}
      opening={opening}
      recordedAt={viewedAt}
      restrictedReason={t('protected.who')}
      onHide={() => setValue(undefined)}
      labels={ds.protectedValue}
    />
  )
}

function DayLab() {
  const t = useT('ds-floor-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const [text, setText] = useState(false)
  return (
    <div className="fw-dfl-stack">
      <DayStrip
        label={t('day.label')}
        from={at('05:00')}
        to={at('19:00')}
        shift={{ from: at('07:00'), to: at('16:00') }}
        segments={[
          { id: 'w1', from: at('07:02'), to: at('11:00'), kind: 'work' },
          { id: 'b1', from: at('11:00'), to: at('11:30'), kind: 'break' },
          { id: 'w2', from: at('11:30'), to: at('16:00'), kind: 'work' },
          { id: 'o1', from: at('16:00'), to: at('16:10'), kind: 'overtime' },
        ]}
        events={[
          { id: 'e1', at: at('07:02'), kind: 'in', label: t('day.badge') },
          { id: 'e2', at: at('16:25'), kind: 'auto-out', flagged: true },
        ]}
        overlays={[
          {
            id: 'machine',
            name: t('day.machine'),
            spans: [
              { id: 'm1', from: at('07:05'), to: at('09:40'), label: t('day.running'), tone: 'success' },
              { id: 'm2', from: at('09:40'), to: at('10:05'), label: t('day.down'), tone: 'danger' },
              { id: 'm3', from: at('10:05'), to: at('16:00'), label: t('day.running'), tone: 'success' },
            ],
          },
        ]}
        anomalies={[{ id: 'a1', at: at('16:25'), label: t('day.anomaly') }]}
        locale={INTL_LOCALE[locale]}
        timeZone={DEFAULT_TIME_ZONE}
        showText={text}
        labels={ds.dayStrip}
      />
      <div className="fw-dfl-buttons">
        <Button size="sm" aria-pressed={text} onClick={() => setText((v) => !v)}>
          {text ? t('day.hideText') : t('day.showText')}
        </Button>
      </div>
    </div>
  )
}

/* ── the display tier (D26) ────────────────────────────────────────────────────────────────────── */

function DisplayLab() {
  const t = useT('ds-floor-lab')
  const ds = useDsLabels()
  const [base] = useState(() => Date.now())
  return (
    <div className="fw-dfl-display" {...displayDensityAttrs()}>
      <FloorElapsed label={t('display.call')} since={base - 4 * 60_000} warnAfterMs={5 * 60_000} dangerAfterMs={10 * 60_000} size="md" labels={ds.floorElapsed} />
      <FloorElapsed label={t('display.stop')} since={base - 38 * 60_000} size="md" labels={ds.floorElapsed} />
    </div>
  )
}
