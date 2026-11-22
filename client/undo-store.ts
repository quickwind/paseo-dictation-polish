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

export function getUndoEntry(
  composer: object,
  slotId?: symbol,
): PolishUndoEntry | undefined {
  if (slotId !== undefined) {
    const bySlot = undoBySlot.get(slotId);
    if (bySlot !== undefined) {
      return bySlot;
    }
  }
  return undoByComposer.get(composer);
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
  let existing: PolishUndoEntry | undefined;
  if (slotId !== undefined) {
    existing = undoBySlot.get(slotId);
    undoBySlot.delete(slotId);
  }
  const byComposer = undoByComposer.get(composer);
  undoByComposer.delete(composer);
  const removed = existing ?? byComposer;
  if (removed !== undefined && latestUndoEntry === removed) {
    latestUndoEntry = undefined;
  }
  emitChange();
}
