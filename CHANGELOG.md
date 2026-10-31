# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-31

First public release.

### Added

- `sync` — bidirectional union merge between two machines through a relay directory
  (USB stick, network share, anything with a filesystem). Also the zero-argument
  double-click mode: it seeds the relay on the first run and merges afterwards.
- `pack` / `restore` — one-way snapshots for moving to a brand-new machine.
- `status` — show what a DSH home contains and where the tool thinks the workspace is.
- Path rewriting on every boundary: session header `cwd`, `storages/workspace.json`,
  `link:` dependencies in `package.json` and `pnpm-lock.yaml` (the lockfile form is
  relative to the profile directory, so it is recomputed even when the absolute path
  is unchanged), and the derived session project directory name.
- Session logs are rewritten by recompressing **only** the first zstd frame; the rest
  is copied byte-for-byte, because the format requires a one-line header frame.
- Discovery-based sync scope: every top-level directory under `~/.dsh` that is not
  machine-bound is merged, so plugins installed later (with their own data
  directories, or private files inside their profile) are covered without changes.
- Session merge covers project directories outside the workspace index, so sessions
  opened in other folders are not lost.
- Conflict handling: later write wins for files and for sessions (by last event
  timestamp, not file mtime); the loser is kept as `*.conflict-<timestamp>` on the
  machine that lost, and both copies are re-stamped so the conflict does not repeat.
- Binary-safe `storages/` merge (text files get paths rewritten, binaries are copied).
- Application-running guard: refuses to run while DSH holds the data directory
  (`--force` overrides).
- Plugin health check: if `node_modules` is missing, a dependency is not installed, or
  a `link:` target does not exist (typical after copying `.dsh` by hand), the plugin
  install is rerun automatically.
- `--with-plugin-data [dir,...]` to merge plugin data directories outside `~/.dsh`
  (defaults to `~/.openviking` and `~/.hindsight` when the flag has no value).
- `--dry-run`, `--force`, `--no-install`, `--home`, `--workspace-root`,
  `--with-git`, `--with-credentials`, `--version`, `--help`.
- `dsh-migrate.cmd` launcher that finds the Node runtime bundled with DSH, so users do
  not need a separate Node install.
