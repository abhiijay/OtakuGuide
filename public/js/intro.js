// intro.js — home-page load choreography (no dependencies):
//   1. Katakana scramble on the hero wordmark — first paint only, ~0.5s,
//      runs on aria-hidden spans (the h1 carries the real name in aria-label)
//   2. Count-up on [data-countup] numbers — JS (not CSS counter()) because
//      Intl.NumberFormat keeps the thousands comma while animating
// Both respect prefers-reduced-motion, and the server renders the real
// text/numbers, so nothing on the page depends on this file running.
(function () {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1 — wordmark scramble
  const KATAKANA = 'オタクガイドアニメサクラモノガタリ';
  document.querySelectorAll('[data-scramble]').forEach((el) => {
    if (reduced) return;
    const final = el.textContent;
    const frames = 15; // ~0.5s at 30fps
    let frame = 0;
    (function tick() {
      frame += 1;
      const settled = Math.floor((frame / frames) * final.length);
      let out = final.slice(0, settled);
      for (let i = settled; i < final.length; i += 1) {
        out += KATAKANA[Math.floor(Math.random() * KATAKANA.length)];
      }
      el.textContent = out;
      if (frame < frames) setTimeout(tick, 33);
      else el.textContent = final;
    })();
  });

  // 2 — stat count-up
  const fmt = new Intl.NumberFormat('en-US');
  document.querySelectorAll('[data-countup]').forEach((el) => {
    const target = Number(el.dataset.countup);
    if (reduced || !Number.isFinite(target) || target <= 0) return;
    const duration = 900;
    const start = performance.now();
    requestAnimationFrame(function step(now) {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = fmt.format(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step);
    });
  });

  // 3 — scroll-effect fallbacks for browsers without CSS scroll-driven
  //     animations (animation-timeline), e.g. older Safari/Firefox. Mirrors
  //     .view-rise with an IntersectionObserver and the gutter thread with a
  //     passive scroll listener. Browsers with native support skip all this.
  const hasScrollTimeline =
    typeof CSS !== 'undefined' && CSS.supports('animation-timeline: scroll()');
  if (!hasScrollTimeline && !reduced) {
    const sections = document.querySelectorAll('.view-rise');
    sections.forEach((el) => el.classList.add('js-rise'));
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('js-rise-in');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px' }
    );
    sections.forEach((el) => io.observe(el));

    const thread = document.querySelector('.scroll-thread');
    if (thread) {
      const onScroll = () => {
        const doc = document.documentElement;
        const progress = doc.scrollTop / (doc.scrollHeight - doc.clientHeight || 1);
        thread.style.transform = `scaleY(${progress})`;
      };
      document.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  }
})();
