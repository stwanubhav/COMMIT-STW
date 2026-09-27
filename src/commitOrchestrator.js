const path = require('path');
const { GitHubClient } = require('./github');
const { HuggingFaceClient } = require('./huggingface');
const { collectFiles, isBinaryFile, readFileContent } = require('./fileFilter');

// Delay between consecutive GitHub API calls to avoid rate-limiting (ms)
const INTER_COMMIT_DELAY = 800;

let _cancelRequested = false;

/**
 * Main pipeline:
 *  1. Validate credentials & resolve repo
 *  2. Collect + filter files from local project folder
 *  3. Optionally analyse project with HuggingFace
 *  4. For each file: generate AI commit message → commit to GitHub
 *
 * @param {object} options
 * @param {string} options.githubToken
 * @param {string} options.repoName        - "owner/repo" or just "repo"
 * @param {string} options.projectPath     - Absolute local path to project folder
 * @param {string} [options.hfToken]       - HuggingFace API token (optional)
 * @param {boolean} [options.createRepo]   - Auto-create repo if missing
 * @param {boolean} [options.privateRepo]  - Make new repo private
 * @param {number}  [options.delayMs]      - Override inter-commit delay
 *
 * @param {function} onUpdate              - Progress callback(update)
 *   update shapes:
 *     { type: 'init',    message }
 *     { type: 'scan',    total, skipped, files }
 *     { type: 'analyse', message }
 *     { type: 'progress', current, total, file, status, commitMsg, error }
 *     { type: 'done',    committed, failed, skipped }
 *     { type: 'error',   message }
 *     { type: 'cancelled' }
 */
async function commitOrchestrator(options, onUpdate) {
  _cancelRequested = false;

  const {
    githubToken,
    repoName,
    projectPath,
    hfToken,
    createRepo = true,
    privateRepo = false,
    delayMs = INTER_COMMIT_DELAY
  } = options;

  const emit = (update) => onUpdate && onUpdate(update);

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

  // ── Step 2: Resolve & ensure repo exists ────────────────────────────────────
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

  // ── Step 3: Scan local project files ────────────────────────────────────────
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

  emit({
    type: 'scan',
    total: files.length,
    skipped: skipped.length,
    files,
    skippedFiles: skipped
  });

  // ── Step 4: Optionally analyse project with HuggingFace ─────────────────────
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

  // ── Step 5: Commit files one by one ─────────────────────────────────────────
  let committed = 0;
  let failed = 0;
  const failedFiles = [];

  for (let i = 0; i < files.length; i++) {
    if (_cancelRequested) {
      emit({ type: 'cancelled' });
      return;
    }

    const relativePath = files[i];
    const absolutePath = path.join(projectPath, relativePath);
    const ext = path.extname(relativePath);

    emit({
      type: 'progress',
      current: i + 1,
      total: files.length,
      file: relativePath,
      status: 'processing'
    });

    // Read file content
    let content;
    try {
      content = readFileContent(absolutePath);
    } catch (err) {
      emit({
        type: 'progress',
        current: i + 1,
        total: files.length,
        file: relativePath,
        status: 'failed',
        error: `Read error: ${err.message}`
      });
      failed++;
      failedFiles.push(relativePath);
      continue;
    }

    // Generate commit message
    let commitMsg;
    const isBinary = isBinaryFile(absolutePath);

    if (isBinary) {
      commitMsg = `Add binary file: ${relativePath}`;
    } else if (hf) {
      try {
        const textContent = content.toString('utf8');
        commitMsg = await hf.generateCommitMessage(relativePath, textContent, ext);
      } catch {
        commitMsg = buildFallbackMessage(relativePath);
      }
    } else {
      commitMsg = buildFallbackMessage(relativePath);
    }

    // Commit to GitHub
    try {
      await github.commitFile(relativePath, content, commitMsg);
      committed++;
      emit({
        type: 'progress',
        current: i + 1,
        total: files.length,
        file: relativePath,
        status: 'committed',
        commitMsg
      });
    } catch (err) {
      failed++;
      failedFiles.push(relativePath);
      emit({
        type: 'progress',
        current: i + 1,
        total: files.length,
        file: relativePath,
        status: 'failed',
        error: err.message
      });
    }

    // Throttle to avoid GitHub secondary rate limits
    if (i < files.length - 1) {
      await sleep(delayMs);
    }
  }

  // ── Step 6: Final summary ────────────────────────────────────────────────────
  emit({
    type: 'done',
    committed,
    failed,
    failedFiles,
    skipped: skipped.length,
    repoUrl: `https://github.com/${github.owner}/${github.repo}`
  });
}

// Allow cancellation from main process
commitOrchestrator.cancel = () => {
  _cancelRequested = true;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildFallbackMessage(filePath) {
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1];
  const dir = parts.length > 1 ? parts[parts.length - 2] : '';
  const ext = path.extname(filename);
  const name = filename.replace(ext, '');

  if (/readme/i.test(filename)) return `Add README documentation`;
  if (/package\.json/i.test(filename)) return `Add package.json with project dependencies`;
  if (/\.gitignore/i.test(filename)) return `Add .gitignore rules`;
  if (/dockerfile/i.test(filename)) return `Add Dockerfile for containerization`;
  if (/docker-compose/i.test(filename)) return `Add Docker Compose configuration`;
  if (/\.env\.example/i.test(filename)) return `Add environment variable template`;
  if (/index\.(js|ts|jsx|tsx)/i.test(filename)) return `Add ${dir || 'main'} entry point`;
  if (/test|spec/i.test(filePath)) return `Add tests for ${name}`;
  if (/config/i.test(filename)) return `Add ${name} configuration`;
  if (/util|helper/i.test(filename)) return `Add ${name} utility functions`;
  if (/model/i.test(filename)) return `Add ${name} data model`;
  if (/route|controller/i.test(filename)) return `Add ${name} routes`;
  if (/component/i.test(filePath)) return `Add ${name} component`;
  if (/service/i.test(filename)) return `Add ${name} service`;
  return `Add ${filename}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { commitOrchestrator };
