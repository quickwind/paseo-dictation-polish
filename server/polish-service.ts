import type { PolishProfile, Preferences } from "../shared/preferences";
import type {
  PolishRunInput,
  PolishRunOutput,
  PolishStatusOutput,
  PolishWarmOutput,
} from "../shared/rpc";
import type { WarmBackgroundAgentManager } from "./background-agent-engine";
import {
  OpenAiCompatibleEngineError,
  runOpenAiCompatiblePolish,
  type EnvLookup,
} from "./openai-compatible-engine";
import { buildPolishMessages, type PolishMessages } from "./prompts";

export type BackgroundAgentPolishEngine = (params: {
  readonly messages: PolishMessages;
  readonly preferences: Preferences;
  readonly signal: AbortSignal;
}) => Promise<string>;

export interface PolishServiceOptions {
  readonly getSettings: () => Promise<Preferences>;
  readonly fetchFn?: typeof fetch;
  readonly env?: EnvLookup;
  readonly now?: () => number;
  readonly backgroundAgentEngine?: BackgroundAgentPolishEngine;
  readonly backgroundAgentManager?: WarmBackgroundAgentManager;
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
 * Server-side Polish Engine orchestrator enforcing strict fail-open guarantees.
 */
export class PolishService {
  private readonly getSettings: () => Promise<Preferences>;
  private readonly fetchFn: typeof fetch;
  private readonly env: EnvLookup;
  private readonly now: () => number;
  private readonly backgroundAgentEngine?: BackgroundAgentPolishEngine;
  private readonly backgroundAgentManager?: WarmBackgroundAgentManager;
  private lastLatencyMs: number | null = null;
  private lastFallbackReason: string | null = null;

  constructor(options: PolishServiceOptions) {
    this.getSettings = options.getSettings;
    this.fetchFn = options.fetchFn ?? fetch;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
    this.backgroundAgentManager = options.backgroundAgentManager;
    this.backgroundAgentEngine =
      options.backgroundAgentEngine ??
      (options.backgroundAgentManager
        ? (params) => options.backgroundAgentManager!.polish(params)
        : undefined);
  }

  async getStatus(): Promise<PolishStatusOutput> {
    const preferences = await this.getSettings();
    const warmStatus = this.backgroundAgentManager
      ? this.backgroundAgentManager.getStatus()
      : {
          warmState:
            preferences.engine === "background-agent"
              ? ("idle" as const)
              : ("disabled" as const),
          lastError: null,
          usesOnCurrentAgent: 0,
        };

    return {
      engine: preferences.engine,
      warmState: preferences.engine === "background-agent" ? warmStatus.warmState : "disabled",
      lastLatencyMs: this.lastLatencyMs,
      lastFallbackReason: this.lastFallbackReason,
      lastError: warmStatus.lastError,
      usesOnCurrentAgent: warmStatus.usesOnCurrentAgent,
    };
  }

  async warm(): Promise<PolishWarmOutput> {
    const preferences = await this.getSettings();
    if (!this.backgroundAgentManager) {
      if (preferences.engine !== "background-agent") {
        return { warmState: "disabled", error: null };
      }
      return {
        warmState: "error",
        error: "Background agent manager is not configured.",
      };
    }

    return this.backgroundAgentManager.warm(preferences);
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

    if (engine === "background-agent" && !this.backgroundAgentEngine) {
      return failOpen("background_agent_not_configured");
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
      if (engine === "background-agent") {
        rawOutput = await this.backgroundAgentEngine!({
          messages,
          preferences,
          signal: controller.signal,
        });
      } else {
        rawOutput = await runOpenAiCompatiblePolish({
          config: preferences.openaiCompatible,
          messages,
          signal: controller.signal,
          fetchFn: this.fetchFn,
          env: this.env,
        });
      }
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
