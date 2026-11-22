import { describe, expect, it, vi } from "vitest";
import { PolishService } from "../server/polish-service";
import {
  OPENAI_COMPAT_PRESETS,
  PreferencesSchema,
  type Preferences,
} from "../shared/preferences";

function makePreferences(overrides: Partial<Preferences> = {}): Preferences {
  const base = PreferencesSchema.parse({});
  return {
    ...base,
    ...overrides,
    backgroundAgent: {
      ...base.backgroundAgent,
      ...overrides.backgroundAgent,
    },
    openaiCompatible: {
      ...base.openaiCompatible,
      ...overrides.openaiCompatible,
    },
  };
}

function makeChatResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("Preferences & PolishService", () => {
  it("parses empty settings into complete defaults and exposes all presets", () => {
    const defaults = PreferencesSchema.parse({});
    expect(defaults).toEqual({
      engine: "background-agent",
      backgroundAgent: {
        provider: "",
        model: "",
        thinking: "low",
        rotateAfterUses: 1,
      },
      openaiCompatible: {
        preset: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        model: "deepseek-v4.1-flash",
        apiKeyEnvVar: "OPENCODE_API_KEY",
        apiKey: "",
      },
      profile: "clean",
      customInstructions: "",
      vocabulary: "",
      timeoutMs: 8000,
      showComposerPill: false,
    });
    expect(Object.keys(OPENAI_COMPAT_PRESETS)).toEqual([
      "opencode-go",
      "openai",
      "groq",
      "ollama",
      "custom",
    ]);
  });

  it("polishes via OpenCode Go preset with env-var-first auth and clean prompt guardrails", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return makeChatResponse("Refactor the login handler and run the tests.");
    });

    const service = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "openai-compatible",
          openaiCompatible: {
            preset: "opencode-go",
            baseUrl: "https://opencode.ai/zen/go/v1/",
            model: "deepseek-v4.1-flash",
            apiKeyEnvVar: "OPENCODE_API_KEY",
            apiKey: "inline-should-not-win",
          },
        }),
      fetchFn,
      env: { OPENCODE_API_KEY: "env-secret-key" },
    });

    const result = await service.polish({
      text: "um refactor the login handler and uh run the tests",
    });

    expect(result.fallback).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.engine).toBe("openai-compatible");
    expect(result.text).toBe("Refactor the login handler and run the tests.");

    expect(capturedUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer env-secret-key");

    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("deepseek-v4.1-flash");
    expect(body.messages[0]?.content).toContain("NEVER answer questions");
    expect(body.messages[0]?.content).toContain("Polish Profile: clean");
    expect(body.messages[1]?.content).toContain("<raw_draft>");
    expect(body.messages[1]?.content).toContain(
      "um refactor the login handler and uh run the tests",
    );
  });

  it("falls back to inline apiKey when env var is missing", async () => {
    let authHeader: string | undefined;
    const fetchFn: typeof fetch = vi.fn(async (_input, init) => {
      authHeader = (init?.headers as Record<string, string>).Authorization;
      return makeChatResponse("Polished text.");
    });

    const service = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "openai-compatible",
          openaiCompatible: {
            preset: "openai",
            baseUrl: OPENAI_COMPAT_PRESETS.openai.baseUrl,
            model: OPENAI_COMPAT_PRESETS.openai.model,
            apiKeyEnvVar: "OPENAI_API_KEY",
            apiKey: "inline-fallback-key",
          },
        }),
      fetchFn,
      env: {},
    });

    const result = await service.polish({ text: "polished text" });
    expect(result.fallback).toBe(false);
    expect(authHeader).toBe("Bearer inline-fallback-key");
  });

  it("omits Authorization header for keyless Ollama preset", async () => {
    let headersSent: Record<string, string> = {};
    const fetchFn: typeof fetch = vi.fn(async (_input, init) => {
      headersSent = init?.headers as Record<string, string>;
      return makeChatResponse("Check local Ollama.");
    });

    const service = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "openai-compatible",
          openaiCompatible: {
            preset: "ollama",
            baseUrl: OPENAI_COMPAT_PRESETS.ollama.baseUrl,
            model: OPENAI_COMPAT_PRESETS.ollama.model,
            apiKeyEnvVar: "",
            apiKey: "",
          },
        }),
      fetchFn,
      env: {},
    });

    const result = await service.polish({ text: "check local ollama" });
    expect(result.fallback).toBe(false);
    expect(headersSent.Authorization).toBeUndefined();
  });

  it("returns whitespace-only input unchanged without calling engine", async () => {
    const fetchFn = vi.fn();
    const service = new PolishService({
      getSettings: async () => makePreferences({ engine: "openai-compatible" }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await service.polish({ text: "   \n\t  " });
    expect(result.text).toBe("   \n\t  ");
    expect(result.changed).toBe(false);
    expect(result.fallback).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails open when background-agent engine is selected but not configured", async () => {
    const service = new PolishService({
      getSettings: async () => makePreferences({ engine: "background-agent" }),
    });

    const result = await service.polish({ text: "hello world" });
    expect(result.text).toBe("hello world");
    expect(result.changed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe("background_agent_not_configured");
    expect(result.engine).toBe("background-agent");
  });

  it("fails open on timeout", async () => {
    const fetchFn: typeof fetch = vi.fn((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const service = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "openai-compatible",
          timeoutMs: 25,
        }),
      fetchFn,
      env: { OPENCODE_API_KEY: "test" },
    });

    const result = await service.polish({ text: "original draft" });
    expect(result.text).toBe("original draft");
    expect(result.changed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe("timeout");
  });

  it("fails open on HTTP error without leaking API key", async () => {
    const fetchFn: typeof fetch = vi.fn(async () => new Response("Unauthorized", { status: 401 }));

    const service = new PolishService({
      getSettings: async () => makePreferences({ engine: "openai-compatible" }),
      fetchFn,
      env: { OPENCODE_API_KEY: "super-secret-token" },
    });

    const result = await service.polish({ text: "original draft" });
    expect(result.text).toBe("original draft");
    expect(result.changed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe("http_error");
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });

  it("fails open on empty model output", async () => {
    const fetchFn: typeof fetch = vi.fn(async () => makeChatResponse("   \n "));

    const service = new PolishService({
      getSettings: async () => makePreferences({ engine: "openai-compatible" }),
      fetchFn,
      env: { OPENCODE_API_KEY: "test" },
    });

    const result = await service.polish({ text: "original draft" });
    expect(result.text).toBe("original draft");
    expect(result.changed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe("empty_output");
  });

  it("fails open on runaway expansion for non-translation profiles", async () => {
    const bloated = "A".repeat(300);
    const fetchFn: typeof fetch = vi.fn(async () => makeChatResponse(bloated));

    const service = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "openai-compatible",
          profile: "clean",
        }),
      fetchFn,
      env: { OPENCODE_API_KEY: "test" },
    });

    const result = await service.polish({ text: "short draft" });
    expect(result.text).toBe("short draft");
    expect(result.changed).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe("suspicious_expansion");
  });
});
