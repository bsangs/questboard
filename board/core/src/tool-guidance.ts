export function buildToolGuidanceSection(guidanceByTool: Record<string, string>): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const [tool, guidance] of Object.entries(guidanceByTool)) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    const text = guidance.trim();
    if (text) sections.push(text);
  }
  return sections.join("\n\n");
}
