/** Honest-copy §6. The mode comes from the actual review destination, never the channel name. */
export function reviewCopy(mode: 'check' | 'synchronize') {
  return mode === 'synchronize'
    ? { menu: 'Review and synchronize…', title: 'Review and synchronize', subtitle: 'Review the exact destination and changes before synchronization.' }
    : { menu: 'Check before sending', title: 'Check before sending', subtitle: 'Nothing is sent from here.' }
}
