// Podium hover-preview (views/home.ejs only).
// Hovering a chart row ([data-preview-target]) shows that anime in the big
// podium cell ([data-preview-pane]); leaving the list returns to 第1位.
(function () {
  const panes = document.querySelectorAll('[data-preview-pane]');
  const rows = document.querySelectorAll('[data-preview-target]');
  const list = document.querySelector('[data-preview-list]');
  if (!panes.length || !rows.length || !list) return;

  function show(index) {
    panes.forEach((pane) => {
      const active = pane.dataset.previewPane === String(index);
      pane.classList.toggle('hidden', !active);
      if (active) {
        // Restart the cross-fade so every swap eases in instead of snapping.
        pane.classList.remove('pane-anim');
        void pane.offsetWidth;
        pane.classList.add('pane-anim');
      }
    });
  }

  rows.forEach((row) => {
    row.addEventListener('mouseenter', () => show(row.dataset.previewTarget));
  });
  list.addEventListener('mouseleave', () => show(0));
})();
