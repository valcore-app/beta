"use client";

export type CanonicalSectionId =
  | "welcome"
  | "capital-protection"
  | "weekly-lock-entry"
  | "formation-roles"
  | "relative-scoring"
  | "role-multipliers"
  | "salary-power-cap"
  | "live-price-feedback"
  | "tactical-moves"
  | "movers-radar"
  | "swap-flow"
  | "closing";

export type ProtocolGuideSectionId = CanonicalSectionId;

const canonicalSectionIds: CanonicalSectionId[] = [
  "welcome",
  "capital-protection",
  "weekly-lock-entry",
  "formation-roles",
  "relative-scoring",
  "role-multipliers",
  "salary-power-cap",
  "live-price-feedback",
  "tactical-moves",
  "movers-radar",
  "swap-flow",
  "closing",
];

const sectionIdSet = new Set<CanonicalSectionId>(canonicalSectionIds);

export const normalizeProtocolGuideSection = (value?: string | null): CanonicalSectionId => {
  if (!value) return "welcome";
  if (sectionIdSet.has(value as CanonicalSectionId)) {
    return value as CanonicalSectionId;
  }
  return "welcome";
};

