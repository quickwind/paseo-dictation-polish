import { describe, expect, it, vi } from "vitest";
import {
  runComposerPolish,
  runComposerUndo,
  type ComposerHandle,
  type PolishNotifier,
} from "../client/polish-controller";
import {
  canUndoPolish,
  clearUndoEntry,
  getLatestUndoEntry,
  getUndoEntry,
  shouldClearUndoEntry,
} from "../client/undo-store";
import type { PolishRunOutput } from "../shared/rpc";

function createMockComposer(initialPrompt: string) {
  let prompt = initialPrompt;
  const setPrompt = vi.fn((next: string) => {
    prompt = next;
  });
  const focus = vi.fn(async () => undefined);

  const composer: ComposerHandle = {
    get prompt() {
      return prompt;
    },
    setPrompt,
    focus,
  };

  return {
    composer,
    setPrompt,
    focus,
    simulateUserEdit(next: string) {
      prompt = next;
    },
  };
}

function createMockNotifier(): PolishNotifier & {
  show: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    show: vi.fn(),
    error: vi.fn(),
  };
}

describe("runComposerPolish", () => {
  it("replaces Raw Draft with Polished Text and focuses composer on success", async () => {
    const { composer, setPrompt, focus } = createMockComposer("um fix the bug please");
    const notify = createMockNotifier();
    const runPolish = vi.fn(
      async (): Promise<PolishRunOutput> => ({
        text: "Fix the bug, please.",
        changed: true,
        fallback: false,
        latencyMs: 42,
        engine: "openai-compatible",
      }),
    );

    const outcome = await runComposerPolish({ composer, runPolish, notify });

    expect(outcome).toEqual({ status: "applied", changed: true });
    expect(runPolish).toHaveBeenCalledWith({ text: "um fix the bug please" });
    expect(setPrompt).toHaveBeenCalledWith("Fix the bug, please.");
    expect(composer.prompt).toBe("Fix the bug, please.");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(notify.show).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("short-circuits on empty or whitespace-only input", async () => {
    const { composer, setPrompt, focus } = createMockComposer("   \n ");
    const notify = createMockNotifier();
    const runPolish = vi.fn();

    const outcome = await runComposerPolish({ composer, runPolish, notify });

    expect(outcome).toEqual({ status: "noop" });
    expect(runPolish).not.toHaveBeenCalled();
    expect(setPrompt).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(notify.show).not.toHaveBeenCalled();
  });

  it("aborts overwrite and notifies when user edits draft during flight", async () => {
    const { composer, setPrompt, focus, simulateUserEdit } = createMockComposer("initial draft");
    const notify = createMockNotifier();

    let resolveFlight!: (value: PolishRunOutput) => void;
    const runPolish = vi.fn(
      () =>
        new Promise<PolishRunOutput>((resolve) => {
          resolveFlight = resolve;
        }),
    );

    const pending = runComposerPolish({ composer, runPolish, notify });
    simulateUserEdit("initial draft with extra edits");
    resolveFlight({
      text: "Initial draft.",
      changed: true,
      fallback: false,
      latencyMs: 100,
      engine: "openai-compatible",
    });

    const outcome = await pending;

    expect(outcome).toEqual({ status: "aborted_stale" });
    expect(setPrompt).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(composer.prompt).toBe("initial draft with extra edits");
    expect(notify.show).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: "info" }),
    );
  });

  it("preserves original draft and warns when server returns fallback", async () => {
    const { composer, setPrompt, focus } = createMockComposer("keep me intact");
    const notify = createMockNotifier();
    const runPolish = vi.fn(
      async (): Promise<PolishRunOutput> => ({
        text: "keep me intact",
        changed: false,
        fallback: true,
        fallbackReason: "timeout",
        latencyMs: 8000,
        engine: "openai-compatible",
      }),
    );

    const outcome = await runComposerPolish({ composer, runPolish, notify });

    expect(outcome).toEqual({ status: "fallback", fallbackReason: "timeout" });
    expect(setPrompt).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(composer.prompt).toBe("keep me intact");
    expect(notify.show).toHaveBeenCalledWith(
      expect.stringContaining("timeout"),
      expect.objectContaining({ variant: "warning" }),
    );
  });

  it("preserves original draft and reports error when RPC rejects", async () => {
    const { composer, setPrompt, focus } = createMockComposer("keep me on error");
    const notify = createMockNotifier();
    const runPolish = vi.fn(async () => {
      throw new Error("network down");
    });

    const outcome = await runComposerPolish({ composer, runPolish, notify });

    expect(outcome).toEqual({ status: "error" });
    expect(setPrompt).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(composer.prompt).toBe("keep me on error");
    expect(notify.error).toHaveBeenCalledTimes(1);
  });
});

describe("undo store and runComposerUndo", () => {
  it("stores undo state on successful polish and flips canUndoPolish to true", async () => {
    const { composer } = createMockComposer("um fix the bug please");
    const notify = createMockNotifier();
    const runPolish = vi.fn(
      async (): Promise<PolishRunOutput> => ({
        text: "Fix the bug, please.",
        changed: true,
        fallback: false,
        latencyMs: 25,
        engine: "openai-compatible",
      }),
    );

    await runComposerPolish({ composer, runPolish, notify });

    const entry = getUndoEntry(composer);
    expect(entry).toEqual({
      rawDraft: "um fix the bug please",
      polishedText: "Fix the bug, please.",
    });
    expect(canUndoPolish(composer.prompt, entry)).toBe(true);

    clearUndoEntry(composer);
  });

  it("restores exact Raw Draft, focuses composer, and clears undo state on runComposerUndo", async () => {
    const { composer, setPrompt, focus } = createMockComposer("um fix the bug please");
    const notify = createMockNotifier();
    const runPolish = vi.fn(
      async (): Promise<PolishRunOutput> => ({
        text: "Fix the bug, please.",
        changed: true,
        fallback: false,
        latencyMs: 25,
        engine: "openai-compatible",
      }),
    );

    await runComposerPolish({ composer, runPolish, notify });
    focus.mockClear();
    setPrompt.mockClear();

    const entry = getUndoEntry(composer);
    const result = await runComposerUndo({ composer, entry });

    expect(result).toEqual({ reverted: true });
    expect(setPrompt).toHaveBeenCalledWith("um fix the bug please");
    expect(composer.prompt).toBe("um fix the bug please");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(getUndoEntry(composer)).toBeUndefined();
    expect(canUndoPolish(composer.prompt, getUndoEntry(composer))).toBe(false);
  });

  it("invalidates undo state when user edits or clears composer.prompt", async () => {
    const { composer, simulateUserEdit } = createMockComposer("um fix the bug please");
    const notify = createMockNotifier();
    const runPolish = vi.fn(
      async (): Promise<PolishRunOutput> => ({
        text: "Fix the bug, please.",
        changed: true,
        fallback: false,
        latencyMs: 25,
        engine: "openai-compatible",
      }),
    );

    await runComposerPolish({ composer, runPolish, notify });
    const entry = getUndoEntry(composer);
    expect(canUndoPolish(composer.prompt, entry)).toBe(true);

    simulateUserEdit("Fix the bug, please! Extra text");
    expect(canUndoPolish(composer.prompt, entry)).toBe(false);

    simulateUserEdit("");
    expect(canUndoPolish(composer.prompt, entry)).toBe(false);

    const undoResult = await runComposerUndo({ composer, entry });
    expect(undoResult).toEqual({ reverted: false });

    clearUndoEntry(composer);
  });

  it("supports Command Center revert-last-polish when focused composer matches latest undo entry and no-ops otherwise", async () => {
    const { composer, setPrompt, focus, simulateUserEdit } = createMockComposer("raw dictation");
    const notify = createMockNotifier();
    const runPolish = vi.fn(
      async (): Promise<PolishRunOutput> => ({
        text: "Polished dictation.",
        changed: true,
        fallback: false,
        latencyMs: 15,
        engine: "openai-compatible",
      }),
    );

    await runComposerPolish({ composer, runPolish, notify });
    focus.mockClear();
    setPrompt.mockClear();

    // Simulate Command Center lookup via getLatestUndoEntry
    const latest = getLatestUndoEntry();
    expect(canUndoPolish(composer.prompt, latest)).toBe(true);
    const reverted = await runComposerUndo({ composer, entry: latest });
    expect(reverted).toEqual({ reverted: true });
    expect(composer.prompt).toBe("raw dictation");

    // Subsequent revert with no undo entry safely no-ops
    const noOp = await runComposerUndo({ composer, entry: getLatestUndoEntry() });
    expect(noOp).toEqual({ reverted: false });

    // Edit after polish also no-ops
    await runComposerPolish({ composer, runPolish, notify });
    simulateUserEdit("something else");
    const editedNoOp = await runComposerUndo({ composer, entry: getLatestUndoEntry() });
    expect(editedNoOp).toEqual({ reverted: false });

    clearUndoEntry(composer);
  });

  it("keeps undo entry alive before asynchronous composer.prompt update flushes, then clears after user edit", () => {
    const entry = {
      rawDraft: "um raw draft",
      polishedText: "Polished draft.",
    };

    // Before host useComposer() re-renders with polishedText, currentPrompt may still equal rawDraft
    expect(
      shouldClearUndoEntry({
        currentPrompt: "um raw draft",
        entry,
        hasObservedPolished: false,
      }),
    ).toBe(false);

    // Once polishedText is rendered, undo remains active
    expect(
      shouldClearUndoEntry({
        currentPrompt: "Polished draft.",
        entry,
        hasObservedPolished: true,
      }),
    ).toBe(false);

    // After polishedText was observed, any user edit invalidates the undo entry
    expect(
      shouldClearUndoEntry({
        currentPrompt: "Polished draft. Extra",
        entry,
        hasObservedPolished: true,
      }),
    ).toBe(true);

    // Even if polishedText was not yet observed, diverging away from rawDraft clears it
    expect(
      shouldClearUndoEntry({
        currentPrompt: "completely different text",
        entry,
        hasObservedPolished: false,
      }),
    ).toBe(true);
  });

  it("aborts overwrite when useComposer returns immutable snapshots and user types during flight", async () => {
    let livePrompt = "raw dictation";
    const setPrompt = vi.fn((next: string) => {
      livePrompt = next;
    });
    const focus = vi.fn(async () => {});
    const makeSnapshot = () =>
      Object.freeze({
        prompt: livePrompt,
        setPrompt,
        focus,
      });

    let currentSnapshot = makeSnapshot();
    const clickTimeSnapshot = currentSnapshot;
    const notify = createMockNotifier();

    const runPolish = vi.fn(async () => {
      // Simulate host producing a brand-new immutable snapshot when user types mid-flight
      livePrompt = "raw dictation + extra typing";
      currentSnapshot = makeSnapshot();
      return {
        text: "Polished dictation.",
        changed: true,
        fallback: false,
        latencyMs: 50,
        engine: "openai-compatible" as const,
      };
    });

    const outcome = await runComposerPolish({
      composer: clickTimeSnapshot,
      getLatestComposer: () => currentSnapshot,
      runPolish,
      notify,
    });

    expect(outcome).toEqual({ status: "aborted_stale" });
    expect(setPrompt).not.toHaveBeenCalled();
    expect(livePrompt).toBe("raw dictation + extra typing");
    expect(notify.show).toHaveBeenCalledWith(expect.any(String), { variant: "info" });
  });
});
