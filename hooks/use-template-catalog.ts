"use client";

import { useEffect, useState } from "react";
import { fetchPublicCatalog } from "@/lib/firestore";
import type { PublicCatalog } from "@/lib/templates/schema";

// Module-level cache: the catalog is fetched once per session (plan §7.4), not once per
// component — the gallery, onboarding, and "Add from checklist"/"Start from a template"
// dialogs all share this instead of each costing their own read.
let cached: PublicCatalog | null | undefined; // undefined = not fetched yet this session
let inFlight: Promise<PublicCatalog | null> | null = null;

async function loadCatalog(): Promise<PublicCatalog | null> {
  if (cached !== undefined) return cached;
  if (!inFlight) {
    inFlight = fetchPublicCatalog().then((result) => {
      cached = result;
      inFlight = null;
      return result;
    });
  }
  return inFlight;
}

/** Admin-published templates (plan §7.4) — the Today view never calls this; only the gallery/onboarding/checklist pickers do. */
export function useTemplateCatalog() {
  const [catalog, setCatalog] = useState<PublicCatalog | null>(cached ?? null);
  const [loaded, setLoaded] = useState(cached !== undefined);

  useEffect(() => {
    let cancelled = false;
    loadCatalog().then((result) => {
      if (!cancelled) {
        setCatalog(result);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { catalog, loaded };
}
