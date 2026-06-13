// onboarding.js — progressive enhancement for the cold-start quiz.
//
// The page already works with zero JS: the poster grid is peer-checkbox driven
// (CSS shows the selected state) and submits as a plain POST. This script layers
// on three things, and no-ops cleanly if fetch is missing:
//   1. a live "N chosen" counter + a smart submit label (skip ↔ add favorites)
//   2. Spotify-style expansion — picking a title fetches more like it and weaves
//      those posters into the SAME grid, which can themselves be picked and
//      expand further, so the grid becomes one never-ending list
//   3. a gentle fade-in for woven-in cards (skipped under reduced motion)
(() => {
  'use strict';

  const form = document.getElementById('onboard-form');
  if (!form || typeof fetch !== 'function') return;

  const grid = document.getElementById('seed-grid');
  const countEl = document.getElementById('pick-count');
  const countWrap = form.querySelector('[data-count-wrap]');
  const finishBtn = document.getElementById('finish-btn');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!grid) return;

  // Every anime id already in the grid (seeds + anything woven in), so we never
  // show the same poster twice. Also doubles as the `exclude` list we send the
  // server so it can drop other seasons of titles already on the page.
  const renderedIds = new Set(
    [...grid.querySelectorAll('.onboard-card[data-id]')].map((el) => el.dataset.id)
  );
  // Ids we've already expanded from, so re-toggling a pick doesn't refetch.
  const expandedIds = new Set();

  // Reveal the counter (hidden by default so the no-JS view shows only the
  // encouraging line, never a stale "0 chosen").
  if (countWrap) countWrap.classList.remove('hidden');

  function refreshTally() {
    const n = form.querySelectorAll('input[name="pick"]:checked').length;
    if (countEl) countEl.textContent = String(n);
    if (finishBtn) {
      finishBtn.textContent =
        n === 0 ? 'skip for now' : n === 1 ? 'add 1 favorite' : `add ${n} favorites`;
    }
  }

  // Build a poster card with the SAME structure/classes as the server-rendered
  // ones, so CSS selection state and further expansion work identically. Built
  // via the DOM API (not innerHTML) so titles can't break out into markup.
  function buildCard(anime) {
    const label = document.createElement('label');
    label.className = 'onboard-card relative block cursor-pointer select-none';
    label.dataset.id = String(anime.id);
    label.dataset.title = anime.title;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'pick';
    input.value = String(anime.id);
    input.className = 'peer sr-only';

    const badge = document.createElement('span');
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = '選';
    badge.className =
      'pointer-events-none absolute right-2 top-2 z-10 flex h-7 w-7 items-center ' +
      'justify-center rounded-full bg-sakura font-serif text-xs font-bold text-paper ' +
      'opacity-0 transition-opacity duration-150 peer-checked:opacity-100';

    const frame = document.createElement('div');
    frame.className =
      'cover-lift relative aspect-[2/3] overflow-hidden border border-ink/20 ' +
      'transition-shadow peer-checked:border-sakura peer-checked:ring-4 ' +
      'peer-checked:ring-sakura peer-focus-visible:ring-2 peer-focus-visible:ring-sakura';

    const img = document.createElement('img');
    img.src = anime.cover_large || anime.cover_image_url;
    img.alt = anime.title;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = 'cover-img h-full w-full';
    img.addEventListener('error', function onErr() {
      img.removeEventListener('error', onErr);
      img.src = anime.cover_image_url;
    });

    const title = document.createElement('p');
    title.textContent = anime.title;
    title.className =
      'mt-1.5 line-clamp-2 font-serif text-xs font-bold leading-snug text-ink ' +
      'peer-checked:text-sakura';

    frame.appendChild(img);
    label.append(input, badge, frame, title);
    return label;
  }

  // Weave "more like the just-picked anime" into the end of the one grid. We send
  // the full set of ids already on the page so the server can exclude other
  // seasons of titles we've already shown — the dedup the client can't do alone.
  async function expand(seedId) {
    if (expandedIds.has(seedId)) return;
    expandedIds.add(seedId);

    let similar;
    try {
      const qs = new URLSearchParams({ exclude: [...renderedIds].join(',') });
      const res = await fetch(`/api/similar/${encodeURIComponent(seedId)}?${qs}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`similar: ${res.status}`);
      similar = (await res.json()).similar || [];
    } catch {
      expandedIds.delete(seedId); // allow a retry on a later toggle
      return;
    }

    // Server already excludes franchises; this is the belt-and-braces id guard.
    const fresh = similar.filter((a) => !renderedIds.has(String(a.id)));
    if (!fresh.length) return;

    const added = [];
    for (const a of fresh) {
      renderedIds.add(String(a.id));
      const card = buildCard(a);
      if (!reduceMotion.matches) {
        card.style.transition = 'opacity 200ms ease';
        card.style.opacity = '0';
      }
      grid.appendChild(card);
      added.push(card);
    }

    if (!reduceMotion.matches) {
      // Next frame so the transition actually runs from 0 → 1.
      requestAnimationFrame(() => {
        for (const card of added) card.style.opacity = '1';
      });
    }
  }

  // Delegated: catches both seed checkboxes and every woven-in one.
  form.addEventListener('change', (event) => {
    const input = event.target;
    if (!input || input.name !== 'pick') return;
    refreshTally();
    if (input.checked) {
      const card = input.closest('.onboard-card');
      if (card) expand(card.dataset.id);
    }
  });

  refreshTally();
})();
