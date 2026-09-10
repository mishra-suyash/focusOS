"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { saveUserSettings, subscribeUserSettings } from "@/lib/firestore";
import type { UserSettings } from "@/types";

const DEFAULTS: UserSettings = { hydrationMinutes: 60, breakMinutes: 50, updatedAt: "" };

export function useUserSettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<UserSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) {
      setSettings(DEFAULTS);
      setLoaded(false);
      return;
    }
    return subscribeUserSettings(user.uid, (next) => {
      setSettings(next ? { ...DEFAULTS, ...next } : DEFAULTS);
      setLoaded(true);
    });
  }, [user]);

  function update(patch: Partial<Omit<UserSettings, "updatedAt">>) {
    if (!user) return;
    setSettings((current) => ({ ...current, ...patch }));
    saveUserSettings(user.uid, patch);
  }

  return { settings, loaded, update };
}
