import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#050816",
          900: "#0b1020",
          800: "#11182d"
        },
        signal: {
          cyan: "#7dd3fc",
          lime: "#bef264",
          amber: "#fcd34d",
          coral: "#fb7185"
        }
      },
      boxShadow: {
        panel: "0 20px 60px rgba(0, 0, 0, 0.28)"
      },
      fontFamily: {
        display: ["ui-sans-serif", "SF Pro Display", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"]
      }
    }
  },
  plugins: []
} satisfies Config;

