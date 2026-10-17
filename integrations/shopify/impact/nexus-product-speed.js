// Product page speed (Nexus). Each colour is its own product page, so a colour change is a page change:
// - Chrome fetches the other colours' pages while this page is idle, and renders one ahead the moment a finger or a
//   mouse presses it (speculation rules). Safari has no speculation rules; there the photo answers first (below).
// - At the tap the chosen colour is marked and its photo replaces the main photo at once: the colour picture's own small
//   photo, soft, until the sharp one (started at the first touch, at the size the gallery asks for) is decoded.
// - The gallery thumbnails load with the page, the next gallery photos once the page is idle, and every lazy photo
//   starts 1.5 screens ahead (Safari otherwise waits until a photo is almost on screen).
const COLOUR_LINKS = '.variant-picker__option a.thumbnail-swatch[href]';
const warming = new Set();
const main = () => document.querySelector('[id^="shopify-section-"][id$="__main"]') || document;
const colourLinks = () => [...main().querySelectorAll(COLOUR_LINKS)].filter(link => !link.closest('quick-buy-drawer'));
const currentPhoto = () => main().querySelector('product-gallery .product-gallery__media.is-selected img') || main().querySelector('product-gallery .product-gallery__media img');
// The colour's photo at every width the gallery offers, so the new page asks for a photo that is already in the cache.
function sharpSources(link) {
  const photo = currentPhoto(), thumb = link.querySelector('img'), source = thumb?.getAttribute('src');
  if (!photo || !source || !photo.getAttribute('srcset')) return null;
  const srcset = photo.getAttribute('srcset').split(',').map(entry => {
    const [, descriptor] = entry.trim().split(/\s+/), width = parseInt(descriptor, 10);
    if (!width) return null;
    const url = new URL(source, window.location.href); url.searchParams.set('width', width);
    return `${url.href} ${descriptor}`;
  }).filter(Boolean).join(', ');
  return srcset ? { srcset, sizes: photo.getAttribute('sizes') || '100vw' } : null;
}
function warm(link, urgent) {
  const sources = sharpSources(link);
  if (!sources || warming.has(sources.srcset)) return;
  const image = new Image(); warming.add(sources.srcset);
  if (urgent) image.fetchPriority = 'high';
  image.onerror = () => warming.delete(sources.srcset);
  image.sizes = sources.sizes; image.srcset = sources.srcset;
}
// Put back what the tap changed when the browser restores this page from its back/forward cache.
let undo = [];
function showColour(link) {
  const photo = currentPhoto(), thumb = link.querySelector('img'), group = link.closest('.variant-picker__option'), label = group?.querySelector('legend + span');
  undo.forEach(step => step()); undo = [];
  for (const other of group ? group.querySelectorAll('a.thumbnail-swatch') : []) {
    const was = other.classList.contains('is-selected');
    other.classList.toggle('is-selected', other === link);
    undo.push(() => other.classList.toggle('is-selected', was));
  }
  const name = link.querySelector('.sr-only')?.textContent.trim();
  if (label && name) { const was = label.textContent; label.textContent = name; undo.push(() => { label.textContent = was; }); }
  if (!photo || !thumb?.currentSrc) return;
  const before = { src: photo.getAttribute('src'), srcset: photo.getAttribute('srcset'), sizes: photo.getAttribute('sizes'), filter: photo.style.filter };
  undo.push(() => { for (const key of ['src', 'srcset', 'sizes']) { if (before[key] == null) photo.removeAttribute(key); else photo.setAttribute(key, before[key]); } photo.style.filter = before.filter; });
  const sources = sharpSources(link);
  photo.removeAttribute('srcset'); photo.src = thumb.currentSrc; photo.style.filter = 'blur(2px)';
  if (!sources) return;
  const sharp = new Image(); sharp.fetchPriority = 'high'; sharp.sizes = sources.sizes; sharp.srcset = sources.srcset;
  sharp.decode().then(() => {
    if (photo.getAttribute('src') !== thumb.currentSrc) return;   // a newer tap or a restore changed it
    photo.sizes = sources.sizes; photo.srcset = sources.srcset; photo.style.filter = before.filter;
  }, () => {});
}
const links = colourLinks();
if (links.length) {
  if (HTMLScriptElement.supports?.('speculationrules')) {
    const rules = document.createElement('script'); rules.type = 'speculationrules';
    const where = { selector_matches: COLOUR_LINKS };
    rules.textContent = JSON.stringify({ prefetch: [{ source: 'document', where, eagerness: 'immediate' }], prerender: [{ source: 'document', where, eagerness: 'conservative' }] });
    document.head.append(rules);
  }
  for (const link of links) {
    link.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') warm(link, false); });
    for (const type of ['pointerdown', 'focus']) link.addEventListener(type, () => warm(link, true));
    link.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.classList.contains('is-selected')) return;
      showColour(link);   // the link still opens the colour's page as before
    });
  }
  window.addEventListener('pageshow', event => { if (event.persisted) { undo.forEach(step => step()); undo = []; } });
}
// Gallery: thumbnails now, the next photos when the page is idle, all of them once the shopper reaches for the gallery.
const gallery = main().querySelector('product-gallery');
if (gallery) {
  gallery.querySelectorAll('.product-gallery__thumbnail img[loading="lazy"]').forEach(img => { img.loading = 'eager'; });
  const slides = [...gallery.querySelectorAll('.product-gallery__media:not([hidden]) img[loading="lazy"]')];
  const loadSlides = count => slides.splice(0, count).forEach(img => { img.loading = 'eager'; });
  const idle = window.requestIdleCallback || (task => setTimeout(task, 300));
  const whenLoaded = task => (document.readyState === 'complete' ? task() : window.addEventListener('load', task, { once: true }));
  whenLoaded(() => idle(() => loadSlides(2)));
  for (const type of ['pointerdown', 'pointerenter', 'focusin']) gallery.addEventListener(type, () => loadSlides(slides.length), { once: true, passive: true });
}
// Every other lazy photo starts 1.5 screens before it scrolls into view.
if ('IntersectionObserver' in window) {
  const ahead = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { ahead.unobserve(entry.target); entry.target.loading = 'eager'; }
  }), { rootMargin: '150% 0px' });
  const watch = root => { if (root.matches?.('img[loading="lazy"]')) ahead.observe(root); root.querySelectorAll?.('img[loading="lazy"]').forEach(img => ahead.observe(img)); };
  watch(document);
  // Sections that arrive later (related products, reviews) are watched as they are added.
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => { if (node.nodeType === 1) watch(node); }))).observe(document.body, { childList: true, subtree: true });
}
