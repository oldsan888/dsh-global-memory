# 安装与运维

本文面向从公开 Git 仓库安装 `@oldsan888/dsh-global-memory` 的开发者和 AI 工具。

## 前置条件

- DSH 可以正常启动并已配置 LLM；
- Node.js、pnpm 和网络环境满足目标 DSH 的要求；
- 已明确目标 `DSH_HOME` 和 profile；本文使用 `web`；
- 生产安装使用经过审阅的完整 Git commit，不使用可移动的 branch 名。

从全新 DSH 源码运行时，先完成 DSH 自身构建：

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
Set-Location deepseek-harness
pnpm install --frozen-lockfile
pnpm run build
```

只安装依赖而不构建，Web profile 可能报 `MissingClientBundleError`。如果使用已安装的 `dsh` CLI，可把下文的 `pnpm dsh` 替换为 `dsh`。

## Git 安装

### 1. 显式设置 Home

PowerShell：

```powershell
$env:DSH_HOME = 'E:\path\to\dsh-home'
```

Bash：

```bash
export DSH_HOME=/path/to/dsh-home
```

更换源码目录不会自动更换 Home。存在全局 `DSH_HOME` 时，每个安装、诊断和启动进程都应显式覆盖它。

### 2. 第一次执行安装

```powershell
pnpm dsh plugin --profile web add "git+https://github.com/oldsan888/dsh-global-memory.git#4fc9bed446835682fd66dacd6451a71d84408ba2"
```

首次执行通常会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 退出。这是 pnpm 对 Git 包 `prepare: tsdown` 的安全拦截。

失败应当是原子的：profile 不应新增 dependency、bundle、lockfile 或插件安装目录。

### 3. 添加精确构建授权和宿主 peer 规则

编辑：

```text
$DSH_HOME/profiles/web/pnpm-workspace.yaml
```

保留既有内容并合并：

```yaml
allowBuilds:
  '@oldsan888/dsh-global-memory@git+https://github.com/oldsan888/dsh-global-memory.git#4fc9bed446835682fd66dacd6451a71d84408ba2': true

peerDependencyRules:
  ignoreMissing:
    - '@deepseek-ai/*'
```

注意：

- `allowBuilds` 键必须与 pnpm 当次错误输出完全一致；
- revision 改变后需要审阅新代码并使用新的精确键；
- 已有同名 YAML 字段时应合并，不要重复定义；
- `ignoreMissing` 只消除 profile 安装期无法看见宿主 peers 的静态警告，不会安装第二份 DSH 或 Cordis；
- 不要把 DSH/Cordis peer 改成插件普通 dependencies。

### 4. 重试安装

```powershell
pnpm dsh plugin --profile web add "git+https://github.com/oldsan888/dsh-global-memory.git#4fc9bed446835682fd66dacd6451a71d84408ba2"
```

成功后 profile 应包含：

- dependency 与 bundle：`@oldsan888/dsh-global-memory`；
- lockfile resolution commit：`4fc9bed446835682fd66dacd6451a71d84408ba2`；
- package version：`0.2.0`；
- `lib/index.js` 和 `lib/storage-compat.js`。

## 验收

### 静态检查

```powershell
$profile = Join-Path $env:DSH_HOME 'profiles/web'

pnpm --dir $profile peers check
pnpm dsh --profile web --dump-config |
  Select-String 'global-memory|agent_memories|tool-memory'
```

预期：

- `No peer dependency issues found`；
- `agent_memories: sqlite` 存在；
- `global-memory-storage-compat` 与 `global-memory` 存在；
- 不存在 `tool-memory` 或相关 patch warning；
- profile lockfile 指向已审阅的完整 commit。

### 启动检查

```powershell
pnpm dsh --profile web
```

检查：

- Web 服务正常监听；
- 没有插件加载、模块解析、注入、重复工具或 schema 错误；
- `$DSH_HOME/storages/agent-memories.db` 被创建；
- Node 可能输出 SQLite experimental warning，该提示本身不代表加载失败。

### 功能检查

在第一个测试会话中：

```text
请调用 memory_write 保存：我偏好简洁的中文技术说明。
使用 key=validation-writing-style、scope=profile、kind=preference、
basis=user-stated、sensitivity=normal、importance=0.7。
```

在第二个新会话中：

```text
请调用 memory_recall，query 使用“中文技术说明”，scope 使用 profile，
并报告 returned、matchedTotal、truncated 和召回正文。
```

最后重启 DSH，并在第三个新会话中再次召回。完整验收标准：

1. 写入成功；
2. 新会话召回正文一致；
3. `returned >= 1`；
4. 重启后仍可召回；
5. 数据库只写入目标 `DSH_HOME`。

## 配置

不要直接修改 `node_modules` 中的安装副本。使用：

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

启动 DSH 的进程必须能读取对应环境变量。不要把 API Key 写入 Git、README、日志或公开 profile。

可选 profile bootstrap：

```yaml
- id: global-memory
  config:
    profileBootstrap:
      content: 用户明确确认的简洁画像，最多 900 字符。
```

默认不创建画像。Bootstrap 只在 `agent-memory-profile` 不存在时创建一次，不覆盖现有 active profile。

完整配置语义见[技术参考](./TECHNICAL-REFERENCE.md)。

## 备份、升级与卸载

### 备份

停止 DSH 后备份：

```text
$DSH_HOME/storages/agent-memories.db*
```

停止服务后复制可以避免遗漏 WAL 中尚未 checkpoint 的数据。恢复时也应先停止 DSH。

### 升级

1. 阅读目标 revision 的 diff、README 和 `package.json`；
2. 停止 DSH 并备份数据库；
3. 使用新的完整 commit 重新执行 `plugin add`；
4. 加入 pnpm 输出的新精确 `allowBuilds` 键；
5. 安装成功后移除旧 revision 授权键；
6. 重跑静态、启动、跨会话和重启验收。

### 卸载

```powershell
pnpm dsh plugin --profile web remove @oldsan888/dsh-global-memory
```

随后移除 profile overlay 中只属于本插件的配置和旧 `allowBuilds` 键。

卸载不会自动删除 `agent-memories.db*`。只有确认不再需要恢复后，才应在 DSH 已停止且已有备份的情况下处理数据库。

## 常见问题

### `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

复制 pnpm 输出的完整键到目标 profile 的 `pnpm-workspace.yaml`，审阅 revision 后设为 `true`，再重试原命令。

### `Issues with peer dependencies found`

确认 profile 包含：

```yaml
peerDependencyRules:
  ignoreMissing:
    - '@deepseek-ai/*'
```

不要额外安装 DSH/Cordis 宿主副本。

### `patch: entry "tool-memory" not found`

0.2.0 不包含该 patch。出现提示通常说明 profile 仍安装旧 commit。检查 package、bundle、lockfile resolution 和安装目录中的 `package.json`。

### 修改配置后没有生效

使用 profile 的 `cordis.patch.yml` overlay 并重启 DSH。只修改另一个本地 checkout 不会改变 profile 中已经安装的副本。

## AI 安装代理检查清单

1. 阅读 README、`package.json`、`cordis.patch.yml` 和目标 revision diff；
2. 明确目标 DSH commit、`DSH_HOME`、profile 和插件 commit；
3. 不用本地 `file:` 路径代替公开 Git 验证；
4. 只添加 pnpm 实际输出的精确 `allowBuilds` 键；
5. 保留宿主 API 为 peers，不重复安装 DSH/Cordis；
6. 检查 lockfile 的完整 Git commit；
7. 完成 peer、配置、启动、写入、跨会话与重启验收；
8. 检查旧 Home 没有写入；
9. 不输出 API Key、启动 token、Cookie 或其他凭据；
10. 未经授权，不删除数据库、不启用 embedding、不推送代码。
