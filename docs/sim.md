# 评测用的模拟环境：接口

`@tenonai/yew/sim` 给评测用：把一个场景（「世界」）装进新的数据目录，起一个 `yew serve`，由控制器扮演人来交任务、答审批，最后对账判分。装载世界和登录已经随 npm 包发布（1.5.0 起）；开始的闸门和场景时钟、运行记录和事件流、`YEW_SIM_AWAY` 还没做，现在世界里 `queued` 的信在 `yew serve` 起来后就投递，日期按真实时间走。

分工：

- **Yew Harness 提供三样**：能装进场景的临时实例、评测模式下的几个开关、一份运行记录。
- **控制器负责其余**：假会话的剧本、模拟的人、容器和网络、什么时候停、对账和判分。

几条约定：

- **控制器怎么用 Harness**：控制器用 Python，外壳是 Inspect AI（0.3.291）。装载世界用 npm 包子路径 `@tenonai/yew/sim` 里的 `loadWorld`：控制器调一个 Node 小脚本，由它 import，世界文件和数据目录作参数传进去。登录在 Python 里照 `signIn`（`src/sim/client.ts`）的做法做：同样的链接正则、`POST /api/auth/exchange`、Cookie 和 Origin。这两处（`loadWorld` 的参数和返回、一次性链接的格式和换 Cookie 的接口）是对外的接口，改动会写进更新记录。控制器按版本固定，被测的实例也装同一个版本的包，运行记录里的 Harness 版本就对得上。
- **容器和网络归控制器**：容器不联网。被测模型和假会话都走一个 OpenAI 兼容的自定义服务商：`loadWorld` 的 `providers` 里 `baseUrl` 指向容器里 `127.0.0.1:13131` 的 Inspect bridge，bridge 经 `docker exec` 和控制器通信。这个服务商 `keyRequired: false`，不用放 Key。
- **世界文件和人的规则不进容器**：装载在单独的一步里写进数据目录，跑 `yew serve` 的容器里没有世界文件；假会话的剧本和人的规则从头到尾留在控制器。

## 一、怎么跑

1. 控制器建一个数据目录和若干工作区（从场景复制，带 git 历史），准备好世界文件。
2. `loadWorld(world, { home, underTest, providers, skill })`：把世界写进数据目录的 SQLite。返回一份名字和 id 的对照，评分要用：会话按名字，信按 `key`，卡按编号。这一步在 `yew serve` 启动之前、在控制器手里做，会话没有任何工具或接口能走到它；「本人」的决定只能这样预先造出来。`scripts/sim-load.ts <world.json> <数据目录>` 是同一个函数的命令行包装，对照表写到标准输出。
3. 带着评测模式的环境变量（第三节）起 `yew serve`。评测模式下它起来以后**先不跑任何会话**：不投递信件，不跑定时任务，场景时钟也不走。
4. `signIn(stdout)`（同一子路径）从 serve 的标准输出里找到一次性链接（端口也从链接里读），调 `POST /api/auth/exchange` 换成 Cookie，返回一个带好 Cookie 和 Origin 的请求函数。所有写请求都要带 `Origin: http://127.0.0.1:<端口>`。
5. 订阅评测事件流 `GET /api/sim/events`。可选：服务商要 Key 时，用 `PUT /api/providers/:id/key` 放进去，数据目录配 `YEW_KEYCHAIN=off`，Key 只在内存里；经 Inspect bridge 的自定义服务商不用这一步。
6. `POST /api/sim/start`：从这一刻起投递信件、跑定时任务，场景时钟从世界的日期开始走。
7. 交任务，三种方式：
   - 人的消息：`POST /api/sessions/:id/messages`；
   - 世界文件里状态为 `queued` 的信：start 以后自动投递；
   - 跑一个定时任务：`POST /api/schedules/:id/run`。按现有规矩算无人值守。
8. 边跑边按人的规则答：
   - 授权、ask_user 的问题、兜底提问：`POST /api/approvals/:id`。兜底提问是会话回复末尾的提问被放进审批中心，在审批中心里是一条 `kind` 为 `question`、`request.fromReply` 为 true 的记录，和 ask_user 一样回答。
   - 决定卡：`POST /api/cards/:id/decide`。
   - 暂存的信：放行 `POST /api/letters/:id/release`，拒收 `POST /api/letters/:id/refuse`。
   - 看有什么待处理的：`GET /api/center`。
9. 控制器判断该停了就停，在自己存的那份记录末尾写停止原因，再读 SQLite 或 `yew export` 对账。

有两件事是有意如此，剧本要照着走：`edit` 之前要先 `read` 同一个文件；回复最后一段带「告诉我」这类话，也算回复末尾的提问，会作为兜底提问进审批中心。

不加 skill 时 `skill` 传空字符串：`loadWorld` 总会在数据目录写一个 `AGENTS.md`。这个文件不存在时，Yew Harness 会退回去读 `~/.claude/CLAUDE.md`。控制器同时把 `HOME` 指向干净的目录。

## 二、世界文件（`yew-sim-world/1`）

JSON。时间都用 ISO 8601，带时区。会话、团队、工作区都用名字互相引用，装载时换成 id。

```json
{
  "format": "yew-sim-world/1",
  "date": "2026-11-20T09:00:00+08:00",
  "settings": { "language": "zh", "mainSession": "统筹", "defaultModel": { "provider": "deepseek", "model": "deepseek-v4-pro", "thinking": "medium" } },
  "teams": [{ "name": "产品" }],
  "workspaces": [{ "name": "acme-shop", "path": "/sim/work/acme-shop" }],
  "sessions": [
    {
      "name": "统筹",
      "kind": "standing",
      "team": null,
      "role": "……职责说明……",
      "workspace": null,
      "permissionMode": "auto",
      "receive": "accept",
      "canOrganize": true,
      "canPostCards": true,
      "model": "under-test",
      "openedBy": null,
      "status": { "state": "idle" },
      "transcript": []
    }
  ],
  "letters": [],
  "cards": [],
  "schedules": []
}
```

- **`date`**：场景开始的时刻。`YEW_SIM_DATE` 没设时，场景时钟就从它开始。
- **`sessions[]`**：
  - `kind`：`standing` 或 `task`。`permissionMode`：`auto`、`manual`、`skip`。`receive`：`accept`、`hold`、`refuse`。
  - `model`：写 `"under-test"` 表示被测的模型，由 `loadWorld` 的 `underTest` 给定；否则写 `{ "provider", "model", "thinking" }`。假会话写成指向控制器剧本服务的自定义服务商，用 `loadWorld` 的 `providers` 加进去。
  - `openedBy`：任务会话是谁开的，填会话名，系统提示词里会写出来。
  - `status`：`{ "state": "idle" }`、`{ "state": "error", "error": "…", "since": "…" }` 或 `{ "state": "archived" }`。
- **`sessions[].transcript[]`**：已有的对话，按时间。
  - `{ "role": "user", "text", "at" }`：人发的消息。
  - `{ "role": "assistant", "text", "calls": [{ "id", "tool", "args" }], "at" }`
  - `{ "role": "toolResult", "callId", "tool", "text", "isError", "at" }`
  - `{ "role": "compaction", "summary", "at" }`：压缩摘要，它之前的记录模型不再看到。
  - 信和决定不用写在这里：状态为 `delivered`、`done` 的信，和带 `deliveredTo` 的已定的卡，装载时按时间插进对应会话的记录，用 Harness 自己的格式。
- **`letters[]`**：`{ "key"?, "from", "to", "kind", "summary", "body", "status", "at", "replyTo"?, "decision"? }`。
  - `key` 是评分引用这封信用的名字；`replyTo` 填另一封信的 `key`。
  - `from` 是会话名，或 `"@person"`、`"@cli"`。
  - `kind`：`notice`、`request`、`decision`、`report`。
  - `status`：`queued`、`held`、`delivered`、`done`、`refused`、`dropped`。`queued` 的信在 start 以后投递。
  - `decision`：转达决定的信填决定的编号。
- **`cards[]`**：`{ "number", "by", "requestedBy"?, "title", "context", "options": [{ "label", "detail"? }], "recommended"?, "deadline"?, "sessions"?, "undoable"?, "reversible"?, "after"?, "status", "choice"?, "note"?, "createdAt", "decidedAt"?, "withdrawnReason"?, "deliveredTo"? }`。
  - 字段和 post_card 的一样。`recommended`、`choice` 都写选项的标签，`sessions` 写会话名。
  - `status`：`pending`、`decided`、`withdrawn`。`decided` 的就是「本人」的决定。
  - `deliveredTo`：这个决定已送到的会话名列表，装载时把 `<decision>` 插进它们的记录。
- **`schedules[]`**：`{ "name", "cron", "session", "message", "enabled", "permissionMode"?, "catchUp"? }`。
- **以后可能加**：MCP 服务（HTTP，指向控制器的假服务），等有用 MCP 发信的题再加。

## 三、评测模式的开关

只在起 `yew serve` 的环境里设，并从会话 Shell 的环境里去掉。

| 变量 | 作用 |
| --- | --- |
| `YEW_SIM=1` | 打开评测模式。下面几个都要它；`/api/sim/start` 和 `/api/sim/events` 也只在这时有 |
| `YEW_SIM_DATE` | 场景时钟从这个时刻起走，没设时用世界文件的 `date`。系统提示词里的日期，信件、卡片和记录的时间，都按场景时钟 |
| `YEW_SIM_RUN` | 控制器给的一段 JSON，原样写进运行记录的第一行，字段由评测定，例如 `{"item":"p2-b2-3","version":1,"repeat":1}` |
| `YEW_SIM_LOG` | 运行记录写到哪；默认在数据目录里，会话读不到 |
| `YEW_SIM_AWAY=1` | 人不在：所有会话都按无人值守的规矩，要人批准的调用和提问直接拒绝，写进报告。备用，最后做：第一版里人不在的题，都由定时任务唤起值守会话 |

## 四、运行记录（`yew-sim-log/1`）

一行一个 JSON，每行都带 `t`（场景时钟的 ISO 时间）和 `type`。同样的行也从 `GET /api/sim/events`（SSE）送出，控制器边跑边存。

| `type` | 内容 |
| --- | --- |
| `run` | 第一行。`format`；`run`（`YEW_SIM_RUN` 原样）；`harness: { version, commit }`；`protocol`；`prompts: { system, tools }`，被测会话第一次调用时那份的 SHA-256；`model: { provider, model, thinking }`；`skill`（`AGENTS.md` 的 SHA-256，空文件也算）；`date` |
| `prompt` | 会话的系统提示词或工具说明第一次用、以后变了（压缩、上下文换新）时写一行：`session`、`kind`（`system` 或 `tools`）、`sha256`、`text`（全文） |
| `message` | 人发给会话的消息：`session`、`text` |
| `model_call` | 一次模型调用：`session`；`helper`（助手代跑的为 true，并带 `for`：派它的会话）；`n`；`provider`、`model`（这次实际用的）；`tokens: { input, output, cacheRead, cacheWrite, thinking }`（给不出的为 null）；`ms`；`text`（回复里给人看的文字）；`stopReason`；`error`（服务商报错、限流时的说明，没有为 null） |
| `tool_call` | `session`、`id`、`tool`、`args`（完整）、`status`、`result`（文字）、`exitCode`（Shell 类才有）、`approval`（对应的授权请求 id 或 null）。`status` 取：`done`、`error`、`denied`（拒绝或不让跑）、`needs_review`（重启时它在跑，结果不明） |
| `approval` | `id`、`session`、`kind`（`permission` 或 `question`）、`status`。`permission` 的带 `summary`、`purpose`（会话写的用途）、`mustConfirm`（必须确认的原因或 null）、`always`（有没有选「总是允许」）。`question` 的原样带 `questions`（问题、header、选项、建议项、是否多选）和 `fromReply`（兜底提问为 true）。答了以后再写一行，带 `answer: { by, choice, text }`；`by` 取 `person`、`rule`、`unattended` |
| `letter` | `id`、`event`（`sent`、`held`、`released`、`delivered`、`done`、`refused`、`dropped`）和信的全部字段 |
| `card` | `number`、`event`（`posted`、`updated`、`withdrawn`、`decided`）和卡的全部字段 |
| `compaction` | `session`、`summary`（原文） |
| `session` | `session` 和 `event`。`opened` 带 `by`（谁开的）和 `fork`（从哪个会话分出来，没有为 null）；`status` 带 `state`（`working`、`waiting`、`idle`、`error`、`stopped`）；`finished` 带 `outcome` 和 `next`（finish_task 的参数） |
| `fallback` | `session`、`text`：回复末尾的提问被兜底放进审批中心 |

停止原因（`idle`、`calls`、`time`）由控制器写在它那份记录的末尾。文件和 git 的最终状态、假服务收到的东西，也由控制器另存。

## 五、协议版本

`PROTOCOL_VERSION` 在 `src/shared/version.ts`，`/api/health` 的 `protocol` 字段能读到，也写进运行记录的第一行。信件、决定卡、授权请求、finish_task 的字段一改就升版本。

- 第 1 版：finish_task 有可选的 `next`，写还剩什么、下一步谁做。
- 第 2 版：信件有可选的 `quotes`，是会话转达的用户原话，发信前由 Yew Harness 对着自己的记录核对过；send_letter 和 open_session 相应接受 `quotes`。授权请求的 `reasons` 多了 `system-services`（用系统服务的命令）；`matter`（只有用户能答）不再包括点名 Yew Harness 的数据目录和「会话读不到的目录」的命令，跳过方式下只剩提高花费上限。
