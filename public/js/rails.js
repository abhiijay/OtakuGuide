// rails.js — infinite revolving cover rails (home page).
// Each rail renders its items TWICE (second copy aria-hidden). When the
// scroll position crosses one full set width it silently wraps, so the
// first anime always follows the last — no edges in either direction.
// Rails also auto-drift (alternating direction per rail) so they're always
// revolving; drift pauses on hover so the stat cards stay readable, and is
// skipped entirely under prefers-reduced-motion.
(function () {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.querySelectorAll('[data-rail]').forEach((rail, index) => {
    const items = rail.querySelectorAll('li');
    if (items.length < 4 || items.length % 2 !== 0) return;
    // Width of one full set = distance between the two copies' first items.
    const setW = items[items.length / 2].offsetLeft - items[0].offsetLeft;
    if (setW <= 0) return;

    rail.addEventListener(
      'scroll',
      () => {
        if (rail.scrollLeft >= setW) rail.scrollLeft -= setW;
        else if (rail.scrollLeft < 1) rail.scrollLeft += setW;
      },
      { passive: true }
    );

    // Start mid-cover so the rail reads as an already-flowing ribbon,
    // not a list that begins at a margin.
    rail.scrollLeft = Math.round(items[0].offsetWidth * 0.6);

    if (reduced) return;

    // Constant gentle drift (~33px/s), alternating direction per rail.
    // Fractional scrollLeft assignments can be floored by the browser,
    // so accumulate into `carry` and apply whole pixels.
    const direction = index % 2 === 0 ? 1 : -1;
    let paused = false;
    let carry = 0;
    rail.addEventListener('pointerenter', () => { paused = true; });
    rail.addEventListener('pointerleave', () => { paused = false; });
    (function drift() {
      if (!paused && !document.hidden) {
        carry += 0.55;
        if (carry >= 1) {
          const whole = Math.floor(carry);
          rail.scrollLeft += whole * direction;
          carry -= whole;
        }
      }
      requestAnimationFrame(drift);
    })();
  });
})();
