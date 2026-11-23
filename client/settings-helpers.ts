import {
  OPENAI_COMPAT_PRESETS,
  type BackgroundAgentPreferences,
  type OpenAiCompatPresetId,
  type OpenAiCompatiblePreferences,
} from "../shared/preferences";

export const TIMEOUT_MS_MIN = 1000;
export const TIMEOUT_MS_MAX = 30000;

export const DEFAULT_ROTATE_OPTIONS = [1, 2, 3, 5, 10] as const;

export const DEFAULT_THINKING_OPTIONS = ["low", "medium", "high"] as const;

export interface ThinkingOptionItem {
  readonly id: string;
  readonly label: string;
}

export interface ProviderModelWithThinking {
  readonly id: string;
  readonly label: string;
  readonly thinkingOptions?: readonly ThinkingOptionItem[];
}

export type TimeoutParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly errorKind: "invalidNumber" | "outOfRange" };

export function applyOpenAiCompatPreset(
  current: OpenAiCompatiblePreferences,
  preset: OpenAiCompatPresetId,
): OpenAiCompatiblePreferences {
  if (preset === "custom") {
    return {
      ...current,
      preset: "custom",
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

export function parseTimeoutMs(raw: string): TimeoutParseResult {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, errorKind: "invalidNumber" };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < TIMEOUT_MS_MIN || parsed > TIMEOUT_MS_MAX) {
    return { ok: false, errorKind: "outOfRange" };
  }

  return { ok: true, value: parsed };
}

export function getModelThinkingOptions(
  models: readonly ProviderModelWithThinking[],
  selectedModelId: string,
): readonly ThinkingOptionItem[] {
  const matched = models.find((m) => m.id === selectedModelId);
  if (matched?.thinkingOptions && matched.thinkingOptions.length > 0) {
    return matched.thinkingOptions;
  }
  return [];
}

export function buildRotateAfterUsesValues(currentValue: number): readonly number[] {
  if (DEFAULT_ROTATE_OPTIONS.includes(currentValue as (typeof DEFAULT_ROTATE_OPTIONS)[number])) {
    return DEFAULT_ROTATE_OPTIONS;
  }
  return [...DEFAULT_ROTATE_OPTIONS, currentValue].sort((a, b) => a - b);
}

export function isBackgroundAgentDirty(
  saved: BackgroundAgentPreferences,
  draft: BackgroundAgentPreferences,
): boolean {
  return (
    saved.provider !== draft.provider ||
    saved.model !== draft.model ||
    saved.thinking !== draft.thinking ||
    saved.rotateAfterUses !== draft.rotateAfterUses
  );
}

export function isOpenAiCompatDirty(
  saved: OpenAiCompatiblePreferences,
  draft: OpenAiCompatiblePreferences,
): boolean {
  return (
    saved.preset !== draft.preset ||
    saved.baseUrl !== draft.baseUrl ||
    saved.model !== draft.model ||
    saved.apiKeyEnvVar !== draft.apiKeyEnvVar
  );
}
