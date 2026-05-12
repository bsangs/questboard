import { notFound, redirect } from "next/navigation";
import { SettingsPage } from "@/components/SettingsPage";
import { isSettingsSectionId, normalizeSettingsSectionId } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const normalized = normalizeSettingsSectionId(section);
  if (normalized && normalized !== section) redirect(`/settings/${normalized}`);
  if (!isSettingsSectionId(section)) notFound();
  return <SettingsPage section={section} />;
}
