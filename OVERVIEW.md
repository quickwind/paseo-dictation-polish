Dictation Polish cleans up spoken dictation and rough prompt drafts inside the Paseo composer before you send them to an agent.

## How it works

After dictating or typing a Raw Draft in edit-before-send mode, click **Polish** in the composer action bar. The plugin sends the Raw Draft to your configured Polish Engine, replaces the composer text in place with the Polished Text, and switches the button to **Undo polish** so you can restore the exact Raw Draft with one click.

You can also revert from the Command Center using **Revert last polish** while the polished text is still unchanged, or open plugin settings with **Dictation Polish Settings**. If you edit the composer while a polish request is running or after polishing finishes, your edits take precedence and the plugin will not overwrite them. On any timeout, network failure, or empty output, the plugin fails open and keeps the Raw Draft untouched.

Two Polish Engine modes are supported on the Paseo host:

- **Background Agent**: Keeps a single warm-standby Paseo background agent ready in a strict tool-free configuration (`claude` only, with `plan` mode, empty `mcpServers`, `allowedTools: []`, `disallowedTools`, and `--tools ""`) and rotates it asynchronously after the configured number of uses. Providers that cannot enforce a tool-free configuration are disabled for Background Agent polishing.
- **OpenAI-Compatible API**: Sends a direct text-only `/chat/completions` request with `temperature: 0` to an OpenAI-compatible endpoint, without spawning a Paseo agent session.

## Setup

Requires Paseo `>=0.17.0`.

Open **Settings > Plugins > Dictation Polish** on your Paseo host and choose one Polish Engine:

- **Background Agent**: Available when `claude` is configured on the Paseo host. Select an optional model override, thinking effort (default `low`), and rotation threshold (default `1` use). Use **Warm Now** to pre-start the standby agent before your first polish.
- **OpenAI-Compatible API**: Pick a preset (`OpenCode Go`, `OpenAI`, `Groq`, `Ollama (Local)`, or `Custom`) to pre-fill the Base URL, model, and API key environment variable name. For example, `OpenCode Go` defaults to `https://opencode.ai/zen/go/v1`, model `deepseek-v4.1-flash`, and `OPENCODE_API_KEY` on the Paseo daemon host. For keyless local endpoints such as Ollama, leave the environment variable name blank. API keys are read strictly from the daemon environment and are never stored in plugin settings or returned to connected clients.

Use the **Inline Test Playground** at the bottom of the settings screen to test your configuration and measure round-trip latency before using it in a workspace.

## Capabilities, data handling, and limits

### Polish Profiles and formatting options

- **Polish Profile**:
  - `clean`: Removes verbal fillers, stutters, and mid-sentence self-corrections, fixes punctuation, and wraps code identifiers, file paths, and CLI commands in backticks while keeping the original language and intent.
  - `structured`: Applies `clean` rules and organizes multi-point spoken instructions into concise Markdown bullet lists or numbered steps.
  - `translate-en`: Applies `clean` rules and translates Chinese or mixed Chinese/English Raw Drafts into concise English prompts while keeping technical identifiers intact.
- **Custom Instructions**: Optional formatting preferences appended to the Polish Profile prompt.
- **Vocabulary**: Host-wide list of preferred spellings and mishearing corrections, one entry per line (`misheard -> canonical` or `canonical`), injected into the polishing instructions.
- **Timeout (ms)**: Maximum wait between `1000` and `30000` ms (default `8000`) before falling back to the Raw Draft.

### Data sent and stored

- Only the current composer Raw Draft (or playground sample text), along with your selected Polish Profile, Custom Instructions, and Vocabulary, is sent to the Polish Engine you configure.
- Settings are stored in host-scoped plugin preferences on the Paseo daemon. API keys are never stored in plugin settings JSON; the daemon resolves Bearer tokens strictly from the configured host environment variable.
- Undo snapshots are kept only in client memory for the current session and cleared when the draft changes.

### Known limits

- Works only through the manual **Polish** action in edit-before-send mode.
- Does not intercept direct-send dictation or modify Paseo Voice Mode, as Paseo does not currently expose a dictation post-processing hook.
