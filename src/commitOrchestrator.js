const path = require('path');
const { GitHubClient } = require('./github');
const { HuggingFaceClient } = require('./huggingface');
const { collectFiles, isBinaryFile, readFileContent } = require('./fileFilter');

// How many files to commit in parallel (GitHub allows bursts but penalises >5 concurrent)
const DEFAULT_CONCURRENCY = 3;
// Delay (ms) between each parallel batch to stay under GitHub secondary rate limits
const BATCH_DELAY = 600;
// Per-file retry attempts on failure
const MAX_RETRIES = 3;
// Delay before each retry (doubles each attempt: 1s, 2s, 4s)
const RETRY_BASE_DELAY = 1000;

let _cancelRequested = false;

/**
 * Classify a file into a known category so we can detect unclassified files.
 * Returns { category, label } — if category is 'unknown' the file is unclassified.
 */
function classifyFile(filePath) {
  const p = filePath.replace(/\\/g, '/').toLowerCase();
  const filename = p.split('/').pop();
  const ext = path.extname(filename);

  if (/\.(test|spec)\.(js|ts|jsx|tsx|py|rb|go|java|cs)$/.test(filename)) return { category: 'test',      label: 'Test file' };
  if (/test[s]?\/|spec[s]?\/|__tests__\//.test(p))                         return { category: 'test',      label: 'Test file' };
  if (/\.(css|scss|sass|less|styl)$/.test(ext))                            return { category: 'style',     label: 'Stylesheet' };
  if (/\.(html|htm|ejs|hbs|pug|njk)$/.test(ext))                          return { category: 'template',  label: 'Template/HTML' };
  if (/\.(md|mdx|rst|txt)$/.test(ext))                                     return { category: 'docs',      label: 'Documentation' };
  if (/\.(json|yaml|yml|toml|ini|cfg|conf|xml)$/.test(ext))               return { category: 'config',    label: 'Configuration' };
  if (/\.(env\.example|env\.sample)/.test(filename) || filename === '.env.example') return { category: 'config', label: 'Env template' };
  if (/dockerfile|docker-compose/.test(filename))                          return { category: 'config',    label: 'Docker config' };
  if (/\.(gitignore|eslintrc|prettierrc|babelrc|editorconfig)/.test(filename)) return { category: 'config', label: 'Dev config' };
  if (/package\.json|package-lock\.json|yarn\.lock|pnpm-lock/.test(filename)) return { category: 'config', label: 'Package manifest' };
  if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(ext))                             return { category: 'source',    label: 'JavaScript/TypeScript' };
  if (/\.(py|pyw)$/.test(ext))                                             return { category: 'source',    label: 'Python' };
  if (/\.(java|kt|kts)$/.test(ext))                                        return { category: 'source',    label: 'Java/Kotlin' };
  if (/\.(cs|vb|fs)$/.test(ext))                                           return { category: 'source',    label: '.NET' };
  if (/\.(c|cpp|cc|h|hpp)$/.test(ext))                                     return { category: 'source',    label: 'C/C++' };
  if (/\.(go)$/.test(ext))                                                  return { category: 'source',    label: 'Go' };
  if (/\.(rs)$/.test(ext))                                                  return { category: 'source',    label: 'Rust' };
  if (/\.(rb|erb)$/.test(ext))                                              return { category: 'source',    label: 'Ruby' };
  if (/\.(php)$/.test(ext))                                                 return { category: 'source',    label: 'PHP' };
  if (/\.(sh|bash|zsh|fish|ps1|bat|cmd)$/.test(ext))                      return { category: 'source',    label: 'Shell script' };
  if (/\.(sql)$/.test(ext))                                                 return { category: 'source',    label: 'SQL' };
  if (/\.(vue|svelte)$/.test(ext))                                          return { category: 'source',    label: 'Component file' };
  if (/\.(dart)$/.test(ext))                                                return { category: 'source',    label: 'Dart' };
  if (/\.(png|jpg|jpeg|gif|svg|ico|webp|bmp)$/.test(ext))                  return { category: 'asset',     label: 'Image asset' };
  if (/\.(woff|woff2|ttf|eot|otf)$/.test(ext))                            return { category: 'asset',     label: 'Font asset' };
  if (/\.(pdf|docx?|xlsx?|pptx?)$/.test(ext))                             return { category: 'asset',     label: 'Document asset' };

  return { category: 'unknown', label: `Unclassified (${ext || 'no extension'})` };
}

/**
 * Main pipeline with parallel commits, timing, retry, and unclassified file reporting.
 *
 * @param {object}   options
 * @param {string}   options.githubToken
 * @param {string}   options.repoName
 * @param {string}   options.projectPath
 * @param {string}   [options.hfToken]
 * @param {boolean}  [options.createRepo]
 * @param {boolean}  [options.privateRepo]
 * @param {number}   [options.concurrency]  - parallel file commits (default 3)
 *
 * @param {function} onUpdate  - progress callback
 */
async function commitOrchestrator(options, onUpdate) {
  _cancelRequested = false;
  const pipelineStart = Date.now();

  const {
    githubToken,
    repoName,
    projectPath,
    hfToken,
    createRepo    = true,
    privateRepo   = false,
    concurrency   = DEFAULT_CONCURRENCY
  } = options;

  const emit = (update) => onUpdate && onUpdate(update);

  // helper to format elapsed / ETA
  const elapsed = () => formatDuration(Date.now() - pipelineStart);

  // ── Step 1: Validate GitHub credentials ─────────────────────────────────────
  emit({ type: 'init', message: '🔐 Validating GitHub credentials...' });
  const github = new GitHubClient(githubToken);

  let authenticatedUser;
  try {
    authenticatedUser = await github.getAuthenticatedUser();
    emit({ type: 'init', message: `✅ Authenticated as: ${authenticatedUser}` });
  } catch (err) {
    emit({ type: 'error', message: `❌ GitHub auth failed: ${err.message}` });
    throw err;
  }

  // ── Step 2: Resolve & ensure repo ───────────────────────────────────────────
  emit({ type: 'init', message: `📦 Resolving repository: ${repoName}...` });
  await github.resolveRepo(repoName);

  try {
    if (createRepo) {
      await github.ensureRepoExists(privateRepo, 'Auto-committed by GitHub Auto-Commit Tool');
      emit({ type: 'init', message: `✅ Repository ready: ${github.owner}/${github.repo}` });
    } else {
      await github.getRepoInfo();
      emit({ type: 'init', message: `✅ Repository found: ${github.owner}/${github.repo}` });
    }
  } catch (err) {
    emit({ type: 'error', message: `❌ Repository error: ${err.message}` });
    throw err;
  }

  // ── Step 3: Scan project files ───────────────────────────────────────────────
  emit({ type: 'init', message: '🔍 Scanning project files...' });
  let files, skipped;
  try {
    ({ files, skipped } = collectFiles(projectPath));
  } catch (err) {
    emit({ type: 'error', message: `❌ Failed to scan project: ${err.message}` });
    throw err;
  }

  if (files.length === 0) {
    emit({ type: 'error', message: '❌ No committable files found in the selected folder.' });
    throw new Error('No files to commit.');
  }

  // Classify every file, separate out unclassified ones
  const classifiedFiles = files.map(f => ({ path: f, ...classifyFile(f) }));
  const unclassifiedFiles = classifiedFiles.filter(f => f.category === 'unknown');

  emit({
    type: 'scan',
    total: files.length,
    skipped: skipped.length,
    files,
    skippedFiles: skipped,
    unclassifiedFiles: unclassifiedFiles.map(f => ({ path: f.path, label: f.label }))
  });

  // Report unclassified files
  if (unclassifiedFiles.length > 0) {
    emit({
      type: 'unclassified',
      count: unclassifiedFiles.length,
      files: unclassifiedFiles.map(f => ({ path: f.path, label: f.label })),
      message: `⚠️  ${unclassifiedFiles.length} file(s) could not be classified into any known module — they will still be committed.`
    });
  }

  // ── Step 4: HuggingFace project analysis ────────────────────────────────────
  const hf = hfToken ? new HuggingFaceClient(hfToken) : null;

  if (hf) {
    emit({ type: 'analyse', message: '🤖 Analysing project with HuggingFace AI...' });
    try {
      const summary = await hf.analyseProject(files);
      emit({ type: 'analyse', message: `📝 Project summary: ${summary}` });
    } catch {
      emit({ type: 'analyse', message: '⚠️  AI analysis skipped (API issue), using smart heuristics.' });
    }
  } else {
    emit({ type: 'analyse', message: '⚠️  No HuggingFace token — using smart heuristic commit messages.' });
  }

  emit({ type: 'init', message: `⚡ Parallel commit mode: ${concurrency} files at a time` });

  // ── Step 5: Parallel commit pipeline ────────────────────────────────────────
  let committed = 0;
  let failed = 0;
  let completed = 0;
  const failedFiles = [];
  const fileTimes = []; // track per-file durations for ETA

  // Split files into batches of `concurrency`
  const batches = [];
  for (let i = 0; i < files.length; i += concurrency) {
    batches.push(files.slice(i, i + concurrency));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    if (_cancelRequested) {
      emit({ type: 'cancelled' });
      return;
    }

    const batch = batches[batchIdx];

    // Process all files in the batch concurrently
    await Promise.all(batch.map(async (relativePath) => {
      if (_cancelRequested) return;

      const absolutePath = path.join(projectPath, relativePath);
      const ext = path.extname(relativePath);
      const fileStart = Date.now();

      emit({
        type: 'progress',
        current: completed + 1,
        total: files.length,
        file: relativePath,
        status: 'processing',
        elapsed: elapsed(),
        eta: calcEta(fileTimes, files.length, completed)
      });

      // ── Read file ──────────────────────────────────────────────────────────
      let content;
      try {
        content = readFileContent(absolutePath);
      } catch (err) {
        completed++;
        failed++;
        failedFiles.push({ path: relativePath, reason: `Read error: ${err.message}`, retries: 0 });
        emit({
          type: 'progress',
          current: completed,
          total: files.length,
          file: relativePath,
          status: 'failed',
          error: `Read error: ${err.message}`,
          retries: 0,
          elapsed: elapsed(),
          eta: calcEta(fileTimes, files.length, completed)
        });
        return;
      }

      // ── Generate commit message ─────────────────────────────────────────────
      let commitMsg;
      const isBinary = isBinaryFile(absolutePath);

      if (isBinary) {
        commitMsg = `Add binary file: ${relativePath}`;
      } else if (hf) {
        try {
          commitMsg = await hf.generateCommitMessage(relativePath, content.toString('utf8'), ext);
        } catch {
          commitMsg = buildFallbackMessage(relativePath);
        }
      } else {
        commitMsg = buildFallbackMessage(relativePath);
      }

      // ── Commit with retry logic ─────────────────────────────────────────────
      let lastError = null;
      let attempt = 0;
      let success = false;

      while (attempt < MAX_RETRIES && !_cancelRequested) {
        try {
          if (attempt > 0) {
            const waitMs = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
            emit({
              type: 'retry',
              file: relativePath,
              attempt,
              maxRetries: MAX_RETRIES,
              waitMs,
              message: `🔄 Retrying ${relativePath} (attempt ${attempt + 1}/${MAX_RETRIES}) in ${waitMs / 1000}s...`
            });
            await sleep(waitMs);
          }

          await github.commitFile(relativePath, content, commitMsg);
          success = true;
          break;
        } catch (err) {
          lastError = err;
          attempt++;

          // Don't retry on 4xx client errors (bad token, file too large, etc.)
          // Only retry on 5xx server errors and network errors
          const status = err.status || 0;
          if (status >= 400 && status < 500 && status !== 409 && status !== 422) {
            break; // no point retrying auth/permission errors
          }
          // 409 Conflict and 422 Unprocessable are SHA conflicts — retry with fresh SHA
        }
      }

      const fileMs = Date.now() - fileStart;
      fileTimes.push(fileMs);
      completed++;

      if (success) {
        committed++;
        emit({
          type: 'progress',
          current: completed,
          total: files.length,
          file: relativePath,
          status: 'committed',
          commitMsg,
          durationMs: fileMs,
          duration: formatDuration(fileMs),
          elapsed: elapsed(),
          eta: calcEta(fileTimes, files.length, completed)
        });
      } else {
        failed++;
        failedFiles.push({
          path: relativePath,
          reason: lastError?.message || 'Unknown error',
          retries: attempt
        });
        emit({
          type: 'progress',
          current: completed,
          total: files.length,
          file: relativePath,
          status: 'failed',
          error: lastError?.message || 'Unknown error',
          retries: attempt,
          elapsed: elapsed(),
          eta: calcEta(fileTimes, files.length, completed)
        });
      }
    }));

    // Small delay between batches to avoid GitHub secondary rate limits
    if (batchIdx < batches.length - 1 && !_cancelRequested) {
      await sleep(BATCH_DELAY);
    }
  }

  // ── Step 6: Final summary ────────────────────────────────────────────────────
  const totalMs = Date.now() - pipelineStart;

  emit({
    type: 'done',
    committed,
    failed,
    failedFiles,
    skipped: skipped.length,
    unclassified: unclassifiedFiles.length,
    repoUrl: `https://github.com/${github.owner}/${github.repo}`,
    totalDuration: formatDuration(totalMs),
    totalMs,
    avgFileMs: fileTimes.length ? Math.round(fileTimes.reduce((a, b) => a + b, 0) / fileTimes.length) : 0
  });
}

commitOrchestrator.cancel = () => { _cancelRequested = true; };

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculate estimated time remaining based on average file processing time.
 */
function calcEta(fileTimes, totalFiles, completedFiles) {
  if (fileTimes.length === 0) return '--';
  const remaining = totalFiles - completedFiles;
  if (remaining <= 0) return '0s';
  const avgMs = fileTimes.reduce((a, b) => a + b, 0) / fileTimes.length;
  return formatDuration(Math.round(avgMs * remaining));
}

/**
 * Format milliseconds into a human-readable string: "1m 23s" or "45s"
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function buildFallbackMessage(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const filename = parts[parts.length - 1];
  const dir = parts.length > 1 ? parts[parts.length - 2] : '';
  const ext = path.extname(filename);
  const name = filename.replace(ext, '');

  if (/readme/i.test(filename))         return `Add README documentation`;
  if (/package\.json/i.test(filename))  return `Add package.json with project dependencies`;
  if (/package-lock\.json/i.test(filename)) return `Add package-lock.json`;
  if (/yarn\.lock/i.test(filename))     return `Add yarn.lock dependency lockfile`;
  if (/\.gitignore/i.test(filename))    return `Add .gitignore rules`;
  if (/dockerfile/i.test(filename))     return `Add Dockerfile for containerization`;
  if (/docker-compose/i.test(filename)) return `Add Docker Compose configuration`;
  if (/\.env\.example/i.test(filename)) return `Add environment variable template`;
  if (/index\.(js|ts|jsx|tsx)/i.test(filename)) return `Add ${dir || 'main'} entry point`;
  if (/test|spec/i.test(filePath))      return `Add tests for ${name}`;
  if (/config/i.test(filename))         return `Add ${name} configuration`;
  if (/util|helper/i.test(filename))    return `Add ${name} utility functions`;
  if (/model/i.test(filename))          return `Add ${name} data model`;
  if (/route|controller/i.test(filename)) return `Add ${name} routes`;
  if (/component/i.test(filePath))      return `Add ${name} component`;
  if (/service/i.test(filename))        return `Add ${name} service`;
  if (/middleware/i.test(filename))     return `Add ${name} middleware`;
  if (/hook/i.test(filename))           return `Add ${name} hook`;
  if (/store|reducer|action/i.test(filename)) return `Add ${name} state management`;
  return `Add ${filename}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { commitOrchestrator };
