// Assemble Shopify-filtered cards before sorting/paginating them. Native pagination
// counts families; one family can now occupy several independently ordered cards.
export function orderCards(cards, order, sort) {
  const ranks = new Map(order.map((key, index) => [key, index]));
  return [...cards].sort((a, b) => {
    if (sort === 'price-ascending' || sort === 'price-descending') return (Number(a.price) - Number(b.price)) * (sort === 'price-ascending' ? 1 : -1) || a.source - b.source;
    if (sort === 'title-ascending' || sort === 'title-descending') return a.title.localeCompare(b.title, document.documentElement.lang) * (sort === 'title-ascending' ? 1 : -1) || a.source - b.source;
    if (sort && sort !== 'manual') return a.source - b.source;
    return (ranks.get(a.key) ?? order.length) - (ranks.get(b.key) ?? order.length) || a.source - b.source;
  });
}
const collectionIdentity = url => { const value = new URL(url); ['nexus_page', 'page', 'section_id'].forEach(key => value.searchParams.delete(key)); value.searchParams.sort(); return value.pathname + value.search; };
// Native facets replace this component; every new filter/sort starts at card page one.
document.addEventListener('facet:update', event => {
  if (document.querySelector('nexus-collection') && event.detail?.url) event.detail.url.searchParams.delete('nexus_page');
}, { capture: true });
class NexusCollection extends HTMLElement {
  connectedCallback() {
    this.abort = new AbortController();
    this.load();
  }
  disconnectedCallback() { this.abort?.abort(); }
  async load() {
    const list = this.querySelector('product-list'), status = this.querySelector('[data-nexus-collection-status]'), navigation = this.querySelector('[data-nexus-card-pagination]');
    if (!list || !status || !navigation) return;
    const signal = this.abort.signal, section = this.closest('.shopify-section');
    this.setAttribute('aria-busy', 'true'); list.hidden = true; navigation.hidden = true;
    this.querySelectorAll('.collection__pagination').forEach(el => { el.hidden = true; });
    status.textContent = this.dataset.loading;
    try {
      const pages = Number(this.dataset.pages), current = Number(this.dataset.currentPage), size = Number(this.dataset.pageSize);
      if (!Number.isInteger(pages) || pages > 50 || Number(this.dataset.productCount) > 250 || !size) throw new Error('Collection exceeds supported size');
      const sections = new Map([[current, this]]), queue = Array.from({ length: pages }, (_, i) => i + 1).filter(page => page !== current);
      const base = new URL(window.location.href); base.searchParams.delete('nexus_page');
      this.identity = collectionIdentity(base);
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length && !signal.aborted) {
          const page = queue.shift(), url = new URL(base);
          url.searchParams.set('section_id', section.id.replace('shopify-section-', '')); url.searchParams.set(this.dataset.pageParam || 'page', String(page));
          const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
          if (!response.ok) throw new Error('Collection page unavailable');
          const fragment = new DOMParser().parseFromString(await response.text(), 'text/html');
          const next = fragment.querySelector('nexus-collection');
          if (!next || next.dataset.collectionId !== this.dataset.collectionId || next.dataset.pages !== this.dataset.pages || next.dataset.productCount !== this.dataset.productCount) throw new Error('Collection changed while loading');
          sections.set(page, next);
        }
      }));
      if (signal.aborted || !this.isConnected) return;
      const cards = [], seen = new Set(), promos = [];
      for (const [page, fragment] of [...sections].sort(([a], [b]) => a - b)) {
        const sourceList = fragment.querySelector('product-list');
        for (const element of sourceList.children) {
          if (!element.hasAttribute('data-nexus-card')) { if (page === 1) promos.push({ element, position: Number(element.dataset.nexusPromoPosition || 1) - 1 }); continue; }
          const key = element.dataset.nexusCard;
          if (seen.has(key)) throw new Error('Duplicate collection card');
          seen.add(key); cards.push({ key, price: element.dataset.nexusPrice, title: element.dataset.nexusTitle, source: cards.length, element });
        }
      }
      if (cards.length > 2000) throw new Error('Collection exceeds supported card count');
      const order = JSON.parse(this.querySelector('[data-nexus-order]').textContent).order ?? [];
      this.cards = orderCards(cards, order, this.dataset.sort); this.promos = promos;
      this.list = list; this.status = status; this.navigation = navigation; this.size = size;
      this.render(Number(new URL(window.location.href).searchParams.get('nexus_page') || 1), false);
      this.addEventListener('click', event => { const link = event.target.closest('[data-nexus-page]'); if (!link) return; event.preventDefault(); this.render(Number(link.dataset.nexusPage), true); }, { signal });
      window.addEventListener('popstate', () => { if (!this.isConnected) return; if (collectionIdentity(window.location.href) !== this.identity) { window.location.reload(); return; } this.render(Number(new URL(window.location.href).searchParams.get('nexus_page') || 1), false); }, { signal });
    } catch (error) {
      if (signal.aborted || !this.isConnected) return;
      status.textContent = this.dataset.error;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.textContent = this.dataset.retry;
      retry.addEventListener('click', () => this.load(), { once: true, signal }); status.append(' ', retry);
    } finally { if (this.isConnected && !signal.aborted) this.removeAttribute('aria-busy'); }
  }
  render(requested, navigate) {
    const pages = Math.max(1, Math.ceil(this.cards.length / this.size)), page = Math.min(pages, Math.max(1, Number.isInteger(requested) ? requested : 1));
    const start = (page - 1) * this.size, nodes = this.cards.slice(start, start + this.size).map(c => c.element);
    for (const promo of this.promos) if (promo.position >= start && promo.position < start + this.size) nodes.splice(promo.position - start, 0, promo.element);
    this.list.replaceChildren(...nodes); this.list.hidden = false;
    this.list.querySelectorAll('[reveal-js]').forEach(el => el.removeAttribute('reveal-js'));
    this.status.textContent = this.dataset.count.replace('{count}', String(this.cards.length));
    const links = [];
    for (let i = 1; i <= pages; i++) {
      const link = document.createElement('a'), url = new URL(window.location.href); url.searchParams.delete(this.dataset.pageParam || 'page'); url.searchParams.set('nexus_page', String(i));
      link.href = url.toString(); link.dataset.nexusPage = String(i); link.className = 'pagination__item'; link.textContent = String(i); link.setAttribute('aria-label', `${this.dataset.pageLabel} ${i}`); if (i === page) link.setAttribute('aria-current', 'page'); links.push(link);
    }
    this.navigation.replaceChildren(...links); this.navigation.hidden = pages === 1;
    if (navigate) { const url = new URL(window.location.href); url.searchParams.delete(this.dataset.pageParam || 'page'); url.searchParams.set('nexus_page', String(page)); history.pushState(null, '', url); this.status.tabIndex = -1; this.status.focus({ preventScroll: true }); this.scrollIntoView({ behavior: 'instant', block: 'start' }); }
  }
}
if (!customElements.get('nexus-collection')) customElements.define('nexus-collection', NexusCollection);
