# dsh-migrate

Move **DeepSeek Harness** between two computers — conversations, plugins, plugin settings and workspace files — with one double-click, using a USB stick or any shared folder as the relay.

> **Unofficial.** This is a community tool, not part of DeepSeek Harness. It reads and writes DSH's private on-disk format. A future DSH release can break it. Always take a copy of `~/.dsh` before the first run (see [Failure modes](docs/KNOWN-LIMITATIONS.md)).
>
> **Windows only** (10/11). It relies on `cmd.exe`, NTFS junctions and the Windows Electron build.
>
> [中文说明](README.zh-CN.md) · Tool output is in Chinese; the source is commented in Chinese.

---

## Why this exists

DeepSeek Harness keeps everything on the machine: `~/.dsh` holds the session logs, the plugin profile and the credentials, and your workspace folder sits somewhere else entirely. There is no cloud sync — signing in on another computer gives you an empty install.

Copying `~/.dsh` by hand looks like it should work, but three things break:

1. **The workspace is not inside `~/.dsh`.** Files you created during a conversation live in your working folder. Copy only `.dsh` and they stay behind.
2. **A plugin you are developing is a `link:` dependency** pointing at an absolute path (`"dsh-loadout": "link:C:/Users/…/workspace/dsh-loadout"`). On the second machine that path does not exist, so the plugin never loads.
3. **`node_modules` and `dsh-runtimes` are machine-bound.** They contain absolute symlinks and compiled binaries; they must be rebuilt, not copied.

There is also a subtler one: session logs, `storages/workspace.json`, and the session directory name are all keyed by the **absolute** workspace path. Move to a machine with a different user name and the history silently disappears from the sidebar.

`dsh-migrate` handles all of that: it copies the portable state, rewrites every absolute path to the target machine, rebuilds the plugin install, and — when both machines have been used separately — merges the two histories instead of overwriting one with the other.

## What it does

| Command | Use it when |
| --- | --- |
| `sync` (also the zero-argument double-click mode) | Daily back-and-forth between an office and a home machine |
| `pack` | First trip to a brand-new machine, or you want a frozen snapshot |
| `restore` | Install from a `pack` snapshot |

`sync` is a **union merge**: sessions, files and plugins added on either side are kept. When the same file or the same session was modified on both machines, the later write wins and the losing copy is saved next to it as `*.conflict-<timestamp>` so nothing is lost.

## Quick start (USB stick, two machines)

1. Copy `dsh-migrate.cmd` and `dsh-migrate.mjs` to the root of the USB stick (not into the workspace folder).
2. On machine A: quit DeepSeek Harness **completely** (closing the window is not enough — exit from the tray icon), then double-click `dsh-migrate.cmd`. First run takes a few seconds and writes a ~50 MB relay. If the stick is empty this is the "seed" run.
3. On machine B: install DeepSeek Harness, start it once (so it downloads its bundled Node runtime), quit it, plug the stick in, double-click `dsh-migrate.cmd`. It backs up B's existing `~/.dsh`, merges both sides, rewrites paths for B's user profile and reinstalls the plugins.
4. Thereafter, whichever machine you leave, double-click once before switching. That is the whole ritual.

Do not run it while DSH is open. The tool detects a locked data directory and refuses; `--force` overrides that, at your own risk.

## Command line

```text
node dsh-migrate.mjs sync    --with <relay-dir> [--home <DSH_HOME>] [--with-plugin-data [dir,...]] [--no-install] [--no-delete] [--dry-run]
node dsh-migrate.mjs pack    --out <dir>        [--home <DSH_HOME>] [--with-credentials] [--with-git] [--with-plugin-data [dir,...]] [--force]
node dsh-migrate.mjs restore --in <dir>         [--home <DSH_HOME>] [--workspace-root <dir>] [--no-install] [--force] [--dry-run]
node dsh-migrate.mjs status                     [--home <DSH_HOME>]
node dsh-migrate.mjs --version | --help
```

Every command also accepts `--lang zh|en`.

| Flag | Meaning |
| --- | --- |
| `--home` | DSH home to act on. Defaults to `$DSH_HOME`, then `~/.dsh`. Handy for testing against a copy. |
| `--lang zh\|en` | Output language for the help text and progress messages. Defaults to the system locale; `DSH_MIGRATE_LANG` works too. Paths, session titles and user file names are never translated. |
| `--workspace-root` | Where the workspace should live on this machine. Use it when the workspace is not at the recorded path. |
| `--with-plugin-data [dir,...]` | Also merge plugin data directories outside `~/.dsh`. Without a value: `~/.openviking`, `~/.hindsight`. With a value: those names (relative to `~`) or absolute paths. |
| `--with-git` | Include `.git` in workspace copies (off by default: it is large and rewrites badly). |
| `--with-credentials` | Include `.credentials.yaml` (off by default — see below). |
| `--no-install` | Skip `dsh plugin install` (dry runs, CI, or when you want to install by hand). |
| `--no-delete` | Do not propagate deletions; keep the merge union-only. |
| `--dry-run` | Print what would change, write nothing. Start here. |
| `--force` | Run even if DSH appears to be running; also allows overwriting an existing bundle. |

## What gets synced

| Included | Skipped |
| --- | --- |
| `sessions/` — every project directory, including sessions opened outside the registered workspace | `node_modules/`, `dsh-runtimes/`, `cache/`, `logs/` |
| `storages/` — workspace index, projection cache, session policy (JSON is path-rewritten; binaries are copied byte-for-byte) | `*.lock`, `.migrate-tmp`, `~*.tmp` |
| `profiles/<name>/` — `package.json`, `pnpm-lock.yaml`, cordis config, and any private files the plugins wrote there | `.credentials.yaml` (each machine signs in once, then keeps its own token) |
| Every other top-level directory in `~/.dsh`, discovered at run time — so plugins installed later with their own data folders are covered without changing the tool | `~/.openviking/`, `~/.hindsight/` unless `--with-plugin-data` |
| Workspace files (excluding `.git` unless `--with-git`) | Electron `Local Storage` (keybindings live there) |
| Optional: plugin data directories, via `--with-plugin-data` | |

Discovery is deliberate: the tool does not keep a list of known plugins. If a plugin creates `~/.dsh/my-plugin/`, that directory is merged like everything else, and a plugin that writes a private file inside its profile directory is merged too.

## Path rewriting

Three things carry absolute paths and are rewritten on every sync boundary:

- the `cwd` field in the first frame of each session log,
- `storages/workspace.json` (`tables.workspaces.<id>.path`),
- `link:` dependencies in `profiles/*/package.json` (absolute) and `profiles/*/pnpm-lock.yaml` (**relative to the profile directory**, so it must be recomputed even when the absolute path did not change).

The session project directory name (`--C-Users-…-workspace--`) is derived from the cwd, so it is renamed along with the header. The rewrite is done by re-compressing only the first zstd frame of the log and appending the remaining frames untouched — see [How it works](#how-it-works).

## Conflicts

Both machines edited the same thing:

- **A file** — if the timestamps differ by more than 2 seconds, the newer one wins and is copied to the other side. If they are within 2 seconds, the content is compared; if it differs, the winner is chosen deterministically by byte order (so both machines agree on the same winner in one round), the loser is saved as `<name>.conflict-<timestamp>`, and both copies are stamped "now" so the next sync does not report it again.
- **A session log** — the divergence is real (both appended events). The winner is the one whose **last event timestamp is later** (file mtime is unreliable: copying resets it), with mtime and byte order as fallbacks. The loser is saved as `session.vN.jsonl.zstd.conflict-<timestamp>`.

`*.conflict-*` files stay on the machine that produced them and are never synced.

## How deletions travel

A pure union would resurrect anything you delete on one machine — the other machine still has it and pushes it right back. So `sync` also keeps tombstones:

- A file that was present at the last sync and is gone now counts as deleted: the relay copy is removed too, and a tombstone (path + time) is recorded in the relay's `state.json`.
- The other machine applies that tombstone — but **only if its own copy is older than the tombstone**. A file you edited after the deletion survives (it "resurrects"), is pushed back to the relay, and both machines agree again on the next round.
- These paths never propagate deletions: `storages/workspace.json` and a profile's `package.json` / `cordis*.yml` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`. DSH and the plugin manager recreate them; deleting them by mistake costs far more than keeping one extra copy.
- Tombstones live in the relay (`state.json`, kept 30 days). Each machine's "last snapshot" lives in `~/.dsh/.dsh-migrate-state.json` and is never synced — if it were shared, a machine would mistake files it has not pulled yet for deletions.

Pass `--no-delete` to keep the old behaviour: merge only, deleted files come back on the next sync.

## How it works

Facts taken from `app.asar` sources, in case you want to verify or port them:

- Session logs are **multi-frame zstd**, and the format requires that **the first frame is exactly one header line**. Recompressing the whole file breaks it. `dsh-migrate` finds the first frame boundary by binary search, rewrites only that frame (with the same checksum option the app uses), and appends the original tail bytes.
- The project directory name is `--` + a normalized cwd + `--`: runs of `/`, `\`, `:` collapse to a single `-`, characters outside `[A-Za-z0-9._-]` become `~XXXX`, leading `-`/`+` are stripped.
- Sub-sessions inherit `~/.dsh` layout, so a whole DSH home can be reconstructed from `sessions/` + `storages/` + `profiles/` plus the workspace.

The tool is a single dependency-free ES module using only `node:fs`, `node:path`, `node:os`, `node:zlib` and `node:child_process`.

## Requirements

- Windows 10/11.
- DeepSeek Harness desktop installed (the launcher reuses its bundled Node runtime).
- Node.js **22.15+** or 24+ if you run the `.mjs` directly — the session-log rewrite needs `zlib.zstdCompressSync` / `zstdDecompressSync`. The tool checks this and exits if the runtime is too old.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `[x] 当前 Node 是 … 没有内置 zstd 接口` | Use `dsh-migrate.cmd` (it finds DSH's Node), or install Node 24. |
| `[!] 请先完全退出 DeepSeek Harness` | Exit from the tray icon, then retry. |
| Sessions are missing on the other machine | Check the workspace path is the same, or pass `--workspace-root`. The sidebar shows sessions listed in `storages/workspace.json`. |
| A plugin is listed but fails to load | The `link:` target path does not exist on this machine. Run `dsh plugin --profile <name> install` after fixing the path, or delete the dependency. |
| Both machines keep reporting the same conflict | That should not happen after one round; if it does, one side is read-only or being written by a running app. |
| Sync is slow | The first run copies ~50 MB. Later runs only move the diff (~0.2 s when nothing changed). Large attachments and `--with-git` dominate. |

## Failure modes

Read [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) before pointing this at the only copy of your data. In short: it writes real files in `~/.dsh` and your workspace, it depends on undocumented formats, and it has been tested with a single real installation plus synthetic fixtures — not on a fleet of user setups.

## License

MIT — see [LICENSE](LICENSE).
