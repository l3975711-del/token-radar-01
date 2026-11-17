// Token Radar, round 2: the entrypoint.
//
// The sealed snapshot comes in, the ranked board, the dashboard data, the
// dashboard files, the screenshots and the dossier go out. The scoring itself
// lives in lib/model.ts; this file only moves data between the snapshot, the
// model and the output directory, in the order the competition's gate expects:
// board first, dashboard data next, the copied files, and the dossier last.
//
// Only two knobs exist: --input (a snapshot file, or a directory holding
// snapshot.json) and --output (else MAKEFUN_OUTPUT_DIR, else /output).
// Everything else is fixed: the file names, the caps, the dossier shape.
//
// Exit codes: 2 when the snapshot cannot be found, 1 when the board or the
// screenshots are refused, 0 when the run completes and the dossier is written.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardIssue,
  buildRadar,
  dataScript,
  parseSnapshot,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// The scorer's caps, as the gate states them. The dossier's text is capped
// at 64 KiB; at most four screenshots of 512 KiB each; the dashboard at most
// 400 files and 4 MiB in all.
const TEXT_CAP_BYTES = 65_536;
const SHOT_CAP_COUNT = 4;
const SHOT_CAP_BYTES = 524_288;
const DASH_CAP_FILES = 400;
const DASH_CAP_BYTES = 4_194_304;

// A screenshot name the dossier accepts, and how many the gate requires.
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const SHOTS_REQUIRED = 3;

// The directory this file lives in: the repository root, holding dashboard/
// and screenshots/ beside it.
const ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * The value of a `--name value` or `--name=value` flag, or `fallback` when the
 * flag is absent. Later flags win over earlier ones.
 */
function flagValue(flag: string, fallback: string): string {
  const argv = process.argv.slice(2);
  let found = fallback;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === flag) {
      if (i + 1 < argv.length) found = argv[i + 1]!;
    } else if (token.startsWith(flag + '=')) {
      found = token.slice(flag.length + 1);
    }
  }
  return found;
}

/**
 * Copy the plain files of one directory into another, skipping dotfiles and
 * anything that is not a regular file. Returns the names copied, in the order
 * the directory lists them.
 */
function copyPlainFiles(fromDir: string, toDir: string): string[] {
  mkdirSync(toDir, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(fromDir)) {
    if (name.startsWith('.')) continue;
    const source = join(fromDir, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(toDir, name));
    copied.push(name);
  }
  return copied;
}

/** Refuse with a message on stderr and the given exit code. */
function refuse(message: string, code: number): never {
  console.error(`token radar: ${message}`);
  process.exit(code);
}

const inputArg = flagValue('--input', '/input');
const snapshotPath = inputArg.endsWith('.json')
  ? inputArg
  : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  refuse(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory>`, 2);
}

const outputDir = flagValue(
  '--output',
  process.env.MAKEFUN_OUTPUT_DIR ?? '/output',
);

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);

const issue = boardIssue(board, snapshot);
if (issue !== null) refuse(`board refused: ${issue}`, 1);

mkdirSync(outputDir, { recursive: true });
writeFileSync(
  join(outputDir, 'board.json'),
  JSON.stringify({ rows: board }) + '\n',
  'utf8',
);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar), 'utf8');

const dashboardFiles = copyPlainFiles(
  join(ROOT, 'dashboard'),
  join(outputDir, 'dashboard'),
);
const screenshotFiles = copyPlainFiles(
  join(ROOT, 'screenshots'),
  join(outputDir, 'screenshots'),
);

if (screenshotFiles.length < SHOTS_REQUIRED) {
  refuse(
    `need at least ${SHOTS_REQUIRED} screenshots, found ${screenshotFiles.length}`,
    1,
  );
}
for (const name of screenshotFiles) {
  if (!SHOT_NAME.test(name)) refuse(`screenshot name refused: ${name}`, 1);
}

// The dossier closes the run: it is built from the files just written, so it
// must be the last write, after the board, the data and the copied files.
// buildDossier returns the dossier text; this file writes it out.
writeFileSync(
  join(outputDir, 'dossier.json'),
  buildDossier(outputDir, {
    text_max_bytes: TEXT_CAP_BYTES,
    screenshots: { max: SHOT_CAP_COUNT, max_bytes: SHOT_CAP_BYTES },
    dashboard: { max_files: DASH_CAP_FILES, max_bytes: DASH_CAP_BYTES },
  }),
  'utf8',
);

console.log(
  `token radar: scored ${board.length} rows from ${snapshot.protocols.length} protocols ` +
    `(${snapshot.watchlist.length} watchlist, ${radar.early_size} early) ` +
    `and set aside ${radar.live_size} live-token protocols`,
);
console.log(
  `token radar: wrote board.json, data.js, dossier.json, ` +
    `${dashboardFiles.length} dashboard files and ` +
    `${screenshotFiles.length} screenshots to ${outputDir}`,
);
