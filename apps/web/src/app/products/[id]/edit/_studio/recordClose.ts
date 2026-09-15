export function closeStudioRecord(options: {
  opened: number
  canChangeEditor: () => boolean
  back: () => void
  clear: () => void
}): number {
  if (!options.canChangeEditor()) return options.opened
  if (options.opened > 0) {
    options.back()
    return options.opened - 1
  }
  options.clear()
  return 0
}
