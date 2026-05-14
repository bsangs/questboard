export type TemplateValue = string | number | boolean | null | undefined;

export function renderTemplate(
  template: string,
  values: Record<string, TemplateValue>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key];
    return value == null ? match : String(value);
  });
}

