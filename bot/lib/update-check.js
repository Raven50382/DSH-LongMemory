// 插件版本检查：只读远端版本清单，不下载、不覆盖安装。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

const RAW_BASE = 'https://raw.githubusercontent.com/Raven50382/DSH-LongMemory/main';
const JSD_BASE = 'https://cdn.jsdelivr.net/gh/Raven50382/DSH-LongMemory@main';
const REPO_URL = process.env.XLIENS_UPDATE_REPO
  || 'https://github.com/Raven50382/DSH-LongMemory';
const CACHE_MS = 6 * 60 * 60 * 1000;
const FAIL_CACHE_MS = 10 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 5000;

const PACKAGE_SOURCES = process.env.XLIENS_UPDATE_PACKAGE
  ? [{ id: 'custom', url: process.env.XLIENS_UPDATE_PACKAGE }]
  : [
    { id: 'github-raw', url: `${RAW_BASE}/bot/package.json` },
    { id: 'jsdelivr', url: `${JSD_BASE}/bot/package.json` },
  ];
const MANIFEST_SOURCES = process.env.XLIENS_UPDATE_MANIFEST
  ? [{ id: 'custom-manifest', url: process.env.XLIENS_UPDATE_MANIFEST }]
  : [
    { id: 'github-raw-manifest', url: `${RAW_BASE}/version.json` },
    { id: 'jsdelivr-manifest', url: `${JSD_BASE}/version.json` },
  ];


let cache = null;
let inflight = null;

function localVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

function versionParts(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const [core, pre] = s.split('-', 2);
  const nums = core.split('.').map((x) => Number(String(x).replace(/[^0-9].*$/, '')) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre: pre || '' };
}

export function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

function isTimeoutError(e) {
  const name = String(e?.name || '');
  const msg = String(e?.message || e);
  return name === 'TimeoutError' || name === 'AbortError'
    || /aborted|timeout|timed out|超时/i.test(msg);
}

async function fetchJson(url, timeoutMs, source) {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'xliens-update-check' },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    const err = new Error(isTimeoutError(e)
      ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）`
      : String(e?.message || e));
    err.source = source;
    err.timeout = isTimeoutError(e);
    throw err;
  }
}

async function firstSource(sources, timeoutMs) {
  // 顺序请求，不能 Promise.any：CDN 可能缓存旧版本并抢先返回。
  const errors = [];
  for (const source of sources) {
    try {
      const json = await fetchJson(source.url, timeoutMs, source.id);
      return { ...source, json };
    } catch (e) {
      errors.push(e);
    }
  }
  const err = new Error('所有版本源都失败');
  err.errors = errors;
  throw err;
}

function failureMessage(errors, timeoutMs) {
  const list = Array.isArray(errors) ? errors : [errors];
  const timeoutCount = list.filter((e) => e?.timeout).length;
  if (timeoutCount === list.length) {
    return `请求超时（${Math.round(timeoutMs / 1000)} 秒）`;
  }
  const detail = list.map((e) => `${e?.source || '版本源'}：${e?.message || e}`).join('；');
  if (timeoutCount > 0) {
    return `部分版本源超时（${Math.round(timeoutMs / 1000)} 秒）：${detail}`;
  }
  return `所有版本源都失败：${detail}`;
}

async function remoteVersion(timeoutMs) {
  // version.json 是可选清单；显式配置时才优先读取，避免每次多等一个 404。
  if (process.env.XLIENS_UPDATE_MANIFEST) {
    try {
      const hit = await firstSource(MANIFEST_SOURCES, timeoutMs);
      const manifest = hit.json;
      if (manifest && String(manifest.version || '').trim()) {
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        const file = files.find((x) => x && x.url) || null;
        return {
          version: String(manifest.version).trim(),
          source: 'manifest',
          notes: String(manifest.notes || manifest.changelog || ''),
          downloadUrl: file?.url || manifest.downloadUrl || '',
          releaseUrl: manifest.releaseUrl || `${REPO_URL}/releases`,
        };
      }
    } catch { /* 清单不可用时继续读 package.json */ }
  }
  const hit = await firstSource(PACKAGE_SOURCES, timeoutMs);
  const pkg = hit.json;
  const version = String(pkg?.version || '').trim();
  if (!version) throw new Error(`${hit.id}：远端没有版本号`);
  return {
    version,
    source: 'package',
    notes: '',
    downloadUrl: '',
    releaseUrl: `${REPO_URL}/releases`,
  };
}

export function getUpdateState() {
  return cache;
}

export async function checkUpdate({ force = false, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  if (process.env.XLIENS_UPDATE_DISABLE === '1') {
    return { ok: false, status: 'disabled', current: localVersion(), latest: '', hasUpdate: false,
      checkedAt: new Date().toISOString(), error: '更新检查已禁用' };
  }
  if (!force && cache && Date.now() - cache.ts < (cache.ok ? CACHE_MS : FAIL_CACHE_MS)) {
    return cache.value;
  }
  if (!force && inflight) return inflight;
  const run = (async () => {
    const current = localVersion();
    const checkedAt = new Date().toISOString();
    try {
      const remote = await remoteVersion(timeoutMs);
      const cmp = compareVersions(remote.version, current);
      const latest = cmp < 0 ? current : remote.version;
      const value = {
        ok: true, status: cmp > 0 ? 'update' : 'latest',
        current, latest, hasUpdate: cmp > 0,
        checkedAt, source: remote.source, notes: remote.notes,
        downloadUrl: remote.downloadUrl, releaseUrl: remote.releaseUrl,
        repoUrl: REPO_URL,
      };
      cache = { ts: Date.now(), ok: true, value };
      return value;
    } catch (e) {
      const errors = Array.isArray(e?.errors) ? e.errors : [e];
      const value = {
        ok: false, status: 'error', current, latest: '', hasUpdate: false,
        checkedAt, source: '', notes: '', downloadUrl: '',
        releaseUrl: `${REPO_URL}/releases`, repoUrl: REPO_URL,
        error: errors.length > 1
          ? failureMessage(errors, timeoutMs)
          : (e?.timeout ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : String(e?.message || e)),
        sourceErrors: errors.map((x) => ({
          source: x?.source || '', error: String(x?.message || x),
        })),
      };
      cache = { ts: Date.now(), ok: false, value };
      return value;
    } finally {
      inflight = null;
    }
  })();
  inflight = run;
  return run;
}

export function startUpdateCheck() {
  // 启动时只触发一次，不阻塞插件 apply；失败静默，详情页可手动重试。
  if (process.env.XLIENS_UPDATE_DISABLE === '1') return;
  checkUpdate().catch(() => {});
}
