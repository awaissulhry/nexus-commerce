'use client'

import type { ReactNode } from 'react'
import '../../floor.css'

/**
 * A full-screen state of a floor job (design "Refusals": a picture, what happened, why in words, what to do; never a
 * toast). The DS has no `FloorStateScreen` yet (design "New DS parts"): this is the app's stand-in, layout only, with
 * the floor tones; its one to three actions are the frame's action bar.
 */
export function FloorState({
  tone,
  icon,
  title,
  text,
  busy,
  alert,
  children,
}: {
  tone: 'info' | 'success' | 'warning' | 'danger'
  icon: ReactNode
  title: string
  text?: string
  busy?: boolean
  /** Announce it at once (a refusal). */
  alert?: boolean
  children?: ReactNode
}) {
  return (
    <div className="fw-floor-state" data-tone={tone} aria-busy={busy || undefined} role={alert ? 'alert' : undefined}>
      <span className="fw-floor-state-icon" aria-hidden="true">
        {icon}
      </span>
      <h1 className="fw-floor-state-title">{title}</h1>
      {text ? <p className="fw-floor-state-text">{text}</p> : null}
      {children}
    </div>
  )
}
