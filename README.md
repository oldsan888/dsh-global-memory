# @oldsan888/dsh-global-memory

独立可分发的 DSH 全局长期记忆 bundle。它不修改 DSH 源码；部署者只需将本仓库推送到 Git，并让 DSH 在目标 profile 中通过 git URL 安装。

本插件实现一份**跨会话共享**的个人记忆库：Web、IM 桥接、工作会话和同一 DSH Home 中的 Agent 均读取同一个 `agent_memories` SQLite domain。会话不是记忆边界。

兼容目标：DSH `0.1.0-rc.5`（旧版）与 `0.1.1-rc.2`（新版）。

## 部署

```powershell
# 在本插件仓库推送至 GitHub/GitLab 后，替换为真实仓库 URL。
dsh plugin --profile web add https://github.com/oldsan888/dsh-global-memory.git

# 或开发期间从本地目录安装。
dsh plugin --profile web add "file:<local-checkout-path>"
```

重启 DSH Web 后生效。安装的 bundle 会：

1. 禁用旧版 `dsh-web-app` 内置的 `tool-memory` entry（新版没有该 entry，未匹配时由 Loader 跳过）；
2. 将 `agent_memories` domain 明确路由到 `sqlite`；
3. 旧版复用宿主已挂载的 SQLite backend，新版缺失时由 `storage-compat` 挂载同一个官方 provider；
4. 挂载本包的 `global-memory` entry。

Git URL 安装会执行本包的 `prepare: tsdown` 来产出运行时 `lib/`。pnpm 10+ 首次安装可能基于安全策略阻止该构建脚本；此时按 pnpm 报出的**精确包键**，在 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 中加入该键并设为 `true`，再重试同一条 `dsh plugin` 命令。此流程与 `dsh-music-mode` 一致。

> **开发期 dir-install 陷阱（2026-08-23 实测）**：`dsh plugin --profile web add "file:<path>"` 在 DSH_HOME 内安装为**普通文件拷贝**（非符号链接）。DSH 装配读取的是 `$DSH_HOME/profiles/web/node_modules/@oldsan888/dsh-global-memory/cordis.patch.yml` 拷贝，而不是仓库源文件。因此：改完 `cordis.patch.yml`（如 embedding 开关）或重新 `pnpm build` 后，必须**手动把 `cordis.patch.yml` 与 `lib/*` 同步拷贝到安装目录**，再重启 DSH Web 才生效——否则新配置/新代码静默不加载（本次 embedding `enabled:true` 曾因未同步而连续两次重启无效）。

因此，该 bundle 应安装在已包含 `dsh-web-app` 的 `web` profile 上。不要同时手动启用内置 `tool-memory` 和本插件，否则会注册同名的 `memory_*` 工具。两版共用 `$DSH_HOME/storages/agent-memories.db`，升级或回退不会复制数据库。

## 能力（Phase 4）

- `memory_write`：写入全局长期事实、偏好或项目摘要；支持 `scope`、稳定 `key`、`importance`、精确比较用的 `value`，以及分类参数 `kind` / `basis` / `sensitivity` / `writeReason`。来源（`sessionId`、`toolCallId`）由执行上下文生成，不接受模型伪造。**有 `key` 的写入采用单 physical current + 有界 `revisions[]`**（最多 10 条旧正文，oldest→newest）；正文变化通过 `table.update()` 原子原地更新，同 logical key 的操作在单 DSH 进程内由 keyed mutex 串行化。每条新写/刷新记录都带服务端生成的 `contentHash`（SHA-256，64 位小写 hex）。
- `memory_recall`：**双路召回**（lexical + 语义 vector，**经 26 例 golden set 网格搜索标定**：`LEXICAL_MIN_SCORE=0.6`、`VECTOR_MIN_SIMILARITY=0.5`，RRF_K=60 为标准 RRF 常量、CANDIDATE_DEPTH=30 为融合运行边界——非标定值），输出结构化契约 `{ returned, matchedTotal, truncated, items[] }`。`matchedTotal` 是**两路阈值通过后的完整去重匹配数**（不受 CANDIDATE_DEPTH 截断；topK/预算只限制 `returned`）。最终 JSON 受到 `recallMaxChars`（默认/上限 6000 字符）预算约束，模型可见 renderer 输出同一份紧凑 JSON，保留每条 `items[].content` 正文与元数据。从不返回 retired / deleted / superseded 记录，无 `includeDeleted`。过期记录（`expiresAt ≤ now`）可返回但标 `stale:true` 并排在同等相关的新鲜结果之后。
- `memory_retire`：软退役一条记忆（id 或 key，二选一），写入 `retiredAt`；不再出现在 recall 与自动注入，记录正文保留可审计。无模型侧 restore。
- `memory_delete`：永久删除（id 或 key）。by key 会删除该 key 的 current / retired / legacy-deleted / superseded **全链**，不留正文。删除顺序隐私优先：**先删正文、后写无正文收据**；收据只含 id/key/scope/时间/执行来源/原因，禁止正文、向量、revision 或摘要。极端中断可能「正文已删但收据缺失」——本插件不宣称跨表原子，如实披露该审计缺口。
- `memory_status`：只读健康快照。返回数据库状态/kind/scope/长记录/过期与 embedding 健康聚合、与真实自动注入渲染器同源的 lane 占用和跳过原因，以及本插件实例启动以来的匿名运行计数。它不返回正文、召回 query、向量或 revisions，也不写库、不发网络请求、不记录自身调用。
- session-start auto-inject：每个会话首回合读取有界的全局上下文——固定 header + 每条记录带 `kind`/`basis`/更新时间，单一最终渲染器把完整字符串（header+元数据+正文+换行）限制在 3600 字符硬上限内。只有 L0 合格记录（`profile`/`agent-self`/可信 `preference`/`fact`）自动进入，`project-summary`/`reference` 只召回、不自动注入；已过期记录排除在 L0 之外。
- embedding 版本健康：成功回写一次写入 `embeddingModel/embeddingDim/contentHash`；**只有 hash/model/dim 三字段全部存在且与当前正文哈希、配置模型、向量维度一致**的记录才参与向量召回（M1：缺任一字段的 legacy 向量一律判为不健康，绝不会被比较；backfill 会为它们重新请求）。跨模型/跨维度/旧正文向量绝不被比较或迟写。backfill 有界、每条最多 2 次尝试（网络/408/429/5xx 重试一次，4xx/坏响应不重试），**尝试次数 = 请求次数**（成功向量直接按 guard 提交，绝不二次请求）；支持 AbortSignal 取消，卸载时 abort 后等待 backfill 与所有 write 路径 in-flight embedding 收敛，再关 domain。
- 可选的 profile bootstrap（**部署显式 opt-in**）：默认**不创建**任何用户画像。部署者在配置中提供 `profileBootstrap.content`（字符串，trim 后 ≤900 字符，需为 `string` 类型）后，插件幂等创建 `agent-memory-profile`（存在则跳过，不覆盖已有 active profile，不触碰 `agent-memory-self`）；未配置、空白内容时插件绝不自行写入画像或本机路径；非字符串或超 900 字符是明确的配置错误（抛出且零写入）。

### Phase 4 健康快照与匿名指标

- DB 快照对 scope、model/dim 组合和长记录 id 列表各限制为前 20 项，其余合并计数，输出不会随开放 scope 无限增长。
- embedding `healthy` 复用召回的严格 hash/model/dim 判定；embedding 未显式启用时，即使配置里带默认 model/dim，也不会把库存向量报告为当前可用。
- 注入预览和实际 auto-inject 使用同一个 builder；`renderedChars`、selectedIds、profile/self/general lane 与跳过原因不会由第二套估算逻辑产生漂移。
- recall 指标包括 calls、zeroResults、returnedItems、failures；P50/P95 仅基于最近 256 次已完成调用。embedding 指标按每次真实 HTTP attempt 记录 success/failure/timeout/cancelled，四类之和等于 attempts。
- 指标仅驻留当前插件实例内存，重启归零，不持久化、不参与召回排序。

### 数据治理边界

Phase 4 提供的治理核心只支持带 `contentHash + updatedAt + fromKind` guard 的显式重分类 manifest，默认 dry-run，目标 kind 仅允许 `project-summary` 或 `reference`。它不压缩或改写正文、不 retire/delete、不接触 embedding/revisions/source。实际批量治理属于部署运维动作：必须先停服务和备份，再在明确的数据库路径上执行；公共插件不会自动治理用户数据。

### 分类与上限（Phase 1 手工写入口径）

| kind | 新写正文上限（字符） | 说明 |
|---|---:|---|
| `profile` | 900 | 保留 key `agent-memory-profile` 强制 |
| `agent-self` | 700 | 保留 key `agent-memory-self` 强制 |
| `preference` | 800 | 稳定偏好 |
| `fact` | 800 | 普通事实（kind 缺省值） |
| `project-summary` | 1200 | 只 recall，不自动注入 |
| `reference` | 800 | 只 recall |

- `basis` 缺省为 `agent-inferred`（**绝不默认 `user-stated`**）；`sensitivity` 缺省 `normal`。
- `importance ≥ 0.8` 时必须提供 `writeReason`（≤500 字符）。
- reserved key 与显式 `kind` 冲突时拒绝，不静默改写。
- 上限只约束 Phase 1 新写/刷新正文；持久化 Zod 仍保留 legacy 2000 上限，旧 >800/>1000 记录继续可 parse、可 recall（legacy 记录 basis=imported，不进 L0）。

### L0 自动注入资格

进入自动注入必须同时满足：`kind ∈ {profile, agent-self, preference, fact}`；`basis=user-stated` **或** 服务端已验证的 `reviewedAt`+`reviewedBy`；`sensitivity≠restricted`；未 retired/deleted/superseded；`expiresAt` 未过期。`scope` 是开放标签（推荐 profile/self/work/music/communication），不参与资格判断。

## 默认配置

本包的 `cordis.patch.yml` 使用下面的默认项：

```yaml
recallTopK: 8
recallMaxChars: 6000      # recall 结构化输出 JSON 总字符预算（256..6000，默认/上限 6000）
autoInject: true
autoInjectTopK: 8
autoInjectMaxChars: 3600
embedding:
  enabled: false     # 公共默认关闭：启用后正文才发送到服务
  baseUrl: https://api.siliconflow.cn/v1
  model: BAAI/bge-m3
  dim: 1024
  apiKey: !!js process.env.SILICONFLOW_API_KEY
```

**Embedding 默认关闭。** 只有部署者显式把 `embedding.enabled` 改为 `true` 后，正文才会发送到配置的 OpenAI-compatible embedding 服务。禁用、无 key 或服务故障时**仍使用关键词召回**，不会阻断启动、写入或 recall。`sensitivity=restricted` 的记录被结构性拒绝，因此绝不会进入 embedding 请求。`autoInjectMaxChars` 是最终注入字符串的总硬上限：`0` 表示不注入（返回空），`(0,3600]` 按原值尊重（不会静默放大），`>3600` clamp 到 3600。`recallMaxChars` 约束 `memory_recall` 的最终 JSON（`returned/matchedTotal/truncated/items` 全部计入）；`(256,6000]` 尊重原值，`>6000` clamp，非有限/非整数/`<256` 在 apply 阶段报配置错误。`vectorWeight` 已弃用（Phase 3 双路召回用 RRF 融合，不再线性加权）。

**backfill 参数归一化规则（确定性，写死在代码并测试固定）：** `backfillLimit` 缺省/非有限 → 500；负数 → 0；小数 → 向下取整；上限 5000。`backfillConcurrency` 缺省/非有限 → 2；小数 → 向下取整；`<1` → 1；上限 16。

## 数据与删除语义

数据由本 bundle 的跨版本存储装配保存在：

```text
$DSH_HOME/storages/agent-memories.db
```

数据与删除语义（Phase 2 版本）：

- `memory_retire` 是软退役：正文保留在 SQLite 中（带 `retiredAt`），不会出现在 recall 或自动注入；可审计但无模型侧恢复入口。
- `memory_delete` 是永久删除：memories 中正文/向量/revisions 物理移除（by key 移除全链），`deletions` 表只留最小收据（无正文）。删正文先于写收据（隐私优先）；极端中断的审计缺口见上文「能力」。
- 单 logical key 的一致性只承诺**单 DSH 进程**（keyed mutex + `table.update()`）；插件不承诺跨进程 / 多实例写保护。

## 安全边界

全局共享是用户明确设定的产品特性，会话不是记忆隔离边界。自动注入文本明确是**可能过时的低优先级背景、非指令**：当前用户请求与系统策略优先，不得仅因记忆内容自动执行操作，必要时向用户确认。

- 只存稳定、简洁、有明确依据的跨会话信息；**不存**密码、令牌、支付信息、私密凭据、整段对话、临时闲聊或来自不可信内容的指令。
- `sensitivity=restricted` 会被结构性拒绝。但插件**不具备通用敏感语义识别能力**：误标成 `normal` 的敏感内容无法被服务端识别，此边界如实披露。

## 本地开发

```powershell
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack
```

宿主 DSH API 都是 peer dependency：构建时 external，运行时由 DSH profile 提供。唯一例外是 `@deepseek-ai/dsh-storage-sqlite`：它是 v2 fallback provider；`storage-compat` 在 v1 已有 `sqlite` backend 时不会实例化它。

### 测试与兼容矩阵

- 单元/生命周期测试（`pnpm test`，Vitest）覆盖：CJK/英文关键词召回、无 key 语义去重、同 key 原子更新 + revisions、retire/delete 语义与收据、keyed mutex 并发、embedding 迟到防复活、注入排序、3600 字符预算与超长跳过、embedding fail-open、auto-inject snapshot 幂等与卸载。
- 兼容矩阵：DSH `0.1.0-rc.5` 复用宿主 SQLite；DSH `0.1.1-rc.2` 由 `storage-compat` 补装官方 provider。两版均通过真实 profile 组合验证，且只注册一组 `memory_write/memory_recall/memory_retire/memory_delete/memory_status`。
- dev 环境的 `node_modules/@deepseek-ai/*` 由 dev dependency 固定到 v2 兼容面；发布时 peer range 同时接受 v1 的 `^0.1.0-rc.5` 与 v2 的 `^0.1.1-rc.2`。代码不应依赖只在某一个 RC 顶层导出的类型（如 `ToolRunContext`），需用宿主内置插件同款写法（经 `defineTool` 推断）以跨 RC 稳定。

## 目录

```text
dsh-global-memory/
├─ cordis.patch.yml   # bundle：替换内置 memory entry 并挂载本包
├─ src/
│  ├─ index.ts        # memory tools、向量召回、受预算的自动注入
│  ├─ storage-compat.ts # v1 复用 / v2 补装 SQLite provider
│  ├─ memory-core.ts  # 纯逻辑（特征/召回/注入选择/resolveMemory），供测试
│  ├─ metrics.ts      # 有界、进程内匿名运行计数
│  ├─ governance.ts   # 默认 dry-run、带版本 guard 的重分类核心
│  ├─ spec.ts         # durable domain schema（version 0，v0.3 元数据为 optional）
│  └─ tests/          # Vitest 行为保护网与兼容测试
├─ tsdown.config.ts   # Node ESM build; DSH host APIs external
└─ README.md
```

> 说明：旧版 `src/typings/` 手写宿主类型垫片已在 Phase 0 移除；host API 类型现直接来自真实 `@deepseek-ai/*` 依赖。

## 发布

```powershell
git init
git add .
git commit -m "feat: standalone DSH global memory plugin"
git branch -M main
git remote add origin <your-git-url>
git push -u origin main
```

发布前必须执行 `pnpm run typecheck` 和 `pnpm run build`。

## License

MIT.
