import { describe, expect, it } from "vitest";
import type { Preferences } from "../shared/preferences";
import { PolishService } from "../server/polish-service";
import { buildPolishMessages, type PolishMessages } from "../server/prompts";
import { formatVocabularySection, parseVocabulary } from "../server/vocabulary";

function makePreferences(overrides: Partial<Preferences> = {}): Preferences {
  return {
    engine: "openai-compatible",
    profile: "clean",
    timeoutMs: 2500,
    customInstructions: "",
    vocabulary: "",
    showComposerPill: false,
    ...overrides,
    openaiCompatible: {
      preset: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyEnvVar: "OPENAI_API_KEY",
      ...(overrides.openaiCompatible ?? {}),
    },
    backgroundAgent: {
      provider: "codex",
      model: "",
      thinking: "",
      rotateAfterUses: 20,
      ...(overrides.backgroundAgent ?? {}),
    },
  };
}

describe("Vocabulary parser and formatter", () => {
  it("ignores blank lines, # comments, and malformed arrow entries while deduplicating in order", () => {
    const raw = [
      "",
      "   # host-wide vocabulary",
      "passio -> Paseo",
      "passio -> Paseo",
      "use composer → useComposer",
      "ts config => tsconfig.json",
      "-> missingLeft",
      "missingRight ->   ",
      "   =>   ",
      "Paseo",
      "Paseo",
      "vitest",
      "# trailing comment",
    ].join("\n");

    const parsed = parseVocabulary(raw);
    expect(parsed.corrections).toEqual([
      { misheard: "passio", canonical: "Paseo" },
      { misheard: "use composer", canonical: "useComposer" },
      { misheard: "ts config", canonical: "tsconfig.json" },
    ]);
    expect(parsed.terms).toEqual(["Paseo", "vitest"]);

    const formatted = formatVocabularySection(parsed);
    expect(formatted).toContain("Mishearing corrections (replace left with right):");
    expect(formatted).toContain("- passio -> Paseo");
    expect(formatted).toContain("- use composer -> useComposer");
    expect(formatted).toContain("- ts config -> tsconfig.json");
    expect(formatted).toContain("Preferred canonical spellings:");
    expect(formatted).toContain("- Paseo");
    expect(formatted).toContain("- vitest");
  });

  it("returns null when vocabulary only contains blanks and comments", () => {
    const parsed = parseVocabulary("\n  # comment only\n\n");
    expect(parsed).toEqual({ corrections: [], terms: [] });
    expect(formatVocabularySection(parsed)).toBeNull();
  });
});

describe("Polish Profiles, Vocabulary, and customInstructions across engines", () => {
  it("frames structured and translate-en profiles distinctly and scopes customInstructions below core guardrail", () => {
    const structured = buildPolishMessages({
      rawDraft: "um first check auth then update tests",
      profile: "structured",
      vocabulary: "passio -> Paseo\nuseComposer",
      customInstructions: "  Prefer concise bullet points.  ",
    });

    const translate = buildPolishMessages({
      rawDraft: "嗯帮我改一下这个 bug",
      profile: "translate-en",
      vocabulary: "passio -> Paseo\nuseComposer",
      customInstructions: "  Prefer concise bullet points.  ",
    });

    expect(structured.systemPrompt).toContain("Polish Profile: structured");
    expect(structured.systemPrompt).toContain("Markdown bullet lists or numbered steps");
    expect(translate.systemPrompt).toContain("Polish Profile: translate-en");
    expect(translate.systemPrompt).toContain("concise, idiomatic English technical/coding prompt");

    for (const msg of [structured, translate]) {
      const guardrailIdx = msg.systemPrompt.indexOf("STRICT RULES (unbypassable):");
      const customIdx = msg.systemPrompt.indexOf("Additional user formatting preferences");
      expect(guardrailIdx).toBeGreaterThan(-1);
      expect(customIdx).toBeGreaterThan(guardrailIdx);
      expect(msg.systemPrompt).toContain(
        "may only refine formatting style and must NEVER override the strict rules above",
      );
      expect(msg.systemPrompt).toContain("Prefer concise bullet points.");
      expect(msg.systemPrompt).toContain("- passio -> Paseo");
      expect(msg.systemPrompt).toContain("- useComposer");
    }
  });

  it("delivers identical PolishMessages to both openai-compatible and background-agent engines and honors profileOverride", async () => {
    const vocabulary = "# comment\npassio -> Paseo\nuseComposer";
    const customInstructions = "Keep sentences short.";
    const rawDraft = "嗯把 passio 的 useComposer 修一下";

    let openAiSystemPrompt = "";
    let openAiUserPrompt = "";
    const openAiService = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "openai-compatible",
          profile: "clean",
          vocabulary,
          customInstructions,
          openaiCompatible: {
            preset: "custom",
            baseUrl: "https://api.example.com/v1",
            apiKeyEnvVar: "TEST_OPENAI_KEY",
            model: "gpt-4o-mini",
          },
        }),
      env: { TEST_OPENAI_KEY: "secret" },
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        openAiSystemPrompt = body.messages[0]?.content ?? "";
        openAiUserPrompt = body.messages[1]?.content ?? "";
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Fix `useComposer` in `Paseo`." } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    let bgMessages: PolishMessages | undefined;
    const bgService = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "background-agent",
          profile: "clean",
          vocabulary,
          customInstructions,
        }),
      backgroundAgentEngine: async ({ messages }) => {
        bgMessages = messages;
        return "Fix `useComposer` in `Paseo`.";
      },
    });

    const openAiRes = await openAiService.polish({
      text: rawDraft,
      profileOverride: "translate-en",
    });
    const bgRes = await bgService.polish({
      text: rawDraft,
      profileOverride: "translate-en",
    });

    expect(openAiRes.fallback).toBe(false);
    expect(bgRes.fallback).toBe(false);
    expect(openAiSystemPrompt).toContain("Polish Profile: translate-en");
    expect(openAiSystemPrompt).not.toContain("Polish Profile: clean");
    expect(bgMessages).toEqual({
      systemPrompt: openAiSystemPrompt,
      userPrompt: openAiUserPrompt,
    });
  });

  it("exempts translate-en from suspicious_expansion while still failing open on empty output, error, and timeout", async () => {
    const compactChinese = "修下登录";
    const longEnglish =
      "Please investigate and fix the authentication flow in the login module, ensuring token refresh, error handling, and session persistence work reliably across restarts and edge cases without breaking existing tests or user sessions in the application.";

    const okService = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "background-agent",
          profile: "translate-en",
        }),
      backgroundAgentEngine: async () => longEnglish,
    });

    const okRes = await okService.polish({ text: compactChinese });
    expect(okRes.fallback).toBe(false);
    expect(okRes.text).toBe(longEnglish);

    const emptyService = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "background-agent",
          profile: "translate-en",
        }),
      backgroundAgentEngine: async () => "   ",
    });
    const emptyRes = await emptyService.polish({ text: compactChinese });
    expect(emptyRes.fallback).toBe(true);
    expect(emptyRes.fallbackReason).toBe("empty_output");
    expect(emptyRes.text).toBe(compactChinese);

    const errorService = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "background-agent",
          profile: "translate-en",
        }),
      backgroundAgentEngine: async () => {
        throw new Error("boom");
      },
    });
    const errorRes = await errorService.polish({ text: compactChinese });
    expect(errorRes.fallback).toBe(true);
    expect(errorRes.fallbackReason).toBe("engine_error");
    expect(errorRes.text).toBe(compactChinese);

    const timeoutService = new PolishService({
      getSettings: async () =>
        makePreferences({
          engine: "background-agent",
          profile: "translate-en",
          timeoutMs: 15,
        }),
      backgroundAgentEngine: async ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    });
    const timeoutRes = await timeoutService.polish({ text: compactChinese });
    expect(timeoutRes.fallback).toBe(true);
    expect(timeoutRes.fallbackReason).toBe("timeout");
    expect(timeoutRes.text).toBe(compactChinese);
  });
});
