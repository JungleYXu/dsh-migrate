# Known limitations

This tool reads and writes DeepSeek Harness's on-disk state directly. That state is a private format, not a public API. Treat every one of the points below as a real risk, not a disclaimer formality.

## Before your first run

- **Back up `~/.dsh` and your workspace yourself.** The tool writes in place. `pack` never modifies anything, so `node dsh-migrate.mjs pack --out D:\backup` is a safe first command.
- **Use `--dry-run` once** to see what a sync would do.
- **Quit DSH completely.** Closing the window leaves the host running; exit from the tray icon. The tool detects a locked data directory and refuses, but `--force` bypasses that check.

## Platform

- **Windows only.** The launcher is a `.cmd` file, plugin links rely on NTFS junctions, and lock detection uses Windows share modes. Nothing has been tested on macOS or Linux. The merge logic itself is portable, but the path and junction handling is not.
- Node **22.15+** or 24+ is required for the zstd frame rewrite. The bundled DSH runtime satisfies this; an old system Node does not.

## Format coupling

- Session logs must remain multi-frame zstd with a one-line header in the **first** frame. The tool rewrites only that frame and copies the rest byte-for-byte. If DSH changes the header shape or the frame layout, the tool may write logs DSH cannot read. It self-checks the rewrite (decompress and compare) before renaming, but that only proves the tool's own round trip.
- The project directory encoding (`--<normalized cwd>--`) is derived from observed behaviour. If DSH changes the normalization, sessions will land in a directory DSH does not look at.
- Session log version numbers (`session.vN`) are discovered, not hard-coded, so a newer log version is copied as a file — but its header `cwd` rewrite is only guaranteed for the versions seen so far.

## Merge semantics

- **Deletions do not propagate.** Sync merges sets. A session or file deleted on one machine reappears on the next sync from the other machine. Delete on both sides, or archive instead.
- **A file edited on both machines within 2 seconds** is resolved by byte order, not by meaning. Both machines agree, and the loser is saved as `*.conflict-<timestamp>`, but the surviving content is arbitrary between the two.
- **A session appended to on both machines** keeps the side with the later last-event timestamp. The other side's later turns are archived in `*.conflict-<timestamp>`, not merged into one transcript. Manually splicing them is not supported.
- **Renames and moves are seen as delete + create.** The old path is restored by the other machine.
- `storages/` files that look like text get absolute paths rewritten. A plugin that stores a path inside a binary blob will keep the old path.

## Deliberately not migrated

- `.credentials.yaml` — each machine signs in once and keeps its own token. `--with-credentials` exists but copying a token across machines is a bad default.
- `node_modules/`, `dsh-runtimes/`, `cache/`, `logs/` — machine-bound. Plugins are reinstalled on the target machine instead.
- Electron `Local Storage` (keybindings and other UI state).
- `~/.openviking/` and `~/.hindsight/` unless `--with-plugin-data` is passed. OpenViking's `pending/` directory is a push queue; merging two machines' queues can cause duplicate uploads.
- Anything outside `~/.dsh` and the workspace, except the plugin data directories you name.

## Operational

- **Two machines syncing through the same relay at the same time is unsupported.** There is no lock. Use it from one machine at a time.
- **The relay is a full copy of portable state** (~50 MB for a fresh install, more with attachments). On FAT32 media, files over 4 GB fail.
- **Large attachments dominate sync time.** `attachments/` is content-addressed, so unchanged objects are skipped cheaply, but the first run copies everything.
- **Plugin reinstall needs network access** the first time on a new machine (pnpm fetches packages). `--no-install` defers that.
- **No integrity manifest.** Files are compared by size and mtime (and content when timestamps are close). A corrupted file with an unchanged mtime is not detected.

## Testing status

Developed and tested on one real Windows installation plus synthetic fixtures covering: two divergent machines, unknown plugin directories, binary storage files, sessions opened outside the registered workspace, same-second conflicts, and repeated idempotent syncs. It has **not** been exercised across a range of DSH versions, locales, or third-party plugin sets. Bug reports with a `--dry-run` transcript are welcome.

## If it breaks

1. Do not run it again.
2. Restore your own backup of `~/.dsh` and the workspace.
3. Open an issue with: DSH version, tool version (`--version`), the command, and the output of `--dry-run`.

`*.conflict-*` files are your safety net for merge decisions: they contain the losing copy of anything that was overwritten.
