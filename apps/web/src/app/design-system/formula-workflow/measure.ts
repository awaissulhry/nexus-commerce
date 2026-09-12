/** Read-only instrumentation for the opt-in local browser fixture. */
export function measureFormulaDialog() {
  const dialog = document.querySelector<HTMLElement>('[aria-modal="true"]')
  if (!dialog) return null
  const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const luminance = (channels: number[]) => channels.map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0)
  const surface = (element: Element): string => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const background = getComputedStyle(current).backgroundColor
      if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background
    }
    return 'rgb(255, 255, 255)'
  }
  const text = [...dialog.querySelectorAll<HTMLElement>('*')].filter(element =>
    [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && !element.closest(':disabled, [aria-disabled="true"]') && element.getClientRects().length,
  ).map(element => {
    const style = getComputedStyle(element)
    const a = luminance(rgb(style.color)); const b = luminance(rgb(surface(element)))
    return { text: element.textContent?.trim().slice(0, 60), ratio: Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2)) }
  })
  const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select')].filter(element => !element.matches(':disabled') && element.getClientRects().length).map(element => {
    const box = element.getBoundingClientRect()
    return { name: element.getAttribute('aria-label') ?? element.textContent?.trim(), width: Math.round(box.width), height: Math.round(box.height) }
  })
  const body = dialog.querySelector<HTMLElement>('.nds-modal-b')!
  return { viewport: innerWidth, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    dialogWidth: dialog.clientWidth, dialogScrollWidth: dialog.scrollWidth, bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth,
    minimumTextContrast: Math.min(...text.map(item => item.ratio)), lowContrast: text.filter(item => item.ratio < 7), smallTargets: controls.filter(item => item.width < 44 || item.height < 44),
    focus: document.activeElement?.getAttribute('aria-label'), controls }
}
