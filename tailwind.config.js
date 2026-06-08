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
        // Sakura red — the single accent. Starting value, refine when designing pages.
        // Range we committed to: #DC143C – #E03C42
        sakura: {
          DEFAULT: '#DC143C',
        },
        ink: '#0a0a0a',
        paper: '#fafaf7',
      },
      fontFamily: {
        // Headings — self-hosted Shippori Mincho added later in public/fonts/
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
