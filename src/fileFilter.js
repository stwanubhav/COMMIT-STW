const fs = require('fs');
const path = require('path');
const ignore = require('ignore');

// ── Directories that should NEVER be committed ────────────────────────────────
const BLOCKED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'venv',
  '.venv',
  'env',
  '.env',
  'vendor',
  'bower_components',
  '.gradle',
  'target',           // Maven / Rust
  'Pods',             // iOS CocoaPods
  '.dart_tool',
  '.pub-cache',
  'coverage',
  '.nyc_output',
  'htmlcov',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vercel',
  '.serverless',
  'tmp',
  'temp',
  'logs',
  '.DS_Store',
  'Thumbs.db'
]);

// ── File extensions that should NEVER be committed ────────────────────────────
const BLOCKED_EXTENSIONS = new Set([
  // Compiled / binary
  '.pyc', '.pyo', '.pyd',
  '.class', '.jar', '.war', '.ear',
  '.o', '.obj', '.a', '.lib', '.dll', '.so', '.dylib',
  '.exe', '.bin', '.out',
  '.wasm',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  // Images / media (large binaries — skip unless small)
  '.mp4', '.avi', '.mov', '.mkv', '.wmv',
  '.mp3', '.wav', '.ogg', '.flac',
  // Lock files (auto-generated)
  // Note: package-lock.json IS useful, handled separately below
  // Database / secrets
  '.sqlite', '.db', '.mdb',
  '.pfx', '.pem', '.key', '.p12', '.cer',
  // Editor / IDE
  '.suo', '.user', '.vspscc', '.ncb', '.opensdf',
  // Logs
  '.log'
]);

// ── Specific filenames to always skip ─────────────────────────────────────────
const BLOCKED_FILENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '*.log',
  'npm-debug.log',
  'yarn-error.log',
  'yarn-debug.log'
]);

// ── Max file size to commit (bytes) — skip huge files ─────────────────────────
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Load .gitignore rules from the project root (if it exists).
 */
function loadGitignore(projectRoot) {
  const ig = ignore();
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    ig.add(content);
  }
  return ig;
}

/**
 * Recursively collect all files from a directory,
 * applying all filters to exclude unnecessary files.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {{ files: string[], skipped: string[] }}
 *   files   — relative paths of files to commit
 *   skipped — relative paths of files that were filtered out
 */
function collectFiles(projectRoot) {
  const ig = loadGitignore(projectRoot);
  const files = [];
  const skipped = [];

  function walk(dir, relativeBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }

    for (const entry of entries) {
      const relativePath = relativeBase
        ? `${relativeBase}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        // Check blocked directory names
        if (BLOCKED_DIRS.has(entry.name)) {
          skipped.push(`${relativePath}/ [blocked directory]`);
          continue;
        }
        // Check .gitignore
        if (ig.ignores(relativePath + '/')) {
          skipped.push(`${relativePath}/ [.gitignore]`);
          continue;
        }
        walk(path.join(dir, entry.name), relativePath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const absPath = path.join(dir, entry.name);

        // Blocked filename check
        if (BLOCKED_FILENAMES.has(entry.name)) {
          skipped.push(`${relativePath} [blocked filename]`);
          continue;
        }

        // Blocked extension check
        if (BLOCKED_EXTENSIONS.has(ext)) {
          skipped.push(`${relativePath} [blocked extension: ${ext}]`);
          continue;
        }

        // .gitignore check
        if (ig.ignores(relativePath)) {
          skipped.push(`${relativePath} [.gitignore]`);
          continue;
        }

        // Size check
        try {
          const stat = fs.statSync(absPath);
          if (stat.size > MAX_FILE_SIZE) {
            skipped.push(`${relativePath} [too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB]`);
            continue;
          }
        } catch {
          skipped.push(`${relativePath} [unreadable]`);
          continue;
        }

        files.push(relativePath);
      }
    }
  }

  walk(projectRoot, '');

  // Sort: config/root files first, then by directory depth, then alphabetically
  files.sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  return { files, skipped };
}

/**
 * Determine if a file is binary (non-text).
 * Reads the first 8KB and checks for null bytes.
 */
function isBinaryFile(filePath) {
  try {
    const buffer = Buffer.alloc(8192);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Read a file's content as Buffer (works for both text and binary).
 */
function readFileContent(absolutePath) {
  return fs.readFileSync(absolutePath);
}

module.exports = {
  collectFiles,
  isBinaryFile,
  readFileContent,
  BLOCKED_DIRS,
  BLOCKED_EXTENSIONS,
  MAX_FILE_SIZE
};
