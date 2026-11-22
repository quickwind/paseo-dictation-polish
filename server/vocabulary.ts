export interface VocabularyCorrection {
  readonly misheard: string;
  readonly canonical: string;
}

export interface ParsedVocabulary {
  readonly corrections: readonly VocabularyCorrection[];
  readonly terms: readonly string[];
}

const ARROW_PATTERN = /^(.*?)(?:->|→|=>)(.*)$/;

/**
 * Parses newline-delimited host-wide Vocabulary text into deduplicated
 * mishearing corrections and preferred canonical terms.
 */
export function parseVocabulary(raw?: string): ParsedVocabulary {
  if (!raw) {
    return { corrections: [], terms: [] };
  }

  const corrections: VocabularyCorrection[] = [];
  const terms: string[] = [];
  const seenCorrections = new Set<string>();
  const seenTerms = new Set<string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const arrowMatch = ARROW_PATTERN.exec(line);
    if (arrowMatch) {
      const misheard = arrowMatch[1].trim();
      const canonical = arrowMatch[2].trim();
      if (!misheard || !canonical) {
        continue;
      }

      const key = `${misheard}\0${canonical}`;
      if (!seenCorrections.has(key)) {
        seenCorrections.add(key);
        corrections.push({ misheard, canonical });
      }
      continue;
    }

    if (!seenTerms.has(line)) {
      seenTerms.add(line);
      terms.push(line);
    }
  }

  return { corrections, terms };
}

/**
 * Formats parsed Vocabulary entries into a prompt section, or null when empty.
 */
export function formatVocabularySection(parsed: ParsedVocabulary): string | null {
  if (parsed.corrections.length === 0 && parsed.terms.length === 0) {
    return null;
  }

  const lines: string[] = ["Vocabulary (preferred spellings and corrections):"];

  if (parsed.corrections.length > 0) {
    lines.push("Mishearing corrections (replace left with right):");
    for (const entry of parsed.corrections) {
      lines.push(`- ${entry.misheard} -> ${entry.canonical}`);
    }
  }

  if (parsed.terms.length > 0) {
    lines.push("Preferred canonical spellings:");
    for (const term of parsed.terms) {
      lines.push(`- ${term}`);
    }
  }

  return lines.join("\n");
}
