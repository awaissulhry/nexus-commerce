/**
 * How an app gives the floor `ScanInput` its camera: a `CameraScanner` over `@zxing/browser` (a dependency of this app,
 * not of the design system). ZXing loads only when the camera opens, so a page that never opens it never ships it.
 * The factory app keeps its own copy of these few lines.
 */
import type { CameraScanner } from '@/design-system/floor'

export const zxingCamera: CameraScanner = {
  async start(video, onCode) {
    const { BrowserMultiFormatReader } = await import('@zxing/browser')
    const reader = new BrowserMultiFormatReader()
    // The rear camera on a tablet or phone.
    const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, video, (result) => {
      if (result) onCode(result.getText())
    })
    return () => controls.stop()
  },
}

/**
 * A scanner, for a page without one: the code as keystrokes 0 ms apart, then Enter, sent to whatever has focus — the
 * way a USB wedge types. The floor `ScanInput` reads it as a `wedge` scan.
 */
export function simulateWedgeScan(code: string): void {
  const target = document.activeElement ?? document.body
  for (const key of [...code, 'Enter']) target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
