// Verified hosts: Shopify Inbox, CWILL/Loloyal and Klaviyo's floating teaser.
// Do not reach into third-party iframes or alter their stored open/closed state.
const widgetSelector = 'shopify-chat, .loloyal-launcher-wrapper, #loloyal-core-popup-root, [class*="kl-teaser-"], [data-nexus-floating-promotion]';
let menuOpen = false, frame = 0;
const previous = new Map();
function update() {
  frame = 0;
  const menu = document.getElementById('header-sidebar-menu');
  menuOpen = !!menu?.hasAttribute('open');
  document.documentElement.classList.toggle('nexus-menu-open', menuOpen);
  if (menuOpen) {
    // Include a popup that appears after the drawer opens. Find the complete
    // fixed overlay rather than guessing generated app classes or hiding the
    // embedded newsletter form (which would change the document's height).
    document.querySelectorAll('form.klaviyo-form').forEach(form => {
      let overlay;
      for (let node = form; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).position === 'fixed') overlay = node;
      }
      overlay?.setAttribute('data-nexus-floating-promotion', '');
    });
    document.querySelectorAll(widgetSelector).forEach(widget => {
      if (!previous.has(widget)) previous.set(widget, widget.inert);
      widget.inert = true;
    });
  } else {
    for (const [widget, inert] of previous) if (widget.isConnected) widget.inert = inert;
    previous.clear();
  }
}
function schedule() { if (!frame) frame = requestAnimationFrame(update); }
function start() {
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' && record.target.id === 'header-sidebar-menu')) update();
    else if (menuOpen && records.some(record => record.type === 'childList')) schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  document.addEventListener('dialog:after-hide', event => { if (event.target.id === 'header-sidebar-menu') schedule(); });
  document.addEventListener('shopify:section:load', schedule);
  update();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
