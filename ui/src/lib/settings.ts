export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "git", label: "Git" },
  { id: "commands", label: "Commands" },
  { id: "roles", label: "Roles & env" },
  { id: "files", label: "Ignored files" },
  { id: "scopes", label: "Scopes" },
  { id: "notifications", label: "Notifications" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function normalizeSettingsSectionId(
  value: string | null | undefined,
): SettingsSectionId | null {
  if (value === "workflow" || value === "base_prompt") return "general";
  if (value && isSettingsSectionId(value)) return value;
  return null;
}

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}
