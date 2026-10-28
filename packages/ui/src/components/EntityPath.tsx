'use client'

import { Fragment } from 'react'
import NextLink from 'next/link'

import { Tooltip, useTooltipsDisabled } from '../primitives/Tooltip'
import type { EntityLinkComponent } from './EntityLinks'
import type { EntityRef } from './entityLinksModel'
import { entityPathPlace, entityPathSteps, entityPathText } from './entityPathModel'
import './entity-path.css'

export interface EntityPathProps {
  /** Top first: portfolio, campaign, ad group (`{ id, name, href? }`). A missing step (null, no name) is left out. */
  items: ReadonlyArray<EntityRef | null | undefined> | null | undefined
  /** The host's link — the web app passes its workspace `Link` (it keeps the `/w/<id>` prefix). Default Next's `Link`. */
  linkAs?: EntityLinkComponent
  /** What the path is, for a screen reader: "Goes to", "Found in". */
  label?: string
  /** The accessible name of an empty path (a muted dash). Default "None". */
  emptyLabel?: string
  className?: string
}

/**
 * Where a thing sits — Portfolio › Campaign › Ad group — on one line (Keyword Harvest DS lane H7, 2026-10-10). Each
 * step with an `href` is a real link (a new tab works); a step without one is its name. Too long for its box, the
 * MIDDLE steps are cut first, so the portfolio and the ad group stay readable; the whole path shows on hover and on
 * focus (a portal `Tooltip`; a native title where the host turned tooltips off). Empty = a muted dash. Words, CSV text
 * ("A › B › C") and sorting: `entityPathModel.ts`. In a grid: `entityPathColumn`.
 */
export function EntityPath({ items, linkAs, label, emptyLabel = 'None', className }: EntityPathProps) {
  const Link = linkAs ?? NextLink
  const quiet = useTooltipsDisabled()
  const steps = entityPathSteps(items)
  const cls = ['nds-entitypath', className ?? ''].filter(Boolean).join(' ')
  if (!steps.length) return <span className={`${cls} is-none`} role="img" aria-label={label ? `${label}: ${emptyLabel}` : emptyLabel}>—</span>
  const full = entityPathText(steps)
  const path = (
    <span className={cls} role="group" aria-label={label} title={quiet ? full : undefined}>
      {steps.map((step, i) => {
        const stepCls = `nds-entitylink nds-entitypath-step is-${entityPathPlace(i, steps.length)}${step.href ? '' : ' is-plain'}`
        return (
          <Fragment key={`${i}:${step.id}`}>
            {i > 0 && <span className="nds-entitypath-sep" aria-hidden="true">›</span>}
            {step.href ? <Link href={step.href} className={stepCls}>{step.name}</Link> : <span className={stepCls}>{step.name}</span>}
          </Fragment>
        )
      })}
    </span>
  )
  return quiet ? path : <Tooltip label={full} portal className="nds-entitypath-tip">{path}</Tooltip>
}
