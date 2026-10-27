import type { Config } from "tailwindcss";
import forms from "@tailwindcss/forms";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./hooks/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f8faf9",
          100: "#eef2f0",
          200: "#dce4df",
          300: "#c2cec7",
          400: "#94a69b",
          500: "#6f8377",
          600: "#54665c",
          700: "#3f4e45",
          800: "#2c3731",
          900: "#1c2621",
          950: "#101713"
        },
        // 200–400 are the light tints dark mode uses for moss text (`dark:text-moss-400` etc.); without
        // them those classes generated nothing and the text fell back to 700, about 2:1 on ink-900.
        // 400 is the darkest that still reads at 4.5:1+ on ink-800/900/950.
        moss: {
          200: "#bcd9c7",
          300: "#93c2a6",
          400: "#6fae8a",
          500: "#4f8b67",
          600: "#3f7656",
          700: "#315d45",
          800: "#264a37"
        },
        amberline: "#d39b40"
      },
      boxShadow: {
        soft: "0 18px 60px rgba(15, 23, 42, 0.08)"
      }
    }
  },
  plugins: [forms]
};

export default config;
