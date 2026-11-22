---
status: accepted
---

# Use manual Composer Polish action in v1 instead of STT proxy or insert heuristics

Paseo 0.17's plugin SDK provides `addComposerItem` and `useComposer()` for reading and replacing composer text, but does not expose dictation lifecycle events or a server-side `dictation.transcribe.after` hook (tracked in upstream Discussion #10523). In v1, we trigger polishing exclusively through a manual `Polish` button in the Composer toolbar (plus Command Center actions) and keep the server-side formatting engine decoupled so it can later attach directly to an upstream dictation hook.

## Considered Options

- **Local OpenAI-compatible STT proxy**: Can intercept direct-send (`autoSend: true`) dictation before submission, but cannot reuse Paseo's bundled local Sherpa-ONNX (`sense-voice-int8`) without shipping native binaries, and Paseo's `DictationStreamManager` splits audio into 15-second segments that would be formatted independently.
- **Client-side insert heuristic (`useComposer()`)**: Watches `composer.prompt` for sudden text jumps, but cannot reliably distinguish dictation confirmation (`✓`) from clipboard pastes (`⌘V`) without risking corruption of pasted code or logs.

## Consequences

- Users keep Paseo's built-in local STT (`sense-voice-int8`) with zero audio config changes and zero 15-second segmentation artifacts.
- v1 polishing applies to edit-before-send workflows (clicking `✓` after dictation, or any typed draft); direct-send dictation (`⌘D` / `Enter` / send arrow) will be supported once upstream adds a dictation post-transcription hook.
