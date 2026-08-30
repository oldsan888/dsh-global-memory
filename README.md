# @oldsan888/dsh-global-memory

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的独立全局长期记忆插件。

它通过 DSH 的公开 bundle/profile 机制安装，不修改 DSH 源码，也不依赖任何私人分支或历史上的 `tool-memory` 定制。插件为同一个 `DSH_HOME` 中的会话提供一份共享 SQLite 记忆库，并向模型注册写入、召回、退役、永久删除和健康检查工具。

## 先读结论

- 可以直接从公开 Git 仓库安装，不需要本地插件源码。
- 插件不会替换或修改 DSH 源码。
- 记忆跨会话共享，但只在同一个 `DSH_HOME` 内共享。
- Embedding 默认关闭；默认关键词召回不发送记忆正文到外部服务。
- Git 安装需要显式通过 pnpm `allowBuilds` 授权插件的 `prepare` 构建脚本。
- DSH 当前仍是 prerelease，插件只承诺下表列出的精确版本，不承诺任意未来版本自动兼容。

## 已验证版本

| 组件 | 版本或 revision | 验证程度 |
|---|---|---|
| 本插件 | `0.2.0` | 类型检查、212 项测试、构建、打包、远端 Git 安装与真实 LLM 功能验证通过 |
| 本插件 Git revision | `4fc9bed446835682fd66dacd6451a71d84408ba2` | 推荐的可复现安装 revision |
| DSH 源码宿主 | `0.1.2-alpha.1`，commit `cd5ef8148158c3a752a658978873241fdf8e2bbc` | 干净 Home 端到端验证通过 |
| DSH npm 构建 API | `0.1.1-rc.2` | 插件独立安装、类型检查和构建使用的已发布 API |
| Cordis | `4.0.1` | 精确 peer/dev 版本 |
| Node.js | `24.14.0` | 已验证环境 |
| pnpm | `11.7.0` | 已验证环境 |

插件的 DSH peer contract 是：

```text
0.1.1-rc.2 || 0.1.2-alpha.1
```

之所以同时出现 RC 与 alpha，不是插件强制 DSH 使用 RC，而是当前 DSH Git 源码已经标记为 `0.1.2-alpha.1`，相关 `@deepseek-ai/dsh-*` npm 包却只发布到 `0.1.1-rc.2`。Git dependency 的独立构建阶段必须使用 npm 上真实存在的 rc.2 包；运行阶段则由已验证的 alpha.1 宿主提供 peer API。等 DSH 发布对应的 alpha npm 包后，可以再统一版本。

其他 DSH 版本属于未验证组合。升级 DSH 前，请先在独立 Home 中复验本 README 的安装与验收步骤。

## 工作方式

安装后，bundle 会执行三件事：

1. 把 `agent_memories` storage domain 路由到 SQLite；
2. 复用宿主已有的 SQLite backend，或在缺失时挂载 DSH 官方 SQLite provider；
3. 挂载 `global-memory`，注册五个 `memory_*` 工具和有界自动注入。

插件不会查找、禁用或替换 `tool-memory`。官方 DSH 历史中没有该 bundle entry；它曾来自非官方本地定制，不属于本插件的公开依赖。

数据默认保存在：

```text
$DSH_HOME/storages/agent-memories.db
```

`DSH_HOME` 是数据边界：同一 Home 中的 Web、其他 profile 或桥接会话可以共享记忆；不同 Home 互不共享。它不是多用户权限边界，也不适合多个 DSH 进程同时写同一个数据库。

## 前置条件

安装前需要：

- 一个可正常启动并已配置 LLM 的 DSH；
- Node.js 与 pnpm，版本应满足目标 DSH 的要求；
- 能访问 GitHub 和 npm registry；
- 明确目标 `DSH_HOME` 和 profile 名称。以下示例使用 `web`。

如果从全新 DSH 源码运行，先完成 DSH 自身安装和构建：

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
Set-Location deepseek-harness
pnpm install --frozen-lockfile
pnpm run build
```

只执行 `pnpm install` 而不构建，Web profile 可能因缺少 client bundles 报 `MissingClientBundleError`。如果使用已经安装好的 `dsh` CLI，可以跳过源码构建步骤，并把后文的 `pnpm dsh` 替换为 `dsh`。

## 从 GitHub 安装

### 1. 明确隔离的 DSH Home

PowerShell：

```powershell
$env:DSH_HOME = 'E:\path\to\dsh-home'
```

Bash：

```bash
export DSH_HOME=/path/to/dsh-home
```

不要假设更换 DSH 源码目录会自动更换 Home。环境中如果已经存在全局 `DSH_HOME`，每个安装、诊断和启动进程都应显式覆盖它。

### 2. 第一次执行安装

在 DSH 源码目录运行：

```powershell
pnpm dsh plugin --profile web add "git+https://github.com/oldsan888/dsh-global-memory.git#4fc9bed446835682fd66dacd6451a71d84408ba2"
```

首次执行通常会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 退出。这是预期的安全拦截，不是插件构建失败。Git 仓库不提交生成后的 `lib/`，安装时需要执行 `prepare: tsdown`；pnpm 要求部署者明确授权该脚本。

失败应当是原子的：profile 不应新增 dependency、bundle、lockfile 或残留插件目录。

### 3. 授权构建并处理宿主 peers

编辑：

```text
$DSH_HOME/profiles/web/pnpm-workspace.yaml
```

保留文件中的既有配置，并合并下面两段：

```yaml
allowBuilds:
  '@oldsan888/dsh-global-memory@git+https://github.com/oldsan888/dsh-global-memory.git#4fc9bed446835682fd66dacd6451a71d84408ba2': true

peerDependencyRules:
  ignoreMissing:
    - '@deepseek-ai/*'
```

安全注意事项：

- `allowBuilds` 的键必须与 pnpm 当次错误输出完全一致。
- revision 改变后，应审阅新代码并使用新 revision 对应的新键；不要把包名写成无版本、无来源的宽泛授权。
- 如果文件已有 `allowBuilds`、`peerDependencyRules` 或 `ignoreMissing`，请合并键，不要创建重复 YAML 字段。
- `ignoreMissing` 不会安装第二份 DSH 或 Cordis。DSH 在运行时通过 profile module fallback 提供宿主 peer；重复安装宿主 API 反而可能产生多个 Cordis 实例。

### 4. 重试同一安装命令

```powershell
pnpm dsh plugin --profile web add "git+https://github.com/oldsan888/dsh-global-memory.git#4fc9bed446835682fd66dacd6451a71d84408ba2"
```

成功时，DSH profile 应出现：

- dependency：`@oldsan888/dsh-global-memory`；
- bundle：`@oldsan888/dsh-global-memory`；
- lockfile resolution commit：`4fc9bed446835682fd66dacd6451a71d84408ba2`；
- 安装包版本：`0.2.0`；
- 构建产物：`lib/index.js` 与 `lib/storage-compat.js`。

## 安装后验收

### 静态检查

PowerShell：

```powershell
$profile = Join-Path $env:DSH_HOME 'profiles/web'

pnpm --dir $profile peers check
pnpm dsh --profile web --dump-config |
  Select-String 'global-memory|agent_memories|tool-memory'
```

预期结果：

- peer 检查输出 `No peer dependency issues found`；
- 配置中存在 `agent_memories: sqlite`；
- 存在 `global-memory-storage-compat` 与 `global-memory`；
- 不存在 `tool-memory`，也没有 `patch: entry "tool-memory" not found`。

同时检查 profile 的 `pnpm-lock.yaml`，确认 Git resolution 是你审阅和授权的完整 commit，而不是仅依赖可移动的 branch 名。

### 启动检查

```powershell
pnpm dsh --profile web
```

启动成功后应满足：

- Web 服务正常监听；
- 日志没有插件加载、模块解析、服务注入、重复工具或 schema 错误；
- `$DSH_HOME/storages/agent-memories.db` 被创建；
- Node.js 可能输出 `SQLite is an experimental feature`，这是当前 Node SQLite API 的非阻断警告。

### 功能检查

在一个测试会话中明确要求模型调用 `memory_write`，例如：

```text
请调用 memory_write 保存：我偏好简洁的中文技术说明。
使用 key=validation-writing-style、scope=profile、kind=preference、
basis=user-stated、sensitivity=normal、importance=0.7。
```

然后创建第二个新会话：

```text
请调用 memory_recall，query 使用“中文技术说明”，scope 使用 profile，
并报告 returned、matchedTotal、truncated 和召回正文。
```

完整验收至少包括：

1. 写入工具返回成功；
2. 新会话可以召回；
3. `returned >= 1` 且正文一致；
4. 停止并重启 DSH 后，第三个新会话仍能召回；
5. 数据库只写入目标 `DSH_HOME`。

## 模型工具

### `memory_write`

写入稳定、简洁、跨会话有价值的信息。支持：

- `scope`：开放标签，推荐 `profile`、`self`、`work`、`music`、`communication`；
- `key`：稳定逻辑键；相同 key 更新当前记录并保留最多 10 条旧 revision；
- `importance`：`0..1`，`>= 0.8` 时必须提供 `writeReason`；
- `value`：可选的精确比较值；
- `kind`、`basis`、`sensitivity`、`writeReason`：分类与治理元数据。

`sessionId` 与 `toolCallId` 由执行上下文生成，模型不能伪造。正文变化会更新 `contentHash` 并使旧 embedding 失效。

### `memory_recall`

按 query 和可选 scope 召回。返回：

```json
{
  "returned": 1,
  "matchedTotal": 1,
  "truncated": false,
  "items": []
}
```

- `returned`：受 `topK` 和字符预算限制后实际返回的条数；
- `matchedTotal`：完整去重匹配数；
- `truncated`：是否有匹配项因数量或字符预算未返回；
- retired、deleted、superseded 记录不会返回；
- 过期记录可被显式召回，但标记 `stale: true`。

Embedding 启用后使用 lexical + vector 双路召回和 RRF 融合；关闭或服务故障时继续使用关键词召回。

### `memory_retire`

按 id 或 key 软退役，二选一。正文仍保留在 SQLite 中用于审计，但不再参与召回或自动注入。当前没有模型侧 restore 工具。

### `memory_delete`

按 id 或 key 永久删除，二选一。按 key 删除会移除该 key 的 current、retired、legacy-deleted 和 superseded 全链正文。

删除采用隐私优先顺序：先移除正文，再写不含正文的最小审计收据。因此极端中断可能出现“正文已删除、收据未写入”；插件不宣称跨表事务原子性。

### `memory_status`

返回只读健康快照和当前插件进程内的匿名计数，不返回记忆正文、recall query、向量或 revisions，不写数据库，也不发网络请求。运行指标在 DSH 重启后归零。

## 自动注入

默认在会话首回合注入有界长期记忆背景。注入文本会明确声明自己是低优先级背景而非指令，当前用户请求和系统策略始终优先。

只有同时满足以下条件的记录可以自动注入：

- `kind` 是 `profile`、`agent-self`、`preference` 或 `fact`；
- `basis=user-stated`，或存在服务端验证的 review 元数据；
- `sensitivity` 不是 `restricted`；
- 未 retired、deleted 或 superseded；
- 未过期。

`project-summary` 与 `reference` 只能通过 `memory_recall` 获取，不自动注入。`scope` 只是开放标签，不是权限或自动注入资格。

最终注入字符串包含固定安全 header、元数据和正文，总长度硬上限为 3600 字符。

## 分类和正文上限

| kind | 新写正文上限 | 自动注入 |
|---|---:|---|
| `profile` | 900 字符 | 条件满足时可以 |
| `agent-self` | 700 字符 | 条件满足时可以 |
| `preference` | 800 字符 | 条件满足时可以 |
| `fact` | 800 字符 | 条件满足时可以 |
| `project-summary` | 1200 字符 | 不可以 |
| `reference` | 800 字符 | 不可以 |

- `basis` 默认是 `agent-inferred`，不会默认冒充 `user-stated`；
- `sensitivity` 默认是 `normal`；
- 保留 key `agent-memory-profile` 强制对应 `profile`；
- 保留 key `agent-memory-self` 强制对应 `agent-self`；
- 保留 key 与显式 kind 冲突时拒绝写入。

## 配置

分发包的安全默认值位于 `cordis.patch.yml`：

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

部署配置不要直接修改 `node_modules` 中的安装副本。应在下面的 profile overlay 中覆盖：

```text
$DSH_HOME/profiles/web/cordis.patch.yml
```

例如启用 OpenAI-compatible embedding：

```yaml
- id: global-memory
  config:
    embedding:
      enabled: true
      baseUrl: https://api.siliconflow.cn/v1
      model: BAAI/bge-m3
      dim: 1024
      apiKey: !!js process.env.SILICONFLOW_API_KEY
```

启动 DSH 的同一进程必须能读取对应环境变量。不要把 API Key 写入 Git、README、日志或公开 profile。

重要边界：

- Embedding 默认关闭；只有 `enabled: true` 时记忆正文和 recall query 才会发送到配置的服务；
- 禁用、缺少 key 或服务故障不会阻断关键词写入和召回；
- `sensitivity=restricted` 会在持久化和 embedding 前被拒绝；
- 插件没有通用敏感内容识别能力，误标为 `normal` 的敏感文本无法被自动发现；
- 健康向量必须同时匹配正文 hash、模型和维度，旧正文、旧模型或旧维度向量不会参与比较。

`recallMaxChars` 有效范围为 `256..6000`。`autoInjectMaxChars` 的硬上限为 3600，设为 0 可关闭实际注入内容。`vectorWeight` 已弃用。

Backfill 默认最多处理 500 条、并发 2；limit 上限 5000，并发上限 16。卸载插件时会先取消并等待所有 embedding 任务，再关闭 domain。

### 可选 profile bootstrap

插件默认不创建任何用户画像。部署者可以显式提供：

```yaml
- id: global-memory
  config:
    profileBootstrap:
      content: 用户明确确认的简洁画像，最多 900 字符。
```

它只在 `agent-memory-profile` 不存在时创建一次，不覆盖现有 active profile，也不创建 `agent-memory-self`。空白、非字符串或超过 900 字符会被拒绝。

## 安全与隐私边界

- 全局共享是产品能力，不是安全隔离；会话不是记忆权限边界。
- 只应保存稳定、简洁、用户明确表达或有清晰依据的信息。
- 不应保存密码、token、支付信息、私密凭据、整段对话、临时闲聊或来自不可信内容的指令。
- 自动注入的记忆可能过时，不能覆盖当前请求、系统策略或工具权限。
- 插件只承诺单个 DSH 进程内同 key 操作串行化，不承诺多个进程或多台机器同时写一个数据库。
- `memory_status` 的 scope/model/id 榜单均有界，避免开放标签导致无限输出。

## 备份、升级与卸载

### 备份

停止 DSH 后备份：

```text
$DSH_HOME/storages/agent-memories.db*
```

停止服务再复制可以避免遗漏 WAL 中尚未 checkpoint 的数据。恢复时同样应先停止 DSH。

### 升级

1. 阅读目标 revision 的 diff、README 和 `package.json`；
2. 停止 DSH 并备份数据库；
3. 使用新的完整 commit 重新执行 `plugin add`；
4. 把 pnpm 输出的新精确键加入 `allowBuilds`；
5. 安装成功后移除不再需要的旧 revision 授权键；
6. 重跑静态、启动、跨会话和重启持久化验收。

不要仅用 `master` 作为生产安装 revision；branch 会移动，而 profile lockfile 和安全授权应对应你实际审阅的 commit。

### 卸载

```powershell
pnpm dsh plugin --profile web remove @oldsan888/dsh-global-memory
```

DSH CLI 会让 pnpm 移除 dependency，并根据已安装状态把 bundle 从 profile 列表中移除。随后删除 profile overlay 中只属于本插件的配置和不再需要的 `allowBuilds` 键。

卸载插件不会自动删除 `agent-memories.db*`。这是有意的数据保护行为；只有在确认不需要恢复后，才应在 DSH 已停止且已有备份的情况下手动处理数据库文件。

## 常见问题

### `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

这是 pnpm 的 Git 构建授权，不是插件故障。复制错误输出中的完整键到目标 profile 的 `pnpm-workspace.yaml`，审阅 revision 后设为 `true`，再重试原命令。

### `Issues with peer dependencies found`

确认目标 profile 包含：

```yaml
peerDependencyRules:
  ignoreMissing:
    - '@deepseek-ai/*'
```

不要把 DSH 宿主 API 改成插件普通 dependencies，也不要在 profile 中安装另一套 Cordis。

### `patch: entry "tool-memory" not found`

当前 0.2.0 不包含该 patch。出现此提示通常说明 profile 仍安装旧 commit。检查 profile package、bundle、lockfile resolution 和安装目录中的 `package.json`。

### 修改配置后没有生效

Git/file 安装得到的是 profile 内的安装副本。不要只修改另一个本地 checkout；使用 profile 的 `cordis.patch.yml` overlay，并重启 DSH。开发本包本身时则需要重新 build、重新安装或同步安装副本。

### 只有 SQLite experimental warning

当前 Node.js 会对内置 SQLite API输出 experimental warning。若服务、工具和数据库均正常，这不是插件加载失败。

## 给 AI 安装代理的最小检查清单

AI 工具在替用户安装前应：

1. 读取本 README、`package.json`、`cordis.patch.yml` 和目标 revision diff；
2. 明确并回显目标 DSH 源码 commit、`DSH_HOME`、profile 和插件 commit；
3. 不使用本地 `file:` 路径代替公开 Git 验证；
4. 首次失败后只添加 pnpm 实际输出的精确 `allowBuilds` 键；
5. 保留宿主 API 为 peer，不复制安装 DSH/Cordis；
6. 检查 lockfile resolution 的完整 Git commit；
7. 运行 peer、dump-config、启动、写入、跨会话召回和重启持久化检查；
8. 检查数据库只写入目标 Home；
9. 不输出或记录 LLM API Key、Web 启动 token、Cookie 或其他凭据；
10. 未经用户明确授权，不删除数据库、不启用 embedding、不推送代码。

## 本地开发

```powershell
git clone https://github.com/oldsan888/dsh-global-memory.git
Set-Location dsh-global-memory
pnpm install --frozen-lockfile
pnpm peers check
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run
```

当前质量基线：

- 9 个 Vitest 测试文件；
- 212 项测试全部通过；
- TypeScript 类型检查通过；
- tsdown ESM 构建通过；
- dry-run tarball 只包含运行库、source maps、patch、README、LICENSE 和 package manifest。

宿主 DSH API 和 Cordis 是 peer dependencies，运行时由 DSH 提供。`@deepseek-ai/dsh-storage-sqlite@0.1.1-rc.2` 是插件的直接 fallback provider。仓库根 `pnpm-workspace.yaml` 只用于在 pnpm 11 下固定已发布 rc.2 的构建期 peer 闭包，不会进入发布 tarball。

## 目录

```text
dsh-global-memory/
├─ cordis.patch.yml          # bundle patch：存储路由与插件挂载
├─ src/
│  ├─ index.ts               # 工具、召回、自动注入与生命周期
│  ├─ storage-compat.ts      # 复用或挂载官方 SQLite backend
│  ├─ memory-core.ts         # 纯逻辑与召回算法
│  ├─ metrics.ts             # 有界进程内指标
│  ├─ governance.ts          # 带 guard、默认 dry-run 的治理核心
│  └─ spec.ts                # durable domain schema
├─ tests/                    # 行为、生命周期和发布契约测试
├─ pnpm-workspace.yaml       # pnpm 11 构建期 peer 闭包
├─ tsdown.config.ts          # Node ESM 构建配置
└─ README.md
```

## License

[MIT](./LICENSE)
