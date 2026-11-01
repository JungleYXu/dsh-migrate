#!/usr/bin/env node
/**
 * dsh-migrate — 把 DeepSeek Harness 的「对话 + 插件 + 工作区文件」整体搬到另一台电脑。
 *
 * 为什么需要它：
 *   1. 会话与插件在 ~/.dsh，但开发中的插件（link: 依赖）指向工作区绝对路径，工作区不在 .dsh 里；
 *   2. node_modules / dsh-runtimes 里全是本机绝对路径与二进制，跨机必断，只能新机重装；
 *   3. 会话目录名、session 日志头里的 cwd、storages/workspace.json 的 path 都绑死绝对路径。
 *
 * 用法：
 *   node dsh-migrate.mjs pack    --out D:\bundle
 *   node dsh-migrate.mjs restore --in  D:\bundle
 *   node dsh-migrate.mjs status
 *
 * 关键约束（来自 app.asar 内 @deepseek-ai/dsh-session-persistence-jsonl 源码）：
 *   - zstd 日志是「多帧拼接」，第一帧必须恰好是头行（含 \n），所以改写只重编第一帧，
 *     其余字节原样保留；
 *   - 项目目录名 = "--" + projectKey(cwd) + "--"，分隔符连续段折叠为一个 "-"。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.1.1';
const FORMAT = 'dsh-migrate/1';
const ZSTD_MAGIC = 0xfd2fb528;
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

/* ------------------------------------------------------------------- i18n */

/*
 * 输出语言：--lang zh|en > DSH_MIGRATE_LANG > 系统区域（zh* 用中文，其余英文）。
 * 文案以中文写在调用点（读代码时最直观），英文靠下面的规则表在输出层替换。
 * 规则按「渲染后的整行」匹配，所以模板字符串里的变量已经填好，可以用捕获组带过去。
 * 只有用户可见的输出过这层；日志内容、路径、会话标题一律原样。
 */
const LANGS = ['zh', 'en'];

function detectLang() {
  const scan = (args) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--lang' && args[i + 1]) return args[i + 1];
      if (args[i].startsWith('--lang=')) return args[i].slice(7);
    }
    return null;
  };
  const fromArg = scan(process.argv.slice(2));
  const fromEnv = process.env.DSH_MIGRATE_LANG || null;
  for (const v of [fromArg, fromEnv]) {
    if (!v) continue;
    const low = String(v).toLowerCase();
    if (LANGS.includes(low)) return low;
    if (low.startsWith('zh')) return 'zh';
    if (low.startsWith('en')) return 'en';
  }
  try {
    const loc = String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
    return loc.startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

const LANG = detectLang();

/** [中文正则, 英文替换]；按顺序匹配，每条命中的都替换一次（一行里可能有多段中文）。 */
const EN_RULES = [
  // ---- 启动 / 守卫
  [/^\[x\] 当前 Node 是 (.+)，没有内置 zstd 接口（需要 Node 22\.15\+ 或 24\+）。$/, '[x] This Node is $1 and has no built-in zstd (Node 22.15+ or 24+ is required).'],
  [/^    请用 DSH 自带的 Node 运行本工具：双击 dsh-migrate\.cmd 即可（它会自动找）。$/, '    Run this tool with the Node bundled with DSH: double-click dsh-migrate.cmd (it finds it for you).'],
  [/^DeepSeek Harness 还在运行，先完全退出它再继续：$/, 'DeepSeek Harness is still running. Quit it completely before continuing:'],
  [/^    \* 关窗口不算，要从托盘图标右键退出（或任务管理器里结束 DeepSeek Harness）。$/, '    * Closing the window is not enough — right-click the tray icon and exit, or end it in Task Manager.'],
  [/^    \* 应用正在写会话日志和插件目录，这时候同步可能被文件占用打断，$/, '    * The app is writing session logs and plugin state; a sync now can be interrupted by locked files,'],
  [/^      刚拉下来的会话也可能被它退出时用内存里的旧索引覆盖掉。$/, '      and sessions just pulled in can be overwritten by its in-memory index when it exits.'],
  [/^    \* 确认无所谓、一定要现在跑，加 --force 跳过这个检查。$/, '    * If you accept that risk, add --force to skip this check.'],

  // ---- 通用错误
  [/^找不到 DSH home：(.+)$/, 'DSH home not found: $1'],
  [/^输出目录在工作区内部：(.+)$/, 'Output directory is inside the workspace: $1'],
  [/^  换一个位置（U 盘根目录最合适），或显式用 --out 指定。$/, '  Pick another location (the root of the USB stick is best), or pass --out explicitly.'],
  [/^  提示：U 盘里请把 dsh-migrate\.cmd 放在 U 盘根目录再双击。$/, '  Hint: put dsh-migrate.cmd at the root of the USB stick and double-click it there.'],
  [/^输出目录非空：(.+)（加 --force 覆盖）$/, 'Output directory is not empty: $1 (add --force to overwrite)'],
  [/^不是迁移包（缺 manifest\.json）：(.+)$/, 'Not a migration bundle (manifest.json is missing): $1'],
  [/^包格式 (.+) 与工具 (.+) 不一致，继续尝试$/, 'Bundle format $1 differs from this build ($2); trying anyway'],
  [/^中转目录在工作区内部：(.+)$/, 'Relay directory is inside the workspace: $1'],
  [/^  U 盘请放在根目录，或用 --with 指定别的位置。$/, '  Put the stick at a drive root, or point --with somewhere else.'],
  [/^已创建空的 DSH home：(.+)$/, 'Created an empty DSH home: $1'],

  // ---- pack
  [/^打包 DSH home：(.+)$/, 'Packing the DSH home: $1'],
  [/^打包工作区（(\d+) 个）$/, 'Packing workspaces ($1)'],
  [/^工作区不存在，跳过：(.+)$/, 'Workspace does not exist, skipped: $1'],
  [/^会话目录未找到（按路径键）：(.+)$/, 'No session directory for path key: $1'],
  [/^插件数据目录（--with-plugin-data）$/, 'Plugin data directories (--with-plugin-data)'],
  [/^  （这台机器上没有这些目录，跳过）$/, '  (none of these directories exist on this machine, skipped)'],
  [/^  复制工具自身失败（不影响迁移）：(.+)$/, '  Could not copy the tool itself (migration is unaffected): $1'],
  [/^完成$/, 'Done'],
  [/^完成（--dry-run，未写入任何东西）$/, 'Done (--dry-run: nothing was written)'],
  [/^  包目录：(.+)$/, '  Bundle: $1'],
  [/^  总大小：(.+)$/, '  Total size: $1'],
  [/^  工作区：(.+)$/, '  Workspace: $1'],
  [/^  插件 profile：(.+)$/, '  Plugin profiles: $1'],
  [/^(\d+) 个 link 依赖/, '$1 link dep(s)'],
  [/(\d+) 个 link 依赖\)/, '$1 link dep(s))'],
  [/^  凭证 \.credentials\.yaml 未打包（新机器重新登录即可）$/, '  Credentials (.credentials.yaml) are not included — sign in again on the new machine'],
  [/^  插件数据：(.+)$/, '  Plugin data: $1'],
  [/^接下来$/, 'Next'],
  [/^  把整个 U 盘插到新电脑，先装好 DeepSeek Harness 并启动一次（为了内置 Node），$/, '  Plug the stick into the new machine, install DeepSeek Harness and start it once (to fetch its bundled Node),'],
  [/^  退出应用后，双击 U 盘里的 dsh-migrate\.cmd 即可自动还原。$/, '  then quit it and double-click dsh-migrate.cmd on the stick.'],

  // ---- restore
  [/^还原计划$/, 'Restore plan'],
  [/^  来源机器：(.+) 打包于 (.+)$/, '  From: $1, packed at $2'],
  [/^--workspace-root 指定$/, 'set by --workspace-root'],
  [/\[路径变更：--workspace-root 指定\]/, '[path change: set by --workspace-root]'],
  [/\[路径变更：新机用户目录不同，自动迁移\]/, '[path change: user profile differs — re-rooted automatically]'],
  [/^新机用户目录不同，自动迁移$/, 'the user profile differs — re-rooted automatically'],
  [/^ 工作区：(.+)$/, ' Workspace: $1'],
  [/^\(--dry-run，未做任何修改\)$/, '(--dry-run: nothing was written)'],
  [/^目标已存在：(.+)$/, 'Target already exists: $1'],
  [/^  加 --force 会先把它备份成 (.+)\.bak-<时间戳> 再覆盖$/, '  --force backs it up to $1.bak-<timestamp> first'],
  [/^备份现有 home -> (.+)$/, 'Backing up the existing home -> $1'],
  [/^复制 home$/, 'Copying the home'],
  [/^保留本机 (.+) 失败：(.+)$/, 'Could not keep the local $1: $2'],
  [/^  已保留本机状态：(.+)$/, '  Kept local state: $1'],
  [/^  旧 home 备份仍留在此处：(.+)$/, '  Previous home backup left at: $1'],
  [/^复制工作区$/, 'Copying workspaces'],
  [/^包内缺少工作区：(.+)$/, 'Bundle is missing a workspace: $1'],
  [/^插件数据目录$/, 'Plugin data directories'],
  [/^修正插件 link: 路径$/, 'Rewriting plugin link: paths'],
  [/^ (.+)\/package\.json 已更新$/, ' $1/package.json updated'],
  [/^ storages\/workspace\.json 已更新$/, ' storages/workspace.json updated'],
  [/^迁移会话目录$/, 'Migrating session directories'],
  [/^未找到会话目录：(.+)$/, 'Session directory not found: $1'],
  [/^目标会话目录已存在，跳过改名：(.+)$/, 'Target session directory already exists, not renaming: $1'],
  [/^ 改写失败 (.+): (.+)$/, ' Rewrite failed for $1: $2'],
  [/^ 会话头 cwd 改写：(\d+) 个$/, ' Session header cwd rewritten: $1'],
  [/^修正 storages 内的绝对路径$/, 'Rewriting absolute paths inside storages'],
  [/^ 已更新 (\d+) 处引用$/, ' Updated $1 reference(s)'],
  [/^重装插件（node_modules 里是旧机器的绝对路径，必须重建）$/, "Reinstalling plugins (node_modules holds the old machine's absolute paths; it must be rebuilt)"],
  [/^ 已删除 (.+)\/node_modules$/, ' Removed $1/node_modules'],
  [/^已跳过插件安装（--no-install）。新机器上请执行：$/, 'Plugin install skipped (--no-install). Run this on the new machine:'],
  [/^未找到 dsh 命令，无法自动安装插件。请手动执行：$/, 'The dsh command was not found, so plugins cannot be installed automatically. Run this manually:'],
  [/^ (.+) 安装返回码 (\d+)，请检查输出$/, ' $1 install exited with code $2; check its output'],
  [/^ 工作区：(.+)$/, ' Workspace: $1'],
  [/^ 下一步：启动 DeepSeek Harness 并登录（凭证不随包迁移）。$/, ' Next: start DeepSeek Harness and sign in (credentials are not migrated).'],
  [/^注意：本次还原到非默认 home，启动应用前需设置 DSH_HOME=(.+)$/, 'Note: restored into a non-default home; set DSH_HOME=$1 before starting the app'],

  // ---- sync
  [/^检测到中转站，开始双向同步$/, 'Relay detected — starting a two-way sync'],
  [/^首次运行，初始化中转站（把本机完整推一份上去）$/, 'First run — seeding the relay with this machine'],
  [/^首次同步：把这个中转站初始化成一份完整快照$/, 'First sync: initialising this relay with a full snapshot'],
  [/^双向同步$/, 'Two-way sync'],
  [/^工作区文件$/, 'Workspace files'],
  [/^会话$/, 'Sessions'],
  [/^工作区索引$/, 'Workspace index'],
  [/^其它存储$/, 'Other storage'],
  [/^附件与插件数据$/, 'Attachments and plugin data'],
  [/^插件清单$/, 'Plugin manifests'],
  [/^安装新增插件$/, 'Installing new plugins'],
  [/^插件目录不完整（本次复制过 \.dsh 的典型后遗症），重新安装$/, 'Plugin directory is incomplete (typical after copying .dsh by hand) — reinstalling'],
  [/^有新增插件但没找到 dsh 命令，请手动执行：(.+)$/, 'New plugins found but the dsh command is missing; run manually: $1'],
  [/^ 工作区新增到本机：(.+)$/, ' Workspace added locally: $1'],
  [/^ 工作区新增到中转站：(.+)$/, ' Workspace added to the relay: $1'],
  [/^ 工作区按 --workspace-root 落到 (.+)（索引里原来是 (.+)）$/, ' Workspace placed at $1 by --workspace-root (the index had $2)'],
  [/^ 会话（(.+)）：拉入 (\d+) \/ 推出 (\d+)$/, ' Sessions ($1): pulled $2 / pushed $3'],
  // 汇总行必须排在通用 `(.+)：拉入…` 之前，否则 `会话` 会被当成标签原样留下。
  [/^ 会话：拉入 (\d+) \/ 推出 (\d+)$/, ' Sessions: pulled $1 / pushed $2'],
  [/^ 文件：拉入 (\d+) \/ 推出 (\d+) \/ 冲突 (\d+)$/, ' Files: pulled $1 / pushed $2 / conflicts $3'],
  [/^ 中转站：(.+)$/, ' Relay: $1'],
  [/^ 两边的 workspace\.json 已合并（工作区 id、会话列表取并集）$/, ' Both workspace.json files merged (workspace ids and session lists unioned)'],
  [/^ 投影缓存 \/ 会话策略已按时间合并$/, ' Projection cache and session policy merged by timestamp'],
  [/^ 插件目录：中转站里还没有，已整份推上去（不含 node_modules）$/, ' Plugin profiles: the relay had none, pushed a full copy (without node_modules)'],
  [/^ 插件目录：本地没有，从包里整份复制（不含 node_modules）$/, ' Plugin profiles: none locally, copied the whole set from the relay (without node_modules)'],
  [/^ (.+)：拉入 (\d+) 个文件 \/ 推出 (\d+) 个$/, ' $1: pulled $2 file(s) / pushed $3'],
  [/^ (.+)：拉入 (\d+) \/ 推出 (\d+)$/, ' $1: pulled $2 / pushed $3'],
  [/^ 插件 \+= (.+)（从包里补上）$/, ' Plugin += $1 (added from the relay)'],
  [/^ 插件 \+= (.+)（推进包里）$/, ' Plugin += $1 (pushed to the relay)'],
  [/^ 中转站里有插件数据（(.+)），本次没加 --with-plugin-data，已跳过$/, ' The relay holds plugin data ($1); --with-plugin-data was not passed, skipped'],
  [/^按 --skip-workspace 跳过工作区：(.+)$/, ' Skipped workspace by --skip-workspace: $1'],
  [/^ 中转站：(.+)$/, ' Relay: $1'],
  [/^ 会话：拉入 (\d+) \/ 推出 (\d+)$/, ' Sessions: pulled $1 / pushed $2'],
  [/^ 文件：拉入 (\d+) \/ 推出 (\d+) \/ 冲突 (\d+)$/, ' Files: pulled $1 / pushed $2 / conflicts $3'],
  [/^ 删除：本机删 (\d+) \/ 中转站删 (\d+) \/ 复活留用 (\d+)$/, ' Deletions: removed locally $1 / removed from relay $2 / kept after resurrection $3'],
  [/^ 删除：本机删 (\d+) \/ 中转站删 (\d+)$/, ' Deletions: removed locally $1 / removed from relay $2'],
  [/^ 删除失败 (.+)：(.+)$/, ' Could not delete $1: $2'],
  [/^ 删除中转站文件失败 (.+)：(.+)$/, ' Could not remove $1 from the relay: $2'],
  [/^ 冲突文件已保留本地版本，另一份另存为 \.conflict-<时间戳>$/, ' Conflicting files kept their local version; the other copy was saved as .conflict-<timestamp>'],
  [/^  已备份 (\d+) 项到 (.+)$/, '  Backed up $1 item(s) to $2'],
  [/^  备份失败 (.+)：(.+)$/, ' Backup failed for $1: $2'],
  [/^没有找到备份：(.+)$/, 'No backups found: $1'],
  [/^备份（(\d+) 次，最新在前）：(.+)$/, 'Backups ($1 run(s), newest first): $2'],
  [/^  (\d{8}-\d{6})  (.+)  (\d+) 项$/, '  $1  $2  $3 item(s)'],
  [/^没有这次备份：(.+)$/, 'No such backup: $1'],
  [/^回滚 (.+)（(\d+) 项）$/, 'Rolling back $1 ($2 item(s))'],
  [/^  （--dry-run，没有写任何文件）$/, '  (--dry-run, nothing was written)'],
  [/^已恢复 (\d+) 项，跳过 (\d+) 项$/, 'Restored $1 item(s), skipped $2'],
  [/^已恢复 (\d+) 项$/, 'Restored $1 item(s)'],
  [/^  回滚之后建议再跑一次 sync，让两台机器重新对齐。$/, '  Run sync once more so both machines line up again.'],
  [/^  冲突会话已按「最后写入时间新的赢」收敛，旧的一份另存为 \.conflict-<时间戳>$/, '  Conflicting sessions were resolved by last-write-wins; the older copy was saved as .conflict-<timestamp>'],
  [/^  两台机器现在内容一致，可以直接换机继续。$/, '  Both machines now hold the same content — you can switch machines.'],
  [/^ (.+) 两边都改过，采用本机那份（另一份另存 \.conflict-<时间戳>）$/, ' $1 was modified on both sides — keeping the local copy (the other saved as .conflict-<timestamp>)'],
  [/^ (.+) 两边都改过，采用中转站那份（另一份另存 \.conflict-<时间戳>）$/, ' $1 was modified on both sides — keeping the relay copy (the other saved as .conflict-<timestamp>)'],
  [/^ 两边都改过：(.+) —— 采用本机那份（另一份存为 (.+)\.conflict-<时间戳>）$/, ' Modified on both sides: $1 — keeping the local copy (the other saved as $2.conflict-<timestamp>)'],
  [/^ 两边都改过：(.+) —— 采用中转站那份（另一份存为 (.+)\.conflict-<时间戳>）$/, ' Modified on both sides: $1 — keeping the relay copy (the other saved as $2.conflict-<timestamp>)'],
  [/^ 同一会话两边都改了（(.+)）：采用本机那份，另一份另存为 \.conflict-<时间戳>$/, ' Session $1 was extended on both sides — keeping the local copy (the other saved as .conflict-<timestamp>)'],
  [/^ 同一会话两边都改了（(.+)）：采用中转站那份，另一份另存为 \.conflict-<时间戳>$/, ' Session $1 was extended on both sides — keeping the relay copy (the other saved as .conflict-<timestamp>)'],

  // ---- status
  [/^DSH home：(.+)$/, 'DSH home: $1'],
  [/^工作区（(\d+)）：$/, 'Workspaces ($1):'],
  [/^    会话 (\d+) 个，目录 (.+)$/, '    $1 session(s), directory $2'],
  [/^profile (.+)：(\d+) 个插件$/, 'profile $1: $2 plugin(s)'],
];

// 规则表里为了可读性保留了缩进（`^    请用 DSH ...`）。运行时统一去掉：
// 模式吃掉的缩进、以及替换文本开头的缩进都由 tr() 按原行的缩进还原。
// 只要出现中文或全角标点就要走翻译（`DSH home：…` 里只有一个全角冒号）。
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

const RULES = EN_RULES.map(([re, en]) => [
  new RegExp(re.source.replace(/^\^ +/, '^'), re.flags),
  en.replace(/^ +/, ''),
]);

/**
 * 逐行翻译：先剥掉行首缩进，把规则作用在正文上，再把缩进拼回去。
 * 一行里可能有多段中文（例如 `插件 profile：desktop(1 个 link 依赖)`），
 * 所以每条命中的规则都替换一次，最多三轮直到不再变化。
 */
function tr(text) {
  if (LANG === 'zh' || typeof text !== 'string' || !CJK.test(text)) return text;
  return text
    .split('\n')
    .map((line) => {
      const body0 = line.replace(/^[ \t]+/, '');
      const indent = line.slice(0, line.length - body0.length);
      if (!CJK.test(body0)) return line;
      let body = body0;
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (const [re, en] of RULES) {
          if (!re.test(body)) continue;
          const next = body.replace(re, en);
          if (next !== body) {
            body = next;
            changed = true;
          }
        }
        if (!changed) break;
      }
      return indent + body;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ utils */

const log = (...a) => console.log(...a.map((x) => (typeof x === 'string' ? tr(x) : x)));
const warn = (...a) => console.log('[!]', ...a.map((x) => (typeof x === 'string' ? tr(x) : x)));
const step = (s) => console.log(`\n== ${tr(s)}`);

/*
 * 会话日志首帧的改写依赖 zlib 的 Zstandard 接口（zstdCompressSync / zstdDecompressSync），
 * Node 22.15+ / 24 才带。老版本 Node 上不要冒险跑：没有它就只能「整文件重压」，
 * 而 DSH 的日志格式硬性要求首帧恰好一行 header，重压会把会话写坏。
 */
if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
  console.error(
    tr(
      `[x] 当前 Node 是 ${process.version}，没有内置 zstd 接口（需要 Node 22.15+ 或 24+）。\n` +
        '    请用 DSH 自带的 Node 运行本工具：双击 dsh-migrate.cmd 即可（它会自动找）。',
    ),
  );
  process.exit(2);
}

function mb(n) {
  return `${(n / 1048576).toFixed(1)} MB`;
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** child 是否等于 parent 或位于 parent 内部（大小写不敏感，Windows 语义）。 */
function isInside(child, parent) {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function walkSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(p);
      else total += st.size;
    }
  }
  return total;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 与 app.asar 中 projectKey() 完全一致的实现（按 UTF-16 code unit）。 */
function projectKey(cwd) {
  if (!cwd.length) throw new Error('cannot encode an empty project path');
  let readable = '';
  let sepRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sepRun) readable += '-';
      sepRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      sepRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      sepRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

function defaultHome() {
  const env = (process.env.DSH_HOME || '').trim();
  return env || path.join(os.homedir(), '.dsh');
}

/**
 * 桌面版 DSH 运行时会在自己的 userData 目录里持有 `lockfile` 的排他锁。
 * 用「能不能以读写方式打开」来判断它是否还开着：被占用就是还在跑。
 * 返回 true / false；非 Windows 或找不到该文件时返回 null（表示判断不了，不拦截）。
 */
function appRunning() {
  if (process.platform !== 'win32') return null;
  const lock = path.join(process.env.APPDATA || '', '@deepseek-ai', 'dsh-desktop', 'lockfile');
  if (!exists(lock)) return false;
  try {
    const fd = fs.openSync(lock, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
  }
}

/** 写本地数据之前先确认应用已经退出，避免和应用抢同一批文件。 */
function assertAppClosed(opts) {
  if (opts.force) return;
  if (appRunning() !== true) return;
  warn(
    'DeepSeek Harness 还在运行，先完全退出它再继续：\n' +
      '    * 关窗口不算，要从托盘图标右键退出（或任务管理器里结束 DeepSeek Harness）。\n' +
      '    * 应用正在写会话日志和插件目录，这时候同步可能被文件占用打断，\n' +
      '      刚拉下来的会话也可能被它退出时用内存里的旧索引覆盖掉。\n' +
      '    * 确认无所谓、一定要现在跑，加 --force 跳过这个检查。',
  );
  process.exit(1);
}

function copyTree(src, dst, skip) {
  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    errorOnExist: false,
    preserveTimestamps: true,
    filter: (s) => !skip(s),
  });
}

/* ------------------------------------------------------- zstd frame utils */

/** 最小 N，使 buf[0..N) 能被独立解码的 zstd 帧解开；失败返回 -1。 */
function firstFrameLength(buf) {
  if (buf.length < 8 || buf.readUInt32LE(0) !== ZSTD_MAGIC) return -1;
  let lo = 6;
  let hi = buf.length;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      zlib.zstdDecompressSync(buf.subarray(0, mid));
      ans = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  return ans;
}

/** 把会话日志第一行（header）里的 cwd 换成新值。返回 true 表示改写成功。 */
function rewriteLogCwd(file, oldCwd, newCwd) {
  const buf = fs.readFileSync(file);
  const isZstd = buf.length >= 8 && buf.readUInt32LE(0) === ZSTD_MAGIC;

  let headText;
  let tail;
  if (isZstd) {
    const frameLen = firstFrameLength(buf);
    if (frameLen < 0) throw new Error('无法定位首个 zstd 帧');
    headText = zlib.zstdDecompressSync(buf.subarray(0, frameLen)).toString('utf8');
    tail = buf.subarray(frameLen);
  } else {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) throw new Error('日志缺少首行');
    headText = buf.subarray(0, nl + 1).toString('utf8');
    tail = buf.subarray(nl + 1);
  }

  const line = headText.replace(/\n$/, '');
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new Error('首行不是合法 JSON');
  }
  if (obj.type !== 'session') throw new Error('首行不是 session 头');
  if (obj.cwd !== oldCwd) {
    if (obj.cwd !== newCwd) return false;
    return false;
  }
  obj.cwd = newCwd;
  const newLine = JSON.stringify(obj) + '\n';

  let head;
  if (isZstd) {
    head = zlib.zstdCompressSync(Buffer.from(newLine, 'utf8'), CHECKSUM);
    // 自检：重编后的第一帧必须能独立解出同一行
    const check = zlib.zstdDecompressSync(head).toString('utf8');
    if (check !== newLine) throw new Error('重编首帧自检失败');
  } else {
    head = Buffer.from(newLine, 'utf8');
  }

  const tmp = `${file}.migrate-tmp`;
  fs.writeFileSync(tmp, Buffer.concat([head, tail]));
  fs.renameSync(tmp, file);
  return true;
}

/** 扫描目录下的会话日志文件（session.vN.jsonl[.zstd]）。 */
function sessionLogFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sessionLogFiles(p));
    else if (/^session(\.[a-z0-9]+)?\.jsonl(\.zstd)?$/i.test(e.name)) out.push(p);
  }
  return out;
}

/* ---------------------------------------------------------------- manifest */

function readWorkspaceIndex(home) {
  const file = path.join(home, 'storages', 'workspace.json');
  if (!exists(file)) return { file, ids: [], workspaces: {} };
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const workspaces = (json.tables && json.tables.workspaces) || {};
  return { file, json, ids: Object.keys(workspaces), workspaces };
}

function profileDirs(home) {
  const dir = path.join(home, 'profiles');
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, dir: path.join(dir, e.name) }));
}

function linkDeps(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json');
  if (!exists(pkgFile)) return [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (typeof spec === 'string' && spec.startsWith('link:')) out.push({ name, target: spec.slice(5) });
  }
  return out;
}

/* -------------------------------------------------------------------- pack */

/**
 * --skip-workspace 的匹配器。
 * 可以给绝对路径（精确匹配，大小写不敏感），也可以只给目录名（末段匹配），
 * 可重复给多次，或用逗号分隔。
 */
function skipWorkspaceMatcher(opts) {
  const raw = opts.skipWorkspace;
  if (!raw || raw === true) return () => false;
  const items = [].concat(raw).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return () => false;
  const paths = [];
  const names = [];
  for (const it of items) {
    if (/^[a-zA-Z]:[\\/]/.test(it) || it.startsWith('\\\\') || it.startsWith('/')) paths.push(path.resolve(it).toLowerCase());
    else names.push(it.toLowerCase().replace(/[\\/]+$/, ''));
  }
  return (p) => {
    const abs = path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
    if (paths.includes(abs)) return true;
    const base = path.basename(abs);
    return names.some((n) => n.includes('\\') || n.includes('/') ? abs.endsWith(n) : base === n);
  };
}

function cmdPack(opts) {
  const home = opts.home || defaultHome();
  assertAppClosed(opts);
  if (!isDir(home)) {
    warn(`找不到 DSH home：${home}`);
    process.exit(1);
  }
  const out = path.resolve(opts.out);

  // 拒绝把包写进工作区内部：否则下次打包会把上次的包自己也装进去（滚雪球）
  const idx0 = readWorkspaceIndex(home);
  for (const id of idx0.ids) {
    const wp = idx0.workspaces[id]?.path;
    if (wp && isInside(out, wp)) {
      warn(`输出目录在工作区内部：${out}\n     换一个位置（U 盘根目录最合适），或显式用 --out 指定。\n     提示：U 盘里请把 dsh-migrate.cmd 放在 U 盘根目录再双击。`);
      process.exit(1);
    }
  }

  if (exists(out) && fs.readdirSync(out).length > 0 && !opts.force) {
    warn(`输出目录非空：${out}（加 --force 覆盖）`);
    process.exit(1);
  }
  fs.mkdirSync(out, { recursive: true });
  // 清掉上一次打包的残留，避免新旧混装
  if (opts.force) {
    for (const n of ['home', 'workspaces', 'userdata', 'manifest.json']) rmrf(path.join(out, n));
  }

  const withCredentials = !!opts.withCredentials;
  const withGit = !!opts.withGit;

  const homeSkip = (p) => {
    const rel = path.relative(home, p);
    if (!rel) return false;
    const parts = rel.split(/[\\/]/);
    if (parts.includes('node_modules')) return true;
    if (parts[0] === 'dsh-runtimes') return true;
    if (parts[0] === 'cache') return true;
    if (parts[0] === 'logs') return true;
    if (!withCredentials && rel === '.credentials.yaml') return true;
    return false;
  };

  step(`打包 DSH home：${home}`);
  const t0 = Date.now();
  copyTree(home, path.join(out, 'home'), homeSkip);
  log(`  -> ${mb(walkSize(path.join(out, 'home')))}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const index = readWorkspaceIndex(home);
  const wsEntries = [];
  const skipWs = skipWorkspaceMatcher(opts);
  const all = index.ids.map((id) => ({ id, ...index.workspaces[id] }));
  const list = all.filter((ws) => {
    if (!skipWs(ws.path)) return true;
    warn(`按 --skip-workspace 跳过工作区：${ws.path}`);
    return false;
  });

  step(`打包工作区（${list.length} 个）`);
  list.forEach((ws, i) => {
    if (!isDir(ws.path)) {
      warn(`工作区不存在，跳过：${ws.path}`);
      return;
    }
    const dir = `workspaces/ws-${i}`;
    const key = projectKey(ws.path);
    const sessDir = path.join(home, 'sessions', key);
    if (!isDir(sessDir)) warn(`会话目录未找到（按路径键）：${key}`);
    wsEntries.push({
      id: ws.id,
      title: ws.title,
      path: ws.path,
      dir,
      sessionsDir: key,
      sessionsPresent: isDir(sessDir),
    });
    const skip = (p) => {
      const parts = path.relative(ws.path, p).split(/[\\/]/);
      if (parts.includes('node_modules')) return true;
      if (!withGit && parts[0] === '.git') return true;
      return false;
    };
    copyTree(ws.path, path.join(out, dir), skip);
    log(`  ${ws.path}\n     -> ${dir}  ${mb(walkSize(path.join(out, dir)))}`);
  });

  const profiles = profileDirs(home).map((p) => ({
    name: p.name,
    linkDeps: linkDeps(p.dir),
  }));

  // 插件数据目录在 DSH home 之外（~/.openviking 等），默认不搬
  const entries = pluginDataEntries(opts);
  const withPluginData = entries.length > 0 || !!opts.withPluginData;
  const pluginData = [];
  if (withPluginData) {
    step('插件数据目录（--with-plugin-data）');
    for (const { label, abs } of entries) {
      if (!isDir(abs)) continue;
      const to = path.join(out, PLUGIN_DATA_ROOT, label);
      copyTree(abs, to, () => false);
      pluginData.push({ label, path: abs });
      log(`  ${label}  ${mb(walkSize(to))}`);
    }
    if (!pluginData.length) log('  （这台机器上没有这些目录，跳过）');
  }

  const manifest = {
    format: FORMAT,
    createdAt: new Date().toISOString(),
    source: {
      home,
      platform: process.platform,
      hostname: os.hostname(),
      username: os.userInfo().username,
      userProfile: os.homedir(),
    },
    includesCredentials: withCredentials,
    includesGit: withGit,
    includesPluginData: withPluginData,
    pluginData,
    workspaces: wsEntries,
    profiles,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 把工具自身放进包里，新机器上无需另外准备。
  // U 盘模式下源目录 == 输出目录，此时文件本来就在，跳过（否则会撞上「正在运行的文件」）。
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['dsh-migrate.mjs', 'dsh-migrate.cmd']) {
    const src = path.join(selfDir, f);
    const dst = path.join(out, f);
    if (samePath(src, dst) || !exists(src)) continue;
    try {
      fs.copyFileSync(src, dst);
    } catch (e) {
      warn(`  复制工具自身失败（不影响迁移）：${e.message}`);
    }
  }

  const total = walkSize(out);
  step('完成');
  log(`  包目录：${out}`);
  log(`  总大小：${mb(total)}`);
  log(`  工作区：${wsEntries.map((w) => w.path).join(', ') || '(无)'}`);
  log(`  插件 profile：${profiles.map((p) => `${p.name}(${p.linkDeps.length} 个 link 依赖)`).join(', ')}`);
  if (!withCredentials) log('  凭证 .credentials.yaml 未打包（新机器重新登录即可）');
  if (withPluginData && pluginData.length) log(`  插件数据：${pluginData.map((p) => p.label).join(', ')}`);
  if (opts.auto) {
    step('接下来');
    log('  把整个 U 盘插到新电脑，先装好 DeepSeek Harness 并启动一次（为了内置 Node），');
    log('  退出应用后，双击 U 盘里的 dsh-migrate.cmd 即可自动还原。');
  }
}

/* ----------------------------------------------------------------- restore */

function findDshCli() {
  const cands = [
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ].filter(Boolean);
  for (const c of cands) if (exists(c)) return c;
  const probe = spawnSync('where', ['dsh'], { encoding: 'utf8', shell: true });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find(Boolean);
    if (first && exists(first.trim())) return first.trim();
  }
  return null;
}

function rewriteJsonPaths(file, oldPath, newPath) {
  if (oldPath === newPath || !exists(file)) return false;
  const raw = fs.readFileSync(file, 'utf8');
  const variants = [
    [oldPath, newPath],
    [oldPath.replace(/\\/g, '/'), newPath.replace(/\\/g, '/')],
    [JSON.stringify(oldPath).slice(1, -1), JSON.stringify(newPath).slice(1, -1)],
  ];
  let next = raw;
  for (const [a, b] of variants) if (a && a !== b && next.includes(a)) next = next.split(a).join(b);
  if (next === raw) return false;
  fs.writeFileSync(file, next);
  return true;
}

function cmdRestore(opts) {
  const src = path.resolve(opts.in);
  const mfFile = path.join(src, 'manifest.json');
  if (!exists(mfFile)) {
    warn(`不是迁移包（缺 manifest.json）：${src}`);
    process.exit(1);
  }
  const mf = JSON.parse(fs.readFileSync(mfFile, 'utf8').replace(/^\uFEFF/, ''));
  if (mf.format !== FORMAT) warn(`包格式 ${mf.format} 与工具 ${FORMAT} 不一致，继续尝试`);

  const home = path.resolve(opts.home || defaultHome());
  const dry = !!opts.dryRun;
  assertAppClosed(opts);

  step('还原计划');
  log(`  来源机器：${mf.source.hostname} / ${mf.source.username}   打包于 ${mf.createdAt}`);
  log(`  DSH home：${mf.source.home}  ->  ${home}`);

  // 新机用户目录不同（比如换了 Windows 账号）时，自动把旧用户目录下的工作区
  // 落到新用户目录的相同相对位置，而不是硬塞回一个不存在的 C:\Users\xxx。
  const oldProfile = mf.source.userProfile;
  const newProfile = os.homedir();
  const profileChanged = !!oldProfile && !samePath(oldProfile, newProfile);

  const mapping = mf.workspaces.map((ws) => {
    let target = ws.path;
    let why = '';
    if (opts.workspaceRoot) {
      target = path.join(path.resolve(opts.workspaceRoot), path.basename(ws.path));
      why = '--workspace-root 指定';
    } else if (profileChanged && isInside(ws.path, oldProfile)) {
      target = path.join(newProfile, path.relative(oldProfile, ws.path));
      why = '新机用户目录不同，自动迁移';
    }
    return { ...ws, target, changed: !samePath(target, ws.path), why };
  });
  for (const m of mapping) {
    log(`  工作区：${m.path}\n          -> ${m.target}${m.changed ? `  [路径变更：${m.why}]` : ''}`);
  }
  if (dry) {
    log('\n(--dry-run，未做任何修改)');
    return;
  }

  let bak = null;
  if (exists(home)) {
    if (!opts.force) {
      warn(`目标已存在：${home}\n     加 --force 会先把它备份成 ${path.basename(home)}.bak-<时间戳> 再覆盖`);
      process.exit(1);
    }
    bak = `${home}.bak-${stamp()}`;
    step(`备份现有 home -> ${bak}`);
    fs.renameSync(home, bak);
  }

  step('复制 home');
  fs.mkdirSync(home, { recursive: true });
  copyTree(path.join(src, 'home'), home, () => false);

  // 新机自己的「本机状态」必须留住：运行时（257MB，重下一遍很慢）、缓存、日志，
  // 以及刚登录拿到的凭证。这些跟着机器走，不属于迁移内容。
  if (bak) {
    const keep = ['dsh-runtimes', 'cache', 'logs', '.credentials.yaml'];
    const moved = [];
    for (const name of keep) {
      const from = path.join(bak, name);
      if (!exists(from)) continue;
      const to = path.join(home, name);
      rmrf(to);
      try {
        fs.renameSync(from, to);
        moved.push(name);
      } catch (e) {
        warn(`保留本机 ${name} 失败：${e.message}`);
      }
    }
    if (moved.length) log(`  已保留本机状态：${moved.join(', ')}`);
    log(`  旧 home 备份仍留在此处：${bak}`);
  }

  step('复制工作区');
  for (const m of mapping) {
    const from = path.join(src, m.dir);
    if (!exists(from)) {
      warn(`包内缺少工作区：${from}`);
      continue;
    }
    fs.mkdirSync(path.dirname(m.target), { recursive: true });
    copyTree(from, m.target, () => false);
    log(`  ${m.target}`);
  }

  /* 插件数据目录（~/.openviking 等）：包里带了就铺回去 */
  const pdRoot = path.join(src, PLUGIN_DATA_ROOT);
  if (isDir(pdRoot)) {
    step('插件数据目录');
    const recorded = new Map();
    for (const e of mf.pluginData || []) {
      if (e && typeof e === 'object' && e.label) recorded.set(e.label, e.path);
      else if (typeof e === 'string') recorded.set(e, path.join(mf.source.userProfile || os.homedir(), e));
    }
    for (const label of fs.readdirSync(pdRoot)) {
      const from = path.join(pdRoot, label);
      if (!isDir(from)) continue;
      const orig = recorded.get(label);
      const to = orig
        ? reRootPath(orig, mf.source.userProfile || os.homedir(), os.homedir())
        : path.join(os.homedir(), label);
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to, () => false);
      log(`  ${label} -> ${to}`);
    }
  }

  /* 1) profiles 下各 package.json 里的 link: 绝对路径 */
  step('修正插件 link: 路径');
  for (const p of profileDirs(home)) {
    const pkgFile = path.join(p.dir, 'package.json');
    if (!exists(pkgFile)) continue;
    let raw = fs.readFileSync(pkgFile, 'utf8');
    const before = raw;
    for (const m of mapping) {
      if (!m.changed) continue;
      for (const [a, b] of [
        [m.path.replace(/\\/g, '/'), m.target.replace(/\\/g, '/')],
        [m.path, m.target],
      ]) {
        raw = raw.split(`link:${a}`).join(`link:${b}`);
      }
    }
    if (raw !== before) {
      fs.writeFileSync(pkgFile, raw);
      log(`  ${p.name}/package.json 已更新`);
    }
  }

  /* 2) storages/workspace.json 的 path */
  const idxFile = path.join(home, 'storages', 'workspace.json');
  if (exists(idxFile)) {
    const json = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    let touched = false;
    for (const m of mapping) {
      const entry = json.tables && json.tables.workspaces && json.tables.workspaces[m.id];
      if (entry && entry.path !== m.target) {
        entry.path = m.target;
        touched = true;
      }
    }
    if (touched) {
      fs.writeFileSync(idxFile, JSON.stringify(json, null, 2));
      log('  storages/workspace.json 已更新');
    }
  }

  /* 3) 会话：项目目录改名 + 日志头 cwd 改写 */
  step('迁移会话目录');
  for (const m of mapping) {
    const oldKey = projectKey(m.path);
    const newKey = projectKey(m.target);
    const oldDir = path.join(home, 'sessions', oldKey);
    const newDir = path.join(home, 'sessions', newKey);
    if (!isDir(oldDir)) {
      warn(`未找到会话目录：${oldKey}`);
      continue;
    }
    if (oldKey !== newKey) {
      if (isDir(newDir)) {
        warn(`目标会话目录已存在，跳过改名：${newKey}`);
      } else {
        fs.renameSync(oldDir, newDir);
        log(`  ${oldKey}\n     -> ${newKey}`);
      }
    }
    if (m.changed) {
      let n = 0;
      let failed = 0;
      for (const f of sessionLogFiles(isDir(newDir) ? newDir : oldDir)) {
        try {
          if (rewriteLogCwd(f, m.path, m.target)) n++;
        } catch (e) {
          failed++;
          warn(`  改写失败 ${path.basename(path.dirname(f))}: ${e.message}`);
        }
      }
      log(`  会话头 cwd 改写：${n} 个${failed ? `，失败 ${failed} 个` : ''}`);
    }
  }

  /* 4) 其它存储里的绝对路径（投影缓存、策略等） */
  step('修正 storages 内的绝对路径');
  const storages = path.join(home, 'storages');
  if (isDir(storages)) {
    let n = 0;
    const stack = [storages];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith('.json')) {
          for (const m of mapping) if (m.changed && rewriteJsonPaths(p, m.path, m.target)) n++;
        }
      }
    }
    log(`  已更新 ${n} 处引用`);
  }

  /* 5) 去掉 node_modules，重装插件 */
  step('重装插件（node_modules 里是旧机器的绝对路径，必须重建）');
  for (const p of profileDirs(home)) {
    const nm = path.join(p.dir, 'node_modules');
    if (exists(nm)) {
      rmrf(nm);
      log(`  已删除 ${p.name}/node_modules`);
    }
  }

  if (opts.noInstall) {
    warn('已跳过插件安装（--no-install）。新机器上请执行：');
    for (const p of profileDirs(home)) log(`    dsh plugin --profile ${p.name} install`);
    return;
  }

  const dsh = findDshCli();
  if (!dsh) {
    warn('未找到 dsh 命令，无法自动安装插件。请手动执行：');
    for (const p of profileDirs(home)) log(`    dsh plugin --profile ${p.name} install`);
    return;
  }
  const env = { ...process.env, DSH_HOME: home };
  for (const p of profileDirs(home)) {
    log(`  $ dsh plugin --profile ${p.name} install`);
    const r = spawnSync(`"${dsh}" plugin --profile ${p.name} install`, {
      stdio: 'inherit',
      shell: true,
      env,
    });
    if (r.status !== 0) warn(`  ${p.name} 安装返回码 ${r.status}，请检查输出`);
  }

  step('完成');
  log(`  DSH home：${home}`);
  for (const m of mapping) log(`  工作区：${m.target}`);
  log('  下一步：启动 DeepSeek Harness 并登录（凭证不随包迁移）。');
  if (home !== defaultHome()) {
    warn(`注意：本次还原到非默认 home，启动应用前需设置 DSH_HOME=${home}`);
  }
}

/* -------------------------------------------------------------------- sync */

/*
 * 双向增量同步：U 盘（或任意共享盘）当中转站，两台机器轮流各跑一次即可接力。
 *
 *   A 机：双击 -> 本地新增的推进包里、包里的新东西拉回本地 -> 两边一致
 *   B 机：双击 -> 同上（方向按文件时间自动判断，不需要选）
 *
 * 与 restore 的区别：restore 是「单向覆盖成某一刻的快照」，sync 是「并集合并」，
 * 两台机器各自产生的会话、文件、插件设置都不会被对方抹掉。
 *
 * 包里始终保存「第一台机器」的规范路径（manifest.workspaces[].path），跨机器时
 * 只在边界上改写路径（会话头 cwd、storages、link:），所以来回搬不会越改越乱。
 */

/**
 * 同步范围是「动态发现」而不是写死插件名：
 *   - sessions / storages / profiles 由各自的合并逻辑处理；
 *   - DSH home 顶层剩下的目录与文件一律视为插件数据，按时间双向合并。
 * 这样别人装了我不认识的插件（它们的目录名我根本没听过）也能带走，
 * 不需要等工具加名单。
 */
const MANAGED_DIRS = new Set(['sessions', 'storages', 'profiles']);
const NEVER_SYNC_DIRS = new Set(['node_modules', 'dsh-runtimes', 'cache', 'logs', '.git', '.dsh-migrate-backup']);
const NEVER_SYNC_FILES = new Set(['.credentials.yaml', 'manifest.json', '.dsh-migrate-state.json', '.DS_Store', 'Thumbs.db']);
const VOLATILE_RE = /(^|[\\/])(\.migrate-tmp|.*\.lock|~.*\.tmp)$/;

/** DSH home 顶层里需要参与同步的目录（sessions/storages/profiles 除外）。 */
function discoverDataDirs(home) {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (MANAGED_DIRS.has(e.name) || NEVER_SYNC_DIRS.has(e.name)) continue;
    out.push(e.name);
  }
  return out.sort();
}

/** DSH home 顶层的零散文件（凭据等除外），比如插件写的 loadout.json / .dshw-*.json。 */
function discoverHomeFiles(home) {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (NEVER_SYNC_FILES.has(e.name) || VOLATILE_RE.test(e.name)) continue;
    out.push(e.name);
  }
  return out.sort();
}

/*
 * 有些插件把数据放在 DSH home 之外的用户目录里。它们默认不参与同步
 * （各自是独立服务/队列，合并两台机器的副本有重复推送的风险），
 * 需要时用 --with-plugin-data 显式打开。
 */
const PLUGIN_DATA_DIRS = ['.openviking', '.hindsight'];
const PLUGIN_DATA_ROOT = 'userdata';

/**
 * --with-plugin-data 的取值：
 *   不带值 / 带 true      -> 默认那两份（~/.openviking、~/.hindsight）
 *   --with-plugin-data a,b -> 自己点名（相对 ~ 的目录名，或绝对路径）
 * 其它插件把数据放在别处时，用户照着自己的目录名传就行，不用等我改代码。
 */
function pluginDataEntries(opts) {
  const v = opts.withPluginData;
  if (!v) return [];
  const raw = v === true ? PLUGIN_DATA_DIRS : String(v).split(',');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = String(item).trim();
    if (!s) continue;
    const abs = path.isAbsolute(s) ? path.resolve(s) : path.join(os.homedir(), s);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ label: path.basename(abs) || s, abs });
  }
  return out;
}

/** 把会话日志切成「首帧（header）」和「其余字节」。 */
function splitLog(buf) {
  const isZstd = buf.length >= 8 && buf.readUInt32LE(0) === ZSTD_MAGIC;
  if (isZstd) {
    const n = firstFrameLength(buf);
    if (n < 0) throw new Error('无法定位首个 zstd 帧');
    return {
      isZstd,
      headText: zlib.zstdDecompressSync(buf.subarray(0, n)).toString('utf8'),
      tail: buf.subarray(n),
    };
  }
  const nl = buf.indexOf(0x0a);
  if (nl < 0) throw new Error('日志缺少首行');
  return { isZstd, headText: buf.subarray(0, nl + 1).toString('utf8'), tail: buf.subarray(nl + 1) };
}

/** 用新的 cwd 重新拼出日志（只重编首帧，其余字节原样）；cwd 为空表示不改。 */
function joinLog(parts, cwd) {
  if (!cwd) return Buffer.concat([parts.isZstd ? zlib.zstdCompressSync(Buffer.from(parts.headText, 'utf8'), CHECKSUM) : Buffer.from(parts.headText, 'utf8'), parts.tail]);
  const obj = JSON.parse(parts.headText.replace(/\n$/, ''));
  obj.cwd = cwd;
  const line = JSON.stringify(obj) + '\n';
  const head = parts.isZstd ? zlib.zstdCompressSync(Buffer.from(line, 'utf8'), CHECKSUM) : Buffer.from(line, 'utf8');
  return Buffer.concat([head, parts.tail]);
}

/** 一份日志尾部里最后一条带 time 的记录的时间戳（毫秒），用来判「谁写得更晚」。 */
function lastEventTime(parts) {
  const tail = parts.tail;
  if (!tail.length) return 0;
  if (!parts.isZstd) {
    const lines = tail.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (typeof rec.time === 'number') return rec.time;
      } catch {
        /* 不完整的尾行跳过 */
      }
    }
    return 0;
  }
  // zstd 尾部是多帧拼接：从最后一帧往前找，最多回退 8 帧
  const marks = [];
  for (let i = 0; i + 3 < tail.length; i++) {
    if (tail.readUInt32LE(i) === 0xfd2fb528) marks.push(i);
  }
  for (let i = marks.length - 1; i >= 0 && i > marks.length - 9; i--) {
    const end = i + 1 < marks.length ? marks[i + 1] : tail.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(tail.subarray(marks[i], end)).toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter(Boolean);
    for (let k = lines.length - 1; k >= 0; k--) {
      try {
        const rec = JSON.parse(lines[k]);
        if (typeof rec.time === 'number') return rec.time;
      } catch {
        /* ignore */
      }
    }
  }
  return 0;
}

/** 目录下版本号最高的会话日志（session.vN.jsonl.zstd）。 */
function highestLog(dir) {
  const files = sessionLogFiles(dir);
  if (!files.length) return null;
  const ver = (f) => {
    const m = /\.v(\d+)\./i.exec(path.basename(f));
    return m ? Number(m[1]) : 0;
  };
  return files.sort((x, y) => ver(y) - ver(x))[0];
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function copyFilePreserve(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const st = fs.statSync(src);
  try {
    fs.utimesSync(dst, st.atime, st.mtime); // FAT32/exFAT 上也能保住时间戳，避免「U 盘上的永远最新」
  } catch {
    /* 时间戳设置失败不影响内容 */
  }
}

/** 把会话目录里的内容复制到另一边，并把日志头的 cwd 规范成 destCwd。 */
function copySessionDir(srcDir, dstDir, destCwd, dry) {
  const files = sessionLogFiles(srcDir);
  const names = new Set(files.map((f) => path.relative(srcDir, f)));
  for (const rel of names) {
    const from = path.join(srcDir, rel);
    const to = path.join(dstDir, rel);
    if (dry) continue;
    const parts = splitLog(fs.readFileSync(from));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, joinLog(parts, destCwd));
    const st = fs.statSync(from);
    try {
      fs.utimesSync(to, st.atime, st.mtime);
    } catch {
      /* ignore */
    }
  }
  return names.size;
}

/** 递归列出相对路径 -> {size, mtimeMs}。 */
function walkRel(root, skip, out = new Map(), rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (skip && skip(r, path.join(root, r), e)) continue;
    if (e.isDirectory()) walkRel(root, skip, out, r);
    else if (e.isFile()) {
      const st = statOrNull(path.join(root, r));
      if (st) out.set(r, { size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** 双向合并两棵目录树：谁新谁覆盖，缺的补齐；删除不传播。 */
function mergeTree(localRoot, bundleRoot, opts) {
  const { skip, dry, stats, contentAddressed } = opts;
  const a = walkRel(localRoot, skip);
  const b = walkRel(bundleRoot, skip);
  for (const rel of new Set([...a.keys(), ...b.keys()])) {
    // 冲突留档只在产生它的那台机器上留一份，不再跟着同步来同步去
    if (/\.conflict-\d{8}-\d{6}$/.test(rel)) continue;
    const la = a.get(rel);
    const lb = b.get(rel);
    const toBundle = () => {
      if (!dry) copyFilePreserve(path.join(localRoot, rel), path.join(bundleRoot, rel));
      stats.pushed++;
    };
    const toLocal = () => {
      if (!dry) {
        backupSave(opts.scope, localRoot, rel);
        copyFilePreserve(path.join(bundleRoot, rel), path.join(localRoot, rel));
      }
      stats.pulled++;
    };
    if (!la) toLocal();
    else if (!lb) toBundle();
    else if (contentAddressed) stats.unchanged++;
    else {
      // contentAddressed 之外的普通文件：时间差够大就谁后写谁赢（最常见的直觉）；
      // 时间差不到 2 秒则先比内容 —— 内容一样就是没变，不一样才进冲突分支。
      // 注意不能只看「大小一样」就当成没变：同一秒内两边各写一次时，大小相同但内容不同很常见。
      const dt = la.mtimeMs - lb.mtimeMs;
      const localFile = path.join(localRoot, rel);
      const bundleFile = path.join(bundleRoot, rel);
      let same = false;
      if (dt <= 2000 && dt >= -2000) {
        if (la.size === lb.size) {
          try {
            same = fs.readFileSync(localFile).equals(fs.readFileSync(bundleFile));
          } catch {
            same = false;
          }
        }
        if (same) stats.unchanged++;
      }
      if (dt > 2000) toBundle();
      else if (dt < -2000) toLocal();
      else if (!same) {
        // 时间接近、内容不同：两台机器都改过。按字节定胜负 —— 两边算的是同一对字节，
        // 结果必然一致，所以一轮之后两台机器收敛到同一份；败者另存 .conflict-<时间戳> 留档。
        stats.fileConflicts++;
        let localWins = true;
        try {
          localWins = Buffer.compare(fs.readFileSync(localFile), fs.readFileSync(bundleFile)) > 0;
        } catch {
          localWins = true;
        }
        const relShow = `${opts.label ? opts.label + '/' : ''}${rel}`;
        warn(`  两边都改过：${relShow} —— 采用${localWins ? '本机' : '中转站'}那份（另一份存为 ${path.basename(rel)}.conflict-<时间戳>）`);
        if (!dry) {
          fs.mkdirSync(path.dirname(localFile), { recursive: true });
          const keep = path.join(path.dirname(localFile), `${path.basename(localFile)}.conflict-${stamp()}`);
          copyFilePreserve(localWins ? bundleFile : localFile, keep);
          if (localWins) copyFilePreserve(localFile, bundleFile);
          else {
            backupSave(opts.scope, localRoot, rel);
            copyFilePreserve(bundleFile, localFile);
          }
          // 两边都标成「刚刚」：内容已一致、时间也一致，下次同步直接就跳过这一段，
          // 另一台机器拉过去之后同样会跳过，不会来回重复报同一个冲突。
          const now = new Date();
          fs.utimesSync(bundleFile, now, now);
          fs.utimesSync(localFile, now, now);
        }
      }
    }
  }
}

/** 两台机器用户目录不同时，把旧用户目录下的路径换算到本机。 */
function reRootPath(p, oldProfile, newProfile) {
  if (!oldProfile || !newProfile || samePath(oldProfile, newProfile)) return p;
  if (!isInside(p, oldProfile)) return p;
  return path.join(newProfile, path.relative(oldProfile, p));
}

function writeIndex(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(json, null, 2);
  // 内容没变就不重写：mtime 一变，另一边就会把它当成新改动，来回传个没完。
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch {
    /* 文件还不存在，正常往下写 */
  }
  fs.writeFileSync(file, text);
  return true;
}

/** 建立「本地工作区 <-> 包内工作区」的映射，缺的一侧补上。 */
function resolveSyncMapping(home, mf, opts) {
  const idx = readWorkspaceIndex(home);
  const locals = idx.ids.map((id) => ({ id, ...idx.workspaces[id] }));
  const used = new Set();
  const mapping = [];
  const newLocalEntries = [];

  for (const bw of mf.workspaces) {
    const base = path.basename(bw.path).toLowerCase();
    let le =
      locals.find((e) => !used.has(e.id) && e.id === bw.id) ||
      locals.find((e) => !used.has(e.id) && path.basename(e.path).toLowerCase() === base) ||
      locals.find((e) => !used.has(e.id) && samePath(e.path, bw.path));
    if (le) used.add(le.id);
    // 显式给了 --workspace-root 就以它为准：手工拷过 .dsh 的机器，本地索引里往往还留着
    // 另一台机器的老路径，不覆盖的话会把文件拉到那个位置去。
    const forced = opts.workspaceRoot ? path.join(path.resolve(opts.workspaceRoot), path.basename(bw.path)) : null;
    const localPath = forced
      ? forced
      : le
        ? le.path
        : reRootPath(bw.path, mf.source.userProfile, os.homedir());
    if (forced && le && !samePath(forced, le.path)) {
      warn(`  工作区按 --workspace-root 落到 ${forced}（索引里原来是 ${le.path}）`);
    }
    if (!le) {
      newLocalEntries.push({ id: bw.id, path: localPath, title: bw.title || path.basename(localPath) });
    }
    mapping.push({
      bundle: bw,
      localId: le ? le.id : bw.id,
      localPath,
      bundlePath: bw.path,
      bundleDir: bw.dir,
      isNewLocal: !le,
    });
  }
  // 本地独有、包里还没有的工作区：这次同步推出去
  for (const le of locals) {
    if (used.has(le.id)) continue;
    mapping.push({
      bundle: null,
      localId: le.id,
      localPath: le.path,
      bundlePath: le.path,
      bundleDir: null, // 稍后分配
      isNewBundle: true,
    });
  }
  return { mapping, idx, newLocalEntries };
}

/** 把映射结果写回两边 workspace.json（本地用本机路径，包内用规范路径）。 */
function syncWorkspaceIndex(home, dir, mapping, idx, dry) {
  // 本地
  if (exists(idx.file) || mapping.length) {
    const json = idx.json || {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: {} },
    };
    json.tables = json.tables || { workspaces: {} };
    json.tables.workspaces = json.tables.workspaces || {};
    json.global = json.global || {};
    json.global.workspaceIds = json.global.workspaceIds || [];
    for (const m of mapping) {
      const cur = json.tables.workspaces[m.localId];
      if (cur) {
        if (cur.path !== m.localPath) cur.path = m.localPath;
      } else {
        json.tables.workspaces[m.localId] = {
          path: m.localPath,
          title: path.basename(m.localPath),
          sessionIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      if (!json.global.workspaceIds.includes(m.localId)) json.global.workspaceIds.push(m.localId);
      if (!json.global.defaultWorkspaceId) json.global.defaultWorkspaceId = m.localId;
    }
    if (!dry) writeIndex(idx.file, json);
    idx.json = json;
  }
  // 包内：拿本地那份当模板（字段、键序都一致），只把 path 换成规范路径。
  // 两边各自序列化会让同一个索引在每台机器上长得不一样，合并时永远「有差异」。
  const bIdxFile = path.join(dir, 'home', 'storages', 'workspace.json');
  const base = idx.json || {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  };
  const bJson = JSON.parse(JSON.stringify(base));
  bJson.tables = bJson.tables || { workspaces: {} };
  bJson.tables.workspaces = bJson.tables.workspaces || {};
  bJson.global = bJson.global || {};
  bJson.global.workspaceIds = bJson.global.workspaceIds || [];
  for (const m of mapping) {
    const id = m.bundle ? m.bundle.id : m.localId;
    const cur = bJson.tables.workspaces[m.localId];
    const entry = cur || {
      path: m.bundlePath,
      title: path.basename(m.bundlePath),
      sessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    entry.path = m.bundlePath;
    entry.sessionIds = entry.sessionIds || [];
    bJson.tables.workspaces[id] = entry;
    if (id !== m.localId) delete bJson.tables.workspaces[m.localId];
    if (!bJson.global.workspaceIds.includes(id)) bJson.global.workspaceIds.push(id);
    if (!bJson.global.defaultWorkspaceId) bJson.global.defaultWorkspaceId = id;
  }
  if (!dry) writeIndex(bIdxFile, bJson);
  return { localJson: idx.json, bundleJson: bJson };
}

/** 会话 id 并集：目录名并集，同时补齐两边 workspace.json 里的 sessionIds（否则侧栏里看不到）。 */
function mergeSessionIds(localJson, bundleJson, mapping) {
  if (!localJson || !bundleJson) return;
  for (const m of mapping) {
    const lid = m.localId;
    const bid = m.bundle ? m.bundle.id : m.localId;
    const lIds = (localJson.tables.workspaces[lid] && localJson.tables.workspaces[lid].sessionIds) || [];
    const bIds = (bundleJson.tables.workspaces[bid] && bundleJson.tables.workspaces[bid].sessionIds) || [];
    const all = [...new Set([...lIds, ...bIds])];
    if (localJson.tables.workspaces[lid]) localJson.tables.workspaces[lid].sessionIds = all;
    if (bundleJson.tables.workspaces[bid]) bundleJson.tables.workspaces[bid].sessionIds = all;
  }
}

/**
 * 合并一对「项目目录」（本地 sessions\<key> vs 中转站 home\sessions\<key>）。
 * localCwd / bundleCwd 为空表示这个目录不属于已登记的工作区（会话是在别的文件夹里开的），
 * 原样搬运、不改 header 里的 cwd。
 */
function mergeSessionDirs(lDir, bDir, localCwd, bundleCwd, stats, dry, home) {
  const keepOld = (d) => {
    if (dry || !home) return;
    backupSave('home', home, path.relative(home, d));
  };
  const list = (root) => {
    try {
      return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const ids = new Set([...list(lDir), ...list(bDir)]);
  let pulled = 0;
  let pushed = 0;
  for (const id of ids) {
    const ld = path.join(lDir, id);
    const bd = path.join(bDir, id);
    const lf = isDir(ld) ? highestLog(ld) : null;
    const bf = isDir(bd) ? highestLog(bd) : null;
    if (lf && !bf) {
      copySessionDir(ld, bd, bundleCwd, dry);
      pushed++;
      continue;
    }
    if (bf && !lf) {
      keepOld(ld);
      copySessionDir(bd, ld, localCwd, dry);
      pulled++;
      continue;
    }
    if (!lf && !bf) continue;
    const L = splitLog(fs.readFileSync(lf));
    const B = splitLog(fs.readFileSync(bf));
    if (L.tail.equals(B.tail)) continue; // 内容一致（只是 header cwd 可能不同）
    const lSuperset = L.tail.length >= B.tail.length && L.tail.subarray(0, B.tail.length).equals(B.tail);
    const bSuperset = B.tail.length >= L.tail.length && B.tail.subarray(0, L.tail.length).equals(L.tail);
    if (lSuperset && L.tail.length > B.tail.length) {
      copySessionDir(ld, bd, bundleCwd, dry);
      pushed++;
    } else if (bSuperset && B.tail.length > L.tail.length) {
      keepOld(ld);
      copySessionDir(bd, ld, localCwd, dry);
      pulled++;
    } else {
      // 真分叉：两台机器都续写这同一个会话，字节流对不上。
      // 必须选一个「胜者」并让两边都采纳它，否则每次同步都会重复报冲突、来回踢。
      // 规则：比日志里最后一条事件的 time（这才代表「哪台写得更晚」；
      // 文件 mtime 会被复制/拷贝搞乱，不可靠），时间相同再退回 mtime 与字节序。
      stats.sessionConflicts++;
      const lt = lastEventTime(L);
      const bt = lastEventTime(B);
      const lm = statOrNull(lf);
      const bm = statOrNull(bf);
      let localWins;
      if (lt && bt && lt !== bt) localWins = lt > bt;
      else if (lm && bm && Math.abs(lm.mtimeMs - bm.mtimeMs) > 2000) localWins = lm.mtimeMs > bm.mtimeMs;
      else localWins = Buffer.compare(L.tail, B.tail) > 0;
      warn(`  同一会话两边都改了（${id}）：采用${localWins ? '本机' : '中转站'}那份，另一份另存为 .conflict-<时间戳>`);
      if (!dry) {
        fs.mkdirSync(ld, { recursive: true });
        const keep = path.join(ld, `${path.basename(localWins ? bf : lf)}.conflict-${stamp()}`);
        fs.copyFileSync(localWins ? bf : lf, keep);
        if (localWins) copySessionDir(ld, bd, bundleCwd, false);
        else {
          keepOld(ld);
          copySessionDir(bd, ld, localCwd, false);
        }
      }
    }
  }
  return { pulled, pushed };
}

/**
 * 会话：按项目目录名（= projectKey(cwd)）逐个合并。
 * 已登记的工作区按映射改名并改写 cwd；不在工作区索引里的项目目录（在别的文件夹里开过会话）
 * 也照搬，否则这些会话换台机器就「消失」了。
 */
function mergeSessions(home, dir, mapping, stats, dry) {
  const lRoot = path.join(home, 'sessions');
  const bRoot = path.join(dir, 'home', 'sessions');
  const listDirs = (root) => {
    try {
      return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const pairs = new Map(); // 中转站的项目目录名 -> 本机项目目录名
  for (const m of mapping) {
    pairs.set(projectKey(m.bundlePath), { lKey: projectKey(m.localPath), cwdA: m.localPath, cwdB: m.bundlePath, label: path.basename(m.localPath) });
  }
  // 已经通过上面映射处理过的「本机项目目录」，不能再被当成「索引外的散目录」搬一遍，
  // 否则中转站里会出现同一个工作区的两份目录（一份按包内路径、一份按本机路径），会话跟着重复。
  const mappedLocal = new Set(mapping.map((m) => projectKey(m.localPath)));
  for (const key of [...listDirs(lRoot), ...listDirs(bRoot)]) {
    if (pairs.has(key) || mappedLocal.has(key)) continue;
    pairs.set(key, { lKey: key, cwdA: null, cwdB: null, label: key });
  }
  let pulled = 0;
  let pushed = 0;
  for (const [bKey, info] of pairs) {
    const r = mergeSessionDirs(path.join(lRoot, info.lKey), path.join(bRoot, bKey), info.cwdA, info.cwdB, stats, dry, home);
    pulled += r.pulled;
    pushed += r.pushed;
    if (r.pulled || r.pushed) log(`  会话（${info.label}）：拉入 ${r.pulled} / 推出 ${r.pushed}`);
  }
  stats.sessionsPulled += pulled;
  stats.sessionsPushed += pushed;
}

/** storages：workspace.json 之外的 JSON 存储按时间双向合并，路径跨机器改写。 */
function mergeStorages(home, dir, mapping, dry) {
  const a = path.join(home, 'storages');
  const b = path.join(dir, 'home', 'storages');
  if (!isDir(a) && !isDir(b)) return;
  const translate = (text, fromRoot, toRoot) => {
    if (!fromRoot || !toRoot || samePath(fromRoot, toRoot)) return text;
    const pairs = [
      [fromRoot, toRoot],
      [fromRoot.replace(/\\/g, '/'), toRoot.replace(/\\/g, '/')],
      [JSON.stringify(fromRoot).slice(1, -1), JSON.stringify(toRoot).slice(1, -1)],
    ];
    let out = text;
    for (const [x, y] of pairs) if (x) out = out.split(x).join(y);
    return out;
  };
  const roots = mapping.map((m) => ({ local: m.localPath, bundle: m.bundlePath }));
  const skip = (rel) => rel.split(/[\\/]/)[0] === 'workspace.json';
  // storages 里不全是 JSON：插件可能塞 sqlite / 二进制快照进来。
  // 文本文件才做路径改写，二进制按时间整份复制（用 utf8 读会把它们写坏）。
  const isText = (p) => {
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) return false;
    return !buf.toString('utf8').includes('\uFFFD');
  };
  const moveText = (from, to, translateFrom, translateTo) => {
    let text = fs.readFileSync(from, 'utf8');
    for (const r of roots) text = translate(text, translateFrom(r), translateTo(r));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text);
  };
  const keepOld = (rel) => backupSave('home', home, path.join('storages', rel));

  const filesA = walkRel(a, skip);
  const filesB = walkRel(b, skip);
  for (const rel of new Set([...filesA.keys(), ...filesB.keys()])) {
    const pa = path.join(a, rel);
    const pb = path.join(b, rel);
    const sa = filesA.get(rel);
    const sb = filesB.get(rel);
    if (!sa) {
      if (dry) continue;
      keepOld(rel);
      if (isText(pb)) moveText(pb, pa, (r) => r.bundle, (r) => r.local);
      else copyFilePreserve(pb, pa);
      continue;
    }
    if (!sb) {
      if (dry) continue;
      if (isText(pa)) moveText(pa, pb, (r) => r.local, (r) => r.bundle);
      else copyFilePreserve(pa, pb);
      continue;
    }
    if (Math.abs(sa.mtimeMs - sb.mtimeMs) < 2000) continue;
    if (dry) continue;
    if (sa.mtimeMs > sb.mtimeMs) {
      if (isText(pa)) moveText(pa, pb, (r) => r.local, (r) => r.bundle);
      else copyFilePreserve(pa, pb);
    } else {
      keepOld(rel);
      if (isText(pb)) moveText(pb, pa, (r) => r.bundle, (r) => r.local);
      else copyFilePreserve(pb, pa);
    }
  }
}

/** 把一段文本里的 link: 绝对路径从 from 换算成 to（兼容正斜杠与反斜杠两种写法）。 */
function translateLink(text, from, to) {
  if (!from || !to || samePath(from, to)) return text;
  return text
    .split(`link:${from.replace(/\\/g, '/')}`)
    .join(`link:${to.replace(/\\/g, '/')}`)
    .split(`link:${from}`)
    .join(`link:${to}`);
}

/** 纯文本里的绝对路径换算（正斜杠、反斜杠两种写法都换），用于 lockfile 等。 */
function translatePathText(text, from, to) {
  if (!from || !to || samePath(from, to)) return text;
  return text.split(from.replace(/\\/g, '/')).join(to.replace(/\\/g, '/')).split(from).join(to);
}

/** 整目录拷贝后，把里面各 profile package.json 的 link: 路径统一换算。 */
function translateAllLinks(selfRoot, otherRoot, mapping, dir) {
  if (!isDir(selfRoot)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(selfRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const pdir = path.join(selfRoot, e.name);
    const odir = path.join(otherRoot, e.name);
    // package.json 用绝对 link:，lockfile 用相对 link:（相对另一台机器的 profile 目录），
    // 所以相对形式要先按对侧目录还原成绝对路径，换算后再相对本机目录重算。
    const rebase = (text) =>
      text.replace(/link:(\.\.[^\s"']*)/g, (whole, rel) => {
        const absOld = path.resolve(odir, rel.split('/').join(path.sep));
        let absNew = absOld;
        for (const m of mapping) absNew = translatePathText(absNew, dir === 'toLocal' ? m.bundlePath : m.localPath, dir === 'toLocal' ? m.localPath : m.bundlePath);
        // 即使目标绝对路径没变（同一台机器、同一工作区），相对基准目录也换了，
        // 必须按新的 profile 目录重算一遍相对路径，否则包里的相对链接是坏的。
        const out = 'link:' + path.relative(pdir, absNew).replace(/\\/g, '/');
        return out === whole ? whole : out;
      });
    for (const fname of ['package.json', 'pnpm-lock.yaml']) {
      const file = path.join(pdir, fname);
      if (!exists(file)) continue;
      const before = fs.readFileSync(file, 'utf8');
      let after = before;
      for (const m of mapping) {
        const [from, to] = dir === 'toLocal' ? [m.bundlePath, m.localPath] : [m.localPath, m.bundlePath];
        after = translatePathText(after, from, to);
      }
      after = rebase(after);
      if (after !== before) {
        fs.writeFileSync(file, after);
        n++;
      }
    }
  }
  return n;
}

/** profiles：package.json 依赖取并集，cordis 配置按时间取新。返回本地 package.json 是否变化。 */
/**
 * 本机插件目录能不能用：node_modules 缺失、某个依赖没落地、
 * 或者 link: 依赖指向的目录不存在（手工拷 .dsh 后最常见）都算坏。
 */
function localProfileBroken(home) {
  const root = path.join(home, 'profiles');
  if (!isDir(root)) return false;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const pkgFile = path.join(dir, 'package.json');
    if (!exists(pkgFile)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    const deps = pkg.dependencies || {};
    if (!Object.keys(deps).length) continue;
    const nm = path.join(dir, 'node_modules');
    if (!isDir(nm)) return true;
    for (const [dep, spec] of Object.entries(deps)) {
      if (!exists(path.join(nm, dep))) return true;
      const m = /^link:(.+)$/.exec(String(spec));
      if (m && !isDir(path.resolve(dir, m[1]))) return true;
    }
  }
  return false;
}

function mergeProfiles(home, dir, mapping, dry, stats) {
  const a = path.join(home, 'profiles');
  const b = path.join(dir, 'home', 'profiles');
  const skipNm = (p) => {
    const parts = p.split(/[\\/]/);
    if (parts.includes('node_modules')) return true;
    if (p.toLowerCase().endsWith('.bak')) return true;            // 插件管理器留下的备份
    if (parts.includes('.plugin-manager') && parts.includes('logs')) return true;
    return false;
  };
  if (!isDir(a) && isDir(b)) {
    if (!dry) {
      copyTree(b, a, skipNm);
      translateAllLinks(a, b, mapping, 'toLocal');
    }
    log('  插件目录：本地没有，从包里整份复制（不含 node_modules）');
    return true;
  }
  if (isDir(a) && !isDir(b)) {
    if (!dry) {
      copyTree(a, b, skipNm);
      translateAllLinks(b, a, mapping, 'toBundle');
    }
    log('  插件目录：中转站里还没有，已整份推上去（不含 node_modules）');
    return false;
  }
  if (!isDir(a) || !isDir(b)) return false;
  const translate = translateLink;
  const keepOld = (abs) => backupSave('profiles', a, path.relative(a, abs));
  let localChanged = false;
  const names = new Set([
    ...fs.readdirSync(a, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
    ...fs.readdirSync(b, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  ]);
  for (const name of names) {
    const pa = path.join(a, name, 'package.json');
    const pb = path.join(b, name, 'package.json');
    if (exists(pa) && exists(pb)) {
      const ja = JSON.parse(fs.readFileSync(pa, 'utf8').replace(/^\uFEFF/, ''));
      const jb = JSON.parse(fs.readFileSync(pb, 'utf8').replace(/^\uFEFF/, ''));
      ja.dependencies = ja.dependencies || {};
      jb.dependencies = jb.dependencies || {};
      let changedLocal = false;
      let changedBundle = false;
      for (const [dep, spec] of Object.entries(jb.dependencies)) {
        if (ja.dependencies[dep] === undefined) {
          let v = spec;
          for (const m of mapping) v = translate(v, m.bundlePath, m.localPath);
          ja.dependencies[dep] = v;
          changedLocal = true;
          log(`  插件 += ${dep}（从包里补上）`);
        }
      }
      for (const [dep, spec] of Object.entries(ja.dependencies)) {
        if (jb.dependencies[dep] === undefined) {
          let v = spec;
          for (const m of mapping) v = translate(v, m.localPath, m.bundlePath);
          jb.dependencies[dep] = v;
          changedBundle = true;
          log(`  插件 += ${dep}（推进包里）`);
        }
      }
      if (!dry && changedLocal) {
        keepOld(pa);
        fs.writeFileSync(pa, JSON.stringify(ja, null, 2) + '\n');
        localChanged = true;
      }
      if (!dry && changedBundle) fs.writeFileSync(pb, JSON.stringify(jb, null, 2) + '\n');
    } else if (exists(pa) && !exists(pb)) {
      if (!dry) {
        fs.mkdirSync(path.dirname(pb), { recursive: true });
        fs.copyFileSync(pa, pb);
      }
    } else if (!exists(pa) && exists(pb)) {
      if (!dry) {
        fs.mkdirSync(path.dirname(pa), { recursive: true });
        fs.copyFileSync(pb, pa);
        localChanged = true;
      }
    }
    // cordis / pnpm 配置：时间新的覆盖旧的
    for (const f of ['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      const x = path.join(a, name, f);
      const y = path.join(b, name, f);
      const sx = statOrNull(x);
      const sy = statOrNull(y);
      if (sx && sy) {
        if (Math.abs(sx.mtimeMs - sy.mtimeMs) < 2000) {
          // 同一秒两边都改过：先比内容，真不一样才留档（保留本机那份）。
          let same = false;
          try {
            same = fs.readFileSync(x).equals(fs.readFileSync(y));
          } catch {
            same = false;
          }
          if (same) continue;
          if (dry) continue;
          // 内容不同：按字节定胜负，胜者写回两边并抹平 mtime（下一轮直接跳过）。
          const localWins = Buffer.compare(fs.readFileSync(x), fs.readFileSync(y)) > 0;
          const keep = path.join(path.dirname(x), `${f}.conflict-${stamp()}`);
          copyFilePreserve(localWins ? y : x, keep);
          if (localWins) copyFilePreserve(x, y);
          else {
            keepOld(x);
            copyFilePreserve(y, x);
          }
          warn(`  ${name}/${f} 两边都改过，采用${localWins ? '本机' : '中转站'}那份（另一份另存 .conflict-<时间戳>）`);
          const now = new Date();
          fs.utimesSync(x, now, now);
          fs.utimesSync(y, now, now);
          continue;
        }
        if (dry) continue;
        if (sx.mtimeMs > sy.mtimeMs) copyFilePreserve(x, y);
        else {
          keepOld(x);
          copyFilePreserve(y, x);
        }
      } else if (sx && !sy && !dry) {
        fs.mkdirSync(path.dirname(y), { recursive: true });
        fs.copyFileSync(x, y);
      } else if (!sx && sy && !dry) {
        fs.mkdirSync(path.dirname(x), { recursive: true });
        fs.copyFileSync(y, x);
      }
    }

    // 插件自己在 profile 目录里写的私有文件（清单、缓存、本地设置……）：
    // 名字我不可能全知道，就整目录按时间双向合并，跳过上面已单独处理的几个。
    const special = new Set(['package.json', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']);
    const skipOther = (rel) => {
      const parts = rel.split(/[\\/]/);
      if (parts.includes('node_modules')) return true;
      if (parts[0] === '.plugin-manager') return true;
      if (/\.bak$/i.test(rel)) return true;
      return special.has(rel);
    };
    const scratch = { pulled: 0, pushed: 0, unchanged: 0, fileConflicts: 0, sessionConflicts: 0, sessionsPulled: 0, sessionsPushed: 0 };
    mergeTree(path.join(a, name), path.join(b, name), {
      skip: skipOther,
      dry,
      stats: stats || scratch,
      scope: `prof:${name}`,
      label: `${name}/插件私有文件`,
    });
  }
  if (!dry && localChanged) translateAllLinks(a, b, mapping, 'toLocal');
  if (!dry) translateAllLinks(b, a, mapping, 'toBundle');
  return localChanged;
}

/* -------------------------------------------------------------- 墓碑记录 */
// 同步只增不删时，一台机器上删掉的文件会被另一台原样推回来。这里用「墓碑」
// 记住「上次快照里有的文件，这次不见了」，让删除也能跨机传播；同时保证
// 「删完之后又在另一台改过」的文件不会被误删（按修改时间判断，新的赢）。

const STATE_VERSION = 1;
const BACKUP_VERSION = 1;
const BACKUP_DIR_NAME = '.dsh-migrate-backup';
const BACKUP_KEEP = 5;
let BK = null; // 本次同步的写前镜像会话；null 表示不备份
const TOMB_KEEP_MS = 30 * 24 * 3600 * 1000;
const TOMB_MAX = 5000;

// 这些路径宁可不传播删除：DSH 自己会重建，删错了代价远大于多留一份。
const PROTECTED_LOCAL_RE = [
  /^storages[\\/]workspace\.json$/i,
  /^profiles[\\/][^\\/]+[\\/](package\.json|cordis\.yml|cordis\.patch\.yml|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/i,
];

function isProtectedLocal(rel) {
  const norm = rel.replace(/\\/g, '/');
  return PROTECTED_LOCAL_RE.some((re) => re.test(norm));
}

function scopeSkip(withGit, hasTopGit) {
  return (rel) => {
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => NEVER_SYNC_DIRS.has(p))) return true;
    if (!withGit && (hasTopGit ? parts[0] === '.git' : parts.includes('.git'))) return true;
    const base = parts[parts.length - 1];
    if (NEVER_SYNC_FILES.has(base)) return true;
    if (VOLATILE_RE.test(rel)) return true;
    return false;
  };
}

function walkPaths(root, skip) {
  const out = new Set();
  if (!isDir(root)) return out;
  const walk = (rel) => {
    let ents;
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (skip && skip(r)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.add(r);
    }
  };
  walk('');
  return out;
}

function pruneEmptyDirs(file, root) {
  let d = path.dirname(file);
  const stop = path.resolve(root);
  while (path.resolve(d) !== stop && path.resolve(d).startsWith(stop + path.sep)) {
    try {
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

function stateFile(dir) {
  return path.join(dir, 'state.json');
}

// 墓碑放在中转站里（两台机器共用一份账本），每台机器的「上次快照」放在本机 ——
// 快照如果也共用，一台机器会把另一台新增、自己还没拉过的文件误判成「被删了」。
function localStateFile(home) {
  return path.join(home, '.dsh-migrate-state.json');
}

function loadState(dir) {
  const f = stateFile(dir);
  if (!exists(f)) return { format: STATE_VERSION, deleted: [] };
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    return { format: STATE_VERSION, deleted: Array.isArray(s.deleted) ? s.deleted : [] };
  } catch {
    return { format: STATE_VERSION, deleted: [] };
  }
}

function saveState(dir, state) {
  const cutoff = Date.now() - TOMB_KEEP_MS;
  state.deleted = state.deleted.filter((t) => t && t.at > cutoff).slice(-TOMB_MAX);
  writeIndex(stateFile(dir), { format: STATE_VERSION, deleted: state.deleted });
}

function loadLocalState(home) {
  const f = localStateFile(home);
  if (!exists(f)) return { format: STATE_VERSION, snapshot: {} };
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    return { format: STATE_VERSION, snapshot: s.snapshot || {} };
  } catch {
    return { format: STATE_VERSION, snapshot: {} };
  }
}

function saveLocalState(home, state) {
  writeIndex(localStateFile(home), { format: STATE_VERSION, snapshot: state.snapshot });
}

/** 应用别的机器记下的墓碑：本机这份没被改过就删掉；改过就留下（复活）。 */
function applyTombstones(root, scope, state, dry, stats) {
  if (!isDir(root)) return;
  const keep = [];
  for (const t of state.deleted) {
    if (!t || t.scope !== scope || !t.path) {
      keep.push(t);
      continue;
    }
    const abs = path.join(root, t.path);
    const st = statOrNull(abs);
    if (!st) {
      // 本机也没有这份：留着墓碑，好让另一台（还没同步的那台）也删掉。
      keep.push(t);
      continue;
    }
    if (st.mtimeMs >= t.at) {
      stats.resurrected++;
      continue; // 删完之后又被改过：文件留下，墓碑作废
    }
    if (dry) {
      stats.deletedPulled++;
      keep.push(t);
      continue;
    }
    try {
      backupSave(scope, root, t.path);
      fs.rmSync(abs, { force: true });
      pruneEmptyDirs(abs, root);
      stats.deletedPulled++;
    } catch (e) {
      warn(`  删除失败 ${t.path}：${e.message}`);
      keep.push(t);
    }
  }
  state.deleted = keep;
}

/** 上次快照里有、这次本机没了 → 从中转站删掉并记墓碑，避免被另一台推回来。 */
function detectLocalDeletions(root, scope, prev, bundleRoot, state, dry, stats, skip) {
  if (!prev || !prev.size) return;
  const cur = walkPaths(root, skip);
  for (const p of prev) {
    if (cur.has(p)) continue;
    if (isProtectedLocal(p)) continue;
    const b = path.join(bundleRoot, p);
    if (!exists(b)) continue;
    if (dry) {
      stats.deletedPushed++;
      continue;
    }
    try {
      fs.rmSync(b, { force: true });
      pruneEmptyDirs(b, bundleRoot);
    } catch (e) {
      warn(`  删除中转站文件失败 ${p}：${e.message}`);
      continue;
    }
    state.deleted.push({ scope, path: p, at: Date.now() });
    stats.deletedPushed++;
  }
}

function recordSnapshot(root, scope, state, skip) {
  state.snapshot[scope] = [...walkPaths(root, skip)].sort();
}

function prevSnapshot(state, scope) {
  const arr = state.snapshot[scope];
  return new Set(Array.isArray(arr) ? arr : []);
}

/* ------------------------------------------------------------------- sync */

/* ---- 写前镜像 ---------------------------------------------------------------
 * 同步会改本机文件：从中转站覆盖、写冲突留档、按墓碑删除。这些动作一旦判断错了，
 * 用户唯一的退路就是「另一台机器也还有一份」—— 但两台机器同时被写坏时就没有退路了。
 * 所以每次改动之前，先把那份原始文件拷进 ~/.dsh/.dsh-migrate-backup/<时间戳>/。
 * 只存被改到的文件（通常几 MB），保留最近 BACKUP_KEEP 次，`undo` 可以整份回滚。
 */

function backupRoot(home) {
  return path.join(home, BACKUP_DIR_NAME);
}

function sanitizeScope(scope) {
  return String(scope).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'root';
}

/** 开始一次同步的镜像目录；返回 null 表示这次不备份。 */
function backupStart(home, opts) {
  if (!home || opts.noBackup || opts.dry) return null;
  // 同一秒内连跑两次时，目录名要能区分开，否则第二次会把第一次的镜像写进同一个目录，
  // 前一次的 _manifest.json 被覆盖，那份备份就再也回滚不回来了。
  const root = backupRoot(home);
  const base = stamp();
  let name = base;
  for (let n = 2; fs.existsSync(path.join(root, name)); n++) name = `${base}-${n}`;
  return { home, dir: path.join(root, name), scopes: new Map(), entries: [], saved: new Set() };
}

/** 改动 root/rel 之前把它存一份。同一路径一次同步只存最早的那份。 */
function backupSave(scope, root, rel) {
  const bk = BK;
  if (!bk || !rel) return;
  const key = `${scope}\u0000${rel}`;
  if (bk.saved.has(key)) return;
  const src = path.join(root, rel);
  if (!exists(src)) return;
  const dst = path.join(bk.dir, sanitizeScope(scope), rel);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (isDir(src)) copyTree(src, dst);
    else copyFilePreserve(src, dst);
  } catch (e) {
    warn(`  备份失败 ${rel}：${e.message}`);
    return;
  }
  bk.saved.add(key);
  if (!bk.scopes.has(scope)) bk.scopes.set(scope, root);
  bk.entries.push({ scope, path: rel.split(path.sep).join('/'), kind: isDir(dst) ? 'dir' : 'file' });
}

function backupFinish(bk) {
  if (!bk) return;
  if (!bk.entries.length) {
    // 什么都没改：不要留下空的备份目录，免得 undo 列表里全是噪音。
    rmrf(bk.dir);
    return;
  }
  const manifest = {
    format: BACKUP_VERSION,
    at: new Date().toISOString(),
    home: bk.home,
    scopes: [...bk.scopes].map(([id, root]) => ({ id, root })),
    entries: bk.entries,
  };
  fs.mkdirSync(bk.dir, { recursive: true });
  fs.writeFileSync(path.join(bk.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log(`  已备份 ${bk.entries.length} 项到 ${bk.dir}`);
}

function listBackups(home) {
  const root = backupRoot(home);
  if (!isDir(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root).sort().reverse()) {
    const dir = path.join(root, name);
    const mf = path.join(dir, 'manifest.json');
    if (!exists(mf)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8').replace(/^\uFEFF/, ''));
      out.push({ stamp: name, dir, manifest: m });
    } catch {
      /* 损坏的备份目录跳过，不影响其它几次 */
    }
  }
  return out;
}

/** 只保留最近 BACKUP_KEEP 次；更早的连同目录一起删掉。 */
function pruneBackups(home) {
  const all = listBackups(home);
  for (const b of all.slice(BACKUP_KEEP)) rmrf(b.dir);
}

function cmdUndo(opts) {
  const home = path.resolve(opts.home || defaultHome());
  const runs = listBackups(home);
  if (!runs.length) {
    warn(`没有找到备份：${backupRoot(home)}`);
    process.exit(1);
  }
  if (opts.list) {
    log(`备份（${runs.length} 次，最新在前）：${backupRoot(home)}`);
    for (const b of runs) {
      const when = b.manifest.at ? new Date(b.manifest.at).toLocaleString() : b.stamp;
      log(`  ${b.stamp}  ${when}  ${b.manifest.entries.length} 项`);
    }
    return;
  }
  const run = opts.at ? runs.find((b) => b.stamp === String(opts.at)) : runs[0];
  if (!run) {
    warn(`没有这次备份：${opts.at}`);
    process.exit(1);
  }
  const roots = new Map((run.manifest.scopes || []).map((s) => [s.id, s.root]));
  log(`回滚 ${run.stamp}（${run.manifest.entries.length} 项）`);
  let done = 0;
  let skipped = 0;
  for (const e of run.manifest.entries) {
    const scopeRoot = roots.get(e.scope);
    if (!scopeRoot) {
      skipped++;
      continue;
    }
    const from = path.join(run.dir, sanitizeScope(e.scope), e.path);
    const to = path.join(scopeRoot, e.path);
    if (!exists(from)) {
      skipped++;
      continue;
    }
    log(`  ${e.scope}/${e.path}`);
    if (opts.dry) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (isDir(from)) {
      rmrf(to);
      copyTree(from, to);
    } else {
      copyFilePreserve(from, to);
    }
    done++;
  }
  if (opts.dry) {
    log(`  （--dry-run，没有写任何文件）`);
    return;
  }
  log(`已恢复 ${done} 项${skipped ? `，跳过 ${skipped} 项` : ''}`);
  log(`  回滚之后建议再跑一次 sync，让两台机器重新对齐。`);
}

function cmdSync(opts) {
  const dir = path.resolve(opts.with || opts.in);
  const home = path.resolve(opts.home || defaultHome());
  const dry = !!opts.dryRun;
  assertAppClosed(opts);
  if (!isDir(home)) {
    // 第一次在这台机器上接力：家目录还不存在就建一个，等同步把它填满，
    // 不必先启动一次 DSH（虽然启动一次能顺带装好内置运行时，安装步骤仍会提示）。
    if (dry) {
      warn(`找不到 DSH home：${home}`);
      process.exit(1);
    }
    fs.mkdirSync(home, { recursive: true });
    log(`已创建空的 DSH home：${home}`);
  }
  for (const id of readWorkspaceIndex(home).ids) {
    const wp = readWorkspaceIndex(home).workspaces[id]?.path;
    if (wp && isInside(dir, wp)) {
      warn(`中转目录在工作区内部：${dir}\n     U 盘请放在根目录，或用 --with 指定别的位置。`);
      process.exit(1);
    }
  }

  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const mfFile = path.join(dir, 'manifest.json');
  let mf = exists(mfFile) ? JSON.parse(fs.readFileSync(mfFile, 'utf8').replace(/^\uFEFF/, '')) : null;
  const firstRun = !mf;
  if (!mf) {
    mf = {
      format: FORMAT,
      createdAt: new Date().toISOString(),
      source: { home, platform: process.platform, hostname: os.hostname(), username: os.userInfo().username, userProfile: os.homedir() },
      workspaces: [],
      profiles: [],
    };
  }

  step(firstRun ? '首次同步：把这个中转站初始化成一份完整快照' : '双向同步');
  const { mapping, idx } = resolveSyncMapping(home, mf, opts);

  // 某些工作区可能大到不该跟着同步（游戏目录、素材库、几百 GB 的工程），
  // 用 --skip-workspace <路径或目录名> 把它们排除在本次同步之外。
  const skipWs = skipWorkspaceMatcher(opts);
  for (let i = mapping.length - 1; i >= 0; i--) {
    const m = mapping[i];
    if (skipWs(m.localPath) || skipWs(m.bundlePath)) {
      warn(`按 --skip-workspace 跳过工作区：${m.localPath}`);
      mapping.splice(i, 1);
    }
  }

  for (const m of mapping) {
    if (m.isNewLocal) log(`  工作区新增到本机：${m.localPath}`);
    if (m.isNewBundle) log(`  工作区新增到中转站：${m.bundlePath}`);
  }

  // 给「包里还没有」的工作区分配目录
  let next = 0;
  for (const m of mapping) {
    if (!m.bundleDir) {
      m.bundleDir = `workspaces/ws-${next++}`;
      if (!m.bundle) {
        const id = m.localId;
        m.bundle = { id, title: path.basename(m.bundlePath), path: m.bundlePath, dir: m.bundleDir, sessionsDir: projectKey(m.bundlePath) };
        mf.workspaces.push(m.bundle);
      }
    }
  }

  const stats = {
    pulled: 0,
    pushed: 0,
    unchanged: 0,
    fileConflicts: 0,
    sessionConflicts: 0,
    sessionsPulled: 0,
    sessionsPushed: 0,
    deletedPulled: 0,
    deletedPushed: 0,
    resurrected: 0,
  };
  const withGit = !!opts.withGit;
  const noDelete = !!opts.noDelete;
  const state = loadState(dir); // 中转站：墓碑账本（两台共用）
  const lstate = loadLocalState(home); // 本机：上次快照（各自一份）
  const bundleHome = path.join(dir, 'home');
  const homeSkip = scopeSkip(withGit, false);
  BK = backupStart(home, opts);

  /* 0) 删除传播：先处理墓碑，再找出「上次有、这次没了」的文件。
        必须放在合并之前 —— 合并会把中转站那份重新拉回来，之后就分不清是删除还是缺失。 */
  if (!noDelete) {
    applyTombstones(home, 'home', state, dry, stats);
    detectLocalDeletions(home, 'home', prevSnapshot(lstate, 'home'), bundleHome, state, dry, stats, homeSkip);
  }

  /* 1) 工作区文件 */
  step('工作区文件');
  for (const m of mapping) {
    const scope = `ws:${m.bundleDir}`;
    const bundleRoot = path.join(dir, m.bundleDir);
    const skip = (rel) => {
      const parts = rel.split(/[\\/]/);
      if (parts.includes('node_modules')) return true;
      if (!withGit && parts[0] === '.git') return true;
      return false;
    };
    if (!noDelete) {
      applyTombstones(m.localPath, scope, state, dry, stats);
      detectLocalDeletions(m.localPath, scope, prevSnapshot(lstate, scope), bundleRoot, state, dry, stats, skip);
    }
    const before = { ...stats };
    mergeTree(m.localPath, bundleRoot, {
      skip,
      dry,
      stats,
      scope,
      label: path.basename(m.localPath),
    });
    if (!dry) recordSnapshot(m.localPath, scope, lstate, skip);
    const dP = stats.pulled - before.pulled;
    const dQ = stats.pushed - before.pushed;
    if (dP || dQ) log(`  ${path.basename(m.localPath)}：拉入 ${dP} 个文件 / 推出 ${dQ} 个`);
  }

  /* 2) 会话 */
  step('会话');
  mergeSessions(home, dir, mapping, stats, dry);

  /* 3) 存储索引 */
  step('工作区索引');
  const { localJson, bundleJson } = syncWorkspaceIndex(home, dir, mapping, idx, dry);
  if (localJson && bundleJson) {
    mergeSessionIds(localJson, bundleJson, mapping);
    if (!dry) {
      backupSave('home', home, path.relative(home, idx.file));
      const wroteLocal = writeIndex(idx.file, localJson);
      const wroteBundle = writeIndex(path.join(dir, 'home', 'storages', 'workspace.json'), bundleJson);
      if (wroteLocal || wroteBundle) log('  两边的 workspace.json 已合并（工作区 id、会话列表取并集）');
    } else {
      log('  两边的 workspace.json 已合并（工作区 id、会话列表取并集）');
    }
  }

  /* 4) 其它存储 */
  step('其它存储');
  mergeStorages(home, dir, mapping, dry);
  log('  投影缓存 / 会话策略已按时间合并');

  /* 5) 插件数据目录与附件 */
  step('附件与插件数据');
  const dataDirs = new Set([...discoverDataDirs(home), ...discoverDataDirs(bundleHome)]);
  for (const name of [...dataDirs].sort()) {
    const la = path.join(home, name);
    const lb = path.join(bundleHome, name);
    if (!isDir(la) && !isDir(lb)) continue;
    const scope = `dir:${name}`;
    if (!noDelete && isDir(la)) {
      applyTombstones(la, scope, state, dry, stats);
      detectLocalDeletions(la, scope, prevSnapshot(lstate, scope), lb, state, dry, stats, homeSkip);
    }
    fs.mkdirSync(la, { recursive: true });
    fs.mkdirSync(lb, { recursive: true });
    const before = { ...stats };
    mergeTree(la, lb, { dry, stats, scope, label: name, contentAddressed: name === 'attachments' });
    if (!dry) recordSnapshot(la, scope, lstate, homeSkip);
    const dP = stats.pulled - before.pulled;
    const dQ = stats.pushed - before.pushed;
    if (dP || dQ) log(`  ${name}：拉入 ${dP} 个文件 / 推出 ${dQ} 个`);
  }
  const homeFiles = new Set([...discoverHomeFiles(home), ...discoverHomeFiles(bundleHome)]);
  for (const f of [...homeFiles].sort()) {
    const x = path.join(home, f);
    const y = path.join(bundleHome, f);
    const sx = statOrNull(x);
    const sy = statOrNull(y);
    if (sx && sy) {
      if (Math.abs(sx.mtimeMs - sy.mtimeMs) < 2000) {
        // 时间接近：先比内容。不能因为「差不到 2 秒」就当成没变 —— 同一秒两边各写一次很常见。
        let same = false;
        try {
          same = fs.readFileSync(x).equals(fs.readFileSync(y));
        } catch {
          same = false;
        }
        if (same) continue;
        if (dry) continue;
        const localWins = Buffer.compare(fs.readFileSync(x), fs.readFileSync(y)) > 0;
        const keep = path.join(home, `${f}.conflict-${stamp()}`);
        copyFilePreserve(localWins ? y : x, keep);
        if (localWins) copyFilePreserve(x, y);
        else {
          backupSave('home', home, f);
          copyFilePreserve(y, x);
        }
        warn(`  ${f} 两边都改过，采用${localWins ? '本机' : '中转站'}那份（另一份另存 .conflict-<时间戳>）`);
        stats.fileConflicts++;
        const now = new Date();
        fs.utimesSync(x, now, now);
        fs.utimesSync(y, now, now);
        continue;
      }
      if (dry) continue;
      if (sx.mtimeMs > sy.mtimeMs) {
        copyFilePreserve(x, y);
        stats.pushed++;
      } else {
        backupSave('home', home, f);
        copyFilePreserve(y, x);
        stats.pulled++;
      }
    } else if (sx && !sy && !dry) {
      copyFilePreserve(x, y);
      stats.pushed++;
    } else if (!sx && sy && !dry) {
      copyFilePreserve(y, x);
      stats.pulled++;
    }
  }
  // 插件数据目录（在 DSH home 之外的用户目录里）：默认不动，--with-plugin-data 才合并
  const pdEntries = pluginDataEntries(opts);
  const pdKnown = new Map();
  for (const e of mf.pluginData || []) {
    if (e && typeof e === 'object' && e.label) pdKnown.set(e.label, e.path);
    else if (typeof e === 'string') pdKnown.set(e, path.join(mf.source?.userProfile || os.homedir(), e));
  }
  if (pdEntries.length) {
    for (const { label, abs } of pdEntries) {
      const bu = path.join(dir, PLUGIN_DATA_ROOT, label);
      if (!isDir(abs) && !isDir(bu)) continue;
      const scope = `pd:${label}`;
      if (!noDelete && isDir(abs)) {
        applyTombstones(abs, scope, state, dry, stats);
        detectLocalDeletions(abs, scope, prevSnapshot(lstate, scope), bu, state, dry, stats, homeSkip);
      }
      fs.mkdirSync(abs, { recursive: true });
      fs.mkdirSync(bu, { recursive: true });
      const before = { ...stats };
      mergeTree(abs, bu, { dry, stats, scope, label });
      if (!dry) recordSnapshot(abs, scope, lstate, homeSkip);
      const dP = stats.pulled - before.pulled;
      const dQ = stats.pushed - before.pushed;
      log(`  ${label}：拉入 ${dP} 个文件 / 推出 ${dQ} 个`);
    }
    if (!dry) {
      mf.includesPluginData = true;
      mf.pluginData = pdEntries.map((e) => ({ label: e.label, path: e.abs }));
    }
  } else if (mf.includesPluginData) {
    const names = [...pdKnown.keys()].join(', ');
    log(`  中转站里有插件数据（${names}），本次没加 --with-plugin-data，已跳过`);
  }

  /* 6) 插件清单 */
  step('插件清单');
  const pkgChanged = mergeProfiles(home, dir, mapping, dry, stats);
  if (!dry) mf.profiles = profileDirs(home).map((p) => ({ name: p.name, linkDeps: linkDeps(p.dir) }));
  // 以前手工拷过 .dsh 的机器，node_modules 里的 junction 往往指向另一台机器的路径：
  // 清单没变也装不上，所以这里额外体检一次，坏了就重装。
  const nmBroken = !dry && localProfileBroken(home);

  /* 7) 清单文件 */
  if (!dry) {
    mf.source = mf.source || {};
    mf.syncedAt = new Date().toISOString();
    mf.syncedBy = { hostname: os.hostname(), username: os.userInfo().username, home, userProfile: os.homedir() };
    writeIndex(mfFile, mf);
    recordSnapshot(home, 'home', lstate, homeSkip);
    saveLocalState(home, lstate);
    saveState(dir, state);
  }

  /* 8) 需要时装插件 */
  if ((pkgChanged || nmBroken) && !opts.noInstall && !dry) {
    const dsh = findDshCli();
    if (dsh) {
      step(nmBroken ? '插件目录不完整（本次复制过 .dsh 的典型后遗症），重新安装' : '安装新增插件');
      const env = { ...process.env, DSH_HOME: home };
      for (const p of profileDirs(home)) {
        log(`  $ dsh plugin --profile ${p.name} install`);
        spawnSync(`"${dsh}" plugin --profile ${p.name} install`, { stdio: 'inherit', shell: true, env });
      }
    } else {
      warn('有新增插件但没找到 dsh 命令，请手动执行：dsh plugin --profile desktop install');
    }
  }

  backupFinish(BK);
  BK = null;
  if (!dry) pruneBackups(home);

  step(dry ? '完成（--dry-run，未写入任何东西）' : '完成');
  log(`  中转站：${dir}`);
  log(`  会话：拉入 ${stats.sessionsPulled} / 推出 ${stats.sessionsPushed}`);
  log(`  文件：拉入 ${stats.pulled} / 推出 ${stats.pushed} / 冲突 ${stats.fileConflicts}`);
  if (stats.deletedPulled || stats.deletedPushed || stats.resurrected) {
    log(`  删除：本机删 ${stats.deletedPulled} / 中转站删 ${stats.deletedPushed}${stats.resurrected ? ` / 复活留用 ${stats.resurrected}` : ''}`);
  }
  if (stats.fileConflicts) warn('  冲突文件已保留本地版本，另一份另存为 .conflict-<时间戳>');
  if (stats.sessionConflicts) warn('  冲突会话已按「最后写入时间新的赢」收敛，旧的一份另存为 .conflict-<时间戳>');
  if (!dry) log('  两台机器现在内容一致，可以直接换机继续。');
}

/* ------------------------------------------------------------------ status */

function cmdStatus(opts) {
  const home = opts.home || defaultHome();
  if (!isDir(home)) {
    warn(`找不到 DSH home：${home}`);
    process.exit(1);
  }
  const index = readWorkspaceIndex(home);
  log(`DSH home：${home}   (${mb(walkSize(home))})`);
  if (cfgFile) log(`配置文件：${cfgFile}`);
  log(`\n工作区（${index.ids.length}）：`);
  for (const id of index.ids) {
    const ws = index.workspaces[id];
    const key = projectKey(ws.path);
    const sess = path.join(home, 'sessions', key);
    const count = isDir(sess) ? fs.readdirSync(sess, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
    log(`  ${ws.path}`);
    log(`    会话 ${count} 个，目录 ${key}`);
  }
  for (const p of profileDirs(home)) {
    const pkgFile = path.join(p.dir, 'package.json');
    const deps = exists(pkgFile) ? Object.keys(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).dependencies || {}) : [];
    log(`\nprofile ${p.name}：${deps.length} 个插件`);
    for (const d of linkDeps(p.dir)) log(`  link: ${d.name} -> ${d.target}`);
  }
}

/* -------------------------------------------------------------------- help */

const HELP_ZH = `dsh-migrate ${VERSION} — 在两台电脑之间接力使用 DeepSeek Harness

  无参数（推荐，U 盘/共享盘模式）
    把 dsh-migrate.cmd 和 dsh-migrate.mjs 放在 U 盘根目录：
      任意一台机器双击 -> 双向同步（本地新的推上去，包里的新东西拉下来）
      第一次双击会把当前机器完整推一份上去当底子。
    两台机器轮流各双击一次，内容就接上了，谁都不用重新装、不用重新登录。

  命令行
  node dsh-migrate.mjs sync    --with <中转目录> [--home <DSH_HOME>] [--with-plugin-data [目录名,...]] [--no-install] [--no-delete] [--no-backup] [--dry-run]
  node dsh-migrate.mjs pack    --out <目录>   [--home <DSH_HOME>] [--with-credentials] [--with-git] [--with-plugin-data [目录名,...]] [--force]
  node dsh-migrate.mjs restore --in  <目录>   [--home <DSH_HOME>] [--workspace-root <目录>] [--no-install] [--force] [--dry-run]
  node dsh-migrate.mjs undo                   [--home <DSH_HOME>] [--list] [--at <时间戳>] [--dry-run]
  node dsh-migrate.mjs status                 [--home <DSH_HOME>]
  node dsh-migrate.mjs --version | --help

  选项
  --lang zh|en        输出语言（默认跟随系统区域；也可用 DSH_MIGRATE_LANG 指定）
  --no-delete         sync 只合并、不传播删除（默认会把「本机删掉的文件」同步删掉对面那份）
  --no-backup         sync 不做写前备份（默认会把即将被改动的本机文件先存一份）
  --skip-workspace <路径|目录名>
                      不同步这个工作区，可重复给多次；用来排除游戏目录、素材库这类大而无用的目录

说明：
  * 运行前请**完全退出** DeepSeek Harness（关窗口不算，从托盘退出）。
    工具会检测应用是否还占用着数据目录，没退出就拒绝执行；确实要跑加 --force。
  * sync 是并集合并：两边各自新增的会话、工作区文件、插件都会保留；
    同一份文件/会话两边都改过时，按「后写的赢」收敛，另一份另存 .conflict-<时间戳> 留档，只留在本机、不再来回同步。
  * pack/restore 是单向快照：换新机器、或想回到某个确定状态时用。
  * 删除也会传播：在某台机器上删掉的文件，下一次同步时另一台也会删掉它（中转站里那份一起清掉），
    否则对面一同步又会被推回来、删了等于没删。只有「本机这份比删除时间还新」时才留下（删完又改过）。
    DSH 自己会重建的路径（workspace.json、profile 的 package.json / cordis*.yml / 锁文件）不参与删除传播；
    不想要这个行为就加 --no-delete。
  * 每次 sync 之前，即将被覆盖或删除的本机文件会先存一份到 ~\\.dsh\\.dsh-migrate-backup\\<时间戳>\\（通常只有几 MB，
    保留最近 5 次）。发现数据不对就运行 undo 回滚最近一次，或 undo --list 挑一次回滚。
    同步没改动任何文件时不会留下备份目录；不需要这个兜底就加 --no-backup。
  * 同步范围是「发现式」的：DSH home 下的会话、存储、插件清单，加上工作区目录里的全部文件，
    以及 DSH home 里其它顶层目录（插件自己建的数据目录，装了什么插件就带什么，不需要预先知道）。
    始终跳过 node_modules、dsh-runtimes、cache、logs；.credentials.yaml 不搬（每台机器各自登录一次）。
  * 在别的文件夹里开过的会话（不在工作区索引里的项目目录）也会一并搬过去，不会丢。
  * 插件数据目录在用户目录下（~/.openviking、~/.hindsight）：默认不搬，需要时加 --with-plugin-data；
    你的插件把数据放在别处，就用 --with-plugin-data 目录名（相对 ~）或 --with-plugin-data D:\\某个目录 显式指定。
  * 两台机器用户名不同也没关系：同步时按本机用户目录自动换算工作区路径，
    会话头 cwd、workspace.json、link: 依赖都会跟着改。
`;

const HELP_EN = `dsh-migrate ${VERSION} — move DeepSeek Harness between two computers

  No arguments (recommended, USB stick / shared folder)
    Put dsh-migrate.cmd and dsh-migrate.mjs at the root of the stick:
      double-click on either machine -> two-way sync (local news go up, relay news come down)
      the first double-click seeds the relay with a full copy of that machine.
    Alternate one double-click per machine and the two stay in step — no reinstall, no re-login.

  Command line
  node dsh-migrate.mjs sync    --with <relay-dir> [--home <DSH_HOME>] [--with-plugin-data [dir,...]] [--no-install] [--no-delete] [--no-backup] [--dry-run]
  node dsh-migrate.mjs pack    --out <dir>        [--home <DSH_HOME>] [--with-credentials] [--with-git] [--with-plugin-data [dir,...]] [--force]
  node dsh-migrate.mjs restore --in <dir>         [--home <DSH_HOME>] [--workspace-root <dir>] [--no-install] [--force] [--dry-run]
  node dsh-migrate.mjs undo                       [--home <DSH_HOME>] [--list] [--at <stamp>] [--dry-run]
  node dsh-migrate.mjs status                     [--home <DSH_HOME>]
  node dsh-migrate.mjs --version | --help

  Options
  --lang zh|en        Output language (defaults to the system locale; DSH_MIGRATE_LANG also works)
  --no-delete         sync merges only; do not propagate deletions to the other machine
  --no-backup         sync without the pre-write backup (on by default)
  --skip-workspace <path|name>
                      leave this workspace out of sync; repeatable (game folders, asset libraries)

Notes:
  * Quit DeepSeek Harness **completely** before running (closing the window is not enough; exit from
    the tray icon). The tool detects a locked data directory and refuses; add --force to override.
  * sync is a union merge: sessions, workspace files and plugins added on either side are kept.
    When the same file or session changed on both machines, the later write wins and the other copy is
    saved as .conflict-<timestamp> — it stays on that machine and is not synced again.
  * pack/restore are one-way snapshots: for a brand-new machine, or to return to a known state.
  * Deletions propagate: a file you delete on one machine is deleted on the other at its next sync
    (the relay copy goes too) — otherwise the other machine would just push it back.
    A copy that is *newer* than the deletion survives (you edited it after deleting); DSH-owned paths
    (workspace.json, profile package.json / cordis*.yml / lock files) are never deleted this way.
    Pass --no-delete to disable the whole feature.
  * Before every sync, each local file that is about to be overwritten or deleted is copied to
    ~\\.dsh\\.dsh-migrate-backup\\<stamp>\\ (usually a few MB; the last 5 runs are kept). If the result
    looks wrong, run undo to roll the last run back, or undo --list to pick an older one.
    A sync that changed nothing leaves no backup directory; pass --no-backup to turn this off.
  * The sync scope is discovered, not hard-coded: every session, storage file and plugin manifest under
    the DSH home, every file in the workspace, plus any other top-level directory in the DSH home
    (a plugin's own data directory travels with the plugin, without this tool knowing about it).
    node_modules, dsh-runtimes, cache and logs are always skipped; .credentials.yaml never moves
    (sign in once per machine).
  * Sessions opened in other folders (project directories outside the workspace index) travel too.
  * Plugin data directories live in your user profile (~/.openviking, ~/.hindsight): not synced by
    default — add --with-plugin-data. If your plugin keeps data elsewhere, name it:
    --with-plugin-data somedir (relative to ~) or --with-plugin-data D:\\some\\dir.
  * Different user names on the two machines are fine: workspace paths are re-rooted to the local
    profile and session header cwd, workspace.json and link: dependencies are rewritten to match.
`;

function helpText() {
  return LANG === 'en' ? HELP_EN : HELP_ZH;
}

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
  // 可以给多次的参数（收集成数组，而不是后来者覆盖前面）
  const MULTI = new Set(['skipWorkspace']);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      if (MULTI.has(key)) {
        const prev = out[key];
        out[key] = prev === undefined ? [next] : [].concat(prev, next);
      } else {
        out[key] = next;
      }
      i++;
    }
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
let cmd = argv._[0];
const selfDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 放在工具旁边的 dsh-migrate.config.json（或 ~/.dsh/.dsh-migrate.config.json）。
 * 键名与命令行参数同名（驼峰）：{ "skipWorkspace": ["D:\\大目录"], "withPluginData": [".openviking"] }。
 * 命令行显式给的参数优先；配置里写中文路径不受 .cmd 代码页限制。
 */
function applyLocalConfig() {
  const files = [path.join(selfDir, 'dsh-migrate.config.json')];
  try {
    files.push(path.join(defaultHome(), '.dsh-migrate.config.json'));
  } catch {
    // home 解析失败就算了，旁边的配置仍然有效
  }
  for (const f of files) {
    if (!exists(f)) continue;
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      warn(`配置文件读不了，已忽略：${f}（${e.message}）`);
      continue;
    }
    if (!cfg || typeof cfg !== 'object') continue;
    for (const [k, v] of Object.entries(cfg)) {
      if (k.startsWith('_') || k === 'lang') continue;
      if (k === 'skipWorkspace' || k === 'skipWorkspaces') {
        const add = [].concat(v);
        argv.skipWorkspace = argv.skipWorkspace ? [].concat(argv.skipWorkspace, add) : add;
        continue;
      }
      if (argv[k] === undefined) argv[k] = v;
    }
    return f;
  }
  return null;
}

const cfgFile = applyLocalConfig();

/*
 * 无参数 = U 盘模式，自适配方向：
 *   所在目录里已经有中转站（manifest.json + home\）→ 增量同步（两边取并集）
 *   否则                                          → 初始化：把本机完整推一份上去
 * 把 dsh-migrate.cmd / dsh-migrate.mjs 放在 U 盘根目录，两台机器轮流各双击一次即可。
 */
if (argv.version || argv.V) {
  log(`dsh-migrate ${VERSION}`);
  process.exit(0);
}

if (!cmd && (argv.help || argv.h)) {
  cmd = 'help';
} else if (!cmd) {
  const station = argv.with || argv.in || selfDir;
  const ready = exists(path.join(station, 'manifest.json')) && isDir(path.join(station, 'home'));
  step(ready ? '检测到中转站，开始双向同步' : '首次运行，初始化中转站（把本机完整推一份上去）');
  cmd = 'sync';
  // 显式给了 --with 就尊重它：另一台机器上 U 盘盘符可能不一样，
  // 也可能想把中转站放在共享盘而不是工具所在目录。
  if (!argv.with && !argv.in) argv.with = selfDir;
  argv.auto = true;
}

if (cmd === 'pack') cmdPack(argv);
else if (cmd === 'restore') cmdRestore(argv);
else if (cmd === 'sync') cmdSync(argv);
else if (cmd === 'undo') cmdUndo(argv);
else if (cmd === 'status') cmdStatus(argv);
else {
  log(helpText());
  process.exit(cmd === 'help' ? 0 : 1);
}
