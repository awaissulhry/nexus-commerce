'use client'

import { cloneElement, isValidElement, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { nextTooltipInteraction, type TooltipInteraction, type TooltipInteractionEvent } from './tooltipInteraction'

export interface TooltipProps {
  /** tooltip text/content shown above the trigger on hover/focus */
  label: ReactNode
  className?: string
  children: ReactNode
  /** Escape scroll containers and sticky headers. Inherited from TooltipPortalProvider. */
  portal?: boolean
}

const PortalContext = createContext(false)
const DisabledContext = createContext(false)

/** Configure hints for a scrolling host. Disabled hosts render only the labelled triggers. */
export function TooltipPortalProvider({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  const inheritedDisabled = useContext(DisabledContext)
  return <DisabledContext.Provider value={inheritedDisabled || disabled}><PortalContext.Provider value>{children}</PortalContext.Provider></DisabledContext.Provider>
}

/** Hover/focus tooltip. Scrolling hosts opt into a viewport-positioned portal. */
export function Tooltip({ label, className, children, portal }: TooltipProps) {
  const inheritedPortal = useContext(PortalContext)
  const disabled = useContext(DisabledContext)
  if (disabled) return <>{children}</>
  if (portal ?? inheritedPortal) return <PortalTooltip label={label} className={className}>{children}</PortalTooltip>
  return (
    <span className={`nds-tooltip${className ? ` ${className}` : ''}`}>
      {children}
      <span className="tip" role="tooltip">{label}</span>
    </span>
  )
}

function PortalTooltip({ label, className, children }: TooltipProps) {
  const [interaction, setInteraction] = useState<TooltipInteraction>({ open: false, keyboardFocus: false, suppressed: false })
  const currentInteraction = useRef(interaction)
  const send = useCallback((event: TooltipInteractionEvent) => {
    // Tab's default focus change can run before React commits the document key handler.
    currentInteraction.current = nextTooltipInteraction(currentInteraction.current, event)
    setInteraction(currentInteraction.current)
  }, [])
  const open = interaction.open
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const portalRef = useRef<HTMLSpanElement>(null)
  const id = useId()
  const [position, setPosition] = useState<{ left: number; top: number; arrow: number; bottom: boolean } | null>(null)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') send('dismiss') }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [open, send])
  useEffect(() => {
    if (!interaction.suppressed) return
    const rearm = (event: KeyboardEvent) => {
      // Tabbing inside an open disclosure is not a fresh visit to its trigger.
      if (anchorRef.current?.querySelector('[aria-expanded="true"]')) return
      if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) send('keyboard-navigation')
    }
    document.addEventListener('keydown', rearm, true)
    return () => document.removeEventListener('keydown', rearm, true)
  }, [interaction.suppressed, send])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!anchorRef.current || !tipRef.current) return
      const anchor = anchorRef.current.getBoundingClientRect()
      const tip = tipRef.current.getBoundingClientRect()
      const pad = 8, gap = 8
      const end = className?.split(/\s+/).includes('nds-tooltip--end')
      const center = anchor.left + anchor.width / 2
      const left = Math.max(pad, Math.min(end ? anchor.right - tip.width : center - tip.width / 2, document.documentElement.clientWidth - tip.width - pad))
      const bottom = anchor.top - tip.height - gap < pad && anchor.bottom + gap + tip.height <= window.innerHeight - pad
      const top = bottom ? anchor.bottom + gap : Math.max(pad, anchor.top - gap - tip.height)
      setPosition({ left, top, arrow: Math.max(10, Math.min(center - left, tip.width - 10)), bottom })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = new ResizeObserver(place)
    if (tipRef.current) observer.observe(tipRef.current)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      observer.disconnect()
    }
  }, [open, label, className])
  const trigger = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { 'aria-describedby': [children.props['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined })
    : children
  return (
    <span
      ref={anchorRef}
      className={`nds-tooltip${className ? ` ${className}` : ''}`}
      aria-describedby={open ? id : undefined}
      onPointerEnter={event => { if (event.pointerType !== 'touch' && event.buttons === 0) send('pointer-enter') }}
      onPointerMove={event => {
        // Removing an overlay may expose its trigger without the pointer actually moving.
        if (currentInteraction.current.suppressed && event.pointerType !== 'touch' && event.buttons === 0 && (event.movementX !== 0 || event.movementY !== 0)) send('pointer-move')
      }}
      onPointerLeave={event => { if (!(event.relatedTarget instanceof Node) || !portalRef.current?.contains(event.relatedTarget)) send('pointer-leave') }}
      onFocus={event => send(event.target.matches(':focus-visible') ? 'keyboard-focus' : 'pointer-focus')}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) send('blur') }}
      onPointerDownCapture={() => send('dismiss')}
      onDragStartCapture={() => send('dismiss')}
      onClickCapture={() => send('dismiss')}
      onKeyDownCapture={event => { if (['Escape', 'Enter', ' '].includes(event.key)) send('dismiss') }}
    >
      {trigger}
      {open && createPortal(
        <span ref={portalRef} className={`nds-tooltip nds-tooltip--portal${className ? ` ${className}` : ''}`} data-placement={position?.bottom ? 'bottom' : 'top'} style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden', '--nds-tooltip-arrow-x': `${position?.arrow ?? 0}px` } as CSSProperties}
          onPointerEnter={() => send('pointer-enter')}
          onPointerLeave={event => { if (!(event.relatedTarget instanceof Node) || !anchorRef.current?.contains(event.relatedTarget)) send('pointer-leave') }}>
          <span ref={tipRef} id={id} className="tip" role="tooltip">{label}</span>
        </span>,
        document.body,
      )}
    </span>
  )
}
