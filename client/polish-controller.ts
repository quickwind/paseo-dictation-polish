import type { PluginComposer } from "@getpaseo/plugin/client";
import type { ToastOptions } from "@getpaseo/plugin/client/ui";
import type { PolishRunInput, PolishRunOutput } from "../shared/rpc";
import {
  canUndoPolish,
  clearUndoEntry,
  setUndoEntry,
  type PolishUndoEntry,
} from "./undo-store";

export type ComposerHandle = Pick<PluginComposer, "prompt" | "setPrompt" | "focus">;

export interface PolishNotifier {
  show(message: string, options?: ToastOptions): void;
  error(message: string): void;
}

export interface PolishFeedbackMessages {
  readonly raceAborted: string;
  readonly fallback: (reason: string) => string;
  readonly fallbackUnknown: string;
  readonly error: string;
}

export type ComposerPolishResult =
  | { readonly status: "noop" }
  | { readonly status: "aborted_stale" }
  | { readonly status: "fallback"; readonly fallbackReason?: string }
  | { readonly status: "error" }
  | { readonly status: "applied"; readonly changed: boolean };

export interface RunComposerPolishParams {
  readonly composer: ComposerHandle;
  readonly runPolish: (input: PolishRunInput) => Promise<PolishRunOutput>;
  readonly notify: PolishNotifier;
  readonly messages?: PolishFeedbackMessages;
  readonly slotId?: symbol;
}

const DEFAULT_MESSAGES: PolishFeedbackMessages = {
  raceAborted: "Draft changed while polishing; kept your edits.",
  fallback: (reason) => `Could not polish draft (${reason}); kept original text.`,
  fallbackUnknown: "unknown",
  error: "Failed to polish draft; kept original text.",
};

/**
 * Executes a single manual polish cycle against the active composer with
 * empty-input short-circuiting, race-condition protection, and fail-open handling.
 */
export async function runComposerPolish({
  composer,
  runPolish,
  notify,
  messages = DEFAULT_MESSAGES,
  slotId,
}: RunComposerPolishParams): Promise<ComposerPolishResult> {
  const rawDraft = composer.prompt;
  if (rawDraft.trim().length === 0) {
    return { status: "noop" };
  }

  let result: PolishRunOutput;
  try {
    result = await runPolish({ text: rawDraft });
  } catch {
    notify.error(messages.error);
    return { status: "error" };
  }

  if (composer.prompt !== rawDraft) {
    notify.show(messages.raceAborted, { variant: "info" });
    return { status: "aborted_stale" };
  }

  if (result.fallback) {
    const reason = result.fallbackReason ?? messages.fallbackUnknown;
    notify.show(messages.fallback(reason), { variant: "warning" });
    return { status: "fallback", fallbackReason: result.fallbackReason };
  }

  composer.setPrompt(result.text);
  await composer.focus();

  if (result.changed && result.text !== rawDraft) {
    setUndoEntry(composer, { rawDraft, polishedText: result.text }, slotId);
  } else {
    clearUndoEntry(composer, slotId);
  }

  return { status: "applied", changed: result.changed };
}

export interface RunComposerUndoParams {
  readonly composer: ComposerHandle;
  readonly entry: PolishUndoEntry | undefined;
  readonly slotId?: symbol;
}

/**
 * Reverts a composer back to its Raw Draft if the current prompt still matches
 * the stored Polished Text.
 */
export async function runComposerUndo({
  composer,
  entry,
  slotId,
}: RunComposerUndoParams): Promise<{ readonly reverted: boolean }> {
  if (!canUndoPolish(composer.prompt, entry)) {
    return { reverted: false };
  }

  composer.setPrompt(entry.rawDraft);
  await composer.focus();
  clearUndoEntry(composer, slotId);

  return { reverted: true };
}
