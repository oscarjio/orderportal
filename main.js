const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');

// Ladda API-klient och auth-storage. Wrappad i try/catch så appen
// fortfarande startar även om modulerna saknas under utveckling.
let authStorage = null;
let PPClient = null;
let DigestAuth = null;
try {
  authStorage = require('./src/lib/auth-storage.js');
} catch (e) {
  console.warn('[main] auth-storage saknas:', e.message);
}
try {
  const ppModule = require('./src/lib/pp-client.js');
  // Stöd både default-export och named exports
  PPClient = ppModule.PPClient || ppModule.default || ppModule;
  DigestAuth = ppModule.DigestAuth;
} catch (e) {
  console.warn('[main] pp-client saknas:', e.message);
}

let mainWindow;
// Singleton som delas mellan IPC-handlers
let ppClient = null;

function createWindow(startPage) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'OrderPortal',
    backgroundColor: '#1e2535',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const initialPage = startPage || path.join('src', 'index.html');
  mainWindow.loadFile(path.join(__dirname, initialPage));

  // Enkel applikationsmeny (kan bytas ut senare)
  const template = [
    {
      label: 'Arkiv',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'quit', label: 'Avsluta' }
      ]
    },
    {
      label: 'Redigera',
      submenu: [
        { role: 'undo', label: 'Ångra' },
        { role: 'redo', label: 'Gör om' },
        { type: 'separator' },
        { role: 'cut', label: 'Klipp ut' },
        { role: 'copy', label: 'Kopiera' },
        { role: 'paste', label: 'Klistra in' }
      ]
    },
    {
      label: 'Visa',
      submenu: [
        { role: 'togglefullscreen', label: 'Helskärm' },
        { role: 'toggleDevTools', label: 'Utvecklarverktyg' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Initierar ppClient från sparad digest-state om sådan finns.
// Returnerar true om användaren är inloggad (state återställt).
async function bootstrapAuth() {
  if (!authStorage || !PPClient) return false;
  try {
    const state = await authStorage.loadState();
    if (state && DigestAuth) {
      // Gammalt MD5-format har 32-char ha1. Nytt format använder SHA-256 (64 ch).
      if (state.ha1 && state.ha1.length === 32) {
        console.log('[main] Hittade gammalt MD5-format — rensar och kräver ny login');
        await authStorage.clearState();
        if (PPClient) ppClient = new PPClient();
        return false;
      }
      // Utan clientId kan vi inte beräkna korrekt digest-response — tvinga re-login
      if (!state.clientId) {
        console.log('[main] State saknar clientId — rensar och kräver ny login');
        await authStorage.clearState();
        if (PPClient) ppClient = new PPClient();
        return false;
      }
      const digestAuth = new DigestAuth(state);
      if (typeof digestAuth.fromJSON === 'function' && state.nc !== undefined) {
        digestAuth.fromJSON(state);
      }
      ppClient = new PPClient({ digestAuth });
      console.log('[main] Återställde auth-state för', state.username);
      return true;
    }
  } catch (e) {
    console.warn('[main] bootstrapAuth misslyckades:', e.message);
  }
  // Ingen state -> skapa en tom klient för login-flödet
  if (PPClient) ppClient = new PPClient();
  return false;
}

app.whenReady().then(async () => {
  const loggedIn = await bootstrapAuth();
  const startPage = loggedIn
    ? path.join('src', 'index.html')
    : path.join('src', 'login.html');
  createWindow(startPage);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(startPage);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: App-info ----------
// Exempel på IPC-kanal där renderer kan fråga main om app-info
ipcMain.handle('app:getVersion', () => app.getVersion());

// ---------- IPC: Autentisering ----------
ipcMain.handle('auth:login', async (_evt, payload) => {
  try {
    const { username, password, clientId } = payload || {};
    if (!ppClient && PPClient) ppClient = new PPClient();
    if (!ppClient) throw new Error('pp-client saknas');
    const result = await ppClient.login(username, password, clientId || null);
    if (!ppClient.digestAuth?.ha1 || !ppClient.digestAuth?.clientId) {
      return { ok: false, error: 'Inloggning misslyckades — kontrollera clientId och credentials.' };
    }
    if (authStorage && ppClient.digestAuth) {
      const state = typeof ppClient.digestAuth.toJSON === 'function'
        ? ppClient.digestAuth.toJSON()
        : { ...ppClient.digestAuth };
      await authStorage.saveState(state);
      console.log('[main] Sparade digest-state för', state.username);
    }
    return { ok: true, user: result && result.user ? result.user : result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:setDigestManual', async (_evt, json) => {
  try {
    if (!PPClient || !DigestAuth) throw new Error('pp-client saknas');
    const digestAuth = new DigestAuth(json);
    if (typeof digestAuth.fromJSON === 'function') digestAuth.fromJSON(json);
    ppClient = new PPClient({ digestAuth });
    if (authStorage) {
      const state = typeof digestAuth.toJSON === 'function' ? digestAuth.toJSON() : json;
      await authStorage.saveState(state);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:logout', async () => {
  try {
    if (authStorage) await authStorage.clearState();
    ppClient = PPClient ? new PPClient() : null;
    setImmediate(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(path.join(__dirname, 'src', 'login.html'));
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:status', async () => {
  const isAuthed = !!(ppClient && ppClient.digestAuth && ppClient.digestAuth.ha1);
  let user = null;
  try {
    if (isAuthed) {
      // Försök hämta aktuell user-info från API
      if (typeof ppClient.me === 'function') {
        user = await ppClient.me();
      }
      // Fallback: minimal info från digest-state
      if (!user && ppClient.digestAuth) {
        user = {
          UserName: ppClient.digestAuth.username,
          FullName: ppClient.digestAuth.username,
          ClientId: ppClient.digestAuth.clientId,
          Role: ppClient.digestAuth.role
        };
      }
    }
  } catch (e) {
    console.warn('[main] auth:status me() misslyckades:', e.message);
    if (ppClient?.digestAuth) {
      user = { UserName: ppClient.digestAuth.username };
    }
  }
  return { authenticated: isAuthed, user };
});

// Triggrar laddning av huvudvyn efter lyckad inloggning
ipcMain.handle('auth:success', async () => {
  if (mainWindow) {
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  }
  return { ok: true };
});

// ---------- IPC: Data (Projektportalen) ----------
// Sparar state efter varje anrop så auto-korrigerad HA1 persisteras.
// DEBOUNCED: första anropet schemalägger en sparning 800ms senare; om fler
// anrop sker inom fönstret skjuts sparningen fram. Detta tar bort en stor
// flaskhals där parallella API-anrop blockerades av disk-IO.
async function persistStateNow() {
  try {
    if (authStorage && ppClient?.digestAuth?.ha1 && ppClient.digestAuth.clientId) {
      const state = typeof ppClient.digestAuth.toJSON === 'function'
        ? ppClient.digestAuth.toJSON()
        : { ...ppClient.digestAuth };
      await authStorage.saveState(state);
    }
  } catch (_) { /* silent */ }
}
let __persistTimer = null;
function persistStateIfPossible() {
  // Non-blocking debounced schedule — caller kan använda utan await
  if (__persistTimer) clearTimeout(__persistTimer);
  __persistTimer = setTimeout(() => {
    __persistTimer = null;
    persistStateNow();
  }, 800);
}
// Säkerställ persist vid app-quit så vi inte tappar state
if (typeof app !== 'undefined' && app?.on) {
  app.on('before-quit', async (e) => {
    if (__persistTimer) {
      clearTimeout(__persistTimer);
      __persistTimer = null;
      try { await persistStateNow(); } catch (_) {}
    }
  });
}

function requireClient() {
  if (!ppClient) throw new Error('Ingen pp-client initierad (logga in först)');
  return ppClient;
}

ipcMain.handle('api:serviceOrders:list', async (_evt, args) => {
  try {
    const c = requireClient();
    const data = await c.listServiceOrders(args);
    persistStateIfPossible();
    return { ok: true, data };
  } catch (err) {
    persistStateIfPossible();
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('api:serviceOrders:get', async (_evt, id) => {
  try {
    const c = requireClient();
    const data = await c.getServiceOrder(id);
    persistStateIfPossible();
    return { ok: true, data };
  } catch (err) {
    persistStateIfPossible();
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('api:customers:list', async (_evt, args) => {
  try {
    const c = requireClient();
    const data = await c.listCustomers(args);
    persistStateIfPossible();
    return { ok: true, data };
  } catch (err) {
    persistStateIfPossible();
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('api:time:week', async (_evt, args) => {
  const t0 = Date.now();
  try {
    const c = requireClient();
    const data = await c.getTimeWeek(args);
    console.log(`[main-timing] api:time:week ${args?.startDate}: ${Date.now()-t0}ms`);
    persistStateIfPossible();
    return { ok: true, data };
  } catch (err) {
    console.log(`[main-timing] api:time:week ${args?.startDate}: ${Date.now()-t0}ms FEL`);
    persistStateIfPossible();
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('api:time:create', async (_evt, args) => {
  try {
    const c = requireClient();
    const data = await c.createTimeEntry(args);
    persistStateIfPossible();
    return { ok: true, data };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('api:time:update', async (_evt, { id, patch }) => {
  try {
    const c = requireClient();
    const data = await c.updateTimeEntry(id, patch);
    return { ok: true, data };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('api:time:delete', async (_evt, id) => {
  try {
    const c = requireClient();
    const data = await c.deleteTimeEntry(id);
    return { ok: true, data };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('api:serviceOrders:create', async (_evt, args) => {
  try {
    const c = requireClient();
    const data = await c.createServiceOrder(args);
    return { ok: true, data };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('api:serviceOrders:update', async (_evt, { id, patch }) => {
  try {
    const c = requireClient();
    const data = await c.updateServiceOrder(id, patch);
    return { ok: true, data };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC: Material ----------
// ---------- IPC: PDF-export ----------
ipcMain.handle('app:printOrderPdf', async (_evt, { html, defaultFileName }) => {
  const { dialog, BrowserWindow: BW } = require('electron');
  try {
    // Välj filnamn
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Spara order som PDF',
      defaultPath: defaultFileName || 'order.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'Avbrutet' };
    // Skapa osynligt fönster och läs HTML
    const win = new BW({ show: false, webPreferences: { offscreen: false } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const buf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    require('fs').writeFileSync(result.filePath, buf);
    win.close();
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC: Fakturor (kund + leverantör) + PDF ----------
ipcMain.handle('api:invoices:customer', async (_evt, { projectId, args }) => {
  try { return { ok: true, data: await requireClient().getOrderCustomerInvoices(projectId, args) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('api:invoices:supplier', async (_evt, { projectId, args }) => {
  try { return { ok: true, data: await requireClient().getOrderSupplierInvoices(projectId, args) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('api:invoices:pdf', async (_evt, { invoiceId, type, meta }) => {
  try {
    const r = await requireClient().getInvoicePdf(invoiceId, type, meta);
    const b64 = r.buffer.toString('base64');
    const dataUrl = `data:${r.contentType || 'application/pdf'};base64,${b64}`;
    return { ok: true, dataUrl, size: r.buffer.length, fileName: r.fileName || null };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('api:materials:list', async (_evt, projectId, opts) => { try { return { ok: true, data: await requireClient().getOrderMaterials(projectId, opts || {}) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:orders:timeEntries', async (_evt, projectId) => { try { return { ok: true, data: await requireClient().getOrderTimeEntries(projectId) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:materials:create', async (_evt, args) => { try { return { ok: true, data: await requireClient().addOrderMaterial(args) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:materials:update', async (_evt, { id, patch }) => { try { return { ok: true, data: await requireClient().updateOrderMaterial(id, patch) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:materials:delete', async (_evt, id) => { try { return { ok: true, data: await requireClient().deleteOrderMaterial(id) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:articles:search', async (_evt, args) => { try { return { ok: true, data: await requireClient().searchArticlesBroad(args || {}) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:articles:snabbval', async (_evt, args) => { try { return { ok: true, data: await requireClient().searchArticlesSnabbval(args || {}) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:articles:groups', async () => { try { return { ok: true, data: await requireClient().getArticleGroups() }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:articles:salesprice', async (_evt, { articleId, projectId }) => { try { return { ok: true, data: await requireClient().getArticleSalesPrice(articleId, projectId) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('api:timeTypes:list', async () => { try { return { ok: true, data: await requireClient().getTimeTypes() }; } catch (err) { return { ok: false, error: err.message }; } });

// Kör alla counter-endpoints parallellt och returnera en bundle
ipcMain.handle('api:dashboard:counters', async () => {
  try {
    const c = requireClient();
    const tasks = {
      openServiceOrders: c.countOpenServiceOrders
        ? c.countOpenServiceOrders()
        : (c.getOpenServiceOrdersCount ? c.getOpenServiceOrdersCount() : null),
      activeCustomers: c.countActiveCustomers
        ? c.countActiveCustomers()
        : (c.getActiveCustomersCount ? c.getActiveCustomersCount() : null),
      weekHours: c.getWeekHours ? c.getWeekHours() : null,
      pendingInvoices: c.countPendingInvoices
        ? c.countPendingInvoices()
        : (c.getPendingInvoicesCount ? c.getPendingInvoicesCount() : null)
    };
    const keys = Object.keys(tasks);
    const results = await Promise.allSettled(keys.map((k) => tasks[k]));
    const data = {};
    keys.forEach((k, i) => {
      data[k] = results[i].status === 'fulfilled' ? results[i].value : null;
    });
    persistStateIfPossible();
    return { ok: true, data };
  } catch (err) {
    persistStateIfPossible();
    return { ok: false, error: err.message };
  }
});
