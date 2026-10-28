'use client'

/**
 * FloorFrame — the frame of every floor screen (gap G2, SCR-022): the floor density, a top bar, the offline banner,
 * the screen's one job, and the big action bar at the thumb's side.
 *
 *   <FloorFrame
 *     header={<FloorHeader start={<OperatorChip … />} title="Cucitura · Linea 2" end={<FloorHelpButton … />} />}
 *     banner={<OfflineBanner … />}
 *     actions={<FloorActionBar actions={[…]} />}
 *     overlay={<IdleOverlay … />}
 *     muted={device.muted}
 *   >
 *     …the screen…
 *   </FloorFrame>
 *
 * - Density: the frame is a `DensityProvider` (TypeScript reads the tier's numbers) AND carries `data-density` on its
 *   own root, so the CSS tokens `--nds-density-*` hold inside it and a pop-up portalled to `<body>` can follow when the
 *   app also sets it on `<html>` (`densityAttrs`). Default `floor`.
 * - No rail, no sub-sidebar, no command palette (A2 §1.5): header, banner, content, action bar — four rows.
 * - The frame is a size container: under 760 px of its OWN width it takes the phone layout (16 px gutter, the title on
 *   its own line, the main action on its own row), so a frame inside a page behaves like the screen it stands for.
 * - `muted` is the device's sound setting; every `useConfirmFeedback()` inside the frame honours it.
 * - `fill` (default true) makes the frame the whole viewport (`100dvh`, the content scrolls between the bars). The
 *   catalogue shows frames inside a page and turns it off, with `landmarks={false}` so one page does not hold several
 *   `<main>`s.
 * - Every word comes from the app (Italian or English, the person's language): the frame adds none.
 */
import { createContext, useCallback, useContext, type ReactNode } from 'react'

import { DensityProvider } from '../lib/density'
import { densityAttrs, type DensityName } from '../tokens/density'
import { confirmFeedback, type ConfirmFeedbackResult, type FeedbackKind } from './confirmFeedback'
import './floor.css'

interface FloorSettings {
  muted: boolean
}

const FloorSettingsContext = createContext<FloorSettings>({ muted: false })

export interface FloorFrameProps {
  /** The top bar — usually a `FloorHeader`. */
  header?: ReactNode
  /** Under the top bar — the `OfflineBanner`. */
  banner?: ReactNode
  /** The bottom bar — a `FloorActionBar`. */
  actions?: ReactNode
  /** Above everything — the `IdleOverlay`. */
  overlay?: ReactNode
  children?: ReactNode
  /** Default `floor`. */
  density?: DensityName
  /** The device's sound setting, for `useConfirmFeedback`. Default false. */
  muted?: boolean
  /** Fill the viewport. Default true. */
  fill?: boolean
  /** `<header>`, `<main>` and `<footer>` landmarks. Default true; off where several frames share one page. */
  landmarks?: boolean
  /** The content's accessible name (the screen's title). */
  label?: string
  id?: string
  className?: string
}

export function FloorFrame({
  header,
  banner,
  actions,
  overlay,
  children,
  density = 'floor',
  muted = false,
  fill = true,
  landmarks = true,
  label,
  id,
  className,
}: FloorFrameProps) {
  const Header = landmarks ? 'header' : 'div'
  const Main = landmarks ? 'main' : 'div'
  const Footer = landmarks ? 'footer' : 'div'
  return (
    <DensityProvider value={density}>
      <FloorSettingsContext.Provider value={{ muted }}>
        <div id={id} className={['nds-floor-frame', className ?? ''].filter(Boolean).join(' ')} data-fill={fill ? 'true' : 'false'} {...densityAttrs(density)}>
          {header ? <Header className="nds-floor-frame-header">{header}</Header> : null}
          {banner ? <div className="nds-floor-frame-banner">{banner}</div> : null}
          <Main className="nds-floor-frame-main" aria-label={label} role={!landmarks && label ? 'region' : undefined}>
            {children}
          </Main>
          {actions ? <Footer className="nds-floor-frame-actions">{actions}</Footer> : null}
          {overlay}
        </div>
      </FloorSettingsContext.Provider>
    </DensityProvider>
  )
}

export interface FloorHeaderProps {
  /** Start side — the `OperatorChip`. */
  start?: ReactNode
  /** The screen's or station's name. */
  title?: ReactNode
  /** End side — language, `FloorHelpButton`. */
  end?: ReactNode
}

/** The floor top bar: operator, title, then language and help at the end. */
export function FloorHeader({ start, title, end }: FloorHeaderProps) {
  return (
    <div className="nds-floor-header">
      {start ? <div className="nds-floor-header-start">{start}</div> : null}
      {title ? <div className="nds-floor-header-title">{title}</div> : null}
      {end ? <div className="nds-floor-header-end">{end}</div> : null}
    </div>
  )
}

/** The device's floor settings in force here (outside a frame: not muted). */
export function useFloorSettings(): FloorSettings {
  return useContext(FloorSettingsContext)
}

/**
 * `confirmFeedback` bound to the frame's mute setting:
 *   const feedback = useConfirmFeedback()
 *   feedback('success', rowRef.current)
 */
export function useConfirmFeedback(): (kind: FeedbackKind, target?: Element | null) => ConfirmFeedbackResult {
  const { muted } = useFloorSettings()
  return useCallback((kind: FeedbackKind, target?: Element | null) => confirmFeedback(kind, { target, muted }), [muted])
}
