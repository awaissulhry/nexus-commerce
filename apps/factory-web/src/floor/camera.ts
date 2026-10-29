import type { CameraScanner } from '@nexus/ui/floor'

/**
 * The floor ScanInput's camera: a `CameraScanner` over `@zxing/browser` (a dependency of this app, not of the design
 * system), as the DS catalogue's `zxingCamera.ts` shows. ZXing loads only when the camera opens, so a screen whose
 * camera stays closed never ships it.
 */
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
