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
// A card inserted under a still pointer is not :hover until the pointer moves,
// so the strip and quick-buy collapsed after every pointer selection. Pin the
// hover presentation until the browser tracks the pointer on the new card.
function pinHover(card) {
  card.setAttribute('data-nexus-hover', '');
  const controller = new AbortController(), signal = controller.signal;
  const release = () => { card.removeAttribute('data-nexus-hover'); controller.abort(); };
  // After a first move inside, native :hover and pointerleave take over.
  window.addEventListener('pointermove', event => { if (!card.contains(event.target)) release(); }, { capture: true, passive: true, once: true, signal });
  window.addEventListener('scroll', release, { capture: true, passive: true, once: true, signal });
  card.addEventListener('pointerleave', release, { signal });
}
// A colour change must feel instant. The card fragments (2 KB each) are fetched once and kept, quietly ahead of time for
// cards on screen; the photos start loading when a mouse reaches the strip or a finger touches a picture; and at the tap
// the picture's own small photo stands in for the card's photo until the sharp photo is decoded.
const fragments = new Map();
const warmed = new Set();
const loadingPhotos = new Set();
const prefetchQueue = [];
let prefetching = 0;
let standInId = 0;
const fineHover = window.matchMedia('(hover: hover) and (pointer: fine)');
// Data saver and 2G get no fetch ahead of a tap.
const thrifty = () => { const connection = navigator.connection; return Boolean(connection && (connection.saveData || /2g/.test(connection.effectiveType || ''))); };
function fragmentUrl(swatch) {
  const url = new URL(swatch.href); url.searchParams.set('view', 'nexus-card');
  const preview = new URL(window.location.href).searchParams.get('preview_theme_id'); if (preview) url.searchParams.set('preview_theme_id', preview);
  return url.href;
}
function loadFragment(swatch) {
  const url = fragmentUrl(swatch);
  if (!fragments.has(url)) {
    const html = fetch(url, { signal: AbortSignal.timeout(20000) }).then(response => { if (!response.ok) throw new Error('Variant card unavailable'); return response.text(); });
    html.catch(() => fragments.delete(url));   // a failed fetch is tried again on the next tap
    fragments.set(url, html);
  }
  return fragments.get(url);
}
function readFragment(html, card) {
  const next = new DOMParser().parseFromString(html, 'text/html').querySelector('product-card');
  // The fragment renders outside the collection grid, so its image sizes miss the column count and the browser picks a
  // photo 5 to 10 times too big. Take the sizes of the card it replaces.
  if (next) for (const kind of ['primary', 'secondary']) {
    const sizes = card.querySelector(`.product-card__image--${kind}`)?.getAttribute('sizes'), img = next.querySelector(`.product-card__image--${kind}`);
    if (sizes && img) img.setAttribute('sizes', sizes);
  }
  return next;
}
// The photos a shopper sees on the card: the hover photo too while a mouse rests on it.
const showsSecondary = card => fineHover.matches && (card.matches(':hover') || card.hasAttribute('data-nexus-hover')) && card.classList.contains('product-card--show-secondary-media');
const shownPhotos = (card, secondary) => [card.querySelector('.product-card__image--primary'), secondary ? card.querySelector('.product-card__image--secondary') : null].filter(Boolean);
// Loads a colour's photos into the browser cache at the size its card will ask for. Urgent (a finger or a key on the
// picture) goes ahead of the store's background downloads.
function warmPhotos(swatch, card, urgent) {
  const secondary = showsSecondary(card), key = `${fragmentUrl(swatch)} ${secondary}`;
  if (warmed.has(key)) return;
  warmed.add(key);
  loadFragment(swatch).then(html => {
    const next = readFragment(html, card);
    if (next) for (const img of shownPhotos(next, secondary)) {
      const photo = new Image(); photo.decoding = 'async'; if (urgent) photo.fetchPriority = 'high'; loadingPhotos.add(photo);
      photo.onload = photo.onerror = () => loadingPhotos.delete(photo);
      for (const name of ['sizes', 'srcset', 'src']) { const value = img.getAttribute(name); if (value) photo.setAttribute(name, value); }
    }
  }, () => warmed.delete(key));
}
// Two fetches ahead of time at once, so a tap never waits behind a queue of them.
function queuePrefetch(task) { prefetchQueue.push(task); pumpPrefetch(); }
function pumpPrefetch() {
  while (prefetching < 2 && prefetchQueue.length) {
    const task = prefetchQueue.shift(); prefetching++;
    Promise.resolve().then(task).catch(() => {}).finally(() => { prefetching--; pumpPrefetch(); });
  }
}
// Resolves once the photo is loaded and decoded, or failed: never early on a photo still loading.
const photoReady = img => (img.complete && img.naturalWidth ? img.decode().catch(() => {}) : new Promise(resolve => {
  img.addEventListener('load', () => img.decode().catch(() => {}).then(resolve), { once: true });
  img.addEventListener('error', resolve, { once: true });
}));
const prefetchObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) { prefetchObserver.unobserve(entry.target); entry.target.querySelector('nexus-card-swatches')?.prefetch(); }
}, { rootMargin: '200px 0px' }) : null;
const standInHost = card => card.querySelector('.product-card__figure > a') || card.querySelector('.product-card__figure');
function showStandIn(card, swatch) {
  const host = standInHost(card), thumb = swatch.querySelector('img');
  if (!host || !thumb?.currentSrc) return null;
  let standIn = card.querySelector('.nexus-card-stand-in');
  if (!standIn) { standIn = document.createElement('img'); standIn.className = 'nexus-card-stand-in'; standIn.alt = ''; standIn.setAttribute('aria-hidden', 'true'); host.append(standIn); }
  clearTimeout(standIn.retireTimer); standIn.classList.remove('is-done', 'is-shown');
  const token = standIn.token = ++standInId;
  standIn.src = thumb.currentSrc;
  // Shown only once it can paint, so a stand-in that still loads never hides the old photo behind a blank frame.
  const show = () => { if (standIn.token === token) standIn.classList.add('is-shown'); };
  if (standIn.complete && standIn.naturalWidth) show(); else standIn.decode().then(show, () => {});
  return standIn;
}
function retireStandIn(standIn, token) {
  if (!standIn || standIn.token !== token) return;   // a newer tap owns it
  standIn.classList.add('is-done');
  standIn.retireTimer = setTimeout(() => standIn.remove(), 300);
}
class NexusCardSwatches extends HTMLElement {
  connectedCallback() {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.observer = new ResizeObserver(() => scheduleFit(this)); this.observer.observe(this);
    scheduleFit(this);
    this.card = this.closest('product-card'); if (this.card) prefetchObserver?.observe(this.card);
    this.addEventListener('click', event => {
      const swatch = event.target.closest('[data-nexus-swatch]');
      if (!swatch || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); void this.select(swatch, event.detail === 0);
    }, { signal });
    // The first sign of intent starts the photos: a mouse on the strip, a finger on a picture, keyboard focus.
    this.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') this.warm(); }, { signal });
    for (const type of ['pointerdown', 'focusin']) this.addEventListener(type, event => { const swatch = event.target.closest('[data-nexus-swatch]'); if (swatch) this.warm(swatch); }, { signal });
  }
  disconnectedCallback() { this.abort?.abort(); this.observer?.disconnect(); pendingFits.delete(this); if (this.card) prefetchObserver?.unobserve(this.card); }
  prefetch() {
    if (thrifty()) return;
    const idle = window.requestIdleCallback || (task => setTimeout(task, 200));
    idle(() => { if (this.isConnected) this.querySelectorAll('[data-nexus-swatch]:not(.is-selected)').forEach(swatch => queuePrefetch(() => loadFragment(swatch))); });
  }
  warm(only) {
    const card = this.closest('product-card'); if (!card) return;
    for (const swatch of only ? [only] : this.querySelectorAll('[data-nexus-swatch]:not([hidden])')) if (!swatch.classList.contains('is-selected')) warmPhotos(swatch, card, Boolean(only));
  }
  measureFit() {
    const swatches = [...this.querySelectorAll('[data-nexus-swatch]')], more = this.querySelector('[data-nexus-more]');
    if (!more) return;
    // The picture size comes from the theme style (48 px with a mouse, smaller on touch screens), without transforms.
    const style = getComputedStyle(this), gap = parseFloat(style.gap) || 8, size = parseFloat(getComputedStyle(swatches[0] || this).width) || 48;
    const available = this.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
    const capacity = Math.max(1, Math.floor((available + gap) / (size + gap) + 0.001));   // 0.001: sizes cut to fit exactly
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
    // Answer the tap at once: the picture is marked chosen and its photo stands in for the card's photo.
    const swatches = [...this.querySelectorAll('[data-nexus-swatch]')], before = swatches.find(el => el.classList.contains('is-selected'));
    const mark = chosen => swatches.forEach(el => { const selected = el === chosen; el.classList.toggle('is-selected', selected); if (selected) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current'); });
    mark(swatch);
    const standIn = showStandIn(card, swatch), token = standIn?.token;
    try {
      const next = readFragment(await loadFragment(swatch), card);
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
      // Retain the collection's filtered options when the card fragment comes from a product URL. The strip itself moves
      // into the new card: its pictures are already decoded, so none of them blinks or loads again.
      this.querySelectorAll('[data-nexus-swatch]').forEach(el => { const selected = el.dataset.nexusGroup === swatch.dataset.nexusGroup; el.classList.toggle('is-selected', selected); if (selected) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current'); });
      next.querySelector('nexus-card-swatches')?.replaceWith(this);
      const collection = card.closest('nexus-collection'), stored = collection?.cards?.find(c => c.element === card);
      if (stored) stored.element = next;
      const photos = shownPhotos(next, showsSecondary(card));
      photos.forEach(img => { img.loading = 'eager'; img.fetchPriority = 'high'; });
      if (standIn) standInHost(next)?.append(standIn);
      // Pin before insertion so the new card's first style is already open and does not re-animate.
      if (card.matches(':hover') || card.hasAttribute('data-nexus-hover')) pinHover(next);
      card.replaceWith(next);
      // Preserve keyboard focus; pointer users keep the pinned hover presentation.
      if (restoreFocus) next.querySelector('[data-nexus-swatch][aria-current="true"]')?.focus({ preventScroll: true });
      // The sharp photo takes over once decoded; until then the stand-in stays, never an empty frame.
      if (standIn) Promise.all(photos.map(photoReady)).then(() => retireStandIn(standIn, token));
    } catch (error) {
      if (this.abort.signal.aborted || this.sequence !== sequence || !card.isConnected) return;
      mark(before); retireStandIn(standIn, token);
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
