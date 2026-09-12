// Nexus adapter for Impact 7.2.0. Loaded as a dependency of theme.js.
// Shopify/Impact remain authoritative for option selection, price, stock and cart IDs.
const selections = new WeakMap();
export function beginSelection(picker, form) {
  const previous = selections.get(form);
  const state = { sequence: (previous?.sequence ?? 0) + 1, controls: previous?.controls ?? new Map(), managed: picker.hasAttribute('data-nexus-content') };
  selections.set(form, state);
  if (state.managed) {
    for (const button of Array.from(form.elements).filter(el => el.type === 'submit')) {
      if (!state.controls.has(button)) state.controls.set(button, button.disabled);
      button.disabled = true;
    }
    form.setAttribute('aria-busy', 'true');
    form.querySelectorAll('.shopify-payment-button').forEach(el => { el.inert = true; });
  }
  return state;
}
export const isCurrentSelection = (form, state) => selections.get(form) === state;
export function finishSelection(form, state, variant, error) {
  if (!isCurrentSelection(form, state) || !state.managed) return;
  form.removeAttribute('aria-busy');
  if (error) {
    // A failed option request leaves no purchasable variant, even if an old ID remains in the DOM.
    const input = form.elements.namedItem('id');
    if (input) input.value = '';
    form.querySelectorAll('.shopify-payment-button').forEach(el => { el.inert = true; });
    const message = document.getElementById('error-announcement');
    if (message) message.textContent = form.dataset.nexusError || document.documentElement.dataset.nexusVariantError || 'The selected options could not be loaded. Select your options again.';
    return;
  }
  for (const [button, disabled] of state.controls) if (button.isConnected) button.disabled = disabled || !variant?.available;
  form.querySelectorAll('.shopify-payment-button').forEach(el => { el.inert = !variant?.available; });
  selections.set(form, { ...state, controls: new Map() });
  const message = document.getElementById('error-announcement');
  if (message) message.textContent = '';
}

export function applyContentSections(fragment, picker) {
  if (!picker.hasAttribute('data-nexus-content') || !picker.hasAttribute('update-url')) return;
  // Only product-template sections participate. Header, cart, reviews and app blocks retain their state.
  const nodes = fragment.querySelectorAll('[data-nexus-section]');
  for (const next of nodes) {
    const current = document.querySelector(`[data-nexus-section="${CSS.escape(next.dataset.nexusSection)}"]`);
    if (!current || current.dataset.nexusProduct !== next.dataset.nexusProduct) continue;
    const focusedId = current.contains(document.activeElement) ? document.activeElement.id : '';
    current.replaceWith(next.cloneNode(true));
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
}

// Prevent form submission during pending/failed option requests, including Enter and quick-buy.
document.addEventListener('submit', event => {
  const form = event.target, state = selections.get(form);
  if (state?.managed && (form.hasAttribute('aria-busy') || !form.elements.namedItem('id')?.value)) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);

class NexusImpactFeatures extends HTMLElement {
  connectedCallback() {
    this.abort?.abort();
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.cards = [...this.querySelectorAll('.features-card')];
    this.toggle = this.querySelector('.features-show-more');
    this.expanded = false;
    this.updateCards();
    this.addEventListener('click', event => {
      const card = event.target.closest('.features-card');
      if (card) {
        const dialog = this.querySelector(`#${CSS.escape(card.getAttribute('aria-controls'))}`);
        if (!dialog) return;
        this.activeDialog?.close();
        this.opener = card;
        dialog.querySelectorAll('img[data-src]').forEach(img => {
          img.src = img.dataset.src;
          delete img.dataset.src;
        });
        this.activeDialog = dialog;
        dialog.showModal();
      } else if (event.target.closest('.features-show-more')) {
        const previousTop = this.toggle.getBoundingClientRect().top;
        this.expanded = !this.expanded;
        this.updateCards();
        if (this.expanded && event.detail === 0) {
          // Keyboard users continue through the newly revealed cards in order.
          this.cards[4]?.focus();
        } else if (!this.expanded) {
          // Preserve the disclosure's viewport position when the grid shrinks.
          window.scrollBy({ top: this.toggle.getBoundingClientRect().top - previousTop, behavior: 'instant' });
          this.toggle.focus({ preventScroll: true });
        }
      } else if (event.target.closest('.features-modal__close')) {
        this.activeDialog?.close();
      } else if (event.target === this.activeDialog) {
        const bounds = this.activeDialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.activeDialog.close();
      }
    }, { signal });
    this.querySelectorAll('dialog').forEach(dialog => {
      dialog.addEventListener('close', () => {
        if (this.activeDialog !== dialog) return;
        this.activeDialog = null;
        if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
      }, { signal });
      dialog.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length && !el.closest('[inert]'));
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }, { signal });
    });
  }
  updateCards() {
    this.cards.forEach((card, index) => { card.hidden = !this.expanded && index >= 4; });
    if (!this.toggle) return;
    this.toggle.hidden = this.cards.length <= 4;
    this.toggle.setAttribute('aria-expanded', String(this.expanded));
    this.toggle.querySelector('[data-feature-toggle-label]').textContent = this.expanded ? this.dataset.less : this.dataset.more;
    const count = this.toggle.querySelector('[data-feature-count]');
    count.textContent = String(Math.max(0, this.cards.length - 4));
    count.hidden = this.expanded;
  }
  disconnectedCallback() {
    this.activeDialog?.close();
    this.activeDialog = null;
    this.abort?.abort();
  }
}
if (!customElements.get('nexus-impact-features')) customElements.define('nexus-impact-features', NexusImpactFeatures);
