const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// Initialize store for settings
const store = new Store();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  // Open DevTools if in development
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  // Set up application menu
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          click: () => mainWindow.webContents.send('open-settings')
        },
        {
          label: 'Export Chat',
          click: () => mainWindow.webContents.send('export-chat')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About Claude Chat',
          click: () => dialog.showMessageBox(mainWindow, {
            title: 'About Claude Chat',
            message: 'Claude Chat v1.0.0\nAn Electron-based client for Claude.ai',
            buttons: ['OK']
          })
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});

// Handle API key storage
ipcMain.handle('save-api-key', async (event, apiKey) => {
  store.set('apiKey', apiKey);
  return true;
});

ipcMain.handle('get-api-key', async (event) => {
  return store.get('apiKey');
});

// Handle saving chat history
ipcMain.handle('export-chat-dialog', async (event, chatContent) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Export Chat History',
    defaultPath: 'claude-chat-export.md',
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (filePath) {
    try {
      fs.writeFileSync(filePath, chatContent, 'utf-8');
      return { success: true, path: filePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  return { success: false, error: 'Export cancelled' };
});
