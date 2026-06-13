// Account dropdown polish (views/partials/nav.ejs).
// The menu is a native <details class="account-menu"> — it already opens and
// closes on click without any JS. This only adds the niceties a native details
// can't do on its own: close when you click outside it, and close on Escape.
// No-ops gracefully when the menu isn't on the page (logged-out visitors).
(function () {
  const menu = document.querySelector('.account-menu');
  if (!menu) return;

  // Click anywhere outside the open menu closes it.
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });

  // Escape closes it and returns focus to the avatar trigger.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.open) {
      menu.open = false;
      const summary = menu.querySelector('summary');
      if (summary) summary.focus();
    }
  });
})();
