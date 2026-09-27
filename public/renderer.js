/* ── State ────────────────────────────────────────────────────────────────── */
let isRunning = false;
let scannedFiles = [];
let scannedSkipped = [];
let currentEventSource = null;

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const githubTokenEl   = document.getElementById('githubToken');
const hfTokenEl       = document.getElementById('hfToken');
const repoNameEl      = document.getElementById('repoName');
const projectPathEl   = document.getElementById('projectPath');
const createRepoEl    = document.getElementById('createRepo');
const privateRepoEl   = document.getElementById('privateRepo');

const startBtn        = document.getElementById('startBtn');
const cancelBtn       = document.getElementById('cancelBtn');
const browseBtn       = document.getElementById('browseBtn');
const toggleToken     = document.getElementById('toggleToken');
const toggleHf        = document.getElementById('toggleHf');
const clearLogBtn     = document.getElementById('clearLogBtn');

const progressPanel   = document.getElementById('progressPanel');
const progressBar     = document.getElementById('progressBar');
const progressTitle   = document.getElementById('progressTitle');
const progressCounter = document.getElementById('progressCounter');
const currentFileEl   = document.getElementById('currentFile');

const summaryCard     = document.getElementById('summaryCard');
const summaryIcon     = document.getElementById('summaryIcon');
const committedCount  = document.getElementById('committedCount');
const skippedCount    = document.getElementById('skippedCount');
const failedCount     = document.getElementById('failedCount');
const repoLinkEl      = document.getElementById('repoLink');

const logContainer    = document.getElementById('logContainer');
const includeList     = document.getElementById('includeList');
const excludeList     = document.getElementById('excludeList');
const fileCounts      = document.getElementById('fileCounts');

const statusDot       = document.getElementById('statusDot');
const statusLabel     = document.getElementById('statusLabel');

// Folder browser modal
const folderModal     = document.getElementById('folderModal');
const folderPath      = document.getElementById('folderPath');
const folderList      = document.getElementById('folderList');
const folderConfirm   = document.getElementById('folderConfirm');
const folderCancel    = document.getElementById('folderCancel');

let selectedFolder = '';

/* ── Tab navigation ───────────────────────────────────────────────────────── */
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

/* ── Token visibility toggles ─────────────────────────────────────────────── */
toggleToken.addEventListener('click', () => {
  githubTokenEl.type = githubTokenEl.type === 'password' ? 'text' : 'password';
});
toggleHf.addEventListener('click', () => {
  hfTokenEl.type = hfTokenEl.type === 'password' ? 'text' : 'password';
});

/* ── Folder browser ───────────────────────────────────────────────────────── */
browseBtn.addEventListener('click', () => {
  openFolderBrowser('C:\\');
});

async function openFolderBrowser(startPath) {
  selectedFolder = startPath;
  folderModal.classList.remove('hidden');
  await loadFolder(startPath);
}

async function loadFolder(dirPath) {
  folderPath.textContent = dirPath;
  folderList.innerHTML = '<li class="folder-loading">Loading...</li>';
  selectedFolder = dirPath;

  try {
    const res = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath })
    });
    const data = await res.json();
    if (data.error) { folderList.innerHTML = `<li class="folder-error">${data.error}</li>`; return; }

    folderList.innerHTML = '';

    // Parent directory
    if (data.parent) {
      const li = document.createElement('li');
      li.className = 'folder-item parent';
      li.innerHTML = `<span class="folder-icon">⬆</span> ..`;
      li.addEventListener('click', () => loadFolder(data.parent));
      folderList.appendChild(li);
    }

    // Subdirectories
    data.dirs.forEach(d => {
      const li = document.createElement('li');
      li.className = 'folder-item';
      li.innerHTML = `<span class="folder-icon">📁</span> ${d.name}`;
      li.addEventListener('dblclick', () => loadFolder(d.path));
      li.addEventListener('click', () => {
        document.querySelectorAll('.folder-item').forEach(x => x.classList.remove('selected'));
        li.classList.add('selected');
        selectedFolder = d.path;
        folderPath.textContent = d.path;
      });
      folderList.appendChild(li);
    });

    if (data.dirs.length === 0 && !data.parent) {
      folderList.innerHTML = '<li class="folder-empty">No subfolders found.</li>';
    }
  } catch (err) {
    folderList.innerHTML = `<li class="folder-error">Error: ${err.message}</li>`;
  }
}

folderConfirm.addEventListener('click', () => {
  if (selectedFolder) {
    projectPathEl.value = selectedFolder;
    log('info', `📁 Project folder selected: ${selectedFolder}`);
  }
  folderModal.classList.add('hidden');
});

folderCancel.addEventListener('click', () => {
  folderModal.classList.add('hidden');
});

// Allow manually typing a path
projectPathEl.addEventListener('change', () => {
  selectedFolder = projectPathEl.value;
});
projectPathEl.removeAttribute('readonly');

/* ── Clear log ─────────────────────────────────────────────────────────────── */
clearLogBtn.addEventListener('click', () => {
  logContainer.innerHTML = '<div class="log-empty">Log cleared.</div>';
});

/* ── Start commit pipeline ────────────────────────────────────────────────── */
startBtn.addEventListener('click', async () => {
  if (isRunning) return;

  const githubToken = githubTokenEl.value.trim();
  const hfToken     = hfTokenEl.value.trim();
  const repoName    = repoNameEl.value.trim();
  const projectPath = projectPathEl.value.trim();

  if (!githubToken) { showError('GitHub token is required.'); return; }
  if (!repoName)    { showError('Repository name is required.'); return; }
  if (!projectPath) { showError('Please enter a project folder path.'); return; }

  resetProgressUI();
  setRunningState(true);

  // Close any existing SSE connection
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }

  // Use fetch + ReadableStream to handle SSE from a POST request
  try {
    const response = await fetch('/api/start-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubToken,
        hfToken: hfToken || null,
        repoName,
        projectPath,
        createRepo: createRepoEl.checked,
        privateRepo: privateRepoEl.checked
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const update = JSON.parse(line.slice(6));
            handleProgress(update);
          } catch { /* malformed line */ }
        }
      }
    }
  } catch (err) {
    log('error', `❌ Connection error: ${err.message}`);
    setStatus('error', 'Error');
  }

  setRunningState(false);
});

/* ── Cancel ──────────────────────────────────────────────────────────────── */
cancelBtn.addEventListener('click', async () => {
  await fetch('/api/cancel', { method: 'POST' });
  log('warning', '⚠️  Cancellation requested...');
});

/* ── Progress handler ─────────────────────────────────────────────────────── */
function handleProgress(update) {
  switch (update.type) {

    case 'init':
      log('info', update.message);
      progressTitle.textContent = update.message.replace(/^[^\w]*/, '');
      break;

    case 'scan':
      scannedFiles   = update.files || [];
      scannedSkipped = update.skippedFiles || [];
      log('info', `🔍 Found ${update.total} files to commit, ${update.skipped} skipped.`);
      renderFileList(scannedFiles, scannedSkipped);
      fileCounts.textContent = `${update.total} to commit · ${update.skipped} skipped`;
      progressCounter.textContent = `0 / ${update.total}`;
      break;

    case 'analyse':
      log(update.message.includes('⚠') ? 'warning' : 'info', update.message);
      break;

    case 'progress': {
      const pct = Math.round((update.current / update.total) * 100);
      progressBar.style.width = `${pct}%`;
      progressCounter.textContent = `${update.current} / ${update.total}`;

      if (update.status === 'processing') {
        progressTitle.textContent = `Processing...`;
        currentFileEl.textContent = `→ ${update.file}`;
        log('muted', `  ⟳ ${update.file}`);
        updateFileStatus(update.file, 'processing');
      } else if (update.status === 'committed') {
        log('success', `  ✅ ${update.file}`);
        if (update.commitMsg) log('muted', `     💬 "${update.commitMsg}"`);
        updateFileStatus(update.file, 'committed');
        currentFileEl.textContent = `✅ ${update.file}`;
      } else if (update.status === 'failed') {
        log('error', `  ❌ ${update.file} — ${update.error}`);
        updateFileStatus(update.file, 'failed');
      }
      break;
    }

    case 'done':
      committedCount.textContent = update.committed;
      skippedCount.textContent   = update.skipped;
      failedCount.textContent    = update.failed;
      summaryIcon.textContent    = update.failed === 0 ? '✅' : '⚠️';
      summaryCard.classList.remove('hidden');
      progressTitle.textContent  = 'Pipeline complete!';
      currentFileEl.textContent  = '';
      progressBar.style.width    = '100%';

      if (update.repoUrl) {
        repoLinkEl.href = update.repoUrl;
        repoLinkEl.classList.remove('hidden');
      }

      log('success', `\n🎉 Done! ${update.committed} committed · ${update.failed} failed · ${update.skipped} skipped`);
      if (update.repoUrl) log('info', `🔗 ${update.repoUrl}`);
      setStatus('done', 'Done');
      break;

    case 'cancelled':
      log('warning', '🛑 Operation cancelled by user.');
      progressTitle.textContent = 'Cancelled';
      setStatus('error', 'Cancelled');
      break;

    case 'error':
      log('error', update.message);
      progressTitle.textContent = 'Error occurred';
      setStatus('error', 'Error');
      break;
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function log(level, message) {
  const empty = logContainer.querySelector('.log-empty');
  if (empty) empty.remove();

  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.innerHTML = `<span class="timestamp">${ts}</span>${escapeHtml(message)}`;
  logContainer.appendChild(line);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showError(msg) {
  log('error', `❌ ${msg}`);
  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed; top:16px; right:16px; z-index:9999;
    background:#da3633; color:#fff; padding:10px 18px;
    border-radius:8px; font-size:13px; font-weight:600;
    box-shadow:0 4px 12px rgba(0,0,0,.4);
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function resetProgressUI() {
  progressPanel.classList.remove('hidden');
  summaryCard.classList.add('hidden');
  repoLinkEl.classList.add('hidden');
  progressBar.style.width = '0%';
  progressTitle.textContent = 'Starting...';
  progressCounter.textContent = '0 / 0';
  currentFileEl.textContent = '';
  log('info', '─'.repeat(55));
  log('info', '🚀 Starting commit pipeline...');
}

function setRunningState(running) {
  isRunning = running;
  startBtn.disabled = running;
  cancelBtn.classList.toggle('hidden', !running);
  if (running) setStatus('running', 'Running');
}

function setStatus(state, label) {
  statusDot.className = 'status-dot ' + state;
  statusLabel.textContent = label;
}

function renderFileList(files, skipped) {
  includeList.innerHTML = '';
  excludeList.innerHTML = '';

  if (files.length === 0) {
    includeList.innerHTML = '<li class="placeholder">No files found.</li>';
  } else {
    files.forEach(f => {
      const li = document.createElement('li');
      li.id = `file-${btoa(f).replace(/[^a-zA-Z0-9]/g, '')}`;
      li.dataset.path = f;
      li.textContent = f;
      includeList.appendChild(li);
    });
  }

  if (skipped.length === 0) {
    excludeList.innerHTML = '<li class="placeholder">Nothing skipped.</li>';
  } else {
    skipped.forEach(f => {
      const li = document.createElement('li');
      li.textContent = f;
      excludeList.appendChild(li);
    });
  }
}

function updateFileStatus(filePath, status) {
  const li = includeList.querySelector(`[data-path="${filePath}"]`);
  if (!li) return;
  li.className = status;
  if (status === 'committed') li.textContent = `✅ ${filePath}`;
  else if (status === 'failed') li.textContent = `❌ ${filePath}`;
  else if (status === 'processing') li.textContent = `⟳ ${filePath}`;
}
