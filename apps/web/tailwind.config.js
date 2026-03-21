/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      colors: {
        ink: "#0f172a",
        ember: "#f97316",
        moss: "#1f2937",
        haze: "#f8fafc",
      },
      backgroundImage: {
        "hero-glow":
          "radial-gradient(80rem 80rem at 10% 10%, rgba(249, 115, 22, 0.25), transparent 60%), radial-gradient(60rem 60rem at 80% 0%, rgba(14, 165, 233, 0.25), transparent 60%)",
      },
    },
  },
  plugins: [],
};
