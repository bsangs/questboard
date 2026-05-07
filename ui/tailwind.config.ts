import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          '"SF Mono"',
          "Menlo",
          "Consolas",
          '"Liberation Mono"',
          "monospace",
        ],
      },
      colors: {
        // Notion-like neutrals; semantic accents.
        ink: {
          DEFAULT: "#37352f",
          muted: "#787774",
          subtle: "#9b9a97",
        },
      },
      boxShadow: {
        tile: "0 1px 0 rgba(15,15,15,0.04), 0 0 0 1px rgba(15,15,15,0.04)",
        tileHover:
          "0 2px 4px rgba(15,15,15,0.08), 0 0 0 1px rgba(15,15,15,0.08)",
        drawer: "-8px 0 24px rgba(15,15,15,0.08)",
      },
      keyframes: {
        pulseDot: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        slideIn: {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        pulseDot: "pulseDot 1.6s ease-in-out infinite",
        slideIn: "slideIn 220ms ease-out",
        fadeIn: "fadeIn 180ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
