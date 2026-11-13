/**
 * A PDF made here printed from the tablet (B-W2b-387: the cartons' marks when the station's label printer cannot take them),
 * as Kits prints its DDT (B-W2a-76): the file in a hidden frame and the browser's print, or a new tab where the frame
 * cannot print. The frame and its address go a minute later.
 */
export function printPdf(bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.src = url
  frame.onload = () => {
    try {
      frame.contentWindow?.print()
    } catch {
      window.open(url, '_blank', 'noopener')
    }
    window.setTimeout(() => {
      frame.remove()
      URL.revokeObjectURL(url)
    }, 60_000)
  }
  document.body.appendChild(frame)
}
