'use client'

import { Upload } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'

/** The band's Import and Items & prices' Import price list: the button, held with its reason (the wizard is the container's). */
export function ImportButton({ label, held, onOpen }: { label: string; held: string | null; onOpen?: () => void }) {
  return (
    <Button size="sm" heldReason={held} onClick={() => onOpen?.()}>
      <Upload size={13} aria-hidden /> {label}
    </Button>
  )
}
