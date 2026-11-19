const { contextBridge, ipcRenderer } = require('electron');

// Exponera en smal, säker API-yta mot renderern.
// Behåller bakåtkompatibla metoder (getVersion + orders-stubs) och
// utökar med nya metoder för auth och Projektportalens API.
contextBridge.exposeInMainWorld('api', {
  // ---------- Existerande (bakåtkompat) ----------
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Stubbar för framtida API-anrop. Byt ut mot riktiga fetch-anrop när API:et finns.
  orders: {
    list: async (params) => {
      // TODO: ersätt med fetch mot ditt API
      // return fetch('https://ditt-api/orders?...').then(r => r.json())
      return null;
    },
    get: async (id) => null,
    create: async (order) => null,
    update: async (id, patch) => null
  },

  // ---------- Auth ----------
  login: (username, password, clientId) =>
    ipcRenderer.invoke('auth:login', { username, password, clientId }),
  setDigestManually: (json) => ipcRenderer.invoke('auth:setDigestManual', json),
  logout: () => ipcRenderer.invoke('auth:logout'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  // Triggrar main att ladda index.html efter lyckad inloggning
  notifyAuthSuccess: () => ipcRenderer.invoke('auth:success'),

  // ---------- Data (Projektportalen) ----------
  serviceOrders: {
    list: (args) => ipcRenderer.invoke('api:serviceOrders:list', args),
    get: (id) => ipcRenderer.invoke('api:serviceOrders:get', id),
    create: (args) => ipcRenderer.invoke('api:serviceOrders:create', args),
    update: (id, patch) => ipcRenderer.invoke('api:serviceOrders:update', { id, patch }),
    timeEntries: (projectId) => ipcRenderer.invoke('api:orders:timeEntries', projectId)
  },
  customers: {
    list: (args) => ipcRenderer.invoke('api:customers:list', args)
  },
  time: {
    getWeek: (args) => ipcRenderer.invoke('api:time:week', args),
    create: (args) => ipcRenderer.invoke('api:time:create', args),
    update: (id, patch) => ipcRenderer.invoke('api:time:update', { id, patch }),
    delete: (id) => ipcRenderer.invoke('api:time:delete', id)
  },
  materials: {
    list: (projectId, opts) => ipcRenderer.invoke('api:materials:list', projectId, opts),
    create: (args) => ipcRenderer.invoke('api:materials:create', args),
    update: (id, patch) => ipcRenderer.invoke('api:materials:update', { id, patch }),
    delete: (id) => ipcRenderer.invoke('api:materials:delete', id)
  },
  articles: {
    search: (args) => ipcRenderer.invoke('api:articles:search', args),
    snabbval: (args) => ipcRenderer.invoke('api:articles:snabbval', args),
    groups: () => ipcRenderer.invoke('api:articles:groups'),
    salesprice: (articleId, projectId) => ipcRenderer.invoke('api:articles:salesprice', { articleId, projectId })
  },
  timeTypes: {
    list: () => ipcRenderer.invoke('api:timeTypes:list')
  },
  invoices: {
    customer: (projectId, args) => ipcRenderer.invoke('api:invoices:customer', { projectId, args }),
    supplier: (projectId, args) => ipcRenderer.invoke('api:invoices:supplier', { projectId, args }),
    pdf: (invoiceId, type, meta) => ipcRenderer.invoke('api:invoices:pdf', { invoiceId, type, meta })
  },
  dashboard: {
    counters: () => ipcRenderer.invoke('api:dashboard:counters')
  },

  // ---------- PDF-export ----------
  printOrderPdf: (args) => ipcRenderer.invoke('app:printOrderPdf', args)
});
