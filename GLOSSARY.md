# Paseo Dictation Polish

Domain language for polishing spoken dictation and rough prompt drafts inside Paseo before sending them to an agent.

## Language

**Polish Engine**:
The server-side text-only inference backend that transforms a Raw Draft into Polished Text via an OpenAI-compatible chat endpoint.
_Avoid_: Formatter, LLM backend, rewriter

**Polish Profile**:
A named formatting rule preset (`clean`, `structured`, or `translate-en`) that controls how a Raw Draft is reshaped without altering its intent.
_Avoid_: Style, mode, template

**Raw Draft**:
The unpolished input text taken from the composer before polishing, whether produced by dictation or rough typing.
_Avoid_: Transcript, source text, prompt

**Polished Text**:
The cleaned, formatted output returned by the Polish Engine to replace the Raw Draft in the composer.
_Avoid_: Result, completion, response

**Vocabulary**:
A host-wide list of preferred spellings and mishearing corrections (`misheard -> canonical` or `canonical`) injected into polishing instructions.
_Avoid_: Glossary, dictionary, term list
