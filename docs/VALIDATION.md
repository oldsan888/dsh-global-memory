# 公开验证报告

## 验证目标

确认一个不了解本地开发历史、只获得公开 Git 地址的开发者或 AI 工具，可以在独立 DSH Home 中完成：

1. 固定 revision 安装；
2. 构建授权和 peer 配置；
3. 配置合成与启动；
4. 真实 LLM 写入；
5. 跨会话召回；
6. 跨进程持久化；
7. 旧 Home 零写入。

## 验证环境

| 项目 | 值 |
|---|---|
| 日期 | 2026-08-30 |
| 操作系统 | Windows x64 |
| Node.js | `24.14.0` |
| pnpm | `11.7.0` |
| DSH | `0.1.2-alpha.1` |
| DSH commit | `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| 插件 | `0.2.0` |
| 插件运行 commit | `4fc9bed446835682fd66dacd6451a71d84408ba2` |

LLM 凭据、Web token、Cookie 和本地敏感配置不进入本报告。

## 源码质量检查

| 检查 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm peers check` | 通过，无 peer 问题 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 9 files / 212 tests 通过 |
| `pnpm build` | 通过 |
| `pnpm pack --dry-run` | 通过 |
| `git diff --check` | 通过 |

Dry-run tarball 只包含：

- `cordis.patch.yml`；
- `lib/index.js` 与 source map；
- `lib/storage-compat.js` 与 source map；
- `package.json`；
- README、docs 和 LICENSE。

## 远端 Git 安装

安装源：

```text
git+https://github.com/oldsan888/dsh-global-memory.git#4fc9bed446835682fd66dacd6451a71d84408ba2
```

第一次安装被 pnpm 以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拒绝。检查确认失败原子性成立：profile dependency、bundle、lockfile 和插件目录均未残留。

加入 pnpm 输出的精确 `allowBuilds` 键及 `peerDependencyRules.ignoreMissing: ['@deepseek-ai/*']` 后，第二次安装成功：

- Git 临时 checkout 执行依赖安装；
- `prepare: tsdown` 成功；
- profile lockfile 固定到完整 commit；
- 安装包版本为 `0.2.0`；
- `pnpm peers check` 无问题。

## 配置合成

`pnpm dsh --profile web --dump-config` 退出码为 0：

- `agent_memories: sqlite` 存在；
- `global-memory-storage-compat` 存在；
- `global-memory` 存在；
- `tool-memory` 匹配数为 0；
- 没有 `tool-memory not found` warning。

## 启动与存储

- Web Host 成功监听 `127.0.0.1:3080`；
- 无 token 请求返回 401；完成启动 token 交换后返回 200；
- stderr 只有 Node SQLite experimental warning；
- 没有插件加载、模块解析、服务注入、重复工具或 schema 错误；
- 数据库只创建在目标 Home；
- 表包括 memories、deletions、unit globals 和 units。

## 真实功能闭环

### 写入

独立测试会话要求已配置 LLM 调用 `memory_write`。模型实际发起工具调用，数据库出现一条记录：

```text
content = DSH_MEMORY_V020_REMOTE_GIT_4FC9BED
key = validation-memory-v020
scope = work
kind = fact
basis = user-stated
sensitivity = normal
importance = 0.7
```

记录包含服务端生成的 sessionId、toolCallId 和 contentHash。

### 跨会话召回

第二个新会话实际调用：

```json
{
  "query": "REMOTE_GIT_4FC9BED",
  "scope": "work"
}
```

结果：

```json
{
  "returned": 1,
  "matchedTotal": 1,
  "truncated": false,
  "stale": false
}
```

正文、scope、key、kind 和 basis 与写入一致。该会话在显式召回前也收到了符合规则的自动注入。

### 重启持久化

停止首次 Host，用同一目标 Home 启动新进程。重启后数据库仍有且仅有一条验证记录。

第三个新会话再次实际调用 `memory_recall`，返回同一正文和 `returned=1`、`matchedTotal=1`、`truncated=false`。

## 隔离检查

在启动前、首次运行后和重启验证后，对旧开发 Home 与旧记忆测试 Home 进行排除 `node_modules` 的整树内容指纹比较。

三次比较中，两个旧 Home 的文件数、最新修改时间和组合 SHA-256 摘要均保持一致。确认安装、运行、写入和重启没有写入旧 Home。

## 发现并解决的问题

| 问题 | 原因 | 处理 |
|---|---|---|
| Git prepare 被拒绝 | pnpm 安全策略 | 使用精确 `allowBuilds` 键 |
| profile peer 警告 | DSH 宿主包由运行时 fallback 提供，pnpm 安装期不可见 | `peerDependencyRules.ignoreMissing: ['@deepseek-ai/*']` |
| `tool-memory not found` | 旧插件错误依赖非官方本地定制 | 0.2.0 删除该 patch 与相关声明 |
| alpha 包无法从 npm 安装 | DSH Git 源码与 npm 发布版本错位 | 精确双版本 peer contract，构建使用已发布 rc.2 |
| pnpm 自动选择过旧 peer 闭包 | pnpm 11 prerelease 解析结果 | 仓库 workspace overrides 固定已发布 rc.2 构建闭包 |
| 全新 DSH 缺 client bundle | clone 只有源码 | 启动前执行 DSH `pnpm run build` |

## 结论

`@oldsan888/dsh-global-memory@0.2.0` 在上述精确版本组合中具备：

- 公开 Git 可审阅、可重复安装；
- 安装期依赖和构建边界清晰；
- 配置合成与 Host 装配正常；
- 真实写入、自动注入、跨会话召回正常；
- 跨进程持久化正常；
- 目标 Home 隔离正常。

这不是对任意未来 DSH prerelease 的兼容承诺。升级 DSH 或插件 revision 后应重新执行[安装与运维指南](./INSTALLATION.md)中的验收流程。
