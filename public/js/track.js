// track.js — progressive enhancement for the anime-page "my list" panel.
//
// The list API (PUT/DELETE /api/library/:id) is JSON + CSRF-header only, so
// unlike the no-JS catalog this panel needs JavaScript; the server renders a
// <noscript> note for those without it. This script wires the controls to the
// API and, crucially, re-syncs every control from the entry the server returns
// after each save — so the panel always shows the actual stored state, never a
// hopeful guess. No-ops cleanly if fetch is missing.
(() => {
  'use strict';

  const panel = document.querySelector('.track-panel');
  if (!panel || typeof fetch !== 'function') return;

  const animeId = panel.dataset.animeId;
  const csrf = panel.dataset.csrf;
  if (!animeId) return;

  const setButtons = [...panel.querySelectorAll('.track-set')];
  const scoreSel = panel.querySelector('[data-score]');
  const favBtn = panel.querySelector('[data-fav]');
  const removeBtn = panel.querySelector('[data-remove]');
  const statusEl = panel.querySelector('.track-status');
  const msgEl = panel.querySelector('.track-msg');

  // Local mirror of the stored entry. status is what the API requires on every
  // PUT — a score/favorite change has to carry the current status along. null
  // status means "not on the list yet"; the first status click creates the row.
  let cur = {
    status: setButtons.find((b) => b.classList.contains('text-sakura'))?.dataset.status || null,
    score: scoreSel && scoreSel.value ? Number(scoreSel.value) * 10 : null,
    favorite: favBtn ? favBtn.getAttribute('aria-pressed') === 'true' : false,
  };

  function flash(text) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.classList.remove('hidden');
  }

  // Repaint every control from the server's stored entry (or null after a
  // remove). This is the single source of truth — the API owns the row.
  function sync(entry) {
    if (!entry) {
      cur = { status: null, score: null, favorite: false };
    } else {
      cur = {
        status: entry.status,
        score: entry.score,
        favorite: !!entry.is_favorite,
      };
    }

    setButtons.forEach((b) => {
      const on = b.dataset.status === cur.status;
      b.classList.toggle('border-sakura', on);
      b.classList.toggle('text-sakura', on);
      b.classList.toggle('border-paper/25', !on);
      b.classList.toggle('text-paper/80', !on);
    });

    if (statusEl) statusEl.textContent = cur.status ? cur.status.toLowerCase() : 'not tracked';
    if (scoreSel) scoreSel.value = cur.score != null ? String(Math.round(cur.score / 10)) : '';
    if (favBtn) {
      favBtn.setAttribute('aria-pressed', cur.favorite ? 'true' : 'false');
      favBtn.classList.toggle('border-sakura', cur.favorite);
      favBtn.classList.toggle('text-sakura', cur.favorite);
      favBtn.classList.toggle('border-paper/25', !cur.favorite);
      favBtn.classList.toggle('text-paper/70', !cur.favorite);
      const glyph = favBtn.querySelector('[aria-hidden]');
      if (glyph) glyph.textContent = cur.favorite ? '★' : '☆';
    }
    if (removeBtn) removeBtn.classList.toggle('hidden', !cur.status);
  }

  function busy(on) {
    setButtons.forEach((b) => (b.disabled = on));
    if (scoreSel) scoreSel.disabled = on;
    if (favBtn) favBtn.disabled = on;
    if (removeBtn) removeBtn.disabled = on;
  }

  // PUT a patch merged over the current state. status is always sent (API
  // requires it); with no entry yet, a bare score/favorite implies WATCHING.
  async function save(patch) {
    const body = {
      status: patch.status || cur.status || 'WATCHING',
      score: 'score' in patch ? patch.score : cur.score,
      is_favorite: 'favorite' in patch ? patch.favorite : cur.favorite,
    };
    busy(true);
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(animeId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
      sync(data.entry);
      flash('saved.');
    } catch (err) {
      flash(err.message || 'could not save.');
    } finally {
      busy(false);
    }
  }

  async function remove() {
    busy(true);
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(animeId)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrf, Accept: 'application/json' },
      });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `remove failed (${res.status})`);
      }
      sync(null);
      flash('removed.');
    } catch (err) {
      flash(err.message || 'could not remove.');
    } finally {
      busy(false);
    }
  }

  setButtons.forEach((b) =>
    b.addEventListener('click', () => save({ status: b.dataset.status }))
  );
  if (scoreSel) {
    scoreSel.addEventListener('change', () =>
      save({ score: scoreSel.value ? Number(scoreSel.value) * 10 : null })
    );
  }
  if (favBtn) {
    favBtn.addEventListener('click', () => save({ favorite: !cur.favorite }));
  }
  if (removeBtn) {
    removeBtn.addEventListener('click', remove);
  }
})();
