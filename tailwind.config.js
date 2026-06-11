/** @type {import('tailwindcss').Config} */
module.exports = {
  // Files Tailwind scans for class names — anything else uses goes unused
  content: [
    './views/**/*.ejs',
    './public/js/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        // Sakura red — LOCKED 2026-06-11 at the warm vermillion end of the
        // committed #DC143C–#E03C42 range, matching the riso-print reds in
        // the design-inspiration set. `deep` is the pressed/hover state.
        sakura: {
          DEFAULT: '#E03C42',
          deep: '#B41E2B',
        },
        // Warm ink on near-white paper (user feedback 2026-06-11: whitish, not cream).
        ink: '#16120F',
        // Dark-act background — neutral deep black (user feedback 2026-06-12:
        // warm ink read muddy-brown as a background; keep ink for text/borders).
        night: '#0B0B0D',
        paper: '#FBFBF9',
      },
      fontFamily: {
        // Display — self-hosted Shippori Mincho (public/fonts/, weights 500 + 800)
        serif: ['"Shippori Mincho"', 'Georgia', 'serif'],
        // Body — system stack
        sans: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
