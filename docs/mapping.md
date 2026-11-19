# Entré → Projektportalen: Mappning

> **Designprincip:** UI:t följer Entrés mönster (orderlista, mini-kalender, enkla dialoger). Datan kommer från Projektportalen. Adapter-lagret i `pp-client.js` översätter mellan de två modellerna.

## Tidsregistrering

### Entré-dialog (vår UI-design)

Fält:
- **Datum** (datum)
- **Tidkod** (dropdown: 010 Arbetstid Montör, 011 Arbetstid Förman, 020 Restid, 030 Övertid 1, ...)
- **Anställd** (automatiskt inloggad användare)
- **Kundorder** (ordernummer, autocompletes mot orderlistan)
- **Projekt** (optional, projektnummer)
- **Objekt** (fri text)
- **Resultatenhet** (default 50)
- **Antal** (timmar, t.ex. 8)
- **Text** (fri kommentar)

### Projektportalens dialog (samma funktion, olika struktur)

Projektportalen har **fyra sektioner** i en dialog:
1. **Rapportera tid** — rader med Projekt/Serviceorder, Moment/Avvikelser/ÄTA, OB, Arbetad tid, Debiterbar tid, Kommentar, Debiterbar-flagga
2. **Rapportera ersättning** — rader med Typ av ersättning, Enhet, Antal, Kommentar
3. **Rapportera frånvaro** — rader med Frånvarotyp, Timmar, Kommentar
4. **Rapportera material** — rader med Artikelgrupp, Material, Benämning, Antal, Enhet, Pris/enhet, Kostnad, Debiterbar

### Mappning Entré → Projektportalen

| Entré-fält | Projektportalen-fält | Anteckning |
|---|---|---|
| Datum | `Timestamp` / `Date` | YYYY-MM-DD |
| Anställd | `UserId` | Inloggad användare |
| Kundorder | `ProjectId` | Projektportalen slår upp på ProjectNumber → ProjectId |
| Projekt | `ProjectId` eller `ParentTaskId` | Samma entitet i Projektportalen |
| Objekt (fritext) | `ProjectTaskId` eller `Comment` | Om matchar moment → Task, annars i Comment |
| Resultatenhet | — | Finns ej direkt — Projektportalen härleder från användarens profil |
| Tidkod 010/011 | Sektion: **Tid**, field `TimeTypeId` | Arbetstid: TimeTypeId = 190 (Elektriker) eller liknande per klient |
| Tidkod 020 (Restid) | Sektion: **Ersättning**, TimeTypeId = "Restid" | Hämta IDn via `/claims-time-types/client` |
| Tidkod 030/031 (Övertid) | Sektion: **Tid**, field `OBHours` / `OvertimeType` | OB-nivåer |
| Tidkod 040 (Sjuk) / 050 (Semester) / 060 (Tjänstledigt) | Sektion: **Frånvaro**, field `AbsenceTypeId` | Olika frånvarotyper |
| Antal | `Quantity` (tid) / `Hours` (frånvaro) | Timmar decimal |
| Text | `Comment` | Fritext |

**Tidkod-kategorisering (routing till rätt sektion)**:

```
010, 011  → POST /api/actual-time         (Rapportera tid)
020       → POST /api/claims              (Ersättning / restid)
030, 031  → POST /api/actual-time         (med OB-flagga)
040, 050, 060 → POST /api/absence         (Frånvaro)
```

> **Not:** Endpoint-paths är hypoteser — måste verifieras genom att faktiskt spara en tidrad och fånga POST-URL:en. Se öppna frågor nedan.

### Adapter-funktion (preview)

```js
// I pp-client.js
async createTimeEntry({
  datum, tidkod, userId, kundorder, projekt, objekt, antal, text, resultatenhet
}) {
  // 1. Kategorisera tidkod
  const code = String(tidkod).substring(0, 3);  // "010", "020", ...
  
  // 2. Slå upp ProjectId från ProjectNumber (om kundorder är ordernr, inte id)
  const projectId = await this._resolveProjectId(kundorder);
  
  // 3. Bygg body utifrån sektion
  if (['010','011','030','031'].includes(code)) {
    return this._request('POST', '/actual-time', { body: {
      ProjectId: projectId,
      UserId: userId || this.digestAuth.username,
      Timestamp: datum + 'T00:00:00',
      Quantity: antal,
      Comment: text || '',
      TimeTypeId: this._mapEntréTidkod(code),
      IsInvoiceAble: true
    }});
  }
  if (code === '020') {
    return this._request('POST', '/claims', { body: {
      ProjectId: projectId, UserId: userId, Date: datum,
      Quantity: antal, Comment: text, TimeTypeId: 20
    }});
  }
  if (['040','050','060'].includes(code)) {
    return this._request('POST', '/absence', { body: {
      UserId: userId, Date: datum, Hours: antal,
      AbsenceTypeId: { '040': 1, '050': 2, '060': 3 }[code],
      Comment: text
    }});
  }
  throw new Error('Okänd tidkod: ' + tidkod);
}
```

## Order (serviceorder)

### Entré-dialog (vår UI)

- **Projekt** (autocomplete mot projektnummer)
- **Kundnummer** *
- **Ordertyp** * (10 = Arbetsorder default)
- **Leveransadress**
- **Beskrivning** *

### Projektportalen-data

Projektportalen har INTE en enkel "Ny order"-dialog — där skapas serviceordrar oftast från en befintlig kund eller projekt. Vår UI är enklare.

### Mappning

| Entré-fält | Projektportalen-fält |
|---|---|
| Projekt (nummer) | `ParentProjectId` |
| Kundnummer | `CustomerId` (slå upp via `/customers-paging` med keyword) |
| Ordertyp | `ProjectType` (10=Arbetsorder, 20=Servicekontrakt, ...) |
| Leveransadress | `Address` + `City` |
| Beskrivning | `ProjectName` |

Förväntad endpoint: `POST /api/service-order` eller `POST /api/projects` med ProjectType-flagga.

### Adapter (preview)

```js
async createServiceOrder({ projekt, kundnummer, ordertyp, leveransadress, beskrivning }) {
  const customer = await this._findCustomer(kundnummer);
  return this._request('POST', '/service-order', { body: {
    CustomerId: customer.CustomerId,
    ParentProjectId: projekt ? await this._resolveProjectId(projekt) : null,
    ProjectType: Number(ordertyp) || 10,
    Address: leveransadress || '',
    ProjectName: beskrivning,
    ClientId: this.digestAuth.clientId
  }});
}
```

## Öppna frågor (måste verifieras)

1. **Exakt POST-URL för tid** — ska vi använda `/actual-time`, `/time-report`, `/time-manage/report`?
2. **Exakt POST-URL för frånvaro** — `/absence`, `/absence-report`?
3. **Exakt POST-URL för order** — `/service-order`, `/projects` med flagga?
4. **TimeTypeId-mappning** — hur hittar vi rätt TimeTypeId för "Elektriker montör" i vår klient? Via `/claims-time-types/client`?
5. **PUT vs POST för uppdatering** — används PUT eller POST för edit?

## Verifieringsplan

För varje skrivoperation behöver vi en **engångs-kartläggning** via browsern:
1. Gå in i Projektportalen, öppna den relevanta dialogen
2. Fyll i ett testvärde (t.ex. 0.1 timme på ett projekt)
3. Klicka Spara
4. Fånga POST-URL + body via XHR-hook
5. Radera testvärdet direkt efter
6. Dokumentera i api-spec.md

## Implementation — stegordning

1. ✅ **Kartläggning** (denna fil)
2. **Verifiera create-endpoints** via 2-3 test-spar + direkt ta bort (tid, order, frånvaro)
3. **Implementera pp-client skrivoperationer**: `createTimeEntry`, `updateTimeEntry`, `deleteTimeEntry`, `createServiceOrder`, `updateServiceOrder`
4. **Preload/main IPC**: Nya kanaler `api:time:create`, `api:orders:create` etc.
5. **Renderer**: Koppla våra befintliga form-submit-handlers (i modalerna) att anropa nya API:er
6. **Felhantering**: Visa serverfel i UI (toast)
7. **Rebuild state**: Efter skapande, kör om `loadLiveOrders`/`loadLiveTime` så UI reflekterar live-state
