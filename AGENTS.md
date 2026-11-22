# Agents

Navigation pointers for coding agents working in `paseo-dictation-polish`.

- **Domain vocabulary**: Read `GLOSSARY.md` before naming types, settings, RPCs, or UI strings (`Polish Engine`, `Polish Profile`, `Raw Draft`, `Polished Text`, `Vocabulary`).
- **Architectural decisions**: Read `docs/adr/` before changing entry points or Background Agent lifecycle (`0001` covers why v1 uses a manual Composer action without an STT proxy or insert heuristic; `0002` covers warm-standby + async rotate-and-kill).
- **Paseo Plugin SDK contracts**: Verify exact types directly in `node_modules/@getpaseo/plugin/dist/` (and `node_modules/@getpaseo/client/`). Do not rely on older local Paseo checkouts.
- **Runtime boundaries**: `shared/` is runtime-neutral (no Node or React), `client/` uses React Native primitives + `@getpaseo/plugin/client/ui` only (no DOM globals, HTML tags, `className`, or `onClick`), and `server/` has no React/client imports.
- **Verification**: Run `npm run check` (runs `typecheck`, `test`, runtime boundary audit, mobile compliance audit, and `OVERVIEW*.md` em-dash check).
- **Host snapshot semantics**: In Paseo, `useComposer()` returns a fresh immutable snapshot on every render. Keep client tests realistic by using immutable snapshot handles when testing async composer flows.
