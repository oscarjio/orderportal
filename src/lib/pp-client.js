'use strict';

/**
 * API-wrapper för Projektportalen (https://api-app3.projektportalen.se/api).
 *
 * Hanterar HTTP Digest Authentication via DigestAuth-instansen och exponerar
 * högnivåmetoder för de vanligaste endpoints som Electron-klienten behöver.
 *
 * Använder inbyggda Node 18+ `fetch` (Electron 30 kör Node 20).
 */

const { DigestAuth } = require('./digest-auth');

const DEFAULT_BASE_URL = 'https://api-app3.projektportalen.se/api';

/**
 * Kastas när servern svarar med 401 även efter en retry med ny challenge.
 */
class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized', { status = 401, body = null } = {}) {
    super(message);
    this.name = 'UnauthorizedError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Kastas vid nätverksfel eller icke-2xx svar som inte är 401.
 */
class NetworkError extends Error {
  constructor(message, { status = 0, body = null, cause = null } = {}) {
    super(message);
    this.name = 'NetworkError';
    this.status = status;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

/**
 * Serialisera ett query-objekt till en URL-encoded sträng (utan ledande "?").
 * Undefined/null-värden hoppas över. Booleans serialiseras som "true"/"false".
 * @param {Object} [query]
 * @returns {string}
 */
function buildQueryString(query) {
  if (!query || typeof query !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}

class ProjektportalenClient {
  /**
   * @param {Object} [opts]
   * @param {DigestAuth} [opts.digestAuth]
   * @param {string} [opts.baseUrl]
   * @param {typeof fetch} [opts.fetch]  Injicerbar fetch (för tester)
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.digestAuth = opts.digestAuth || new DigestAuth();
    this._fetch = opts.fetch || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new Error('fetch is not available — requires Node 18+ or Electron with Node 20');
    }
  }

  /**
   * Intern request-hjälpare. Hanterar Digest-auth, retry på 401 och JSON.
   * @param {string} method
   * @param {string} path           path under baseUrl (ska börja med "/")
   * @param {Object} [opts]
   * @param {any}    [opts.body]    JSON-serialiseras om objekt
   * @param {Object} [opts.query]   serialiseras till query-string
   * @param {boolean}[opts.skipAuth] hoppa över Authorization-header (för första /authenticate-pingen)
   * @returns {Promise<any|null>}
   * @private
   */
  async _request(method, path, { body, query, skipAuth = false } = {}) {
    const qs = buildQueryString(query);
    const pathWithQuery = qs ? `${path}?${qs}` : path;
    const url = `${this.baseUrl}${pathWithQuery}`;
    // URI som används i Authorization: full path inkl /api-prefix men EXKL
    // query-sträng (verifierat: GET med query i URI ger 401, utan funkar).
    const baseUrlObj = new URL(this.baseUrl);
    const authUri = `${baseUrlObj.pathname}${path}`.replace(/\/\//g, '/');

    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
      // Projektportalen-specifika headers som den riktiga appen skickar
      lang: 'sv',
      languageId: '1',
      'client-timezone-offset': String(-new Date().getTimezoneOffset())
    };
    let payload;
    if (body !== undefined && body !== null) {
      if (typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      } else {
        payload = body;
      }
    }
    if (method === 'POST' && (body === undefined || body === null)) {
      headers['Content-Length'] = '0';
    }

    // Bygg auth-header om vi har state
    const addAuth = () => {
      if (skipAuth) return;
      try {
        headers.Authorization = this.digestAuth.buildAuthorizationHeader(method, authUri);
      } catch (_err) {
        // Ingen state än — låt servern svara 401, då parsar vi challengen.
      }
    };
    addAuth();

    // DIAGNOSTIK: logga digest-state utan secrets
    if (!skipAuth && this.digestAuth) {
      const d = this.digestAuth;
      console.log(`[pp-client] → ${method} ${pathWithQuery}  digest={user=${d.username}, clientId=${d.clientId}, nc=${d._nc}, ha1Len=${d.ha1?.length||0}, nonceLen=${d.nonce?.length||0}}`);
    }

    let response;
    try {
      response = await this._fetch(url, { method, headers, body: payload });
    } catch (err) {
      throw new NetworkError(`fetch failed: ${err && err.message ? err.message : err}`, { cause: err });
    }

    // 401 eller 204 med WWW-Authenticate → parsa challenge och försök en gång till
    if (!skipAuth && response.status === 401) {
      const chal = response.headers.get('www-authenticate');
      if (chal) {
        this.digestAuth.setChallenge(chal);
        // Rensa auth-header och bygg ny
        delete headers.Authorization;
        try {
          headers.Authorization = this.digestAuth.buildAuthorizationHeader(method, authUri);
        } catch (err) {
          throw new UnauthorizedError('Digest state incomplete after challenge', { status: 401 });
        }
        try {
          response = await this._fetch(url, { method, headers, body: payload });
        } catch (err) {
          throw new NetworkError(`fetch failed on retry: ${err && err.message ? err.message : err}`, { cause: err });
        }
        if (response.status === 401) {
          const txt = await safeReadText(response);
          throw new UnauthorizedError('Unauthorized after digest retry', { status: 401, body: txt });
        }
      } else {
        const txt = await safeReadText(response);
        console.warn(`[pp-client] ${method} ${pathWithQuery} -> 401 (ingen challenge): ${(txt||'').substring(0,200)}`);

        // Automatisk nonce-refresh. Parallella anrop koalesceras på samma
        // refresh-promise så alla väntar in ett enda /authenticate-anrop.
        const nonceFailed = /nonce.*(validate|fail|expire|invalid)/i.test(txt || '');
        if (nonceFailed) {
          if (!this._nonceRefreshPromise) {
            console.log('[pp-client] Nonce förfallen — refreshar via /authenticate');
            this._nonceRefreshPromise = (async () => {
              try {
                const authResp = await this._fetch(`${this.baseUrl}/authenticate`, {
                  method: 'GET',
                  headers: { Accept: 'application/json' }
                });
                const newChal = authResp.headers.get('www-authenticate');
                if (!newChal) throw new Error('/authenticate returnerade inget challenge-header');
                this.digestAuth.setChallenge(newChal);
              } finally {
                // Rensa flaggan så framtida nonce-förfall kan trigga ny refresh
                setTimeout(() => { this._nonceRefreshPromise = null; }, 100);
              }
            })();
          }

          try {
            await this._nonceRefreshPromise;
            // Bygg ny Authorization och retry:a originalanropet
            delete headers.Authorization;
            headers.Authorization = this.digestAuth.buildAuthorizationHeader(method, authUri);
            const retryResp = await this._fetch(url, { method, headers, body: payload });
            if (retryResp.status === 204) return null;
            if (retryResp.ok) {
              const ctype = retryResp.headers.get('content-type') || '';
              if (!ctype.includes('application/json')) {
                const t = await safeReadText(retryResp);
                if (!t) return null;
                try { return JSON.parse(t); } catch { return t; }
              }
              try { return await retryResp.json(); } catch { return null; }
            }
            const retryTxt = await safeReadText(retryResp);
            console.warn(`[pp-client] Retry efter nonce-refresh fallerade: HTTP ${retryResp.status} ${(retryTxt||'').substring(0,200)}`);
            throw new NetworkError(`HTTP ${retryResp.status}: ${(retryTxt||'').substring(0,200)}`, { status: retryResp.status, body: retryTxt });
          } catch (e) {
            if (e instanceof NetworkError) throw e;
            throw new UnauthorizedError('Unauthorized efter nonce-refresh: ' + e.message, { status: 401, body: txt });
          }
        }

        throw new UnauthorizedError('Unauthorized (no challenge header)', { status: 401, body: txt });
      }
    }

    if (response.status === 204) return null;

    if (response.status >= 400) {
      const txt = await safeReadText(response);
      if (response.status === 401) {
        throw new UnauthorizedError('Unauthorized', { status: 401, body: txt });
      }
      // Inkludera första 400 tecken av body i felmeddelandet så vi ser
      // vad servern klagar på (t.ex. "Required field X missing").
      const preview = (txt || '').replace(/\s+/g, ' ').substring(0, 400);
      const msg = preview ? `HTTP ${response.status}: ${preview}` : `HTTP ${response.status}`;
      console.warn(`[pp-client] ${method} ${pathWithQuery} -> ${msg}`);
      throw new NetworkError(msg, { status: response.status, body: txt });
    }

    // 2xx — parse JSON om möjligt
    const ctype = response.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      const txt = await safeReadText(response);
      if (!txt) return null;
      try {
        return JSON.parse(txt);
      } catch {
        return txt;
      }
    }
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Autentisering
  // ---------------------------------------------------------------------------

  /**
   * Logga in. Gör först en GET /authenticate för att få challenge (401 + WWW-Authenticate),
   * sätter credentials och gör sedan om anropet med beräknad response.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<any>}
   */
  async login(username, password, clientId = null) {
    const crypto = require('crypto');
    // Servern accepterar olika hash-varianter för password-query-paramet.
    // Vi testar i ordning: SHA256(password), SHA256(username:realm:password)=HA1, plaintext.
    const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const passwordHash = h(password);
    const passwordHA1 = h(`${username}:ProjectPortal:${password}`);
    const pwCandidates = [
      { label: 'HA1 (user:realm:pw)', value: passwordHA1 },
      { label: 'SHA256(password)', value: passwordHash },
      { label: 'plaintext', value: password }
    ];

    // Steg 1: Hämta klient-lista. Prova flera password-former.
    if (!clientId) {
      for (const cand of pwCandidates) {
        try {
          const q = new URLSearchParams({ username, password: cand.value }).toString();
          const r = await this._fetch(`${this.baseUrl}/users-client?${q}`, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Origin: 'https://app3.projektportalen.se',
              Referer: 'https://app3.projektportalen.se/'
            }
          });
          if (r.ok) {
            const data = await r.json().catch(() => null);
            const shape = Array.isArray(data) ? `array[${data.length}]` : (data && typeof data === 'object' ? `keys:${Object.keys(data).join(',')}` : typeof data);
            console.log(`[pp-client] /users-client (${cand.label}) ->`, shape);
            if (Array.isArray(data) && data.length) {
              clientId = data[0].ClientId ?? data[0].Id ?? data[0].clientId;
              if (clientId) break;
            } else if (data && typeof data === 'object') {
              clientId = data.ClientId ?? data.clientId ?? data.DefaultClientId
                       ?? data.Clients?.[0]?.ClientId
                       ?? data.clients?.[0]?.ClientId;
              if (clientId) break;
            }
          } else {
            console.warn(`[pp-client] /users-client (${cand.label}) status ${r.status}`);
          }
        } catch (e) {
          console.warn(`[pp-client] /users-client (${cand.label}) misslyckades:`, e.message);
        }
      }
      if (clientId) {
        console.log('[pp-client] Detekterad clientId:', clientId);
      }
    }

    if (!clientId) {
      throw new Error('Kunde inte hitta clientId automatiskt. Kontrollera användarnamn/lösenord eller ange clientId manuellt via Avancerat-fliken.');
    }

    // Steg 2: GET /authenticate för digest challenge (401 + WWW-Authenticate)
    const url = `${this.baseUrl}/authenticate`;
    let response;
    try {
      response = await this._fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new NetworkError(`login fetch failed: ${err && err.message ? err.message : err}`, { cause: err });
    }

    if (response.status === 401 || response.status === 204) {
      const chal = response.headers.get('www-authenticate');
      if (!chal) throw new UnauthorizedError('No WWW-Authenticate header on /authenticate');
      this.digestAuth.setChallenge(chal);
    } else if (response.status >= 400) {
      const txt = await safeReadText(response);
      throw new NetworkError(`authenticate ping failed: HTTP ${response.status}`, { status: response.status, body: txt });
    }

    // Sätt credentials och beräkna HA1 (kräver realm från challenge)
    this.digestAuth.setCredentials(username, password);

    // Sätt clientId NU så den ingår i response-hashen
    if (clientId !== null && clientId !== undefined) {
      this.digestAuth.clientId = clientId;
    }

    // Steg 3: /authenticate är tillräckligt för att validera credentials.
    //         /login-endpointet är oklart och returnerar 401 utan challenge —
    //         vi skippar det eftersom digest-auth redan fungerar utan.
    const result = await this._request('GET', '/authenticate');
    console.log('[pp-client] Login auth OK');

    // Logga respons-strukturen (top-level keys) så vi ser var clientId finns
    if (result && typeof result === 'object') {
      const keys = Array.isArray(result) ? `array[${result.length}]` : Object.keys(result);
      console.log('[pp-client] /authenticate response keys:', keys);
    } else {
      console.log('[pp-client] /authenticate response type:', typeof result, 'value:', result);
    }

    // Extrahera clientId och role från response på alla rimliga platser
    const extractClientId = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const direct = obj.ClientId ?? obj.clientId ?? obj.CurrentClientId;
      if (direct !== undefined && direct !== null) return direct;
      if (obj.Client?.Id) return obj.Client.Id;
      if (obj.Client?.ClientId) return obj.Client.ClientId;
      if (obj.User?.ClientId) return obj.User.ClientId;
      if (obj.user?.clientId) return obj.user.clientId;
      if (obj.data?.ClientId) return obj.data.ClientId;
      // Sök djupare — upp till 2 nivåer
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const inner = v.ClientId ?? v.clientId;
          if (inner) return inner;
        }
      }
      return null;
    };
    if (result && typeof result === 'object') {
      const cid = extractClientId(result);
      const role = result.RoleCode ?? result.roleCode ?? result.Role ?? result.RoleName ?? result.User?.RoleCode;
      if (cid !== undefined && cid !== null) {
        this.digestAuth.clientId = cid;
        console.log('[pp-client] Satte digest.clientId =', cid);
      } else {
        console.warn('[pp-client] Kunde INTE hitta clientId i /authenticate response');
      }
      if (role) this.digestAuth.role = role;
    }

    return result;
  }

  /**
   * Hämta inloggad användares info för nuvarande klient.
   * @returns {Promise<any>}
   */
  async me() {
    // Returnerar minimal user-info från digest-state. Det finns inget
    // dedikerat /me-endpoint som fungerar utan extra context.
    return {
      UserName: this.digestAuth.username,
      FullName: this.digestAuth.username,
      ClientId: this.digestAuth.clientId,
      Role: this.digestAuth.role
    };
  }

  /**
   * Rensa all auth-state (logout lokalt — servern har ingen session att invalidera).
   * @returns {Promise<void>}
   */
  async logout() {
    this.digestAuth.clear();
  }

  // ---------------------------------------------------------------------------
  // Dashboard / översikt
  // ---------------------------------------------------------------------------

  /**
   * Hämta räknare för dashboard (antal i varje kategori).
   * @returns {Promise<any>}
   */
  async getDashboardCounters() {
    return this._request('GET', '/getAllQuantityDisplayedInCounter');
  }

  /**
   * Antal projekt för inloggad klient.
   * @returns {Promise<any>}
   */
  async getProjectsAmount() {
    return this._request('GET', '/clients/projects/amount');
  }

  /**
   * Totalt rapporterade timmar för klienten.
   * @returns {Promise<any>}
   */
  async getReportedHoursTotal() {
    return this._request('GET', '/clients/reported-hours/total');
  }

  /**
   * Hämta klient (företag) på id.
   * @param {string|number} clientId
   * @returns {Promise<any>}
   */
  async getClient(clientId) {
    return this._request('GET', `/clients/${encodeURIComponent(clientId)}`);
  }

  /**
   * Lista favoritmarkerade projekt.
   * @returns {Promise<any>}
   */
  async getFavoriteProjects() {
    return this._request('GET', '/projects/favorite');
  }

  // ---------------------------------------------------------------------------
  // Serviceorder / projekt
  // ---------------------------------------------------------------------------

  /**
   * Lista serviceorder med paginering och sortering.
   * @param {Object} [opts]
   * @param {number} [opts.tabIndex=1]
   * @param {number} [opts.pageIndex=1]
   * @param {number} [opts.pageSize=50]
   * @param {string} [opts.keyword='']
   * @param {string} [opts.orderBy='Numbers']
   * @param {boolean}[opts.isAsc=true]
   * @returns {Promise<any>}
   */
  /**
   * Lista serviceordrar.
   * Body-schema: ag-grid server-side-pagering (observerat från browser):
   *   { SortModel, StartRow, EndRow, FilterModel, TabIndex, Keyword }
   *
   * TabIndex-mappning (observerat i UI):
   *   1 = Favoriter, 2 = Pågående, 3 = Väntande/Stoppade, 4 = Utförda,
   *   5 = Fakturera, 6 = Avslutade, 8 = Alla
   */
  async listServiceOrders({
    tabIndex = 8,       // default "Alla"
    startRow = 0,
    endRow = 50,
    keyword = '',
    sortModel = [],
    filterModel = {},
  } = {}) {
    const body = {
      SortModel: sortModel,
      StartRow: startRow,
      EndRow: endRow,
      FilterModel: filterModel,
      TabIndex: tabIndex,
      Keyword: keyword,
    };
    return this._request('POST', '/service-order/list', { body });
  }

  /**
   * Hämta en komplett serviceorder. Fannar ut tre parallella anrop:
   * project, project-header och amounts — och returnerar sammanslaget objekt.
   * @param {string|number} id
   * @returns {Promise<{project:any, header:any, amounts:any}>}
   */
  async getServiceOrder(id) {
    const encoded = encodeURIComponent(id);
    const [project, header, amounts] = await Promise.all([
      this._request('GET', `/projects/${encoded}`),
      this._request('GET', `/projects-header/${encoded}`),
      this._request('GET', `/service-orders/${encoded}/amounts`),
    ]);
    return { project, header, amounts };
  }

  /**
   * Hämta ett projekt på id.
   * @param {string|number} id
   * @returns {Promise<any>}
   */
  async getProject(id) {
    return this._request('GET', `/projects/${encodeURIComponent(id)}`);
  }

  /**
   * Slå upp ProjectId från ett ProjectNumber (eller returnera keyword
   * direkt om ingen match hittas). Används av createServiceOrder /
   * createTimeEntry för att översätta UI-inskrivna projektnummer till IDn.
   * @param {string|number} projektNumber
   * @returns {Promise<string|number|null>}
   * @private
   */
  async _resolveProjectId(projektNumber) {
    if (projektNumber === undefined || projektNumber === null || projektNumber === '') return null;
    const keyword = String(projektNumber).trim();
    try {
      const res = await this._request('POST', '/service-order/list', {
        body: {
          SortModel: [],
          StartRow: 0,
          EndRow: 1,
          FilterModel: {},
          TabIndex: 8,
          Keyword: keyword,
        },
      });
      const rows = Array.isArray(res)
        ? res
        : (res?.Rows || res?.rows || res?.Data || res?.data || []);
      if (rows.length > 0) {
        const first = rows[0];
        return first.ProjectId ?? first.projectId ?? first.Id ?? first.id ?? null;
      }
    } catch (_err) {
      // Fall tillbaka på keyword som-är om sökning misslyckas.
    }
    return keyword;
  }

  /**
   * Skapar ny service-order ("Ny order" i Entré-stil).
   * UI-fält: Projekt, Kundnummer, Ordertyp, Leveransadress, Beskrivning.
   *
   * @param {Object} args
   * @param {string|number} [args.projektNumber] Parent-projektnummer (optional)
   * @param {string|number} args.kundnummer      Kundnummer eller kundnamn
   * @param {string|number} [args.ordertyp]      10=Arbetsorder default
   * @param {string} [args.leveransadress]
   * @param {string} args.beskrivning            Blir ProjectName
   * @returns {Promise<any>}
   */
  async createServiceOrder({ projektNumber, kundnummer, ordertyp, leveransadress, beskrivning }) {
    const customerId = await this.findCustomerByNumber(kundnummer);
    const parentProjectId = projektNumber
      ? await this._resolveProjectId(projektNumber)
      : null;
    const body = {
      CustomerId: customerId,
      ProjectType: Number(ordertyp) || 10,
      Address: leveransadress || '',
      ProjectName: beskrivning || '',
      ClientId: this.digestAuth.clientId,
      ParentProjectId: parentProjectId,
    };
    return this._request('POST', '/service-order', { body });
  }

  /**
   * Uppdaterar befintlig service-order. Patch får innehålla valfria fält
   * (ProjectName, Address, StatusName, Price, ...). ClientId och ProjectId
   * skickas alltid för identifikation.
   *
   * Försöker PUT /service-order/{id} först; faller tillbaka på
   * PUT /projects/{id} om första svarar 404.
   *
   * @param {string|number} projectId
   * @param {Object} patch
   * @returns {Promise<any>}
   */
  async updateServiceOrder(projectId, patch = {}) {
    if (projectId === undefined || projectId === null || projectId === '') {
      throw new Error('updateServiceOrder: projectId krävs');
    }
    const diffBody = { ...patch };
    for (const k of Object.keys(diffBody)) {
      if (diffBody[k] === undefined) delete diffBody[k];
    }
    diffBody.ClientId = this.digestAuth.clientId;
    diffBody.ProjectId = projectId;

    const encoded = encodeURIComponent(projectId);
    try {
      return await this._request('PUT', `/service-order/${encoded}`, { body: diffBody });
    } catch (err) {
      if (err && err.status === 404) {
        return this._request('PUT', `/projects/${encoded}`, { body: diffBody });
      }
      throw err;
    }
  }

  /**
   * Hitta CustomerId från kundnummer (eller kundnamn) via /customers-paging.
   * Om kundnummer är icke-numeriskt söker vi även på namn (fallback via tabIndex 1).
   * Kastar Error om ingen match hittas.
   *
   * @param {string|number} kundnummer
   * @returns {Promise<string|number>}
   */
  async findCustomerByNumber(kundnummer) {
    if (kundnummer === undefined || kundnummer === null || kundnummer === '') {
      throw new Error('findCustomerByNumber: kundnummer krävs');
    }
    const keyword = String(kundnummer).trim();
    const isNumeric = /^\d+$/.test(keyword);

    const searchOnce = async (kw, tabIndex) => {
      const query = {
        isAsc: true,
        keyword: kw,
        orderByPropertyName: 'Name',
        pageIndex: 1,
        pageSize: 1,
        tabIndex,
      };
      const res = await this._request('GET', '/customers-paging/', { query });
      const rows = Array.isArray(res)
        ? res
        : (res?.Rows || res?.rows || res?.Data || res?.data || res?.Items || []);
      if (rows.length > 0) {
        const first = rows[0];
        return first.CustomerId ?? first.customerId ?? first.Id ?? first.id ?? null;
      }
      return null;
    };

    // Primär sökning enligt spec: tabIndex=3
    let id = await searchOnce(keyword, 3);
    if (id) return id;

    // Icke-numeriskt -> försök även på namn via tabIndex=1 (default "alla")
    if (!isNumeric) {
      id = await searchOnce(keyword, 1);
      if (id) return id;
    }

    throw new Error('Kund inte hittad: ' + kundnummer);
  }

  // ---------------------------------------------------------------------------
  // Kunder
  // ---------------------------------------------------------------------------

  /**
   * Lista kunder med paginering.
   * @param {Object} [opts]
   * @param {number} [opts.tabIndex=1]
   * @param {number} [opts.pageIndex=1]
   * @param {number} [opts.pageSize=50]
   * @param {string} [opts.keyword='']
   * @param {string} [opts.orderBy='Name']
   * @param {boolean}[opts.isAsc=true]
   * @returns {Promise<any>}
   */
  async listCustomers({
    tabIndex = 1,
    pageIndex = 1,
    pageSize = 50,
    keyword = '',
    orderBy = 'Name',
    isAsc = true,
  } = {}) {
    const query = {
      isAsc,
      keyword,
      orderByPropertyName: orderBy,
      pageIndex,
      pageSize,
      tabIndex,
    };
    return this._request('GET', '/customers-paging/', { query });
  }

  // ---------------------------------------------------------------------------
  // Fakturor
  // ---------------------------------------------------------------------------

  /**
   * Lista kundfakturor med paginering.
   * @param {Object} [opts]
   * @param {number} [opts.tabIndex=1]
   * @param {number} [opts.pageIndex=1]
   * @param {number} [opts.pageSize=50]
   * @param {string} [opts.keyword='']
   * @param {string} [opts.orderBy='Numbers']
   * @param {boolean}[opts.isAsc=true]
   * @returns {Promise<any>}
   */
  async listInvoices({
    tabIndex = 1,
    pageIndex = 1,
    pageSize = 50,
    keyword = '',
    orderBy = 'Numbers',
    isAsc = true,
  } = {}) {
    const query = {
      isAsc,
      keyword,
      orderByPropertyName: orderBy,
      pageIndex,
      pageSize,
      tabIndex,
    };
    return this._request('GET', '/customerInvoices-paging/', { query });
  }

  // ---------------------------------------------------------------------------
  // Faktura-listor per order (ag-grid server-side pagering)
  // ---------------------------------------------------------------------------

  /**
   * Lista kundfakturor kopplade till en order/projekt.
   * Endpoint: POST /project/project-invoices
   * Body-schema är ag-grid server-side med ProjectId + Keyword.
   */
  async getOrderCustomerInvoices(projectId, { startRow = 0, endRow = 50, keyword = '' } = {}) {
    const body = {
      startRow,
      endRow,
      rowGroupCols: [],
      valueCols: [],
      pivotCols: [],
      pivotMode: false,
      groupKeys: [],
      filterModel: {},
      sortModel: [],
      ProjectId: String(projectId),
      Keyword: keyword,
    };
    return this._request('POST', '/project/project-invoices', { body });
  }

  /**
   * Lista leverantörsfakturor kopplade till en order/projekt.
   * Endpoint: POST /project/project-supplier-invoices
   */
  async getOrderSupplierInvoices(projectId, { startRow = 0, endRow = 50, keyword = '' } = {}) {
    const body = {
      startRow,
      endRow,
      rowGroupCols: [],
      valueCols: [],
      pivotCols: [],
      pivotMode: false,
      groupKeys: [],
      filterModel: {},
      sortModel: [],
      ProjectId: String(projectId),
      Keyword: keyword,
    };
    return this._request('POST', '/project/project-supplier-invoices', { body });
  }

  /**
   * Hämta faktura-PDF som Buffer.
   *
   * Strategi (verifierat via Chrome-capture av webb-appen):
   *   1. Fortnox-integrerade lev-fakturor: POST /integrations/clients/fortnox/supplierinvoices/pdf
   *      med body { FortnoxId: IntegrationInformationId, GivenNumber }.
   *      Svar: { FileName, MemoryStream, Bytes: <base64-PDF> }
   *   2. Om raden har FileUrl/InvoiceFileUrl → hämta blob direkt (Azure)
   *   3. Faller tillbaka till /supplier-invoices/{id}/image m.fl. kandidat-paths
   *
   * @param {string|number} invoiceId
   * @param {'customer'|'supplier'} [type='customer']
   * @param {Object} [meta]  extra info från raden: { integrationInformationId, givenNumber, fileUrl, ... }
   * @returns {Promise<{ok:true, buffer:Buffer, contentType:string|null}>}
   */
  async getInvoicePdf(invoiceId, type = 'customer', meta = {}) {
    const baseObj = new URL(this.baseUrl);
    const tryDirectBlob = async (blobUrl) => {
      if (!blobUrl || typeof blobUrl !== 'string' || !blobUrl.startsWith('http')) return null;
      const r = await this._fetch(blobUrl).catch(() => null);
      if (!r || !r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, buffer: buf, contentType: 'application/pdf', sourceUrl: blobUrl };
    };

    // 1) Fortnox-path för lev-fakturor
    if (type === 'supplier'
        && meta
        && (meta.integrationInformationId || meta.IntegrationInformationId)
        && (meta.givenNumber || meta.GivenNumber)) {
      try {
        const fortnoxId = meta.integrationInformationId ?? meta.IntegrationInformationId;
        const givenNumber = String(meta.givenNumber ?? meta.GivenNumber);
        const body = { FortnoxId: Number(fortnoxId), GivenNumber: givenNumber };
        const resp = await this._request(
          'POST',
          '/integrations/clients/fortnox/supplierinvoices/pdf',
          { body }
        );
        // Svar: { FileName, MemoryStream, Bytes: "<base64-PDF>" }
        const b64 = resp?.Bytes || resp?.bytes || resp?.MemoryStream;
        if (b64 && typeof b64 === 'string') {
          const buf = Buffer.from(b64, 'base64');
          return { ok: true, buffer: buf, contentType: 'application/pdf', fileName: resp.FileName };
        }
      } catch (e) {
        console.warn('[pp-client] Fortnox supplier-PDF misslyckades:', e.message);
        // fall-through till fallbacks
      }
    }

    // 2) Direkt blob-URL från rad-data
    const directCandidates = [
      meta?.fileUrl, meta?.FileUrl,
      meta?.invoiceFileUrl, meta?.InvoiceFileUrl,
      meta?.invoicePicture, meta?.InvoicePicture,
      meta?.binaryObjectUrl, meta?.BinaryObjectUrl,
    ].filter(Boolean);
    for (const u of directCandidates) {
      if (/fortnox\.se/i.test(u)) continue; // Fortnox API-URL ≠ PDF
      const r = await tryDirectBlob(u);
      if (r) return r;
    }

    // 3) Klassiska fallback-paths
    const id = encodeURIComponent(invoiceId);
    const candidates = type === 'supplier'
      ? [
          `/supplier-invoices/${id}/image`,
          `/project-supplier-invoice/${id}/image`,
          `/supplier-invoices/${id}/download`,
          `/project-supplier-invoice/${id}`,
        ]
      : [
          `/customer-invoices/${id}/image`,
          `/customer-invoices/${id}/draft-certificate`,
          `/project-invoices/${id}/image`,
          `/customer-invoices/${id}/download`,
          `/customer-invoices/${id}`,
        ];

    for (const p of candidates) {
      try {
        const url = `${this.baseUrl}${p}`;
        const authUri = `${baseObj.pathname}${p}`.replace(/\/\//g, '/');
        const headers = {
          Accept: 'application/json, application/pdf, application/octet-stream, */*',
          lang: 'sv', languageId: '1',
          'client-timezone-offset': String(-new Date().getTimezoneOffset()),
          Authorization: this.digestAuth.buildAuthorizationHeader('GET', authUri)
        };
        const resp = await this._fetch(url, { method: 'GET', headers });
        if (!resp.ok) continue;
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await resp.json();
          const blobUrl = data?.Url || data?.url || data?.FileUrl || data?.PdfUrl
                       || data?.ImageUrl || data?.BlobUrl || (typeof data === 'string' ? data : null);
          const r = await tryDirectBlob(blobUrl);
          if (r) return r;
          // Vissa endpoints returnerar { Bytes: base64 }
          const b64 = data?.Bytes || data?.bytes;
          if (b64 && typeof b64 === 'string') {
            return { ok: true, buffer: Buffer.from(b64, 'base64'), contentType: 'application/pdf' };
          }
        }
        if (contentType.includes('pdf') || contentType.includes('octet-stream')) {
          const buf = Buffer.from(await resp.arrayBuffer());
          return { ok: true, buffer: buf, contentType: contentType || 'application/pdf' };
        }
      } catch (_) { continue; }
    }
    throw new Error(
      `PDF inte hittad för ${type}-faktura ${invoiceId}. ` +
      `Provade Fortnox${type==='supplier' ? '(via IntegrationInformationId/GivenNumber)' : ''}, direkt-URL och ${candidates.length} fallback-paths.`
    );
  }

  // ---------------------------------------------------------------------------
  // Tid
  // ---------------------------------------------------------------------------

  /**
   * Hämta en användares tidrapporterade material för en vecka/period.
   * @param {Object} args
   * @param {string|number} args.userId
   * @param {string} args.startDate  Format YYYY-MM-DD
   * @param {string} args.endDate    Format YYYY-MM-DD
   * @returns {Promise<any>}
   */
  /**
   * Huvud-endpoint för veckovy i Hantera tid.
   * Response är en DUBBELKODAD JSON-sträng: { WeekTotalList, AllUsersReportTime, ... }
   * Varje user i AllUsersReportTime har UserActualTimeList med faktiska tidrader.
   */
  async getTimeWeek({ startDate, endDate, showSevenDays = true }) {
    const raw = await this._request('GET', '/time-manage', {
      query: { StartDate: startDate, EndDate: endDate, ShowSevenDays: showSevenDays }
    });
    // Response är dubbelkodad JSON — parsa igen om det är en sträng
    let data = raw;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch {}
    }
    return data;
  }

  /** Backward-compat: materialvy */
  async getTimeMaterials({ userId, startDate, endDate }) {
    return this._request('GET', '/time-manage/materials', {
      query: { userId, startDate, endDate },
    });
  }

  // ---------------------------------------------------------------------------
  // Tid-CRUD (create/update/delete tidrader)
  // ---------------------------------------------------------------------------

  /**
   * Skapar en tidrad. Tidkoden styr typ:
   *   010/011  -> arbetstid  -> POST /api/actual-time
   *   020      -> restid     -> POST /api/claims
   *   030/031  -> övertid    -> POST /api/actual-time (med OB)
   *   040/050/060 -> frånvaro -> POST /api/absence
   *
   * Body-form: PascalCase (enligt andra Projektportalen-endpoints).
   * Datum skickas som YYYY-MM-DDT00:00:00 (ISO utan TZ).
   *
   * @param {Object} args
   * @param {string} args.datum          YYYY-MM-DD
   * @param {string} args.tidkod         t.ex. "010", "020", "030"...
   * @param {string|number} [args.userId]
   * @param {string|number} [args.projectId]       Om redan upplöst
   * @param {string|number} [args.projectNumber]   Ordernummer/projektnummer, löses upp via _resolveProjectId
   * @param {string} [args.objectRef]    Objekt (moment/fritext)
   * @param {number} args.antal          Timmar (decimal)
   * @param {string} [args.text]         Kommentar
   * @param {string|number} [args.resultatenhet]
   * @returns {Promise<any>}
   */
  async createTimeEntry({
    datum,
    tidkod,
    timeTypeId,   // explicit TimeTypeId (kan komma från /time-types/client)
    category,     // 'actual' | 'claims' | 'absence' — om angiven vinner över tidkod-mappning
    userId,
    projectId,
    projectNumber,
    objectRef,
    antal,
    text,
    resultatenhet,
    projectTaskId,
  }) {
    const code = String(tidkod || '').substring(0, 3);
    const timestamp = `${datum}T00:00:00`;

    // UserId måste vara numeriskt. Prova cache, sedan hämta från /time-manage
    let uid = Number(userId) || Number(this.digestAuth.cachedUserId);
    if (!uid || Number.isNaN(uid)) {
      try {
        const iso = d => d.toISOString().slice(0, 10);
        const today = new Date();
        const day = today.getDay() || 7;
        const mon = new Date(today); mon.setDate(today.getDate() - (day - 1));
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const r = await this._request('GET', '/time-manage', {
          query: { StartDate: iso(mon), EndDate: iso(sun), ShowSevenDays: true }
        });
        let data = r;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
        const users = data?.AllUsersReportTime || [];
        // Hitta mig (matcha på username/email)
        const meName = String(this.digestAuth.username || '').toLowerCase();
        const me = users.find(u => (u.UserName || '').toLowerCase().includes(meName.split('@')[0])) || users[0];
        if (me?.UserId) {
          uid = me.UserId;
          this.digestAuth.cachedUserId = uid;
          console.log('[pp-client] Cachade UserId', uid, 'för', me.UserName);
        }
      } catch (e) {
        console.warn('[pp-client] Kunde inte hämta UserId:', e.message);
      }
    }

    const pid = projectId != null
      ? Number(projectId)
      : (projectNumber != null ? Number(await this._resolveProjectId(projectNumber)) : null);

    // Hämta ProjectTaskId om den saknas — använd första tasken från /tasks-deviations/report-time
    let ptId = Number(projectTaskId) || Number(objectRef);
    if ((!ptId || Number.isNaN(ptId)) && pid) {
      try {
        const tasks = await this._request('GET', `/${encodeURIComponent(pid)}/tasks-deviations/report-time`);
        const firstTask = Array.isArray(tasks) ? tasks.find(t => t.ProjectTaskId) : null;
        if (firstTask?.ProjectTaskId) {
          ptId = firstTask.ProjectTaskId;
          console.log('[pp-client] Auto-resolverade ProjectTaskId', ptId, 'för projekt', pid);
        }
      } catch (e) {
        console.warn('[pp-client] Kunde inte hämta ProjectTaskId:', e.message);
      }
    }

    // Verifierat riktigt format från Chrome-capture:
    // POST /actual-times/multiple med batch-body där alla tre typer
    // (ActualTime/Absence/Claims) samlas i en request. Timestamp är YYYY-MM-DD.
    const baseBatch = {
      ActualTimeRequests: [],
      AbsenceTimeRequests: [],
      ClaimsTimeRequests: [],
      DeletedActualTimeIds: [],
      DeletedAbsenceTimeIds: [],
      DeletedClaimsTimeIds: [],
      UserId: uid,
      Timestamp: datum,  // YYYY-MM-DD (inte T00:00:00)
    };

    // Om category+timeTypeId kommer explicit från UI (via /time-types/client)
    // vinner de över den legacy-baserade 3-siffriga tidkod-mappningen.
    const explicitTT = timeTypeId != null ? Number(timeTypeId) : null;
    const cat = category && ['actual','claims','absence'].includes(category) ? category : null;

    const timeTypeMap = { '010': 0, '011': 0, '020': 20, '030': 0, '031': 0 };
    const absenceTypeMap = { '040': 1, '050': 2, '060': 3 };

    // 1. Explicit kategori (från UI med riktiga TimeTypeId-värden)
    if (cat === 'actual' || (!cat && ['010', '011', '030', '031'].includes(code))) {
      const body = { ...baseBatch, ActualTimeRequests: [{
        ProjectId: pid,
        ProjectTaskId: ptId || 0,
        TimeTypeId: explicitTT != null ? explicitTT : (timeTypeMap[code] ?? 0),
        Billable: true,
        DeviationId: 0,
        Quantity: Number(antal) || 0,
        InvoiceQuantity: Number(antal) || 0,
        Comment: text || '',
        InvoiceAble: true,
      }] };
      return this._request('POST', '/actual-times/multiple', { body });
    }

    if (cat === 'claims' || (!cat && code === '020')) {
      const body = { ...baseBatch, ClaimsTimeRequests: [{
        ProjectId: pid,
        ProjectTaskId: ptId || 0,
        TimeTypeId: explicitTT != null ? explicitTT : 20,
        Quantity: Number(antal) || 0,
        Comment: text || '',
      }] };
      return this._request('POST', '/actual-times/multiple', { body });
    }

    if (cat === 'absence' || (!cat && ['040', '050', '060'].includes(code))) {
      // AbsenceTypeId bör komma från TimeType.AbsenceTypeId — om explicit TT
      // givet letar vi upp det från cachen; annars fall tillbaka på legacy-mappning.
      let absTypeId = absenceTypeMap[code];
      if (explicitTT != null) {
        // Vi har inget lokalt cache här i pp-client; UI har redan markerat
        // kategorin som "absence", så AbsenceTypeId motsvarar själva TimeTypeId
        // i många klienter. Acceptera explicit override via absenceTypeId
        // eller använd legacy om code finns.
        absTypeId = absenceTypeMap[code] ?? explicitTT;
      }
      const body = { ...baseBatch, AbsenceTimeRequests: [{
        AbsenceTypeId: absTypeId,
        TimeTypeId: explicitTT != null ? explicitTT : undefined,
        Hours: Number(antal) || 0,
        Quantity: Number(antal) || 0,
        Comment: text || '',
      }] };
      return this._request('POST', '/actual-times/multiple', { body });
    }

    throw new Error(`Okänd tidkod: ${tidkod} (cat=${cat}, timeTypeId=${explicitTT})`);
  }

  /**
   * Uppdaterar en tidrad via ActualTimeId.
   * Använder PUT /api/actual-time/{id}. Om servern svarar 404 (t.ex. raden är
   * i själva verket en frånvarorad eller ersättning) bubblar felet upp så att
   * UI kan ladda om state.
   *
   * @param {string|number} actualTimeId
   * @param {Object} patch   PascalCase-fält som ska uppdateras
   * @returns {Promise<any>}
   */
  /**
   * Uppdaterar en tidrad. Använder samma batch-endpoint /actual-times/multiple
   * med ActualTimeId i ActualTimeRequests[0].
   */
  async updateTimeEntry(actualTimeId, patch) {
    const uid = Number(patch.UserId) || Number(this.digestAuth.cachedUserId);
    const datum = patch.Timestamp?.substring(0, 10) || patch.datum || new Date().toISOString().slice(0, 10);
    const body = {
      ActualTimeRequests: [{
        ActualTimeId: Number(actualTimeId),
        ProjectId: patch.ProjectId ?? patch.projectId,
        ProjectTaskId: patch.ProjectTaskId ?? 0,
        TimeTypeId: patch.TimeTypeId ?? 0,
        Billable: patch.Billable ?? true,
        DeviationId: patch.DeviationId ?? 0,
        Quantity: Number(patch.Quantity ?? patch.antal ?? 0),
        InvoiceQuantity: Number(patch.InvoiceQuantity ?? patch.Quantity ?? patch.antal ?? 0),
        Comment: patch.Comment ?? patch.text ?? '',
        InvoiceAble: patch.InvoiceAble ?? true,
      }],
      AbsenceTimeRequests: [],
      ClaimsTimeRequests: [],
      DeletedActualTimeIds: [],
      DeletedAbsenceTimeIds: [],
      DeletedClaimsTimeIds: [],
      UserId: uid,
      Timestamp: datum,
    };
    return this._request('POST', '/actual-times/multiple', { body });
  }

  /**
   * Tar bort en tidrad via batch-endpointen.
   * Body: { ..., DeletedActualTimeIds: [id], UserId, Timestamp }
   */
  async deleteTimeEntry(actualTimeId, { timestamp } = {}) {
    const uid = Number(this.digestAuth.cachedUserId);
    const body = {
      ActualTimeRequests: [],
      AbsenceTimeRequests: [],
      ClaimsTimeRequests: [],
      DeletedActualTimeIds: [Number(actualTimeId)],
      DeletedAbsenceTimeIds: [],
      DeletedClaimsTimeIds: [],
      UserId: uid,
      Timestamp: timestamp || new Date().toISOString().slice(0, 10),
    };
    return this._request('POST', '/actual-times/multiple', { body });
  }

  /**
   * Hitta ProjectId från ProjectNumber genom att söka i senaste
   * service-order-list-cache eller göra en kändeslösning. Förenklat: anta att
   * projectNumber redan är ProjectId om det är rent numeriskt > 100000.
   *
   * @param {string|number} projectNumberOrId
   * @returns {Promise<string|number|null>}
   */
  async _resolveProjectId(projectNumberOrId) {
    if (projectNumberOrId == null || projectNumberOrId === '') return null;
    const asStr = String(projectNumberOrId).trim();
    // Rent numeriskt och > 100000 -> anta att det redan är ett ProjectId
    if (/^\d+$/.test(asStr) && Number(asStr) > 100000) {
      return asStr;
    }
    // Kolla cache från senaste listServiceOrders-anrop
    if (this._lastServiceOrderList && Array.isArray(this._lastServiceOrderList)) {
      const hit = this._lastServiceOrderList.find((row) => {
        const num = row.ProjectNumber ?? row.Number ?? row.Numbers;
        return num != null && String(num) === asStr;
      });
      if (hit) {
        return hit.ProjectId ?? hit.Id ?? hit.ProjectID ?? asStr;
      }
    }
    // Fallback: sök via service-order-list med keyword
    try {
      const res = await this.listServiceOrders({ keyword: asStr, endRow: 5 });
      const rows = Array.isArray(res) ? res : (res && (res.Rows || res.rows || res.Data)) || [];
      const hit = Array.isArray(rows) && rows.find((row) => {
        const num = row.ProjectNumber ?? row.Number ?? row.Numbers;
        return num != null && String(num) === asStr;
      });
      if (hit) {
        return hit.ProjectId ?? hit.Id ?? hit.ProjectID ?? asStr;
      }
    } catch (_err) {
      // Ignorera — returnera råvärdet som fallback nedan
    }
    // Sista utväg: returnera indata oförändrat — servern får avgöra
    return asStr;
  }

  // ---------------------------------------------------------------------------
  // Material
  // ---------------------------------------------------------------------------

  /**
   * Hämta material registrerade på en specifik order/projekt.
   *
   * VERIFIERAT via Chrome XHR-capture: Entré/Projektportalen använder
   *   POST /api/projects/reported-user-materials
   * med ag-grid-body och ProjectId som sträng. Tidigare varianter (GET
   * /{id}/tasks-deviations/materials + GET /projects/material) returnerar
   * tom Materials-array för de flesta ordrar; den här är rätt.
   *
   * Fallback till den gamla task-hierarki-endpointen om nya endpointen
   * skulle svara tomt (bakåtkompat).
   */
  async getOrderMaterials(projectId, { skipFallback = false } = {}) {
    const pidStr = String(projectId);
    const body = {
      StartRow: 0,
      EndRow: 200,
      ProjectId: pidStr,
      FilterModel: {},
      SortModel: [],
      RowGroupCols: [],
      ValueCols: [],
      PivotCols: [],
      PivotMode: false,
      GroupKeys: [],
      Keyword: '',
    };

    let primary = null;
    try {
      primary = await this._request('POST', '/projects/reported-user-materials', { body });
    } catch (e) {
      console.warn('[pp-client] reported-user-materials misslyckades:', e.message);
    }

    // Extrahera rader från ag-grid-responsen. Fält kan heta Rows/rows/Data/Items.
    const rows = Array.isArray(primary)
      ? primary
      : (primary?.Rows || primary?.rows || primary?.Data || primary?.data || primary?.Items || []);

    // Fallback till gamla task-hierarki-endpointen — extra anrop per
    // projekt utan material, så skippa det om caller har skipFallback=true
    // (t.ex. vid batch-hämtning i tidsregistreringen).
    let fallbackNested = [];
    if (!rows.length && !skipFallback) {
      try {
        const id = encodeURIComponent(projectId);
        const tasks = await this._request('GET', `/${id}/tasks-deviations/materials`);
        if (Array.isArray(tasks)) {
          fallbackNested = tasks.flatMap(t => Array.isArray(t.Materials) ? t.Materials : []);
        }
      } catch (_) { /* ignorera */ }
    }

    return {
      rows: rows.length ? rows : fallbackNested,
      projectId: Number(projectId),
      tasks: [],
      allMaterials: [],
    };
  }

  /**
   * Hämta tidrader registrerade på en specifik order/projekt.
   *
   * VERIFIERAT via Chrome-capture: webb-Entré använder
   *   POST /api/projects/reported-user-times
   * med ag-grid-body (identiskt format som reported-user-materials).
   * Varje rad har UserName, Quantity, ReportDate, TaskName, TimeTypeId,
   * TimeTypeName, ActualTimeId, ProjectTaskId, Comment etc.
   *
   * Den gamla GET /{id}/tasks-deviations/report-time returnerar bara
   * task-hierarki utan tidrader — använd den endast som fallback.
   */
  async getOrderTimeEntries(projectId) {
    const pidStr = String(projectId);
    const body = {
      StartRow: 0,
      EndRow: 200,
      ProjectId: pidStr,
      FilterModel: {},
      SortModel: [],
      RowGroupCols: [],
      ValueCols: [],
      PivotCols: [],
      PivotMode: false,
      GroupKeys: [],
      Keyword: '',
    };
    let primary = null;
    try {
      primary = await this._request('POST', '/projects/reported-user-times', { body });
    } catch (e) {
      console.warn('[pp-client] reported-user-times misslyckades:', e.message);
    }
    const rows = Array.isArray(primary)
      ? primary
      : (primary?.Rows || primary?.rows || primary?.Data || primary?.Items || []);
    // Fallback till gamla endpointen om primärt svar är tomt
    let fallbackTasks = [];
    if (!rows.length) {
      try {
        const id = encodeURIComponent(projectId);
        const r = await this._request('GET', `/${id}/tasks-deviations/report-time`);
        if (Array.isArray(r)) fallbackTasks = r;
      } catch (_) {}
    }
    return {
      rows,
      tasks: fallbackTasks,
      projectId: Number(projectId),
      totalCount: primary?.TotalCount ?? rows.length,
    };
  }

  /**
   * Hämta kompletta listan med tidkoder som klienten har tillgång till.
   * Svarar med ~200 TimeType-objekt: TimeTypeId, Name, ShortName,
   * IsShowInMobileApp, Billable, Percentage, AbsenceTypeId, IsClaimsType etc.
   */
  async getTimeTypes() {
    const data = await this._request('GET', '/time-types/client');
    return Array.isArray(data) ? data : [];
  }

  /**
   * Hämta artikelgrupper (inkl. "Snabbval Artiklar" som innehåller bilzoner).
   */
  async getArticleGroups() {
    const data = await this._request('GET', '/article-groups/articles');
    return Array.isArray(data) ? data : [];
  }

  /**
   * Sök/lista artiklar — används för "Snabbval Artiklar".
   * Endpoint: GET /api/search/articles/search
   * Query: ClientId, UserId, Keyword, Top, PageIndex, ArticleGroupId, ShowCost, PriceListId
   * Svar: { TotalCount, Articles: [{ ArticleId, ArticleNumber, Name, SalesPrice, UnitCode, ... }] }
   *
   * Utan ArticleGroupId returneras alla artiklar; skicka 7122 (Snabbval) för top-listan.
   */
  async searchArticlesSnabbval({
    clientId,
    userId,
    keyword = '',
    top = 50,
    pageIndex = 1,
    articleGroupId = null,
    showCost = true,
    priceListId = 0,
  } = {}) {
    const query = {
      ClientId: clientId ?? this.digestAuth.clientId,
      UserId: userId ?? this.digestAuth.cachedUserId ?? 0,
      Keyword: keyword,
      Top: top,
      PageIndex: pageIndex,
      ShowCost: showCost,
      PriceListId: priceListId,
    };
    if (articleGroupId) query.ArticleGroupId = articleGroupId;
    return this._request('GET', '/search/articles/search', { query });
  }

  /**
   * Totalt rapporterat material för order.
   */
  async getOrderMaterialTotals(projectId) {
    const id = encodeURIComponent(projectId);
    return this._request('GET', `/projects/${id}/total-reported-Materials`);
  }

  /**
   * Totalt rapporterad tid per användare för order.
   */
  async getOrderTimeTotals(projectId) {
    const id = encodeURIComponent(projectId);
    return this._request('GET', `/projects/${id}/total-reported-user-times`);
  }

  /**
   * Projekt-ekonomi (intäkter, kostnader, resultat).
   */
  async getProjectEconomy(projectId) {
    const id = encodeURIComponent(projectId);
    return this._request('GET', `/projects/${id}/project-economy`);
  }

  /**
   * Lägg till material på en order.
   *
   * VERIFIERAT via Chrome XHR-capture av Projektportalens webb:
   *   POST /api/materials
   *   body: {
   *     ActualAndExpectedMaterialRequests: [{
   *       Name, Total, MaterialUnitId, ArticleId, InvoiceAble, ArticleNumber,
   *       Discount, CreateDate, ReportQty, ReportInvoiceQty, BudgetQty,
   *       Price, CostPrice, GrossPrice, PurchasePrice, WholeSaleId
   *     }],
   *     DeleteActualMaterialIds: [],
   *     ProjectId, ProjectTaskId, TaskType, UserId
   *   }
   *   → HTTP 204 No Content vid success
   *
   * "Fel användar ID" = UserId saknas/ogiltigt. ProjectTaskId hämtas
   * automatiskt via /tasks-deviations/materials om det inte skickas.
   */
  async addOrderMaterial({
    projectId,
    articleId,
    articleNumber,
    benamning,
    antal,
    enhet,
    prisPerEnhet,
    kostnad,
    debiterbar = true,
    projectTaskId,
    taskType,
    userId,
    materialUnitId,
    discount,
    purchasePrice,
  }) {
    // 1) Resolve UserId (kräver numeriskt id — digest-state cachar det från /time-manage)
    let uid = Number(userId) || Number(this.digestAuth.cachedUserId);
    if (!uid || Number.isNaN(uid)) {
      try {
        const iso = d => d.toISOString().slice(0, 10);
        const today = new Date();
        const day = today.getDay() || 7;
        const mon = new Date(today); mon.setDate(today.getDate() - (day - 1));
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const r = await this._request('GET', '/time-manage', {
          query: { StartDate: iso(mon), EndDate: iso(sun), ShowSevenDays: true }
        });
        let data = r;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
        const users = data?.AllUsersReportTime || [];
        const meName = String(this.digestAuth.username || '').toLowerCase();
        const me = users.find(u => (u.UserName || '').toLowerCase().includes(meName.split('@')[0])) || users[0];
        if (me?.UserId) {
          uid = me.UserId;
          this.digestAuth.cachedUserId = uid;
        }
      } catch (e) {
        console.warn('[pp-client] Kunde inte hämta UserId till material-save:', e.message);
      }
    }
    if (!uid) throw new Error('Material kräver UserId — kunde inte hämtas automatiskt');

    // 2) Resolve ProjectTaskId (obligatoriskt enl. capture; defaultar till första tasken)
    let ptId = Number(projectTaskId) || 0;
    let tType = Number(taskType) || 0;
    if (!ptId) {
      try {
        const tasks = await this._request('GET', `/${encodeURIComponent(projectId)}/tasks-deviations/materials`);
        const firstTask = Array.isArray(tasks)
          ? tasks.find(t => t.ProjectTaskId)
          : null;
        if (firstTask?.ProjectTaskId) {
          ptId = firstTask.ProjectTaskId;
          if (!tType) tType = firstTask.TaskType || firstTask.ProjectTaskType || 1;
        }
      } catch (e) {
        console.warn('[pp-client] Kunde inte hämta ProjectTaskId:', e.message);
      }
    }
    if (!tType) tType = 1;

    // 3) Bygg body enligt verifierat format
    const price = Number(prisPerEnhet) || 0;
    const qty = Number(antal) || 0;
    const body = {
      ActualAndExpectedMaterialRequests: [{
        Name: benamning || '',
        Total: price * qty,
        MaterialUnitId: Number(materialUnitId) || 0,
        ArticleId: Number(articleId) || 0,
        InvoiceAble: !!debiterbar,
        ArticleNumber: articleNumber || '',
        Discount: Number(discount) || 0,
        CreateDate: new Date().toISOString().slice(0, 10),
        ReportQty: qty,
        ReportInvoiceQty: qty,
        BudgetQty: qty,
        Price: price,
        CostPrice: Number(kostnad) || '',
        GrossPrice: null,
        PurchasePrice: Number(purchasePrice) || price,
        WholeSaleId: 0,
      }],
      DeleteActualMaterialIds: [],
      ProjectId: Number(projectId),
      ProjectTaskId: ptId,
      TaskType: tType,
      UserId: uid,
    };
    return this._request('POST', '/materials', { body });
  }

  async updateOrderMaterial(actualMaterialId, patch) {
    const body = { ...patch, ActualMaterialId: actualMaterialId, ClientId: this.digestAuth.clientId };
    return this._request('PUT', `/materials/${encodeURIComponent(actualMaterialId)}`, { body });
  }

  /**
   * Ta bort en eller flera material-rader.
   * Verifierat: POST /api/materials/remove-multiple med body
   * `{ DeleteActualMaterialIds: [id, id, ...] }` → 204 No Content.
   */
  async deleteOrderMaterial(actualMaterialId) {
    const ids = Array.isArray(actualMaterialId)
      ? actualMaterialId.map(Number)
      : [Number(actualMaterialId)];
    const body = { DeleteActualMaterialIds: ids };
    return this._request('POST', '/materials/remove-multiple', { body });
  }

  /**
   * Hämta fullständiga pris-detaljer för en artikel mot ett projekts prislista.
   *
   * VERIFIERAT från Chrome-capture:
   *   GET /api/articles/{articleId}/salesprice/{priceListId}/0
   *   → {
   *       ArticleId, Name, ArticleNumber, UnitName, UnitId (MaterialUnitId!),
   *       Price, PurchasePrice, GrossPrice, Discount, MaterialCost, ...
   *     }
   *
   * Snabbval/search endpoints returnerar SalesPrice: 0 för de flesta
   * artiklar — den här endpointen ger det faktiska priset enligt projektets
   * prislista (samt rätt UnitId som krävs vid material-POST).
   *
   * Cachar projekt-PriceListId internt så vi slipper extra anrop.
   *
   * @param {string|number} articleId
   * @param {string|number} projectId  används för att slå upp PriceListId
   * @returns {Promise<any|null>} null om något saknas
   */
  async getArticleSalesPrice(articleId, projectId) {
    if (!articleId) return null;
    // 1) Slå upp PriceListId för projektet (cachat)
    this._projectPriceLists = this._projectPriceLists || new Map();
    let priceListId = this._projectPriceLists.get(String(projectId));
    if (!priceListId) {
      try {
        const proj = await this._request('GET', `/projects/${encodeURIComponent(projectId)}`);
        priceListId = proj?.PriceListId ?? proj?.priceListId ?? 0;
        this._projectPriceLists.set(String(projectId), priceListId);
      } catch (e) {
        console.warn('[pp-client] Kunde inte hämta PriceListId för projekt', projectId, e.message);
      }
    }
    const pl = Number(priceListId) || 0;
    // 2) Hämta pris
    const path = `/articles/${encodeURIComponent(articleId)}/salesprice/${pl}/0`;
    try {
      return await this._request('GET', path);
    } catch (e) {
      console.warn('[pp-client] salesprice-anrop misslyckades:', e.message);
      return null;
    }
  }

  /**
   * Sök artiklar brett (inte begränsat till snabbval). Returnerar
   * { TotalCount, Articles: [...] } — används av inline-material-editorn
   * när man skriver artikelnummer.
   */
  async searchArticlesBroad({ keyword = '', top = 20, pageIndex = 1 } = {}) {
    // Auto-resolve UserId om cache är tom (servern kräver giltigt UserId)
    if (!this.digestAuth.cachedUserId) {
      try {
        const iso = d => d.toISOString().slice(0, 10);
        const today = new Date();
        const day = today.getDay() || 7;
        const mon = new Date(today); mon.setDate(today.getDate() - (day - 1));
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const r = await this._request('GET', '/time-manage', {
          query: { StartDate: iso(mon), EndDate: iso(sun), ShowSevenDays: true }
        });
        let data = r;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
        const users = data?.AllUsersReportTime || [];
        const meName = String(this.digestAuth.username || '').toLowerCase();
        const me = users.find(u => (u.UserName || '').toLowerCase().includes(meName.split('@')[0])) || users[0];
        if (me?.UserId) this.digestAuth.cachedUserId = me.UserId;
      } catch (_) {}
    }
    const query = {
      ClientId: this.digestAuth.clientId,
      UserId: this.digestAuth.cachedUserId || 0,
      Keyword: keyword,
      Top: top,
      PageIndex: pageIndex,
      // Verifierat via Chrome-capture: webb-appen skickar ALLTID ArticleGroupId=0
      // för bred sökning (över alla grupper). Utelämnas parametern blir
      // resultatet tomt för vissa sökord.
      ArticleGroupId: 0,
      ShowCost: true,
      PriceListId: 0,
    };
    return this._request('GET', '/search/articles/search', { query });
  }

  /**
   * Lista artiklar (material-register) för autocomplete vid material-skapande.
   */
  async searchArticles({ keyword = '', pageSize = 20 } = {}) {
    return this._request('GET', '/articles', { query: { keyword, pageSize } });
  }
}

/**
 * Läs response-body som text utan att kasta.
 * @param {Response} response
 * @returns {Promise<string|null>}
 */
async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

module.exports = {
  ProjektportalenClient,
  // Alias så main.js som letar efter PPClient/default också fungerar
  PPClient: ProjektportalenClient,
  default: ProjektportalenClient,
  // Återexportera DigestAuth så main.js kan hämta den från samma modul
  DigestAuth,
  UnauthorizedError,
  NetworkError,
  DEFAULT_BASE_URL,
};
