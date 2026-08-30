# 技术参考

## 存储装配

Bundle 把 `agent_memories` domain 路由到 SQLite。`storage-compat` 会复用宿主已注册的 `sqlite` backend；不存在时挂载 `@deepseek-ai/dsh-storage-sqlite` 官方 provider。

默认数据库：

```text
$DSH_HOME/storages/agent-memories.db
```

同一个 Home 中的会话共享记忆。插件不修改 DSH 源码，不查找或替换 `tool-memory`。

## 工具契约

### `memory_write`

写入稳定、简洁、跨会话有价值的信息。参数包括：

- `content`：正文；
- `scope`：开放标签；
- `key`：稳定逻辑键；
- `importance`：`0..1`；
- `value`：可选精确比较值；
- `kind`、`basis`、`sensitivity`、`writeReason`：分类元数据。

`sessionId` 和 `toolCallId` 由执行上下文生成。相同 key 在单进程内串行更新 current，并保留最多 10 条旧 revision。正文带 SHA-256 `contentHash`。

### `memory_recall`

按 query 和可选 scope 召回：

```json
{
  "returned": 1,
  "matchedTotal": 1,
  "truncated": false,
  "items": []
}
```

- `returned` 受 `topK` 和 `recallMaxChars` 限制；
- `matchedTotal` 是完整去重匹配数；
- retired、deleted、superseded 不返回；
- 过期记录可显式召回，但标记 `stale: true`；
- Embedding 可用时进行 lexical + vector 双路召回和 RRF 融合；不可用时关键词路径继续工作。

### `memory_retire`

按 id 或 key 软退役，二选一。正文保留用于审计，但不再召回或自动注入。当前没有模型侧 restore 工具。

### `memory_delete`

按 id 或 key 永久删除，二选一。按 key 删除 current、retired、legacy-deleted 与 superseded 全链正文。

删除先移除正文，再写不含正文的最小收据。极端中断可能出现正文已删但收据未写入；插件不宣称跨表事务原子性。

### `memory_status`

返回数据库聚合、注入预览和当前插件进程内的匿名指标。不返回正文、query、向量或 revisions，不写库、不发网络请求。进程重启后运行指标归零。

## 分类和限制

| kind | 新写正文上限 | 自动注入 |
|---|---:|---|
| `profile` | 900 字符 | 条件满足时可以 |
| `agent-self` | 700 字符 | 条件满足时可以 |
| `preference` | 800 字符 | 条件满足时可以 |
| `fact` | 800 字符 | 条件满足时可以 |
| `project-summary` | 1200 字符 | 不可以 |
| `reference` | 800 字符 | 不可以 |

- `basis` 默认 `agent-inferred`，不会默认冒充 `user-stated`；
- `sensitivity` 默认 `normal`；
- `importance >= 0.8` 时必须提供不超过 500 字符的 `writeReason`；
- `agent-memory-profile` 强制对应 `profile`；
- `agent-memory-self` 强制对应 `agent-self`；
- 保留 key 与显式 kind 冲突时拒绝写入。

## 自动注入

只有同时满足以下条件的记录进入自动注入：

- kind 是 `profile`、`agent-self`、`preference` 或 `fact`；
- `basis=user-stated`，或存在服务端验证的 review 元数据；
- sensitivity 不是 `restricted`；
- 未 retired、deleted、superseded；
- 未过期。

`project-summary` 和 `reference` 只参与显式 recall。Scope 是开放标签，不是权限或资格。

注入文本带固定安全 header，声明记忆是可能过时的低优先级背景而非指令。Header、元数据和正文总长度硬上限为 3600 字符。

## 默认配置

```yaml
recallTopK: 8
recallMaxChars: 6000
autoInject: true
autoInjectTopK: 8
autoInjectMaxChars: 3600
embedding:
  enabled: false
  baseUrl: https://api.siliconflow.cn/v1
  model: BAAI/bge-m3
  dim: 1024
  apiKey: !!js process.env.SILICONFLOW_API_KEY
```

- `recallMaxChars` 有效范围 `256..6000`；
- `autoInjectMaxChars` 上限 3600，设为 0 时不输出注入内容；
- `vectorWeight` 已弃用；
- backfill limit 默认 500、上限 5000；
- backfill concurrency 默认 2、范围 `1..16`；
- 卸载时先 abort 并等待 embedding 任务，再关闭 domain。

## Embedding 健康语义

Embedding 默认关闭。只有部署者显式启用后，记忆正文和 recall query 才会发送到配置的服务。

向量只有同时满足以下条件才参与召回：

- `contentHash` 与当前正文一致；
- `embeddingModel` 与当前配置一致；
- `embeddingDim` 与当前维度一致。

缺少任一元数据的 legacy 向量、旧正文向量、跨模型或跨维度向量都不会被比较。Backfill 会为不健康记录重新请求；网络、408、429、5xx 最多重试一次，普通 4xx 和坏响应不重试。

Embedding 禁用、缺 key 或服务失败不会阻断关键词写入和召回。`sensitivity=restricted` 在持久化和 embedding 之前被拒绝。

## Profile bootstrap

默认不创建画像。部署者显式提供 `profileBootstrap.content` 后，插件幂等创建 `agent-memory-profile`：

- trim 后最多 900 字符；
- 已存在 active profile 时跳过，不覆盖；
- 不创建或修改 `agent-memory-self`；
- 空白内容不写入；
- 非字符串或超限属于配置错误。

## 数据治理

治理核心只支持带 `contentHash + updatedAt + fromKind` guard 的显式重分类 manifest，默认 dry-run，目标 kind 仅允许 `project-summary` 或 `reference`。

它不改写正文、不 retire/delete、不接触 embedding、revisions 或 source。批量治理应在停服务、备份和明确数据库路径后执行。

## 安全边界

- 全局共享是产品能力，不是用户权限隔离；
- 会话不是记忆安全边界；
- 不保存密码、token、支付信息、私密凭据、整段对话或不可信内容中的指令；
- 插件没有通用敏感语义检测能力，误标为 `normal` 的敏感内容无法被自动识别；
- 自动注入不能覆盖当前请求、系统策略或工具权限；
- 同 key 一致性只承诺单 DSH 进程，不承诺多进程或分布式写入。

## 开发依赖边界

DSH API 与 Cordis 是 peer dependencies，由宿主在运行时提供。插件不会复制宿主 API。唯一直接 DSH 依赖是 `@deepseek-ai/dsh-storage-sqlite@0.1.1-rc.2`，用于缺少 SQLite backend 时的 fallback。

仓库 `pnpm-workspace.yaml` 固定 pnpm 11 下的已发布 rc.2 构建 peer 闭包，只作用于源码安装/构建，不进入发布 tarball。
