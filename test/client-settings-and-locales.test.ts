import { describe, expect, it } from "vitest";
import en from "../client/locales/en.json";
import zhCn from "../client/locales/zh-CN.json";
import {
  applyOpenAiCompatPreset,
  buildRotateAfterUsesValues,
  getModelThinkingOptions,
  isBackgroundAgentDirty,
  isOpenAiCompatDirty,
  parseTimeoutMs,
} from "../client/settings-helpers";
import {
  BackgroundAgentPreferencesSchema,
  OPENAI_COMPAT_PRESETS,
  OpenAiCompatiblePreferencesSchema,
} from "../shared/preferences";

function flattenLocaleKeys(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result[fullKey] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenLocaleKeys(value as Record<string, unknown>, fullKey));
    }
  }
  return result;
}

function extractPlaceholders(text: string): string[] {
  const matches = text.match(/\{\{[^}]+\}\}/g) ?? [];
  return [...matches].sort();
}

describe("client locales parity", () => {
  it("has identical translation keys in en.json and zh-CN.json", () => {
    const enFlat = flattenLocaleKeys(en);
    const zhFlat = flattenLocaleKeys(zhCn);

    expect(Object.keys(zhFlat).sort()).toEqual(Object.keys(enFlat).sort());
  });

  it("has matching interpolation placeholders for every key", () => {
    const enFlat = flattenLocaleKeys(en);
    const zhFlat = flattenLocaleKeys(zhCn);

    for (const key of Object.keys(enFlat)) {
      expect(extractPlaceholders(zhFlat[key]), `Placeholder mismatch on key "${key}"`).toEqual(
        extractPlaceholders(enFlat[key]),
      );
    }
  });
});

describe("client/settings-helpers", () => {
  it("applies non-custom OpenAI-compatible presets while preserving apiKey", () => {
    const initial = OpenAiCompatiblePreferencesSchema.parse({
      preset: "opencode-go",
      apiKey: "secret-key",
    });

    const ollama = applyOpenAiCompatPreset(initial, "ollama");
    expect(ollama).toEqual({
      preset: "ollama",
      baseUrl: OPENAI_COMPAT_PRESETS.ollama.baseUrl,
      model: OPENAI_COMPAT_PRESETS.ollama.model,
      apiKeyEnvVar: OPENAI_COMPAT_PRESETS.ollama.apiKeyEnvVar,
      apiKey: "secret-key",
    });

    const opencodeGo = applyOpenAiCompatPreset(ollama, "opencode-go");
    expect(opencodeGo).toEqual({
      preset: "opencode-go",
      baseUrl: OPENAI_COMPAT_PRESETS["opencode-go"].baseUrl,
      model: OPENAI_COMPAT_PRESETS["opencode-go"].model,
      apiKeyEnvVar: OPENAI_COMPAT_PRESETS["opencode-go"].apiKeyEnvVar,
      apiKey: "secret-key",
    });
  });

  it("preserves existing fields when switching to custom preset", () => {
    const initial = OpenAiCompatiblePreferencesSchema.parse({
      preset: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyEnvVar: "OPENAI_API_KEY",
      apiKey: "sk-test",
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

    expect(parseTimeoutMs("999")).toEqual({ ok: false, errorKind: "outOfRange" });
    expect(parseTimeoutMs("30001")).toEqual({ ok: false, errorKind: "outOfRange" });
    expect(parseTimeoutMs("8000.5")).toEqual({ ok: false, errorKind: "invalidNumber" });
    expect(parseTimeoutMs("abc")).toEqual({ ok: false, errorKind: "invalidNumber" });
    expect(parseTimeoutMs("")).toEqual({ ok: false, errorKind: "invalidNumber" });
  });

  it("extracts model-specific thinking options when available", () => {
    const models = [
      {
        id: "gpt-5",
        label: "GPT-5",
        thinkingOptions: [
          { id: "minimal", label: "Minimal" },
          { id: "high", label: "High" },
        ],
      },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
    ];

    expect(getModelThinkingOptions(models, "gpt-5")).toEqual([
      { id: "minimal", label: "Minimal" },
      { id: "high", label: "High" },
    ]);
    expect(getModelThinkingOptions(models, "gpt-4o-mini")).toEqual([]);
    expect(getModelThinkingOptions(models, "missing")).toEqual([]);
  });

  it("builds sorted rotateAfterUses options including non-default saved values", () => {
    expect(buildRotateAfterUsesValues(1)).toEqual([1, 2, 3, 5, 10]);
    expect(buildRotateAfterUsesValues(4)).toEqual([1, 2, 3, 4, 5, 10]);
  });

  it("detects dirty state for backgroundAgent and openaiCompatible drafts", () => {
    const bgSaved = BackgroundAgentPreferencesSchema.parse({});
    expect(isBackgroundAgentDirty(bgSaved, { ...bgSaved })).toBe(false);
    expect(isBackgroundAgentDirty(bgSaved, { ...bgSaved, thinking: "high" })).toBe(true);

    const oaiSaved = OpenAiCompatiblePreferencesSchema.parse({});
    expect(isOpenAiCompatDirty(oaiSaved, { ...oaiSaved })).toBe(false);
    expect(isOpenAiCompatDirty(oaiSaved, { ...oaiSaved, model: "gpt-4o" })).toBe(true);
  });
});
