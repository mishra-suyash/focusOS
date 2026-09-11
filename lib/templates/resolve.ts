import { resolvePackBreakDayTemplate, resolvePackWorkdayTemplate } from "@/lib/templates/builtin";
import type { DayTemplatePayload, PublicCatalog } from "@/lib/templates/schema";
import type { PackId } from "@/types";

export interface ResolvedPackTemplate {
  source: "org" | "builtin";
  id: string;
  name: string;
  description?: string;
  version: number;
  slots: DayTemplatePayload["slots"];
}

function findOrgDayTemplate(catalog: PublicCatalog | null, id: string | undefined): ResolvedPackTemplate | null {
  if (!id) return null;
  const match = catalog?.templates.find((template) => template.id === id && template.kind === "day");
  if (!match) return null;
  const payload = match.payload as DayTemplatePayload;
  return { source: "org", id: match.id, name: match.name, description: match.description, version: match.version, slots: payload.slots };
}

/**
 * Resolution order for a pack's default workday template (plan §7.4): admin
 * `packDefaults` override -> built-in default. Deliberately only consulted
 * by onboarding (U3) and the gallery — the Start-day fallback (F1, U1) stays
 * built-in-only so that fast path never costs an extra catalog read.
 */
export function resolveWorkdayTemplate(packId: PackId | undefined, catalog: PublicCatalog | null): ResolvedPackTemplate {
  const pack = packId ?? "research";
  const override = findOrgDayTemplate(catalog, catalog?.packDefaults[pack]?.workdayTemplateId);
  if (override) return override;
  const builtin = resolvePackWorkdayTemplate(pack);
  return { source: "builtin", id: builtin.id, name: builtin.name, description: builtin.description, version: builtin.version, slots: builtin.slots };
}

/** Same resolution order for the break-day default; `null` = no default at all (built-in or org) for this pack. */
export function resolveBreakDayTemplate(packId: PackId | undefined, catalog: PublicCatalog | null): ResolvedPackTemplate | null {
  if (!packId) return null;
  const override = findOrgDayTemplate(catalog, catalog?.packDefaults[packId]?.breakDayTemplateId);
  if (override) return override;
  const builtin = resolvePackBreakDayTemplate(packId);
  if (!builtin) return null;
  return { source: "builtin", id: builtin.id, name: builtin.name, description: builtin.description, version: builtin.version, slots: builtin.slots };
}
