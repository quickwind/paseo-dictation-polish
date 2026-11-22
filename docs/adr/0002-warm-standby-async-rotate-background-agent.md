---
status: accepted
---

# Use warm-standby with async rotate-and-kill for Background Agent polishing

When the Polish Engine runs on a Paseo `background: true` agent, creating an agent on demand adds 1.5–3s of subprocess cold-start latency per request, while reusing one session indefinitely accumulates context and risks cross-utterance bleed. We keep a single pre-warmed background agent ready for immediate use, return the polished result first, and then asynchronously warm a fresh replacement and kill the previous instance (default `rotateAfterUses = 1`).

## Considered Options

- **Send `/clear` after each turn**: `/clear` is a provider-specific slash command (supported by Claude Code, not uniformly across Codex, OpenCode, or ACP providers); sending it to an unsupported provider would execute it as a literal user prompt.
- **Create-and-kill per request**: Guarantees isolation but pays full subprocess startup latency on every button click.

## Consequences

- Only one active background agent exists at steady state (and zero when the user switches to the direct OpenAI-compatible API engine).
- Works uniformly across all Paseo providers without provider-specific reset logic.
