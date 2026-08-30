# @oldsan888/dsh-global-memory

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的全局长期记忆插件。

它通过 DSH 的 bundle/profile 机制安装，不修改 DSH 源码，也不依赖私人分支。插件为同一个 `DSH_HOME` 中的会话提供共享 SQLite 记忆库，使模型可以跨会话保存和召回稳定信息。

## 作用

- 跨会话写入和召回长期记忆；
- 按逻辑 key 更新记忆并保留有限 revision；
- 支持软退役、永久删除和只读健康检查；
- 在会话首回合自动注入有界、低优先级的可信记忆；
- 可选关键词 + embedding 双路召回；Embedding 默认关闭；
- 数据保存在目标 Home 的 `storages/agent-memories.db`。

模型工具：

| 工具 | 作用 |
|---|---|
| `memory_write` | 写入或更新长期记忆 |
| `memory_recall` | 按 query 和可选 scope 召回 |
| `memory_retire` | 软退役，不再召回或注入 |
| `memory_delete` | 永久删除正文并留下最小审计收据 |
| `memory_status` | 返回不含正文的健康快照 |

## 兼容性

| 组件 | 已验证版本 |
|---|---|
| 插件 | `0.2.0` |
| 插件运行代码 | `4fc9bed446835682fd66dacd6451a71d84408ba2` |
| DSH 源码宿主 | `0.1.2-alpha.1`，commit `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| DSH npm 构建 API | `0.1.1-rc.2` |
| Cordis | `4.0.1` |

DSH 当前仍是 prerelease。插件只声明精确 peer contract：

```text
0.1.1-rc.2 || 0.1.2-alpha.1
```

其他版本需要先在独立 `DSH_HOME` 中复验。

## 安装入口

先显式设置目标 `DSH_HOME`，然后在 DSH 源码目录执行：

```powershell
$env:DSH_HOME = 'E:\path\to\dsh-home'

pnpm dsh plugin --profile web add "git+https://github.com/oldsan888/dsh-global-memory.git#4fc9bed446835682fd66dacd6451a71d84408ba2"
```

Git 安装首次通常会被 pnpm 的 `allowBuilds` 安全策略拦截。请按照[安装与运维指南](./docs/INSTALLATION.md)添加精确授权键并完成验收，不要把首次拦截当作插件构建失败。

## 默认边界

- 记忆只在同一个 `DSH_HOME` 中共享；会话不是记忆隔离边界。
- Embedding 默认关闭，关键词写入与召回不依赖外部 embedding 服务。
- 插件不自动识别所有敏感语义；不要保存密码、token、支付信息或私密凭据。
- 插件只承诺单 DSH 进程内同 key 操作串行化，不支持多个进程共享写入一个数据库。
- 插件不查找、禁用或替换非官方的 `tool-memory`。

## 文档索引

- [安装与运维](./docs/INSTALLATION.md)：Git 安装、`allowBuilds`、peer 配置、验收、配置、升级、备份、卸载和故障处理。
- [技术参考](./docs/TECHNICAL-REFERENCE.md)：工具契约、分类、自动注入、embedding、数据治理与安全边界。
- [验证报告](./docs/VALIDATION.md)：公开可复核的环境、步骤、证据和结论。

## 目录

```text
dsh-global-memory/
├─ cordis.patch.yml          # DSH bundle patch
├─ src/                      # 插件实现
├─ tests/                    # 行为、生命周期和发布契约测试
├─ docs/                     # 安装、技术参考和验证报告
├─ pnpm-workspace.yaml       # pnpm 11 构建期 peer 闭包
├─ tsdown.config.ts          # Node ESM 构建
└─ README.md
```

## 本地开发

```powershell
pnpm install --frozen-lockfile
pnpm peers check
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run
```

## License

[MIT](./LICENSE)
