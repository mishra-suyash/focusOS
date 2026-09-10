"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { saveUserSettings, subscribeUserSettings } from "@/lib/firestore";

type Theme = "light" | "dark";

const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void }>({
  theme: "light",
  toggleTheme: () => undefined
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const saved = window.localStorage.getItem("focusos-theme") as Theme | null;
    const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(saved ?? preferred);
  }, []);

  useEffect(() => {
    if (!user) return;
    return subscribeUserSettings(user.uid, (settings) => {
      if (settings?.theme) setTheme(settings.theme);
    });
  }, [user]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("focusos-theme", theme);
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      // Side effects (the Firestore write) must not live inside a setState
      // updater — React can invoke that updater during a later render pass
      // rather than at click-time, which is exactly what triggered "Cannot
      // update a component while rendering a different component" here
      // (saveUserSettings synchronously touches lib/usage.ts's tracker,
      // which notifies UsageOverlay's setState, mid-render of ThemeProvider).
      toggleTheme: () => {
        const next: Theme = theme === "dark" ? "light" : "dark";
        setTheme(next);
        if (user) saveUserSettings(user.uid, { theme: next });
      }
    }),
    [theme, user]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
