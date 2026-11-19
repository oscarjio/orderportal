# Projektportalen – API-spec (reverse engineered)

> **Status:** Dokumenterad utifrån observerad nätverkstrafik i app3-miljön, inloggad som användare i klient 2681 (Jio Eltjänst AB). Detta är inte officiell dokumentation — Projektportalen kan ändra endpoints, fältnamn och auth-mekanism utan förvarning.

## Bas-URL

Alla anrop går mot:

```
https://api-app3.projektportalen.se/api/
```

Webbappen själv ligger på `https://app3.projektportalen.se/` och laddar denna API över CORS. Alla anrop som observerats har `OPTIONS` preflight före den riktiga `GET`/`POST`.

## Autentisering: HTTP Digest (RFC 7616)

Projektportalen använder **HTTP Digest Authentication** — inte en enkel bearer-token. Klienten måste beräkna en ny signatur per request baserat på request-method, URI och ett set med nonces.

### Fält som lagras efter login

Efter lyckad login lagrar webbappen två nycklar i `localStorage`:

**`digestData`** (JSON):

| Fält       | Typ    | Beskrivning                                                    |
|------------|--------|----------------------------------------------------------------|
| userName   | string | Användaridentifierare (22 tecken i observerat fall)            |
| realm      | string | Server-realm (13 tecken)                                       |
| userHash   | string | HA1 = MD5/SHA256(userName:realm:password) — 64 tecken          |
| nonce      | string | Server-genererad nonce per session (68 tecken)                 |
| nc         | string | Nonce counter, hex, inkrementeras per request (starts at `00000001`) |
| cnonce     | string | Client nonce (32 tecken)                                       |
| qop        | string | Quality of protection — observerat värde: `auth`               |
| clientId   | number | Klient/tenant-ID (ex: 2681)                                    |
| role       | string | Användarens roll (14 tecken, ex: "Administrator")              |

**`loginUser`** (JSON): Profil med `UserId`, `RoleId`, `UserName`, `FullName`, `RoleName`, `RoleCode`, `ClientId`, `Client`, `ClientName`, `UserHash`, `Nonce`, `NonceCount`, `Image`, `Password` (!), `IsSuperadmin`, `LastLoginDate`, `ClientNumber`, `Email`, `UsePowerBi`, `PhoneNumber` osv.

> ⚠️ **Säkerhetsnotering:** `loginUser.Password` verkar innehålla lösenordet i klartext (eller base64). Vår klient bör *inte* lagra lösenordet alls efter att userHash beräknats.

### Header-konstruktion per request

Varje riktig request skickar en `Digest`-header med:

```
Authorization: Digest username="<userName>", realm="<realm>", nonce="<nonce>", 
  uri="<requestPath>", qop=auth, nc=<nc>, cnonce="<cnonce>", 
  response="<HA1:nonce:nc:cnonce:qop:HA2>", clientId=<clientId>
```

Där `HA2 = hash(method + ":" + uri)` och `response = hash(HA1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + HA2)`.

Headernamnet är troligen `Digest` eller `Authorization` — en 401-respons ger `"Digest is null"` när headern saknas.

### Login-flöde (verifierat)

**Klassisk HTTP Digest challenge-response** (RFC 7616):

1. Klient gör `GET /api/authenticate` utan Authorization-header.
2. Server svarar `204 No Content` med header:
   ```
   WWW-Authenticate: Digest realm="ProjectPortal", nonce="<base64-string, 68 ch>", qop="auth"
   ```
   Nonce-värdet är base64 av `timestamp:hex-hash` (ASP.NET-standardformat).
3. Klient beräknar:
   - `HA1 = MD5(username + ":" + realm + ":" + password)`
   - `HA2 = MD5(method + ":" + uri)` — för GET /api/authenticate: `MD5("GET:/api/authenticate")`
   - `response = MD5(HA1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + HA2)`
4. Klient gör om `GET /api/authenticate` med:
   ```
   Authorization: Digest username="<user>", realm="ProjectPortal", nonce="<nonce>",
     uri="/api/authenticate", qop=auth, nc=00000001, cnonce="<random hex>",
     response="<md5 hex>"
   ```
5. Vid lyckad auth: 200 + user-data (profilen). Vid misslyckad: 401 med ny nonce.
6. Klient fortsätter sedan anropa andra endpoints och *ökar* `nc` för varje request (`00000001`, `00000002`, ...). Servern kan även skicka ny nonce i svar (header `Authentication-Info`).

**Login med pre-computed hash**: Eftersom `digestData.userHash` = HA1, kan klienten behålla endast HA1 (aldrig lagra plaintext password). För ny session behövs antingen att lösenordet anges igen eller att gammal HA1 återanvänds med ny nonce.

**Ytterligare endpoints i login-flödet (observerade)**:

- `GET /api/login?...` — okänt exakt syfte, 500 utan auth
- `GET /api/users-client?...` — "who am I" / user context
- `GET /api/user/aggrid-states` — användarens sparade grid-inställningar
- `GET /api/users/{userId}/version-suggestion` — version/feature flags
- `POST /signalr/signalr/negotiate?...` — SignalR realtime-förhandling
- `GET /signalr/signalr/start?...` — SignalR-session

### Realtime (SignalR)

Projektportalen använder **ASP.NET SignalR** för realtime-uppdateringar:
- `/signalr/hubs` — hub-definitioner (JavaScript client library)
- `/signalr/signalr/negotiate` — förhandling om transport
- `/signalr/signalr/start` — start session
- WebSocket-anslutning därefter

För vår Electron-klient kan vi ignorera realtime initialt — polling räcker för POC.

## Endpoints

Alla följande endpoints kräver en giltig Digest-header. Svaren är JSON om inget annat anges.

### 0. User / Startsida / Klient-kontext

| Metod | Path | Syfte |
|-------|------|-------|
| GET   | `/user/todos/count` | Antal att göra-punkter |
| GET   | `/user/todos/pagination/{page}/{pageSize}/{tabIndex}` | Att göra-lista |
| GET   | `/clients/{clientId}` | Info om aktuell klient (ex `/clients/2681`) |
| GET   | `/clients/projects/amount` | Antal projekt |
| GET   | `/clients/projects/invoices/amount` | Fakturerat totalt |
| GET   | `/clients/reported-hours/total` | Rapporterade timmar totalt |
| GET   | `/client/holidays` | Helgdagar |
| GET   | `/forecast/counter` | Prognos-räknare |
| GET   | `/customer-invoices/draft-certificate/counter` | Utkast-räknare |
| GET   | `/getAllQuantityDisplayedInCounter` | Counter-ihopslagning |
| GET   | `/projects/favorite` | Favoritprojekt |
| GET   | `/projects/favorite/user?ProjectIds=<id1>&ProjectIds=<id2>...` | Batch av favorit-flag per projekt |

### 1. Projekt

Projekt och serviceorder delar underliggande entitet i Projektportalen. ID:t är numeriskt (ex `898679`).

| Metod | Path | Syfte |
|-------|------|-------|
| GET   | `/projects/{id}` | Basdata för ett projekt/serviceorder |
| GET   | `/projects-header/{id}` | Header/toppinfo |
| GET   | `/projects/{id}/budget-worked-hours` | Budget vs faktiska timmar |
| GET   | `/projects/project-overview/tasks-users/{id}` | Tasks och tilldelade användare |
| GET   | `/projects/notInvoicedAmount?(query)` | Ej fakturerat belopp |
| POST  | `/project/general-list/to-invoice` | Lista projekt klara att fakturera |

### 2. Serviceorder

| Metod | Path | Syfte |
|-------|------|-------|
| POST  | `/service-order/list` | Listar serviceorder (body = filter/pagination) |
| GET   | `/service-orders/{id}/amounts` | Belopp-detalj för serviceorder |
| GET   | `/projects/{id}` | Detaljvy (samma som projekt) |

**Observerade kolumner i listvyn:** Nummer, Projektnamn, Projektledare, Kund, Adress, Stad, Debiteringsform, Status. Statusvärden sett: `Pågående`, `Tilldelad`, `Löpande`, `Fastpris`, `Okänd`.

**Filterflikar (UI):** Favoriter, Pågående, Väntande/Stoppade, Utförda, Fakturera, Avslutade, Alla — troligen skickas som `tabIndex` eller liknande i body.

### 3. Hantera tid

| Metod | Path | Syfte |
|-------|------|-------|
| GET   | `/time-manage/materials?userId=<uid>&startDate=<YYYY-MM-DD>&endDate=<YYYY-MM-DD>` | Tidmaterial per användare och period |

UI har tabs: **Översikt** (team-vy, anställda som rader, veckodagar som kolumner, visar registrerade/förväntade timmar per cell), **Arbetstid**, **Frånvarotid**, **Ersättning**. Dessa tabs laddar inte nya endpoints — samma data, filtrerad klientsidan.

**Tidsdata-struktur (inferenced)**: Varje tidrad verkar ha `projekt`/`serviceorder`, `tidkod` (ex "Industri elektriker", "Elektriker"), `antal`, `OB`, `Arbetstid`, `Debiterbart`, `text` (fri kommentar).

### 4. Register / Kunder

Register har sub-entiteter: **Kund, Kontaktperson, Arbetsplats, Underentreprenör, Artiklar, Anställda, Leverantör, Operatör, Importera**.

| Metod | Path | Syfte |
|-------|------|-------|
| GET   | `/customers-paging/?isAsc=true&keyword=&orderByPropertyName=Name&pageIndex=1&pageSize=10&tabIndex=1` | Paginerad kundlista |

**Query-params:**
- `isAsc`: `true`/`false` — sorteringsriktning
- `keyword`: sökterm
- `orderByPropertyName`: `Name`, `Numbers`, ...
- `pageIndex`: 1-baserad sida
- `pageSize`: rader per sida (10 standard)
- `tabIndex`: `1` = Aktiva, `2` = Inaktiva, `3` = Alla (hypotes)

**Observerade kolumner:** Namn, Adress, Mail, Postnummer, Stad, Organisationsnummer, Kundnummer, Momsnummer, Omv. byggmoms.

Volym: 2 843 kunder i observerat konto.

### 5. Fakturering

| Metod | Path | Syfte |
|-------|------|-------|
| GET   | `/customerInvoices-paging/?isAsc=true&keyword=&orderByPropertyName=Numbers&pageIndex=1&pageSize=10&tabIndex=1` | Paginerad fakturalista |

Samma query-param-mönster som kunder.

### 6. Anbud

| Metod | Path | Syfte |
|-------|------|-------|
| POST  | `/proposals/list/total` | Totalt belopp för anbudslistan (body = filter) |

Fler endpoints förväntade här: paging, detalj, create/update.

### 7. UI-state (spara kolumninställningar)

| Metod | Path | Syfte |
|-------|------|-------|
| POST  | `/user/aggrid-state/add-or-update` | Sparar ag-grid-kolumnstate per vy |

Triggas ofta i bakgrunden — vi kan säkert ignorera detta i vår klient.

## Mönster att känna till

### Paginering

Två mönster observerade:

**1. Query-string-paging** (kunder, fakturor):
```
GET /api/customers-paging/?isAsc=true&keyword=&orderByPropertyName=Name&pageIndex=1&pageSize=10&tabIndex=1
```

**2. POST-body-paging** (serviceorder, projekt): body innehåller troligen filter + paging + sort. Exakt schema behöver inspekteras genom att faktiskt spara `XMLHttpRequest.send`-body:n.

### Sortering

`orderByPropertyName=<Fältnamn>` + `isAsc=true|false`.

### Filtrering mellan tabs

`tabIndex` i query eller body anger vilken flik (Aktiva/Inaktiva/Alla respektive Pågående/Utförda/etc.).

### Datatyp-ID:n

Alla entitet-ID är stora heltal (6–7 siffror). Exempel: `898679`, `900752`, `943515`.

## Okända/behöver fortsatt utredning

- Exakt login-endpoint och response-format
- Schemat för `POST /service-order/list` body (filter, paging, sort)
- Schemat för `POST /proposals/list/total` body
- Response-body för alla endpoints (storlek/form)
- Hur Digest-headern ser ut i byte — hash-algoritm (MD5 vs SHA-256), exact format
- Endpoints för **skapa/uppdatera/ta bort** serviceorder, kund, tidrad, faktura
- Endpoints för Signeringar, Rapporter, Resursplanering, Inköp, Meddelande
- Artiklar, Anställda, Leverantör, Operatör, Arbetsplats-endpoints under Register

## Plan för vår Electron-klient

Baserat på ovanstående, prioritet (serviceorder som POC enligt användarens val):

### Fas 1 — Auth-wrapper
1. Implementera `DigestAuth`-klass i `src/lib/digest-auth.js` som beräknar Authorization-header per request.
2. Lagra `digestData` i Electron (`electron-store` eller krypterat i `app.getPath('userData')`).
3. Utveckla en enkel login-vy: användaren fyller i användarnamn + lösenord, vi POST:ar mot `/auth/login` (eller klistrar in digestData manuellt som fallback).

### Fas 2 — API-klient i preload.js
Exponera:
```
window.api.login(username, password)
window.api.logout()
window.api.me()                          → loginUser
window.api.serviceOrders.list(filter)    → POST /service-order/list
window.api.serviceOrders.get(id)         → GET /projects/{id} + /projects-header/{id}
window.api.customers.list({pageIndex, pageSize, keyword, tabIndex})
window.api.time.getWeek({userId, startDate, endDate})
```

### Fas 3 — Koppla om renderer
- Orderlista (Entré-kopia) → Serviceorder från Projektportalen. Mappa kolumner: `Nummer`→`Ordernummer`, `Kund`→`Kundens namn`, `Projektnamn`→`Beskrivning`, `Projektledare`→`Vår referens`, `Debiteringsform`+`Status`→`Status-pill`.
- Kundlistan → `/customers-paging/`
- Tidsregistrering → `/time-manage/materials/`

### Fas 4 — Create/Update
Kräver ytterligare reverse-engineering av POST-endpoints (klicka "Skapa" i varje vy och fånga bodyn).
