const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { commitOrchestrator } = require('./commitOrchestrator');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../public/icon.png'),
    titleBarStyle: 'hidden',
    backgroundColor: '#0d1117',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: pick a local project folder ──────────────────────────────────────────
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select your project folder'
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── IPC: start the commit pipeline ────────────────────────────────────────────
ipcMain.handle('start-commit', async (event, options) => {
  try {
    await commitOrchestrator(options, (update) => {
      // Stream progress back to renderer
      mainWindow.webContents.send('progress-update', update);
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── IPC: cancel ongoing operation ─────────────────────────────────────────────
ipcMain.handle('cancel-commit', () => {
  commitOrchestrator.cancel();
  return { success: true };
});
