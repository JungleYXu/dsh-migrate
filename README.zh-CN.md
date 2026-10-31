# dsh-migrate

在两台电脑之间搬运 **DeepSeek Harness** 的全部东西——对话、插件、插件配置、工作区文件——用一个 U 盘当中转，双击一次就行。

> **非官方工具。** 它不属于 DeepSeek Harness 官方，读写的是 DSH 私有的磁盘格式，DSH 升级后可能失效。第一次运行前请先手工备份一份 `~/.dsh`（见 [已知限制](docs/KNOWN-LIMITATIONS.md)）。
>
> **仅支持 Windows 10/11**（依赖 `cmd.exe`、NTFS junction 和 Windows 版 Electron）。
>
> [English README](README.md)

---

## 为什么需要它

DeepSeek Harness 把所有东西都放在本机：`~/.dsh` 里是会话日志、插件 profile 和登录凭证，而工作区目录在别的地方。它没有云同步——换一台机器登录，得到的是一个空安装。

直觉上"拷 `~/.dsh` 过去"应该能行，但有三处一定会断：

1. **工作区不在 `~/.dsh` 里。** 对话中产生的文件在你的工作目录里，只拷 `.dsh` 永远带不走。
2. **开发中的插件是 `link:` 绝对路径依赖**（例如 `"dsh-loadout": "link:C:/Users/…/workspace/dsh-loadout"`）。换台机器这个路径不存在，插件就装不上、也用不了。
3. **`node_modules` 和 `dsh-runtimes` 与本机绑定**（绝对软链 + 编译产物），只能在新机器上重装，不能拷。

还有一个更隐蔽的：会话日志里的 `cwd`、`storages/workspace.json` 里的 `path`、以及会话的项目目录名，全都按**绝对路径**取值。换一台用户名不同的机器，历史对话会从侧栏里静默消失。

`dsh-migrate` 处理这些事：拷走可迁移的部分、把每个绝对路径改写成目标机器的、重建插件安装；如果两台机器各用了一段时间，它做的是**合并**，而不是用一边覆盖另一边。

## 三种用法

| 命令 | 什么时候用 |
| --- | --- |
| `sync`（也就是无参数双击模式） | 公司/家里两台机器每天来回接力 |
| `pack` | 第一次去一台全新机器，或想留一个固定快照 |
| `restore` | 从 `pack` 的快照装回去 |

`sync` 是**并集合并**：两边新增的会话、文件、插件都保留。只有同一个文件或同一个会话两边都改过时才需要裁决——后写的那份胜出，输的那份另存为 `*.conflict-<时间戳>`，不会丢。

## 快速开始（U 盘，两台机器）

1. 把 `dsh-migrate.cmd` 和 `dsh-migrate.mjs` 放到 U 盘根目录（不要放进工作区文件夹里）。
2. 在机器 A：**完全退出** DeepSeek Harness（关窗口不算，从托盘图标退出），双击 `dsh-migrate.cmd`。第一次运行需要几秒，写出一个约 50 MB 的中转站；空 U 盘上这次就是"打底"。
3. 在机器 B：先装好 DeepSeek Harness 并启动一次（让它下载内置 Node 运行时），退出应用，插上 U 盘，双击 `dsh-migrate.cmd`。它会先备份 B 原有的 `~/.dsh`，合并两边，按 B 的用户目录改写路径，并重新安装插件。
4. 之后每次换机前双击一次即可。

不要在 DSH 运行中执行。工具会检测数据目录是否被占用并拒绝执行；`--force` 可以强行跳过，后果自负。

## 命令行

```text
node dsh-migrate.mjs sync    --with <中转目录> [--home <DSH_HOME>] [--with-plugin-data [目录名,...]] [--no-install] [--no-delete] [--no-backup] [--dry-run]
node dsh-migrate.mjs pack    --out <目录>      [--home <DSH_HOME>] [--with-credentials] [--with-git] [--with-plugin-data [目录名,...]] [--force]
node dsh-migrate.mjs restore --in <目录>       [--home <DSH_HOME>] [--workspace-root <目录>] [--no-install] [--force] [--dry-run]
node dsh-migrate.mjs undo                      [--home <DSH_HOME>] [--list] [--at <时间戳>] [--dry-run]
node dsh-migrate.mjs status                    [--home <DSH_HOME>]
node dsh-migrate.mjs --version | --help
```

所有命令都接受 `--lang zh|en`。

| 参数 | 作用 |
| --- | --- |
| `--home` | 要操作的 DSH home，默认 `$DSH_HOME`，再退回 `~/.dsh`。测副本时很有用。 |
| `--lang zh\|en` | 帮助与进度消息的语言，默认跟随系统区域；`DSH_MIGRATE_LANG` 等效。路径、会话标题、你自己的文件名不会被翻译。 |
| `--workspace-root` | 本机工作区应该放在哪。当记录里的路径在本机不存在时用它。 |
| `--with-plugin-data [目录名,...]` | 一并合并 `~/.dsh` 之外的插件数据目录。不带值：`~/.openviking`、`~/.hindsight`；带值：你点名的目录（相对 `~`）或绝对路径。 |
| `--with-git` | 工作区里连 `.git` 一起搬（默认不搬：体积大，且跨机容易出问题）。 |
| `--with-credentials` | 连 `.credentials.yaml` 一起搬（默认不搬——见下）。 |
| `--no-install` | 跳过 `dsh plugin install`（只想看改动、或准备手工装）。 |
| `--no-delete` | 不传播删除：只做并集合并，本机删掉的文件不会让对面也删。 |
| `--no-backup` | 本次同步不做写前备份（默认会做，见下一节）。 |
| `--dry-run` | 只打印会做什么，不写任何东西。**建议第一次先跑这个。** |
| `--force` | 应用还在运行时也照跑；也用于覆盖已有的中转站。 |

## 同步范围

| 会同步 | 不会同步 |
| --- | --- |
| `sessions/`——所有项目目录，包括不在工作区索引里（在别的文件夹开过）的会话 | `node_modules/`、`dsh-runtimes/`、`cache/`、`logs/` |
| `storages/`——工作区索引、投影缓存、会话策略（JSON 做路径改写，二进制原样复制） | `*.lock`、`.migrate-tmp`、`~*.tmp` |
| `profiles/<名称>/`——`package.json`、`pnpm-lock.yaml`、cordis 配置，以及插件自己写在这个目录里的私有文件 | `.credentials.yaml`（每台机器各自登录一次，之后一直保留） |
| `~/.dsh` 下**其它所有顶层目录**——运行时发现，所以以后装了自带数据目录的新插件也不用改工具 | 未加 `--with-plugin-data` 时的 `~/.openviking/`、`~/.hindsight/` |
| 工作区文件（默认排除 `.git`） | Electron 的 `Local Storage`（快捷键配置在那里） |
| 可选的插件数据目录（`--with-plugin-data`） | |

这种"发现式"范围是刻意的：工具不维护插件白名单。某个插件建了 `~/.dsh/my-plugin/`，它就会被合并；某个插件在 profile 目录里写了自己的配置文件，也会被合并。

## 路径改写

三处带绝对路径，每次跨机器都改写：

- 每条会话日志第一帧里的 `cwd`；
- `storages/workspace.json` 的 `tables.workspaces.<id>.path`；
- `profiles/*/package.json` 的 `link:`（绝对路径）与 `profiles/*/pnpm-lock.yaml` 的 `link:`（**相对 profile 目录**，所以即使绝对路径没变也必须重算）。

会话的项目目录名（`--C-Users-…-workspace--`）是由 cwd 推出来的，所以要和头行一起改名。改写方式是**只重压第一帧 zstd、其余帧原样拼接**——原因见下。

## 冲突怎么裁决

- **文件**：时间差超过 2 秒，后写的赢并复制到对侧。时间差在 2 秒内则先比内容；内容不同就按字节序确定一个胜者（两边算的是同一对字节，一轮之后必然一致），输的另存 `<文件名>.conflict-<时间戳>`，并把两边时间戳都设为"刚刚"，下一轮直接跳过。
- **会话日志**：两边都追加了事件。胜者按**最后一条事件的时间**判断（文件 mtime 不可靠：复制会重置它），再用 mtime 与字节序兜底。输的另存 `session.vN.jsonl.zstd.conflict-<时间戳>`。

`*.conflict-*` 文件只留在产生它的那台机器上，不参与同步。

## 删除怎么传播

只做并集的话，一边删掉的文件会被另一边推回来——删了等于没删。所以同步时也记「墓碑」：

- 上次同步时还在、这次本机没有的文件，视为删除：中转站里那份一起删掉，并记一条墓碑（路径 + 时间）。
- 另一台同步时按墓碑删本地那份——**但只在本机这份比墓碑更旧时才删**。删完之后你又改过的文件会留下（复活），并重新推回中转站，下一轮两台又一致。
- 以下路径不参与删除传播：`storages/workspace.json`、profile 的 `package.json` / `cordis*.yml` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`。这些是 DSH 和插件管理器会自己重建的东西，删错代价远大于多留一份。
- 墓碑在中转站的 `state.json` 里，保留 30 天；本机「上次快照」存在 `~/.dsh/.dsh-migrate-state.json`（只在本机，不同步——否则另一台会把自己没拉过的新文件当成删除）。

不想要这个行为，加 `--no-delete`：只合并不删，删掉的东西下次同步会回来。

## 回滚：每次同步都留一份被改掉的文件

合并要判断「哪一份更新」，判断错了、或者插件写的东西被覆盖了，你想要的不是一场关于冲突语义的讨论，而是把上一份文件拿回来。所以每次 `sync` 在覆盖或删除本机任何文件之前，都会先把它复制到：

```text
~/.dsh/.dsh-migrate-backup/<YYYYMMDD-HHMMSS>/<scope>/<相对路径>
```

只复制「即将被改动」的那几个文件，一次通常几百 KB 到几 MB，不是又存 50 MB。保留最近 **5** 次，更早的自动清掉。

```text
node dsh-migrate.mjs undo --list                  # 有哪些备份
node dsh-migrate.mjs undo                         # 回滚最近一次同步
node dsh-migrate.mjs undo --at 20261031-204101    # 回滚指定的那一次
node dsh-migrate.mjs undo --dry-run               # 只列出会恢复哪些文件
```

`undo` 会按备份清单里记录的各 scope 根目录把文件放回原处（所以就算你后来把工作区挪了位置也能对上）。回滚之后建议再跑一次 `sync`，让两台机器重新对齐——中转站里还留着刚被你回滚掉的那个版本。

一次没有改动任何文件的同步不会留下备份目录。如果你自己有快照机制，加 `--no-backup` 关掉它。

`restore` 是另一套、从 1.0 就有的机制：它先把整个现有 DSH home 改名成 `<home>.bak-<时间戳>` 再写入，然后把本机专属的 `dsh-runtimes`、`cache`、`logs`、`.credentials.yaml` 搬回去。那是更大的锤子，保留不动。

## 它是怎么做到的

（下面这些是从 `app.asar` 源码里核对过的，方便你验证或移植。）

- 会话日志是**多帧拼接的 zstd**，而格式硬性要求**第一帧恰好是一行 header**。整文件重压会让会话读不出来。工具用二分找到第一帧边界，只重编这一帧（校验和选项与应用一致），尾部字节原样追加。
- 项目目录名 = `--` + 规范化后的 cwd + `--`：`/`、`\`、`:` 的连续段折叠成一个 `-`，`[A-Za-z0-9._-]` 之外的字符变成 `~XXXX`，去掉前导 `-`/`+`。
- 整个 DSH home 可以只靠 `sessions/` + `storages/` + `profiles/` 加工作区重建出来。

工具本身是一个零依赖的 ES module，只用 `node:fs`、`node:path`、`node:os`、`node:zlib`、`node:child_process`。

## 运行要求

- Windows 10/11。
- 已安装 DeepSeek Harness 桌面版（启动器会复用它的内置 Node）。
- 如果直接跑 `.mjs`，需要 Node.js **22.15+** 或 24+（改写会话日志需要 `zlib.zstdCompressSync` / `zstdDecompressSync`）。版本不够时工具会明确报错退出。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `[x] 当前 Node 是 … 没有内置 zstd 接口` | 用 `dsh-migrate.cmd`（它找 DSH 的 Node），或安装 Node 24。 |
| `[!] 请先完全退出 DeepSeek Harness` | 从托盘退出，再运行。 |
| 另一台机器上看不到某些会话 | 工作区路径不一致，加 `--workspace-root`；侧栏只显示 `storages/workspace.json` 里登记的会话。 |
| 插件在列表里但加载失败 | 它的 `link:` 目标在这台机器上不存在。修好路径后跑 `dsh plugin --profile <名称> install`。 |
| 每次同步都报同一个冲突 | 正常情况下最多报一轮；如果持续报，多半是一侧只读，或另一侧应用还在写。 |
| 同步很慢 | 第一次要搬约 50 MB；之后只搬差异（没有变化时约 0.2 秒）。大头是附件和 `--with-git`。 |

## 风险

把它指向你唯一的一份数据之前，请先读 [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md)。简单说：它会真的往 `~/.dsh` 和工作区写文件，依赖未公开格式，而且只在一台真实安装 + 合成测试样本上验证过，不是在大量用户环境里验证过。

## 许可证

MIT，见 [LICENSE](LICENSE)。
