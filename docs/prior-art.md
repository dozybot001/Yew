# 可借鉴的开源项目

2026-11-08 调研。许可证、最近推送和星数取自 GitHub API 和 npm，文件路径按各仓库当天的默认分支。开发某一块之前先看对应小节；复制代码前按第二节办。

## 一、结论

- **不 fork，也不在现成项目上构建。** 服务、Agent 循环、工具、权限和界面都自己写，参照下面这些项目的设计，没有复制代码。
  - 产品形态最接近的 Paseo、T3 Code 只包装 Claude Code、Codex 等外部命令行，没有自己的 Agent 循环。
  - 技术形态最接近的 OpenCode 自带循环、模型可换，但新版绑定 Effect 和 Bun，界面用 SolidJS，约 1.1 万个文件；fork 等于接手它的循环。
  - OpenClaw 是多渠道的个人助理网关，体量过大。pi 的 `apps/p2` 技术栈和 Yew Harness 最像（Node、React 19、pi），但 README 写明是原型，很快删除。
- **pi-agent-core 不作依赖，照它的循环改写。** 它是唯一认真考虑过的依赖：MIT，274 KB，钩子正好对上权限、排队和打断。不直接用它，原因有四：
  1. 1.0.0（10-01）到 1.5.0（11-02）发了 10 版，1.5.0 只升次版本号，却改了 `AgentTool` 的参数类型。
  2. 它精确锁定同版本的 pi-ai，模型层和循环只能一起升级。
  3. 它的消息和工具类型会铺满循环、工具、权限和存储，打破「pi-ai 只在 `src/server/model/` 引用」的约定。
  4. Yew Harness 的审批可能挂几个小时、跨重启，循环要在每个工具调用上落库和恢复，这一层要自己掌握。

  它的循环文件 959 行，连同 Agent 类和类型约 2100 行，照着改写的成本不高。
- **设计主要参照这几处**：pi（MIT）、OpenCode（MIT）、Gemini CLI（Apache-2.0）、Kimi Code（MIT）、OpenClaw（MIT）、T3 Code（MIT）。都是参照设计自己写，没有复制代码；只读命令名单、「允许并记住」的前缀和剥包装命令这三处和原文逐一比过，不构成复制。

## 二、复制规则

- MIT 的代码保留原版权和许可声明；Apache-2.0 的附上 LICENSE 和 NOTICE，并在文件头标明改动。每次复制都记进仓库根目录的 `THIRD_PARTY_NOTICES.md`，第一次复制时建立这个文件。
- 只复制代码。任何项目的系统提示词和工具说明都不复制，Yew Harness 的自己写（AGENTS.md「净室开发」）。
- GPL、AGPL、FSL、带品牌限制或附加条款的项目，只看思路，不复制代码。
- 第三节排除的仓库，代码和文档都不读。
- 包装 Claude Code 的项目里，面向 Claude Code 的适配层和分析文档不读，例如 Happy 的 `docs/competition/claude/`、OpenCode 的 `packages/core/src/plugin/provider/claude-agent/`。

## 三、不读、不用的材料

- 不读、不用泄露、逆向或转载的 Claude Code 源码和提示词。
- 许可证带附加条款的项目不读代码，只看公开的说明文档。
- Yew Harness 接 Anthropic 只用 API Key，不做账号登录，不发送其他客户端的标识。

## 四、M1：Agent 循环与工具

### 4.1 Agent 循环

- **pi `packages/agent/src/agent-loop.ts`、`types.ts`**（MIT，参照设计自己写）：
  - 事件按 agent、turn、message、tool_execution 分 start、update、end 三种，可以直接转成 SSE。
  - 一批工具调用先逐个预检（参数校验和 `beforeToolCall`，审批在这一步逐个问完），再执行。批里有一个工具要求顺序执行，整批就顺序执行。结果按原顺序写回。
  - `beforeToolCall` 返回 `{block, reason}` 时，生成一条出错的工具结果，拒绝理由由此交给模型。
  - 两种排队：steer 的消息在整批工具结果写回后、下一次请求模型前送达；followUp 的消息等循环停下再送。
  - 打断后，已生成的部分留在记录里（stopReason 为 aborted），发新消息就能接着说。
  - `packages/agent/test/agent-loop.test.ts`（66 KB）可以当测试用例清单。2026-11-16 对照过一遍，补上一条：回复在输出上限处被截断时，里面的工具调用一律不执行（参数可能被截断却仍能通过校验），给模型一条出错结果让它重发。Yew Harness 的对应测试在 `test/long-run.test.ts`。
  - pi-ai 的 `isRetryableAssistantError`、`retryDelayMs`（MIT，作依赖调用）：判断一次失败值不值得重试、算退避时间。Yew Harness 在模型层（`src/server/model/gateway.ts`）用它们做唯一一层重试，服务商 SDK 自带的重试关掉；另加空闲超时，流 5 分钟没有数据就放弃这一次并重试。
- **OpenCode `packages/core/src/session/inbox.ts`**（MIT，照设计重写）：排队的消息存在表里，分「步骤之间送达」和「空闲时送达」两种。转成正式消息和删除排队记录在同一个事务里完成，重启不丢，也不重复。会话忙时，排队的消息可改可撤。
- 模型接口要求工具结果紧跟在工具调用后面，所以「两次工具调用之间送达」只能落在一整批结果写回之后。
- pi 的工具可以声明结果未知时能否重放（`replay`）。Yew Harness 不重做，重启后一律标「待核对」。

### 4.2 工具

下表中 pi 的路径省略前缀 `packages/coding-agent/src/`，OpenCode 和 Gemini CLI 的省略 `packages/core/src/`。

| 工具 | 来源 | 做法 |
| --- | --- | --- |
| read | OpenCode `tool/read-filesystem.ts`、`tool/plugin/read.ts` | 单次最多 2000 行或 50 KB；单行截到 2000 字符；含 NUL 判为二进制；行首加行号；截断时提示下一个 offset |
| edit | pi `core/tools/edit-diff.ts`、`edit.ts`；OpenCode `tool/plugin/edit.ts` | 先精确匹配；不中再归一（NFKC、去行尾空白、弯引号、破折号、特殊空格）后匹配，仍须唯一；多处命中时报出次数，要求加上下文，另给 `replaceAll`；一次多段编辑都对原文匹配，重叠就拒；保留 CRLF 和 BOM |
| 读后被改 | Gemini CLI `tools/edit.ts`；Crush `internal/agent/tools/edit.go`（只看思路） | 读时记修改时间、大小和 SHA-256；写前先比前两项，变了再比哈希，内容变了就拒绝 |
| 写入串行 | pi `core/tools/file-mutation-queue.ts` | 同一文件的写入排队执行 |
| shell | pi `core/tools/bash.ts`、`core/tools/output-accumulator.ts`、`utils/shell.ts`；OpenCode `tool/plugin/shell.ts` | 用 `detached` 开新进程组，结束时杀整组；macOS 上先对整组发 SIGSTOP，防止 `a; b` 取消时接着跑 b；输出保留尾部 2000 行或 50 KB，全文写进临时文件；默认超时 2 分钟；后台运行时立即返回编号和输出文件，结束时通知，不让模型轮询 |
| grep、glob | pi `core/tools/grep.ts`、`find.ts` | `rg --no-config --json --line-number --color=never --hidden`，`--no-config` 防止用户的 ripgreprc 改变结果；默认 100 条、单行 500 字符，多取一条来判断是否截断；glob 用 `rg --files --glob` |
| web_fetch | OpenCode `tool/plugin/webfetch.ts`、`tool/html-markdown.ts`；Gemini CLI `tools/web-fetch.ts` | 用 htmlparser2 转 Markdown；手动跟随重定向，每一跳重新过权限，最多 10 跳；超时 30 秒；拒绝 localhost 和私网地址 |
| 输出截断 | pi `core/tools/truncate.ts` | 截断规则，以及截断后给模型的提示 |

工具的参数定义用普通 JSON Schema；pi-ai 1.5 的 `Tool.parameters` 就是 JSON Schema。

### 4.3 权限

- **OpenCode `packages/core/src/permission.ts`、`shell/parse.ts`，回复类型在 `packages/schema/src/permission.ts`**（MIT）：
  - 规则由动作、资源、效果组成，用通配匹配；回复分一次、始终、拒绝，拒绝可附理由。
  - 有一套无人值守规则，把询问一律判成拒绝，M3 的定时任务用得上。
  - Shell 命令按一张参数层级表（ARITY）决定「始终允许」记到哪一级前缀，例如 `git status *`、`npm run build *`。
- **Gemini CLI `packages/core/src/sandbox/utils/commandSafety.ts`、`policy/policy-engine.ts`**（Apache-2.0）：
  - 用 TypeScript 写的只读命令判定。只读名单排除了 `find -exec`、`find -delete`、`rg --pre`、只带 `-n` 以外参数的 sed、`base64 -o`、带 `-c` 的 git。
  - 命令拆段后逐段判定；有重定向或命令替换，就把放行降为询问；解析失败时询问。
- **Kimi Code `packages/agent-core-v2/src/agent/permissionPolicy/`**（MIT）：十余条小策略按顺序判定，第一条给出结论的生效。`policies/dangerous-command-ask.ts` 先剥掉 sudo、doas、env、exec、`bash -c`、eval（最多嵌套 4 层）再判断是否危险，解析不了就询问。必须确认的命令清单可以从它和 Gemini CLI 的 `isDangerousCommand` 起步。
- **Codex `codex-rs/execpolicy/`**（Apache-2.0，Rust，只看设计）：前缀规则可以附命中和不命中的示例，加载时自检；多条规则命中时取最严的。
- **git**：仓库配置能让只读的 git 命令也执行辅助程序，Codex 因此在 2026-08 把 git 移出了安全名单。Yew Harness 没有沙箱，git 的只读命令只在会话的工作文件夹内放行。
- 不学 Goose 的智能审批：它让模型判断操作是否只读，判断结果会被提示注入左右。

### 4.4 上下文压缩

- **pi `packages/coding-agent/src/core/compaction/compaction.ts`、`docs/compaction.md`**（MIT）：保留最近约 2 万 token，不在工具调用和它的结果之间切；喂给摘要的工具结果截到 2000 字符；服务商报上下文超长时，压缩后重试一次；压缩记录标出保留部分从哪一条开始。 Yew Harness 的切点是任意一条消息或模型的一步的开头（2026-11-16 起；原先只能切在用户消息处，一条消息后连做几百步时切不了），代码在 `src/server/agent/compaction.ts`。切在一轮中间时，被移走部分里用户最近的那条消息原文存进压缩记录，随摘要一起发给模型（摘要会丢掉原话里的约束；用 `scripts/soak.ts` 对真实模型跑长任务时发现的）。
- **OpenCode `session/compaction.ts`**（只看思路）：离阈值还差一段时，在后台预先生成摘要，到点直接换上，不让用户等。
- **Goose `crates/goose/src/context_mgmt/mod.rs`**（只看思路）：比例阈值（默认 80%）之外再设 token 上限，先到哪个算哪个。
- 各家的阈值：Codex 90%，Kimi Code 85% 且另外留出 5 万，Gemini CLI 50%，Goose 80%。DeepSeek V4 Pro 的窗口是 100 万，只按 80% 要到 80 万 token 才压缩，单次请求很贵，所以 Yew Harness 同时设 token 上限（M1 计划第六节）。

### 4.5 说明文件

- **Codex `codex-rs/core/src/agents_md.rs`**（Apache-2.0，Rust）：以 `.git` 所在目录为项目根，从根到工作文件夹每层取一个说明文件，合计不超过 32 KiB。
- **pi `packages/coding-agent/src/core/resource-loader.ts`**（MIT）：每个目录只取一个文件，依次找 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`。
- **Gemini CLI `packages/core/src/utils/memoryImportProcessor.ts`**（Apache-2.0）：`@路径` 导入最深 5 层；防循环；代码块和行内代码里的 @ 不算；只导入项目根以内的文件。
- **OpenCode `instruction-discovery.ts`**（MIT）：会话中途说明文件变了，就追加一条消息，说明哪些文件增、删、改。系统提示词不重写，提示词缓存就不会失效。
- 同一文件只载入一次。Yew 仓库的 `CLAUDE.md` 内容就是 `@AGENTS.md`。

### 4.6 测试

- **pi-ai `packages/ai/src/providers/faux.ts`**：用 `setResponses` 排好回应。回应可以写成函数，拿到发给模型的上下文，用来断言循环发了什么；`tokensPerSecond` 模拟流式输出。
- **Gemini CLI `core/fakeContentGenerator.ts`**：把真实响应录成文件再回放，适合给真实服务商做回归冒烟（录制时去掉密钥）。

## 五、M1：本地服务与界面

### 5.1 事件流

- **OpenCode 的两层事件流**（`packages/server/src/event-feed.ts`、`packages/schema/src/session-event.ts`、`event-log.ts`，MIT，照设计重写）：
  - 全局流明确是易失的。
  - 每个会话有带序号的持久日志：按 `after=<序号>` 先回放到当前位置，发一条「已同步」标记，再接实时。
  - 每个订阅者一个有界队列（4096 条），溢出就断开，客户端重连后重读。
  - 每 15 秒发一条 SSE 注释保活；客户端按静默时长识别手机休眠后的半开连接。
- **Paseo `docs/timeline-sync.md`**（Apache-2.0）：实时增量和权威历史分两条路；发现序号缺口就按游标分页补齐；单条大小封顶截断，工具项 64 KiB，其他 256 KiB。
- **Codex `codex-rs/app-server/README.md` 的 Thread read state 一节**：已读状态用 `{firstUnread, revision}` 表示，只有持久、可见的终态结果才推进它。

### 5.2 本机接口安全

- **pi `apps/p2/src/hosts/principals.ts`**（MIT，约 100 行，改写成 Hono 中间件）：
  - Host 只认 `127.0.0.1:端口`、`localhost:端口`，防 DNS 重绑定。
  - 带 `X-Forwarded-*`、`Forwarded` 头的请求不算本机。
  - Origin 必须同源。
  - 按 `Sec-Fetch-Site`、`Sec-Fetch-Dest` 拒绝跨站请求、本机其他端口发来的请求，以及被嵌入的请求。
  - 每个响应带严格的 CSP（nonce、`frame-ancestors 'none'`）。
- **OpenCode `packages/server/src/auth.ts`、`middleware/authorization.ts`、`request-site.ts`、`pairing.ts`**（MIT）：
  - 会话令牌用 HMAC 签名，换签名密钥即全部失效。
  - Cookie 名带端口，且只接受同源请求：同一主机的不同端口算同站，SameSite 分不开。
  - 已登录的一端签发 5 分钟有效的一次性码，另一台设备用它兑换 Cookie，M2 配对用得上。
- **反面教材**：OpenCode 的安全公告 CVE-2026-22812、CVE-2026-22813、GHSA-632h-h47v-g4x4。问题依次是：无认证且 `CORS *`；Markdown 插入原始 HTML、没有 CSP，`?url=` 能换掉服务器地址；`text/plain` 简单请求绕过预检，浏览器缓存的 Basic 凭据随跨站表单发出。
- Hono 内置的 `csrf` 中间件只查表单类请求，Origin 和 `Sec-Fetch-Site` 任一通过就放行，挡不住 DNS 重绑定。Host 白名单要自己写。

### 5.3 界面

| 小项 | 来源 | 做法 |
| --- | --- | --- |
| Markdown | react-markdown（MIT）；T3 Code `apps/web/src/components/ChatMarkdown.tsx`（MIT）；vercel/streamdown（Apache-2.0） | react-markdown 默认不渲染原始 HTML，再用自定义的 `urlTransform` 过滤链接；流式输出里没闭合的语法，参考 Streamdown 的处理 |
| diff | `@pierre/diffs`（Apache-2.0，OpenCode、T3 Code 在用）、`@git-diff-view/react`（MIT） | 作依赖，或由服务端生成统一 diff，界面自己渲染 |
| 会话侧栏 | T3 Code `apps/web/src/components/sidebar/SidebarThreadRow.tsx`、`ThreadStatusIndicators.tsx` | 每行有状态图标和干活计时；所有计时共用一个时钟，同一帧刷新 |
| 思考折叠 | vercel/ai-elements `packages/elements/src/reasoning.tsx`（Apache-2.0） | 流式输出时展开，结束 1 秒后自动收起，显示用时 |
| 审批卡 | T3 Code `apps/web/src/components/chat/ComposerPendingApprovalActions.tsx`、`TimelinePendingApprovalRow.tsx` | 主按钮只放「批准」和「拒绝」，「记住」收进菜单；执行命令、改文件、读文件各有图标和文案；拒绝时可附理由 |
| 审批与提问的状态 | OpenCode `packages/app/src/session/requests/permission-machine.ts`、`question-machine.ts` | 各用一个状态机管键盘操作和切换 |
| 长记录 | assistant-ui 的 virtualization 指南；pi `apps/p2/src/web/use-chat-scroll.ts`、`virtual-list.ts`；use-stick-to-bottom（MIT） | 按「行」虚拟化，不按消息，因为一轮可能有上百个工具调用；先试 `content-visibility: auto`；Chrome、Firefox 交给 `overflow-anchor`，Safari 手动锚定 |

assistant-ui、ai-elements 不整体引入，只按需参考结构，控件照旧自绘。

## 六、M2：手机

- **OpenClaw `src/gateway/approval-web-push.ts`、`ui/public/sw.js`、`ui/src/app/web-push.ts`**（MIT）：
  - 审批推送的正文只写「有审批待看」，可以选择不带命令内容。
  - 每个审批设一个 tag，审批结束时用终态通知替换原通知。
  - 点通知深链到已登录的批准页再操作，不在通知按钮上直接批准。
  - 设置 `topic`、`urgency: high` 和 TTL。
- **OpenClaw `docs/gateway/tailscale.md`**：`tailscale serve` 提供 ts.net 的 HTTPS，转发到一个专用的回环端口，以此区分本机请求和远程请求；服务本身仍只监听回环。
- Web Push 和 Service Worker 只能在 HTTPS 下工作，`http://100.x` 这样的地址不行，要用 `tailscale serve` 给的证书。证书由 Let's Encrypt 签发，机器名会进公开的证书透明日志。iOS 16.4 起支持 Web Push，但必须先加到主屏幕，并由用户点击触发授权。
- 发送 Web Push 用 `web-push`（MPL-2.0，只作依赖，不复制文件）；PWA 用 vite-plugin-pwa（MIT）。
- 端到端加密中继（Happy、Paseo 都有）M2 不需要：Tailscale 的 WireGuard 本身就是端到端加密。
- 没有核实的两点：iOS 上经 ts.net 安装的 PWA 能否收到推送；Android 从主屏幕启动时第一个请求是否不带 Cookie。如果后者属实，页面外壳不能依赖 Cookie。

## 七、M3：会话信箱与定时任务

### 7.1 信箱

- **pi `packages/durable/README.md`、`src/harness/inbox.ts`**（MIT；标为实验性，宜移植代码，不作依赖）：
  - 收件分三种：steer 在本轮工具调用之间插入，followUp 在本轮结束后开新一轮，write 只写进记录。
  - 同一 `requestId` 重复提交时返回原记录。
  - 任务每被崩溃打断一次就计数，到上限（默认 5）即终止，防止崩溃循环。
  - `reset(交接说明)` 开一个新上下文，旧记录留在库里。
- **MCP 规范 2026-07-28 的 `client/elicitation`；ACP `docs/protocol/v1/tool-calls.mdx`、`elicitation.mdx`**（Apache-2.0，照规范自己实现）：
  - 决定卡用受限的 JSON Schema 表达；回应分接受、拒绝、取消三种。
  - 审批选项分 allow_once、allow_always、reject_once、reject_always。
  - 认不出的回应不算批准；命令或目标变了要重新请求。
- **A2A `specification/a2a.proto`**（v1.0.1，Apache-2.0）：只借状态名（含 input_required、rejected、auth_required），以及「消息不可变、编号由发送方生成」。它面向跨网络的 Agent，进程内的会话用不上它的 JSON-RPC 和 gRPC。
- **OpenClaw `docs/concepts/session-tool.md`、`docs/tools/loop-detection.md`**：别的会话发来的信，在提示和记录里都标为非用户；回复只送一次，不再回灌给对方；同一工具、同样参数、同样错误连续 3 次就拦截。
- **RFC 3834**：带 Auto-Submitted 头的信不自动回复。
- **Hermes `tools/approval.py`**（MIT，参考设计）：同一项审批不重复出卡，参数相同的待批请求合并成一张。

### 7.2 定时任务

- **croner**（MIT，零依赖）只用来算下次运行时间，不用它的定时器。常驻服务每 60 秒比对一次墙钟和库里的下次运行时间，按（任务，计划时刻）去重；上一次没跑完，这一次记为跳过。注意 croner 默认把日期和星期两个字段按「或」处理。
- **Hermes `cron/missed_runs.py`、`cron/AGENTS.md`**（MIT，Python，移植逻辑）：每个任务一个补跑开关，补跑只跑一次，错过的场次记一行；先推进下次运行时间再派发；定时会话里禁用定时任务管理工具。
- **OpenClaw `docs/automation/cron-jobs/`**：启动时把过期任务错开重排，不一起执行；连续失败按 30 秒、1、5、15、60 分钟退避；重启时没有终态的运行记为「中断、投递未知」；没有变化就不发消息。`docs/tools/exec-approvals.md`：没有界面可以询问，或询问超时，就直接拒绝。
- 无人值守的会话把「询问」一律当作拒绝并上报；上报卡带「允许这一条并重跑」，批准只对这一条有效。向你提问改为发一张决定卡并结束本轮。定时会话不能新建或修改定时任务，也不能改自己的权限。

## 八、M4：技能、MCP、产物、记忆

- **技能**：agentskills `docs/client-implementation/adding-skills-support.mdx`（CC-BY-4.0）、pi `packages/coding-agent/src/core/skills.ts`（MIT）。
  - 扫描 `<项目>/.agents/skills`、`~/.agents/skills`、`~/.yew/skills`，兼容 `.claude/skills`；同名时项目级优先，并告警。
  - YAML 宽松解析；项目技能先经信任再加载。
  - 技能清单进系统提示，技能内容不被压缩掉。
  - `allowed-tools` 只当提示，不当放行：规则不能整体放行工具。
- **MCP**：官方 TypeScript SDK v2（`@modelcontextprotocol/client` 2.4.0，Apache-2.0）作依赖，备选 `@earendil-works/pi-mcp`（MIT）。
- **自带的 MCP 服务**（2026-11-16，不是 Yew Harness 本身的依赖，不复制代码；整棵依赖树锁在 `mcp-builtin/package-lock.json`，第一次使用时用 `npm ci --ignore-scripts` 装进数据目录）：浏览器用 microsoft/playwright-mcp（`@playwright/mcp`，Apache-2.0）；电脑操控用 domdomegg/computer-use-mcp（MIT）。比较过的：chrome-devtools-mcp（Apache-2.0，偏调试）；mediar-ai/mcp-server-macos-use（MIT，npm 包里带 posthog 等与功能无关的依赖，不用）。版本写在 `mcp-builtin/package.json`，升级时重新生成锁文件、看它们的更新记录，并对 `mcp-builtin` 运行 `npm audit`。2026-11-16 的审计：sharp 的高危（libvips 等）用 `overrides` 固定到已修复的 0.35.5；剩下 8 条中危都是 file-type 在解析恶意构造的文件时死循环（GHSA-5v7r-6r5c-r473），经 jimp 被 nut-js 带入。豁免理由：这里处理的只有本机截下的屏幕图像，没有外来文件；上游修复后随版本升级去掉。
  - 只做 stdio 和 Streamable HTTP。
  - stdio 子进程默认只继承 HOME、LOGNAME、PATH、SHELL、TERM、USER，密钥显式传入；关闭时杀整个进程组。
  - OAuth 令牌按 issuer 分开存进钥匙串，回调地址用 `http://127.0.0.1:<端口>/callback`。
  - 项目级的 MCP 配置先经信任才读；新增 stdio 服务器要你确认。
- **产物**：pi `apps/p2/plugins/artifacts/server.ts`、`preview.tsx`（MIT），OpenCode `packages/server/src/handlers/artifact.ts`（MIT）。
  - 产物响应头的 CSP 自带 `sandbox allow-scripts`；iframe 不给 `allow-same-origin`，得到不透明源。
  - 另加 `frame-ancestors 'self'`、`form-action 'none'`、`connect-src 'none'`。p2 放开了 `https:`，Yew Harness 不照抄这一点。
  - 每个产物新建一个 iframe。
  - Sandpack 默认用 codesandbox.io 的打包器，safe-content-frame 的外壳托管在第三方域名，都不符合「数据在本机」。
- **记忆**：常设会话换新上下文时，身份从数据库和文件重建，包括职责和说明文件、固定读的记忆文件、未读信件和未了结的请求与审批、它自己写的交接说明、已激活的技能。参考 Hermes 的记忆上限和开局冻结（`website/docs/user-guide/features/memory.md`）、OpenClaw 压缩前先静默写一轮记忆（`docs/concepts/compaction.md`）。

## 九、核实过的仓库

| 仓库 | 许可证 | 语言 | 最近推送 | 星数 | 借什么 |
| --- | --- | --- | --- | --- | --- |
| [earendil-works/pi](https://github.com/earendil-works/pi)（原 badlogic/pi-mono） | MIT | TypeScript | 2026-11-08 | 120,705 | pi-ai 所在的仓库：循环、工具、压缩、本机接口校验、产物、信箱 |
| [anomalyco/opencode](https://github.com/anomalyco/opencode)（原 sst/opencode） | MIT | TypeScript | 2026-11-08 | 225,362 | 权限、排队、事件流、认证、web_fetch |
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | Apache-2.0 | TypeScript | 2026-11-08 | 108,774 | 只读命令判定、@ 导入、读后被改的检测 |
| [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | MIT | TypeScript | 2026-11-06 | 8,169 | 策略链式的权限、危险命令判定 |
| [openai/codex](https://github.com/openai/codex) | Apache-2.0 | Rust | 2026-11-08 | 133,616 | 前缀规则、AGENTS.md 层级、已读状态 |
| [aaif-goose/goose](https://github.com/aaif-goose/goose)（原 block/goose） | Apache-2.0 | Rust | 2026-11-08 | 56,344 | 压缩阈值 |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | MIT | TypeScript | 2026-11-08 | 394,169 | Web Push 审批、Tailscale、定时任务、防循环 |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | MIT | Python | 2026-11-08 | 261,587 | 定时补跑、无人值守的审批、记忆上限 |
| [pingdotgg/t3code](https://github.com/pingdotgg/t3code) | MIT | TypeScript | 2026-11-08 | 51,628 | React 界面组件 |
| [getpaseo/paseo](https://github.com/getpaseo/paseo) | Apache-2.0 | TypeScript | 2026-11-08 | 23,434 | 记录同步、守护进程 |
| [slopus/happy](https://github.com/slopus/happy) | MIT | Swift | 2026-11-08 | 24,536 | 手机端；加密中继（M2 不用） |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | Apache-2.0 | Rust | 2026-11-07 | 4,597 | 工具调用和权限选项的词汇 |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) | Apache-2.0 | — | 2026-11-05 | 26,446 | 任务状态名 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 新贡献 Apache-2.0，旧贡献 MIT | TypeScript | 2026-11-05 | 13,730 | M4 的 MCP 客户端 |
| [agentskills/agentskills](https://github.com/agentskills/agentskills) | Apache-2.0（docs 为 CC-BY-4.0） | Python | 2026-11-04 | 27,054 | 技能规范 |
| [Hexagon/croner](https://github.com/Hexagon/croner) | MIT | TypeScript | 2026-11-08 | 2,615 | cron 计算 |
| [vercel/ai-elements](https://github.com/vercel/ai-elements) | Apache-2.0 | TypeScript | 2026-10-14 | 2,510 | 思考折叠等组件 |
| [vercel/streamdown](https://github.com/vercel/streamdown) | Apache-2.0 | TypeScript | 2026-11-05 | 5,748 | 流式 Markdown |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT | TypeScript | 2026-11-08 | 12,998 | 聊天组件、虚拟化指南 |
| [remarkjs/react-markdown](https://github.com/remarkjs/react-markdown) | MIT | JavaScript | 2026-10-03 | 15,935 | Markdown 渲染 |
| [cure53/DOMPurify](https://github.com/cure53/DOMPurify) | Apache-2.0 或 MPL-2.0 | JavaScript | 2026-11-07 | 17,510 | HTML 清洗 |
| [pierrecomputer/pierre](https://github.com/pierrecomputer/pierre) | Apache-2.0 | TypeScript | 2026-11-08 | 6,516 | `@pierre/diffs` |
| [stackblitz-labs/use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom) | MIT | TypeScript | 2026-06-04 | 784 | 贴底滚动 |
| [web-push-libs/web-push](https://github.com/web-push-libs/web-push) | MPL-2.0 | JavaScript | 2026-11-07 | 3,572 | 发送 Web Push（只作依赖） |

看过但不采用的：

- **只能看思路**：Crush（FSL-1.1-MIT）；siteboon/claudecodeui、coder/xum、winfunc/opcode（AGPL-3.0）；Open WebUI（许可证禁止改品牌）；LobeHub（社区许可证附加了商用条件）。
- **停更或转向**：Vibe Kanban 宣布停运；kimi-cli、Roo Code、sugyan/claude-code-webui、wbopan/cui、21st-dev/1code 已归档；Crystal 改名 Nimbalyst；Omnara 转做托管平台；AutoGen 的 README 称已归档。
- **不合用**：beads（Go 加 Dolt，面向多机同步）；node-cron、cron、bree、cron-parser（自带定时器或依赖 luxon，croner 够用）；Aider（用文本编辑格式，不走工具调用）；`@modelcontextprotocol/sdk` v1（依赖 express 等服务端包）；`@virtuoso.dev/message-list`（商业许可）。
- **只核了仓库信息，没读代码**：Cline、Continue、OpenHands、Mistral Vibe、mini-swe-agent。

## 十、v1 之后补齐（2026-11-19：多模态附件、PDF、多目录、换新与触发器）

为避免重复造轮子，对这一批工作流补全项单独核对了开源生态（均符合第二节的许可与净室规则）：

| 能力 | 选用 / 参考 | 许可证 | 决策与理由 |
| --- | --- | --- | --- |
| PDF 解析与扫描页渲染 | [mozilla/pdf.js](https://github.com/mozilla/pdf.js)（npm `pdfjs-dist` 6.5.438，可选依赖 `@napi-rs/canvas` 1.1.1） | Apache-2.0 / MIT | **直接作生产依赖（精确锁版本）**。零必需传递依赖、原生支持 Node 24 ESM，自带离线 `cmaps/` 和 `standard_fonts/`（中文合同/发票/证照 PDF 100% 离线解析，不请求外部 CDN）。`unpdf`（MIT）默认不含本地 CMap，解析中文 CID 字体容易乱码；`mupdf` 为 AGPL-3.0，不采用。配合 `@napi-rs/canvas`（MIT，与已有的 `@napi-rs/keyring` 同生态）在 macOS 与 Linux 上均可离线把纯图扫描页渲染成 PNG 喂给视觉模型。 |
| 图片尺寸与格式核验 | [image-size/image-size](https://github.com/image-size/image-size)（npm `image-size` 2.1.0） | MIT | **直接作生产依赖（精确锁版本）**。98 KB、零依赖、纯 JS 解析 PNG/JPEG/GIF/WebP 宽高与格式，配合自写魔数白名单校验；不采用曾出现恶意文件死循环漏洞的 `file-type`（GHSA-5v7r-6r5c-r473），也不引入体积大且含原生 libvips 的 `sharp`（端侧缩放交给浏览器 Canvas、iOS `CGImage`、Android `Bitmap`）。 |
| 会话级附件存储 | OpenCode Issue #46173（MIT，参考架构思路） | MIT | 附件以文件形式单独落盘在每会话目录、消息记录里只存轻量引用，避免大 base64 撑爆 SQLite、误触发 token 压缩或拖慢手机中继传输。 |
| 多目录工作区 | Gemini CLI `--include-directories`（Apache-2.0，参考设计） | Apache-2.0 | 保留主工作区 `cwd`，新增显式区分只读/可写的 `extraDirs`，黑名单（凭据与不可读目录）永远优先于白名单。 |
| 常设会话换新上下文 | pi `packages/durable/src/harness/inbox.ts` `reset()`（MIT，参考设计） | MIT | 保留同一会话 id 与全部历史记录，在记录里写一条新的上下文边界（可选交接摘要）并重拍环境快照。 |
| 定时任务隔离 | Hermes `cron/`、OpenClaw `cron-jobs`（MIT，参考设计） | MIT | 支持按所属常设会话派生干净的 `task` 会话运行，完成后自动归档；定时运行期间禁止改定时任务或放宽权限。 |
| 输入框 `@` / `/` 补全 | T3 Code、OpenCode（MIT，参考交互） | MIT | `@` 行内任意位置提及会话或工作区文件，`/` 行首触发技能与 `/compact`、`/renew`，控件按产品规范第 7、18 节自绘。 |
