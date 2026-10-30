'use client'

import { useMemo, useState, type ReactNode } from 'react'
import {
  Ban,
  CircleDot,
  CircleHelp,
  ClipboardCheck,
  Coffee,
  Droplet,
  Droplets,
  Hammer,
  Hand,
  Layers,
  Package,
  Pin,
  PlugZap,
  Ruler,
  Scissors,
  Spline,
  SquareSplitHorizontal,
  Star,
  StarHalf,
  Sun,
  Unlink,
  Users,
  Volume2,
  Wrench,
  Zap,
} from 'lucide-react'
import { FloorActionBar, FloorFrame } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile, type ReasonTone } from '@nexus/ui/floor/ReasonGrid/index'
import { INTL_LOCALE } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { REASON_KIT_NAMESPACE, useReasonWords } from '../../../lib/ds-words/reason-grid'
import { WithMessages } from '../../../record-panels/i18n'
import '../reason-grid-lab.css'

/** The icons a station's reason list may carry (the office picks one per reason; B-W2a-18). */
const ICONS = {
  ban: Ban,
  circleDot: CircleDot,
  help: CircleHelp,
  clipboard: ClipboardCheck,
  coffee: Coffee,
  droplet: Droplet,
  droplets: Droplets,
  hammer: Hammer,
  hand: Hand,
  layers: Layers,
  package: Package,
  pin: Pin,
  power: PlugZap,
  ruler: Ruler,
  scissors: Scissors,
  spline: Spline,
  split: SquareSplitHorizontal,
  star: Star,
  starHalf: StarHalf,
  sun: Sun,
  unlink: Unlink,
  users: Users,
  noise: Volume2,
  wrench: Wrench,
  zap: Zap,
} as const

export type LabIcon = keyof typeof ICONS

export interface LabReason {
  /** Its word is `lab.r.<id>`, its hint (when `hint`) `lab.h.<id>`. */
  id: string
  icon?: LabIcon
  /** A made-up example photo (a drawing, never a real photo). */
  photo?: string
  tone?: ReasonTone
  hint?: boolean
  photoNeeded?: boolean
  /** Not used at this station (the office's list): held with the reason. */
  notHere?: boolean
}

/** The ONE view model of the reason grid lab. It fetches nothing. */
export interface ReasonGridLabModel {
  /** The question, `lab.<question>`. */
  question: 'stop' | 'scrap' | 'defects' | 'symptom' | 'grade'
  mode: 'pick' | 'count'
  reasons: readonly LabReason[]
  value?: string | null
  counts?: Readonly<Record<string, number>>
  /** The bundle's pieces: no reason counts more. */
  max?: number
}

/**
 * SCR-246 — the floor's icon reason grid, DS part D20 (B-W2a-24; NEW id: the design gives the DS part no screen of its
 * own; its screens are the reason picker SCR-091 (B-W2a-74) and every floor step that asks why: scrap, rework, pause,
 * defects, symptom, grade — B-W2a-73…76 — and Plant › Machine requests "Report a problem"). On the floor tier, tablet
 * first, one job centred. Made-up reasons and example drawings; the picks and counts are kept in this view only.
 */
export function ReasonGridLabView({ model }: { model: ReasonGridLabModel }) {
  return (
    <WithMessages namespaces={[REASON_KIT_NAMESPACE]}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Lab({ model }: { model: ReasonGridLabModel }) {
  const t = useT(REASON_KIT_NAMESPACE)
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const words = useReasonWords()
  const [value, setValue] = useState<string | null>(model.value ?? null)
  const [counts, setCounts] = useState<Record<string, number>>({ ...(model.counts ?? {}) })
  const number = useMemo(() => new Intl.NumberFormat(intl), [intl])

  const reasons = useMemo<ReasonTile[]>(
    () =>
      model.reasons.map((reason) => {
        const Icon = reason.icon ? ICONS[reason.icon] : null
        const icon: ReactNode = Icon ? <Icon /> : null
        return {
          id: reason.id,
          label: t(`lab.r.${reason.id}`),
          hint: reason.hint ? t(`lab.h.${reason.id}`) : undefined,
          icon,
          photo: reason.photo,
          tone: reason.tone,
          photoNeeded: reason.photoNeeded,
          heldReason: reason.notHere ? t('lab.notHere') : null,
        }
      }),
    [model.reasons, t],
  )

  const picked = reasons.find((reason) => reason.id === value)
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const counting = model.mode === 'count'
  const empty = reasons.length === 0
  const held = empty ? null : counting ? (total === 0 ? t('lab.countFirst') : null) : picked ? null : t('lab.chooseFirst')

  return (
    <div className="fw-rglab">
      <FloorFrame
        fill={false}
        landmarks={false}
        label={t(`lab.${model.question}`)}
        actions={<FloorActionBar actions={[{ label: counting ? t('lab.saveCounts') : t('lab.confirm'), onPress: () => undefined, heldReason: empty ? t('lab.emptyStation') : held }]} />}
      >
        <div className="fw-rglab-job">
          {counting ? (
            <ReasonGrid
              mode="count"
              label={t(`lab.${model.question}`)}
              reasons={reasons}
              counts={counts}
              onCountChange={(next) => setCounts(next)}
              max={model.max}
              words={{ ...words, empty: t('lab.emptyStation') }}
              locale={intl}
            />
          ) : (
            <ReasonGrid label={t(`lab.${model.question}`)} reasons={reasons} value={value} onChange={(id) => setValue(id)} words={{ ...words, empty: t('lab.emptyStation') }} locale={intl} />
          )}
          {model.max !== undefined ? <p className="fw-rglab-note">{t('lab.bundleMax', { max: number.format(model.max) })}</p> : null}
          {held ? <p className="fw-rglab-note">{held}</p> : null}
          {picked ? <p className="fw-rglab-note">{picked.photoNeeded ? t('lab.photoNext', { reason: picked.label }) : t('lab.chosen', { reason: picked.label })}</p> : null}
        </div>
      </FloorFrame>
    </div>
  )
}
