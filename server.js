const express = require('express');
const path = require('path');
const { commitOrchestrator } = require('./src/commitOrchestrator');

const app = express();
const PORT = 3131;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE: stream commit progress ───────────────────────────────────────────────
app.post('/api/start-commit', async (req, res) => {
  // Set up Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await commitOrchestrator(req.body, send);
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// ── Cancel ────────────────────────────────────────────────────────────────────
app.post('/api/cancel', (_req, res) => {
  commitOrchestrator.cancel();
  res.json({ success: true });
});

// ── List directory (folder browser) ──────────────────────────────────────────
const fs = require('fs');
app.post('/api/browse', (req, res) => {
  const dirPath = req.body.path || 'C:\\';
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }));
    const parent = path.dirname(dirPath) !== dirPath ? path.dirname(dirPath) : null;
    res.json({ current: dirPath, parent, dirs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ GitHub Auto-Commit running at: http://localhost:${PORT}\n`);

  // Auto-open browser
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
});
