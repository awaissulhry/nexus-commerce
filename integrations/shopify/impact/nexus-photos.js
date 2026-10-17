// Photos ahead of the shopper (Nexus), on every page:
// - every lazy photo starts loading 1.5 screens before it scrolls into view (Safari otherwise waits until a photo is
//   almost on screen) — but only once the page has loaded, so the first screen keeps the network to itself;
// - a photo still loading when it is half a screen away gets a small soft version of itself underneath (48 px wide,
//   1–2 KB); once that can paint, the theme's fade-ins start with it instead of an empty box, and the sharp photo
//   replaces it when decoded.
const PREVIEW_WIDTH = 48;
// The photo the browser shows or will show: a <picture> source that matches this screen comes first.
function photoUrl(img) {
  if (img.currentSrc) return img.currentSrc;
  const picture = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
  for (const source of picture ? picture.querySelectorAll('source') : []) {
    if (source.media && !window.matchMedia(source.media).matches) continue;
    const first = (source.getAttribute('srcset') || '').trim().split(/\s+/)[0];
    if (first) return first;
  }
  return img.getAttribute('src') || (img.getAttribute('srcset') || '').trim().split(/\s+/)[0] || '';
}
function previewUrl(img) {
  const raw = photoUrl(img);
  if (!/\/cdn\/shop\/|cdn\.shopify\.com/.test(raw)) return null;
  const url = new URL(raw, window.location.href), width = Number(url.searchParams.get('width')), height = Number(url.searchParams.get('height'));
  url.searchParams.set('width', PREVIEW_WIDTH);
  if (width && height) url.searchParams.set('height', Math.max(1, Math.round(height * PREVIEW_WIDTH / width))); else url.searchParams.delete('height');
  return url.href;
}
const ready = img => img.complete && img.naturalWidth > 0;
function showPreview(img) {
  if (ready(img) || img.dataset.nexusPreview || img.getBoundingClientRect().width < 200) return;
  // Slides not on show wait for the slideshow, and a photo the theme already gives a preview keeps it.
  if (img.closest('.slideshow__slide:not(.is-selected)') || getComputedStyle(img).backgroundImage !== 'none') return;
  const url = previewUrl(img);
  if (!url) return;
  const fit = getComputedStyle(img).objectFit;
  img.dataset.nexusPreview = '';
  img.style.backgroundImage = `url("${url}")`;
  img.style.backgroundSize = fit === 'contain' ? 'contain' : fit === 'cover' ? 'cover' : '100% 100%';
  img.style.backgroundPosition = 'center';
  img.style.backgroundRepeat = 'no-repeat';
  // Once the soft version can paint, the theme's fades stop waiting for the sharp photo (imageLoaded in theme.js).
  const probe = new Image(), announce = () => { if (ready(img)) return; img.setAttribute('data-nexus-preview-ready', ''); img.dispatchEvent(new Event('nexus:preview-ready')); };
  probe.onload = () => probe.decode().then(announce, announce);
  probe.src = url;
  // Taken away once the sharp photo can paint, so it never shows through a photo with a transparent background.
  const clear = () => requestAnimationFrame(() => { for (const name of ['background-image', 'background-size', 'background-position', 'background-repeat']) img.style.removeProperty(name); });
  img.addEventListener('load', () => img.decode().then(clear, clear), { once: true });
  img.addEventListener('error', clear, { once: true });
}
if ('IntersectionObserver' in window) {
  const ahead = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { ahead.unobserve(entry.target); entry.target.loading = 'eager'; }
  }), { rootMargin: '150% 0px' });
  const near = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { near.unobserve(entry.target); showPreview(entry.target); }
  }), { rootMargin: '50% 0px' });
  // Until the page has loaded (and the browser is idle), lazy photos wait in a list instead of loading ahead.
  let settled = false;
  const waiting = [];
  const loadAhead = img => { if (settled) ahead.observe(img); else waiting.push(img); };
  const settle = () => { settled = true; waiting.splice(0).forEach(img => ahead.observe(img)); };
  const idle = window.requestIdleCallback || (task => setTimeout(task, 300));
  const whenLoaded = task => (document.readyState === 'complete' ? task() : window.addEventListener('load', task, { once: true }));
  whenLoaded(() => idle(settle, { timeout: 2000 }));
  const watch = img => { if (img.loading === 'lazy') loadAhead(img); if (!ready(img)) near.observe(img); };
  const scan = root => { if (root.matches?.('img')) watch(root); root.querySelectorAll?.('img').forEach(watch); };
  scan(document);
  // Sections that arrive later (related products, reviews, swapped cards) are watched as they are added.
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => { if (node.nodeType === 1) scan(node); }))).observe(document.body, { childList: true, subtree: true });
}
