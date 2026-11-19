/* ============================================================
   OrderPortal – renderer (browser side)
   ============================================================ */

(function () {
  // Data-arrayer: startar som kopior av mock-data, byts ut mot live-data
  // så fort window.api.serviceOrders.list() svarar.
  let orders = [...(window.MockData?.orders || [])];
  let customers = [...(window.MockData?.customers || [])];
  let timeEntries = [...(window.MockData?.timeEntries || [])];
  let selectedOrderId = null;
  let selectedCustomerId = null;
  let selectedTimeId = null;
  let editingTimeId = null;
  let currentView = 'orders';
  let orderFilter = 'alla';
  let liveMode = false;  // blir true när vi faktiskt fått live-data
  let calViewDate = new Date();  // vilken månad/vecka minikalendern centreras runt
  let orderSort = { col: null, dir: 'asc' };  // aktiv sortering på orderlistan
  let currentDetailOrder = null;
  let currentDetailTab = 'time';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ============================================================
  //  LIVE API-BRYGGA
  //  Mappar Projektportalens fältnamn till våra interna fält.
  //  Namnen kan variera — vi gissar utifrån observerad UI-terminologi.
  // ============================================================
  const pick = (obj, ...keys) => {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
  };

  // Fältnamn verifierade mot Projektportalens riktiga response-struktur.
  function mapServiceOrder(raw) {
    return {
      nummer: String(pick(raw, 'ProjectNumber', 'ProjectId') || ''),
      kund: pick(raw, 'CustomerName', 'Client') || '',
      kundnummer: String(pick(raw, 'CustomerNumber', 'CustomerId', 'ClientId') || ''),
      beskrivning: pick(raw, 'ProjectName', 'Description') || '',
      referens: pick(raw, 'ProjectManager', 'ProjectManager2') || '',
      projekt: String(pick(raw, 'ProjectNumber', 'ProjectId') || ''),
      startdatum: '',  // ingen StartDate i service-order list-responsen
      belopp: Number(pick(raw, 'Price', 'OfferPrice', 'EstimatedPrice') || 0),
      status: pick(raw, 'StatusName', 'PriceType') || '',
      prio: !!pick(raw, 'IsFavorite'),
      ny: false,
      flag: null,
      _raw: raw
    };
  }

  function mapCustomer(raw) {
    return {
      kundnummer: String(pick(raw, 'CustomerNumber', 'ConvertCustomerNumber', 'CustomerId') || ''),
      namn: pick(raw, 'Name') || '',
      orgnr: pick(raw, 'OrganizationalNumber') || '',
      ort: pick(raw, 'City') || '',
      telefon: pick(raw, 'Phone', 'PhoneNumber') || '',
      epost: pick(raw, 'Email', 'Mail') || '',
      kundgrupp: pick(raw, 'IsCompany') ? 'Företag' : 'Privat',
      _raw: raw
    };
  }

  // Plocka ut array ur API-svar. Projektportalen använder olika nycklar:
  //   service-order/list → { Rows: [...], TotalCount }
  //   customers-paging/ → { CustomerViews: [...], TotalCount }
  //   time-manage/materials → direkt array
  function extractList(resp) {
    if (!resp) return [];
    if (Array.isArray(resp)) return resp;
    return resp.Rows || resp.CustomerViews || resp.Items
        || resp.data || resp.items || resp.rows || resp.list || resp.result || [];
  }

  async function loadLiveOrders() {
    try {
      // tabIndex: 2=Pågående, 3=Väntande, 4=Utförda, 5=Fakturera, 6=Avslutade, 8=Alla
      const tabMap = { alla: 8, nya: 2, prio: 2, oppna: 2 };
      const resp = await window.api?.serviceOrders?.list({
        tabIndex: tabMap[orderFilter] ?? 8,
        startRow: 0,
        endRow: 100
      });
      if (!resp || resp.ok === false) throw new Error(resp?.error || 'API-anrop misslyckades');
      const raw = resp.data ?? resp;
      const list = extractList(raw);
      if (list.length === 0) {
        console.warn('[renderer] Tom lista från service-order/list. Raw:', raw);
      }
      orders = list.map(mapServiceOrder);
      liveMode = true;
      console.log(`[renderer] Laddade ${orders.length} serviceordrar från API`);
    } catch (e) {
      console.error('[renderer] Kunde inte ladda live-ordrar, kör mock:', e);
      showToast(`Kunde inte hämta ordrar: ${e.message}. Visar mock-data.`, 'warn');
    }
  }

  async function loadLiveCustomers() {
    try {
      const resp = await window.api?.customers?.list({ pageSize: 100, pageIndex: 1 });
      if (!resp || resp.ok === false) throw new Error(resp?.error || 'API-anrop misslyckades');
      const raw = resp.data ?? resp;
      const list = extractList(raw);
      customers = list.map(mapCustomer);
      console.log(`[renderer] Laddade ${customers.length} kunder från API`);
    } catch (e) {
      console.warn('[renderer] Kunde inte ladda live-kunder:', e.message);
    }
  }

  // Enkel toast som visas 4s
  function showToast(msg, type = 'info') {
    let toast = document.getElementById('__toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = '__toast';
      toast.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:6px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);font-size:13px;max-width:400px;';
      document.body.appendChild(toast);
    }
    toast.style.background = type === 'warn' ? '#f6c453' : type === 'error' ? '#e57373' : '#1bb89a';
    toast.style.color = '#fff';
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(toast.__t);
    toast.__t = setTimeout(() => (toast.style.display = 'none'), 4000);
  }

  // ============================================================
  //  VY-SWITCHING
  // ============================================================
  function switchView(name) {
    currentView = name;
    $$('section.view').forEach(v => {
      v.hidden = v.dataset.view !== name;
    });
    $$('.nav-item').forEach(i => i.classList.toggle('active', i.dataset?.view === name));
    const titles = {
      home: 'HEM',
      orders: 'ORDERLISTA',
      time: 'TIDSREGISTRERING',
      customers: 'KUNDLISTA',
      planning: 'TIDPLANERING',
      'reports-order': 'RAPPORTCENTRAL',
      'reports-time': 'RAPPORTCENTRAL',
      contacts: 'KONTAKTER'
    };
    $('#pageTitle').textContent = titles[name] || name.toUpperCase();
    if (name === 'home') renderHome();
    if (name === 'orders') {
      renderOrders();
      loadLiveOrders().then(renderOrders);
    }
    if (name === 'time') {
      // Använd cachad data om preload har körts — annars ladda.
      // Tidsregistrering preloadas vid app-start så första klicket blir instant.
      if (window.__liveTimeLoadedAt) {
        renderTime();
      } else if (window.__liveTimeLoading) {
        // Preload pågår — visa spinner, data renderas när den är klar
        renderTime();
        setTimeLoading(true);
      } else {
        timeEntries = [];
        window.__liveWeekInfo = null;
        renderTime();
        setTimeLoading(true);
        loadLiveTime().then(() => {
          setTimeLoading(false);
          renderTime();
        });
      }
    }
    if (name === 'customers') {
      renderCustomers();
      loadLiveCustomers().then(renderCustomers);
    }
  }

  // Laddar tid för innevarande vecka. Försöker härleda user + datum.
  // Hjälp-funktion: toggla spinner/ready-indicator bredvid "Tidsregistrering" i sidebar
  function setTimeNavIndicator(state) {
    // state: 'loading' | 'ready' | 'none'
    const spinner = $('#timeNavSpinner');
    const ready = $('#timeNavReady');
    if (!spinner || !ready) return;
    spinner.style.display = state === 'loading' ? 'inline-block' : 'none';
    ready.style.display   = state === 'ready'   ? 'inline-block' : 'none';
  }

  // Hjälp: klassificera tidrad som arbetad timme eller tillägg
  const isWorkHour = (t) => {
    const id = Number(t.TimeTypeId || 0);
    const name = String(t.TimeTypeName || '').trim();
    if (id === 0 && !name) return true;
    if (/^arbetstid/i.test(name)) return true;
    if (/^övertid/i.test(name)) return true;
    if (/ötid/i.test(name)) return true;
    return false;
  };

  // Processa svar för EN vecka och mutera delat state
  function mergeWeekResponse(resp, span, state, userId) {
    if (!resp || resp.ok === false) return;
    const data = resp.data ?? resp;
    const users = data?.AllUsersReportTime || [];
    const me = users.find(u => u.UserId === userId) || users[0];
    if (!me) return;
    state.meName = me.UserName || state.meName;
    if (me.UserId) state.meId = me.UserId;

    const totals = me.UserWeekTimeTotalList || [];
    for (let d = 0; d < 7; d++) {
      state.dayTotalsByDate[addDays(span.monday, d)] = totals[d] || 0;
    }
    const rawList = me.UserActualTimeList || [];
    for (const t of rawList) {
      const stampRaw = t.Timestamp || t.Date || t.Day || '';
      const datum = stampRaw ? String(stampRaw).substring(0, 10) : '';
      const qty = Number(t.Quantity || 0);
      const work = isWorkHour(t);
      if (datum) {
        if (work) state.workHoursByDate[datum] = (state.workHoursByDate[datum] || 0) + qty;
        else state.tillaggByDate[datum] = (state.tillaggByDate[datum] || 0) + 1;
      }
      state.entries.push({
        id: 'a_' + (t.ActualTimeId || Math.random()),
        rawId: t.ActualTimeId,
        kind: work ? 'arbete' : 'tillägg',
        datum,
        tidkod: pick(t, 'TimeTypeName', 'ProjectTaskName', 'ParentTaskName') || (work ? 'Arbetstid' : ''),
        order: String(t.ProjectNumber || t.ProjectId || ''),
        projectId: t.ProjectId,
        projekt: t.ProjectName || '',
        text: t.Comment || '',
        antal: qty,
        isWork: work,
        status: t.IsApproved ? 'Klar' : 'Pågående'
      });
    }
    const extraLists = [
      { key: 'UserClaimsTimeList', kind: 'ersättning' },
      { key: 'ClaimsTimeList', kind: 'ersättning' },
      { key: 'UserClaimTimeList', kind: 'ersättning' },
      { key: 'UserAbsenceTimeList', kind: 'frånvaro' },
      { key: 'AbsenceTimeList', kind: 'frånvaro' },
      { key: 'UserAbsenceList', kind: 'frånvaro' },
    ];
    for (const def of extraLists) {
      const val = me[def.key];
      if (!Array.isArray(val) || !val.length) continue;
      for (const r of val) {
        const datum = String(r.Timestamp || r.Date || r.Day || r.ReportDate || '').substring(0, 10);
        if (!datum || datum.startsWith('0001-')) continue;
        const qty = Number(r.Quantity || r.Hours || r.Amount || 0);
        if (qty > 0) state.tillaggByDate[datum] = (state.tillaggByDate[datum] || 0) + 1;
        state.entries.push({
          id: `${def.key}_${r.Id || r.ClaimsTimeId || r.AbsenceTimeId || Math.random()}`,
          rawId: r.Id || r.ClaimsTimeId || r.AbsenceTimeId,
          kind: def.kind,
          datum,
          tidkod: pick(r, 'TimeTypeName', 'AbsenceTypeName', 'ClaimsTypeName', 'Name') || def.kind,
          order: String(r.ProjectNumber || r.ProjectId || ''),
          projectId: r.ProjectId,
          projekt: r.ProjectName || '',
          text: r.Comment || '',
          antal: qty,
          isWork: false,
          status: r.IsApproved ? 'Klar' : 'Pågående'
        });
      }
    }
  }

  // Commita state till globala variabler + rendera (debouncat) om tidsvyn är öppen.
  // Första commit = visa för användaren (dölj overlay, sätt grön prick).
  // Resten av veckorna fyller på tyst i bakgrunden.
  let __commitRenderTimer = null;
  let __firstCommitDone = false;
  function commitTimeState(state) {
    const seen = new Set();
    timeEntries = state.entries.filter(e => {
      const key = `${e.id}:${e.datum}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    window.__liveWeekInfo = {
      dayTotalsByDate: state.dayTotalsByDate,
      workHoursByDate: state.workHoursByDate,
      tillaggByDate: state.tillaggByDate,
      userName: state.meName,
    };
    window.__liveTimeLoadedAt = Date.now();
    updateTimeLastUpdatedLabel();
    // FÖRSTA commit markerar "laddad" för UX — dölj overlay & grön prick.
    // Övriga veckor renderas sen utan att störa användaren.
    if (!__firstCommitDone && state.entries.length) {
      __firstCommitDone = true;
      if (typeof setTimeLoading === 'function') setTimeLoading(false);
      setTimeNavIndicator('ready');
      console.log('[loadLiveTime] Första commit klar — UX markerad som laddad');
    }
    // Debounce render — flera veckor i rad = bara en render
    if (currentView === 'time') {
      if (__commitRenderTimer) clearTimeout(__commitRenderTimer);
      __commitRenderTimer = setTimeout(() => {
        __commitRenderTimer = null;
        renderTime();
      }, 30);
    }
  }

  // Hämta bilzoner för alla projekt i state.timeEntries.
  // Kallas EN gång efter att alla veckor är klara. Tar bort tidigare bilzon-
  // entries ur state innan vi lägger till nya — undviker dubbletter/missar.
  async function fetchBilzonerForState(state) {
    // Rensa eventuella tidigare bilzon-entries så vi alltid får en färsk bild
    state.entries = state.entries.filter(e => e.kind !== 'bilzon');
    // Räkna om tillaggByDate utan bilzon-bidrag (dvs. backa räkningen för tidigare bilzoner)
    // OBS: tillaggByDate innehåller även tid-tillägg (restid/beredskap) som vi INTE
    // ska nolla. Enklast: räkna om tillaggByDate från scratch baserat på state.entries.
    const rebuiltTillagg = {};
    for (const e of state.entries) {
      if (e.kind === 'tillägg' || e.kind === 'ersättning' || e.kind === 'frånvaro') {
        if (e.datum && e.antal > 0) {
          rebuiltTillagg[e.datum] = (rebuiltTillagg[e.datum] || 0) + 1;
        } else if (e.datum && (e.kind === 'ersättning' || e.kind === 'frånvaro')) {
          rebuiltTillagg[e.datum] = (rebuiltTillagg[e.datum] || 0) + 1;
        }
      }
    }
    state.tillaggByDate = rebuiltTillagg;

    const myProjectIds = new Set();
    for (const e of state.entries) {
      const pid = Number(e.projectId);
      if (pid) myProjectIds.add(pid);
    }
    if (!myProjectIds.size) return;
    console.log(`[loadLiveTime] Hämtar bilzoner för ${myProjectIds.size} projekt (UserId=${state.meId})…`);
    const results = await Promise.all(
      [...myProjectIds].map(pid =>
        window.api?.materials?.list?.(pid, { skipFallback: true })
          .then(r => ({ pid, data: r?.data ?? r }))
          .catch(err => ({ pid, error: err?.message }))
      )
    );
    const projectDisplay = new Map();
    for (const e of state.entries) {
      if (e.projectId && !projectDisplay.has(e.projectId)) {
        projectDisplay.set(e.projectId, { order: e.order, projekt: e.projekt });
      }
    }
    const isBilzon = (m) => {
      const name = (m.Name || m.ArticleName || '').toLowerCase();
      const num = String(m.ArticleNumber || '');
      if (name.includes('bil')) return true;
      if (/^9999(0[1-8])$/.test(num)) return true;
      return false;
    };
    const dateSpanSet = new Set(Object.keys(state.dayTotalsByDate));
    for (const mr of results) {
      const rows = Array.isArray(mr.data?.rows) ? mr.data.rows : [];
      for (const m of rows) {
        const mUserId = m.UserId ?? m.userId;
        if (state.meId && mUserId && mUserId !== state.meId) continue;
        if (!isBilzon(m)) continue;
        const datum = String(m.ReportDate || m.Timestamp || m.Date || '').substring(0, 10);
        if (!datum || !dateSpanSet.has(datum)) continue;
        state.tillaggByDate[datum] = (state.tillaggByDate[datum] || 0) + 1;
        const disp = projectDisplay.get(Number(m.ProjectId || mr.pid)) || {};
        const bilzonId = m.ActualMaterialId || m.Id;
        state.entries.push({
          id: 'bil_' + (bilzonId || Math.random()),
          rawId: m.ActualMaterialId || m.Id,
          kind: 'bilzon',
          datum,
          tidkod: m.Name || m.ArticleName || 'Bilzon',
          order: disp.order || String(m.ProjectId || mr.pid || ''),
          projectId: Number(m.ProjectId || mr.pid) || null,
          projekt: disp.projekt || m.ProjectName || '',
          text: `${m.ArticleNumber || ''}${m.Name ? ' — ' + m.Name : ''}`.trim().replace(/^— /, ''),
          antal: Number(m.ReportedQty || m.Quantity || 0),
          isWork: false,
          status: 'Bilzon'
        });
      }
    }
    console.log(`[loadLiveTime] Bilzoner: ${state.entries.filter(e => e.kind === 'bilzon').length} rader`);
  }

  async function loadLiveTime() {
    // Flagga för att switchView ska veta att preload pågår
    window.__liveTimeLoading = true;
    __firstCommitDone = false;
    setTimeNavIndicator('loading');
    const tStart = performance.now();
    try {
      console.log('[renderer] loadLiveTime() start, calViewDate=', calViewDate.toISOString().slice(0,10));
      const iso = d => d.toISOString().slice(0, 10);

      // Bygg 5 veckor centrerade kring calViewDate
      const centerDate = new Date(calViewDate);
      const centerDay = centerDate.getDay() || 7;
      const centerMonday = new Date(centerDate);
      centerMonday.setDate(centerDate.getDate() - (centerDay - 1));
      const firstMonday = new Date(centerMonday);
      firstMonday.setDate(centerMonday.getDate() - 14);

      const weekSpans = [];
      for (let w = 0; w < 5; w++) {
        const mon = new Date(firstMonday);
        mon.setDate(firstMonday.getDate() + w * 7);
        const sun = new Date(mon);
        sun.setDate(mon.getDate() + 6);
        weekSpans.push({ monday: iso(mon), sunday: iso(sun), idx: w });
      }

      // Cache authStatus så vi slipper göra anropet vid varje reload
      const tAuth = performance.now();
      if (!window.__cachedAuthStatus) {
        window.__cachedAuthStatus = await window.api?.authStatus?.().catch(() => null);
      }
      const status = window.__cachedAuthStatus;
      const userId = status?.user?.UserId || status?.user?.ClientId;
      console.log(`[timing] authStatus: ${Math.round(performance.now()-tAuth)}ms`);

      // Delat state som muteras när svar kommer
      const state = {
        dayTotalsByDate: {},
        workHoursByDate: {},
        tillaggByDate: {},
        entries: [],
        meName: '',
        meId: null,
      };

      // ALLA 5 veckor startas SAMTIDIGT — inga serial-await:s
      const centerIdx = 2;
      const tWeeksStart = performance.now();
      const weekPromises = weekSpans.map((span, i) => {
        const t0 = performance.now();
        return window.api?.time?.getWeek({ startDate: span.monday, endDate: span.sunday })
          .catch(err => ({ ok: false, error: err?.message }))
          .then(resp => {
            console.log(`[timing] vecka ${i} (${span.monday}): ${Math.round(performance.now()-t0)}ms`);
            mergeWeekResponse(resp, span, state, userId);
            commitTimeState(state);
            return { i, span };
          });
      });

      // Vänta bara på att center-veckan är klar för första render
      await weekPromises[centerIdx];
      console.log(`[timing] Center klar efter ${Math.round(performance.now()-tStart)}ms — tidsvyn renderbar nu`);

      // Vänta in alla veckor innan bilzon-hämtning — så alla projekt är kända
      await Promise.allSettled(weekPromises);
      console.log(`[timing] Alla veckor: ${Math.round(performance.now()-tWeeksStart)}ms`);

      // Hämta bilzoner EN gång för alla projekt — tar bort gamla + lägger in färska
      const tBilzon = performance.now();
      try {
        await fetchBilzonerForState(state);
        commitTimeState(state);
        const count = state.entries.filter(e => e.kind === 'bilzon').length;
        console.log(`[timing] bilzoner: ${Math.round(performance.now()-tBilzon)}ms (${count} rader)`);
      } catch (e) { console.warn('bilzoner fail:', e); }

      // Forcera en sista render oavsett debounce
      if (__commitRenderTimer) {
        clearTimeout(__commitRenderTimer);
        __commitRenderTimer = null;
      }
      if (currentView === 'time') renderTime();
      if (typeof setTimeLoading === 'function') setTimeLoading(false);

      console.log(`[renderer] Klart: ${timeEntries.length} tidrader på ${Math.round(performance.now()-tStart)}ms`);
      if (Object.keys(state.dayTotalsByDate).length === 0) {
        showToast('Kunde inte hämta tidsdata för den här månaden', 'warn');
      }
    } catch (e) {
      console.warn('[renderer] Kunde inte ladda live-tid:', e.message);
    } finally {
      window.__liveTimeLoading = false;
      // Göm ready-prick efter 3s (om första commit redan körde blir den redan grön)
      if (window.__liveTimeLoadedAt) {
        setTimeout(() => {
          if (!window.__liveTimeLoading) setTimeNavIndicator('none');
        }, 3000);
      } else {
        setTimeNavIndicator('none');
      }
    }
  }

  // ============================================================
  //  TIDSREGISTRERING — uppdaterad-timestamp + manuell refresh
  // ============================================================
  function updateTimeLastUpdatedLabel() {
    const el = $('#timeLastUpdated');
    if (!el) return;
    const t = window.__liveTimeLoadedAt;
    if (!t) { el.textContent = 'Ej laddad'; return; }
    const d = new Date(t);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const iso = sameDay
      ? `idag ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
      : d.toLocaleString('sv-SE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    el.textContent = `Uppdaterad: ${iso}`;
  }

  // Manuell uppdatera-knapp
  $('#btnRefreshTime')?.addEventListener('click', async () => {
    const btn = $('#btnRefreshTime');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Uppdaterar…';
    setTimeLoading(true);
    try {
      await loadLiveTime();
      renderTime();
      showToast('Tidsregistrering uppdaterad', 'success', 1800);
    } catch (e) {
      showToast('Kunde inte uppdatera: ' + e.message, 'error');
    } finally {
      setTimeLoading(false);
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  // Håll timestamp-etiketten uppdaterad var 30:e sekund (så "idag HH:MM" stämmer)
  setInterval(updateTimeLastUpdatedLabel, 30000);

  // Nav click handlers
  $$('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.dataset.view) {
        switchView(el.dataset.view);
      } else {
        // Group expand toggle
        const group = el.closest('.nav-group');
        if (group) group.classList.toggle('expanded');
      }
    });
  });

  // ============================================================
  //  HEM / DASHBOARD
  // ============================================================
  // ISO-veckoberäkning: måndag-söndag för ett given datum
  function getWeekRange(d) {
    const date = new Date(d);
    date.setHours(0, 0, 0, 0);
    const day = date.getDay() || 7;       // söndag=7
    const mon = new Date(date); mon.setDate(date.getDate() - (day - 1));
    const sun = new Date(mon);  sun.setDate(mon.getDate() + 6);
    const iso = dt => dt.toISOString().slice(0, 10);
    return { mon: iso(mon), sun: iso(sun) };
  }

  // Summera rapporterad tid för en vecka via /time-manage.
  // Returnerar totalen i timmar för inloggad användare (eller alla om ingen hittas).
  async function fetchWeekHoursTotal(startDate, endDate) {
    try {
      const resp = await window.api?.time?.getWeek?.({ startDate, endDate, showSevenDays: true });
      if (!resp?.ok) return 0;
      const data = resp.data ?? resp;
      const users = data?.AllUsersReportTime || [];
      if (!users.length) return 0;
      // Hitta mig — matcha på username/email
      const meName = (window.__meUserName || '').toLowerCase();
      const me = users.find(u => (u.UserName || '').toLowerCase().includes(meName.split('@')[0])) || users[0];
      const list = me?.UserActualTimeList || [];
      return list.reduce((s, r) => s + Number(r.Quantity ?? r.Hours ?? 0), 0);
    } catch (_) {
      return 0;
    }
  }

  function renderHome() {
    const nya = orders.filter(o => o.ny).length;
    const prio = orders.filter(o => o.prio).length;
    const alla = orders.length;
    $('#statNya').textContent = nya;
    $('#statPrio').textContent = prio;
    $('#statAlla').textContent = alla;

    // Placeholder "— / 40" innan async siffror kommit
    if ($('#numCurr').textContent === '' || /\/\s*40$/.test($('#numCurr').textContent) === false) {
      $('#numCurr').textContent = '… / 40';
      $('#numPrev').textContent = '… / 40';
    }
    // Hämta riktiga siffror asynkront
    updateHomeWeekStats();
  }

  async function updateHomeWeekStats() {
    // Cacha uppdatering per 30 sekunder så vi inte flödar API:et
    const now = Date.now();
    if (window.__homeStatsUpdated && now - window.__homeStatsUpdated < 30000) return;
    window.__homeStatsUpdated = now;

    const today = new Date();
    const curr = getWeekRange(today);
    const prevDate = new Date(today); prevDate.setDate(today.getDate() - 7);
    const prev = getWeekRange(prevDate);

    // Cachea username vid första call så vi slipper authStatus varje gång
    if (!window.__meUserName) {
      try {
        const s = await window.api?.authStatus?.();
        window.__meUserName = s?.user?.UserName || s?.user?.FullName || '';
      } catch {}
    }

    const [currH, prevH] = await Promise.all([
      fetchWeekHoursTotal(curr.mon, curr.sun),
      fetchWeekHoursTotal(prev.mon, prev.sun),
    ]);
    $('#numCurr').textContent = `${currH} / 40`;
    $('#numPrev').textContent = `${prevH} / 40`;
    $('#barCurr').style.width = Math.min(100, (currH / 40) * 100) + '%';
    $('#barPrev').style.width = Math.min(100, (prevH / 40) * 100) + '%';
  }

  // ============================================================
  //  ORDERLISTA
  // ============================================================
  function matchesFilter(order) {
    // Textfilter per kolumn
    const inputs = $$('#orderTable .th-filters input');
    for (const inp of inputs) {
      const v = inp.value.trim().toLowerCase();
      if (!v) continue;
      const col = inp.dataset.filterCol;
      const fieldMap = {
        ordernummer: order.nummer,
        kund: order.kund,
        beskrivning: order.beskrivning,
        referens: order.referens,
        projekt: order.projekt
      };
      const value = (fieldMap[col] || '').toString().toLowerCase();
      if (!value.includes(v)) return false;
    }
    // Tabfilter
    if (orderFilter === 'nya') return order.ny;
    if (orderFilter === 'prio') return order.prio;
    if (orderFilter === 'oppna') return order.status !== 'Klar';
    return true;
  }

  function sortOrders(arr) {
    if (!orderSort.col) return arr;
    const col = orderSort.col;
    const dir = orderSort.dir === 'desc' ? -1 : 1;
    return [...arr].sort((a, b) => {
      let av = a[col];
      let bv = b[col];
      // Numerisk sortering för nummer/belopp/startdatum
      if (col === 'belopp' || col === 'nummer' || col === 'projekt') {
        av = Number(av) || 0;
        bv = Number(bv) || 0;
        return (av - bv) * dir;
      }
      // Datum
      if (col === 'startdatum') {
        return String(av || '').localeCompare(String(bv || '')) * dir;
      }
      // Text — locale-medveten, case-insensitive
      return String(av || '').localeCompare(String(bv || ''), 'sv', { sensitivity: 'base' }) * dir;
    });
  }

  function updateSortIndicators() {
    $$('#orderTable .th-labels th.sortable').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === orderSort.col) {
        th.classList.add(orderSort.dir === 'desc' ? 'sort-desc' : 'sort-asc');
      }
    });
  }

  function renderOrders() {
    // Uppdatera tab-badges
    $('#cntAlla').textContent = orders.length;
    $('#cntNya').textContent = orders.filter(o => o.ny).length;
    $('#cntPrio').textContent = orders.filter(o => o.prio).length;

    const tbody = $('#orderTbody');
    tbody.innerHTML = '';
    const rows = sortOrders(orders.filter(matchesFilter));
    updateSortIndicators();
    for (const o of rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = o.nummer;
      if (o.nummer === selectedOrderId) tr.classList.add('selected');
      const flagClass = o.flag ? `flag-dot ${o.flag === 'prio' ? 'prio' : o.flag === 'ok' ? 'ok' : ''}` : '';
      const statusClass =
        o.status === 'Ny' ? 'ny' :
        o.status === 'Pågående' ? 'pagande' :
        o.status === 'Klar' ? 'klar' : '';
      tr.innerHTML = `
        <td><span class="row-expand">▾</span></td>
        <td>${o.flag ? `<span class="${flagClass}"></span>` : ''}</td>
        <td>${o.nummer}</td>
        <td>${o.kund}</td>
        <td>${o.beskrivning}</td>
        <td>${o.referens}</td>
        <td>${o.projekt}</td>
        <td>${o.startdatum}</td>
        <td>${fmtMoney(o.belopp)}</td>
        <td><span class="status-pill ${statusClass}">${o.status}</span></td>
      `;
      tr.addEventListener('click', () => { selectedOrderId = o.nummer; renderOrders(); });
      tr.addEventListener('dblclick', () => openOrderDetail(o.nummer));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showOrderRowContextMenu(e.clientX, e.clientY, o);
      });
      tbody.appendChild(tr);
    }
    $('#postCount').textContent = `${rows.length} poster`;
    $('#pagerText').textContent = `1 / 1`;

    // Aktivera/deaktivera åtgärdsknappar beroende på selection
    $('#btnEditOrder').disabled = !selectedOrderId;
    $('#btnTidOrder').disabled = !selectedOrderId;
  }

  // Tab-klick (orderlistan)
  $$('.tabs .tab[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tabs .tab[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      orderFilter = btn.dataset.filter;
      renderOrders();
    });
  });

  // ============================================================
  //  ORDER-DETALJ
  // ============================================================
  async function openOrderDetail(orderNummer, projectId) {
    const key = String(orderNummer || '');
    // Försök flera matchningstrategier:
    // 1) exakt på nummer (ProjectNumber)
    // 2) jämför ProjectId från _raw
    // 3) om projectId är angivet, sök på det
    let order = orders.find(o => String(o.nummer) === key);
    if (!order && projectId) {
      order = orders.find(o => Number(o._raw?.ProjectId) === Number(projectId));
    }
    if (!order) {
      order = orders.find(o => String(o._raw?.ProjectId) === key || String(o._raw?.ProjectNumber) === key);
    }
    if (!order) {
      // Orderlistan kanske inte är laddad än — vänta kort och försök igen
      if (!orders.length) {
        console.log('[openOrderDetail] Orders tom — väntar på preload…');
        showToast('Laddar orderlistan…', 'info', 2000);
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 200));
          if (orders.length) {
            order = orders.find(o => String(o.nummer) === key)
                 || orders.find(o => Number(o._raw?.ProjectId) === Number(projectId))
                 || orders.find(o => String(o._raw?.ProjectId) === key);
            if (order) break;
          }
        }
      }
    }
    if (!order) {
      // Sista utväg: skapa en minimal order-stub baserat på projectId
      const pid = projectId || (/^\d{5,}$/.test(key) ? Number(key) : null);
      if (pid) {
        console.log('[openOrderDetail] Använder stub för ProjectId', pid);
        order = {
          nummer: String(orderNummer || pid),
          beskrivning: '',
          kund: '',
          _raw: { ProjectId: pid }
        };
      }
    }
    if (!order) {
      console.warn('[openOrderDetail] Hittade ingen order för', { orderNummer, projectId });
      showToast(`Kunde inte hitta order ${orderNummer}${projectId ? ' (ProjectId ' + projectId + ')' : ''}`, 'error');
      return;
    }
    console.log('[openOrderDetail] Öppnar order', order.nummer, 'ProjectId=', order._raw?.ProjectId);
    // Memorera var vi kom ifrån så tillbaka-knappen går tillbaka dit
    if (currentView && currentView !== 'order-detail') {
      window.__previousView = currentView;
    }
    currentView = 'order-detail';
    currentDetailTab = 'time';
    switchView('order-detail');

    // Markera vilken tabb som är aktiv i detaljvyn
    $$('[data-detail-tab]').forEach(b => b.classList.toggle('active', b.dataset.detailTab === 'time'));

    // Initial placeholder medan vi hämtar
    $('#detailTitle').textContent = `${order.nummer} – ${order.beskrivning || ''}`;
    $('#detailSubtitle').textContent = order.kund || '';
    $('#detailAmount').textContent = fmtMoney(order.belopp);
    $('#detailInfo').innerHTML = '<div class="muted">Laddar...</div>';
    $('#detailStatus').innerHTML = '';
    $('#detailThead').innerHTML = '';
    $('#detailTbody').innerHTML = '';
    // Säkerställ spin-keyframes (återanvänds från tidsvyn)
    if (!document.getElementById('__spinStyles')) {
      const style = document.createElement('style');
      style.id = '__spinStyles';
      style.textContent = '@keyframes __spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    }
    const spinnerHtml = '<span class="detail-spinner"></span>';
    $('#cntDetailTime').innerHTML = spinnerHtml;
    $('#cntDetailMaterial').innerHTML = spinnerHtml;
    $('#cntDetailCustInv').innerHTML = spinnerHtml;
    $('#cntDetailSuppInv').innerHTML = spinnerHtml;

    // Sätt upp loading-state innan asynkrona anrop, så "Laddar..." syns direkt
    currentDetailOrder = {
      order,
      nummer: order.nummer,
      beskrivning: order.beskrivning,
      kund: order.kund,
      projectId: order._raw?.ProjectId || order.nummer,
      _raw: order._raw,
      _loading: true,
      _loadingTime: true,
      _loadingMaterial: true,
      _loadingCustInv: true,
      _loadingSuppInv: true,
      _error: null,
      timeRows: [],
      materialRows: [],
      customerInvoices: [],
      supplierInvoices: []
    };
    renderDetailTable();

    try {
      const idForGet = order._raw?.ProjectId || orderNummer;
      const resp = await window.api?.serviceOrders?.get(idForGet);
      const data = resp?.data ?? resp ?? {};
      currentDetailOrder.raw = data;
      console.log('[renderer] order-detalj raw:', data);

      const project = data.project || {};
      const header = data.header || {};
      const amounts = data.amounts || {};

      // Titel + subtitle + belopp
      const projName = pick(project, 'ProjectName', 'Name') || order.beskrivning || '';
      const projNum = pick(project, 'ProjectNumber') || order.nummer;
      $('#detailTitle').textContent = `${projNum} – ${projName}`;
      $('#detailSubtitle').textContent = pick(project, 'CustomerName', 'Client') || order.kund || '';
      const amount = pick(amounts, 'TotalAmount', 'Total', 'Price')
        ?? pick(project, 'Price', 'OfferPrice', 'EstimatedPrice')
        ?? order.belopp;
      $('#detailAmount').textContent = fmtMoney(Number(amount) || 0);

      // Information-kortet
      const adress = pick(project, 'Address', 'DeliveryAddress') || '';
      const stad = pick(project, 'City', 'PostalCity') || '';
      const pl = pick(project, 'ProjectManager', 'ProjectManager2') || '';
      const kund = pick(project, 'CustomerName', 'Client') || order.kund || '';
      $('#detailInfo').innerHTML = `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12.5px;">
          <div style="color:var(--text-dim);">Adress</div><div>${adress || '-'}</div>
          <div style="color:var(--text-dim);">Stad</div><div>${stad || '-'}</div>
          <div style="color:var(--text-dim);">Projektledare</div><div>${pl || '-'}</div>
          <div style="color:var(--text-dim);">Kund</div><div>${kund || '-'}</div>
        </div>`;

      // Status-kortet
      const status = pick(project, 'StatusName', 'Status') || order.status || '';
      const prisTyp = pick(project, 'PriceType', 'PriceTypeName') || '';
      $('#detailStatus').innerHTML = `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12.5px;">
          <div style="color:var(--text-dim);">Status</div><div>${status || '-'}</div>
          <div style="color:var(--text-dim);">Pris-typ</div><div>${prisTyp || '-'}</div>
        </div>`;

      // Hämta tidrader + material parallellt via dedikerade endpoints
      // Varje promise markerar sin egen flagga klar så UI:t uppdateras inkrementellt
      const timeP = (window.api?.serviceOrders?.timeEntries?.(idForGet) || Promise.resolve(null))
        .catch(e => ({ ok: false, error: e.message }));
      const matP = (window.api?.materials?.list?.(idForGet) || Promise.resolve(null))
        .catch(e => ({ ok: false, error: e.message }));
      const custP = (window.api?.invoices?.customer?.(idForGet) || Promise.resolve(null))
        .catch(() => null);
      const suppP = (window.api?.invoices?.supplier?.(idForGet) || Promise.resolve(null))
        .catch(() => null);

      // Uppdatera tid-fliken så snart tidsdata är tillbaka.
      // Ny endpoint returnerar { rows[], tasks[], projectId } — rows är primära.
      timeP.then(timeResp => {
        const raw = timeResp?.data ?? timeResp;
        let rows = Array.isArray(raw?.rows) ? raw.rows : [];
        if (!rows.length) {
          // Fallback: gamla task-hierarkin
          const timeTasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
          rows = timeTasks.flatMap(t => t.TimeRecords || t.ActualTimes || t.ActualTimeList || []);
        }
        currentDetailOrder.timeRows = rows;
        currentDetailOrder._loadingTime = false;
        if (currentDetailTab === 'time') renderDetailTable();
        else $('#cntDetailTime').textContent = currentDetailOrder.timeRows.length;
      });

      matP.then(matResp => {
        const matRaw = matResp?.data ?? matResp;
        // Nya endpointen returnerar { rows, projectId, tasks, allMaterials }
        // där rows är den primära källan (POST /projects/reported-user-materials).
        let rows = Array.isArray(matRaw?.rows) ? matRaw.rows : [];

        // Bakåtkompat: om rows saknas, försök extrahera från gamla fält
        if (!rows.length) {
          const nested = (Array.isArray(matRaw?.tasks) ? matRaw.tasks : [])
            .flatMap(t => Array.isArray(t.Materials) ? t.Materials : []);
          const global = (Array.isArray(matRaw?.allMaterials) ? matRaw.allMaterials : [])
            .filter(m => String(m.ProjectId) === String(matRaw?.projectId ?? idForGet));
          const seen = new Set();
          rows = [...nested, ...global].filter(m => {
            const k = m.ActualMaterialId || m.Id || JSON.stringify(m).slice(0, 50);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }

        currentDetailOrder.materialRows = rows;
        console.log(`[renderer] material: ${rows.length} rader (primär rows-fält)`);
        currentDetailOrder._loadingMaterial = false;
        if (currentDetailTab === 'material') renderDetailTable();
        else $('#cntDetailMaterial').textContent = currentDetailOrder.materialRows.length;
      });

      custP.then(custInv => {
        currentDetailOrder.customerInvoices = (custInv?.data?.Rows ?? custInv?.Rows ?? []);
        currentDetailOrder._loadingCustInv = false;
        $('#cntDetailCustInv').textContent = currentDetailOrder.customerInvoices.length;
        if (currentDetailTab === 'customerInvoice') renderDetailTable();
      });

      suppP.then(suppInv => {
        currentDetailOrder.supplierInvoices = (suppInv?.data?.Rows ?? suppInv?.Rows ?? []);
        currentDetailOrder._loadingSuppInv = false;
        $('#cntDetailSuppInv').textContent = currentDetailOrder.supplierInvoices.length;
        if (currentDetailTab === 'supplierInvoice') renderDetailTable();
      });

      // Vänta på alla fyra så vi kan summera och släcka globalt _loading
      await Promise.all([timeP, matP, custP, suppP]);
      currentDetailOrder._loading = false;
      console.log(`[renderer] order-detalj: ${currentDetailOrder.timeRows.length} tidrader, ${currentDetailOrder.materialRows.length} material`);
      console.log(`[renderer] fakturor: ${currentDetailOrder.customerInvoices.length} kund, ${currentDetailOrder.supplierInvoices.length} lev`);
      renderDetailTable();
    } catch (e) {
      console.error('[renderer] Kunde inte hämta orderdetalj:', e);
      $('#detailInfo').innerHTML = `<div class="muted">Kunde inte hämta detaljer: ${e.message}</div>`;
      if (currentDetailOrder) {
        currentDetailOrder._loading = false;
        currentDetailOrder._loadingTime = false;
        currentDetailOrder._loadingMaterial = false;
        currentDetailOrder._loadingCustInv = false;
        currentDetailOrder._loadingSuppInv = false;
        currentDetailOrder._error = e.message || 'Okänt fel';
      }
      $('#cntDetailTime').textContent = '0';
      $('#cntDetailMaterial').textContent = '0';
      $('#cntDetailCustInv').textContent = '0';
      $('#cntDetailSuppInv').textContent = '0';
      renderDetailTable();
    }
  }

  function renderDetailTable() {
    const timeRows = currentDetailOrder?.timeRows || [];
    const materialRows = currentDetailOrder?.materialRows || [];

    const thead = $('#detailThead');
    const tbody = $('#detailTbody');

    // Global fel-state: visa felmeddelande i stället för evigt laddande
    if (currentDetailOrder?._error) {
      const colspan = currentDetailTab === 'time' ? 5 : 6;
      thead.innerHTML = '';
      tbody.innerHTML = `<tr><td colspan="${colspan}" style="padding:24px;text-align:center;color:var(--danger,#c0392b);">Kunde inte hämta data: ${currentDetailOrder._error}</td></tr>`;
      return;
    }

    // Avgör om aktiv flik laddar (per-tab spinner)
    const tabLoadingMap = {
      time: currentDetailOrder?._loadingTime,
      material: currentDetailOrder?._loadingMaterial,
      customerInvoice: currentDetailOrder?._loadingCustInv,
      supplierInvoice: currentDetailOrder?._loadingSuppInv
    };
    const activeTabLoading = tabLoadingMap[currentDetailTab];

    if (currentDetailOrder?._loading || activeTabLoading) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;"><span class="detail-spinner"></span> Laddar...</td></tr>';
      // Behåll thead tomt medan vi laddar så kolumnrubriker inte blinkar in/ut
      if (!thead.innerHTML) thead.innerHTML = '';
      return;
    }

    $('#cntDetailTime').textContent = Array.isArray(timeRows) ? timeRows.length : 0;
    $('#cntDetailMaterial').textContent = Array.isArray(materialRows) ? materialRows.length : 0;

    if (currentDetailTab === 'time') {
      thead.innerHTML = `<tr class="th-labels"><th>Datum</th><th>Användare</th><th>Aktivitet</th><th>Tidkod</th><th>Antal</th><th>Kommentar</th></tr>`;
      tbody.innerHTML = (Array.isArray(timeRows) ? timeRows : []).map(r => `
        <tr>
          <td>${(pick(r, 'ReportDate', 'Timestamp', 'Date') || '').toString().substring(0,10)}</td>
          <td>${pick(r, 'UserName', 'Name') || ''}</td>
          <td>${pick(r, 'TaskName', 'ProjectTaskName') || ''}</td>
          <td>${pick(r, 'TimeTypeName') || (r.TimeTypeId === 0 ? 'Arbetstid' : '') || ''}</td>
          <td>${Number(pick(r, 'Quantity', 'Hours') || 0)}</td>
          <td>${pick(r, 'Comment', 'Text') || ''}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted" style="padding:16px;">Inga tidrader</td></tr>';
    } else if (currentDetailTab === 'material') {
      thead.innerHTML = `<tr class="th-labels"><th>Datum</th><th>Användare</th><th>Material</th><th>Artikelnr</th><th>Antal</th><th>Enhet</th><th>Pris</th><th style="width:36px;"></th></tr>`;
      tbody.innerHTML = (Array.isArray(materialRows) ? materialRows : []).map(r => {
        const matId = r.ActualMaterialId || r.Id || 0;
        return `<tr>
          <td>${(pick(r, 'Timestamp', 'Date', 'TimestampString', 'ReportedDate', 'RegistrationDate', 'CreatedDate', 'ReportDate') || '').toString().substring(0,10)}</td>
          <td>${pick(r, 'UserName', 'ReporterName', 'ReportedByName', 'Name') || ''}</td>
          <td>${pick(r, 'ArticleName', 'MaterialName', 'ProductName', 'Description', 'Name') || ''}</td>
          <td>${pick(r, 'ArticleNumber', 'ArticleNr', 'ProductNumber', 'MaterialNumber') || ''}</td>
          <td>${Number(pick(r, 'ReportedQty', 'Quantity', 'Qty', 'Amount') || 0)}</td>
          <td>${pick(r, 'MaterialUnitCode', 'UnitCode', 'Unit') || ''}</td>
          <td>${fmtMoney(Number(pick(r, 'Price', 'UnitPrice', 'SalesPrice') || 0))}</td>
          <td style="text-align:center;">${matId ? `<button class="icon-btn mat-del" data-mat-id="${matId}" title="Ta bort" style="background:transparent;border:none;cursor:pointer;color:var(--danger,#ef4444);font-size:14px;">🗑</button>` : ''}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="8" class="muted" style="padding:16px;">Inget material på ordern</td></tr>';
    } else if (currentDetailTab === 'customerInvoice') {
      const rows = currentDetailOrder?.customerInvoices || [];
      thead.innerHTML = `<tr class="th-labels"><th>Nummer</th><th>Namn</th><th>Datum</th><th>Förfall</th><th>Belopp</th><th>Status</th></tr>`;
      tbody.innerHTML = rows.map(r => `
        <tr data-invoice-id="${r.InvoiceId}" data-invoice-type="customer" style="cursor:pointer;">
          <td>${r.InvoiceNumber || ''}</td>
          <td>${r.Name || ''}</td>
          <td>${(r.InvoiceDate||'').substring(0,10)}</td>
          <td>${(r.DueDate||'').substring(0,10)}</td>
          <td>${fmtMoney(Number(r.Amount)||0)}</td>
          <td>${r.PaidInFull ? 'Betald' : 'Obetald'}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted" style="padding:16px;">Inga kundfakturor</td></tr>';
    } else if (currentDetailTab === 'supplierInvoice') {
      const rows = currentDetailOrder?.supplierInvoices || [];
      thead.innerHTML = `<tr class="th-labels"><th>Nummer</th><th>Namn</th><th>Datum</th><th>Förfall</th><th>Belopp</th><th>Status</th></tr>`;
      tbody.innerHTML = rows.map(r => `
        <tr data-invoice-id="${r.InvoiceId}" data-invoice-type="supplier" style="cursor:pointer;">
          <td>${r.InvoiceNumber || ''}</td>
          <td>${r.Name || ''}</td>
          <td>${(r.InvoiceDate||'').substring(0,10)}</td>
          <td>${(r.DueDate||'').substring(0,10)}</td>
          <td>${fmtMoney(Number(r.Amount)||0)}</td>
          <td>${r.PaidInFull ? 'Betald' : 'Obetald'}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted" style="padding:16px;">Inga leverantörsfakturor</td></tr>';
    }
  }

  // Tab-klick (detaljvyns flikar)
  $$('[data-detail-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentDetailTab = btn.dataset.detailTab;
      $$('[data-detail-tab]').forEach(b => b.classList.toggle('active', b === btn));
      updateDetailContextButtons();
      renderDetailTable();
    });
  });

  function updateDetailContextButtons() {
    const addTimeBtn = $('#btnDetailAddTime');
    const addMatBtn = $('#btnDetailAddMaterial');
    if (addTimeBtn) addTimeBtn.hidden = currentDetailTab !== 'time';
    if (addMatBtn) addMatBtn.hidden = currentDetailTab !== 'material';
  }

  // "+ Lägg till tid" på orderdetalj — öppnar modalTime med kundorder förvalt
  $('#btnDetailAddTime')?.addEventListener('click', () => {
    if (!currentDetailOrder) { showToast('Ingen order vald', 'error'); return; }
    editingTimeId = null;
    $('#modalTime .modal-head h2').textContent = 'Tidsregistrering';
    const today = new Date().toISOString().slice(0, 10);
    const orderNr = currentDetailOrder.nummer || '';
    openModal('modalTime', {
      datum: today, anstalld: '106', antal: '', tidkod: '010',
      resultatenhet: '50',
      kundorder: orderNr
    });
    // Visa beskrivning i kundorder-hint
    if ($('#kundorderHint')) {
      $('#kundorderHint').textContent = currentDetailOrder.beskrivning || currentDetailOrder.kund || '';
    }
    if (typeof switchModalTab === 'function') switchModalTab('form');
    loadSnabbvalArticles();
    setTimeout(() => { const el = $('#inputAntal'); if (el) { el.focus(); el.select(); } }, 100);
  });

  // "+ Lägg till rad" på material-fliken — skapar inline-editerbar rad
  $('#btnDetailAddMaterial')?.addEventListener('click', () => {
    if (!currentDetailOrder) { showToast('Ingen order vald', 'error'); return; }
    // Förladda snabbval om det inte redan är gjort (ger instant-träffar i sök)
    loadSnabbvalArticles();
    addInlineMaterialRow();
  });

  // ============================================================
  //  INLINE MATERIAL-EDITOR (på order-detalj)
  //  + Lägg till rad -> ny tom rad med inputs för artnr/antal/enhet/pris
  //  Flöde: skriv artnr -> dropdown -> Enter/välj -> autofyll -> Enter i antal -> spara
  // ============================================================
  function addInlineMaterialRow() {
    const tbody = $('#detailTbody');
    if (!tbody) return;
    // Om en editor redan är öppen, fokusera den
    const existing = tbody.querySelector('tr.mat-edit-row');
    if (existing) {
      existing.querySelector('.mat-artnr')?.focus();
      return;
    }
    // Individuell td per kolumn så de alignerar mot headern:
    // Datum | Användare | Material | Artikelnr | Antal | Enhet | Pris | [del]
    const today = new Date().toISOString().slice(0,10);
    const me = window.__meUserName || 'Jag';
    const inpStyle = 'width:100%;padding:3px 6px;font-size:12.5px;box-sizing:border-box;';
    const tr = document.createElement('tr');
    tr.className = 'mat-edit-row';
    tr.style.background = 'rgba(59,130,246,.08)';
    tr.innerHTML = `
      <td style="color:var(--text-dim);white-space:nowrap;">${today}</td>
      <td style="color:var(--text-dim);white-space:nowrap;">${me}</td>
      <td><input class="mat-name" type="text" placeholder="Benämning (sök…)" autocomplete="off" style="${inpStyle}" /></td>
      <td>
        <input class="mat-artnr" type="text" placeholder="Artnr eller sökord" autocomplete="off" style="${inpStyle}" />
      </td>
      <td><input class="mat-antal" type="number" step="any" min="0" placeholder="0" style="${inpStyle}" /></td>
      <td><input class="mat-enhet" type="text" placeholder="st" style="${inpStyle}" /></td>
      <td><input class="mat-pris" type="number" step="0.01" placeholder="0" style="${inpStyle}" /></td>
      <td style="white-space:nowrap;">
        <button class="icon-btn mat-save" title="Spara" style="background:transparent;border:none;color:var(--success,#10b981);cursor:pointer;font-size:15px;padding:2px 4px;">✓</button>
        <button class="icon-btn mat-cancel" title="Avbryt" style="background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:15px;padding:2px 4px;">✕</button>
      </td>`;
    tbody.insertBefore(tr, tbody.firstChild);

    // Dölj "Inget material"-raden om den finns
    const emptyRow = tbody.querySelector('tr td.muted');
    if (emptyRow) emptyRow.closest('tr').remove();

    // Datastruktur för denna rad
    const state = { articleId: 0, articleNumber: '', matched: null };
    const artnrInp = tr.querySelector('.mat-artnr');
    const nameInp = tr.querySelector('.mat-name');

    // Aktuell aktiv sök-input — uppdateras när man fokuserar artnr eller namn.
    // Samma dropdown används för båda fälten och positioneras under den aktiva.
    let activeInput = artnrInp;

    // Skapa dropdown som ett fritt element i body så den inte klipps av
    // table-wrap:s overflow. Positioneras med fixed mot inputens rect.
    const dropdown = document.createElement('div');
    dropdown.className = 'mat-artnr-dd';
    dropdown.hidden = true;
    // Hög kontrast: vit bakgrund + mörk text så det blir läsbart oavsett tema
    Object.assign(dropdown.style, {
      position: 'fixed',
      minWidth: '340px',
      maxWidth: '520px',
      background: '#ffffff',
      color: '#1a1a1a',
      border: '1px solid #c9ced6',
      maxHeight: '300px',
      overflow: 'auto',
      zIndex: '10000',
      boxShadow: '0 6px 18px rgba(0,0,0,.25)',
      borderRadius: '4px',
      fontFamily: 'inherit',
    });
    document.body.appendChild(dropdown);

    const positionDropdown = () => {
      const r = activeInput.getBoundingClientRect();
      dropdown.style.top = (r.bottom + 2) + 'px';
      dropdown.style.left = r.left + 'px';
      dropdown.style.minWidth = Math.max(340, r.width) + 'px';
    };

    // Städa upp dropdownen när raden tas bort
    const cleanupDropdown = () => { dropdown.remove(); };
    const antalInp = tr.querySelector('.mat-antal');
    const enhetInp = tr.querySelector('.mat-enhet');
    const prisInp = tr.querySelector('.mat-pris');
    const saveBtn = tr.querySelector('.mat-save');
    const cancelBtn = tr.querySelector('.mat-cancel');

    let searchTimer = null;
    let searchSeq = 0;

    // Hjälp: filtrera lokal snabbval-cache efter artikelnr eller namn.
    // Detta ger instant-träffar innan servern svarar.
    const searchLocal = (kw) => {
      const q = (kw || '').toLowerCase();
      if (!q) return [];
      return (snabbvalArticles || []).filter(a =>
        (a.ArticleNumber || '').toLowerCase().includes(q) ||
        (a.Name || '').toLowerCase().includes(q)
      );
    };

    const renderArts = (arts, label) => {
      if (!arts.length) return '';
      return arts.map((a, i) => `
        <div class="mat-art-item" data-idx="${i}" style="padding:7px 12px;cursor:pointer;border-bottom:1px solid #e4e7ec;font-size:12.5px;color:#1a1a1a;">
          <div style="font-weight:600;color:#0b3d91;">${a.ArticleNumber || ''} — <span style="color:#1a1a1a;">${a.Name || '(utan namn)'}</span></div>
          <div style="color:#667085;font-size:11.5px;margin-top:1px;">${a.UnitCode || 'st'}${a.SalesPrice ? ' · ' + a.SalesPrice + ' kr' : ''}${label ? ' · ' + label : ''}</div>
        </div>`).join('');
    };

    const doSearch = async () => {
      const kw = activeInput.value.trim();
      if (!kw) {
        // Tom sökruta: visa snabbval-listan direkt (instant top 50)
        const arts = snabbvalArticles || [];
        if (!arts.length) {
          dropdown.innerHTML = '<div style="padding:10px 12px;color:#667085;font-size:12px;">Skriv artikelnr eller namn…</div>';
        } else {
          dropdown.innerHTML = `<div style="padding:6px 12px 3px;font-size:10.5px;color:#667085;text-transform:uppercase;letter-spacing:.6px;font-weight:600;background:#f7f8fa;">Snabbval</div>${renderArts(arts)}`;
          dropdown.__arts = arts;
        }
        positionDropdown(); dropdown.hidden = false;
        return;
      }

      // 1) Visa lokala träffar direkt (instant)
      const localArts = searchLocal(kw);
      if (localArts.length) {
        dropdown.innerHTML = renderArts(localArts, 'snabbval') + '<div style="padding:4px 10px;font-size:11px;color:var(--text-dim);">Söker fler…</div>';
        dropdown.__arts = localArts;
        positionDropdown(); dropdown.hidden = false;
      } else {
        dropdown.innerHTML = '<div style="padding:10px 12px;color:#667085;font-size:12px;">Söker…</div>';
        positionDropdown(); dropdown.hidden = false;
      }

      // 2) Servern kräver minst 3 tecken enligt capture från Projektportalen
      if (kw.length < 3) {
        if (!localArts.length) {
          dropdown.innerHTML = '<div style="padding:10px 12px;color:#667085;font-size:12px;">Skriv minst 3 tecken för att söka…</div>';
        }
        return;
      }

      // 3) Fråga servern om bredare träffar
      const mySeq = ++searchSeq;
      try {
        const resp = await window.api?.articles?.search?.({ keyword: kw, top: 30 });
        if (mySeq !== searchSeq) return; // stale, användaren har skrivit mer
        if (!resp?.ok) {
          if (!localArts.length) {
            dropdown.innerHTML = `<div style="padding:10px 12px;color:#d92d20;font-size:12px;background:#fef3f2;">Sökfel: ${resp?.error || 'okänt fel'}</div>`;
          }
          console.warn('[inline-mat] search error:', resp?.error);
          return;
        }
        const data = resp.data;
        const serverArts = (Array.isArray(data) ? data : data?.Articles) || [];
        // Slå ihop lokala och server-träffar, dedup på ArticleId
        const seen = new Set(localArts.map(a => a.ArticleId));
        const merged = [...localArts];
        for (const a of serverArts) {
          const id = a.ArticleId || a.id;
          if (!seen.has(id)) { merged.push(a); seen.add(id); }
        }
        console.log(`[inline-mat] kw="${kw}" → local=${localArts.length} server=${serverArts.length} merged=${merged.length}`);
        if (!merged.length) {
          dropdown.innerHTML = '<div style="padding:10px 12px;color:#667085;font-size:12px;">Inga träffar för "' + kw + '"</div>';
          return;
        }
        dropdown.__arts = merged;
        const localHtml = localArts.length ? `<div style="padding:6px 12px 3px;font-size:10.5px;color:#667085;text-transform:uppercase;letter-spacing:.6px;font-weight:600;background:#f7f8fa;">Snabbval</div>${renderArts(localArts)}` : '';
        const remote = merged.slice(localArts.length);
        const remoteHtml = remote.length ? `<div style="padding:6px 12px 3px;font-size:10.5px;color:#667085;text-transform:uppercase;letter-spacing:.6px;font-weight:600;background:#f7f8fa;">Alla artiklar</div>${renderArts(remote).replace(/data-idx="(\d+)"/g, (m, i) => `data-idx="${Number(i) + localArts.length}"`)}` : '';
        dropdown.innerHTML = localHtml + remoteHtml;
      } catch (e) {
        if (!localArts.length) {
          dropdown.innerHTML = `<div style="padding:10px 12px;color:#d92d20;font-size:12px;background:#fef3f2;">Sökfel: ${e.message}</div>`;
        }
        console.warn('[inline-mat] search exception:', e);
      }
    };
    // Bind sök-listeners på båda input-fälten (artnr och benämning)
    const bindSearchTo = (inp) => {
      inp.addEventListener('focus', () => { activeInput = inp; doSearch(); });
      inp.addEventListener('input', () => {
        activeInput = inp;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(doSearch, 200);
      });
      inp.addEventListener('blur', () => setTimeout(() => { dropdown.hidden = true; }, 200));
    };
    bindSearchTo(artnrInp);
    bindSearchTo(nameInp);

    // Håll position synk vid scroll i tabellen
    const scrollParents = [];
    let el = artnrInp.parentElement;
    while (el && el !== document.body) { scrollParents.push(el); el = el.parentElement; }
    scrollParents.push(window);
    const onScroll = () => { if (!dropdown.hidden) positionDropdown(); };
    scrollParents.forEach(p => p.addEventListener('scroll', onScroll, { passive: true }));
    window.addEventListener('resize', onScroll);

    const pickArticle = async (a) => {
      state.articleId = a.ArticleId || a.id || 0;
      state.articleNumber = a.ArticleNumber || '';
      state.matched = a;
      artnrInp.value = a.ArticleNumber || '';
      nameInp.value = a.Name || '';
      enhetInp.value = a.UnitCode || 'st';
      prisInp.value = Number(a.SalesPrice || 0);
      dropdown.hidden = true;
      setTimeout(() => antalInp.focus(), 10);

      // Hämta korrekt pris + UnitId från projektets prislista
      // (snabbval/search returnerar ofta SalesPrice: 0)
      const pid = currentDetailOrder?.projectId || currentDetailOrder?._raw?.ProjectId;
      if (!pid || !state.articleId) return;
      try {
        const resp = await window.api?.articles?.salesprice?.(state.articleId, pid);
        if (!resp?.ok || !resp.data) return;
        const d = resp.data;
        // Uppdatera UI med riktigt pris + enhet från servern
        const realPrice = Number(d.Price || 0);
        if (realPrice > 0) prisInp.value = realPrice;
        if (d.UnitName && !enhetInp.value) enhetInp.value = d.UnitName;
        // Spara hela svaret för save-handler (använder MaterialUnitId, PurchasePrice)
        state.priceDetails = d;
        console.log(`[inline-mat] pris för ${state.articleNumber}: ${realPrice} kr (UnitId ${d.UnitId})`);
      } catch (e) {
        console.warn('[inline-mat] salesprice-fetch failed:', e);
      }
    };
    dropdown.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.mat-art-item');
      if (!item) return;
      e.preventDefault();
      const idx = Number(item.dataset.idx);
      const a = dropdown.__arts?.[idx];
      if (a) pickArticle(a);
    });
    // Hover-highlight
    dropdown.addEventListener('mouseover', (e) => {
      const item = e.target.closest('.mat-art-item');
      if (!item) return;
      dropdown.querySelectorAll('.mat-art-item').forEach(el => { el.style.background = ''; });
      item.style.background = '#eef2ff';
    });

    // Enter-navigering: artnr/namn -> antal -> spara
    // Gemensam handler så man kan söka och välja i båda fälten
    const searchFieldEnter = (inp) => (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const arts = dropdown.__arts || [];
        const val = inp.value.trim().toLowerCase();
        // Först: exakt artikelnr-match
        let match = arts.find(a => String(a.ArticleNumber || '').toLowerCase() === val);
        // Sedan: exakt namn-match
        if (!match) match = arts.find(a => String(a.Name || '').toLowerCase() === val);
        // Om bara en träff totalt
        if (!match && arts.length === 1) match = arts[0];
        if (match) pickArticle(match);
        else antalInp.focus();
      } else if (e.key === 'Escape') {
        removeEditRow();
      }
    };
    artnrInp.addEventListener('keydown', searchFieldEnter(artnrInp));
    nameInp.addEventListener('keydown', searchFieldEnter(nameInp));
    antalInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
      else if (e.key === 'Escape') removeEditRow();
    });
    prisInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    });

    // Helper: ta bort editerings-raden OCH städa dropdown + scroll-listeners
    const removeEditRow = () => {
      cleanupDropdown();
      scrollParents.forEach(p => p.removeEventListener('scroll', onScroll));
      window.removeEventListener('resize', onScroll);
      tr.remove();
    };
    cancelBtn.addEventListener('click', removeEditRow);

    saveBtn.addEventListener('click', async () => {
      const antal = Number(antalInp.value || 0);
      if (!antal || antal <= 0) { showToast('Ange antal > 0', 'error'); antalInp.focus(); return; }
      const pid = currentDetailOrder?.projectId || currentDetailOrder?._raw?.ProjectId;
      if (!pid) { showToast('Saknar ProjectId för ordern', 'error'); return; }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Sparar…';
      try {
        const pd = state.priceDetails || {};
        const resp = await window.api?.materials?.create?.({
          projectId: pid,
          articleId: state.articleId,
          articleNumber: state.articleNumber || artnrInp.value.trim(),
          benamning: nameInp.value.trim(),
          antal,
          enhet: enhetInp.value.trim() || pd.UnitName || 'st',
          // Korrekt MaterialUnitId krävs av servern (hittat via Chrome-capture)
          materialUnitId: Number(pd.UnitId || state.matched?.UnitId || 0),
          prisPerEnhet: Number(prisInp.value || 0),
          kostnad: 0,
          purchasePrice: Number(pd.PurchasePrice || state.matched?.PurchasePrice || 0) || Number(prisInp.value || 0),
          discount: Number(pd.Discount || 0),
          debiterbar: true,
        });
        if (!resp?.ok) throw new Error(resp?.error || '?');
        showToast(`${nameInp.value} × ${antal} tillagd`, 'success');
        // Städa dropdown + lyssnare och ladda om material-tabben
        cleanupDropdown();
        scrollParents.forEach(p => p.removeEventListener('scroll', onScroll));
        window.removeEventListener('resize', onScroll);
        reloadDetailMaterials();
        // Uppdatera även kalendern i bakgrunden — om bilzon matchar
        // filtret syns den i tidsregistreringens cache
        loadLiveTime().then(() => { if (currentView === 'time') renderTime(); });
      } catch (e) {
        showToast('Kunde inte spara: ' + e.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Spara';
      }
    });

    setTimeout(() => artnrInp.focus(), 30);
  }

  async function reloadDetailMaterials() {
    if (!currentDetailOrder) return;
    const pid = currentDetailOrder.projectId || currentDetailOrder._raw?.ProjectId;
    if (!pid) return;
    try {
      const resp = await window.api?.materials?.list?.(pid);
      const raw = resp?.data ?? resp;
      const rows = Array.isArray(raw?.rows) ? raw.rows : [];
      currentDetailOrder.materialRows = rows;
      renderDetailTable();
    } catch (e) {
      console.warn('reloadDetailMaterials:', e);
    }
  }

  // Klick på 🗑-ikoner för att ta bort material
  $('#detailTbody')?.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('.mat-del');
    if (!delBtn) return;
    const id = Number(delBtn.dataset.matId);
    if (!id) return;
    if (!confirm('Ta bort denna material-rad?')) return;
    delBtn.disabled = true;
    try {
      const resp = await window.api?.materials?.delete?.(id);
      if (!resp?.ok) throw new Error(resp?.error || '?');
      showToast('Material borttaget', 'success');
      reloadDetailMaterials();
    } catch (err) {
      showToast('Kunde inte ta bort: ' + err.message, 'error');
      delBtn.disabled = false;
    }
  });

  // Sätt initialt rätt knappar när detail-vyn visas
  updateDetailContextButtons();

  // Klick på en faktura-rad öppnar PDF-viewer
  $('#detailTbody')?.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-invoice-id]');
    if (!tr) return;
    const id = tr.dataset.invoiceId;
    const type = tr.dataset.invoiceType;
    const rows = type === 'customer'
      ? currentDetailOrder?.customerInvoices || []
      : currentDetailOrder?.supplierInvoices || [];
    const row = rows.find(r => String(r.InvoiceId) === String(id));
    if (!row) return;

    const title = `Faktura ${row.InvoiceNumber || id} (${type === 'customer' ? 'Kund' : 'Leverantör'})`;
    const frame = $('#pdfViewerFrame');
    const titleEl = $('#pdfViewerTitle');
    const modal = $('#modalPdfViewer');

    // 1) Direkt-URL från raden (Azure Blob för kundfakturor, vissa lev)
    let url = row?.FileUrl || row?.InvoiceFileUrl || row?.ImageUrl || row?.BlobUrl
           || row?.InvoicePicture || row?.BinaryObjectUrl;

    // Fortnox-länkar pekar mot fortnox.se/3/supplierinvoices/... och är INTE PDF,
    // så de ska inte visas direkt i iframe.
    const looksLikePdf = (u) => {
      if (!u || typeof u !== 'string') return false;
      if (/fortnox\.se/i.test(u)) return false; // Fortnox API-länkar är inte PDF
      return /\.pdf(\?|$)/i.test(u)
          || /blob\.core\.windows\.net/i.test(u)
          || /image|download|pdf/i.test(u);
    };

    // 2) Visa loading-placeholder direkt så användaren ser att vi försöker
    titleEl.textContent = title;
    modal.hidden = false;

    if (looksLikePdf(url)) {
      frame.src = url;
      return;
    }

    // 3) Försök hämta via IPC. Skicka med hela radens metadata så main
    //    kan välja rätt endpoint (t.ex. Fortnox-integration för lev-fakturor).
    frame.src = 'about:blank';
    const prevTitle = titleEl.textContent;
    titleEl.textContent = prevTitle + ' — laddar PDF…';
    try {
      const meta = {
        integrationInformationId: row.IntegrationInformationId,
        givenNumber: row.GivenNumber,
        fileUrl: row.FileUrl,
        invoiceFileUrl: row.InvoiceFileUrl,
        invoicePicture: row.InvoicePicture,
        binaryObjectUrl: row.BinaryObjectUrl,
        vismaId: row.VismaId,
        thirdPartyId: row.ThirdPartyId,
      };
      const resp = await window.api?.invoices?.pdf?.(id, type, meta);
      // main returnerar { ok, dataUrl | path | error }
      const pdfUrl = resp?.dataUrl || resp?.url || resp?.path;
      if (resp?.ok && pdfUrl) {
        frame.src = pdfUrl;
        titleEl.textContent = title;
        return;
      }
      throw new Error(resp?.error || 'Kunde inte hämta PDF');
    } catch (err) {
      titleEl.textContent = title;
      modal.hidden = true;
      alert(`Ingen PDF kunde hämtas: ${err.message || 'okänt fel'}`);
    }
  });

  // Tillbaka-knapp — gå tillbaka till vyn man kom ifrån (default: orders)
  $('#btnBackToList')?.addEventListener('click', () => {
    const back = window.__previousView || 'orders';
    window.__previousView = null;
    switchView(back);
  });

  // Kolumn-sortering
  $$('#orderTable .th-labels th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (orderSort.col === col) {
        orderSort.dir = orderSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        orderSort.col = col;
        orderSort.dir = 'asc';
      }
      renderOrders();
    });
  });

  // Sök-input
  $$('#orderTable .th-filters input').forEach(inp => {
    inp.addEventListener('input', renderOrders);
  });

  // ============================================================
  //  KUNDLISTA
  // ============================================================
  function renderCustomers() {
    const filters = {};
    $$('#customerTable .th-filters input').forEach(i => {
      filters[i.dataset.filterCol] = i.value.trim().toLowerCase();
    });
    const rows = customers.filter(c => {
      return (!filters.kundnummer || c.kundnummer.toLowerCase().includes(filters.kundnummer))
          && (!filters.namn || c.namn.toLowerCase().includes(filters.namn))
          && (!filters.ort || (c.ort || '').toLowerCase().includes(filters.ort));
    });

    const tbody = $('#customerTbody');
    tbody.innerHTML = '';
    for (const c of rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = c.kundnummer;
      if (c.kundnummer === selectedCustomerId) tr.classList.add('selected');
      tr.innerHTML = `
        <td><span class="row-expand">▾</span></td>
        <td>${c.kundnummer}</td>
        <td>${c.namn}</td>
        <td>${c.orgnr || ''}</td>
        <td>${c.ort || ''}</td>
        <td>${c.telefon || ''}</td>
        <td>${c.epost || ''}</td>
        <td>${c.kundgrupp || ''}</td>
      `;
      tr.addEventListener('click', () => {
        selectedCustomerId = c.kundnummer;
        renderCustomers();
      });
      tbody.appendChild(tr);
    }
    $('#custPostCount').textContent = `${rows.length} poster`;
    $('#btnEditCustomer').disabled = !selectedCustomerId;
  }

  $$('#customerTable .th-filters input').forEach(i => i.addEventListener('input', renderCustomers));

  // ============================================================
  //  TIDSREGISTRERING + MINI-KALENDER
  // ============================================================
  const WEEKDAYS = ['må', 'ti', 'on', 'to', 'fr', 'lö', 'sö'];

  // Hjälp: ISO week-number för ett datum
  function isoWeek(d) {
    const date = new Date(d);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 4 - (date.getDay() || 7));
    const yearStart = new Date(date.getFullYear(), 0, 1);
    return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  }

  function renderMiniCal() {
    const cal = $('#miniCal');

    // 5 veckor centrerade runt calViewDate
    const todayIso = new Date().toISOString().slice(0, 10);
    const centerDate = new Date(calViewDate);
    const centerDay = centerDate.getDay() || 7;
    const centerMonday = new Date(centerDate);
    centerMonday.setDate(centerDate.getDate() - (centerDay - 1));
    const firstMonday = new Date(centerMonday);
    firstMonday.setDate(centerMonday.getDate() - 14);

    const weeks = [];
    for (let w = 0; w < 5; w++) {
      const start = new Date(firstMonday);
      start.setDate(firstMonday.getDate() + w * 7);
      weeks.push({
        w: isoWeek(start),
        start: start.toISOString().slice(0, 10)
      });
    }

    // Dagstotaler per datum från API (5 veckor)
    const live = window.__liveWeekInfo;
    const liveTotals = live?.dayTotalsByDate || {};
    const workHours = live?.workHoursByDate || {};
    const tillaggs = live?.tillaggByDate || {};

    // Navigationsheader med pilar + månadsnamn + "Idag"
    const monthLabel = centerDate.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
    let html = `
      <div class="mini-cal-nav" style="display:flex;align-items:center;justify-content:space-between;padding:6px 2px 8px;gap:4px;">
        <button type="button" id="calPrev" title="Föregående månad" style="background:transparent;border:1px solid var(--border);color:var(--text);padding:3px 10px;border-radius:3px;cursor:pointer;font-size:13px;">‹</button>
        <div style="flex:1;text-align:center;font-size:12px;font-weight:600;text-transform:capitalize;">${monthLabel}</div>
        <button type="button" id="calToday" title="Idag" style="background:var(--accent);color:#fff;border:none;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:11px;">Idag</button>
        <button type="button" id="calNext" title="Nästa månad" style="background:transparent;border:1px solid var(--border);color:var(--text);padding:3px 10px;border-radius:3px;cursor:pointer;font-size:13px;">›</button>
      </div>
      <table><thead><tr><th></th>` + WEEKDAYS.map(d => `<th>${d}</th>`).join('') + `</tr></thead><tbody>`;
    for (const wk of weeks) {
      html += `<tr><td class="weeknum">${wk.w}</td>`;
      for (let i = 0; i < 7; i++) {
        const d = addDays(wk.start, i);
        const isWeekend = i >= 5;
        // Arbetade timmar (arbetstid + övertid) vs tillägg (beredskap/restid/bilzon osv)
        // Fall tillbaka till gamla summan om vi inte har klassificerad data
        let hours = workHours.hasOwnProperty(d)
          ? workHours[d]
          : (liveTotals.hasOwnProperty(d)
              ? liveTotals[d]
              : timeEntries.filter(t => t.datum === d).reduce((s, t) => s + t.antal, 0));
        const addons = tillaggs[d] || 0;
        const target = isWeekend ? 0 : 8;
        const isComplete = !isWeekend && hours >= target;
        const hoursChip = isWeekend
          ? 'chip weekend'
          : (isComplete ? 'chip ok' : 'chip');
        const dayNum = new Date(d).getDate();
        const todayCls = d === todayIso ? ' today' : '';
        const weekendTd = isWeekend ? ' is-weekend' : '';
        // Andra chip: tilläggs-count (endast om > 0) — dämpad, smälter in i temat
        const tilläggChip = addons > 0
          ? `<span class="chip tillagg" title="Antal tillägg (beredskap, bilzoner, OB m.m.)" style="background:rgba(120,150,200,.18);color:#8fa3c6;border:1px solid rgba(120,150,200,.3);font-weight:500;">${addons}</span>`
          : `<span class="chip" style="opacity:.25;" title="Inga tillägg">·</span>`;
        html += `<td class="${weekendTd}" data-date="${d}">
          <div class="day">
            <div class="day-num${todayCls}">${dayNum}</div>
            <div class="day-hours">
              <span class="${hoursChip}" title="Arbetade timmar (arbetstid + övertid)">${hours || 0}</span>
              ${tilläggChip}
            </div>
          </div>
        </td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    cal.innerHTML = html;

    // Månadsnavigation
    const shiftMonth = (delta) => {
      calViewDate = new Date(calViewDate);
      calViewDate.setMonth(calViewDate.getMonth() + delta);
      console.log('[cal] shiftMonth', delta, '→', calViewDate);
      // Nollställ dag-selektion/filter vid månadsbyte
      selectedTimeId = null;
      // Visa laddnings-overlay medan tidsdata hämtas för ny månad
      setTimeLoading(true);
      // Ladda om tidsdata för nya månaden, sedan rendera både kalender och tabell
      loadLiveTime().then(() => {
        setTimeLoading(false);
        renderTime();
      });
    };
    $('#calPrev')?.addEventListener('click', () => {
      console.log('[cal] calPrev clicked');
      shiftMonth(-1);
    });
    $('#calNext')?.addEventListener('click', () => {
      console.log('[cal] calNext clicked');
      shiftMonth(1);
    });
    $('#calToday')?.addEventListener('click', () => {
      console.log('[cal] calToday clicked');
      calViewDate = new Date();
      selectedTimeId = null;
      setTimeLoading(true);
      loadLiveTime().then(() => {
        setTimeLoading(false);
        renderTime();
      });
    });

    // Klick på dag → filtrera tabellen (och toggla av vid dubbelklick på samma)
    cal.querySelectorAll('td[data-date]').forEach(td => {
      td.addEventListener('click', () => {
        const alreadySelected = td.classList.contains('selected');
        cal.querySelectorAll('td').forEach(x => x.classList.remove('selected'));
        if (alreadySelected) {
          // Klick på redan markerad dag → rensa filter
          window.__selectedTimeDay = null;
          renderTimeTable(null);
        } else {
          td.classList.add('selected');
          window.__selectedTimeDay = td.dataset.date;
          renderTimeTable(td.dataset.date);
        }
      });
    });
  }

  function addDays(iso, n) {
    const d = new Date(iso);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function renderTimeTable(filterDate = null) {
    const rows = filterDate ? timeEntries.filter(t => t.datum === filterDate) : timeEntries;
    const tbody = $('#timeTbody');
    tbody.innerHTML = '';
    for (const t of rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = t.id;
      if (t.id === selectedTimeId) tr.classList.add('selected');
      const statusClass =
        t.kind === 'bilzon' ? 'bilzon' :
        t.status === 'Klar' ? 'klar' :
        t.status === 'Pågående' ? 'pagande' :
        t.status === 'Refuserad' ? 'refuserad' : '';
      tr.innerHTML = `
        <td>${t.datum}</td>
        <td>${t.tidkod}</td>
        <td>${t.order}</td>
        <td>${t.projekt}</td>
        <td>${t.text}</td>
        <td>${t.antal}</td>
        <td><span class="status-pill ${statusClass}">${t.status}</span></td>
        <td></td>
      `;
      tr.addEventListener('click', () => {
        selectedTimeId = t.id;
        renderTimeTable(filterDate);
      });
      tr.addEventListener('dblclick', () => {
        openEditTime(t);
      });
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTimeRowContextMenu(e.clientX, e.clientY, t);
      });
      tbody.appendChild(tr);
    }
    // Summera bara timmar — inte bilzoner (där antal är antal zoner)
    const total = rows
      .filter(t => t.kind !== 'bilzon')
      .reduce((s, t) => s + t.antal, 0);
    $('#totalHours').textContent = total;
  }

  // ============================================================
  //  HÖGERKLICK-MENY — gemensam helper
  // ============================================================
  function openContextMenu(x, y, items) {
    // items: Array<{ label, icon, handler, disabled, separator }>
    document.querySelector('.ctx-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    Object.assign(menu.style, {
      position: 'fixed', top: y + 'px', left: x + 'px',
      background: '#ffffff', color: '#1a1a1a',
      border: '1px solid #c9ced6', borderRadius: '4px',
      boxShadow: '0 6px 18px rgba(0,0,0,.25)',
      zIndex: '10001', minWidth: '200px', padding: '4px 0',
      fontSize: '13px',
    });
    for (const it of items) {
      if (it.separator) {
        const s = document.createElement('div');
        s.style.cssText = 'height:1px;background:#e4e7ec;margin:4px 0;';
        menu.appendChild(s);
        continue;
      }
      const item = document.createElement('div');
      Object.assign(item.style, {
        padding: '8px 14px',
        cursor: it.disabled ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', gap: '8px',
        color: it.disabled ? '#a0a4ab' : '#1a1a1a',
      });
      item.innerHTML = `<span style="width:16px;text-align:center;">${it.icon || ''}</span><span>${it.label}</span>`;
      if (!it.disabled) {
        item.addEventListener('mouseenter', () => item.style.background = '#eef2ff');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => { menu.remove(); it.handler(); });
      }
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    const closeMenu = (ev) => {
      if (ev && menu.contains(ev.target)) return;
      menu.remove();
      document.removeEventListener('mousedown', closeMenu, true);
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    setTimeout(() => {
      document.addEventListener('mousedown', closeMenu, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  // Högerklick på tidrad
  function showTimeRowContextMenu(x, y, entry) {
    const hasOrder = !!entry.order || !!entry.projectId;
    openContextMenu(x, y, [
      {
        label: 'Öppna order', icon: '→', disabled: !hasOrder,
        handler: () => openOrderDetail(entry.order, entry.projectId),
      },
      {
        label: 'Redigera tid', icon: '✎',
        disabled: entry.kind === 'bilzon',
        handler: () => openEditTime(entry),
      },
      { separator: true },
      {
        label: 'Kopiera ordernummer', icon: '⎘', disabled: !hasOrder,
        handler: async () => {
          let nr = entry.order || '';
          const matchById = orders.find(o => Number(o._raw?.ProjectId) === Number(entry.projectId));
          const matchByNr = orders.find(o => String(o.nummer) === String(nr));
          const resolved = matchById || matchByNr;
          if (resolved?.nummer) nr = String(resolved.nummer);
          try { await navigator.clipboard.writeText(nr); showToast('Kopierat: ' + nr, 'success', 1500); }
          catch { showToast('Kunde inte kopiera', 'error'); }
        },
      },
    ]);
  }

  // Högerklick på orderrad
  function showOrderRowContextMenu(x, y, o) {
    openContextMenu(x, y, [
      {
        label: 'Öppna order', icon: '→',
        handler: () => openOrderDetail(o.nummer),
      },
      { separator: true },
      {
        label: 'Kopiera ordernummer', icon: '⎘',
        handler: async () => {
          try { await navigator.clipboard.writeText(String(o.nummer)); showToast('Kopierat: ' + o.nummer, 'success', 1500); }
          catch { showToast('Kunde inte kopiera', 'error'); }
        },
      },
      {
        label: 'Kopiera beskrivning', icon: '⎘',
        disabled: !o.beskrivning,
        handler: async () => {
          try { await navigator.clipboard.writeText(String(o.beskrivning || '')); showToast('Kopierat beskrivning', 'success', 1500); }
          catch { showToast('Kunde inte kopiera', 'error'); }
        },
      },
      {
        label: 'Kopiera kund', icon: '⎘',
        disabled: !o.kund,
        handler: async () => {
          try { await navigator.clipboard.writeText(String(o.kund || '')); showToast('Kopierat kund', 'success', 1500); }
          catch { showToast('Kunde inte kopiera', 'error'); }
        },
      },
    ]);
  }

  // Öppna modalTime förifylld med entryns data för redigering
  function openEditTime(entry) {
    if (!entry) return;
    editingTimeId = entry.id;
    $('#modalTime .modal-head h2').textContent = 'Redigera tid';
    openModal('modalTime', {
      datum: entry.datum,
      tidkod: entry.tidkod,
      kundorder: entry.order,
      projekt: entry.projekt,
      antal: entry.antal,
      text: entry.text
    });
    // Fokus + selektera Antal-fältet så man kan skriva direkt över värdet
    setTimeout(() => {
      const el = $('#inputAntal');
      if (el) { el.focus(); el.select(); }
    }, 100);
  }

  function renderTime() {
    console.log(`[renderer] renderTime: entries=${timeEntries.length}, dayTotals=${Object.keys(window.__liveWeekInfo?.dayTotalsByDate||{}).length}, filter=${window.__selectedTimeDay||'alla'}`);
    renderMiniCal();
    // Återställ dag-filter om det finns ett sparat
    renderTimeTable(window.__selectedTimeDay || null);
    // Markera dagen i kalendern
    if (window.__selectedTimeDay) {
      const td = $(`#miniCal td[data-date="${window.__selectedTimeDay}"]`);
      if (td) {
        $$('#miniCal td').forEach(x => x.classList.remove('selected'));
        td.classList.add('selected');
      }
    }
    setupKundorderAutocomplete();
  }

  // Visa/dölj laddnings-overlay över tidsvyn.
  function setTimeLoading(isLoading) {
    const view = $('section[data-view="time"]');
    if (!view) return;
    let overlay = document.getElementById('__timeLoading');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = '__timeLoading';
      overlay.innerHTML = `
        <div style="background:#fff;padding:22px 28px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.12);display:flex;align-items:center;gap:14px;">
          <div class="__spinner" style="width:22px;height:22px;border:3px solid #e2edeb;border-top-color:var(--accent);border-radius:50%;animation:__spin 0.8s linear infinite;"></div>
          <div>
            <div style="font-weight:600;font-size:13px;color:var(--text);">Hämtar tidsdata...</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">Laddar 5 veckor från Projektportalen</div>
          </div>
        </div>
      `;
      overlay.style.cssText = 'position:absolute;inset:0;background:rgba(246,250,249,.7);display:flex;align-items:center;justify-content:center;z-index:50;pointer-events:auto;';
      // Säkerställ att view har position:relative
      view.style.position = 'relative';
      view.appendChild(overlay);
      // Injicera spin-keyframes en gång
      if (!document.getElementById('__spinStyles')) {
        const style = document.createElement('style');
        style.id = '__spinStyles';
        style.textContent = '@keyframes __spin { to { transform: rotate(360deg); } }';
        document.head.appendChild(style);
      }
    }
    overlay.style.display = isLoading ? 'flex' : 'none';
  }

  // ============================================================
  //  KUNDORDER-AUTOCOMPLETE (Entré-stil)
  //  Visar Nummer – Märkning – Kund i dropdown.
  //  Under fältet visas vald märkning när användare valt en order.
  // ============================================================
  function setupKundorderAutocomplete() {
    const input = $('#kundorderInput');
    const hint = $('#kundorderHint');
    const dropdown = $('#kundorderDropdown');
    const openBtn = $('#kundorderOpen');
    if (!input || !dropdown || input.__autoInit) return;
    input.__autoInit = true;

    const renderList = (filter = '') => {
      const f = filter.trim().toLowerCase();
      const matches = orders
        .filter(o => !f
          || o.nummer.toLowerCase().includes(f)
          || (o.beskrivning || '').toLowerCase().includes(f)
          || (o.kund || '').toLowerCase().includes(f));
      if (!matches.length) {
        dropdown.innerHTML = `<div style="padding:10px 12px;color:var(--text-dim);font-size:12px;">Inga träffar</div>`;
        return;
      }
      dropdown.innerHTML = matches.map(o => `
        <div class="kundorder-item" data-nr="${o.nummer}" data-beskrivning="${(o.beskrivning||'').replace(/"/g,'&quot;')}" data-kund="${(o.kund||'').replace(/"/g,'&quot;')}"
          style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12.5px;">
          <span style="font-weight:600;color:var(--accent-dark);margin-right:8px;">${o.nummer}</span><span style="color:var(--text);">${o.beskrivning || '(utan märkning)'}</span>
        </div>
      `).join('');
    };

    const show = () => { renderList(input.value); dropdown.style.display = 'block'; };
    const hide = () => { dropdown.style.display = 'none'; };

    const choose = (item) => {
      const nr = item.getAttribute('data-nr');
      const besk = item.getAttribute('data-beskrivning') || '';
      const kund = item.getAttribute('data-kund') || '';
      input.value = nr;
      hint.textContent = besk || '';
      hide();
      // Synka med delat projekt-val
      const order = orders.find(o => o.nummer === nr);
      if (order) setSharedProject(nr, besk, order._raw?.ProjectId || null);
    };

    // Uppdatera hint om användaren skriver ett existerande ordernummer
    const updateHintFromInput = () => {
      const match = orders.find(o => o.nummer === input.value.trim());
      hint.textContent = match ? (match.beskrivning || '') : '';
    };

    input.addEventListener('focus', show);
    input.addEventListener('input', () => { show(); updateHintFromInput(); });
    openBtn?.addEventListener('click', () => { input.focus(); show(); });

    // Klick på ett item
    dropdown.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.kundorder-item');
      if (item) { e.preventDefault(); choose(item); }
    });
    dropdown.addEventListener('mouseover', (e) => {
      const item = e.target.closest('.kundorder-item');
      if (!item) return;
      dropdown.querySelectorAll('.kundorder-item').forEach(el => el.style.background = '');
      item.style.background = 'var(--row-hover)';
    });

    // Stäng när man klickar utanför
    document.addEventListener('mousedown', (e) => {
      if (!dropdown.contains(e.target) && e.target !== input && e.target !== openBtn) hide();
    });

    // Initial hint om fältet redan har ett värde
    updateHintFromInput();
  }

  // ============================================================
  //  DIALOGER (öppna / stäng / spara)
  // ============================================================
  function openModal(id, prefill = {}) {
    const m = $(`#${id}`);
    m.hidden = false;
    // Prefilla fält
    const form = m.querySelector('form');
    if (form) {
      for (const [k, v] of Object.entries(prefill)) {
        const el = form.elements[k];
        if (el) el.value = v;
      }
      const first = form.querySelector('input, select');
      if (first) first.focus();
    }
  }
  function closeModal(id) { $(`#${id}`).hidden = true; }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-close]');
    if (t) closeModal(t.dataset.close);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.modal').forEach(m => (m.hidden = true));
    }
    // Ctrl+S sparar öppen dialog
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      const open = $$('.modal').find(m => !m.hidden);
      if (open) {
        e.preventDefault();
        const saveBtn = open.querySelector('.action.primary:last-of-type');
        if (saveBtn) saveBtn.click();
      }
    }
  });

  // Lägg till order
  let editingOrderId = null;
  $('#btnAddOrder').addEventListener('click', () => {
    editingOrderId = null;
    $('#modalOrder .modal-head h2').textContent = 'Ny order';
    openModal('modalOrder', { ordertyp: '10' });
    // Rensa kundval och autocomplete
    const inp = $('#orderKundSearch'); if (inp) inp.value = '';
    const hid = $('#orderKundNummer'); if (hid) hid.value = '';
    const h = $('#orderKundHint'); if (h) h.textContent = '';
    setTimeout(() => inp?.focus(), 100);
  });

  // Kundsök-autocomplete i order-dialogen
  (function setupOrderKundAutocomplete() {
    const input = $('#orderKundSearch');
    const hidden = $('#orderKundNummer');
    const hint = $('#orderKundHint');
    const dropdown = $('#orderKundDropdown');
    if (!input || !dropdown) return;

    const renderList = (kw) => {
      const q = (kw || '').toLowerCase().trim();
      if (!q || q.length < 1) {
        dropdown.innerHTML = '<div style="padding:8px 12px;color:#667085;font-size:12px;">Skriv för att söka…</div>';
        dropdown.style.display = 'block';
        return;
      }
      const matches = customers.filter(c =>
        (c.namn || '').toLowerCase().includes(q) ||
        (c.kundnummer || '').toLowerCase().includes(q)
      ).slice(0, 30);
      if (!matches.length) {
        dropdown.innerHTML = '<div style="padding:8px 12px;color:#667085;font-size:12px;">Inga träffar</div>';
      } else {
        dropdown.innerHTML = matches.map(c => `
          <div class="kund-item" data-nr="${c.kundnummer}" data-namn="${(c.namn||'').replace(/"/g,'&quot;')}"
               style="padding:7px 12px;cursor:pointer;border-bottom:1px solid #e4e7ec;font-size:12.5px;color:#1a1a1a;">
            <div style="font-weight:600;color:#0b3d91;">${c.kundnummer}</div>
            <div style="color:#1a1a1a;">${c.namn || ''}</div>
            ${c.ort ? `<div style="color:#667085;font-size:11px;">${c.ort}</div>` : ''}
          </div>`).join('');
      }
      dropdown.style.display = 'block';
    };

    input.addEventListener('focus', () => renderList(input.value));
    input.addEventListener('input', () => { hidden.value = ''; hint.textContent = ''; renderList(input.value); });
    input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 180));
    dropdown.addEventListener('mouseover', (e) => {
      const it = e.target.closest('.kund-item');
      if (!it) return;
      dropdown.querySelectorAll('.kund-item').forEach(el => el.style.background = '');
      it.style.background = '#eef2ff';
    });
    dropdown.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.kund-item');
      if (!it) return;
      e.preventDefault();
      const nr = it.dataset.nr;
      const namn = it.dataset.namn;
      input.value = `${nr} — ${namn}`;
      hidden.value = nr;
      hint.textContent = `Kundnummer ${nr}`;
      dropdown.style.display = 'none';
    });
  })();

  // Redigera order (från toolbar-knapp, eller dubbelklick på rad)
  const openEditOrder = () => {
    if (!selectedOrderId) return;
    const order = orders.find(o => o.nummer === selectedOrderId);
    if (!order) return;
    editingOrderId = selectedOrderId;
    $('#modalOrder .modal-head h2').textContent = `Redigera order ${order.nummer}`;
    openModal('modalOrder', {
      projekt: order.projekt,
      kundnummer: order.kundnummer,
      ordertyp: order.status === 'Klar' ? '20' : '10',
      leveransadress: order._raw?.Address || '',
      beskrivning: order.beskrivning
    });
  };
  $('#btnEditOrder')?.addEventListener('click', openEditOrder);

  // Dry-run-flagga — sätt till false för att faktiskt skicka till Projektportalen
  window.__ORDER_CREATE_DRY_RUN = true;

  $('#btnSaveOrder').addEventListener('click', async (e) => {
    e.preventDefault();
    const f = $('#formOrder');
    if (!f.reportValidity()) return;
    const data = Object.fromEntries(new FormData(f));

    if (editingOrderId) {
      // Redigera befintlig order (aktivt — detta skickar)
      const existing = orders.find(o => o.nummer === editingOrderId);
      const projectId = existing?._raw?.ProjectId || editingOrderId;
      const resp = await window.api?.serviceOrders?.update(projectId, {
        ProjectName: data.beskrivning,
        Address: data.leveransadress || undefined
      });
      if (!resp?.ok) { alert('Kunde inte uppdatera order: ' + (resp?.error || 'okänt fel')); return; }
      closeModal('modalOrder');
      f.reset();
      editingOrderId = null;
      loadLiveOrders().then(renderOrders);
      showToast('Order uppdaterad', 'success');
      return;
    }

    // SKAPA NY — DRY-RUN. Bygg body + visa förhandsvisning istället för att POSTa.
    const kundNr = $('#orderKundNummer')?.value?.trim();
    if (!kundNr) {
      showToast('Välj en kund från listan först', 'error');
      $('#orderKundSearch')?.focus();
      return;
    }
    const kund = customers.find(c => c.kundnummer === kundNr);

    // Bygg exakt den request-body som pp-client.createServiceOrder skulle skicka
    const body = {
      CustomerId: '(slås upp via /customers-paging vid riktig save)',
      ProjectType: Number(data.ordertyp) || 10,
      Address: data.leveransadress || '',
      ProjectName: data.beskrivning || '',
      ClientId: '(din klient — sätts från digest-auth)',
      ParentProjectId: data.projekt
        ? `(slås upp från ordernr ${data.projekt})`
        : null,
    };

    const ordertypLabel = {
      '10': 'Arbetsorder', '20': 'Kontantorder', '30': 'Serviceavtal',
      '40': 'Garanti', '50': 'Reklamation'
    }[data.ordertyp] || data.ordertyp;

    const summary = `
      <div style="display:grid;grid-template-columns:140px 1fr;gap:6px 14px;">
        <div style="color:var(--text-dim);">Kund</div>
        <div><strong>${kund?.kundnummer || kundNr}</strong> — ${kund?.namn || '?'}</div>
        <div style="color:var(--text-dim);">Ordertyp</div>
        <div><strong>${data.ordertyp}</strong> ${ordertypLabel}</div>
        ${data.projekt ? `<div style="color:var(--text-dim);">Parent-projekt</div><div>${data.projekt}</div>` : ''}
        ${data.leveransadress ? `<div style="color:var(--text-dim);">Leveransadress</div><div>${data.leveransadress}</div>` : ''}
        <div style="color:var(--text-dim);">Beskrivning</div>
        <div>${data.beskrivning}</div>
        <div style="color:var(--text-dim);">Endpoint</div>
        <div><code style="background:#f7f8fa;padding:2px 6px;border-radius:3px;font-size:11.5px;">POST /api/service-order</code></div>
      </div>`;

    $('#orderPreviewSummary').innerHTML = summary;
    $('#orderPreviewBody').textContent = JSON.stringify(body, null, 2);
    // Spara formulärdata tills användaren stänger
    window.__pendingOrderBody = { form: data, body, kundNr, kund };
    closeModal('modalOrder');
    openModal('modalOrderPreview');
    console.log('[order-create] DRY-RUN — skulle ha POSTat till /api/service-order:', body);
  });

  // Kopiera JSON-knapp i preview-dialogen
  $('#btnCopyOrderBody')?.addEventListener('click', async () => {
    const txt = $('#orderPreviewBody')?.textContent || '';
    try { await navigator.clipboard.writeText(txt); showToast('JSON kopierat', 'success', 1500); }
    catch { showToast('Kunde inte kopiera', 'error'); }
  });

  // Skicka-knappen är disabled tills __ORDER_CREATE_DRY_RUN sätts till false.
  // När den aktiveras kommer denna handler att göra riktig POST.
  $('#btnConfirmCreateOrder')?.addEventListener('click', async () => {
    if (window.__ORDER_CREATE_DRY_RUN) {
      showToast('Dry-run är aktivt — sätt window.__ORDER_CREATE_DRY_RUN = false i konsolen för att aktivera', 'info', 4000);
      return;
    }
    const p = window.__pendingOrderBody;
    if (!p) return;
    const resp = await window.api?.serviceOrders?.create({
      projektNumber: p.form.projekt,
      kundnummer: p.kundNr,
      ordertyp: p.form.ordertyp,
      leveransadress: p.form.leveransadress,
      beskrivning: p.form.beskrivning
    });
    if (!resp?.ok) { showToast('Kunde inte skapa order: ' + (resp?.error || '?'), 'error'); return; }
    closeModal('modalOrderPreview');
    $('#formOrder')?.reset();
    loadLiveOrders().then(renderOrders);
    showToast('Order skapad i Projektportalen', 'success');
  });

  // Lägg till kund
  $('#btnAddCustomer').addEventListener('click', () => {
    openModal('modalCustomer', { kundnummer: window.MockData.nextCustomerNumber() });
  });
  $('#btnSaveCustomer').addEventListener('click', (e) => {
    e.preventDefault();
    const f = $('#formCustomer');
    if (!f.reportValidity()) return;
    const data = Object.fromEntries(new FormData(f));
    customers.unshift({
      kundnummer: data.kundnummer || window.MockData.nextCustomerNumber(),
      namn: data.namn,
      orgnr: data.orgnr,
      ort: data.ort,
      telefon: data.telefon,
      epost: data.epost,
      kundgrupp: data.kundgrupp
    });
    closeModal('modalCustomer');
    f.reset();
    renderCustomers();
  });

  // Lägg till tid
  $('#btnAddTime').addEventListener('click', () => {
    editingTimeId = null;
    $('#modalTime .modal-head h2').textContent = 'Tidsregistrering';
    const today = new Date().toISOString().slice(0, 10);
    openModal('modalTime', {
      datum: today, anstalld: '106', antal: '', tidkod: '010',
      resultatenhet: '50'
    });
    // Alltid starta på Tidkod-fliken
    if (typeof switchModalTab === 'function') switchModalTab('form');
    // Ladda snabbval-artiklar i bakgrunden så dropdown är klar om användaren byter flik
    loadSnabbvalArticles();
    // Fokusera Antal-fältet så man direkt kan skriva utan att klicka
    setTimeout(() => { const el = $('#inputAntal'); if (el) { el.focus(); el.select(); } }, 100);
  });

  // ============================================================
  //  TOAST-HJÄLPARE (grön popup vid bokning/spara)
  // ============================================================
  function showToast(message, type = 'success', ms = 3000) {
    const container = $('#toastContainer');
    if (!container) return;
    const colors = {
      success: { bg: '#10b981', fg: '#fff' },
      error: { bg: '#ef4444', fg: '#fff' },
      info: { bg: '#3b82f6', fg: '#fff' },
    };
    const c = colors[type] || colors.info;
    const el = document.createElement('div');
    el.style.cssText = `background:${c.bg};color:${c.fg};padding:10px 16px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.3);font-size:13.5px;font-weight:500;min-width:220px;max-width:380px;pointer-events:auto;opacity:0;transform:translateX(20px);transition:opacity .2s,transform .2s;`;
    el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;"><span style="font-size:16px;">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ⓘ'}</span><span>${message}</span></div>`;
    container.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(0)'; });
    setTimeout(() => {
      el.style.opacity = '0'; el.style.transform = 'translateX(20px)';
      setTimeout(() => el.remove(), 250);
    }, ms);
  }
  // Exponera globalt så övriga handlers kan ropa på den
  window.showToast = showToast;

  // Placeholder: sharedProject hålls kvar som kompatibilitet men används
  // nu bara inom Tidsregistrering-modalen (snabbval ärver kundorder-fältet).
  const sharedProject = { nummer: '', beskrivning: '', projectId: null };
  function setSharedProject(nr, beskrivning, projectId) {
    sharedProject.nummer = nr || '';
    sharedProject.beskrivning = beskrivning || '';
    sharedProject.projectId = projectId || null;
  }

  // Redigera-knapp för tid (öppnar modal för markerad rad)
  $('#btnEditTime')?.addEventListener('click', () => {
    if (!selectedTimeId) { alert('Välj en rad först'); return; }
    const entry = timeEntries.find(t => t.id === selectedTimeId);
    if (!entry) return;
    openEditTime(entry);
  });

  // Ta bort-knapp för tid
  $('#btnDeleteTime')?.addEventListener('click', async () => {
    if (!selectedTimeId) { alert('Välj en rad först'); return; }
    if (!confirm('Ta bort tidraden?')) return;
    const resp = await window.api?.time?.delete(selectedTimeId);
    if (!resp?.ok) {
      alert('Kunde inte ta bort tid: ' + (resp?.error || 'okänt fel'));
      return;
    }
    selectedTimeId = null;
    loadLiveTime().then(renderTime);
  });

  // ============================================================
  //  SPARA-ROUTER för Tidsregistrering-modalen
  //  LÄGG TILL  = spara + rensa + lämna dialogen öppen (addAnother=true)
  //  SPARA      = spara + stäng dialogen
  //  Vilken typ (tid/material) styrs av aktiv flik.
  // ============================================================
  function getActiveModalTab() {
    const activeTab = $('.tm-tab.active')?.dataset?.tmTab;
    return activeTab || 'form';
  }

  async function saveTimeFromForm() {
    const f = $('#formTime');
    if (!f.reportValidity()) return { ok: false };
    const d = Object.fromEntries(new FormData(f));
    let resp;
    let toastMsg = '';
    if (editingTimeId) {
      const patch = {
        Quantity: Number(d.antal || 0),
        Comment: d.text || '',
        Timestamp: `${d.datum}T00:00:00`
      };
      resp = await window.api?.time?.update(editingTimeId, patch);
      if (!resp?.ok) { showToast('Kunde inte uppdatera tid: ' + (resp?.error || '?'), 'error'); return { ok: false }; }
      toastMsg = 'Tidrad uppdaterad';
    } else {
      const status = await window.api?.authStatus?.();
      const sel = $('#tidkodSelect');
      const opt = sel?.selectedOptions?.[0];
      const ttId = opt?.dataset?.timeTypeId != null ? Number(opt.dataset.timeTypeId) : null;
      const ttName = opt?.textContent?.trim() || '';
      let category = 'actual';
      if (ttId != null && Array.isArray(window.__allTimeTypes)) {
        const found = window.__allTimeTypes.find(t => t.TimeTypeId === ttId);
        if (found?.AbsenceTypeId > 0) category = 'absence';
        else if (found?.IsClaimsType) category = 'claims';
      }
      resp = await window.api?.time?.create({
        datum: d.datum, tidkod: d.tidkod, timeTypeId: ttId, timeTypeName: ttName, category,
        userId: status?.user?.UserId,
        projectNumber: d.kundorder, projektNumber: d.projekt, objectRef: d.objekt,
        antal: Number(d.antal || 0), text: d.text || '',
        resultatenhet: d.resultatenhet
      });
      if (!resp?.ok) { showToast('Kunde inte spara tid: ' + (resp?.error || '?'), 'error'); return { ok: false }; }
      toastMsg = `Tid sparad: ${Number(d.antal||0)}h på ${d.kundorder || 'projekt'}`;
    }
    // Bilzoner-checkbox (om ikryssad)
    const bilzoner = $('#includeBilzoner');
    if (bilzoner?.checked) {
      const bAntal = Number($('#formTime [name="bilzonerAntal"]')?.value || 0);
      const bEnhet = $('#formTime [name="bilzonerEnhet"]')?.value || 'st';
      const bText = $('#formTime [name="bilzonerText"]')?.value || '';
      if (bAntal > 0) {
        const order = orders.find(o => o.nummer === d.kundorder);
        const projectId = order?._raw?.ProjectId;
        if (projectId) {
          // Försök hitta matchande snabbval-artikel (Bilerättning Ale VA = 999901)
          const bilArt = snabbvalArticles.find(a => a.ArticleNumber === '999901');
          await window.api?.materials?.create?.({
            projectId,
            articleId: bilArt?.ArticleId || 0,
            articleNumber: '999901',
            benamning: bText || 'Bilzoner', antal: bAntal,
            enhet: bEnhet, prisPerEnhet: 0, kostnad: 0, debiterbar: true
          }).catch(e => console.warn('bilzoner:', e));
        }
      }
    }
    showToast(toastMsg, 'success');
    loadLiveTime().then(renderTime);
    return { ok: true, data: d };
  }

  async function saveSnabbvalMaterial() {
    if (!snabbvalSelected) {
      showToast('Välj en artikel först', 'error');
      $('#snabbvalArticleInput')?.focus();
      return { ok: false };
    }
    const nr = $('#kundorderInput')?.value?.trim();
    if (!nr) {
      showToast('Fyll i kundorder på Tidkod-fliken', 'error');
      switchModalTab('form');
      return { ok: false };
    }
    const order = orders.find(o => o.nummer === nr);
    const projectId = order?._raw?.ProjectId;
    if (!projectId) { showToast('Hittar inte projektet för kundorder ' + nr, 'error'); return { ok: false }; }

    const antal = Number($('#snabbvalAntal')?.value || 0);
    if (!antal || antal <= 0) { showToast('Ange ett antal > 0', 'error'); return { ok: false }; }
    const enhet = $('#snabbvalEnhet')?.value || snabbvalSelected.UnitCode || 'st';
    const pris = Number($('#snabbvalPris')?.value || 0);
    const kommentar = $('#snabbvalKommentar')?.value || '';

    const pd = snabbvalSelected._priceDetails || {};
    const resp = await window.api?.materials?.create?.({
      projectId,
      articleId: snabbvalSelected.ArticleId || snabbvalSelected.id || 0,
      articleNumber: snabbvalSelected.ArticleNumber || '',
      benamning: kommentar ? `${snabbvalSelected.Name} — ${kommentar}` : snabbvalSelected.Name || '',
      antal, enhet, prisPerEnhet: pris,
      materialUnitId: Number(pd.UnitId || snabbvalSelected.UnitId || 0),
      kostnad: Number(pd.PurchasePrice || snabbvalSelected.PurchasePrice || 0),
      purchasePrice: Number(pd.PurchasePrice || snabbvalSelected.PurchasePrice || 0) || pris,
      discount: Number(pd.Discount || 0),
      debiterbar: true
    });
    if (!resp?.ok) { showToast('Kunde inte spara material: ' + (resp?.error || '?'), 'error'); return { ok: false }; }
    showToast(`${snabbvalSelected.Name} × ${antal} lagd på ${nr}`, 'success');
    // Ladda om tidsregistreringen i bakgrunden så kalendern uppdateras med
    // den nya bilzonen (visas som tillägg på datumet om det matchar filtret)
    loadLiveTime().then(() => { if (currentView === 'time') renderTime(); });
    return { ok: true };
  }

  // Huvud-router för LÄGG TILL / SPARA-knapparna.
  // addAnother=true → dialogen stannar öppen, formulär rensas (ej kundorder/datum)
  // addAnother=false → dialogen stängs efter lyckad save
  async function handleSaveFromModal(addAnother) {
    const tab = getActiveModalTab();
    let result;
    if (tab === 'snabbval') {
      result = await saveSnabbvalMaterial();
    } else {
      result = await saveTimeFromForm();
    }
    if (!result?.ok) return; // felmeddelande redan visat

    if (addAnother) {
      // Rensa bara "förbrukade" fält så användaren kan skriva ny rad direkt
      if (tab === 'snabbval') {
        $('#snabbvalAntal').value = '1';
        $('#snabbvalKommentar').value = '';
        // Behåll artikelvalet så man kan skriva fler av samma
        setTimeout(() => $('#snabbvalAntal')?.focus(), 50);
      } else {
        // Tidkod-fliken: behåll kundorder, datum, tidkod, resultatenhet; rensa antal/text
        const f = $('#formTime');
        if (f) {
          const keep = {
            datum: f.elements.datum?.value,
            anstalld: f.elements.anstalld?.value,
            tidkod: f.elements.tidkod?.value,
            kundorder: f.elements.kundorder?.value,
            projekt: f.elements.projekt?.value,
            resultatenhet: f.elements.resultatenhet?.value
          };
          f.reset();
          Object.entries(keep).forEach(([k, v]) => { if (f.elements[k]) f.elements[k].value = v || ''; });
        }
        editingTimeId = null;
        setTimeout(() => { const el = $('#inputAntal'); if (el) { el.focus(); el.select(); } }, 50);
      }
    } else {
      // Stäng dialogen
      closeModal('modalTime');
      $('#formTime')?.reset();
      editingTimeId = null;
      snabbvalSelected = null;
      if ($('#snabbvalArticleInput')) $('#snabbvalArticleInput').value = '';
      if ($('#snabbvalArticleHint')) $('#snabbvalArticleHint').textContent = '';
    }
  }

  $('#btnSaveTime').addEventListener('click', (e) => { e.preventDefault(); handleSaveFromModal(false); });
  $('#btnAddAnother').addEventListener('click', (e) => { e.preventDefault(); handleSaveFromModal(true); });
  $('#includeBilzoner')?.addEventListener('change', (e) => {
    const div = $('#bilzonerFields');
    if (div) div.style.display = e.target.checked ? 'grid' : 'none';
  });

  // Material – save handler
  $('#btnSaveMaterial')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const f = $('#formMaterial');
    if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f));
    const resp = await window.api?.materials?.create({
      projectId: d.projectId,
      articleNumber: d.articleNumber,
      benamning: d.benamning,
      antal: Number(d.antal),
      enhet: d.enhet,
      prisPerEnhet: Number(d.prisPerEnhet || 0),
      kostnad: Number(d.kostnad || 0),
      debiterbar: !!d.debiterbar
    });
    if (!resp?.ok) { alert('Kunde inte spara material: ' + (resp?.error || '?')); return; }
    closeModal('modalMaterial');
    f.reset();
    // Om detail-vyn är öppen, ladda om material-tabben
    if (typeof renderDetailTable === 'function') renderDetailTable();
  });

  // Utilities
  function fmtMoney(v) {
    if (v == null) return '';
    return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 }).format(v);
  }

  // ============================================================
  //  LOGOUT-KNAPP + USER-INFO i sidebar
  // ============================================================
  async function setupUserInfo() {
    // Rendera ALLTID logout-knappen, oavsett om authStatus svarar
    const footer = $('.sidebar-footer');
    if (!footer) return;

    let name = 'Användare';
    let client = '';
    try {
      const status = await window.api?.authStatus?.();
      if (status?.user) {
        name = status.user.FullName || status.user.UserName || name;
        client = status.user.ClientName || status.user.Client || '';
        if (!client && status.user.ClientId) {
          client = 'ClientId: ' + status.user.ClientId;
        }
      }
    } catch (e) {
      console.warn('[renderer] authStatus fail:', e.message);
    }

    footer.innerHTML = `
      <div style="margin-bottom:6px;color:#fff;font-weight:600;font-size:12px;">${name}</div>
      <div style="margin-bottom:10px;font-size:11px;color:#8ab2ad;">${client || ''}</div>
      <button id="btnLogout"
        style="background:transparent;border:1px solid rgba(255,255,255,.25);color:#d6e7e5;padding:6px 10px;border-radius:4px;cursor:pointer;font-size:12px;width:100%;display:flex;align-items:center;justify-content:center;gap:6px;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Logga ut
      </button>
    `;
    const btn = $('#btnLogout');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (!confirm('Vill du logga ut?')) return;
        const savedHTML = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = 'Loggar ut...';
        try {
          const res = await window.api?.logout?.();
          console.log('[renderer] logout result:', res);
          if (res && res.ok === false) {
            alert('Kunde inte logga ut: ' + (res.error || 'okänt fel'));
            btn.disabled = false;
            btn.innerHTML = savedHTML;
          }
        } catch (e) {
          console.error('[renderer] logout fel:', e);
          alert('Kunde inte logga ut: ' + e.message);
          btn.disabled = false;
          btn.innerHTML = savedHTML;
        }
      });
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,.08)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    }
  }

  // ============================================================
  //  PDF-EXPORT
  // ============================================================
  async function exportOrderPdf(orderNummer) {
    const order = orders.find(o => o.nummer === orderNummer);
    if (!order) { alert('Välj en order först'); return; }
    // Hämta fullständiga order-detaljer om möjligt
    let full = order;
    try {
      const resp = await window.api?.serviceOrders?.get(order._raw?.ProjectId || orderNummer);
      if (resp?.ok) full = { ...order, ...resp.data };
    } catch (_) {}

    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
    const today = new Date().toLocaleDateString('sv-SE');
    const html = `<!DOCTYPE html><html lang="sv"><head><meta charset="utf-8"><title>Order ${esc(order.nummer)}</title>
      <style>
        body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#222; margin:40px; font-size:12px; }
        h1 { color: #1f4b47; border-bottom: 3px solid #f0a7a2; padding-bottom: 8px; }
        .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 20px 0; }
        .meta-item { border: 1px solid #d8e0df; padding: 10px; border-radius: 4px; }
        .meta-item label { display:block; font-size: 10px; color: #6a7b79; text-transform: uppercase; margin-bottom: 4px; }
        .meta-item .value { font-size: 14px; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th { background: #1f4b47; color: #fff; padding: 8px; text-align: left; font-size: 11px; }
        td { padding: 8px; border-bottom: 1px solid #d8e0df; font-size: 11px; }
        .footer { margin-top: 40px; font-size: 10px; color: #888; border-top: 1px solid #ddd; padding-top: 10px; }
      </style></head><body>
      <h1>Order ${esc(order.nummer)}</h1>
      <div style="display:flex;justify-content:space-between;">
        <div><strong>${esc(order.beskrivning)}</strong></div>
        <div>Utskriven: ${today}</div>
      </div>
      <div class="meta">
        <div class="meta-item"><label>Kund</label><div class="value">${esc(order.kund)}</div></div>
        <div class="meta-item"><label>Kundnummer</label><div class="value">${esc(order.kundnummer)}</div></div>
        <div class="meta-item"><label>Projektnummer</label><div class="value">${esc(order.projekt)}</div></div>
        <div class="meta-item"><label>Vår referens</label><div class="value">${esc(order.referens)}</div></div>
        <div class="meta-item"><label>Status</label><div class="value">${esc(order.status)}</div></div>
        <div class="meta-item"><label>Belopp</label><div class="value">${esc(new Intl.NumberFormat('sv-SE',{style:'currency',currency:'SEK',maximumFractionDigits:0}).format(order.belopp || 0))}</div></div>
      </div>
      <div class="footer">OrderPortal — automatiskt genererad ${today}</div>
    </body></html>`;

    const resp = await window.api?.printOrderPdf({ html, defaultFileName: `Order-${order.nummer}.pdf` });
    if (!resp?.ok) {
      if (resp?.error !== 'Avbrutet') alert('PDF-export misslyckades: ' + (resp?.error || '?'));
      return;
    }
    alert('PDF sparad: ' + resp.filePath);
  }

  // Skriv ut-knapp (orderlistan)
  $$('.view-orders .action').forEach(btn => {
    if (/SKRIV UT/i.test(btn.textContent)) {
      btn.addEventListener('click', () => {
        if (!selectedOrderId) { alert('Välj en order först'); return; }
        exportOrderPdf(selectedOrderId);
      });
    }
  });

  // ============================================================
  //  INITIALISERA
  // ============================================================
  setupUserInfo();
  switchView('home');
  renderHome();

  // ============================================================
  //  TIDKODER — dynamisk laddning från /api/time-types/client
  // ============================================================
  async function loadTimeTypes() {
    try {
      const resp = await window.api?.timeTypes?.list?.();
      if (!resp?.ok) return;
      const data = resp.data || [];
      window.__allTimeTypes = data;
      const sel = $('#tidkodSelect');
      if (!sel) return;
      // Visa bara tidkoder markerade som aktuella i Projektportalen
      // (IsShowInMobileApp = de som webb-UI:t faktiskt låter användaren välja).
      // De 200+ övriga är arkiverade/tekniska koder som inte syns i vanliga fall.
      const visible = data.filter(t => t.IsShowInMobileApp);
      const mkOpt = (t) => `<option value="__TT_${t.TimeTypeId}" data-time-type-id="${t.TimeTypeId}">${t.Name}${t.Percentage ? ` (${t.Percentage}%)` : ''}</option>`;
      sel.innerHTML = `<option value="010" data-time-type-id="0">Arbetstid</option>${visible.map(mkOpt).join('')}`;
      console.log(`[renderer] Laddat ${visible.length} aktuella tidkoder (av ${data.length} totalt)`);
    } catch (e) {
      console.warn('[renderer] Kunde inte ladda tidkoder:', e.message);
    }
  }

  // ============================================================
  //  SNABBVAL inuti Tidsregistrering-modalen
  //  Flikar: "Tidkod" (formulär) / "Snabbval" (sök-dropdown → + material)
  // ============================================================
  let snabbvalArticles = [];         // cachad lista från /search/articles/search
  let snabbvalSelected = null;       // valt article-objekt

  async function loadSnabbvalArticles() {
    if (snabbvalArticles.length) return snabbvalArticles;
    try {
      const authStatus = await window.api?.authStatus?.();
      const userId = authStatus?.user?.UserId ?? 0;
      const resp = await window.api?.articles?.snabbval?.({
        userId,
        articleGroupId: 7122,   // "Snabbval Artiklar" (Jio)
        top: 50,
      });
      if (!resp?.ok) throw new Error(resp?.error || 'okänt fel');
      const data = resp.data;
      snabbvalArticles = Array.isArray(data?.Articles) ? data.Articles : [];
      console.log(`[renderer] Snabbval: ${snabbvalArticles.length} artiklar laddade`);
      return snabbvalArticles;
    } catch (e) {
      console.warn('[renderer] Kunde inte ladda snabbval:', e.message);
      return [];
    }
  }

  function renderSnabbvalDropdown(keyword = '') {
    const dropdown = $('#snabbvalArticleDropdown');
    if (!dropdown) return;
    const q = (keyword || '').toLowerCase().trim();
    const matches = (q
      ? snabbvalArticles.filter(a =>
          (a.Name || '').toLowerCase().includes(q) ||
          (a.ArticleNumber || '').toLowerCase().includes(q))
      : snabbvalArticles
    ).slice(0, 40);
    dropdown.innerHTML = matches.map(a => {
      const idx = snabbvalArticles.indexOf(a);
      return `<div class="sv-item" data-idx="${idx}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12.5px;">
        <div style="font-weight:600;">${a.Name || '(utan namn)'}</div>
        <div style="color:var(--text-dim);font-size:11.5px;">${a.ArticleNumber || ''} ${a.SalesPrice ? ` · ${a.SalesPrice} kr` : ''} ${a.UnitCode ? ` · ${a.UnitCode}` : ''}</div>
      </div>`;
    }).join('') || '<div style="padding:10px;color:var(--text-dim);font-size:12px;">Inga träffar</div>';
    dropdown.style.display = 'block';
  }

  async function pickSnabbvalArticle(article) {
    snabbvalSelected = article;
    $('#snabbvalArticleInput').value = article.Name || '';
    $('#snabbvalArticleHint').textContent = `${article.ArticleNumber || ''} · ${article.UnitCode || 'st'}${article.SalesPrice ? ' · ' + article.SalesPrice + ' kr' : ''}`;
    $('#snabbvalEnhet').value = article.UnitCode || 'st';
    $('#snabbvalPris').value = Number(article.SalesPrice || 0);
    $('#snabbvalArticleDropdown').style.display = 'none';

    // Hämta riktigt pris från projektets prislista (snabbval returnerar oftast 0)
    const nr = $('#kundorderInput')?.value?.trim();
    const order = orders.find(o => o.nummer === nr);
    const pid = order?._raw?.ProjectId;
    if (!pid || !article.ArticleId) return;
    try {
      const resp = await window.api?.articles?.salesprice?.(article.ArticleId, pid);
      if (!resp?.ok || !resp.data) return;
      const d = resp.data;
      const realPrice = Number(d.Price || 0);
      if (realPrice > 0) $('#snabbvalPris').value = realPrice;
      if (d.UnitName) $('#snabbvalEnhet').value = d.UnitName;
      snabbvalSelected._priceDetails = d;  // sparas för save
      $('#snabbvalArticleHint').textContent = `${article.ArticleNumber || ''} · ${d.UnitName || 'st'} · ${realPrice} kr`;
    } catch (_) {}
  }

  // Setup för snabbval-fältet i modalen
  const svInput = $('#snabbvalArticleInput');
  const svDropdown = $('#snabbvalArticleDropdown');
  svInput?.addEventListener('focus', async () => {
    await loadSnabbvalArticles();
    renderSnabbvalDropdown(svInput.value);
  });
  svInput?.addEventListener('input', async () => {
    await loadSnabbvalArticles();
    snabbvalSelected = null;
    $('#snabbvalArticleHint').textContent = '';
    renderSnabbvalDropdown(svInput.value);
  });
  svInput?.addEventListener('blur', () => setTimeout(() => {
    if (svDropdown) svDropdown.style.display = 'none';
  }, 180));
  $('#snabbvalArticleOpen')?.addEventListener('click', async () => {
    svInput?.focus();
    await loadSnabbvalArticles();
    renderSnabbvalDropdown('');
  });
  svDropdown?.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.sv-item');
    if (!item) return;
    e.preventDefault();
    const idx = Number(item.dataset.idx);
    const article = snabbvalArticles[idx];
    if (article) pickSnabbvalArticle(article);
  });

  // Flik-växlare inuti modalen
  function switchModalTab(tab) {
    $$('.tm-tab').forEach(b => {
      const active = b.dataset.tmTab === tab;
      b.classList.toggle('active', active);
      b.style.borderBottomColor = active ? 'var(--accent, #3b82f6)' : 'transparent';
      b.style.color = active ? '' : 'var(--text-dim)';
      b.style.fontWeight = active ? '600' : '400';
    });
    $$('.tm-panel').forEach(p => { p.hidden = p.dataset.tmPanel !== tab; });
    // Visa/dölj rätt knappar i modal-foot
    $$('.tm-btn-form').forEach(b => b.hidden = tab !== 'form');
    $$('.tm-btn-snabbval').forEach(b => b.hidden = tab !== 'snabbval');
    // På Snabbval: synka kundorder från tidfliken
    if (tab === 'snabbval') {
      const nr = $('#kundorderInput')?.value?.trim() || '';
      const hint = $('#kundorderHint')?.textContent || '';
      const label = $('#snabbvalKundorderLabel');
      if (label) {
        label.textContent = nr
          ? `${nr}${hint ? ' — ' + hint : ''}`
          : '(välj kundorder på Tidkod-fliken först)';
        label.style.color = nr ? 'var(--text)' : 'var(--warn, #e67e22)';
      }
    }
  }
  $$('.tm-tab').forEach(btn => btn.addEventListener('click', () => switchModalTab(btn.dataset.tmTab)));

  loadTimeTypes();

  // Preload serviceorder, kunder och tidsregistrering i bakgrunden
  // så vyerna är redo när man klickar — slippar vänta varje gång.
  if (window.api?.serviceOrders) {
    loadLiveOrders().then(() => {
      if (currentView === 'orders') renderOrders();
      renderHome(); // uppdatera stats på hem
    });
    loadLiveCustomers().then(() => {
      if (currentView === 'customers') renderCustomers();
    });
    // Tidsregistrering preloadas direkt — ingen auth-polling (användaren är
    // redan inloggad när renderern startar).
    (async () => {
      try {
        console.log('[renderer] Startar preload av tidsregistrering…');
        const t0 = performance.now();
        await loadLiveTime();
        console.log(`[renderer] Preload färdig på ${Math.round(performance.now()-t0)}ms`);
        if (currentView === 'time') {
          setTimeLoading(false);
          renderTime();
        }
      } catch (e) {
        console.warn('[renderer] Preload av tidsregistrering misslyckades:', e.message);
      }
    })();
  } else {
    console.warn('[renderer] window.api.serviceOrders saknas — kör i mock-läge');
  }
})();
