/** Tailwind build config (only needed if you edit the HTML/JS classes later). */
module.exports = {
  content: ['./index.html', './app.js', './ui.js', './access.js', './admin.html', './admin.js', './privacy.html', './terms.html', './refund.html', './contact.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
      },
    },
  },
  plugins: [],
};
