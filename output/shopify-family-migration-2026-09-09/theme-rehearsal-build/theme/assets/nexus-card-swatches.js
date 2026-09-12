// Preserve the merchant's hover strip, with native variant identities and an
// entire server-rendered card swap so price, badges and quick-buy change together.
let replacementId = 0;
const pendingFits = new Set();
let fitFrame = 0;
function scheduleFit(card) {
  pendingFits.add(card);
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    // Read every card before changing any layout. Per-card read/write cycles
    // otherwise force repeated page layouts while the collection initializes.
    const updates = [...pendingFits].filter(card => card.isConnected).map(card => card.measureFit());
    pendingFits.clear();
    updates.forEach(update => update?.());
  });
}
class NexusCardSwatches extends HTMLElement {
  connectedCallback() {
    this.abort = new AbortController();
    this.observer = new ResizeObserver(() => scheduleFit(this)); this.observer.observe(this);
    scheduleFit(this);
    this.addEventListener('click', event => {
      const swatch = event.target.closest('[data-nexus-swatch]');
      if (!swatch || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); void this.select(swatch, event.detail === 0);
    }, { signal: this.abort.signal });
  }
  disconnectedCallback() { this.abort?.abort(); this.observer?.disconnect(); pendingFits.delete(this); }
  measureFit() {
    const swatches = [...this.querySelectorAll('[data-nexus-swatch]')], more = this.querySelector('[data-nexus-more]');
    if (!more) return;
    const style = getComputedStyle(this), gap = parseFloat(style.gap) || 8;
    const available = this.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
    const capacity = Math.max(1, Math.floor((available + gap) / (48 + gap)));
    const visible = swatches.length > capacity ? Math.max(1, capacity - 1) : capacity;
    return () => {
      swatches.forEach((swatch, index) => { const hidden = index >= visible; if (swatch.hidden !== hidden) swatch.hidden = hidden; });
      const hidden = swatches.length <= visible, label = `+${swatches.length - visible}`;
      if (more.hidden !== hidden) more.hidden = hidden;
      if (more.textContent !== label) more.textContent = label;
    };
  }
  async select(swatch, restoreFocus) {
    const card = this.closest('product-card'); if (!card) return;
    const sequence = this.sequence = (this.sequence || 0) + 1;
    const buttons = [...card.querySelectorAll('.product-card__quick-buy, .product-card__mobile-quick-buy-button')];
    buttons.forEach(el => { el.inert = true; }); card.setAttribute('aria-busy', 'true');
    card.querySelector('[data-nexus-card-error]')?.remove();
    try {
      const url = new URL(swatch.href); url.searchParams.set('view', 'nexus-card');
      const preview = new URL(window.location.href).searchParams.get('preview_theme_id'); if (preview) url.searchParams.set('preview_theme_id', preview);
      const response = await fetch(url, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) throw new Error('Variant card unavailable');
      const fragment = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = fragment.querySelector('product-card');
      if (!next || next.dataset.nexusVariant !== swatch.dataset.variantId) throw new Error('Variant card identity differs');
      if (this.sequence !== sequence || !card.isConnected) return;
      // Keep the original placement and styling. A shopper selection never edits merchant order.
      next.className = card.className; next.removeAttribute('reveal-js');
      if (card.dataset.nexusCard) next.dataset.nexusCard = card.dataset.nexusCard;
      const suffix = `--nexus-${++replacementId}`, ids = new Map();
      next.querySelectorAll('[id]').forEach(el => { ids.set(el.id, el.id + suffix); el.id += suffix; });
      next.querySelectorAll('[for],[form],[aria-controls],[aria-labelledby]').forEach(el => {
        for (const key of ['for', 'form', 'aria-controls', 'aria-labelledby']) if (el.hasAttribute(key)) el.setAttribute(key, el.getAttribute(key).split(' ').map(id => ids.get(id) || id).join(' '));
      });
      // Retain the collection's filtered options when the card fragment comes from a product URL.
      const options = this.cloneNode(true);
      options.querySelectorAll('[data-nexus-swatch]').forEach(el => { const selected = el.dataset.nexusGroup === swatch.dataset.nexusGroup; el.classList.toggle('is-selected', selected); if (selected) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current'); });
      next.querySelector('nexus-card-swatches')?.replaceWith(options);
      const collection = card.closest('nexus-collection'), stored = collection?.cards?.find(c => c.element === card);
      if (stored) stored.element = next;
      card.replaceWith(next);
      // Preserve keyboard focus; pointer users retain the exact hover presentation.
      if (restoreFocus) next.querySelector('[data-nexus-swatch][aria-current="true"]')?.focus({ preventScroll: true });
    } catch (error) {
      if (this.abort.signal.aborted || this.sequence !== sequence || !card.isConnected) return;
      const message = document.createElement('p'); message.dataset.nexusCardError = ''; message.setAttribute('role', 'alert'); message.className = 'text-sm'; message.textContent = document.documentElement.dataset.nexusVariantError; card.append(message);
    } finally {
      if (this.sequence === sequence && card.isConnected) { buttons.forEach(el => { el.inert = false; }); card.removeAttribute('aria-busy'); }
    }
  }
}
if (!customElements.get('nexus-card-swatches')) customElements.define('nexus-card-swatches', NexusCardSwatches);
document.addEventListener('submit', event => {
  if (event.target.closest('product-card[aria-busy="true"]')) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
