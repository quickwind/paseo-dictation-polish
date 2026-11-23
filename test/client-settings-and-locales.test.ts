import { describe, expect, it } from "vitest";
import en from "../client/locales/en.json";
import zhCN from "../client/locales/zh-CN.json";
import {
  applyOpenAiCompatPreset,
  isOpenAiCompatDirty,
  parseTimeoutMs,
} from "../client/settings-helpers";
import {
  OPENAI_COMPAT_PRESETS,
  OpenAiCompatiblePreferencesSchema,
} from "../shared/preferences";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result[nextKey] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenKeys(value as Record<string, unknown>, nextKey));
    }
  }
  return result;
}

function extractPlaceholders(template: string): string[] {
  const matches = template.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/[\s{}]/g, "")))].sort();
}

describe("client locales parity", () => {
  it("keeps identical translation keys and interpolation placeholders between en.json and zh-CN.json", () => {
    const enFlat = flattenKeys(en);
    const zhFlat = flattenKeys(zhCN);

    const enKeys = Object.keys(enFlat).sort();
    const zhKeys = Object.keys(zhFlat).sort();
    expect(zhKeys).toEqual(enKeys);

    for (const key of enKeys) {
      expect(enFlat[key].trim().length, `empty en translation for ${key}`).toBeGreaterThan(0);
      expect(zhFlat[key].trim().length, `empty zh-CN translation for ${key}`).toBeGreaterThan(0);
      expect(extractPlaceholders(zhFlat[key]), `placeholder mismatch for ${key}`).toEqual(
        extractPlaceholders(enFlat[key]),
      );
    }
  });
});

describe("client/settings-helpers", () => {
  it("applies non-custom OpenAI-compatible presets cleanly", () => {
    const initial = OpenAiCompatiblePreferencesSchema.parse({
      preset: "opencode-go",
    });

    const ollama = applyOpenAiCompatPreset(initial, "ollama");
    expect(ollama).toEqual({
      preset: "ollama",
      baseUrl: OPENAI_COMPAT_PRESETS.ollama.baseUrl,
      model: OPENAI_COMPAT_PRESETS.ollama.model,
      apiKeyEnvVar: OPENAI_COMPAT_PRESETS.ollama.apiKeyEnvVar,
    });

    const opencodeGo = applyOpenAiCompatPreset(ollama, "opencode-go");
    expect(opencodeGo).toEqual({
      preset: "opencode-go",
      baseUrl: OPENAI_COMPAT_PRESETS["opencode-go"].baseUrl,
      model: OPENAI_COMPAT_PRESETS["opencode-go"].model,
      apiKeyEnvVar: OPENAI_COMPAT_PRESETS["opencode-go"].apiKeyEnvVar,
    });
  });

  it("preserves existing fields when switching to custom preset", () => {
    const initial = OpenAiCompatiblePreferencesSchema.parse({
      preset: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyEnvVar: "OPENAI_API_KEY",
    });

    const custom = applyOpenAiCompatPreset(initial, "custom");
    expect(custom).toEqual({
      ...initial,
      preset: "custom",
    });
  });

  it("validates timeoutMs bounds (1000-30000 integer)", () => {
    expect(parseTimeoutMs("8000")).toEqual({ ok: true, value: 8000 });
    expect(parseTimeoutMs(" 1000 ")).toEqual({ ok: true, value: 1000 });
    expect(parseTimeoutMs("30000")).toEqual({ ok: true, value: 30000 });
    expect(parseTimeoutMs("999")).toEqual({ ok: false, reason: "out_of_range" });
    expect(parseTimeoutMs("30001")).toEqual({ ok: false, reason: "out_of_range" });
    expect(parseTimeoutMs("8000.5")).toEqual({ ok: false, reason: "invalid_number" });
    expect(parseTimeoutMs("abc")).toEqual({ ok: false, reason: "invalid_number" });
    expect(parseTimeoutMs("")).toEqual({ ok: false, reason: "invalid_number" });
  });

  it("detects dirty state for openaiCompatible drafts", () => {
    const oaiSaved = OpenAiCompatiblePreferencesSchema.parse({});
    expect(isOpenAiCompatDirty(oaiSaved, { ...oaiSaved })).toBe(false);
    expect(isOpenAiCompatDirty(oaiSaved, { ...oaiSaved, model: "gpt-4o" })).toBe(true);
  });
});
