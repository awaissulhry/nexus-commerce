'use client'

import { useState } from 'react'
import { Camera, Keyboard, ScanLine } from 'lucide-react'

import { FloorButton, FloorFrame, FloorList, FloorListRow, ScanInput, type ScanSource } from '@/design-system/floor'

import type { FloorCopy } from './floorCopy'
import s from './floorCatalog.module.css'
import { simulateWedgeScan, zxingCamera } from './zxingCamera'

const SOURCE_ICON = { wedge: <ScanLine />, typed: <Keyboard />, camera: <Camera /> } as const

/*
 * G3 scan input on the floor tier. "Simulate a scanner" types a made-up code 0 ms apart and Enter, to whatever has focus,
 * as a USB wedge does: with focus on that button (outside any text field) the document reader takes it, and the list
 * shows `scanner`. Typing slowly in the field and pressing Enter shows `typed`. The camera button uses the injected ZXing
 * scanner (`zxingCamera.ts`) and asks for permission. Verify the green flash and tick on each read, light and dark.
 */
export function ScanInputExample({ copy }: { copy: FloorCopy }) {
  const [reads, setReads] = useState<{ code: string; source: ScanSource; n: number }[]>([])
  const [n, setN] = useState(417)
  return (
    <div className={s.example} id="floor-scan-example">
      <h3 className={s.title}>ScanInput — scanner first, camera fallback, always listening</h3>
      <div className={s.screen}>
        <FloorFrame fill={false} landmarks={false} label={copy.scan}>
          <ScanInput
            label={copy.scan}
            hint={copy.scanHint}
            placeholder="BND-000417"
            scannedLabel={copy.scanned}
            keyboardLabel={copy.type}
            camera={{ scanner: zxingCamera, startLabel: copy.camera, stopLabel: copy.cameraStop, errorLabel: copy.cameraError }}
            keepFocus={false}
            onScan={(code, source) => setReads((r) => [{ code, source, n: Date.now() }, ...r].slice(0, 3))}
          />
          <div className={s.controls}>
            <FloorButton
              size="sm"
              onClick={() => {
                simulateWedgeScan(`BND-000${n}`)
                setN((v) => v + 1)
              }}
            >
              Simulate a scanner
            </FloorButton>
          </div>
          {reads.length > 0 ? (
            <FloorList label={copy.scan}>
              {reads.map((r) => (
                <FloorListRow key={r.n} icon={SOURCE_ICON[r.source]} tone="success" title={r.code} meta={copy.source[r.source]} />
              ))}
            </FloorList>
          ) : null}
        </FloorFrame>
      </div>
    </div>
  )
}
