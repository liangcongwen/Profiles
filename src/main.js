'use strict';
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  Notification,
  globalShortcut,
  screen,
  nativeImage,
  dialog,
  shell
} = require('electron');
const path = require('path');
const fs = require('fs');
const core = require('./core');

const APP_NAME = '桌面签';
const isTest = process.env.DESKTODO_TEST === '1';
if (process.env.DESKTODO_USERDATA) app.setPath('userData', process.env.DESKTODO_USERDATA);

let mainWin = null;
let tray = null;
let state = null;
let quitting = false;
const reminderWins = new Map(); // taskId -> BrowserWindow

// ---------------- 数据持久化 ----------------
const dataFile = () => path.join(app.getPath('userData'), 'data.json');

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    return core.normalizeState(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 数据损坏时备份原文件，避免覆盖丢失
      try {
        fs.copyFileSync(dataFile(), dataFile() + '.broken-' + Date.now());
      } catch (_) {}
    }
    return core.defaultState();
  }
}

let saveTimer = null;
function saveStateNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file); // 原子替换，防止写一半断电
}
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 300);
}

function broadcast() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', state);
}

// ---------------- 图标 ----------------
function appIcon(size) {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  return size ? img.resize({ width: size, height: size }) : img;
}

// ---------------- 主窗口 ----------------
function createMainWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = state.bounds || { width: 340, height: 560, x: wa.x + wa.width - 360, y: wa.y + 40 };
  mainWin = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 260,
    minHeight: 200,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    show: false,
    icon: appIcon(),
    alwaysOnTop: !!state.settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  ensureOnScreen();
  mainWin.setOpacity(state.settings.opacity);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWin.show();
  });

  const remember = () => {
    if (!mainWin || mainWin.isDestroyed() || collapsed) return;
    state.bounds = mainWin.getBounds();
    saveState();
  };
  mainWin.on('moved', remember);
  mainWin.on('resized', remember);
  mainWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  // 外部链接用系统浏览器打开
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// 多显示器拔掉后窗口可能落在屏幕外，拉回主屏
function ensureOnScreen() {
  const b = mainWin.getBounds();
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
  });
  if (!visible) {
    const wa = screen.getPrimaryDisplay().workArea;
    mainWin.setBounds({ x: wa.x + wa.width - b.width - 20, y: wa.y + 40, width: b.width, height: b.height });
  }
}

function toggleMain(forceShow) {
  if (!mainWin) return;
  if (collapsed) expand();
  if (forceShow || !mainWin.isVisible()) {
    mainWin.show();
    mainWin.focus();
  } else {
    mainWin.hide();
  }
}

// ---------------- 贴边隐藏 ----------------
// 窗口拖到屏幕上/左/右边缘后，鼠标离开即缩成一条细边，鼠标移上去再展开
let collapsed = false;
let collapseSide = null;
let savedBounds = null;
const EDGE = 6; // 判定贴边的距离
const STRIP = 4; // 隐藏后露出的像素

function edgeSide() {
  const b = mainWin.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  if (b.y <= a.y + EDGE) return 'top';
  if (b.x <= a.x + EDGE) return 'left';
  if (b.x + b.width >= a.x + a.width - EDGE) return 'right';
  return null;
}

function collapse(side) {
  savedBounds = mainWin.getBounds();
  const a = screen.getDisplayMatching(savedBounds).workArea;
  const b = Object.assign({}, savedBounds);
  if (side === 'top') b.y = a.y - b.height + STRIP;
  if (side === 'left') b.x = a.x - b.width + STRIP;
  if (side === 'right') b.x = a.x + a.width - STRIP;
  collapsed = true;
  collapseSide = side;
  mainWin.setBounds(b);
  mainWin.setAlwaysOnTop(true, 'screen-saver'); // 隐藏时保持最前，方便鼠标唤出
}

function expand() {
  if (!collapsed) return;
  collapsed = false;
  mainWin.setBounds(savedBounds);
  mainWin.setAlwaysOnTop(!!state.settings.alwaysOnTop);
}

function inside(p, b, pad) {
  return p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad;
}

let leaveSince = 0;
function edgeTick() {
  if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) return;
  if (!state.settings.edgeHide) {
    if (collapsed) expand();
    return;
  }
  const p = screen.getCursorScreenPoint();
  if (collapsed) {
    if (inside(p, mainWin.getBounds(), 1)) expand();
    return;
  }
  const side = edgeSide();
  if (!side || mainWin.isFocused() && editing) return;
  if (inside(p, mainWin.getBounds(), 2)) {
    leaveSince = 0;
  } else {
    if (!leaveSince) leaveSince = Date.now();
    if (Date.now() - leaveSince > 600) {
      leaveSince = 0;
      collapse(side);
    }
  }
}
let editing = false; // 渲染进程正在输入时不自动隐藏

// ---------------- 提醒 ----------------
function checkReminders() {
  const now = Date.now();
  const due = core.dueTasks(state, now);
  if (!due.length) return;
  for (const t of due) {
    core.markNotified(t, now);
    showReminder(t);
  }
  saveState();
  broadcast();
}

function showReminder(task) {
  if (Notification.isSupported()) {
    const n = new Notification({
      title: APP_NAME + ' 提醒',
      body: task.text,
      icon: appIcon(64),
      silent: !state.settings.sound
    });
    n.on('click', () => toggleMain(true));
    n.show();
  }
  // 额外弹出一个置顶小窗，支持“完成 / 稍后提醒”
  const old = reminderWins.get(task.id);
  if (old && !old.isDestroyed()) old.close();
  const wa = screen.getPrimaryDisplay().workArea;
  const offset = reminderWins.size * 20;
  const w = new BrowserWindow({
    width: 320,
    height: 190,
    x: wa.x + wa.width - 340 - offset,
    y: wa.y + wa.height - 210 - offset,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.loadFile(path.join(__dirname, 'renderer', 'reminder.html'), { query: { id: task.id } });
  w.once('ready-to-show', () => (isTest ? w.showInactive() : w.show()));
  w.on('closed', () => {
    if (reminderWins.get(task.id) === w) reminderWins.delete(task.id);
  });
  reminderWins.set(task.id, w);
}

// ---------------- 托盘 ----------------
function buildTrayMenu() {
  const s = state.settings;
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => toggleMain() },
    { label: '新建待办', click: () => { toggleMain(true); mainWin.webContents.send('focus-input'); } },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: !!s.alwaysOnTop, click: (m) => applySettings({ alwaysOnTop: m.checked }) },
    { label: '贴边自动隐藏', type: 'checkbox', checked: !!s.edgeHide, click: (m) => applySettings({ edgeHide: m.checked }) },
    { label: '锁定位置', type: 'checkbox', checked: !!s.locked, click: (m) => applySettings({ locked: m.checked }) },
    { label: '开机自启动', type: 'checkbox', checked: !!s.autoStart, click: (m) => applySettings({ autoStart: m.checked }) },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
}

function createTray() {
  tray = new Tray(appIcon(16));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => toggleMain());
}

// ---------------- 设置 ----------------
function registerHotkey(prev) {
  if (prev) globalShortcut.unregister(prev);
  const key = state.settings.hotkey;
  if (!key) return true;
  try {
    return globalShortcut.register(key, () => toggleMain());
  } catch (_) {
    return false;
  }
}

function applySettings(patch) {
  const prev = Object.assign({}, state.settings);
  Object.assign(state.settings, patch);
  const s = state.settings;
  if (mainWin && !mainWin.isDestroyed()) {
    if (!collapsed) mainWin.setAlwaysOnTop(!!s.alwaysOnTop);
    mainWin.setOpacity(Math.min(1, Math.max(0.3, Number(s.opacity) || 1)));
    mainWin.setMovable(!s.locked);
    mainWin.setResizable(!s.locked);
  }
  if (patch.autoStart !== undefined && !isTest && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!s.autoStart, args: ['--hidden'] });
  }
  let hotkeyOk = true;
  if (patch.hotkey !== undefined && patch.hotkey !== prev.hotkey) {
    hotkeyOk = registerHotkey(prev.hotkey);
    if (!hotkeyOk) {
      s.hotkey = prev.hotkey;
      registerHotkey();
    }
  }
  if (tray) tray.setContextMenu(buildTrayMenu());
  saveState();
  broadcast();
  return { ok: hotkeyOk, settings: s };
}

// ---------------- IPC ----------------
function findTask(id) {
  return state.tasks.find((t) => t.id === id);
}

ipcMain.handle('get-state', () => state);
ipcMain.handle('set-tasks', (_e, tasks) => {
  // 主进程里更新过的任务（例如刚触发提醒）以较新的为准，避免被渲染进程旧数据覆盖
  const mine = new Map(state.tasks.map((t) => [t.id, t]));
  state.tasks = tasks.map((t) => {
    const cur = mine.get(t.id);
    return cur && cur.updatedAt > t.updatedAt ? cur : core.newTask(t);
  });
  saveState();
  return true;
});
ipcMain.handle('set-categories', (_e, cats) => {
  state.categories = cats;
  const ids = new Set(cats.map((c) => c.id));
  for (const t of state.tasks) if (!ids.has(t.categoryId)) t.categoryId = 'default';
  saveState();
  broadcast();
  return true;
});
ipcMain.handle('complete-task', (_e, id) => {
  core.completeTask(state, id, Date.now());
  saveState();
  broadcast();
  return true;
});
ipcMain.handle('set-settings', (_e, patch) => applySettings(patch));
ipcMain.handle('get-task', (_e, id) => findTask(id) || null);
ipcMain.handle('reminder-action', (_e, id, action, minutes) => {
  const t = findTask(id);
  const w = reminderWins.get(id);
  if (t) {
    if (action === 'done') core.completeTask(state, id, Date.now());
    if (action === 'snooze') core.snooze(t, minutes || 10, Date.now());
    saveState();
    broadcast();
  }
  if (action === 'open') toggleMain(true);
  if (w && !w.isDestroyed()) w.close();
  return true;
});
ipcMain.on('win', (e, cmd) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (cmd === 'hide') w.hide();
  if (cmd === 'close') w.close();
});
ipcMain.on('editing', (_e, v) => {
  editing = !!v;
});
ipcMain.handle('export-data', async () => {
  const r = await dialog.showSaveDialog(mainWin, {
    title: '导出数据',
    defaultPath: 'desktodo-backup-' + new Date().toISOString().slice(0, 10) + '.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(state, null, 2), 'utf8');
  return true;
});
ipcMain.handle('import-data', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '导入数据（将覆盖当前数据）',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    saveStateNow(); // 先落盘当前数据
    fs.copyFileSync(dataFile(), dataFile() + '.before-import-' + Date.now());
    const bounds = state.bounds;
    state = core.normalizeState(raw);
    state.bounds = bounds;
    applySettings({});
    return true;
  } catch (e) {
    dialog.showErrorBox('导入失败', '文件格式不正确：' + e.message);
    return false;
  }
});

// ---------------- 生命周期 ----------------
if (!isTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => toggleMain(true));
  if (process.platform === 'win32') app.setAppUserModelId('com.liangcongwen.desktodo');

  app.whenReady().then(() => {
    state = loadState();
    createMainWindow();
    createTray();
    applySettings({});
    registerHotkey();
    checkReminders();
    setInterval(checkReminders, 5000);
    setInterval(edgeTick, 200);
  });

  app.on('before-quit', () => {
    quitting = true;
    if (collapsed) expand();
    if (state) {
      if (mainWin && !mainWin.isDestroyed()) state.bounds = mainWin.getBounds();
      saveStateNow();
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    // 常驻托盘，不退出
  });
}
