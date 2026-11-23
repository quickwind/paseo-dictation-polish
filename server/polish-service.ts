import type { PolishProfile, Preferences } from "../shared/preferences";
import type {
  PolishRunInput,
  PolishRunOutput,
  PolishStatusOutput,
} from "../shared/rpc";
import {
  OpenAiCompatibleEngineError,
  runOpenAiCompatiblePolish,
  type EnvLookup,
} from "./openai-compatible-engine";
import { buildPolishMessages } from "./prompts";

export interface PolishServiceOptions {
  readonly getSettings: () => Promise<Preferences>;
  readonly fetchFn?: typeof fetch;
  readonly env?: EnvLookup;
  readonly now?: () => number;
}

function isAbortOrTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function classifyFailureReason(error: unknown, signal: AbortSignal): string {
  if (isAbortOrTimeoutError(error, signal)) {
    return "timeout";
  }
  if (error instanceof OpenAiCompatibleEngineError) {
    return error.code;
  }
  return "engine_error";
}

function isSuspiciousExpansion(
  rawDraft: string,
  polishedText: string,
  profile: PolishProfile,
): boolean {
  if (profile === "translate-en") {
    return false;
  }
  return polishedText.length > rawDraft.length * 3 + 200;
}

/**
 * Server-side Polish Engine orchestrator enforcing strict fail-open guarantees
 * over a text-only OpenAI-compatible chat endpoint.
 */
export class PolishService {
  private readonly getSettings: () => Promise<Preferences>;
  private readonly fetchFn: typeof fetch;
  private readonly env: EnvLookup;
  private readonly now: () => number;
  private lastLatencyMs: number | null = null;
  private lastFallbackReason: string | null = null;

  constructor(options: PolishServiceOptions) {
    this.getSettings = options.getSettings;
    this.fetchFn = options.fetchFn ?? fetch;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
  }

  async getStatus(): Promise<PolishStatusOutput> {
    const preferences = await this.getSettings();
    return {
      engine: preferences.engine,
      lastLatencyMs: this.lastLatencyMs,
      lastFallbackReason: this.lastFallbackReason,
      showComposerPill: preferences.showComposerPill,
    };
  }

  async polish(input: PolishRunInput): Promise<PolishRunOutput> {
    const startedAt = this.now();
    const preferences = await this.getSettings();
    const engine = preferences.engine;
    const profile = input.profileOverride ?? preferences.profile;

    const elapsedMs = () => Math.max(0, this.now() - startedAt);
    const failOpen = (fallbackReason: string): PolishRunOutput => {
      const latencyMs = elapsedMs();
      this.lastLatencyMs = latencyMs;
      this.lastFallbackReason = fallbackReason;
      return {
        text: input.text,
        changed: false,
        fallback: true,
        fallbackReason,
        latencyMs,
        engine,
      };
    };

    if (input.text.trim().length === 0) {
      return {
        text: input.text,
        changed: false,
        fallback: false,
        latencyMs: elapsedMs(),
        engine,
      };
    }

    const messages = buildPolishMessages({
      rawDraft: input.text,
      profile,
      customInstructions: preferences.customInstructions,
      vocabulary: preferences.vocabulary,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, preferences.timeoutMs);

    let rawOutput: string;
    try {
      rawOutput = await runOpenAiCompatiblePolish({
        config: preferences.openaiCompatible,
        messages,
        signal: controller.signal,
        fetchFn: this.fetchFn,
        env: this.env,
      });
    } catch (error) {
      return failOpen(classifyFailureReason(error, controller.signal));
    } finally {
      clearTimeout(timer);
    }

    const polishedText = rawOutput.trim();
    if (polishedText.length === 0) {
      return failOpen("empty_output");
    }

    if (isSuspiciousExpansion(input.text, polishedText, profile)) {
      return failOpen("suspicious_expansion");
    }

    const latencyMs = elapsedMs();
    this.lastLatencyMs = latencyMs;
    this.lastFallbackReason = null;

    return {
      text: polishedText,
      changed: polishedText !== input.text,
      fallback: false,
      latencyMs,
      engine,
    };
  }
}
