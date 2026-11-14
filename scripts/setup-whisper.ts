/**
 * Installs whisper.cpp (speech-to-text that runs on this PC) for Jarvis.
 *
 *   npm run setup-whisper
 *   npm run setup-whisper -- --model ggml-small.en-q5_1.bin
 *
 * Downloads, from the official sources only, and checks each file's SHA-256:
 *   - the prebuilt Windows CPU build from github.com/ggml-org/whisper.cpp releases
 *   - a speech model from huggingface.co/ggerganov/whisper.cpp
 * Everything goes under the Jarvis data folder (%APPDATA%\jarvis), not the repo.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '@jarvis/core/config';
import { VAD_MODEL } from '@jarvis/core/stt';
import { scriptArgs } from './args.ts';

/** Pinned build: whisper.cpp b5454 (v1.9.5), published 2026-10-06. */
const BUILD = {
  tag: 'b5454',
  file: 'whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
};

/** Pinned model checksums from Hugging Face (LFS object ids are SHA-256). */
const MODELS: Record<string, string> = {
  'ggml-base.en-q8_0.bin': 'a4d4a0768075e13cfd7e19df3ae2dbc4a68d37d36a7dad45e8410c9a34f8c87e',
  'ggml-base.en.bin': 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  'ggml-small.en-q5_1.bin': 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30',
  'ggml-small.en.bin': 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
  'ggml-medium.en-q5_0.bin': '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0',
  'ggml-large-v3-turbo-q5_0.bin':
    '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  'ggml-tiny.en-q8_0.bin': '5bc2b3860aa151a4c6e7bb095e1fcce7cf12c7b020ca08dcec0c6d018bb7dd94',
};

const args = scriptArgs({ model: { type: 'string' } });
const config = loadConfig().jarvis;
const model = typeof args.model === 'string' ? args.model : config.stt.model;
const modelSha = MODELS[model];
if (!modelSha) {
  console.error(`Unknown model ${model}. Known: ${Object.keys(MODELS).join(', ')}`);
  process.exit(2);
}

const root = path.join(config.dataDir, 'whisper');
const binDir = path.join(root, BUILD.tag);
const modelDir = path.join(config.dataDir, 'models');
mkdirSync(root, { recursive: true });
mkdirSync(modelDir, { recursive: true });

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function download(url: string, dest: string, expected: string, label: string): Promise<void> {
  if (existsSync(dest) && sha256(dest) === expected) {
    console.log(`${label}: already downloaded and verified.`);
    return;
  }
  const tmp = `${dest}.part`;
  console.log(`${label}: downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${label}: download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => {
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(`  ${pct}% (${(done / 1e6).toFixed(0)} MB)\n`);
    }
  });
  await pipeline(body, createWriteStream(tmp));
  const actual = sha256(tmp);
  if (actual !== expected) {
    rmSync(tmp, { force: true });
    throw new Error(
      `${label}: checksum mismatch (expected ${expected}, got ${actual}). Deleted it.`,
    );
  }
  renameSync(tmp, dest);
  console.log(`${label}: verified (SHA-256 ${expected.slice(0, 12)}…).`);
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return undefined;
}

/**
 * Only what Jarvis runs is kept (kept small on purpose): the server, the CLI used
 * for the install check, and the libraries they load. The CPU backends are all
 * kept because whisper.cpp picks the best one for this processor at runtime.
 */
const KEEP =
  /^(whisper-server\.exe|whisper-cli\.exe|whisper\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-[\w-]+\.dll)$/i;

function prune(dir: string): number {
  let freed = 0;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      freed += prune(full);
    } else if (!KEEP.test(entry)) {
      freed += st.size;
      rmSync(full, { force: true });
    }
  }
  return freed;
}

// 1. Program
const zip = path.join(root, `${BUILD.tag}-${BUILD.file}`);
if (!existsSync(binDir) || !findFile(binDir, 'whisper-server.exe')) {
  await download(
    `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD.tag}/${BUILD.file}`,
    zip,
    BUILD.sha256,
    'whisper.cpp',
  );
  rmSync(binDir, { recursive: true, force: true });
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:DEST -Force',
    ],
    { env: { ...process.env, ZIP: zip, DEST: binDir }, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`Could not unzip: ${r.stderr}`);
} else {
  console.log('whisper.cpp: already installed.');
}
// Keep the disk footprint small: drop extra tools, the download, and old builds.
const freed = prune(binDir);
rmSync(zip, { force: true });
for (const entry of readdirSync(root)) {
  const full = path.join(root, entry);
  if (entry !== BUILD.tag && statSync(full).isDirectory())
    rmSync(full, { recursive: true, force: true });
}
if (freed > 0)
  console.log(`whisper.cpp: removed ${(freed / 1e6).toFixed(1)} MB of tools Jarvis does not use.`);
const server = findFile(binDir, 'whisper-server.exe');
const cli = findFile(binDir, 'whisper-cli.exe');
if (!server || !cli) throw new Error(`whisper-server.exe or whisper-cli.exe missing in ${binDir}`);

// 2. Model
await download(
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model}`,
  path.join(modelDir, model),
  modelSha,
  `model ${model}`,
);

// 3. Silero VAD (0.9 MB): lets whisper-server skip silence and background noise.
await download(
  `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL.file}`,
  path.join(modelDir, VAD_MODEL.file),
  VAD_MODEL.sha256,
  `VAD model ${VAD_MODEL.file}`,
);

// Tell core where the server is (read by resolveWhisper).
writeFileSync(
  path.join(root, 'install.json'),
  JSON.stringify({ build: BUILD.tag, server, cli }, null, 2),
);

const v = spawnSync(cli, ['--help'], { encoding: 'utf8' });
console.log(
  `\nInstalled.\n  server: ${server}\n  cli:    ${cli}\n  model:  ${path.join(modelDir, model)}`,
);
console.log(
  `  runs:   ${v.status === 0 || /usage/i.test(`${v.stdout}${v.stderr}`) ? 'yes' : 'NO, see output above'}`,
);

// A packaged Windows app (like the Claude desktop app) gets a private copy of
// AppData: files it writes there are invisible to your own terminal. Warn so
// the install is not silently stranded.
const localAppData = process.env.LOCALAPPDATA;
const packages = localAppData ? path.join(localAppData, 'Packages') : '';
const stranded =
  packages && existsSync(packages)
    ? readdirSync(packages)
        .map((name) => path.join(packages, name, 'LocalCache', 'Roaming', 'jarvis'))
        .filter((dir) => existsSync(dir))
    : [];
if (stranded.length > 0) {
  console.log(
    `\nWarning: this ran inside a packaged app, so Windows stored the files in its private folder:\n  ${stranded.join('\n  ')}\nRun "npm run setup-whisper" again from your own terminal (it re-uses nothing from there), then delete that folder.`,
  );
}
