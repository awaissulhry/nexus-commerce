import type { Grains } from '../../../sales/quotes/model'
import type { BenchCheck, StyleConfigurator } from '../../../sales/quotes/record/configurator/api'
import type { DraftPick } from '../../../sales/quotes/record/configurator/model'
import type { ConfiguratorModel } from '../../../sales/quotes/record/configurator/view/ConfiguratorView'

/**
 * Test a combination (B-W2b-340; SAL-249): the bench's view model — the shared configurator view in BENCH mode (no line, no
 * price card, no artwork, nothing saved), the style picker, the draft, and B-W2b-229's check of the combination. The values
 * the check took by default are shown chosen beside the person's picks.
 */
export function benchModelOf(input: {
  styles: { value: string; label: string }[]
  styleId: string
  style: StyleConfigurator | null
  read: ConfiguratorModel['read']
  draft: DraftPick[]
  check: { status: 'idle' | 'checking' | 'ready' | 'error'; value: BenchCheck | null }
  grains: Grains
}): ConfiguratorModel {
  const picked = new Set(input.draft.map((pick) => pick.valueId))
  const defaults: DraftPick[] = (input.check.value?.chosen ?? [])
    .filter((entry) => entry.byDefault && !picked.has(entry.valueId))
    .map((entry) => ({ valueId: entry.valueId, groupId: entry.groupId, text: '', byDefault: true, colourId: null, itemId: null, itemColourId: null }))
  return {
    mode: 'BENCH',
    read: input.read,
    style: input.style,
    line: null,
    draft: [...input.draft, ...defaults],
    preview: { status: 'idle', value: null },
    grains: input.grains,
    changed: false,
    saveHeld: { key: 'bench.nothingSaved' },
    saving: false,
    keepPrice: false,
    notice: null,
    artwork: { uploading: [], problem: null },
    pictureUrl: input.style?.picture ? `/api/product/pictures/${encodeURIComponent(input.style.picture.fileId)}` : null,
    bench: { styles: input.styles, styleId: input.styleId, check: input.check },
  }
}
