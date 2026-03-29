# 技术方案决策

> **前置必读**：在讨论任何技术决策之前，必须先阅读产品功能设定文档：
> `pokeclaw/design-docs/product-principles.md`
> 所有技术方案必须服务于产品原则，而非反过来。技术选型有分歧时，以产品原则为准。

> 原则：从下至上（基础先行），从内至外（核心先做）
> 逐节讨论，每节确定后再进入下一节

## 阅读说明

这份文档不是“短摘要”，而是 **后续开发的主决策文档**。默认假设未来新的实现 session 可能只能看到这份文档，因此这里要保留足够的上下文、边界和例子，避免实现时重新争论。

阅读方式：

- **先看结论，再看细节**：每节前几条是最终口径，后面保留原因、例子和边界条件
- **允许细节多，但不允许同一决策散落多处且互相冲突**
- **`DONE`** 表示大方向已定，后续实现只允许在不违背本节结论的前提下细化
- **`TODO` / `DRAFT`** 表示仍可调整，但如果某条已经写成明确口径，默认视为当前实现应遵守

建议按这个顺序查阅：

1. Section 2：Agent核心、pi-mono集成、配置与模型
2. Section 3：安全与隔离
3. Section 4：Agent生命周期、TaskAgent、记忆、运行时可观测性
4. Section 6：存储模型、compaction、runtime事件、竞品取舍
5. Section 8：消息适配与渲染边界
6. Section 9：飞书作为首个真实 channel 的实现要求

---

## 命名规范

| 名称 | 说明 | 用户交互渠道 | 生命周期 |
|------|------|-------------|---------|
| **主Agent** | 系统入口，永远保活的管家 | 飞书1v1私聊 | 永久 |
| **SubAgent** | 聊天型子代理，承担独立任务 | 飞书群（用户 + bot 两人群） | 用户解散群聊时归档 |
| **TaskAgent** | 后台执行代理，无独立飞书群 | `TODO` 未来通过飞书thread轻量交互 | 任务完成即销毁 |

- **主Agent**：用户与bot的飞书1v1私聊，整个系统唯一入口
- **SubAgent**：每个SubAgent对应一个飞书群（默认仅用户和bot两人），用户可在群内直接对话，有持久对话上下文
- **TaskAgent**：统一的后台执行单元，不开独立飞书群。两种触发方式：
  - 定时触发（CronService调度）→ 执行定时任务
  - Agent委派（任意主Agent/SubAgent创建）→ 执行外包子任务（节约上下文、并行执行）
  - 结果向调用者汇报，通过调用者的飞书渠道展示
  - `TODO` 未来支持用户通过飞书thread与TaskAgent轻量交互（回复TaskAgent的消息卡片即可干预其运行）
- **深度限制**：主Agent和SubAgent为第一层，TaskAgent为第二层，TaskAgent不能再创建TaskAgent

> 全文档统一使用以上命名，不使用"后台型SubAgent""BackgroundTask""cron session"等替代称呼。

---

## 1. 基础层：语言、运行时、项目结构 `DONE`

- [x] 开发语言：**TypeScript**
- [x] 运行时：**Node.js** (>=20)
- [x] 包管理：**pnpm**，单package项目，暂不用monorepo（后续如有插件再拆分）
- [ ] 项目目录规范

## 2. Agent核心：框架与LLM `DONE`

### 2.0 进程入口与启动装配 `DONE`

- [x] `main.ts` 只承担进程级职责
  - 加载配置
  - 初始化 storage
  - 启动 runtime bootstrap
  - 监听 `SIGINT` / `SIGTERM`
  - 触发 graceful shutdown
- [x] 真实 runtime 对象装配收敛在 `src/runtime/bootstrap.ts`
  - 组装 `AgentLoop`
  - 组装 builtin tools / `PiAgentModelRunner`
  - 组装 `SessionRuntimeIngress`
  - 组装 `AgentManager`
  - 组装 `CronService`
- [x] `main.ts` 不承载业务逻辑
  - 不做 task/cron/orchestration 规则判断
  - 不直接实现调度、状态机或 channel 语义
  - 只负责“把系统启动起来并在退出时收干净”
- [x] graceful shutdown 当前口径
  - 收到 `SIGINT` / `SIGTERM` 后停止 `CronService` 新扫描
  - 等待 in-flight cron run 落账完成后再退出进程
  - storage 在 runtime 停稳后关闭

### 2.1 框架与工具集

- [x] Agent框架：**pi-mono**（与openclaw相同）
  - `@mariozechner/pi-ai` — 统一多Provider LLM API（Anthropic/OpenAI/Gemini/Bedrock/Mistral）
  - `@mariozechner/pi-agent-core` — Agent运行时（工具调用、状态管理、transport抽象）
  - 源码位置：`/Users/daniel/Programs/ai/pi-mono`
- [x] LLM Provider抽象层：pi-ai已内置多模型切换
- [x] Tool执行引擎：参考 pi coding-agent（`pi-mono/packages/coding-agent/src/core/tools/`）+ openclaw的tool实现
  - pi coding-agent内置7个基础工具：read、bash、edit、write、grep、find、ls
  - 预置工具组：`codingTools`（读写执行）、`readOnlyTools`（只读探索）
  - 工具注册模式：TypeBox schema + factory函数 + 可插拔operations接口（便于sandbox替换执行层）
  - openclaw在此基础上扩展了browser control、canvas、cron、web search等高级工具，可按需参考
- [x] 多模态支持：默认依赖模型自身的多模态能力，后续具体再看

### 2.2 pi-mono集成策略

- [x] 基于OpenClaw集成深度分析
  - **使用**：
    - `pi-ai`：多Provider LLM API适配（核心价值，但OpenClaw实际上大部分provider自己包了stream wrapper，我们评估是否需要同样程度的自定义）
    - `pi-agent-core`：AgentMessage类型定义、AgentTool接口（消息格式统一）
    - `pi-coding-agent` tools：codingTools基础工具集（read/write/edit/bash/grep等）作为基础
  - **不使用**：
    - `pi-coding-agent` SessionManager：整个设计围绕JSONL文件读写，我们选择SQLite存储对话历史，需要自建session管理层
    - `pi-coding-agent` compaction存储层：同样绑定JSONL结构
    - `pi-tui`：我们是飞书渠道，不需要终端UI
  - **参考但自己实现**：
    - Compaction算法逻辑（token估算、LLM摘要生成等可参考，存储层自建）
    - Agent loop编排（createAgentSession的核心循环可参考，failover/steering/followUp等自建）
  - **决策理由**：OpenClaw虽然依赖pi-mono，但实际上大量重新包装（LLM streaming几乎全部自己写、tools加了10+层wrapper、compaction触发逻辑自己实现）。pi-mono对我们的价值主要是LLM适配层+类型系统+基础工具集，不是完整的agent运行时

### 2.4 Runtime / Agent / Orchestration 分层边界 `DONE`

- [x] 当前实现与后续开发必须遵守的分层边界
  - **`AgentLoop`**
    - 单个 session 的单次 run 执行引擎
    - 负责：
      - model turn
      - tool execution
      - 同一 run 内的 steer 插入
      - approval hot wait / retry
      - compaction hooks
    - 不负责：
      - 找谁审批
      - 把审批请求送给哪个 agent
      - task/cron 生命周期
      - 跨 session 协调
  - **`runtime/*`**
    - session 级 ingress / dispatcher / lane 外壳
    - 负责：
      - one-active-run-per-session
      - 新输入是 start 还是 steer
      - approval decision 等外部信号进入 loop
    - 不负责：
      - 产品级 orchestration 规则
      - main/sub/task 的业务路由判断
  - **`agent/*`**
    - 角色、默认权限、system prompt、行为准则
    - 回答“这个 agent 该如何思考与工作”
    - 不负责 runtime ingress/lane，也不负责 channel 呈现
  - **`orchestration/*`**
    - 跨 session / 跨 agent / 跨 run 的产品级协调层
    - 负责：
      - `session -> owner agent -> main agent -> task run` 的关系解析
      - delegated approval
      - task/cron 结果路由
      - live-state / status / spawn / stop / restart
    - 输出给 channel adapter 的应该是：
      - raw runtime event
      - 必要业务上下文
      - 已决定的逻辑投递目标
    - **绝不负责直接拼最终人类展示消息**
  - **`channel adapter`**
    - 平台特定展示与 transport 层
    - 负责：
      - 卡片/文本/thread/patch 等具体渲染
      - 聚合、节流、降级
      - 用户交互回流成 ingress command
    - 不负责：
      - agent/runtime/orchestration 的业务语义判断

### 2.3 配置层、模型配置与管理 `DONE`

- [x] 配置层分工
  - `~/.pokeclaw/system/`：系统区；放 `config.toml`、`secrets.toml`、`pokeclaw.db` 与其他内部运行时元数据
  - `~/.pokeclaw/workspace/`：agent 工作区；后续放 memory 文件、缓存产物与 agent 运行时可自由读写的工作文件
  - `~/.pokeclaw/system/config.toml`：全局、重要、非敏感配置，只能由用户或 config CLI 修改；agent 默认不能直接读取或修改
  - `~/.pokeclaw/system/secrets.toml`：少量真正敏感的 secret 字段；它的意义是与普通配置分层，并配合 sandbox denyRead，而不是假设本地文件本身提供强隔离
  - `~/.pokeclaw/system/pokeclaw.db`：运行时对象配置、状态、草稿和审批记录；不通过普通 fs 工具暴露，而通过受控的 `db.*` 能力访问
- [x] 核心规则
  - 实例值在 SQLite，全局默认值和硬边界在 `config.toml`
  - 真正敏感的字段单独放 `secrets.toml`，不要把整个 provider/channel 对象视为 secret
  - 配置文件中的 secret 使用显式 `*_ref` 字段；普通字段保持普通值，不做隐式插值
  - 新 provider / new channel 的最终启用先不交给 agent；由用户或 config CLI 完成
- [x] 模型配置原则
  - v0 只支持**按场景配置默认模型**，不做 agent 自修改模型体系
  - 每个场景配置一个**可用模型列表**，当前阶段始终优先取列表第一个；后续再增加失败后的 fallback 逻辑
  - 当前只保留最基本的几个场景：主对话、compaction、SubAgent、Cron
  - 是否允许用户在对话中临时切换当前会话模型，可以后续实现时再决定；这不是当前配置架构的核心
- [x] Provider / Model 基本结构
  - Provider 和 Model 分离，采用 `provider/model-id` 形式
  - `config.toml` 存 provider 的非敏感配置、模型 catalog、场景默认列表和元数据
  - 每个 provider 可定义多个 model；每个 model 都有自己的上下文长度、能力边界、价格等元数据
  - 费用、context window、能力标记等放配置中，不硬编码
  - `_ref` 后缀只保留给 secret 引用（如 `api_key_ref`）；普通 provider/model 标识不使用 `_ref`
  - 非标准 provider 需要代码适配；兼容 OpenAI API 的 provider 尽量通过配置接入

## 3. 安全与隔离 `DONE`

> 本节回答三件事：
> 1. 安全边界由什么实现
> 2. 权限如何分层、授予和回收
> 3. secret 与无人值守提权如何处理

### 3.1 Sandbox基础设施

- [x] Sandbox方案选型：**Anthropic sandbox-runtime**（`@anthropic-ai/sandbox-runtime`）
  - OS级沙箱：macOS用Seatbelt，Linux用bubblewrap + seccomp BPF，无需Docker
  - 网络隔离：本地proxy（HTTP+SOCKS5），域名级白名单，默认全部禁止
  - 文件系统隔离：denyRead/allowWrite/denyWrite嵌套覆盖，内核层面强制执行
  - 包裹任意CLI命令及其所有子进程
  - 支持运行时动态更新权限（`updateConfig()`实时生效）
  - 支持human-in-the-loop：网络请求拦截 → askCallback → 挂起等用户审批 → 放行/拒绝，可对接飞书卡片授权
  - **需fork改造**：当前SandboxManager是全局单例，需改成可实例化class以支持per-subagent不同权限（~5300行TS，改造量约半天）
  - 源码位置：`/Users/daniel/Programs/ai/openclaw/sandbox-runtime`

### 3.2 权限模型与全局安全边界

- [x] 权限模型设计
  - 全局安全策略由用户/系统配置定义，是整个系统的最大权限集合，任何agent（包括主Agent）都不能修改或逾越，只有用户可配置
  - 主Agent和SubAgent共享同一套安全策略基础，区别在于任务管理而非安全边界
  - 主Agent可给SubAgent分配权限（不超过全局策略上限）
  - **权限主体是 agent**
    - 长期生效权限绑定到 `agent`
    - `session` / `conversation_branch` 不是权限归属主体，只是执行与展示上下文
    - `TaskAgent` 不持有独立长期权限；运行时使用其 `owner_agent_id` 的有效权限集合
  - **预授权与后续追加授权在 runtime 里同等待遇**
    - 主Agent创建SubAgent时给出的初始权限，与运行中审批新增的权限，最终都应进入同一套 grant 集合
    - 它们只在来源和有效期上不同，不应在运行时被区分成两套权限系统
  - **文件系统：结构化工具与 bash 分开建模**
    - **结构化工具（`read/write/edit/ls/find/grep/...`）**
      - 永久禁止（硬编码）：`~/.gnupg`, `~/.pokeclaw/system/**`，以及其他明确的系统保护区
      - `~/.pokeclaw/workspace/**`：所有 agent 默认可读写
      - 主Agent：默认可读用户环境中的大多数内容，但写权限默认需要授权
      - SubAgent：默认仅拥有创建时指定工作目录 + `~/.pokeclaw/workspace/**`
      - 每个 SubAgent 还应有一个专属私有工作区目录：
        - 路径：`~/.pokeclaw/workspace/subagents/<agent-id-prefix>/`
        - `<agent-id-prefix>` 当前先取 agent UUID 的前 8 个十六进制字符
        - 该目录用于 scratch、笔记、导出物、缓存等 agent 自己的工作产物
        - `workdir` 表示默认执行目录；相对路径解析、代码修改、测试等默认以它为根
        - 如果用户创建 SubAgent 时没有显式提供 `cwd/workdir`，则这个私有目录就是默认 `workdir`
        - 如果用户显式提供了 `cwd/workdir`（例如项目仓库路径），则该路径继续作为默认执行目录；私有工作区仍然会被创建，但不替代 repo `workdir`
        - 因此 `workdir` 与 `privateWorkspaceDir` 可能相同，也可能不同；prompt 与欢迎卡片都需要把这层区别明确告诉 SubAgent
    - **bash（sandboxed）**
      - 默认仍受 sandbox 约束，并继承各自 agent 的默认权限与已批准增量权限
    - **bash（full access）**
      - 不再尝试通过一堆细粒度路径挂载补齐权限
      - 审批通过后，按“接近用户本人终端执行”的语义直接运行
      - 一旦进入 full access，不再承诺文件级 hard deny 的技术强保证
  - **网络**
    - 当前倾向先简化：sandboxed bash 默认允许网络，后续如风险过高再收紧
    - 结构化工具的 network 权限模型后续单独扩展，不与 bash full access 混在一起
  - **SubAgent增量授权**
    - 主Agent创建SubAgent时预判初始白名单（跟随SubAgent生命周期，不过期）
    - 聊天型SubAgent运行中需要额外权限时，默认向用户申请（卡片交互）
    - TaskAgent/Cron运行中需要额外权限时，向主Agent申请（不打扰用户）
    - 主Agent代审不进入用户正在聊天的主 session，而是进入独立的主Agent approval session
    - 该 approval session 默认只提供审批所需的最小工具集；当前先固定为只读调查工具 + 专用审批工具，后续再扩
    - 增量授权默认按时间（可配置，如7天），用户可选永久；但当前第一版主Agent代审不向 agent 暴露可选期限，一律使用系统默认 TTL
    - SubAgent对话被用户归档/解散时，所有增量权限收回
    - 当前口径下，初始白名单也应直接落成该 agent 的 grant，而不是单独维护另一套“初始权限表”
  - **主Agent权限定位：有执行能力的管家**
    - 可以执行 bash；默认走 sandbox，必要时可申请 `bash full access`
    - 复杂/长时间任务委托SubAgent（产品设计选择，非安全限制）
    - 不能修改全局安全策略
    - 能给SubAgent分配权限，但上限由系统配置决定

### 3.3 自动提权与授权回路

- [x] 权限自动检测与授权机制（当前结论）
  - **结构化工具（`read/write/edit/ls/find/grep/...`）**
    - 权限/审批不是自动暂停恢复的隐藏流程，而是显式 agent flow
    - 普通 tool 调用权限不足时，返回结构化 `permission_denied`
    - agent 自己判断这次访问是否合理、必要
    - 如确有必要，再主动调用 `request_permissions`
    - `request_permissions` 才进入审批暂停/恢复路径，并可在批准后自动重试原 tool call
  - **bash / shell**
    - `bash` 不再走细粒度文件权限补洞式提权
    - `bash` 只有两档：
      - 默认：sandboxed
      - 提权后：full access（unsandboxed）
    - `bash full access` 的审批入口应直接放在 `bash` tool 自身参数中，而不是复用通用 `request_permissions`
    - `bash full access` 的长期授权不能放大为“以后所有 bash 都可提权”，而应绑定：
      - `agent`
      - 命令前缀（prefix）
      - `expires_at`
    - 当前阶段的 prefix 规则保持保守：
      - 只对**单个简单命令**提供长期 prefix 授权
      - 命令前面的简单环境变量赋值（如 `FOO=1 npm run dev`）在匹配前会被归一化剥离
      - `&&`、`||`、`;`、`|`、heredoc、subshell、command substitution、redirect 等复杂 shell 结构不进入长期 prefix 授权，只允许 one-shot full access
      - `cd foo && npm run dev` 这类场景优先通过 `cwd/workdir` 解决，而不是依赖 compound prefix
    - 只有命中该 prefix 的后续 bash 调用，才能直接享受既有 full access 授权
    - 一旦批准 `bash full access`，就不再承诺文件级 hard deny 的技术强保证；风险控制点转移到审批本身
    - **当前阶段不支持裸后台命令**
      - 在正式后台任务管理能力落地前，`bash` 继续拒绝明显后台化语法（如未转义的 `&`、`nohup`、`setsid`、`disown`）
      - 后续通过正式的 `job/process` 能力支持后台任务，而不是依赖 shell 技巧
  - 参考飞书实现：lark-integration/lark-capability-tests.md
  - **主Agent delegated approval 会话**
    - `approval_target = main_agent` 时，不把审批请求投递到主聊天 session，也不向该 transcript 追加 system 消息
    - orchestration 负责创建/定位一个专用 approval session，并在其中驱动主Agent完成 approve / deny
    - approval session 的复用范围是“同一次 unattended run”
      - 同一个 `task_run` / source execution session 内可复用同一个 approval session，以保留上下文并尽量命中 prompt prefix cache
      - 新的一次 task/cron 运行必须重新从最新主聊天上下文 fork
      - 超过最大年龄窗口（当前先定 24h）也强制重新 fork，避免陈旧上下文长期存活
    - approval session 使用专用 system prompt 分支：
      - 明确该会话只用于 delegated approval review，不继续执行任务本身
      - 默认工具集固定为只读调查工具 + `review_permission_request`
      - approve / deny 都必须带简短 `reason`
      - 如果模型把 `review_permission_request` 的参数写错（如字段缺失、schema 不匹配），这类错误必须作为 **recoverable tool error** 返回给模型自行修正，而不是升级成 internal runtime error
      - `tool not found` / `invalid tool args` 这类模型层调用错误，统一视为可恢复的工具调用错误，不视为 runtime / implementation bug
    - 每次新的 delegated approval request 都应附带同一 run 最近少量审批结果摘要，帮助主Agent快速参考既往判断
    - 审批完成后：
      - 只更新 `approval_ledger` / `agent_permission_grants`
      - 唤醒原来的等待 run
      - 默认不把审批过程和结论写回主聊天 session
    - 如用户后续询问，主Agent可通过受控查询能力读取审批历史，而不是依赖主聊天 transcript 记住这件事

### 3.4 Secret管理与宿主进程职责

- [x] Secret管理
  - **系统级 secret**（LLM API key、飞书 app secret 等）：
    - 与普通配置分开存放在 `~/.pokeclaw/system/secrets.toml`；`~/.pokeclaw/system/config.toml` 和 SQLite 只保存非敏感字段与 `*_ref` 引用
    - 真正不可透露的通常只是少数字段，不把整个 provider/channel 对象当作 secret
    - **不放入 process.env**：主进程按需 resolve secret，作为参数传给 SDK（pi-ai 等），主进程的长期 `process.env` 中不存在这些值
    - **环境变量黑名单过滤（defense-in-depth）**：spawn bash 子进程时过滤已知危险模式（`*_API_KEY`、`*_SECRET_KEY`、`ANTHROPIC_*`、`OPENAI_*` 等），防止万一有值意外进入 env（参考 OpenClaw sanitizeHostExecEnv）
    - **denyRead 配置与 secret 文件**：sandbox 阻止 agent 的 bash 命令读取 `~/.pokeclaw/system/config.toml`、`~/.pokeclaw/system/secrets.toml` 等敏感文件
    - 不做 Credential Proxy（单机单用户，不需要 NanoClaw 的容器级隔离）
    - 不做加密存储（同用户本地文件无法形成真正强边界；核心边界是 sandbox / mount / tool permission / host runtime 代理调用）
  - Skill/Tool 代码运行在主进程（sandbox 外），通过 host runtime 读取 secret 后代替 agent 调用 API，agent 只看到 provider/channel id 和调用结果，无需暴露原始 secret
    - **CLI credentials**（aws、git 等用户主动启用的）：接受 agent 可访问的风险，与所有竞品一致
    - 多数 CLI 工具同时支持 env 变量和配置文件（如 `~/.aws/credentials`、`~/.config/gh/hosts.yml`）
    - env 变量被黑名单过滤后，工具仍可通过配置文件正常工作
    - 用户的其他配置文件不在 denyRead 范围内
  - 不做 per-subagent secret scoping，全局统一管理

- **Schema / prompt text field limits**
  - 对 `reason`、`justification` 等模型生成的自由文本字段，不要随意加入未经产品确认的硬编码长度上限
  - 只有存在真实外部协议限制、存储约束、UI 限制、或明确产品要求时，才允许加入 hard limit
  - 否则宁可只保留最小语义约束（如 `minLength` / 非空），避免把真实运行中的模型输出误判为系统内部错误

### 3.5 Normal-turn System Prompt 架构

- [x] 系统提示词采用**section builder** 架构，而不是继续维护一个不断膨胀的单一大字符串
  - 参考 `openclaw`：system prompt 按 `Tooling / Tool Call Style / Safety / Skills / Memory / Workspace / Sandbox / Messaging / Voice / Runtime` 等 section 构造，结构稳定且易测试
  - 参考 `zeroclaw`：保持更轻的 `Tools / Your Task / Safety / Skills / Workspace / Project Context / Current Date & Time / Runtime / Channel Capabilities` 分段
  - 参考 `nanobot`：强调 `Identity / Runtime / Workspace / Platform Policy / Guidelines / Bootstrap Files / Memory / Skills` 作为固定骨架
- [x] Pokeclaw 当前结论
  - **先固定结构，再逐步填内容**
  - 系统提示词的长期目标不是一次写满，而是先建立稳定 section 顺序，未来每个能力成熟后再填入对应段落
  - 新内容应通过单独 section builder 扩展，而不是直接在现有 prompt 字符串底部继续追加
- [x] 当前已落地 section（已注入 normal-turn system prompt）
  - `Identity`
  - `Operating Model`
  - `Tool Usage`
  - `Permissions`
  - `Bash Full Access`
  - `Safety`
- [x] 当前已明确但暂不填充的 section（builder 先返回空字符串，待后续补内容）
  - `Workspace & Runtime`
  - `Project Context`
  - `Memory`
  - `Skills`
  - `Subagents / Task Agents / Cron / Channel Capabilities`
- [x] 当前 prompt 内容重点
  - 先把这轮刚完成的权限模型讲清楚：
    - 结构化工具遇到 `<permission_block>` 后，agent 先判断合法性与必要性，再决定是否调用 `request_permissions`
    - `retryToolCallId` 的使用时机
    - `bash` sandbox 失败后，不走 `request_permissions`，而是按需改用 `sandboxMode="full_access"`
    - `bash` reusable prefix 只适用于**单个简单命令**
    - 复杂 shell 命令只允许 one-shot full access，不进入长期 prefix grant
    - 明确禁止依赖裸后台语法（`&` / `nohup` / `setsid` / `disown`）
- [x] 后续补充原则
  - **有真实运行时能力，才补对应 prompt section**；不要为了“显得完整”提前写半成品规则
  - `Workspace & Runtime`：等 workspace 注入、runtime metadata、model/runtime identity 更稳定后再补
  - `Project Context`：等 bootstrap files / AGENTS / project context 注入路径确定后再补
  - `Memory`：等记忆注入方式与 citation 规则定稿后再补
  - `Skills`：等 normal-turn skill injection 方案落地后再补
  - `Subagents / Task Agents / Cron / Channel Capabilities`：等对应运行时和 adapter 语义稳定后再补
- [x] 测试要求
  - system prompt 需要有独立测试，至少锁住：
    - 当前 section 是否存在
    - section 顺序是否稳定
    - 当前关键权限 / bash 规则文案是否存在
    - 尚未实现的 future sections 当前必须为空，不应提前渲染到 prompt 中

### 3.5 无人值守运行的权限策略

- [x] 定时任务的无人值守权限策略
  - 创建时锁定基础权限集（用户确认）
  - 运行时需要额外权限 → 向主Agent申请（不打扰用户）
    - 主Agent在全局策略范围内自主判断，授权或拒绝（可直接决策，不强制先查历史）
    - 超出全局策略的请求 → 主Agent无权授予，通知用户等下次执行
    - 请求异常/可疑 → 主Agent拒绝 + 通知用户
  - 授权记录独立存储（不在主对话流中），主Agent可按需查阅审计
    - 不污染主对话上下文，不干扰用户沟通
    - 出问题时可追溯所有历史授权决策
  - 审计记录策略（最终口径）
    - 仅保留 `approval_ledger` 作为授权审计事实源
    - 主Agent系统提示只告知“可按需查询 `approval_ledger` 历史记录”
    - 查询不是强制前置步骤；LLM可直接 approve/deny
    - 无论是否查询，本次决策都必须写入 `approval_ledger`
  - **提权成功的作用域（TaskAgent/Cron）**：
    - 当前运行实例立即生效（本次run可继续执行）
    - 同时写入其父Agent的 grant 集合（带TTL，可配置永久），供后续该父Agent派生的TaskAgent继承
    - 不作用于其他Agent；全局上限仍受系统安全策略约束
  - 权限不足导致任务失败 → 通过飞书通知用户具体原因，用户补授权后下次自动生效
  - 禁止cron任务执行中创建新的cron任务（防递归）

### 3.6 当前权限存储口径（阶段性结论）

- [x] 当前结论
  - 权限相关 schema 仍处于 **draft**，实现前可按本节结论调整，不受旧草稿字段约束
  - 第一版权限持久化应尽量简洁，只保留当前产品确定会用到的字段
  - grant 只表达“某 agent 当前持有哪些可生效权限”
  - approval 只表达“某次权限请求如何被批准或拒绝”
  - grant 不绑定 `session` / `conversation` / `branch`
  - approval 可绑定发起 `session`，用于阻塞恢复与交互回流
  - 文件系统 scope 第一版只支持两种路径形态：
    - 精确路径：`/abs/path/file-or-dir`
    - 目录子树：`/abs/path/dir/**`
    - 其余 glob（`*.ts`、`a/*/b`、`?`、`[]`）第一版不支持
  - 文件系统权限检查顺序为：路径规范化 -> `hard deny` -> `deny` -> `allow` -> 默认拒绝
  - `hard deny` 来自系统级默认策略/配置，不参与结构化工具审批，也不能被普通 agent grant 打洞
  - `~/.pokeclaw/system/**` 对普通 `fs.read/fs.write` 与 sandboxed bash 保持系统区限制；`~/.pokeclaw/workspace/**` 是所有 agent 默认可读写的工作区
  - `~/.pokeclaw/system/pokeclaw.db` 虽位于系统区，但主Agent可通过单独的 `db.read` / 后续可能的 `db.write` 能力访问系统状态；这不是对 fs `hard deny` 的例外放开，而是另一类受控能力
- [x] grant 最小口径
  - `owner_agent_id`
  - `scope_json`
  - `granted_by`：仅 `user | main_agent`
  - `created_at`
  - `expires_at`：可空；空表示长期有效
  - `source_approval_id`：可空；用于把审批记录和 grant 关联起来
  - `scope_json` 当前采用原子 scope；每条 grant 只保存一个 scope，例如：
    - `{"kind":"fs.read","path":"/Users/daniel/.pokeclaw/workspace/**"}`
    - `{"kind":"fs.write","path":"/Users/daniel/project/README.md"}`
    - `{"kind":"db.read","database":"system"}`
    - `{"kind":"bash.full_access","prefix":["git","push"]}`
- [x] approval 最小口径
  - `owner_agent_id`
  - `requested_by_session_id`
  - `requested_scope_json`
  - `approval_target`：`user | main_agent`
  - `status`：至少覆盖 `pending | approved | denied | cancelled`
  - `reason_text`
  - `created_at`
  - `decided_at`
  - `requested_scope_json` 可一次包含多个原子 scope，例如：
    - `{"scopes":[{"kind":"fs.write","path":"/Users/daniel/.pokeclaw/workspace/**"},{"kind":"db.read","database":"system"}]}`
    - `{"scopes":[{"kind":"bash.full_access","prefix":["python","-m","agent_browser_cli"]}]}`
- [x] 当前不先做的复杂度
  - grant 级 `granted_by_id`
  - grant 级 `conversation_id` / `branch_id`
  - 显式一次性 grant
  - 复杂 revoke 审计字段
  - 多套并存的“初始权限 + 增量权限”存储模型

## 4. 编排层：Agent生命周期与调度 `DONE`

> 本节主要定义长期运行形态：主Agent如何常驻、SubAgent/TaskAgent 如何建模、记忆如何共享、运行中状态如何观测。

### 4.1 主Agent保活与消息处理

- [x] 主Agent保活机制
  - 单进程架构，不需要单独的守护进程
  - **进程级保活**：systemd/pm2 `Restart=always`，崩溃后自动重启
  - **内部watchdog**：定时自检（如每30秒），agent循环卡死则 `process.exit(1)` 让systemd重启
  - **系统命令**：`/status`, `/stop`, `/restart`, `/help` 在HTTP webhook handler层直接处理，不经过agent管道
    - Node.js事件循环是异步的，即使agent在等LLM响应，HTTP请求仍可处理
    - 这些命令在飞书bot创建时预配置
    - **`/stop` 为最高优先级抢占命令**：当前默认产品语义为作用于当前conversation的全部运行单元（前台回复 + 后台TaskAgent/Cron run + 进行中的tool call）
    - 但实现上不应把 `/stop` 写死为 conversation-only；router/orchestration 应按 `target_scope` 封装，便于未来扩展到 `thread / branch / session / task_run`
    - 执行`/stop`时立即触发conversation级取消并清理：停止重试队列、终止子进程树、将相关任务卡片更新为`stopped`终态
  - **重启后恢复**：检查消息cursor，告知用户"有N条未读消息，需要处理吗？"由用户决定
  - **LLM API故障**：重试（指数退避），失败后通知用户"AI服务异常，消息已记录，恢复后处理"，后台持续重试
  - 关键状态全部持久化（SubAgent注册表、定时任务、消息cursor、授权记录），不依赖内存
- [x] 主Agent资源限制（保持响应性）
  - bash等tool call最多10秒超时（可配置）
  - 单轮约10次tool call（软限制）：到达后在tool result中插入系统提示，引导agent考虑开SubAgent
  - 用户发新消息（steering插队）时计数器归零
  - 复杂/长时间任务委托SubAgent
  - **SubAgent不设 tool call 次数限制**：SubAgent本来就是干重活的，实际任务可能需要大量 tool call，靠打断机制（Section 8）兜底安全
- [x] 消息处理模型：默认使用steering（插队）模式
  - 用户在agent处理期间发新消息 → 在tool call间隙注入上下文
  - agent自行判断如何处理（纠正方向 / 记下稍后处理）
  - 不用followUp（排队等当前轮结束），因为聊天场景用户期望被立即"听到"
  - pi-mono框架已内置steering/followUp两种队列，直接使用steering
  - **轻量确认（与steering配合，框架层零延迟）**：
    - Reaction：消息到达后框架立即给用户消息加emoji reaction（如👀），确认系统收到，不产生新消息
    - Typing indicator：agent处理期间保持typing状态
    - 有reaction = 系统收到了，有typing = 正在处理，都没有 = 系统可能挂了
    - **不做"Busy自动回复"**：会与steering冲突——steering下消息已被注入处理流，再回复"我正忙"既矛盾又误导

### 4.2 Agent体系与通信

- [x] SubAgent创建、通信、销毁
  - **创建入口**：主Agent调用 `create_subagent` 专用工具，提交：
    - `title`
    - `description`
    - `initialTask`
    - `cwd?`
    - `initialExtraScopes?`
  - **创建语义**：
    - 该 tool 是“提交创建请求”，**不是阻塞等待创建完成**
    - tool 在基础参数校验、来源 session 校验、基础权限校验通过后，立即返回 `pending_confirmation`
    - 主Agent当前 run 必须结束，不能为了等用户点击确认卡片而长期挂起
    - 原因：IM 场景下用户可能无视卡片、继续发新消息；主Agent必须持续可交互，不能留下悬挂 tool call / run
  - **确认与真正创建**：
    - 后续是否需要用户确认、用卡片还是文本确认、更新原卡片还是发新消息，**都由 channel adapter 决定**
    - orchestration 只持久化一条 pending 创建请求，并推进状态机
    - 用户确认后，系统再继续真正创建 SubAgent 对话面
    - 真正 provision 外部聊天面的技术调用可以同步执行，但这是确认之后的后续流程，不属于主Agent tool call 的等待期
  - **平台抽象**：
    - orchestration 不直接“创建飞书群”
    - 内部只表达“为这个 SubAgent provision 一个独立 conversation surface”
    - 当前飞书可映射为两人群；后续其他 IM 平台可映射为 group / dm / thread / channel 等等价物
    - 因此内部接口和状态命名必须保持平台无关，不出现 `create_lark_group` 这类平台耦合语义
  - **SubAgent prompt / kickoff 口径**：
    - `title` / `description` / `workdir(cwd)` 属于 SubAgent 的长期身份信息，进入该 SubAgent 的实例级 system prompt
    - `privateWorkspaceDir` 也是 SubAgent 的长期身份信息；即使默认执行目录是外部 repo，也要让 SubAgent 知道自己的私有工作区路径
    - `initialTask` 不进入 system prompt，而是只在创建完成后写入一条 hidden kickoff message
    - 该 kickoff message 的 runtime 角色仍是 `user`，但产品语义上是系统生成的启动消息，不是用户真实发言
  - **通信**：主Agent与SubAgent之间双向通信（通过发送消息工具）
    - 主Agent → SubAgent：转达用户指令、授权回复
    - SubAgent → 主Agent：申请权限、汇报结果
    - SubAgent之间：暂不支持
    - 消息标记来源（主Agent/用户），SubAgent可区分
  - **销毁/归档**：用户主动解散群聊 → SubAgent进入archived状态，权限收回
  - **两类子代理**：
    - **SubAgent**（聊天型）：有飞书群，用户可直接对话，有持久对话上下文
    - **TaskAgent**（后台型）：无飞书群，静默执行任务，结果返回给调用者
  - **TaskAgent（后台执行代理）**：
    - 任何agent（主Agent或SubAgent）都可以创建，目的是**节约上下文 + 并行执行**
    - 调用者构造context传入（任务描述 + 必要上下文），TaskAgent独立执行后向调用者汇报
    - 例：code review SubAgent开3个TaskAgent并行扫描不同文件，汇总后给用户结果
    - **深度限制**：最多两层。第一层=主Agent+SubAgent，第二层=TaskAgent。TaskAgent不能再创建TaskAgent，但同层可开多个并行节点
    - **与定时任务共享运行引擎**：TaskAgent是统一的后台执行单元，定时任务和Agent委派的子任务复用同一套引擎（独立session、卡片进度、提权、打断），差异仅在触发方式和context构造（详见Section 5）
  - 主Agent可读取任意SubAgent的对话历史
- [x] 聊天架构
  - 主Agent与用户：飞书1v1 DM（bot直接对话）
  - SubAgent与用户：各自独立飞书群（因飞书限制两人间只能有一个1v1对话，用群实现多SubAgent各自独立对话窗口）
  - **thread 仍然是聊天上下文，不是 TaskAgent**：
    - 用户在主聊天或群聊里发起的飞书 thread，语义上仍是一条独立对话线，只是有 parent 对话
    - thread 自己有独立上下文历史，但可以按需读取 parent 对话中的后续更新
    - 不把 thread 本身建模为 TaskAgent；TaskAgent 只表示后台执行单元
  - **TaskAgent 永远附着在某个对话中展示和被干预**：
    - 无论是 cron 还是 agent 委派出来的后台任务，都绑定到其发起所在的对话（DM / group / thread）
    - 同一个运行中的 TaskAgent 在该对话里只占用一张状态卡片，后续只更新这张卡片，不重复发消息打扰用户
  - **任务干预的默认交互规则**：
    - 任务既可在主聊天（DM / group 主线）发起，也可在 thread 中直接发起，不强制用户切换入口
    - 如果任务发起于主聊天，默认推荐用户针对任务卡片发起一个 thread，再在该 thread 中干预任务
    - 如果任务本来就发起于某个 thread，任务状态卡片直接发在当前 thread，不再创建子 thread
    - **关键路由规则**：普通thread内的普通消息默认属于thread对话流；任务绑定thread内的普通消息默认路由到该绑定TaskAgent
    - 在普通thread中，用户只有在**显式回复/引用任务卡片**（或点击任务卡片按钮）时，消息才路由到对应TaskAgent

### 4.3 记忆共享

- [x] 主Agent与SubAgent的记忆共享
  - **三层记忆模型**：
    - **Layer 1 全局设定（静态）**：名字、说话风格、用户背景。极少更新，用户手动修改。系统提示始终注入
    - **Layer 2 全局共享记忆（受控动态）**：用户环境、偏好、跨agent有用的知识。系统提示始终注入
      - Agent不主动写入全局记忆，避免多agent随意写导致内容杂乱、重复、冲突
      - 更新来源仅三个：用户明确要求记住 / 对话压缩时系统提炼 / 每日系统提炼任务
      - 每日提炼（凌晨系统定时任务）：扫描所有agent当天新增的个人记忆和对话，去重整合后写入全局记忆
    - **Layer 3 Agent个人记忆（per-agent）**：任务相关知识，agent自己通过工具维护。系统提示始终注入
  - **对话历史**（不是记忆）：可压缩截断，压缩前自动提炼重要信息到个人记忆（参考OpenClaw/Nanobot）
  - **访问权限**：
    - 全局设定 + 全局共享记忆：所有agent可读
    - Agent个人记忆：该agent自己 + 主Agent可读
    - SubAgent不能直接读其他SubAgent的个人记忆

### 4.4 运行时可观测性基础设施

> 本节定义框架层的状态采集与查询基础设施。状态如何渲染给用户（飞书卡片样式、更新频率等）见 Section 8。

- [x] LiveState 运行时状态注册表
  - 单进程架构下，仍保留内存 LiveState，专门承接**易丢失、运行中才有价值**的实时诊断信息
  - 框架在agent loop关键点自动更新（发LLM请求、收到delta、开始/结束tool call、bash收到输出），agent本身无感知
  - LiveState 第一版重点放：
    - LLM最近一次delta时间、是否仍在持续输出、少量输出尾部
    - 当前活跃tool / bash命令
    - bash的stdoutTail / stderrTail（最后N行）
    - 最近输出时间、已运行时长
  - **第一版不把bash实时输出chunk落SQLite**
    - 这是运行中诊断信息，不是durable事实
    - 进程重启后不承诺恢复live tail；最终bash结果仍按普通tool result进入消息/历史持久化
  - approval“等待多久”这类值不做冗余持久化，只保留时间锚点，查询时现算
- [x] SQLite 里的可查询状态快照
  - 可观测性不能只靠内存；需要一层**面向查询的durable当前态**
  - 继续复用现有事实表：
    - `sessions`
    - `task_runs`
    - `messages`
    - `approval_ledger`
  - 另增一张轻量 `runtime_status_snapshots`，专门存“当前可回答用户问题的状态快照”，而不是把高频状态字段散落写回多张业务事实表
  - 第一版建议快照字段只放高价值时间锚点和状态字段，例如：
    - `current_state`
    - `current_summary`
    - `needs_user_action`
    - `waiting_reason`
    - `active_approval_id`
    - `current_tool_name`
    - `current_bash_command`
    - `last_activity_at`
    - `last_output_at`
    - `llm_started_at`
    - `llm_first_token_at`
    - `llm_last_delta_at`
    - `last_error_summary`
    - `stalled_flag`
- [x] 状态查询渠道
  - `/status` 系统命令：webhook handler层直接处理，读 `runtime_status_snapshots` + 内存LiveState，不经过agent管道
  - 主Agent不把整套状态查询规则常驻在system prompt里，而是通过一个内置**系统观测/巡检 skill**按需加载
    - 该skill先提供目录级能力说明，再按需下钻到查询路径、判断规则、证据来源
    - 第一版数据访问优先复用受控 `db.read`（system DB）和少量runtime helper，而不是堆很多专用状态工具
  - 飞书卡片实时更新：框架定期从LiveState读取并刷新卡片（渲染细节见Section 8）
- [x] 主Agent对SubAgent的深度诊断
  - `runtime_status_snapshots` → “现在大体在干什么”（当前state、是否等待用户、最近活动时间、是否疑似卡住）
  - LiveState → “运行中细节”（LLM最近delta、bash最近输出tail）
  - SQLite历史事实 → “之前做过什么”（消息、最终tool result、审批记录）
  - 第一版优先回答用户真正关心的几类问题：
    - 谁在跑、谁在等我、谁有问题
    - 某个任务当前在做什么、最近是否还有进展、卡在哪里
    - 为什么要批权限、为什么刚才失败、bash最终报了什么错

### 4.5 运营配置

- [x] 每日摘要（内置默认定时任务）
  - 每天固定时间（默认早上8点）推送：昨日事件回顾 + 今日待办 + 成本消耗
  - 用户可配置时间或关闭
  - 用户也可随时主动询问"昨天都干了啥"
- [x] 主Agent可修改的运营配置（vs不可修改的安全配置）
  - 可修改：预算上限、通知偏好、定时任务时间等（用户对话即可调整，无需碰配置文件）
  - 不可修改：安全策略（文件系统黑名单、网络黑名单、全局最大权限集）

## 5. 定时任务引擎 `DONE`

> 本节只回答定时任务系统本身的问题：
> - 如何调度
> - 如何执行
> - 失败和提权怎么处理
> - 用户最终在对话里看到什么

### 5.1 调度模型与时间语义

- [x] 调度库选型
  - `croner`（npm）用于cron表达式解析，支持时区、秒级精度，OpenClaw已验证
  - `at`（一次性）和 `every`（间隔）用简单时间戳算术处理，不需要库
  - 三种调度类型：`at` / `every` / `cron`
  - 第一版采用**分钟级轻量 scanner**
    - 每分钟扫描一次 `enabled && next_run_at <= now` 的 job
    - scanner 只负责发现 due job、原子 claim、异步 kickoff，不等待任务执行完成
    - 不做 mutation-triggered rescan；`add / update / remove / pause / resume` 只改 DB，由下一轮 scanner 自然接管
    - `force run` 不走 scheduler，直接走手动触发入口
  - **重启/离线错过触发时间的口径**
    - 已经过去的 missed run 默认**不自动补跑**
    - 重启后调度器只恢复未来调度，不追补历史槽位
    - 后续可以补一个产品提示：系统恢复后主动告诉用户“有N个定时任务错过了”，并让用户决定是否现在手动执行
    - 这条提醒是后续产品增强，不阻塞当前主干实现；当前阶段只需要把 missed 情况记录清楚即可

### 5.2 TaskAgent统一执行引擎

- [x] 执行方式：TaskAgent统一引擎
  - 定时任务与Agent委派子任务共享同一套**TaskAgent执行引擎**
  - 引擎职责：创建独立session → 注入调用者提供的context → 独立执行 → 向调用者汇报 → 提权/卡片/打断
  - **引擎本身不关心触发方式**，只管执行：
    - CronService调用：注入所属 agent 的主线上下文 + 最近运行摘要 + cron 任务定义 → 定时任务
    - 手动 `run(job)`：复用同一条 cron kickoff 路径，只是 `trigger_kind = manual`
    - 任意Agent调用：注入任务描述 + 必要上下文 → 委派子任务
  - 定时任务**不在主对话线中执行**，避免阻塞用户对话和上下文污染
  - 触发时从目标SubAgent的session fork一份独立session
    - 继承：权限配置、sandbox配置、个人记忆（Layer 3）
    - 独立：自己的对话线、工具调用、LLM请求
  - Cron任务的context构造：
    1. 系统提示（角色 + 记忆 + 权限 + "你正在后台执行定时任务，中间少说，最后完整交付结果"）
    2. 所属 agent 主对话线的必要上下文（按现有 task execution 路径继承）
    3. 最近一次运行摘要；如果最近一次失败，再补最近一次成功摘要
    4. Cron 任务定义文本（创建时写下的自由文本说明，不强制 JSON/schema）
  - Cron任务定义的写法口径：
    - 目标是“未来再次看到这段话时，agent 能独立明白为什么收到它、现在该做什么、怎么做、何时算完成”
    - 给内容建议，但不强制固定字段或 JSON 结构
  - Cron运行时输出口径：
    - 默认按后台 worker 模式工作，不把中间自然语言过程当作主要交付物
    - 中间文本尽量少，优先直接做事、调工具、推进执行
    - 最终结果必须是**完整、可单独发给用户**的总结；不能假设用户看过中间过程
  - 与主session并行执行，互不阻塞
  - 飞书群共享：主session接收用户消息正常对话，TaskAgent通过卡片展示进度、最终结果发新消息
  - 执行完毕后：关键信息写入agent个人记忆（供下次cron使用），结果摘要可注入主对话历史
  - 上下文连续性通过agent个人记忆（Layer 3）实现，而非共享对话历史

### 5.3 任务创建与管理接口

- [x] 任务创建与管理
  - Agent通过专用cron tool创建/管理（list / add / update / remove / run）
  - 用户通过自然语言对话创建（"每天早上8点review PR"），agent理解后调用tool
  - 创建/更新时写入的是一段**自由文本任务定义**
    - 默认保存在 `cron_jobs.payload_json` 中，但当前语义上它是 opaque text，不应把它当成刚性 JSON schema
    - tool 只提供内容点 guidance，不强制字段格式
  - **归属解析规则**
    - `cron_job.owner_agent_id` 只能绑定长期 agent：`main` 或某个 `sub`
    - `cron_job.target_conversation_id` = owner agent 的主对话面（主DM / SubAgent群）
    - `cron_job.target_branch_id` = owner agent 主对话面的 main branch
    - cron job 不绑定 TaskAgent、approval session、临时 thread
  - **第一版权限边界**
    - `add / update / remove` 先限制为 owner 自己操作自己的 job
    - 主Agent第一版只做管理动作：查看、观测、手动运行、暂停/恢复
    - 先不支持主Agent直接替某个已有 SubAgent 创建 cron job，避免在缺少该 SubAgent 当前上下文的情况下写入错误的长期任务定义
  - 支持手动触发（force run）
    - 手动触发不是修改 `next_run_at`，而是直接创建一次新的 `task_run`
    - 自动触发与手动触发共用同一条执行主链；区别只体现在触发来源元信息（如 `trigger_kind = scheduled | manual`）
    - 手动触发默认不改变原有 schedule，对后续自动调度无副作用
    - 主Agent和SubAgent都可发起手动触发，但真正执行仍按该 job 的归属 agent 上下文运行

### 5.4 失败处理、重试与禁用策略

- [x] 错误处理与重试
  - **并发防护**：`runningAtMs` 互斥标记，同一job不会并发执行
    - scanner claim / 手动 `run(job)` 都必须复用同一套互斥检查
    - lazy检查：超过2小时的runningAtMs标记自动清除（防crash后永久锁死）
  - **重试策略**（参考ZeroClaw模式）：
    - 权限/安全策略错误 → 不盲目重试，进入提权流程（见下方）
    - 其他所有错误 → 重试N次，指数退避（如30s → 1m → 5m），带jitter
  - **退避与周期冲突**：nextRunAtMs = max(正常下次调度时间, 结束时间 + 退避时间)，防止退避和下一周期重叠
  - **自动禁用策略**：
    - 循环任务（every/cron）：**不自动禁用**，连续失败加退避 + 通知用户，由用户决定是否禁用
    - 一次性任务（at）：重试耗尽后禁用（保留记录供查看）
    - Schedule表达式解析错误：连续3次后自动禁用 + 通知用户（配置问题，继续跑没意义）
  - **错误分类在源头做**：LLM/sandbox层直接标记error.retryable，不做事后正则匹配

### 5.5 提权流程与无人值守约束

- [x] 权限不足时的提权流程
  - SubAgent**先自我评估**（安全第一道防线）：
    - 合理需求（如：任务需要读取某个项目文件）→ 向主Agent申请提权
    - 可疑操作（如：尝试读~/.ssh、访问敏感域名）→ 直接拒绝，记录日志，不向主Agent申请
  - 主Agent评估（第二道防线）：
    - 在全局策略范围内 → 批准，TaskAgent带新权限立即重试
    - 超出全局策略 → 无权授予，通知用户
    - 请求可疑 → 拒绝 + 通知用户
    - `approval_ledger` 为可选参考信息，不是强制查询前置
  - 同一次执行最多提权N次（防止反复试探权限边界）
  - 无人值守权限策略详见Section 3

### 5.6 结果通知、任务卡片与用户干预

- [x] 结果通知与用户操作
  - **任务开始**：飞书群发一张卡片（"定时任务xxx开始执行"）
  - **执行中**：静默更新卡片（进度、当前步骤），不发新消息，不触发通知
  - **重试中**：更新卡片（"第1次执行失败，30秒后重试..."）
  - **最终失败**：新消息通知用户 + 可操作按钮
  - **成功**：新消息发送agent的完整汇报结果
  - **权限失败通知**：展示所需权限 + [授权并立即重试] / [授权，下次执行时生效] / [忽略]
  - **普通错误通知**：展示错误信息 + [立即重试] / [禁用任务]
  - 卡片上提供 [停止执行] 按钮，触发CancellationToken优雅中止
  - **任务卡片与干预入口**：
    - 每个运行中的 TaskAgent 绑定一张状态卡片，作为可观测性的唯一锚点
    - 主聊天中：推荐用户针对该卡片发起 thread，在该 thread 中管理任务干预消息
    - thread 中：任务卡片直接挂在当前 thread，避免嵌套 thread
    - 任务干预以显式目标为准：卡片按钮或引用该任务卡片的消息
  - **用户消息到 TaskAgent 的统一路由原则**：
    - 内部实现采用两段式路由，保持低耦合：
      - **Resolution（事实解析层）**：只解析客观信号，不做路由决策（例如：是否在thread、是否引用任务卡片、是否按钮回调、是否显式`/task`命令、是否存在thread绑定任务）
      - **Policy（决策层）**：基于Resolution产物按固定优先级做最终路由（TaskAgent或普通对话）
    - 路由策略默认**代码化实现**（不做多策略插件系统），后续如需调整，仅修改Policy层规则，不改Resolution解析逻辑
    - 所有路由决策记录结构化日志（signals -> decision），便于排查误路由与后续策略迭代
    - 解析顺序：
      1. 消息是否显式回复/引用了某张任务卡片；若是，则路由到该卡片绑定的 `targetRunId`
      2. 消息是否为任务卡片按钮回调；若是，则路由到按钮携带的 `targetRunId`
      3. 消息是否使用显式命令（如 `/task <id> status|stop|retry`）；若是，则路由到对应 `targetRunId`
      4. 当前消息所在thread是否已绑定某个活跃TaskAgent；若是，则默认路由到该 `targetRunId`
      5. 以上条件都不满足，按普通聊天消息处理
    - 通过显式目标路由，降低误判和用户困惑，同时保持实现可维护性

### 5.7 持久化与系统级定时任务

- [x] 任务持久化：SQLite（详见Section 6）
- [x] 内置系统定时任务
  - **独立于用户cron系统**，用户无感知，不出现在cron job列表中
  - 确定性代码逻辑执行（不经过agent LLM调用），稳定性更高
  - 进程启动时注册定时器，无需持久化job store
  - 系统任务可能需要跨agent访问权限（如记忆提炼扫描所有agent），超出单个SubAgent权限范围
  - 用户可通过对话配置时间或开关（改配置，不是操作cron job）
  - 已确定的系统任务：每日摘要（默认早上8点）、每日记忆提炼（凌晨）
  - 后续可扩展：session清理、成本统计等

## 6. 持久化：存储与记忆 `TODO`

> 本节是后续实现 session、message、task、compaction、runtime event 对齐的核心参考。
> 它既定义存储介质，也定义运行时状态如何落库，以及哪些参考实现应该借、哪些不该借。

### 6.1 存储介质选择与总体原则

- [x] 数据库选择：**SQLite为主 + Markdown文件 + 配置文件**
  - **Markdown文件**：三层记忆（Layer 1/2/3）
    - 用户可直接查看/编辑，agent用文件工具读写，全量注入system prompt
    - 不需要检索——记忆在可控规模时直接注入上下文
  - **JSON/YAML文件**：用户侧配置
    - 用户手动编辑友好
  - **SQLite**：所有其他结构化数据
    - 对话历史、Cron jobs、TaskAgent运行记录、授权日志、SubAgent注册表
    - 优势：schema约束、条件查询、migration规范（`ALTER TABLE`）、FTS5/BM25免费获得
    - WAL模式支持并发读写（TaskAgent并行执行场景）
  - 不做SQLite/PostgreSQL抽象层，MVP就用SQLite（单进程单机架构，不需要PG）
  - ORM选型开发时确定（候选：Prisma、Drizzle、Kysely等，要求TS类型安全、生态成熟）
  - **决策理由**：
    - 竞品中4个有3个用SQLite（OpenClaw、NanoClaw、ZeroClaw），Nanobot纯文件
    - 所有竞品的对话历史用JSONL，但分析后发现JSONL对我们无实质优势：
      - 对话历史是线性追加/读取，SQLite同样高效
      - 需要跨agent查询对话时（主Agent读SubAgent历史），SQL远优于遍历文件
      - JSON/JSONL的migration实际上比SQLite更麻烦（OpenClaw的cron store有7种legacy格式需要处理，靠字段存在性猜版本）
      - SQLite有schema约束，写入时即发现格式错误；JSON无约束，只有运行时才暴露
    - JSONL唯一优势是agent可用grep搜索，但：
      - 记忆（Markdown文件）保留了这个能力
      - 对话历史几乎不需要agent检索（框架负责上下文管理）
      - 需要检索时提供2-3个专用tool（search_memory、get_history等）比grep更可靠
    - 不做PG抽象层：Prisma等ORM虽然支持多后端切换，但FTS5（SQLite）和tsvector（PG）语法完全不同，向量搜索也不通用（sqlite-vec vs pgvector），抽象层无法真正屏蔽差异

### 6.2 记忆、检索与向量搜索取舍

- [x] 记忆系统实现
  - 三层记忆模型已在Section 4确定，存储为Markdown文件
  - 记忆量可控时全量注入system prompt，不需要检索
  - 当记忆增长超过context window时，可利用SQLite FTS5/BM25检索相关片段（后续优化）
  - Agent通过文件工具（read/write/grep）直接操作记忆文件
  - **决策理由**：记忆保留Markdown而非存SQLite，因为用户需要直接查看/编辑，agent需要用标准文件工具操作，且全量注入prompt时Markdown格式最自然

- [x] 向量搜索方案
  - **MVP不做向量搜索**
  - 第一步优化：SQLite FTS5/BM25关键词搜索（零额外成本，内置于SQLite 3.9.0+）
  - 第二步优化：云端embedding API（OpenAI/Gemini等）+ SQLite存储向量，混合搜索（向量+关键词加权融合）
  - 不需要GPU，embedding通过云API调用（竞品OpenClaw和ZeroClaw都是这样做的）
  - 架构上预留，不影响MVP
  - **决策理由**：
    - 4个竞品中只有OpenClaw和ZeroClaw做了向量搜索，NanoClaw和Nanobot完全不做也能正常运行
    - 向量搜索的主要场景是记忆量超出context window时的语义检索，MVP阶段记忆量可控
    - FTS5/BM25作为中间方案已经很强（OpenClaw/ZeroClaw混合搜索默认权重70%向量+30%关键词，说明关键词搜索本身就很有效）
    - 本地embedding模型（如node-llama-cpp跑300M模型）效果一般，云API更实用

### 6.3 结构化数据模型与核心表语义

- [x] Session/Conversation/Agent/Thread/Task 数据模型（DB v1）
  - **边界定义（落库语义）**：
    - `channel_instance` = 接入实例（飞书A、飞书B、钉钉A、企微A）
    - `conversation` = 用户可感知主对话单元（仅 DM / Group）
    - `conversation_branch` = `conversation` 下的实际上下文分支（main / thread / task）
    - `agent` = 长生命周期会话型代理（主Agent/SubAgent）
    - `session` = 可运行、可压缩、可fork的上下文实例
    - `task_run` = 一次后台执行记录（cron/委派/系统任务统一）
  - **关系约束**：
    - `channel_instance 1:n conversation`
    - `conversation 1:1 agent`（强约束，唯一索引保证）
    - `conversation 1:n conversation_branch`
    - `conversation_branch 1:n session`
    - `session 1:n message`
    - `cron_job 1:n task_run`
  - **关键决策**：
    - TaskAgent 不作为长期 `agent` 表实体，避免把“执行实例”做成重对象
    - 所有执行日志统一进 `task_run`，不拆多套 run 表
    - `message` 只挂 `session_id`，不直接挂 `conversation_id`，确保 fork/compaction 不串线
    - 定义一组稳定层级 key（`cha:*` / `<channel_key>:conv:*` / `<conversation_key>:branch:*` / `<conversation_key>:agent:run:*`），用于日志、缓存、事件路由和运行时观测；不替代数据库外键
    - 这些 key 虽然不是 DB 强约束，但视为项目级固定协议；新模块不得自行定义同义格式
    - key 组件内禁止出现 `:`；所有 key 必须可通过 `split(':')` 无歧义解析；原始外部 id 与 key-safe 值分离保存
    - 竞品取舍：借 OpenClaw 的层级可读性，借 NanoClaw 的平台来源语义，保留 NanoBot 的 `channel + chat_id` 唯一性，但不把完整关系图编码进单一 key
  - **MVP最小表集合**：
    - `channel_instances`
    - `conversations`
    - `conversation_branches`
    - `agents`
    - `sessions`
    - `messages`
    - `cron_jobs`
    - `task_runs`
    - `approval_ledger`
  - **最关键索引**：
    - 路由：`conversations(channel_instance_id, external_chat_id)`
    - 上下文读取：`messages(session_id, seq)`
    - 会话管理：`sessions(branch_id, status, updated_at)`
    - 调度：`cron_jobs(enabled, next_run_at)`
    - 停止/观测：`task_runs(conversation_id, status, started_at)` + running/queued局部索引

### 6.4 Context Compaction策略

- [ ] 上下文压缩 / compaction策略
  - 基本形状：沿用 pi/OpenClaw 的 token 预算思路，但存储层采用我们自己的 SQLite session 状态，不复用 pi 的 JSONL entry 体系
  - 触发语义固定：
    - 正常阈值触发：**异步** compaction，不阻塞用户当前聊天
    - 严重上下文超限（overflow）：同步 compact-and-retry，作为兜底恢复路径
  - Session 存储语义固定：
    - `sessions.compact_cursor` = 当前 session 已被摘要覆盖的最高消息序号
    - `sessions.compact_summary` = 从 session 起点累计到 `compact_cursor` 的摘要
    - 构造 LLM 上下文时使用 `compact_summary + seq > compact_cursor` 的原始消息
    - 下一次 compaction 复用上一次 `compact_summary`，不重新总结全历史
  - MVP 不做独立 compaction 历史表；如需排障/审计，先写日志即可
  - 当前最小配置只保留：
    - `reserveTokens`
    - `keepRecentTokens`
    - `reserveTokensFloor`
    - `recentTurnsPreserve`
  - 当前默认策略：
    - 第一版配置值按 200k 窗口、70% 软阈值反推得出
    - 因此第一版默认 `reserveTokens = 60000`
    - 第一版默认 `keepRecentTokens = 40000`
    - 第一版默认 `reserveTokensFloor = 60000`
    - 第一版默认 `recentTurnsPreserve = 3`
    - 运行时不额外引入隐藏窗口 cap；具体触发只服从 `model.contextWindow` 与配置值
  - cut point 规则提前固定：
    - 不在 `toolResult` 上切
    - 优先按 turn 边界切
    - `toolCall` 和对应 `toolResult` 尽量保留在同一侧
  - 模型选择统一走 `models.scenarios.compaction`，不单独引入 `compaction.model`
  - 关键设计点：compaction时自动提炼重要信息到agent个人记忆（Layer 3），与我们的三层记忆模型结合；但这一步可以在 MVP 后补

### 6.5 Runtime事件、channel适配与消息边界

- [ ] Agent runtime边界、事件与渠道适配
  - **runtime 对外只产出 agent 语义事件，不产出 channel 动作**
    - 典型事件：
      - `assistant_message_start`
      - `assistant_message_delta`
      - `assistant_message_end`
      - `tool_call_start`
      - `tool_call_end`
      - `compaction_start`
      - `compaction_end`
      - `approval_requested`
      - `approval_resolved`
      - `turn_start`
      - `turn_end`
      - `run_error`
    - 明确不把 `send_draft`、`update_draft`、`finalize_draft`、`cancel_draft` 这类 channel 动作上升为 runtime 事件
  - **权限/审批事件独立于错误事件**
    - `tool_call_failed` / `run_error` 只表达真正的错误语义
    - 权限不足不应直接编码为一次普通 tool error
    - 更合理的 runtime 语义是：
      - `tool_call_blocked`（或同等含义的内部状态）
      - `approval_requested`
      - `approval_resolved`
      - 审批通过后恢复同一次 tool call
    - 只有最终 deny 时，才把拒绝结果返回给 agent
  - **bash / shell 的语义单独固定**
    - shell 的 `stdout` / `stderr` / `exitCode` 属于 command execution outcome
    - 非 0 退出默认仍然是 tool result，而不是 runtime error
    - 只有来自 sandbox / policy gate 的结构化权限阻塞，才能进入 approval flow
    - 不允许通过 shell 的 stderr 文本去推断审批逻辑
    - 在后台任务管理能力落地前，明显后台化语法（未转义的 `&`、`nohup`、`setsid`、`disown`）直接作为 recoverable tool failure 返回，不交给 sandbox 猜测和处理
  - **channel adapter 负责展示和交互，不污染 runtime 语义**
    - adapter 消费 runtime raw events，并根据平台能力做打包、聚合、节流和降级
    - orchestration/runtime **绝不直接拼接最终的人类展示消息**；它们只产出 raw runtime event，再补少量必要上下文（target、agent、run、task、approval 等）
    - 是否展示、如何展示、是否合并为卡片/线程/补丁、是否降级为纯文本，全部由 adapter 按 channel 能力决定
    - 例：
      - 飞书可将多次 tool call 聚合为同一张卡片的 patch，并展示 typing / streaming
      - 微信可隐藏中间 tool 细节，仅在 turn 结束后统一发送结果
      - 审批请求在飞书可渲染为卡片按钮，在微信可降级为“回复 同意/拒绝”的文本交互
  - **消息流采用两段式边界**
    - Ingress：channel input -> adapter 解析 -> 统一 ingress command -> dispatcher -> session lane
    - Egress：runtime event -> channel adapter 渲染 -> platform action -> channel transport
  - **channel transport 与 agent execution 必须异步解耦**
    - adapter 收到平台事件后，应尽快 ack，再异步提交 ingress command
    - runtime/orchestration 产出 outbound event 后，不应阻塞等待某个 channel 发送完成
    - session run 可以因 approval / cancel / stop 这类业务状态暂停，但不能因飞书/Slack/微信发送链路本身而卡住
  - **运行时与渠道之间的真正契约是：runtime event + ingress command**
    - runtime/orchestration -> adapter 的输出应是：`raw runtime event + 必要业务上下文 + 已决定的逻辑投递目标`
    - 而不是 runtime/orchestration 直接调用渠道 API，也不是 channel 直接操纵 agent loop
    - 更不是 orchestration 先拼一段“给人看的最终消息”再强塞给 adapter；那会把 channel 展示能力错误地上移到 orchestration 层
  - **channel durable state 的抽象边界**
    - 不做“万能 channel 对象大表”
    - 只抽象真正稳定的 conversation-level 绑定
    - 更细的 message/card/callback durable 锚点由各 channel 专属表维护
  - **通用表：`channel_surfaces`**
    - 作用：把内部 `conversation_id + branch_id` 绑定到某个具体 `channel_type + channel_installation_id` 的外部 surface
    - 建议字段：
      - `id`
      - `channel_type`
      - `channel_installation_id`
      - `conversation_id`
      - `branch_id`
      - `surface_key`
      - `surface_object_json`
      - `created_at`
      - `updated_at`
    - 不在通用层展开 `chat_id` / `thread_id` / `topic_id` / `open_id` 等平台字段
    - `surface_key` 是 channel 自定义的 lookup key，用于 inbound 反查；core 不解释其结构，但要求在同一 `channel_type + channel_installation_id` 下唯一
    - `surface_object_json` 的 JSON 结构由各 channel 自己定义并严格维护
  - **所有跨层事件都要带完整上下文**
    - agent/runtime 侧：
      - `session_id`
      - `conversation_id`
      - `branch_id`
      - `run_id`
      - `event_id`
      - `correlation_id`
    - channel/presentation 侧：
      - `channel_installation_id`
      - `external_chat_id`
      - `external_thread_id`
      - `external_message_id`
      - 可选 `render_target`
    - 理由：便于 channel adapter 做 patch、聚合、交互回流、限速、幂等与审计
  - **approval 是 runtime 语义，不是 channel 语义**
    - runtime 只表达“需要批准什么”
    - adapter 决定平台上的具体展示和回流解析方式
    - 用户交互最终统一回流为 ingress command，例如 `approval_response`
  - **session 串行是强约束**
    - 同一 session 的输入处理、tool loop、后台 compaction、approval 回流都必须进入同一条串行 lane
    - 避免上下文、消息顺序和状态写入互相打架
  - **第一版 session lane 可以是单进程内存实现**
    - 当前阶段不需要先做跨进程队列或分布式 bus
    - 这套实现**明确受惠于 Node 单进程事件循环模型**，因此第一版可以不引入显式锁
    - 但正确性不来自“天然没并发”，而来自：同一 session 的 lane 占位与入队必须在第一次 `await` 之前同步完成
    - 不同异步 ingress 仍可能在同一 session 上交错进入，所以必须经过 lane 串行化，而不是直接调 `AgentLoop`
    - lane 负责统一接收 message / approval_response / follow-up control，再决定：
      - 立即启动新 run
      - 进入 steer queue
      - 命中挂起中的 approval wait

### 6.6 竞品 / 参考实现取舍

- [ ] 对竞品/参考实现的明确取舍
  - **pi-mono**
    - 主要借：
      - core loop / `AgentEvent` 语义
      - provider-agnostic message model
      - provider message transform 与 tool call id 修复
      - 基础 overflow 检测
    - 不借：
      - 直接让全项目依赖 pi 的原始类型细节
    - 落地方式：
      - 用它做内核与消息桥接基础
      - 在本地再包一层薄 `pi bridge`
  - **pi-coding-agent**
    - 主要借：
      - compaction cut point 规则
      - session 级事件形状
      - overflow compact-and-retry 的状态机
      - 会话重放和摘要复用思路
    - 不借：
      - JSONL / tree entry 存储结构
      - 它的 SessionManager 持久化模型
    - 落地方式：
      - 借 compaction 语义和事件，不借存储
  - **OpenClaw**
    - 主要借：
      - provider turn 修复与消息转换细节
      - 更成熟的 compaction 保护措施
      - 错误分类与归一化
      - session-lane 串行与 run metadata
      - 内部事件向外部协议桥接的组织方式
    - 不借：
      - 过重的产品层包装
      - 与其自身 gateway/plugin 体系紧耦合的部分
    - 落地方式：
      - 借错误处理、消息转换、桥接方法，不照搬整体架构
  - **ZeroClaw**
    - 主要借：
      - channel adapter 的能力视角
      - tool dispatcher 边界
      - draft / typing / patch 这些展示能力应该留在 adapter 层，而不是 runtime 层
    - 不借：
      - 它较弱的 compaction 方案
      - 直接把 channel 动作当作 runtime 事件
    - 落地方式：
      - 借“channel 是展示/交互适配层”这个抽象，不借其具体平台动作定义

## 内置能力 `DRAFT`

> 本章定义产品直接内置、默认可用、由我们自己维护和产品化的一组核心能力。当前先确定 Web 与浏览器能力，后续可继续补充其他内置能力。

### Web 与浏览器能力

- [ ] 三层能力边界
  - **`web_search`**：只负责找候选结果，不负责正文抓取和网页交互
    - 优先走搜索 API：Brave / Tavily / SearXNG 等
    - 可保留一个免费 fallback（如 DuckDuckGo HTML），但不作为主要方案
  - **`web_fetch`**：只负责轻量网页抓取与正文提取，不执行 JavaScript，不承担真实浏览器职责
    - 实现方式参考 OpenClaw：HTTP fetch + Readability 正文提取
    - 失败时内置 **Firecrawl fallback**
    - Firecrawl 属于 `web_fetch` 工具内部 fallback；是否升级到浏览器由 agent 自己判断，不在 `web_fetch` 内部偷偷切到 browser
  - **`browser`**：负责真实网页交互
    - 登录、复杂前端、JS-heavy 网站、下载上传、截图、PDF、强反爬场景都走 browser
    - browser 与 `web_fetch` 是并列能力，不是它的隐藏降级路径
- [ ] `web_search` 的方案选择
  - MVP 优先使用 API 型 provider（Brave / Tavily / SearXNG）
  - 决策理由：结构化结果稳定、实现简单、比抓搜索结果页更可靠
- [ ] `web_fetch` 的实现原则
  - 不使用简单 `curl` 直出给 agent，而是封装成结构化工具
  - 基础流程：
    1. 校验 URL（仅 http/https；禁止 localhost / 内网 / 私网 / file / data / javascript）
    2. 受控 HTTP GET（超时、重定向上限、大小限制、浏览器风格 UA、可选代理）
    3. 按内容类型解析：
       - `text/html` → Readability 提正文
       - `application/json` → pretty JSON
       - `text/plain` / `text/markdown` → 原样返回
    4. Readability 提取失败时，内置 Firecrawl fallback
  - `web_fetch` 定位是轻量抓取，不承担完整反爬；遇到登录、重 JS、强风控页面时，应升级到 browser
- [ ] 浏览器能力选型：**MVP 直接内置 `agent-browser`**
  - 将 `agent-browser` 作为浏览器执行引擎，而不是从零自研 browser runtime
  - 当前已覆盖我们需要的大部分能力：
    - open / snapshot / click / fill / select / wait
    - screenshot / pdf / download
    - cookies / localStorage / state save-load
    - headed 模式
    - `--auto-connect` 复用用户已登录的 Chrome
  - 我们自己的系统负责在它外面补齐：
    - agent 生命周期
    - 权限控制
    - 任务卡片可观测性
    - 与对话/TaskAgent 的路由集成
- [ ] 浏览器状态模型：**共享 profile，隔离 session**
  - `profile` = 长期身份与登录态（cookie、localStorage、站点偏好）
  - `session` = 某个 agent 的具体浏览器工作会话（当前 tab、页面历史、临时操作状态）
  - MVP 设计：
    - 所有 agent 默认共享一个 browser profile，符合用户"同一个助理已经登录过"的直觉
    - 不同 agent 使用不同 browser session，彼此隔离，不共享 tab，不互相打断当前页面状态
    - 因此共享的是认证基础，隔离的是运行时会话
- [ ] 浏览器运行模式
  - 默认：无头浏览器
  - 必要时：可切到有 UI 的 headed 模式
  - 需要用户现有登录态时：支持显式接管用户已打开的 Chrome / 导入 state，而不是强制用户重新登录
- [ ] 产品侧的默认策略
  - `web_search`：找结果
  - `web_fetch`：轻量抓正文
  - `browser`：只在确实需要真实网页交互时才启动
  - 一般不要让 agent 一上来就开 browser；优先 search/fetch，复杂站点再升级

## 7. Skill系统 `DONE`

- [x] Skill定位与设计哲学（详见 `pokeclaw/design-docs/what-is-skill.md`）
  - **Skill = 把优秀做法产品化**，不是教agent一个知识点，而是打包一整套可重复执行的工作流
  - Skill是"半个工具 + 半个SOP"：包含步骤、规则、示例、代码/脚本、资源文件
  - 目的：让agent对特定任务做得**稳、准**，像熟练员工一样按标准做事
  - 行业共识：依赖LLM自身能力理解、使用、组合Skill（agent不是显式"调用"skill，而是读取后自由执行）
- [x] Skill格式规范与加载机制
  - **格式**：沿用行业标准 SKILL.md（YAML frontmatter + Markdown内容），与OpenClaw/Nanobot/ZeroClaw兼容
  - **渐进式加载**（行业标准做法，非某一家独有）：
    - Level 1：所有skill的name+description始终注入system prompt（让agent知道有什么能力）
    - Level 2：agent按需读取skill完整内容（通过read_file等工具），获得具体工作流/SOP
    - Level 3：只有在任务真的需要时，再读取长参考资料、schema/query guide、脚本、案例等资源
    - 如果skill有 `.note.md` → Level 1中额外注入note的summary字段，告知agent有定制笔记及位置
  - **依赖检测**：参考OpenClaw的metadata（requires.bins、requires.env等），加载时检查依赖是否满足
- [x] Skill不只是“外部领域能力”，也可以是**内部系统能力**
  - 例如主Agent的“系统观测/巡检”skill：本质上是一套状态查询与解释工作流，而不是一个单独数据库tool
  - 这类skill的目标是让agent先知道“去哪查、按什么顺序查、怎么把证据翻译成用户能懂的话”，而不是把整份系统状态手册常驻注入
- [x] Skill来源与加载路径
  - **产品workspace目录**（`~/.pokeclaw/skills/`）：主加载路径，clawhub等工具通过`--workdir`参数安装到此
  - 内置skill：打包在产品中
  - 竞品现状：每个产品都有自己的workspace skill目录，clawhub通过`--workdir`指定安装位置，不存在跨产品共享的公共skill目录
  - 参考ZeroClaw的open-skills社区仓库自动同步机制（定期从GitHub拉取 + 安全审计后加载）
  - 未来：marketplace / 社区共享（参考OpenClaw的ClawHub）
  - 参考NanoClaw的git branch模式：虽然我们不是Claude Code生态，但"Skill可以交付代码级能力"的思想值得借鉴
- [x] Skill自主安装
  - **内置打包一批基础skill**（参考OpenClaw/Nanobot做法），其中包含一个"skill市场"skill
  - "skill市场"skill教会agent如何在ClawHub等平台搜索、安装、更新skill，并指定安装到 `~/.pokeclaw/skills/`
  - agent有bash权限，按照skill指引执行安装命令即可，不需要专门的安装API
  - 安装后通过watcher自动发现新skill文件（热加载），无需重启
- [x] Skill热加载
  - 参考OpenClaw的chokidar watcher机制：监听skill目录的SKILL.md文件变化，debounce后自动刷新
  - skill安装/更新/删除后无需重启agent
- [x] Skill自我进化（差异化核心特性）
  - **Skill Note（`.note.md`）**：
    - 存放在skill自身目录内（如 `skills/pr-review/.note.md`），隐藏文件，跟随skill位置
    - 无论skill安装在公共目录还是产品目录，note都能就近找到
    - `TODO` 需调研clawhub等工具升级skill时是否会覆盖目录内的隐藏文件，如果会覆盖需要备份策略
  - **Note文件格式**（带frontmatter，与skill格式风格一致）：
    ```
    ---
    skill: pskoett/pr-review
    summary: "团队标准：必须检查安全改动和测试覆盖率，CI用GitHub Actions"
    updated: 2026-03-16
    ---
    ## 额外步骤
    - ...
    ## 项目特定知识
    - ...
    ```
  - **渐进式注入**：
    - Level 1：skill摘要中附带note的summary字段（50字以内），让agent知道有定制笔记
    - Level 2：agent按需read_file读取完整note内容
  - **两个写入来源**：
    - **实时**：用户在对话中明确要求（如"以后review也检查安全"）→ agent立即更新note
    - **每日系统任务**：凌晨系统定时任务在做记忆提炼时，同时扫描各agent当天对话，发现与skill相关的执行模式 → 增量追加到对应skill的note（不覆盖已有内容）
    - 每日系统任务解决agent"懒惰不主动更新"的问题，确保执行经验持续回流
  - **Base + Note分离的优势**：
    - 社区base更新时note不冲突（note是独立隐藏文件）
    - 可删除note一键回退到原版skill
    - 可审计（清楚看到原版 vs 定制内容）
  - **风险防护**：note修改需用户确认（防幻觉式改进）、可删除回退（防skill退化）
  - **参考资源**：
    - ClawHub社区 self-improving-agent skill：https://clawhub.ai/pskoett/self-improving-agent （后续深入参考）
    - Reflexion论文（agent通过反思和记忆迭代改进）
    - Voyager（Microsoft Research，agent在开放环境中学习和复用技能）
- [x] Per-agent skill隔离：**暂不做**
  - 所有agent共享同一个skill池（单用户产品，所有agent服务同一用户）
  - 如需限制特定SubAgent使用某skill，通过system prompt指令约束而非硬隔离
  - 决策理由：隔离带来的复杂度（共享冲突、重复安装、可见性问题）大于收益
- [x] Skill脚本执行方式
  - 竞品（包括ZeroClaw的SkillTool）都**不把skill脚本注册为独立tool**，只是在prompt中描述可用命令，agent通过bash执行
  - 我们同样：skill里的脚本/命令通过bash运行，不需要专门的tool注册机制
  - Skill可在SKILL.md中以结构化方式描述可用命令（参考ZeroClaw的SkillTool格式），但执行方式就是bash

## 8. 中间层：消息适配与渲染 `TODO`

> 基础设施（LiveState、steering、reaction/typing、查询渠道）已在 Section 4 确定。
> 本节只回答一个问题：**runtime 与 channel 如何双向解耦，同时不把平台展示能力污染回 runtime。**

### 8.1 Runtime Event 与 Channel Adapter 的边界

- [ ] Agent输出 → Channel消息的适配架构
  - **唯一正确的边界**：
    - runtime 只产出 **agent 强相关、channel 无关** 的原始事件
    - channel adapter 消费这些原始事件，并根据各自平台能力决定如何展示
    - transport 只负责真正调用平台 API
  - **runtime 事件的典型语义**：
    - `assistant_message_start`
    - `assistant_message_delta`
    - `assistant_message_end`
    - `tool_call_start`
    - `tool_call_end`
    - `tool_call_blocked`（权限/审批链路）
    - `compaction_start`
    - `compaction_end`
    - `approval_requested`
    - `approval_resolved`
    - `task_run_started`
    - `task_run_completed`
    - `task_run_failed`
    - `task_run_cancelled`
    - `turn_start`
    - `turn_end`
    - `run_error`
  - **权限与错误严格区分**
    - tool error 只表示：
      - tool 自己显式声明的可恢复业务失败
      - runtime / implementation internal error
    - 权限不足不属于这里
    - 权限不足要进入 approval / resume 链路，并最终通过 channel adapter 触达用户
  - **明确禁止的错误抽象**：
    - 不让 runtime 直接输出 `send_draft` / `update_draft` / `finalize_draft` / `cancel_draft`
    - 不让 runtime 直接调用飞书、微信等 channel API
    - 不让 channel 直接操纵 agent loop 内部状态
  - **channel adapter 的职责**：
    - 入站：把平台消息、thread 回复、按钮回调等翻译成统一 ingress command
    - 出站：消费 runtime raw events，自行决定是否展示、如何聚合、如何降级
    - 节流：控制 patch / update 频率
    - 幂等：避免重复发送、重复 patch
    - durable 锚点管理：维护平台消息/card/thread 与内部对象的绑定
  - **设计目标**：
    - runtime 保持纯语义
    - channel adapter 保持平台感知
    - transport 保持 API 感知
    - 三层不混用
  - **当前结论**
    - 现在不再增加额外“消息中间模型”抽象层
    - 直接使用 `runtime event-bus + channel adapter`
    - 入站走统一 ingress command，出站走 runtime raw events

### 8.2 实时过程反馈与平台差异化展示

- [ ] 实时过程反馈的渲染
  - **不是所有平台都要展示同样的过程**
    - 飞书可以充分展示中间态：tool 进度、assistant streaming、typing、卡片 patch
    - 微信等弱交互平台可以选择只展示最终结果，或只展示少量关键中间态
  - **同一组 runtime 事件，不同平台允许有完全不同的展示策略**
    - 飞书例子：
      - 多个连续 tool call 可汇总到同一张卡片中 patch 更新
      - assistant delta 可做流式文本更新
      - approval 可展示为卡片按钮
    - 微信例子：
      - tool call 细节可完全不展示
      - assistant delta 先缓存，turn 结束后一次性发送
      - approval 可退化为“回复 同意 / 拒绝”
  - **因此本节的核心不是定义飞书 UI，而是定义“允许各 channel 自己消费同一组事实事件”**
  - 飞书卡片实时更新仍然是首要实现目标：
    - 将 LiveState（Section 4）和 runtime events 渲染为卡片
    - 当前 tool call
    - assistant 输出增量
    - 耗时、tokens、成本
  - 更新频率、卡片样式、信息密度留给具体 channel adapter 决定
  - 每个 turn 结束后附上消耗数据（tokens / 费用）
  - 不在本层定义 `patch` / `append` / `reply_in_thread` 之类展示动作
    - 这些都属于 platform capability，不属于 runtime 事实

### 8.3 打断、停止与终态回写

- [x] 打断机制
  - `/stop` 指令中断当前conversation下的一切执行（前台回复 + SubAgent/TaskAgent + Cron run + tool call）
  - `/stop` 为最高优先级，命令到达后先执行取消，再处理其他消息
  - **AbortController贯穿全链路**：agent loop → LLM请求 → tool执行，都传入同一个AbortSignal（Node.js标准机制，所有竞品均采用）
  - **两阶段终止**：
    - LLM streaming卡住：AbortSignal取消stream读取，客户端立即停止等待（服务端请求无法取消，HTTP协议限制，所有竞品一样）
    - Bash命令卡住：SIGTERM给进程树 → 可配置grace period（默认3秒）→ SIGKILL强杀（参考OpenClaw kill-tree实现）
    - 进程树级别kill（`-pid`负号），防止子进程逃逸
  - 取消完成后向飞书回写统一停止态（卡片terminal: stopped + 简要原因）

### 8.4 成本追踪与用户可见性

- [x] 成本追踪与展示
  - **采集**：pi-ai的LLM响应自带token usage（input/output/cache），按turn粒度记录到SQLite
    - 字段：agent_id、model、input_tokens、output_tokens、cached_tokens、cost、timestamp
    - 只追踪LLM token成本，不追踪第三方API成本
  - **费用计算**：可配置的模型价格表（不硬编码，厂商经常调价），cache hit按折扣价计算
  - **Per-agent计费**：天然支持——每条turn记录带agent_id，按需聚合即可
  - **预算**：用户设定月度预算，达到阈值时通知一次（同一周期不重复报警），**不硬性停止服务**
  - **展示**：每日摘要包含当日总成本（Section 4.5已确定），用户可随时询问成本明细，每个turn结束附上消耗（渲染细节待飞书API确定）

### 8.5 富交互不可用时的降级策略

- [ ] 降级策略（富交互不可用时的fallback）
  - channel adapter 必须从一开始就支持降级，而不是把飞书能力误当成系统能力
  - 最少要考虑三类退化：
    - **无 streaming**：缓存 delta，最终一次性发送
    - **无 patch / card update**：改为发送新消息，或仅更新本地状态不更新 UI
    - **无按钮交互**：退化为文字命令或文字确认回复
  - approval、任务卡片、tool 进度这三类交互都必须有降级路径
  - 降级是 adapter 责任，不是 runtime 责任

### 8.6 Channel Durable State 的边界

- [ ] channel durable state 设计
  - **只抽象真正稳定的 conversation-level 绑定**
    - 通用表：`channel_surfaces`
    - 作用：把内部 `conversation_id + branch_id` 绑定到某个具体 `channel_type + channel_installation_id` 的外部 surface
  - **建议字段**
    - `id`
    - `channel_type`
    - `channel_installation_id`
    - `conversation_id`
    - `branch_id`
    - `surface_key`
    - `surface_object_json`
    - `created_at`
    - `updated_at`
  - **明确约束**
    - 不在通用层展开 `chat_id` / `thread_id` / `topic_id` / `open_id` 等平台字段
    - `surface_key` 只作为 channel 自定义 lookup key；通用层不解析其内部结构
    - `surface_object_json` 的 JSON schema 由各 channel 自己定义并严格维护
    - 不做“万能 channel 对象大表”
  - **更细的 durable 锚点**
    - `message/card/callback/thread-reply-anchor` 这类平台差异极大的对象，默认由各 channel 专属表维护
    - 是否持久化、存哪些字段、如何恢复，由各 channel 自己决定

## 9. Channel层：飞书集成 `TODO`

> 飞书是第一个真实工作 channel。Section 8 说的是通用边界；本节说的是“飞书具体要做到什么”。

### 9.1 SDK、本地 client 与模块边界

- [ ] 飞书SDK / API选型
  - 包装成本地 client，不把 SDK 细节扩散到业务层
  - inbound / outbound / cards / threads / reactions / typing 分模块实现
  - 模块边界建议：
    - `client.ts`：Lark SDK 包装
    - `inbound.ts`：webhook / ws 消息与 callback 解析
    - `outbound.ts`：消费 runtime event-bus，发文本/卡片/patch
    - `cards.ts` / `cardkit.ts`：飞书卡片与流式更新封装
    - `threads.ts`：thread 回复与 target 解析
    - `typing.ts` / `reactions.ts`：能力补充
  - 当前已落地的第一版边界：
    - `client.ts` 只负责 installation 级 SDK client 管理
    - `channel.ts` 负责飞书 channel runtime 的启动/关闭与模块装配
    - `inbound.ts` 负责 websocket 普通消息接收、解析与路由
    - `outbound.ts` 负责消费 runtime event-bus，并维护飞书侧的运行中卡片状态与发送节流
  - 当前阶段只实现普通文本消息的 websocket 入站；webhook、callback、thread 解析后续补

### 9.2 富交互能力与审批展示

- [ ] 富交互实现（卡片、按钮、审批流、实时更新）
  - 飞书是首个会充分利用强交互能力的平台
  - 重点包括：
    - 卡片按钮回调
    - 卡片 patch / 流式更新
    - typing / reaction
    - approval 的按钮化交互
  - 但这些都属于 **adapter + transport** 的实现，不回流污染 runtime 事件定义
  - 参考结论：
    - thread 回复本质上仍然依赖 `message_id + reply_in_thread`
    - CardKit 流式更新依赖 `card_id + element_id + sequence`
    - 因此这些 durable 锚点不应提前抽象成通用表
  - 当前阶段的飞书 outbound 选择：
    - 不做 “raw event -> 直接 patch 某张旧卡” 的 if/else 逻辑
    - 先维护一份结构化的 `LarkRunState`
    - 再把 `LarkRunState` 渲染成飞书 CardKit card json
    - 最后由发送层做 coalesce / 节流 / create / update / element streaming
  - 当前 `LarkRunState` 的产品语义：
    - 主 transcript 按真实时序渲染：`text -> tool -> text -> ...`
    - `assistant` 文本直接展示，不折叠
    - `reasoning` 统一放在顶部折叠区，不打散到 transcript 中
    - `tool` 按连续序列聚合；序列 `<=2` 保持平铺，序列 `>2` 在结束后折叠为外层组，组内每个 tool 仍可查看详情
    - footer 只保留轻量运行状态（如“正在思考”“正在调用工具”）和 stop 按钮占位
  - 当前 streaming 路径：
    - 首次发送使用 `cardkit.v1.card.create + im.message.create(type=card)`
    - 后续 assistant delta 优先走 `cardElement.content`
    - 结构变化或完成态再走 `card.update`
    - `lark_object_bindings` 持久化 `card_id / message_id / element_id / sequence`
  - 当前 reasoning 边界：
    - 已支持“完成后的 reasoning 摘要/全文”进入顶部折叠区
    - 实时 reasoning delta 还没有底层 runtime 事件支持；当前只能显示“思考中”状态，占位不伪造全文

### 9.3 群、thread 与对话载体

- [ ] 群聊管理（SubAgent自动建群/归档）
  - 主Agent DM 是系统入口
  - SubAgent 使用独立飞书群
  - TaskAgent 不建独立群，只附着在已有对话中展示
  - durable 归属规则：
    - 主Agent / SubAgent 的主对话面通过通用 `channel_surfaces` 绑定到飞书 chat
    - TaskAgent 不拥有自己的长期 surface；其展示锚点附着在 owner 的主线或该次 run 的 thread 上

### 9.4 入站路由与目标解析

- [ ] 消息路由（主agent群 vs subagent群）
  - 飞书消息进入系统后，先做客观解析，再做路由决策
  - 必须区分：
    - 主 DM
    - SubAgent 群
    - 普通 thread
    - 任务绑定 thread
    - 卡片按钮回调
  - 普通聊天消息与任务干预消息要走不同 ingress command
  - 路由决策要保留结构化日志，便于排查误路由
  - 入站必须异步：
    - 平台回调先尽快 ack
    - 再异步提交 `submitMessage(...)` / `submitApprovalDecision(...)` 等统一 ingress command
  - 第一阶段最先打通的入站主链：
    - 普通消息
    - thread 回复
    - approval 卡片按钮回调
  - 当前已实现的最小入站主链：
    - 只接 `im.message.receive_v1`
    - 只处理 `message_type=text`
    - 只把普通文本消息翻译成 `submitMessage(...)`
    - installation 首次来消息时，自动完成 initial pairing
  - 当前入站解析顺序：
    - 飞书事件 -> 提取 `chat_id/message_id/text`
    - `chat_id` -> `surface_key`
    - `channel_surfaces` lookup
    - 命中后解析到 `conversation_id + branch_id`
    - 再按 `conversation/branch` 找最新 `chat` session
    - 最后异步提交给 runtime ingress
  - 第一阶段保留一个兼容回退：
    - 如果 `channel_surfaces` 尚未存在
    - 允许从 `channel_instances(provider=lark, account_key=installation_id) + conversations.external_chat_id + main branch`
      反查已有主线对话
    - 命中后立即补写 `channel_surfaces`
    - 这是帮助迁移现有库数据的兼容桥，不改变长期以 `channel_surfaces` 为准的方向

### 9.5 飞书特有的实现约束

- [ ] 飞书实现的额外约束
  - 飞书可以比其他 channel 展示更多过程，但仍然不能反过来定义 runtime 语义
  - conversation/branch <-> 飞书外部会话面的 durable 绑定复用通用 `channel_surfaces`
  - 飞书特有的 message/card/callback durable 锚点使用飞书专属表，不塞进通用表
  - 建议第一版至少有一张飞书专属对象锚点表，负责：
    - 内部 `message/task_run/approval` 与飞书 `message/card/thread-reply-anchor` 的 durable 绑定
    - `message_id` / `open_message_id` / `card_id` / `element_id` / `sequence` 等平台字段
  - 飞书 adapter 需要负责：
    - 卡片锚点管理
    - patch / streaming 频率控制
    - callback 幂等处理
    - thread / message target 编码与回解
    - 富交互失败时的文本 fallback

## 10. 部署与运维 `TODO`

- [ ] 容器化方案
- [ ] 配置管理
- [ ] 日志与监控
- [ ] 面向开发者的初版安装流程
