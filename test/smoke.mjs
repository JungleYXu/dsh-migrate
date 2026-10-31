// Smoke test for dsh-migrate.
//
// Builds two synthetic DSH homes (no real installation needed beyond a Node with
// zstd support), then exercises pack -> restore and a two-machine sync, asserting
// the properties the tool promises: union merge, path rewriting, unknown-plugin
// coverage, binary safety, and idempotence.
//
//   node test/smoke.mjs
//
// Everything happens under a temporary directory that is removed afterwards.
// The CLI is always called with --force so an already running DSH does not
// block the test.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CLI = fileURLToPath(new URL('../dsh-migrate.mjs', import.meta.url));
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(`--- command failed: ${args.join(' ')}`);
    console.log(r.stdout || '');
    console.log(r.stderr || '');
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runEnv(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.log(`--- command failed: ${args.join(' ')}`);
    console.log(r.stdout || '');
    console.log(r.stderr || '');
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// 中文或全角标点都算「还没翻译干净」。
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

// ---- fixture helpers -------------------------------------------------------


function projectKey(cwd) {
  // Mirrors the tool's own derivation; used only to place fixtures.
  let s = cwd
    .replace(/[\\/:]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, (c) => '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
    .replace(/^[-+]+/, '');
  return `--${s.slice(0, 251)}--`;
}

function writeSession(home, cwd, id, note) {
  const dir = path.join(home, 'sessions', projectKey(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1760000000000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  };
  const head = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), CHECKSUM);
  const event = zlib.zstdCompressSync(
    Buffer.from(JSON.stringify({ type: 'turn/end', seq: 1, time: 1760000000000, note }) + '\n', 'utf8'),
    CHECKSUM,
  );
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([head, event]));
}

function writeWorkspaceIndex(home, id, wsPath, sessionIds) {
  const file = path.join(home, 'storages', 'workspace.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = {
    version: 3,
    global: { workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        [id]: { id, path: wsPath, name: path.basename(wsPath), sessionIds },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function writeProfile(home, deps) {
  const dir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'desktop', dependencies: deps }, null, 2));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- name: ui-chat\n  config:\n    transcriptView: standard\n');
}

function makeHome(root, tag, extraSessionCwd) {
  const home = path.join(root, `home-${tag}`);
  const ws = path.join(root, `ws-${tag}`, 'default-workspace');
  fs.mkdirSync(ws, { recursive: true });

  const wsId = `ws-${tag}`;
  writeSession(home, ws, `session-main-${tag}`, `main ${tag}`);
  writeWorkspaceIndex(home, wsId, ws, [`session-main-${tag}`]);
  writeProfile(home, { 'some-plugin': '^1.0.0' });

  // A session opened outside the registered workspace, i.e. not in any index.
  writeSession(home, extraSessionCwd, `session-stray-${tag}`, `stray ${tag}`);

  // A plugin data directory the tool has never heard of.
  const unknown = path.join(home, 'made-up-plugin');
  fs.mkdirSync(unknown, { recursive: true });
  fs.writeFileSync(path.join(unknown, 'state.json'), JSON.stringify({ from: tag }, null, 2));
  fs.writeFileSync(path.join(home, 'custom-notes.txt'), `notes from ${tag}\n`);

  // Binary storage payload: must be copied byte for byte.
  const blobs = path.join(home, 'storages', 'blobs');
  fs.mkdirSync(blobs, { recursive: true });
  fs.writeFileSync(path.join(blobs, `${tag}.db`), Buffer.from([0x00, 0x01, 0x02, tag.charCodeAt(0), 0xff, 0x00]));

  // Machine-bound things that must never be synced.
  fs.mkdirSync(path.join(home, 'dsh-runtimes', 'dummy'), { recursive: true });
  fs.writeFileSync(path.join(home, 'dsh-runtimes', 'dummy', 'marker.txt'), 'runtime\n');
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', 'c.bin'), 'cache\n');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), `token: secret-of-${tag}\n`);

  // The workspace side.
  fs.writeFileSync(path.join(ws, 'README.md'), `# workspace ${tag}\n`);

  return { home, ws, wsId };
}

function sessionIds(home) {
  const root = path.join(home, 'sessions');
  const out = new Set();
  for (const proj of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const id of fs.readdirSync(dir)) out.add(id);
  }
  return out;
}

function readHeader(home, id) {
  const root = path.join(home, 'sessions');
  for (const proj of fs.readdirSync(root)) {
    const file = path.join(root, proj, id, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    // first frame is the header; find the next zstd magic to bound it
    let end = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4);
    if (end < 0) end = buf.length;
    return JSON.parse(zlib.zstdDecompressSync(buf.subarray(0, end)).toString('utf8').trim());
  }
  return null;
}

function exists(...p) {
  return fs.existsSync(path.join(...p));
}

// ---- test ------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-smoke-'));
const A = makeHome(root, 'A', 'C:\\Projects\\other-A');
const B = makeHome(root, 'B', 'C:\\Projects\\other-B');
const C = { root: path.join(root, 'c-old') }; // for restore: deliberately different path
const relay = path.join(root, 'relay');

try {
  console.log(`temp dir: ${root}`);

  console.log('\n[1] --version / --help');
  check(run('--version').stdout.includes('1.0.0'), 'reports a version');
  check(run('--help').status === 0, '--help exits 0');

  console.log('\n[2] pack');
  const packed = path.join(root, 'bundle');
  let r = run('pack', '--out', packed, '--home', A.home, '--force');
  check(r.status === 0, 'pack exits 0', r.stderr);
  check(exists(packed, 'manifest.json'), 'bundle has manifest.json');
  check(exists(packed, 'home', 'storages', 'workspace.json'), 'bundle has storages');
  check(!exists(packed, 'home', 'dsh-runtimes'), 'machine-bound runtimes excluded');
  check(!exists(packed, 'home', '.credentials.yaml'), 'credentials excluded by default');

  console.log('\n[3] restore into a machine with a different layout');
  fs.mkdirSync(C.root, { recursive: true });
  const cws = path.join(C.root, 'ws', 'default-workspace');
  r = run('restore', '--in', packed, '--home', path.join(C.root, 'home'), '--workspace-root', path.join(C.root, 'ws'), '--no-install', '--force');
  check(r.status === 0, 'restore exits 0', r.stderr);
  const cHome = path.join(C.root, 'home');
  check(sessionIds(cHome).has('session-main-A'), 'restored session present');
  const hdr = readHeader(cHome, 'session-main-A');
  check(hdr && hdr.cwd === cws, 'session cwd rewritten to the new workspace', hdr && hdr.cwd);
  check(exists(cws, 'README.md'), 'workspace files restored');
  const idx = JSON.parse(fs.readFileSync(path.join(cHome, 'storages', 'workspace.json'), 'utf8'));
  const wid = Object.keys(idx.tables.workspaces)[0];
  check(idx.tables.workspaces[wid].path === cws, 'workspace index path rewritten', idx.tables.workspaces[wid].path);

  console.log('\n[4] first sync seeds the relay (machine A)');
  r = run('sync', '--with', relay, '--home', A.home, '--workspace-root', path.dirname(A.ws), '--no-install', '--force');
  check(r.status === 0, 'seed sync exits 0', r.stderr);
  check(exists(relay, 'home', 'made-up-plugin', 'state.json'), 'unknown plugin dir pushed to relay');
  check(exists(relay, 'userdata') === false, 'no userdata without --with-plugin-data');

  console.log('\n[5] machine B merges');
  r = run('sync', '--with', relay, '--home', B.home, '--workspace-root', path.dirname(B.ws), '--no-install', '--force');
  check(r.status === 0, 'merge sync exits 0', r.stderr);
  const idsB = sessionIds(B.home);
  check(idsB.has('session-main-A') && idsB.has('session-main-B'), 'both main sessions present on B');
  check(idsB.has('session-stray-A') && idsB.has('session-stray-B'), 'sessions from outside the workspace index carried over');
  check(readHeader(B.home, 'session-main-A').cwd === B.ws, 'pulled session cwd rewritten on B', readHeader(B.home, 'session-main-A').cwd);
  check(exists(B.home, 'made-up-plugin', 'state.json'), 'unknown plugin dir pulled to B');
  check(
    fs.readFileSync(path.join(B.home, 'made-up-plugin', 'state.json'), 'utf8') ===
      fs.readFileSync(path.join(relay, 'home', 'made-up-plugin', 'state.json'), 'utf8'),
    'unknown plugin data converged between B and the relay',
  );
  const dbA = fs.readFileSync(path.join(A.home, 'storages', 'blobs', 'A.db'));
  check(dbA.equals(fs.readFileSync(path.join(B.home, 'storages', 'blobs', 'A.db'))), 'binary storage copied byte for byte');
  check(fs.existsSync(path.join(B.home, '.credentials.yaml')), 'credentials untouched on B');
  check(!exists(relay, 'home', '.credentials.yaml'), 'credentials never reach the relay');

  console.log('\n[6] convergence and idempotence');
  run('sync', '--with', relay, '--home', A.home, '--workspace-root', path.dirname(A.ws), '--no-install', '--force');
  const finalA = sessionIds(A.home);
  check(finalA.has('session-main-B') && finalA.has('session-stray-B'), 'A pulled B\'s sessions');
  check(readHeader(A.home, 'session-main-B').cwd === A.ws, 'cwd rewritten back on A');
  check(
    fs.readFileSync(path.join(A.home, 'made-up-plugin', 'state.json'), 'utf8') ===
      fs.readFileSync(path.join(B.home, 'made-up-plugin', 'state.json'), 'utf8'),
    'unknown plugin data converged on both machines',
  );

  for (const m of [A, B, A, B]) {
    r = run('sync', '--with', relay, '--home', m.home, '--workspace-root', path.dirname(m.ws), '--no-install', '--force');
    if (r.status !== 0) check(false, 'idempotent sync exits 0', r.stderr);
  }
  check(/拉入 0/.test(r.stdout) && /推出 0/.test(r.stdout), 'steady state transfers nothing', r.stdout.trim().split('\n').slice(-3).join(' | '));

  const idsA = sessionIds(A.home);
  const idsRelay = sessionIds(path.join(relay, 'home'));
  check(
    [...idsA].sort().join() === [...idsB].sort().join() && [...idsA].sort().join() === [...idsRelay].sort().join(),
    'all three sides hold the same session set',
  );

  console.log('\n[7] --dry-run writes nothing');
  const before = fs.statSync(path.join(B.home, 'storages', 'workspace.json')).mtimeMs;
  r = run('sync', '--with', relay, '--home', B.home, '--workspace-root', path.dirname(B.ws), '--no-install', '--dry-run', '--force');
  check(r.status === 0, 'dry run exits 0', r.stderr);
  check(fs.statSync(path.join(B.home, 'storages', 'workspace.json')).mtimeMs === before, 'dry run left files untouched');
  console.log('\n[8] output language');
  let en = run('--help', '--lang', 'en');
  check(en.status === 0, '--help --lang en exits 0');
  check(!CJK.test(en.stdout), 'help text is fully English', en.stdout.match(/.*[\u4e00-\u9fff].*/)?.[0]);
  check(/move DeepSeek Harness/.test(en.stdout), 'help text is the English variant');

  en = run('sync', '--with', relay, '--home', B.home, '--workspace-root', path.dirname(B.ws), '--no-install', '--dry-run', '--force', '--lang', 'en');
  check(en.status === 0, 'sync --lang en exits 0', en.stderr);
  check(!CJK.test(en.stdout), 'sync progress messages are fully English', en.stdout.match(/.*[\u4e00-\u9fff].*/)?.[0]);
  check(/Sessions/.test(en.stdout) && /Files: pulled/.test(en.stdout), 'English summary lines render');

  en = runEnv({ DSH_MIGRATE_LANG: 'en' }, 'status', '--home', B.home);
  check(!CJK.test(en.stdout), 'DSH_MIGRATE_LANG=en is honoured', en.stdout.match(/.*[\u4e00-\u9fff].*/)?.[0]);

  en = runEnv({ DSH_MIGRATE_LANG: 'zh' }, '--help');
  check(CJK.test(en.stdout), 'DSH_MIGRATE_LANG=zh keeps Chinese output');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('all checks passed');
