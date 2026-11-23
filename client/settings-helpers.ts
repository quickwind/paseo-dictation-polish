import {
  OPENAI_COMPAT_PRESETS,
  type OpenAiCompatPresetId,
  type OpenAiCompatiblePreferences,
} from "../shared/preferences";

export const TIMEOUT_MIN_MS = 1000;
export const TIMEOUT_MAX_MS = 30000;

export function applyOpenAiCompatPreset(
  current: OpenAiCompatiblePreferences,
  preset: OpenAiCompatPresetId,
): OpenAiCompatiblePreferences {
  if (preset === "custom") {
    return {
      ...current,
      preset,
    };
  }

  const definition = OPENAI_COMPAT_PRESETS[preset];
  return {
    ...current,
    preset,
    baseUrl: definition.baseUrl,
    model: definition.model,
    apiKeyEnvVar: definition.apiKeyEnvVar,
  };
}

export type TimeoutValidationResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: "invalid_number" | "out_of_range" };

export function parseTimeoutMs(raw: string): TimeoutValidationResult {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: "invalid_number" };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < TIMEOUT_MIN_MS || parsed > TIMEOUT_MAX_MS) {
    return { ok: false, reason: "out_of_range" };
  }

  return { ok: true, value: parsed };
}

export function isOpenAiCompatDirty(
  saved: OpenAiCompatiblePreferences,
  draft: OpenAiCompatiblePreferences,
): boolean {
  return (
    saved.preset !== draft.preset ||
    saved.baseUrl.trim() !== draft.baseUrl.trim() ||
    saved.model.trim() !== draft.model.trim() ||
    saved.apiKeyEnvVar.trim() !== draft.apiKeyEnvVar.trim()
  );
}
