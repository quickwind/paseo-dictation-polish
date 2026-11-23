import type { OpenAiCompatiblePreferences } from "../shared/preferences";
import type { PolishMessages } from "./prompts";

export type EnvLookup = Readonly<Record<string, string | undefined>>;

export class OpenAiCompatibleEngineError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "OpenAiCompatibleEngineError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Resolves the API key for an OpenAI-compatible Polish Engine from the daemon
 * host environment (`env[apiKeyEnvVar]`), or returns undefined when omitted
 * (for keyless local endpoints such as Ollama). API keys are never persisted in
 * host plugin settings.
 */
export function resolveOpenAiCompatibleApiKey(
  config: Pick<OpenAiCompatiblePreferences, "apiKeyEnvVar">,
  env: EnvLookup,
): string | undefined {
  const envVarName = config.apiKeyEnvVar.trim();
  if (envVarName.length > 0) {
    const fromEnv = env[envVarName]?.trim();
    if (fromEnv) {
      return fromEnv;
    }
  }

  return undefined;
}

export interface RunOpenAiCompatibleOptions {
  readonly config: OpenAiCompatiblePreferences;
  readonly messages: PolishMessages;
  readonly signal: AbortSignal;
  readonly fetchFn?: typeof fetch;
  readonly env?: EnvLookup;
}

function extractCompletionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new OpenAiCompatibleEngineError("invalid_response", "Invalid JSON response payload.");
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OpenAiCompatibleEngineError("invalid_response", "Response contained no choices.");
  }

  const firstChoice = choices[0] as { message?: { content?: unknown } };
  const content = firstChoice?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
    return textParts;
  }

  throw new OpenAiCompatibleEngineError("invalid_response", "Choice message had no text content.");
}

/**
 * Calls an OpenAI-compatible `/chat/completions` endpoint and returns raw model text.
 */
export async function runOpenAiCompatiblePolish({
  config,
  messages,
  signal,
  fetchFn = fetch,
  env = process.env,
}: RunOpenAiCompatibleOptions): Promise<string> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new OpenAiCompatibleEngineError("missing_base_url", "OpenAI-compatible baseUrl is empty.");
  }

  const model = config.model.trim();
  if (!model) {
    throw new OpenAiCompatibleEngineError("missing_model", "OpenAI-compatible model is empty.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = resolveOpenAiCompatibleApiKey(config, env);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchFn(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: messages.systemPrompt },
        { role: "user", content: messages.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new OpenAiCompatibleEngineError(
      "http_error",
      `OpenAI-compatible endpoint returned HTTP ${response.status}`,
      response.status,
    );
  }

  const payload: unknown = await response.json();
  return extractCompletionText(payload);
}
