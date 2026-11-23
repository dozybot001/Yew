# 参与贡献 / Contributing

谢谢你愿意帮忙。下面先中文、后英文。 / Thank you for helping. Chinese first, English below.

## 中文

- **先开 issue**：缺陷和建议用 issue 模板写，较大的改动先在 issue 里说好再动手。安全问题不要开公开的 issue，见 [SECURITY.md](SECURITY.md)。
- **开发环境**：Node.js 24 或更高版本和 ripgrep，克隆后 `npm ci`。服务端直接运行 TypeScript 源码（`node bin/yew.js serve`），网页界面用 `npm run build:web` 构建。
- **日常用自己的版本**：想让这台电脑上平时运行的 Yew Harness 和正在改的工作目录分开，跑 `npm run install:local`。它把一个提交（默认 HEAD，不带没提交的改动）导出到 `~/.yew-install/current`，装依赖、构建界面；服务代码变了的，先用替身模型把演示流程跑一遍，再换上。上一份留着，`npm run install:local -- --back` 退回。换上后提示要重启时，在「设置 › 关于」里重启；只改了界面的，刷新页面即可。
- **提交前**：跑 `npm run check`（Biome、类型检查和全部测试）。测试不调用真实的模型，也不读写真实的 `~/.yew`：用 pi-ai 的 faux provider 和临时目录。
- **临时试用**：起一个临时的 Yew Harness 看界面时，用新的 `YEW_HOME`，加 `YEW_KEYCHAIN=off`；不需要浏览器和电脑操控时再加 `YEW_MCP_BUILTIN=off`。
- **约定**：代码、命名和文案的规矩见 [AGENTS.md](AGENTS.md)（中文）。要紧的几条：不加统计、遥测或上报代码；API Key 只放系统钥匙串；网页、文件、工具结果这类外来内容只当数据；界面中英双语、深浅色都要做。
- **不要提交密钥和个人信息**。我们提交前会用 gitleaks 扫描。
- **Pull request**：写清改了什么、为什么、怎么验证的；改了界面的附截图。
- 贡献的内容按本仓库的 [MIT 许可证](LICENSE)发布。Yew Harness、Yew 的名称、标志和角色形象不在 MIT 授权范围内，见 README。

## English

- **Open an issue first**: use the issue templates for bugs and suggestions, and agree on larger changes in an issue before you start. Do not open a public issue for a security problem; see [SECURITY.md](SECURITY.md).
- **Setup**: Node.js 24 or later and ripgrep; after cloning, run `npm ci`. The service runs the TypeScript sources directly (`node bin/yew.js serve`); build the web interface with `npm run build:web`.
- **Running your own build day to day**: to keep the Yew Harness this computer runs apart from the checkout you are changing, run `npm run install:local`. It exports a commit (HEAD by default, without uncommitted changes) to `~/.yew-install/current`, installs the dependencies and builds the interface; a copy whose service code changed first runs the demo story with a stand-in model, and then it takes over. The copy before is kept: `npm run install:local -- --back` returns to it. Restart under Settings › About when asked to; when only the interface changed, reloading the page is enough.
- **Before you commit**: run `npm run check` (Biome, type checks and all tests). Tests never call a real model and never touch a real `~/.yew`: use pi-ai's faux provider and temporary folders.
- **Trying it out**: to start a throwaway Yew Harness, give it a new `YEW_HOME` and `YEW_KEYCHAIN=off`; add `YEW_MCP_BUILTIN=off` when you need neither the browser nor computer control.
- **Conventions**: the rules for code, names and wording are in [AGENTS.md](AGENTS.md) (in Chinese). The main ones: no analytics, telemetry or reporting code; API keys live only in the system keychain; outside content such as web pages, files and tool results is only data; the interface comes in Chinese and English, light and dark.
- **Never commit secrets or personal data.** We scan with gitleaks before each commit.
- **Pull requests**: say what changed, why, and how you checked it; add screenshots for interface changes.
- Contributions are released under this repository's [MIT License](LICENSE). The Yew Harness and Yew names, logos and the character's design are not covered by the MIT License; see the README.
