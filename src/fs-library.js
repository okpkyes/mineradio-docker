'use strict';

/**
 * 本地音乐库核心（src/fs-library.js）
 * ------------------------------------------------------------------
 * 纯 Node 实现的 NAS 音乐库能力，从现运行版本移植而来，去除了对
 * src/config.js 的依赖，改为直接读取环境变量：
 *   - MUSIC_ROOT            默认 /music
 *   - MAX_SCAN_FILES        单次扫描最大文件数，默认 10000
 *   - MINERADIO_LOCAL_FILE_TOKEN  本地文件访问令牌（空=不校验，内网友好）
 *
 * 所有对文件系统的访问都必须经过 resolveMusicPath 校验，这是「路径
 * 穿越防护」的唯一入口，禁止在别处自行拼接路径。
 */

const fs = require('fs');
const path = require('path');

// ---------- 运行时配置（来自环境变量） ----------
function musicRoot() {
  return path.resolve(process.env.MUSIC_ROOT || '/music');
}
function maxScanFiles() {
  return parseInt(process.env.MAX_SCAN_FILES, 10) || 10000;
}
function localFileToken() {
  return process.env.MINERADIO_LOCAL_FILE_TOKEN || '';
}

// ---------- MIME 类型映射（静态资源服务用） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

// 本地文件代理专用 MIME（含歌词 / 封面文本类型）
const LOCAL_FILE_MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.lrc': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// 支持的音乐文件扩展名
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a']);
// 歌词文件扩展名
const LYRIC_EXTENSIONS = new Set(['.lrc', '.txt']);
// 封面图片扩展名
const COVER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/**
 * 解析并验证相对于 MUSIC_ROOT 的路径，防止路径穿越攻击
 * @param {string} dir 相对或绝对路径
 * @returns {{abs: string, rel: string}} 解析后的绝对路径和相对路径
 * @throws {Error} 路径不合法时抛出异常（code: PATH_TRAVERSAL_DETECTED / PATH_OUTSIDE_MUSIC_ROOT / FILE_NOT_FOUND）
 */
function resolveMusicPath(dir) {
  const cleanDir = String(dir || '').trim();
  const root = musicRoot();

  if (!cleanDir || cleanDir === '/' || cleanDir === '.') {
    return { abs: root, rel: '' };
  }

  // 先解码（挡 ..%2F / %2e%2e 等编码穿越；解码失败则保留原串）。
  let decoded;
  try {
    decoded = decodeURIComponent(cleanDir);
  } catch (e) {
    decoded = cleanDir;
  }

  // 空字节（%00）直接拦截
  if (decoded.includes('\0')) {
    const err = new Error('PATH_TRAVERSAL_DETECTED');
    err.code = 'PATH_TRAVERSAL_DETECTED';
    throw err;
  }

  const normalized = path.normalize(decoded).replace(/\\/g, '/');
  // 第一道防线（段级精确判定）：仅当某一段严格等于 '..' 时才算穿越。
  // 文件名 a..b.mp3 的段为 ['a..b.mp3']、目录名 ..favorites 的段为 ['..favorites']，
  // 均不命中；而 ../etc/passwd 的段含 '..'，正确拦截。
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      const err = new Error('PATH_TRAVERSAL_DETECTED');
      err.code = 'PATH_TRAVERSAL_DETECTED';
      throw err;
    }
  }

  let rel = normalized.replace(/^\/+/, '');
  const absAttempt = path.resolve(root, rel);

  // 第二道防线：拼接结果必须仍在 root 之内
  if (!absAttempt.startsWith(root + path.sep) && absAttempt !== root) {
    const err = new Error('PATH_OUTSIDE_MUSIC_ROOT');
    err.code = 'PATH_OUTSIDE_MUSIC_ROOT';
    throw err;
  }

  // 第三道防线：符号链接收口
  // 解析真实路径，确保不跟随符号链接跳到 MUSIC_ROOT 之外
  try {
    const realRoot = fs.realpathSync(root);
    const realAbs = fs.realpathSync(absAttempt);
    if (!realAbs.startsWith(realRoot + path.sep) && realAbs !== realRoot) {
      const err = new Error('PATH_OUTSIDE_MUSIC_ROOT');
      err.code = 'PATH_OUTSIDE_MUSIC_ROOT';
      throw err;
    }
    return { abs: realAbs, rel: rel };
  } catch (e) {
    if (e.code === 'PATH_OUTSIDE_MUSIC_ROOT') throw e;
    // realpathSync 失败（文件不存在等）：回退到原始解析路径（仍受前两道防线的约束）
    return { abs: absAttempt, rel: rel };
  }
}

/**
 * 将 MUSIC_ROOT 下的绝对路径转换为相对路径
 * @param {string} absPath 绝对路径
 * @returns {string} 相对于 MUSIC_ROOT 的路径
 */
function absoluteToRelPath(absPath) {
  const root = musicRoot();
  let rel = path.relative(root, absPath);
  return rel.replace(/\\/g, '/');
}

/**
 * 校验请求是否携带有效 token。
 * 若未设置 localFileToken，则放行（向后兼容 LAN 内网使用）。
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @returns {boolean} true 表示通过
 */
function checkToken(req, url) {
  if (!localFileToken()) return true; // 未设置 token，放行
  const token =
    (req && req.headers && (req.headers['x-mineradio-token'] || req.headers['x-auth-token'])) ||
    (url && url.searchParams ? url.searchParams.get('token') : '') ||
    '';
  return token === localFileToken();
}

/**
 * 格式化文件大小为可读字符串
 * @param {number} bytes 文件大小（字节）
 * @returns {string} 可读的文件大小
 */
function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * 获取本地文件的 Content-Type
 * @param {string} filePath 文件路径
 * @returns {string} MIME 类型
 */
function localContentTypeForPath(filePath) {
  return LOCAL_FILE_MIME[path.extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream';
}

/**
 * 浏览目录内容，返回文件和子目录列表
 * @param {string} dir 要浏览的目录（相对 MUSIC_ROOT）
 * @returns {Promise<object>} {current, musicRoot, dirs:[{name,path}], files:[{name,path,ext,size,sizeLabel,isAudio}]}
 */
async function browseDirectory(dir) {
  const resolved = resolveMusicPath(dir);
  const absDir = resolved.abs;

  try {
    await fs.promises.access(absDir);
  } catch (e) {
    const err = new Error('DIR_NOT_FOUND');
    err.code = 'DIR_NOT_FOUND';
    throw err;
  }
  const stat = await fs.promises.stat(absDir);
  if (!stat.isDirectory()) {
    const err = new Error('NOT_A_DIRECTORY');
    err.code = 'NOT_A_DIRECTORY';
    throw err;
  }

  const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  const dirs = [];
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const entryAbs = path.join(absDir, entry.name);
    const entryRel = absoluteToRelPath(entryAbs);

    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: entryRel });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const fstat = await fs.promises.stat(entryAbs);
      files.push({
        name: entry.name,
        path: entryRel,
        ext: ext,
        size: fstat.size,
        sizeLabel: formatFileSize(fstat.size),
        isAudio: AUDIO_EXTENSIONS.has(ext),
      });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));

  return {
    current: resolved.rel,
    musicRoot: musicRoot(),
    dirs,
    files,
  };
}

/**
 * 递归扫描目录，返回所有音乐文件
 * @param {string} dir 要扫描的目录（相对 MUSIC_ROOT）
 * @returns {Promise<object>} {dir, files:[{path,name,ext,size,sizeLabel,dir}], total, truncated, maxScanFiles, musicRoot}
 */
async function scanDirectory(dir) {
  const resolved = resolveMusicPath(dir);
  const absDir = resolved.abs;

  try {
    await fs.promises.access(absDir);
  } catch (e) {
    const err = new Error('DIR_NOT_FOUND');
    err.code = 'DIR_NOT_FOUND';
    throw err;
  }
  const stat = await fs.promises.stat(absDir);
  if (!stat.isDirectory()) {
    const err = new Error('NOT_A_DIRECTORY');
    err.code = 'NOT_A_DIRECTORY';
    throw err;
  }

  const results = [];
  let truncated = false;
  const limit = maxScanFiles();

  async function walk(currentAbs, currentRel) {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.promises.readdir(currentAbs, { withFileTypes: true });
    } catch (e) {
      return;
    }

    const subDirs = [];
    const audioFiles = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryAbs = path.join(currentAbs, entry.name);
      const entryRel = currentRel ? currentRel + '/' + entry.name : entry.name;

      if (entry.isDirectory()) {
        subDirs.push({ abs: entryAbs, rel: entryRel });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          if (results.length >= limit) {
            truncated = true;
            return;
          }
          let fstat;
          try {
            fstat = await fs.promises.stat(entryAbs);
          } catch (e) {
            fstat = { size: 0 };
          }
          audioFiles.push({
            path: entryRel,
            name: entry.name,
            ext: ext,
            size: fstat.size,
            sizeLabel: formatFileSize(fstat.size),
            dir: currentRel,
          });
        }
      }
    }

    audioFiles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    for (const f of audioFiles) {
      results.push(f);
      if (results.length >= limit) {
        truncated = true;
        break;
      }
    }

    for (const d of subDirs) {
      if (truncated) break;
      await walk(d.abs, d.rel);
    }
  }

  await walk(absDir, resolved.rel);

  return {
    dir: resolved.rel,
    musicRoot: musicRoot(),
    files: results,
    total: results.length,
    truncated,
    maxScanFiles: limit,
  };
}

/**
 * 获取单个文件的元数据（含同目录歌词 / 封面探测）
 * @param {string} filePath 文件路径（相对 MUSIC_ROOT）
 * @returns {Promise<object>} 文件元数据
 */
async function getFileMeta(filePath) {
  const resolved = resolveMusicPath(filePath);
  const absPath = resolved.abs;

  let stat;
  try {
    stat = await fs.promises.stat(absPath);
  } catch (e) {
    const err = new Error('FILE_NOT_FOUND');
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }
  if (!stat.isFile()) {
    const err = new Error('NOT_A_FILE');
    err.code = 'NOT_A_FILE';
    throw err;
  }

  const ext = path.extname(absPath).toLowerCase();
  const baseName = path.basename(absPath, ext);
  const dirName = path.dirname(absPath);

  let hasLyric = false;
  let lyricPath = null;
  for (const lyricExt of LYRIC_EXTENSIONS) {
    const candidate = path.join(dirName, baseName + lyricExt);
    try {
      await fs.promises.access(candidate);
      hasLyric = true;
      lyricPath = absoluteToRelPath(candidate);
      break;
    } catch (e) {
      /* not found, continue */
    }
  }

  let hasCover = false;
  let coverPath = null;
  for (const coverExt of COVER_EXTENSIONS) {
    const candidate = path.join(dirName, baseName + coverExt);
    try {
      await fs.promises.access(candidate);
      hasCover = true;
      coverPath = absoluteToRelPath(candidate);
      break;
    } catch (e) {
      /* not found, continue */
    }
  }

  // 退一步：按常见封面文件名探测（cover / folder / album / front）
  if (!hasCover) {
    const coverNames = ['cover', 'folder', 'album', 'front'];
    for (const name of coverNames) {
      for (const coverExt of COVER_EXTENSIONS) {
        const candidate = path.join(dirName, name + coverExt);
        try {
          await fs.promises.access(candidate);
          hasCover = true;
          coverPath = absoluteToRelPath(candidate);
          break;
        } catch (e) {
          /* not found, continue */
        }
      }
      if (hasCover) break;
    }
  }

  return {
    path: resolved.rel,
    name: path.basename(absPath),
    ext: ext,
    size: stat.size,
    sizeLabel: formatFileSize(stat.size),
    isAudio: AUDIO_EXTENSIONS.has(ext),
    hasLyric: hasLyric,
    lyricPath: lyricPath,
    hasCover: hasCover,
    coverPath: coverPath,
    mtime: stat.mtimeMs,
  };
}

module.exports = {
  MIME,
  LOCAL_FILE_MIME,
  AUDIO_EXTENSIONS,
  LYRIC_EXTENSIONS,
  COVER_EXTENSIONS,
  musicRoot,
  resolveMusicPath,
  absoluteToRelPath,
  checkToken,
  formatFileSize,
  localContentTypeForPath,
  browseDirectory,
  scanDirectory,
  getFileMeta,
};
