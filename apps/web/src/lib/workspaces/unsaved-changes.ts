export interface UnsavedChanges {
  isDirty: () => boolean
  save: () => Promise<void> | void
  discard: () => void
  canDiscard?: () => boolean
}
const forms = new Map<string, UnsavedChanges>()
export function registerProfileChanges(id: string, form: UnsavedChanges) {
  forms.set(id, form)
  return () => { if (forms.get(id) === form) forms.delete(id) }
}
export function pendingProfileChanges() { return [...forms.values()].filter(form => form.isDirty()) }
export function navigateBusinessProfile(href: string) {
  if (pendingProfileChanges().length === 0) { window.location.assign(href); return }
  window.dispatchEvent(new CustomEvent('nexus:profile-navigation', { detail: { href } }))
}
