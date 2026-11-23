听写润色（Dictation Polish）可在你将语音听写或口语化的 Raw Draft 发送给 Agent 之前，直接在 Paseo 输入框中完成清理与格式化润色。

## 工作原理

在编辑后发送（edit-before-send）模式下完成听写或输入 Raw Draft 后，点击输入框操作栏中的 **润色**（**Polish**）按钮。插件会将当前 Raw Draft 发送至你配置的 Polish Engine，原地替换为 Polished Text，并将按钮切换为 **撤销润色**（**Undo polish**），方便一键恢复为精确的原版 Raw Draft。

当润色结果尚未被继续编辑时，你也可以通过 Command Center 的 **撤销上次润色** 恢复原文，或通过 **听写润色设置** 打开插件配置页。如果在润色请求进行中或润色完成后手动修改了输入框内容，插件会保留你的编辑而不会覆盖。遇到超时、网络错误或空输出时，插件遵循 fail-open 策略，原样保留 Raw Draft。

插件在 Paseo 主机端提供两种纯文本 Polish Engine：

- **后台 Agent（Background Agent）**：在后台预热并维持最多一个严格禁用工具（tool-free）的待命 Paseo Agent（仅限 `claude`，强制启用 `plan` 模式、空 `mcpServers`、`allowedTools: []`、`disallowedTools` 与 `--tools ""`），并在返回 Polished Text 后按配置次数异步轮换以保持上下文干净。无法在启动层强制禁用内置工具的其他 Provider 已禁用此模式。
- **OpenAI 兼容接口（OpenAI-Compatible API）**：以 `temperature: 0` 直接调用纯文本 `/chat/completions` 接口，无需创建 Paseo Agent 会话。

## 配置说明

需要 Paseo `>=0.17.0`。

在 Paseo 主机上打开 **设置 > 插件 > 听写润色**，选择一种 Polish Engine：

- **后台 Agent**：当 Paseo 主机已配置可用的 `claude` Provider 时可用。可设置可选模型覆盖、思考强度（默认 `low`）以及轮换阈值（默认 `1` 次），也可点击 **立即预热** 提前启动待命 Agent。
- **OpenAI 兼容接口**：选择接口预设（`OpenCode Go`、`OpenAI`、`Groq`、`Ollama（本地）` 或 `自定义`）以自动填充 Base URL、模型和 API Key 环境变量名。例如 `OpenCode Go` 默认使用 `https://opencode.ai/zen/go/v1`、模型 `deepseek-v4.1-flash` 与守护进程宿主机环境变量 `OPENCODE_API_KEY`。对于 Ollama 等无需鉴权的本地接口，可将环境变量名留空。API Key 仅由守护进程从宿主机环境变量读取，绝不保存在插件配置中，也不会回传给任何已连接的客户端。

可使用设置页底部的 **内联测试区**（Inline Test Playground）验证配置并查看实际往返耗时（ms）。

## 功能、数据流向与已知限制

### Polish Profile 与配置项

- **Polish Profile（润色风格）**：
  - `clean`：去除口癖、重复与句中自我纠正，补充标点并将代码标识符、文件路径和 CLI 命令包裹在反引号中，同时保持原语言与原意。
  - `structured`：在 `clean` 规则基础上，将多点口述指令整理为清晰的 Markdown 列表或编号步骤。
  - `translate-en`：在 `clean` 规则基础上，将中文或中英混杂的 Raw Draft 润色并翻译为简洁的英文开发提示词，保留技术标识符不变。
- **自定义指令**：附加在 Polish Profile 提示词之后的可选格式化偏好。
- **词表（Vocabulary）**：主机级全局配置，每行一条标准拼写或听写纠错规则（`错词 -> 标准词` 或 `标准词`），会注入润色提示词中。
- **超时时间（ms）**：允许范围为 `1000` 至 `30000` ms（默认 `8000`），超时后自动回退保留 Raw Draft。

### 数据发送与存储说明

- 只有当前输入框中的 Raw Draft（或测试区文本）以及你设置的 Polish Profile、自定义指令和 Vocabulary 会被发送到你所配置的 Polish Engine。
- 插件配置保存在 Paseo 守护进程的主机级插件配置中；API Key 仅通过守护进程环境变量读取，绝不存储在插件配置 JSON 中。
- 撤销快照仅保存在当前客户端内存中，输入框内容变化后即自动失效并清除。

### 已知限制

- 仅支持在编辑后发送模式下通过 **润色** 按钮手动触发。
- 暂不拦截直发模式（direct-send）听写，也不修改 Paseo Voice Mode，因为上游 Paseo 尚未提供听写后处理 hook。
