'use client'

import { useState } from 'react'

import { FloorFrame, PinPad } from '@/design-system/floor'
import type { DensityName } from '@/design-system/tokens/density'
import { Button } from '@/design-system/primitives'

import type { FloorCopy } from './floorCopy'
import s from './floorCatalog.module.css'

/** The made-up PIN these examples accept. */
const DEMO_PIN = '246810'
const TRIES = 3

/*
 * G4 PIN pad on the floor tier (80 px keys, 8 mm apart) and on comfortable (60 px), each with its own fake check:
 * 246810 is right; three wrong PINs lock the pad. Verify: only dots ever show; Tab reaches all 12 keys; digits,
 * Backspace and Escape work with focus in the pad; a locked pad's keys stay focusable and do nothing.
 */
function DemoPad({ copy, density }: { copy: FloorCopy; density: DensityName }) {
  const [left, setLeft] = useState(TRIES)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; tone: 'danger' | 'success' | 'info' } | null>(null)
  const locked = left === 0
  return (
    <div className={s.example}>
      <span className={s.caption}>{density}</span>
      <div className={s.screen}>
        <FloorFrame fill={false} landmarks={false} density={density} label={copy.pin}>
          <div className={s.centre}>
            <PinPad
              label={copy.pin}
              enteredLabel={copy.pinEntered}
              clearLabel={copy.pinClear}
              backLabel={copy.pinBack}
              locked={locked}
              busy={busy}
              message={locked ? copy.pinLocked : message?.text}
              messageTone={locked ? 'danger' : message?.tone}
              onSubmit={(pin) => {
                setBusy(true)
                setMessage({ text: copy.pinChecking, tone: 'info' })
                setTimeout(() => {
                  setBusy(false)
                  if (pin === DEMO_PIN) {
                    setLeft(TRIES)
                    setMessage({ text: copy.pinWelcome, tone: 'success' })
                  } else {
                    setLeft((n) => n - 1)
                    setMessage({ text: copy.pinWrong(left - 1), tone: 'danger' })
                  }
                }, 400)
              }}
            />
          </div>
        </FloorFrame>
      </div>
      {locked ? (
        <div>
          <Button
            size="sm"
            onClick={() => {
              setLeft(TRIES)
              setMessage(null)
            }}
          >
            Unlock (demo)
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function PinPadExample({ copy }: { copy: FloorCopy }) {
  return (
    <div className={s.example} id="floor-pin-example">
      <h3 className={s.title}>PinPad — sign-in, sign-off and step-up on a shared tablet</h3>
      <p className={s.note}>Fake check: {DEMO_PIN} is right; three wrong PINs lock the pad.</p>
      <div className={s.pair}>
        <DemoPad copy={copy} density="floor" />
        <DemoPad copy={copy} density="comfortable" />
      </div>
    </div>
  )
}
