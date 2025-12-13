/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./client/index.html",
    "./client/src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'dark-bg': '#0f172a',
        'dark-surface': '#1e293b',
        'dark-border': '#334155',
        'dark-text': '#e2e8f0',
        'dark-text-secondary': '#94a3b8',
        'primary-green': '#10b981',
        'primary-blue': '#3b82f6',
        'primary-purple': '#8b5cf6',
        'primary-orange': '#f97316',
      },
      backgroundImage: {
        'gradient-dark': 'linear-gradient(180deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)',
        'gradient-button-blue': 'linear-gradient(135deg, #3b82f6 0%, #10b981 100%)',
        'gradient-button-purple': 'linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%)',
        'gradient-text': 'linear-gradient(135deg, #3b82f6 0%, #10b981 100%)',
        'gradient-text-purple': 'linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%)',
      },
      boxShadow: {
        'glow-green': '0 0 20px rgba(16, 185, 129, 0.5)',
        'glow-blue': '0 0 20px rgba(59, 130, 246, 0.5)',
        'glow-purple': '0 0 20px rgba(139, 92, 246, 0.5)',
      },
    },
  },
  plugins: [],
}
