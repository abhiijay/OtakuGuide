// focus.js — in-place redraw for the home page's enso window (注目).
// Clicking "draw another shelf" fetches GET /focus and swaps the section
// body without a page reload. Progressive enhancement: without JS the
// button is a real link (per-render nonce → full reload), and any fetch
// failure falls back to that link. A short cross-fade wraps the swap
// unless the user prefers reduced motion.
(() => {
  'use strict';

  const section = document.getElementById('focus');
  if (!section || typeof fetch !== 'function') return;

  const body = section.querySelector('[data-focus-body]');
  if (!body) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const FADE_MS = 180;
  let busy = false;

  // Delegated, because the button itself is replaced by every swap.
  section.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-redraw]');
    if (!button) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    button.setAttribute('aria-busy', 'true');

    try {
      const res = await fetch('/focus', { headers: { Accept: 'text/html' } });
      if (!res.ok || res.status === 204) throw new Error(`focus fragment: ${res.status}`);
      const html = await res.text();

      if (!reduceMotion.matches) {
        body.style.transition = `opacity ${FADE_MS}ms ease`;
        body.style.opacity = '0';
        await new Promise((r) => setTimeout(r, FADE_MS));
      }
      body.innerHTML = html;
      if (!reduceMotion.matches) {
        body.style.opacity = '1';
      }
    } catch {
      window.location.href = button.href; // no-JS path: nonce link, full reload
      return;
    } finally {
      busy = false;
    }
  });
})();
