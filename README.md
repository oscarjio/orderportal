# OrderPortal

OrderPortal är en desktop-app byggd med Electron som efterliknar gränssnittet och flödet i Entré Portal — ett affärssystem som är vanligt förekommande inom den svenska hantverks- och elbranschen. Syftet är att erbjuda en välbekant arbetsyta för orderhantering, tidsregistrering och kunduppföljning, men i en modern och plattformsoberoende skrivbordsapplikation.

Appen kopplar mot **Projektportalen** (`api-app3.projektportalen.se`). Du loggar in med ditt vanliga Projektportalen-konto, och därefter hämtas serviceordrar, kunder, tidrapporter, material och fakturor direkt därifrån. Viss testdata finns kvar i `src/mock-data.js` för utveckling.

## Ladda ner

Färdiga Windows-filer finns under [Releases](https://github.com/oscarjio/orderportal/releases/latest):

- `OrderPortal-Setup-x.y.z.exe` – installationsprogram
- `OrderPortal-Portable-x.y.z.exe` – körs direkt utan installation

Filerna byggs automatiskt av GitHub Actions. Ny release skapas när en release publiceras på GitHub (Releases → Draft a new release) eller när en tagg som `v0.2.0` pushas. Varje push till `main` bygger också, och filerna kan då hämtas som artefakt under fliken Actions.

## Funktioner

- Hem-vy med dashboard och översikt över pågående arbete
- Orderlista med sök, filtrering och detaljvy
- Tidsregistrering med veckokalender
- Kundlista med sökbar tabell
- Dialoger för att skapa ny order, ny kund och ny tidsregistrering
- Tangentbordsgenvägar för vanliga operationer
- Paketering för Windows, macOS och Linux via electron-builder

## Installation

Du behöver Node.js 18 eller senare installerat. Klona sedan repot, installera beroenden och starta appen i utvecklingsläge.

```bash
npm install
npm start
```

`npm start` startar Electron mot källfilerna under `src/` så att du kan utveckla mot ett levande fönster. Ändringar i renderer-filerna kräver en omladdning av fönstret (Ctrl/Cmd+R).

## Bygga paket

Paketering sker med electron-builder. Kör `npm run build` för att bygga för din nuvarande plattform, eller använd en plattformsspecifik variant.

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

Färdiga installationsfiler hamnar under `dist/`. Observera att kodsignering inte är konfigurerad — det är något vi får återkomma till när distribution blir aktuell.

## Projektstruktur

```
orderportal/
├── main.js               # Electron main process
├── preload.js            # Säker bridge mellan main och renderer
├── package.json
├── src/
│   ├── index.html        # Applikationsfönstrets markup
│   ├── styles.css        # Stilar (färger, layout, komponenter)
│   ├── renderer.js       # Vy-logik och routing
│   ├── login.html        # Inloggningsfönster
│   ├── mock-data.js      # Testdata för utveckling
│   └── lib/              # Projektportalen-klient, digest-auth och lagring av session
└── dist/                 # Byggda paket (genereras av electron-builder)
```

## Inloggning och säkerhet

Vid start visas `src/login.html` om ingen sparad session finns. Inloggningen sker med **HTTP Digest-autentisering** mot Projektportalen (se `src/lib/digest-auth.js` och `docs/api-spec.md`).

- Lösenordet sparas inte på disk. Det som sparas är den beräknade digest-hashen (HA1) tillsammans med användarnamn och klient-id.
- Sessionen sparas i `digest-auth.json` i appens användarmapp (`%APPDATA%\OrderPortal` på Windows) och krypteras med Electrons `safeStorage` (Windows DPAPI), så filen bara kan läsas av ditt Windows-konto.
- Vid omstart återställs sessionen automatiskt. Utloggning raderar den sparade filen.
- All kommunikation går via main-processen (`src/lib/pp-client.js`); renderer-fönstret når bara de funktioner som exponeras i `preload.js`.

## Designanteckningar

Färgpaletten är vald för att ligga nära det intryck Entré Portal ger: en dämpad blågrå bakgrund, en tydlig primärblå accent för knappar och aktiva tillstånd samt en neutral typografi som ska kännas igen av befolkningen på byggarbetsplatsen. Layouten följer samma grova indelning med sidomeny till vänster, topprad med kontext-knappar och en central arbetsyta.

Inspirationen är medveten, men det är värt att notera att frågan om upphovsrätt och varumärke kan bli aktuell om appen når en bredare publik. Tills vidare är projektet ett internt utforskande av UX:en, och inga logotyper eller texter från Entré är kopierade rakt av. Om produkten växer vidare bör vi göra en grundligare juridisk genomgång.

## Tangentbordsgenvägar

Esc stänger den öppna modalen utan att spara. Ctrl+S (Windows/Linux) respektive Cmd+S (macOS) sparar den aktiva dialogens innehåll och stänger den om sparningen går igenom. Fler genvägar kan läggas till allt eftersom flödena fylls på.

## Known limitations

Det finns ingen offline-hantering och ingen felhantering utöver det mest grundläggande. Språket är för närvarande hårdkodat till svenska, och tillgänglighet (tangentbordsnavigering bortom genvägarna, skärmläsarstöd, kontrast) är inte granskad. Tester saknas, och automatiska uppdateringar via electron-updater är inte konfigurerade.
