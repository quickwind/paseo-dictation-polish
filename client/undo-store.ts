export interface PolishUndoEntry {
  readonly rawDraft: string;
  readonly polishedText: string;
}

const undoBySlot = new Map<symbol, PolishUndoEntry>();
const undoByComposer = new WeakMap<object, PolishUndoEntry>();
let latestUndoEntry: PolishUndoEntry | undefined;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeUndoStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function canUndoPolish(
  currentPrompt: string,
  entry: PolishUndoEntry | undefined,
): entry is PolishUndoEntry {
  return entry !== undefined && currentPrompt === entry.polishedText;
}

/**
 * Decides whether a stored undo entry should be cleared for a given composer prompt.
 *
 * Right after `composer.setPrompt(polishedText)` runs, React can re-render from
 * the undo store update before the host `useComposer()` snapshot reflects the new
 * prompt. Keep the entry alive during that intermediate render while the prompt
 * still equals `rawDraft` and `polishedText` has not been observed yet.
 */
export function shouldClearUndoEntry(params: {
  readonly currentPrompt: string;
  readonly entry: PolishUndoEntry | undefined;
  readonly hasObservedPolished: boolean;
}): boolean {
  const { currentPrompt, entry, hasObservedPolished } = params;
  if (entry === undefined) {
    return false;
  }
  if (currentPrompt === entry.polishedText) {
    return false;
  }
  if (!hasObservedPolished && currentPrompt === entry.rawDraft) {
    return false;
  }
  return true;
}

export function getUndoEntry(
  composer: object,
  slotId?: symbol,
  currentPrompt?: string,
): PolishUndoEntry | undefined {
  if (slotId !== undefined) {
    const bySlot = undoBySlot.get(slotId);
    if (bySlot !== undefined) {
      return bySlot;
    }
  }
  const byComposer = undoByComposer.get(composer);
  if (byComposer !== undefined) {
    return byComposer;
  }
  // Cross-surface sync: when another control (Composer Pill vs toolbar Action)
  // polished this same composer, share the active undo entry if prompts match.
  if (
    currentPrompt !== undefined &&
    latestUndoEntry !== undefined &&
    currentPrompt === latestUndoEntry.polishedText
  ) {
    return latestUndoEntry;
  }
  return undefined;
}

export function getLatestUndoEntry(): PolishUndoEntry | undefined {
  return latestUndoEntry;
}

export function setUndoEntry(
  composer: object,
  entry: PolishUndoEntry,
  slotId?: symbol,
): void {
  if (slotId !== undefined) {
    undoBySlot.set(slotId, entry);
  }
  undoByComposer.set(composer, entry);
  latestUndoEntry = entry;
  emitChange();
}

export function clearUndoEntry(composer: object, slotId?: symbol): void {
  let changed = false;
  let removed: PolishUndoEntry | undefined;

  if (slotId !== undefined && undoBySlot.has(slotId)) {
    removed = undoBySlot.get(slotId);
    undoBySlot.delete(slotId);
    changed = true;
  }

  if (undoByComposer.has(composer)) {
    removed = removed ?? undoByComposer.get(composer);
    undoByComposer.delete(composer);
    changed = true;
  }

  // If this clear targeted the currently active shared entry (e.g. undone from
  // the other surface), clear any slot pointing to the same entry as well.
  const targetEntry = removed ?? latestUndoEntry;
  if (targetEntry !== undefined) {
    for (const [key, val] of undoBySlot.entries()) {
      if (val === targetEntry) {
        undoBySlot.delete(key);
        changed = true;
      }
    }
    if (latestUndoEntry === targetEntry) {
      latestUndoEntry = undefined;
      changed = true;
    }
  }

  if (changed) {
    emitChange();
  }
}
