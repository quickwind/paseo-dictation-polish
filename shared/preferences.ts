import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PolishEngineKindSchema = z.enum(["background-agent", "openai-compatible"]);
export type PolishEngineKind = z.infer<typeof PolishEngineKindSchema>;

export const PolishProfileSchema = z.enum(["clean", "structured", "translate-en"]);
export type PolishProfile = z.infer<typeof PolishProfileSchema>;

export const OpenAiCompatPresetIdSchema = z.enum([
  "opencode-go",
  "openai",
  "groq",
  "ollama",
  "custom",
]);
export type OpenAiCompatPresetId = z.infer<typeof OpenAiCompatPresetIdSchema>;

export interface OpenAiCompatPresetDefinition {
  readonly label: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnvVar: string;
}

export const OPENAI_COMPAT_PRESETS: Record<OpenAiCompatPresetId, OpenAiCompatPresetDefinition> = {
  "opencode-go": {
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "deepseek-v4.1-flash",
    apiKeyEnvVar: "OPENCODE_API_KEY",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    apiKeyEnvVar: "GROQ_API_KEY",
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b-instruct",
    apiKeyEnvVar: "",
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    model: "",
    apiKeyEnvVar: "",
  },
};

export const BackgroundAgentPreferencesSchema = z.object({
  provider: z.string().default(""),
  model: z.string().default(""),
  thinking: z.string().default("low"),
  rotateAfterUses: z.number().int().min(1).max(20).default(1),
});
export type BackgroundAgentPreferences = z.infer<typeof BackgroundAgentPreferencesSchema>;

export const OpenAiCompatiblePreferencesSchema = z.object({
  preset: OpenAiCompatPresetIdSchema.default("opencode-go"),
  baseUrl: z.string().default(OPENAI_COMPAT_PRESETS["opencode-go"].baseUrl),
  model: z.string().default(OPENAI_COMPAT_PRESETS["opencode-go"].model),
  apiKeyEnvVar: z.string().default(OPENAI_COMPAT_PRESETS["opencode-go"].apiKeyEnvVar),
});
export type OpenAiCompatiblePreferences = z.infer<typeof OpenAiCompatiblePreferencesSchema>;

/**
 * Providers that support a verifiable tool-free configuration at session creation.
 * Other Paseo coding providers leave built-in tools exposed and are disabled for
 * Background Agent polishing.
 */
export const TOOL_FREE_BACKGROUND_PROVIDERS = ["claude"] as const;

export function isToolFreeBackgroundProvider(provider: string): boolean {
  const normalized = provider.trim().split("/", 1)[0]?.toLowerCase() ?? "";
  return (TOOL_FREE_BACKGROUND_PROVIDERS as readonly string[]).includes(normalized);
}

export const PreferencesSchema = z.object({
  engine: PolishEngineKindSchema.default("background-agent"),
  backgroundAgent: BackgroundAgentPreferencesSchema.default(() =>
    BackgroundAgentPreferencesSchema.parse({}),
  ),
  openaiCompatible: OpenAiCompatiblePreferencesSchema.default(() =>
    OpenAiCompatiblePreferencesSchema.parse({}),
  ),
  profile: PolishProfileSchema.default("clean"),
  customInstructions: z.string().default(""),
  vocabulary: z.string().default(""),
  timeoutMs: z.number().int().min(1000).max(30000).default(8000),
  showComposerPill: z.boolean().default(false),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const preferencesSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: PreferencesSchema,
});
