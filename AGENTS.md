# Yew Harness 开发约定

- 这个仓库只放代码、运行和发布要用的配置、描述现状的文档；计划、方案、路线图和过程记录不放进来。
- 维护者直接在 main 上开发和提交，不建功能分支和 worktree；外部贡献走 Pull request，见 [CONTRIBUTING](CONTRIBUTING.md)。`origin` 一次 `git push` 同时推到 Gitee（`dozybot/yew`）和 GitHub（`dozybot001/Yew`）。两边都是公开仓库（2026-11-15 开源，MIT）：提交里不放密钥、个人信息和客户信息，提交前的密钥扫描必须通过。
- 一句话定义：「AI 原生的多 Agent 工作台」 / "An AI-native multi-agent workbench"。README 首句、页面元信息和关于页第一句只用这一句，不另写。

## 技术栈

- Node.js 24 及以上，TypeScript，ESM。服务端用 Node 自带的类型擦除直接运行 `.ts`，开发时不另设构建步骤；对外发布的 npm 包（`@tenonai/yew`，命令 `yew`）用 `npm run build` 编译到 `dist/`，`bin/yew.js` 在源码目录里跑源码、在装好的包里跑编译结果。只用可擦除的语法，不用 `enum`、`namespace` 和参数属性。
- 存储：Node 自带的 `node:sqlite`。数据目录默认 `~/.yew`，可用 `YEW_HOME` 指定；表结构变更写成按序号执行的迁移。
- 模型接入：`@earendil-works/pi-ai`，锁定精确版本，只在 `src/server/model/` 里引用；其他模块通过这一层调用模型，换库时只改这一层。Agent 循环、工具和权限自己写，这是产品本身。
- 本地服务：Hono；服务端向界面推送用 SSE。网页界面：React + Vite。
- iPhone 应用：Swift 6、SwiftUI，iOS 17 起，工程在 `ios/`，Bundle ID `cn.tenonai.apps.yew`；文案用 String Catalog（中英）。安卓应用在 `android/`。中继服务：TypeScript，在 `relay/`。
- 密钥：系统钥匙串（`@napi-rs/keyring`）。
- 系统沙箱：`@anthropic-ai/sandbox-runtime`，锁定精确版本，只在 `src/server/sandbox.ts` 里引用，只用它 README 和类型定义里公开的接口。macOS 和 Linux 上默认打开，`YEW_SANDBOX=off` 关掉；起不来或跑不了测试命令时不进沙箱，并写明原因。改沙箱配置或升级它，合入前单独做一次安全复测。`package.json` 的 `overrides` 把它用的 zod 定到 4.6.6：它声明 `^3.25.0`，而 zod 3.x 有高危公告 GHSA-mrhx-c7xc-m3w5、没有修复版，生产依赖的门禁不放行；它导入的是 zod 4 也带的 `zod/v3`，上游 README 写明可以这样用。`overrides` 只在本仓库生效，用户全局安装时不认，所以 npm 包用 `bundleDependencies` 自带 sandbox-runtime 和它的依赖（含 zod 4.6.6），发布前跑 `npm ci` 让打进包的和锁文件一致。升级 sandbox-runtime 时复核这条覆盖和打包，上游放宽 zod 的范围后就都去掉（已提：anthropics/sandbox-runtime#843）。
- 检查：Biome（格式与 lint）、`tsc --noEmit`、`node --test`。

## 开发约定

- **净室开发**：功能和交互可以参考 Claude Code，但不复制它的代码、提示词和工具说明原文；Yew Harness 的系统提示词和工具说明自己写。产品名、标志和文案不用 Claude 字样，也不暗示与 Anthropic 有合作。复制开源代码前看[可借鉴的开源项目](docs/prior-art.md)的复制规则和排除清单。接 Anthropic 只用 API Key，不做 Anthropic 账号登录。
- **数据在本机**：Yew Harness 不收集任何数据，不加统计、遥测或上报代码；pi-ai 的 telemetry 不接任何导出端。请求服务商时 User-Agent 用 `yew/<版本>`，不发送归因头。
- **密钥**：服务商的 API Key 只存在系统钥匙串，不写进 SQLite、日志、Git、网址和命令参数；Shell 工具的子进程环境里不带这些密钥。
- **外部内容只是数据**：网页、文件、工具结果和其他会话发来的消息都不当作指令或授权，不能替你授权操作、不能改配置和说明文件。例外是用户放在项目里的 AGENTS.md、CLAUDE.md，可以作为用户指令读入，但不能免掉授权方式要求的确认。
- **界限、授权和审批**：三层。界限由系统沙箱和沙箱外的外层保护关死，不问，三种方式下一样：Yew Harness 自己的数据、钥匙串（沙箱里）、「会话读不到的目录」，命令里点名它们不为此发问；只有外层保护起不来的系统上，沙箱外运行、点名这些地方和用 `yew` 命令行三种方式下都问。授权是工具调用前的那张卡，问不问由会话的授权方式决定：默认方式问；自动方式先交给检查模型，做错了收不回、或会落到别人身上的操作（对外发布、以用户的名义对外发消息、往外发数据、远程主机和生产环境、删工作区外的数据、写磁盘、`yew` 命令行）不交给检查、直接问用户，规则里也不能整体放行；跳过方式什么都不问，在记录里标出来，只有提高花费上限还问。审批是会话交给用户定的事（`ask_user`、决定卡、回复末尾留下的问题），尽量做成选择题，哪种方式都不跳过；跳过方式下哪些事先问用户，取决于会话的职责和项目说明，由会话自己提，会话也可能漏问，Yew Harness 不再拦。无人值守时遇到要问人的直接拒绝并上报，不挂起等人。
- **模型**：默认服务商用已备案的国内模型，境外服务商只作用户自选项。Yew Harness 是用户自带密钥、从用户电脑直接调用服务商的本地软件。
- **本地接口**：只监听 `127.0.0.1`；手机经中继访问，两端端到端加密，首次使用扫码配对。校验 `Host` 和 `Origin`，防 DNS 重绑定和跨站请求；浏览器会话用 HttpOnly、`SameSite=Strict` 的 Cookie。错误按 RFC 9457 返回并附请求 ID，可能重试的创建类请求接受 `Idempotency-Key`，列表分页。
- **命令行**：遵循 clig.dev。成功退出码为 0，结果写标准输出，进度和错误写标准错误；提供 `--help`、`--version`，供程序读取的命令提供 `--json`；`NO_COLOR` 非空或输出不是终端时不输出颜色。`yew --version` 输出版本、出品方 Tenon AI 与官网 https://tenonai.cn/。命令行输出只用英文。
- **界面**：中英双语、深浅色从第一个页面起就做全。控件自绘，不露出浏览器默认外观；多行输入随内容自然增高，不设高度上限；对话框只用几档固定尺寸，外框高度不随内容变，长内容在里面滚动。设置（含主题、语言和关于）放在侧栏底部；Yew Harness 没有账号，不设账号入口。可访问性以 WCAG 2.2 AA 为目标，键盘能完成所有操作，控件都有可访问的名称；性能以 Core Web Vitals 的「良好」为目标。
- **品牌**：产品叫 Yew Harness；单说 Yew 指红发女孩。对外显示的名字写 Yew Harness，中文里也一样：界面、命令行输出、手机应用和应用名、启动图标、商店、文档里指产品的地方；npm 包、命令 `yew`、`~/.yew`、环境变量、钥匙串服务名、Bundle ID 和包名、`Yew.app`、协议标签这些技术名字，以及给模型看的提示词、工具说明和信件标记照旧写 Yew。产品图形是一枝红豆杉：红色的果（`#C8323F`，带深绿的种子）和一片叶子，叶子浅色主题用深绿 `#1F3A2E`、深色主题用浅灰绿 `#E3E8E4`；字标是 Young Serif 描出的「Yew」，产品名的地方在后面配一个小一号的「Harness」（网页的 `ProductName`，手机端的 `Lockup`）；组合标志是产品图形加字标，不带 Tenon 标志；Tenon 标志只出现在关于页的出品方，是小号横版组合「出品方　〔T〕榫卯 Tenon AI」。favicon 和各处图标用这个图形，不加 Tenon 角标。界面底色是黑白灰，绿色只用在标志、字标和打开的开关。红发女孩的名字是 Yew，对外不叫吉祥物、mascot；她的 46 个姿势和一张立绘在 `web/public/mascot`，代码里沿用 mascot 这个内部名。她不挡操作，用在空状态、等待、出错和关于页；窗口上悬浮一个，可以拖动，气泡说眼下的状态，窗口窄时不显示；侧栏底部只放设置；打开时有一秒左右可跳过的开场；窗口够宽时会话和首页右边有她的全身立绘。首页中间一个输入框，工具调用显示为一行动作，点开看详情。图标由 `swift scripts/icons.swift` 从标志画出。不使用别的产品的图标、图片和样式代码。
- **文案**：只写已经实现的能力，朴素、具体，不用比喻和排比。
- **README 和社区文件**：`README.md` 写英文、是默认页，约 1000 词；`README.zh-CN.md` 写中文，两份结构相同、一起改。结构依次是：标志、名称、一句话定义和徽章，一行链接（官网 · 文档 · Releases · 另一种语言）；只放一张首图（审批中心）；两三句简介；快速开始；功能写成文字要点，和官网产品页的说法一致，不配图；截图一节放 2 到 4 张小图并排；然后是手机端、文档、数据去向、参与贡献、安全、许可证，最后是出品方的小号横版组合。较长的说明放 `docs/`（沙箱在 `docs/sandbox.md`）。图片放 `docs/assets/`（`node scripts/screenshots.ts` 生成），单张不超过 500 KB，都写替代文字；英文 README 会随 npm 包发布，图片用指向 GitHub 的绝对地址，中文 README 用相对路径和中文界面的图。CONTRIBUTING、CODE_OF_CONDUCT（Contributor Covenant 2.1）和 `.github/` 里的 issue、PR 模板保持中英双语。Release 说明写中英两版。
- **测试**：Agent 循环、工具和权限用 pi-ai 的 faux provider 写确定性测试，测试里不调用真实模型，不读写真实的 `~/.yew`。
- **临时试用**：要起一个 Yew Harness 看界面或截图时，用新的 `YEW_HOME` 加 `YEW_KEYCHAIN=off`，不需要浏览器和电脑操控时再加 `YEW_MCP_BUILTIN=off`（不然会从 npm 安装并启动自带的两个 MCP 服务）：系统钥匙串是所有数据目录共用的，不关掉的话临时的 Yew Harness 手里有真实的 API Key，一封信就会让会话调用真实模型。要复用的演示和截图脚本放进仓库，不放系统临时目录（会被系统清掉）。
- **提交前**：运行 `npm run check` 和 `gitleaks git --staged`。依赖锁定版本，`package-lock.json` 入库；发布前运行 `npm run audit:gate` 和 `npm run audit:install`（后者把打好的包全局装进临时目录，查装到的依赖和沙箱拿到的 zod）：生产依赖的高危问题必须修好；只在构建、测试时用到的依赖，没有修复版时可以在 `scripts/audit-gate.mjs` 登记豁免，写明公告编号、涉及的包、为什么只影响构建或测试和截止日，最长一个月，到期前升级或重新评估。

## 版本与更新记录

- 版本号遵循语义化版本 2.0.0，唯一来源是 `package.json` 的 `version`；`yew --version` 和关于页都从这里读，关于页的构建号用短提交号。新功能升次版本，只有修复时升修订号。
- 发布即在 main 上打 `v<版本>` 标签，用 `git push --follow-tags` 推送；提交本身不等于发布，已发布的版本不改写。
- 更新记录写在 `CHANGELOG.md`，格式按 Keep a Changelog 1.1.0，分新增、变更、弃用、移除、修复、安全六类，最新版本在前，未发布的改动写在「未发布」下；只写用户能感知的变化，平实、具体。
- 提交信息、更新记录和 Release 说明只写改了什么、为什么，写给不了解项目内部的人看：不写谁定的、谁要求的，不引内部编号和内部文档，不写私有仓库、服务器路径和客户信息，不加 AI 署名行（如 `Co-Authored-By`）。提交信息用英文，和默认的 README 一致：第一行一句话说清改动，细节放正文。已推送的提交不改写。
