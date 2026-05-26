'use client'

// UC.8 — Shared preview skin toggle.
//
// Both live previews duplicated the same Mobile/Desktop toggle (same
// structure + icons, differing only in active/inactive colours because
// the headers differ — Amazon dark, eBay light). Extracted here; each
// channel passes its own active/inactive class strings so the PDP skins
// stay channel-specific while the control is shared + consistent.

import { Smartphone, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'

export type Skin = 'mobile' | 'desktop'

export interface PreviewSkinToggleProps {
  skin: Skin
  onChange: (skin: Skin) => void
  /** Classes for the selected button (channel-themed). */
  activeClass: string
  /** Classes for the unselected buttons. */
  inactiveClass: string
}

const BASE =
  'inline-flex items-center gap-1 h-6 px-2 text-[11px] rounded border transition-colors'

export default function PreviewSkinToggle({
  skin,
  onChange,
  activeClass,
  inactiveClass,
}: PreviewSkinToggleProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange('mobile')}
        className={cn(BASE, skin === 'mobile' ? activeClass : inactiveClass)}
        title="Mobile preview"
      >
        <Smartphone className="w-3 h-3" /> Mobile
      </button>
      <button
        type="button"
        onClick={() => onChange('desktop')}
        className={cn(BASE, skin === 'desktop' ? activeClass : inactiveClass)}
        title="Desktop preview"
      >
        <Monitor className="w-3 h-3" /> Desktop
      </button>
    </div>
  )
}
