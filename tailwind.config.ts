import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        mg: {
          bg: { DEFAULT: "#0a0a0f", secondary: "#12121a", tertiary: "#1a1a2e", hover: "#232340", active: "#2a2a4a" },
          accent: { DEFAULT: "#a855f7", bright: "#c084fc", dim: "#7c3aed" },
          text: { DEFAULT: "#e4e4e7", secondary: "#a1a1aa", tertiary: "#71717a" },
          border: { DEFAULT: "#27272a", hover: "#3f3f46" },
        }
      },
      fontFamily: {
        mono: ["var(--font-jetbrains)", "Fira Code", "monospace"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        "glow": "0 0 20px rgba(168, 85, 247, 0.15)",
        "glow-lg": "0 0 40px rgba(168, 85, 247, 0.2)",
        "glow-hover": "0 0 30px rgba(168, 85, 247, 0.3)",
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "fade-in": "fade-in 0.2s ease-out",
        "slide-up": "slide-up 0.3s ease-out",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 20px rgba(168, 85, 247, 0.15)" },
          "50%": { boxShadow: "0 0 30px rgba(168, 85, 247, 0.3)" },
        },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "translateY(0)" } },
      },
    }
  },
  plugins: [],
};

export default config;
