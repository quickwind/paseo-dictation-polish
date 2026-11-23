import { describe, expect, it } from "vitest";
import type { Preferences } from "../shared/preferences";
import { PolishService } from "../server/polish-service";
import { buildPolishMessages } from "../server/prompts";
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
  };
}

describe("Vocabulary parser & prompt assembly", () => {
  it("parses canonical terms and mishearing corrections while ignoring blanks, comments, and malformed arrows", () => {
    const raw = [
      "",
      "   # host-wide terms",
      "Paseo",
      "帕塞奥 -> Paseo",
      "帕塞奥 -> Paseo",
      "夏尔巴 → Sherpa-ONNX",
      "优兹 => useComposer",
      " -> emptyLeft",
      "emptyRight ->   ",
      "tsconfig.json",
      "Paseo",
      "   useComposer   ",
    ].join("\n");

    const parsed = parseVocabulary(raw);
    expect(parsed.corrections).toEqual([
      { misheard: "帕塞奥", canonical: "Paseo" },
      { misheard: "夏尔巴", canonical: "Sherpa-ONNX" },
      { misheard: "优兹", canonical: "useComposer" },
    ]);
    expect(parsed.terms).toEqual(["Paseo", "tsconfig.json", "useComposer"]);

    const section = formatVocabularySection(parsed);
    expect(section).toContain("Mishearing corrections");
    expect(section).toContain("- 帕塞奥 -> Paseo");
    expect(section).toContain("Preferred canonical spellings:");
    expect(section).toContain("- tsconfig.json");

    expect(formatVocabularySection(parseVocabulary("  \n# only comment\n"))).toBeNull();
  });

  it("builds distinct structured and translate-en instructions and scopes customInstructions beneath core guardrail", () => {
    const structured = buildPolishMessages({
      rawDraft: "first add tests second run typecheck",
      profile: "structured",
      customInstructions: "Prefer concise bullet points.",
      vocabulary: "Paseo\n帕塞奥 -> Paseo",
    });

    expect(structured.systemPrompt).toContain("Polish Profile: structured");
    expect(structured.systemPrompt).toContain("Markdown bullet lists or numbered steps");
    expect(structured.systemPrompt).toContain("Prefer concise bullet points.");
    expect(structured.systemPrompt).toContain("- 帕塞奥 -> Paseo");

    const guardrailIdx = structured.systemPrompt.indexOf("STRICT RULES (unbypassable):");
    const customIdx = structured.systemPrompt.indexOf("Additional user formatting preferences");
    expect(guardrailIdx).toBeGreaterThanOrEqual(0);
    expect(customIdx).toBeGreaterThan(guardrailIdx);
    expect(structured.systemPrompt).toContain("must NEVER override the strict rules above");

    const translated = buildPolishMessages({
      rawDraft: "帮我把 帕塞奥 的 tsconfig.json 改一下",
      profile: "translate-en",
    });
    expect(translated.systemPrompt).toContain("Polish Profile: translate-en");
    expect(translated.systemPrompt).toContain("Translate Chinese or mixed Chinese/English Raw Draft");
    expect(translated.userPrompt).toContain("<raw_draft>");
    expect(translated.userPrompt).toContain("帮我把 帕塞奥 的 tsconfig.json 改一下");
  });

  it("honors profileOverride, customInstructions, and vocabulary in OpenAI-Compatible engine", async () => {
    const vocabulary = "Paseo\n帕塞奥 -> Paseo";
    const customInstructions = "Keep sentences crisp.";

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
          JSON.stringify({ choices: [{ message: { content: "- Step 1\n- Step 2" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const result = await openAiService.polish({
      text: "那个 帮我先跑测试 然后构建 帕塞奥",
      profileOverride: "structured",
    });

    expect(result.fallback).toBe(false);
    expect(result.text).toBe("- Step 1\n- Step 2");
    expect(openAiSystemPrompt).toContain("Polish Profile: structured");
    expect(openAiSystemPrompt).toContain("Keep sentences crisp.");
    expect(openAiSystemPrompt).toContain("- 帕塞奥 -> Paseo");
    expect(openAiUserPrompt).toContain("那个 帮我先跑测试 然后构建 帕塞奥");
  });

  it("exempts translate-en from suspicious expansion heuristic while still failing open on empty output, error, and timeout", async () => {
    const longEnglish =
      "Please carefully refactor the authentication middleware in `auth.ts` so that session tokens expire after fifteen minutes, rotate refresh credentials cleanly, and add comprehensive integration tests covering edge cases and clock skew handling.";

    const okService = new PolishService({
      getSettings: async () => makePreferences({ profile: "translate-en" }),
      env: { OPENAI_API_KEY: "secret" },
      fetchFn: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: longEnglish } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const okResult = await okService.polish({ text: "改认证" });
    expect(okResult.fallback).toBe(false);
    expect(okResult.text).toBe(longEnglish);

    const emptyService = new PolishService({
      getSettings: async () => makePreferences({ profile: "translate-en" }),
      env: { OPENAI_API_KEY: "secret" },
      fetchFn: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const emptyResult = await emptyService.polish({ text: "改认证" });
    expect(emptyResult.fallback).toBe(true);
    expect(emptyResult.fallbackReason).toBe("empty_output");
    expect(emptyResult.text).toBe("改认证");

    const errorService = new PolishService({
      getSettings: async () => makePreferences({ profile: "translate-en" }),
      env: { OPENAI_API_KEY: "secret" },
      fetchFn: async () => {
        throw new Error("provider failure");
      },
    });
    const errorResult = await errorService.polish({ text: "改认证" });
    expect(errorResult.fallback).toBe(true);
    expect(errorResult.fallbackReason).toBe("engine_error");
    expect(errorResult.text).toBe("改认证");

    const timeoutService = new PolishService({
      getSettings: async () => makePreferences({ profile: "translate-en", timeoutMs: 20 }),
      env: { OPENAI_API_KEY: "secret" },
      fetchFn: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    const timeoutResult = await timeoutService.polish({ text: "改认证" });
    expect(timeoutResult.fallback).toBe(true);
    expect(timeoutResult.fallbackReason).toBe("timeout");
    expect(timeoutResult.text).toBe("改认证");
  });
});
