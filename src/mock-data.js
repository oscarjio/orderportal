/* ============================================================
   Mock-data.
   Ersätts senare av API-anrop via window.api.* (se preload.js).
   ============================================================ */

window.MockData = (function () {
  const customers = [
    { kundnummer: '1000357', namn: 'Exempelbolaget AB', orgnr: '556412-1122', ort: 'Stockholm', telefon: '08-5554321', epost: 'kontakt@exempelbolaget.se', kundgrupp: '10 – Företag' },
    { kundnummer: '1000412', namn: 'Byggmästarna Nord AB', orgnr: '556789-0011', ort: 'Sundsvall', telefon: '060-123456', epost: 'info@byggnord.se', kundgrupp: '10 – Företag' },
    { kundnummer: '1000501', namn: 'Fastighets AB Växjö', orgnr: '556234-8877', ort: 'Växjö', telefon: '0470-998877', epost: 'kundtjanst@fabvaxjo.se', kundgrupp: '10 – Företag' },
    { kundnummer: '1000617', namn: 'Andersson Elservice', orgnr: '556901-3344', ort: 'Malmö', telefon: '040-555666', epost: 'jobb@anderssonel.se', kundgrupp: '10 – Företag' },
    { kundnummer: '1000734', namn: 'Kommunen Örebro', orgnr: '212000-1810', ort: 'Örebro', telefon: '019-210000', epost: 'fastighet@orebro.se', kundgrupp: '30 – Offentlig sektor' },
    { kundnummer: '1000812', namn: 'Nilsson Fastighet AB', orgnr: '556345-9988', ort: 'Göteborg', telefon: '031-333444', epost: 'info@nilssonfast.se', kundgrupp: '10 – Företag' },
    { kundnummer: '1000999', namn: 'Erik Svensson', orgnr: '19800512-1122', ort: 'Uppsala', telefon: '070-1234567', epost: 'erik@gmail.com', kundgrupp: '20 – Privat' },
    { kundnummer: '1001120', namn: 'HSB Brf Granen', orgnr: '716401-5566', ort: 'Linköping', telefon: '013-222111', epost: 'styrelsen@brfgranen.se', kundgrupp: '10 – Företag' }
  ];

  const orders = [
    { nummer: '32715', kund: 'Exempelbolaget AB', kundnummer: '1000357', beskrivning: 'Infoskärmar', referens: 'ON', projekt: '1000357', startdatum: '2026-03-18', belopp: 125000, status: 'Pågående', prio: false, ny: false, flag: 'warn' },
    { nummer: '32801', kund: 'Byggmästarna Nord AB', kundnummer: '1000412', beskrivning: 'Ny installation kontor plan 3', referens: 'AB', projekt: '1000412', startdatum: '2026-04-02', belopp: 89500, status: 'Ny', prio: false, ny: true, flag: null },
    { nummer: '32815', kund: 'Fastighets AB Växjö', kundnummer: '1000501', beskrivning: 'Servicerunda belysning', referens: 'JM', projekt: '1000501', startdatum: '2026-04-05', belopp: 23400, status: 'Ny', prio: true, ny: true, flag: 'prio' },
    { nummer: '32820', kund: 'Andersson Elservice', kundnummer: '1000617', beskrivning: 'Felsökning huvudcentral', referens: 'PL', projekt: '-', startdatum: '2026-04-08', belopp: 14800, status: 'Klar', prio: false, ny: false, flag: 'ok' },
    { nummer: '32844', kund: 'Kommunen Örebro', kundnummer: '1000734', beskrivning: 'Nödbelysning skola Vivalla', referens: 'ON', projekt: '2026-15', startdatum: '2026-04-10', belopp: 312000, status: 'Pågående', prio: true, ny: false, flag: 'prio' },
    { nummer: '32870', kund: 'Nilsson Fastighet AB', kundnummer: '1000812', beskrivning: 'Byte av armaturer garage', referens: 'JM', projekt: '1000812', startdatum: '2026-04-12', belopp: 56700, status: 'Pågående', prio: false, ny: false, flag: 'warn' },
    { nummer: '32901', kund: 'Erik Svensson', kundnummer: '1000999', beskrivning: 'Installation laddbox privat', referens: 'ON', projekt: '-', startdatum: '2026-04-14', belopp: 18200, status: 'Ny', prio: false, ny: true, flag: null },
    { nummer: '32915', kund: 'HSB Brf Granen', kundnummer: '1001120', beskrivning: 'Årlig elkontroll + protokoll', referens: 'AB', projekt: '1001120', startdatum: '2026-04-15', belopp: 22500, status: 'Pågående', prio: false, ny: false, flag: 'warn' },
    { nummer: '32920', kund: 'Exempelbolaget AB', kundnummer: '1000357', beskrivning: 'Extra skärmar reception', referens: 'ON', projekt: '1000357', startdatum: '2026-04-16', belopp: 42000, status: 'Ny', prio: false, ny: true, flag: null },
    { nummer: '32931', kund: 'Byggmästarna Nord AB', kundnummer: '1000412', beskrivning: 'Underhållsavtal kv 2', referens: 'AB', projekt: '1000412', startdatum: '2026-04-17', belopp: 67200, status: 'Pågående', prio: false, ny: false, flag: 'warn' },
    { nummer: '32944', kund: 'Fastighets AB Växjö', kundnummer: '1000501', beskrivning: 'Tavelbyte källare', referens: 'JM', projekt: '1000501', startdatum: '2026-04-17', belopp: 31200, status: 'Ny', prio: true, ny: true, flag: 'prio' },
    { nummer: '32955', kund: 'Kommunen Örebro', kundnummer: '1000734', beskrivning: 'Akut utryckning Vivalla badhuset', referens: 'PL', projekt: '2026-15', startdatum: '2026-04-18', belopp: 8900, status: 'Klar', prio: false, ny: false, flag: 'ok' }
  ];

  // Några förifyllda tidsregistreringar för aktuell vecka (v.16, mån-fre)
  const timeEntries = [
    { id: 1, datum: '2026-04-13', tidkod: '010 – Arbetstid Montör', order: '32715', projekt: '1000357', text: 'Installation skärmar plan 2', antal: 8, status: 'Klar' },
    { id: 2, datum: '2026-04-14', tidkod: '010 – Arbetstid Montör', order: '32715', projekt: '1000357', text: 'Konfiguration mediaspelare', antal: 8, status: 'Klar' },
    { id: 3, datum: '2026-04-15', tidkod: '010 – Arbetstid Montör', order: '32844', projekt: '2026-15', text: 'Skola Vivalla – nödbelysning', antal: 6, status: 'Pågående' },
    { id: 4, datum: '2026-04-15', tidkod: '020 – Restid', order: '32844', projekt: '2026-15', text: 'Resa Örebro t/r', antal: 2, status: 'Pågående' },
    { id: 5, datum: '2026-04-16', tidkod: '010 – Arbetstid Montör', order: '32844', projekt: '2026-15', text: 'Skola Vivalla – nödbelysning', antal: 8, status: 'Pågående' },
    { id: 6, datum: '2026-04-17', tidkod: '010 – Arbetstid Montör', order: '32870', projekt: '1000812', text: 'Byte armaturer P-garage', antal: 8, status: 'Pågående' }
  ];

  return {
    customers,
    orders,
    timeEntries,
    nextOrderNumber: () => String(Math.max(...orders.map(o => +o.nummer)) + 1),
    nextCustomerNumber: () => String(Math.max(...customers.map(c => +c.kundnummer || 0)) + 1)
  };
})();
