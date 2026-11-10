'use client'

import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, CircleHelp, ExternalLink } from 'lucide-react'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import type { Span } from '@nexus/factory-domain/compliance/certificates-depth/validity'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { ScopeCheckView } from '../api'
import { DEPTH_NS, spanParts } from '../model'
import '../depth.css'

/** The PPE Regulation on EUR-Lex (the LawRef chips' official link). */
export const PPE_REGULATION_HREF = 'https://eur-lex.europa.eu/eli/reg/2016/425/oj'

/** The depth catalogue beside the page's (a view works the same in the Office and the design index). */
export function DepthMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['quality', 'lists', 'records', 'certificates', DEPTH_NS]}>{children}</WithMessages>
}

export const useDepthT = () => useT(DEPTH_NS)

/** A span in words ("5 years 2 months"; nothing: "0 days"). */
export function useSpanText() {
  const d = useDepthT()
  return (span: Span): string => {
    const parts = spanParts(span)
    return parts.length === 0 ? d('span.days', { count: 0 }) : parts.map((part) => d(`span.${part.unit}`, { count: part.count })).join(' ')
  }
}

/** The scope check in words with its icon (design: "Listed for protective motorcycle clothing ✓"; a warning otherwise). */
export function ScopeLine({ check, short = false }: { check: ScopeCheckView; short?: boolean }) {
  const d = useDepthT()
  const icon = check.state === 'LISTED' ? <CircleCheck size={14} aria-hidden /> : check.state === 'NOT_LISTED' ? <CircleAlert size={14} aria-hidden /> : <CircleHelp size={14} aria-hidden />
  const full = d(`scope.${check.state}.${check.kind}`)
  // A grid cell says it short (the full sentence in its title and for assistive technology).
  return (
    <span className={`fw-cd-scope fw-cd-scope-${check.state.toLowerCase()}`} title={short ? full : undefined}>
      {icon}
      {short ? (
        <>
          <span aria-hidden>{d(`scope.short.${check.state}`)}</span>
          <span className="nds-vh">{full}</span>
        </>
      ) : (
        <span>{full}</span>
      )}
    </span>
  )
}

/** The body's NANDO entry: the Commission's site, in a new tab (outside site; design tab:ce-nando). */
export function NandoLink({ href, number, short = false }: { href: string | null; number: string; short?: boolean }) {
  const d = useDepthT()
  if (!href) return <span className="fw-q-hint">{d(short ? 'nando.noneShort' : 'nando.none')}</span>
  return (
    <a className="fw-q-link fw-cd-nando" href={href} target="_blank" rel="noopener noreferrer" aria-label={short ? `${d('nando.open', { number })} (${d('nando.newTab')})` : undefined}>
      {d(short ? 'nando.short' : 'nando.open', { number })} <ExternalLink size={12} aria-hidden />
      {!short && <span className="nds-vh"> ({d('nando.newTab')})</span>}
    </a>
  )
}

/** The law behind a part, as the shared chip (plain words + the official text). */
export function PpeLaw({ point, plainKey }: { point: string; plainKey: string }) {
  const d = useDepthT()
  const ds = useDsWords()
  return <LawRef law={d('law.ppe', { point })} plain={d(plainKey)} href={PPE_REGULATION_HREF} labels={ds.lawRef} />
}

/** A level in words: the property's name and its value's words ("Knuckle protection: yes (KP)"). */
export function useLevelWords() {
  const d = useDepthT()
  return {
    property: (key: string): string => d(`levels.property.${key}`),
    value: (key: string, value: string): string => (key === 'knuckle' ? d('levels.value.kp') : /Area$/.test(key) || key === 'type' ? d(`levels.value.${key}.${value}`) : d('levels.value.level', { level: value })),
  }
}
