import type { CameraScanner } from '@nexus/ui/floor'

/**
 * The serial's camera on New case (Owner answer 11-10: the factory phone or tablet camera, no device spend): a
 * `CameraScanner` over `@zxing/browser` (a dependency of this app), as the floor's and the claim link's. The Office view may
 * not import the Floor's or the Links' own copy (check-view-boundaries), so this page keeps its own few lines. ZXing loads
 * only when the camera opens.
 */
export const serialCamera: CameraScanner = {
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
