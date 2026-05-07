/**
 * Language detection helper. Wraps `franc` and maps to ISO 639-1 codes
 * we care about. Falls back to BoardConfig.default_language.
 */
import { franc } from "franc";

const ISO3_TO_ISO1: Record<string, string> = {
  kor: "ko",
  jpn: "ja",
  eng: "en",
  cmn: "zh",
  spa: "es",
  fra: "fr",
  deu: "de",
  rus: "ru",
  por: "pt",
  ita: "it",
  vie: "vi",
  ind: "id",
};

export function detectLanguage(text: string, fallback = "en"): string {
  const sample = text.trim();
  if (sample.length < 10) return fallback;
  const code3 = franc(sample, { minLength: 10 });
  if (code3 === "und") return fallback;
  return ISO3_TO_ISO1[code3] ?? fallback;
}
