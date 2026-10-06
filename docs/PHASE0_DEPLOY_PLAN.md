# Fase 0 — piano di deploy e misura su device reali

Scopo: portare la pagina spike, il modulo WASM e il disco dove un telefono possa usarli davvero,
su un host che non sia la VPS, e misurare su device reali fino al verdetto go/no-go.
Scritto il 2026-09-30, sul branch `phase0/oz-size-experiment`. Chi lo esegue non deve riprogettare
nulla: dove un fatto non è stato verificato durante la stesura c'è scritto "**da verificare**",
con il modo per verificarlo.

**Nota sulle fonti.** Ogni percorso, campo e numero interno al progetto è stato letto nel file
citato. I limiti dei servizi Cloudflare **non** sono stati verificati sulle pagine ufficiali
durante la stesura (l'accesso al web non era disponibile): quelli riportati vengono dai documenti
del repository, che a loro volta li hanno presi dalla documentazione, e sono marcati come tali.

---

## 0. Presupposti del committente che non reggono

Vengono prima di tutto perché cambiano l'ordine dei lavori.

1. **"La misura che conta è quella servita da un host vero": vero per il prodotto, falso per il
   go/no-go.** Il numero del verdetto è `sim_ms`: il tempo di simulazione di un frame, misurato
   dentro il Worker attorno a `callMain` (`web/src/spike/worker.ts`), a disco già locale e modulo
   già compilato. L'host non entra in quel numero. Le condizioni che contano sono tre: pagina in
   **contesto sicuro** (HTTPS o `localhost`) con gli header di isolamento, disco **sul device**, e
   lo **stesso core** verificato sui 2400 checkpoint. La spec stessa lo ammette:
   `docs/SPEC_PIANO.md` passo 8 dice di aprire la pagina dal telefono con "il port forwarding del
   Codespace (porta pubblica temporanea) o un deploy su Cloudflare Pages di anteprima", e
   `docs/PHASE0_NEXT.md` S9 sceglie il port forwarding USB verso `localhost`.
   **Conseguenza:** il go/no-go **non deve aspettare** le credenziali Cloudflare. L'host vero serve
   a misurare altre cose, che contano per il prodotto: tempo di download del modulo, arrivo del
   disco, header reali in produzione, protezione dell'accesso. Questo piano tiene le due strade
   separate (sezione 4, righe M2 e M5).
2. **Il modulo sotto i 25 MiB esiste solo su questo branch.** `-Oz -g0` è in
   `wasm/core/CMakeLists.txt` (righe 19 e 23) sul branch `phase0/oz-size-experiment`, che **non è
   in `main`** (`git branch --contains 55f101c` elenca solo il branch e il suo remoto). Su `main`
   il core è ancora `-O1` e pesa circa 87 MB. Il primo passo è quindi portare il branch in `main`.
   **Stato al 2026-10-05: quel passo è fatto.** Il branch è in `main` dal 2026-09-30 (PR #13,
   §5 "Fatta"); su `main` `wasm/core/CMakeLists.txt` riga 23 tiene `MELEE_OPT` a `-Oz` e la
   riga 32 aggiunge `-g0` — le righe 19 e 23 citate qui sopra sono quelle del branch del
   2026-10-01 — e il modulo web che la CI spedisce è 15.278.441 byte (§5, PR 1). Il paragrafo
   resta l'analisi del 2026-10-01, non lo stato di oggi.
3. **16.323.657 byte è il modulo Node, non quello web.** La tabella di `docs/PROGRESS.md` (ultima
   sezione) confronta con 87.118.511 byte, che nella sezione S6 è il **modulo Node**; il modulo web
   a `-O1` era 87.118.045. La dimensione del modulo **web** a `-Oz` è stata letta il 2026-10-01 nel
   log della run `36743835141`, alla riga di `scripts/phase0/wasm_report.py`, che riporta due
   moduli: `"wasm_bytes": 16323657` (Node) e `"wasm_bytes": 16323255` (web), entrambi con
   `"within_pages_limit": true`. I due differiscono di 402 byte, e il valore atteso era giusto: il
   modulo web è **16.323.255 byte**, il 62% del limite per file di Pages (§1).
4. **Mettere il modulo su Cloudflare non è ancora permesso.** Il modulo è derivato dal DOL (codice
   del gioco). L'eccezione D3 (`docs/PHASE0_TASKS.md`) copre solo artefatti **privati di GitHub,
   3 giorni**, e la sua estensione alla pagina web (Q8 in `docs/OPEN_QUESTIONS.md`) non ha ancora
   risposta. Pubblicarlo su Cloudflare, anche protetto, è un passo in più che **decide
   l'operatore**. Inoltre la spec vuole il sito "mai pubblico" (`docs/SPEC_PIANO.md`, riga 15:
   "Uso privato tra amici: accesso protetto, mai pubblico"): un indirizzo `*.pages.dev` senza
   Cloudflare Access (il filtro di login di Cloudflare, sezione 3) **non è un'opzione**.
5. **Il disco intero sul telefono non è l'architettura del prodotto.** La spec (riga 9) dice
   "Niente installazioni, niente ISO sul suo dispositivo": nel prodotto i file vengono estratti dal
   disco, caricati su R2 e messi in cache nel browser uno per uno (`docs/SPEC_PIANO.md`, righe 178–179).
   Qui il disco intero va sul telefono **solo perché il core di Fase 0 legge una ISO**. La scelta
   della sezione 2 è quindi fatta per la misura, e non va trattata come base del prodotto.
6. **Il 25 MiB per file di Pages era stato scritto dalla documentazione, non letto.** Il numero è
   nel repository (`scripts/phase0/wasm_report.py`, riga 83: `25 * 1024 * 1024` = 26.214.400 byte).
   **Verificato** il 2026-10-01 su `https://developers.cloudflare.com/pages/platform/limits/`:
   "The maximum file size for a single Cloudflare Pages site asset is 25 MiB". Il modulo web a
   `-Oz` (16.323.255 byte) è il 62% di quel limite.

Due difetti del repository che il piano corregge (sezione 5), trovati leggendo i file:

- `web/public/_headers` dà a **tutti** i `*.wasm` `Cache-Control: public, max-age=31536000,
  immutable`. Il modulo spike ha un nome fisso (`/spike-core/melee_core_web.wasm`): dopo un nuovo
  deploy il telefono potrebbe usare il **vecchio** modulo dalla cache HTTP mentre `core.json`,
  che non ha quella regola, annuncia il commit **nuovo**. Il controllo C3 di
  `docs/PHASE0_DEVICE_PLAN.md` (commit uguale) non se ne accorgerebbe. Il service worker salta
  `/spike-core/` (`web/public/sw.js`, riga 42), ma la cache HTTP no.
- Il commento in `web/vite.config.ts` dice che `_headers` sta "at the repo root": sta in
  `web/public/_headers`.
  **Corretto il 2026-10-01** da `aad3598` (PR #28), che ha ripiegato in
  sé la correzione minore assegnata dalla sezione 5: il commento ora nomina
  `web/public/_headers` (`web/vite.config.ts` riga 8), quindi questa voce non chiede più nulla.

---

## 1. Il problema in una pagina

Un telefono, per fare una corsa, deve avere tre cose.

| Cosa | File | Dimensione | Da dove viene |
| --- | --- | --- | --- |
| **La pagina** | `spike.html` più il JavaScript costruito da `web/src/spike/main.ts`, `compare.ts`, `worker.ts` | **misurata**: il `dist` della spike ha 21 file per 18.005.796 byte, di cui 16.389.654 sono `spike-core`; senza il core e senza le mappe dei sorgenti restano 13 file per **268.162 byte** (`spike.html` da solo: 690 byte) | `vite build` nella workflow `phase0-build.yml` |
| **Il modulo** (il gioco compilato in WebAssembly, *WASM*) | `spike-core/melee_core_web.wasm` + `melee_core_web.js` (il codice JavaScript che lo carica), `core.json`, `parity_vs_onett.txt` | `.wasm`: 87.118.045 byte a `-O1`; a `-Oz` **16.323.255 byte** per il modulo web e 16.323.657 per quello Node (§0.3) | stessa workflow, righe 131–191 (la compilazione del core e il `wasm-opt`) |
| **Il disco** | la ISO di Melee NTSC 1.02 | **1.459.978.240 byte** (1,46 GB; 1,36 GiB), SHA-1 `d4e70c064cc714ba8400a849cf299dbd1aa326fc` | solo sulla VPS, `/home/hermes/incoming/melee-ntsc102.iso` (`docs/OPEN_QUESTIONS.md` Q1); mai nel repository |

In memoria il modulo parte con 256 MB (`-sINITIAL_MEMORY=256MB`, `wasm/core/CMakeLists.txt`
riga 38) e può crescere. Il disco **non** viene copiato in memoria: il Worker lo legge a pezzi,
su richiesta, durante la simulazione.

**Come il core legge il disco oggi.** `worker.ts` riceve un oggetto `File` (un file locale che il
browser sa leggere) e lo "monta" con **WORKERFS**: un file system di Emscripten che, dentro un
Worker, legge un `File` a pezzi con `FileReaderSync`, cioè in modo sincrono. Il core vede il
disco come `/disc/<nome>`. Qualunque strada scelta per il disco deve finire con un `File` locale,
oppure costringe a cambiare file system.

**Quali limiti toccano cosa.**

| Limite | Valore | Stato | Tocca |
| --- | --- | --- | --- |
| Dimensione massima di un file su Cloudflare Pages | 25 MiB = 26.214.400 byte | **verificato** il 2026-10-01: "The maximum file size for a single Cloudflare Pages site asset is 25 MiB" (pagina dei limiti di Pages); il numero di `wasm_report.py` riga 83 è quello documentato | il modulo: a `-O1` è 3,3 volte sopra, a `-Oz` sotto. Il disco è 55 volte sopra: **non può stare su Pages**, in nessun caso |
| Numero di file per sito Pages | 20.000 (piano Free), 100.000 (piani a pagamento) | **verificato** il 2026-10-01, stessa pagina | non ci tocca: il `dist` della spike ha 21 file (misurati, §1) |
| Caricamento su R2 (lo spazio di archiviazione di Cloudflare) con `wrangler r2 object put` | 315 MB per oggetto, un oggetto alla volta | **verificato** il 2026-10-01: "Wrangler supports uploading files up to 315 MB and only allows one object at a time" (pagina "Upload objects" di R2); il numero di `docs/DEPLOY.md` §3 è quello documentato | il disco (1,46 GB) non si carica con `wrangler`: serve l'interfaccia compatibile S3 di R2 (sezione 2) |
| Dimensione massima di un oggetto R2 e di un singolo caricamento senza *multipart* (caricamento a pezzi) | oggetto: 5 TiB (4,995 TiB); caricamento singolo: **5 GiB**; multipart: 4,995 TiB in al più 10.000 parti da 5 MiB–5 GiB | **verificato** il 2026-10-01 sulla pagina dei limiti di R2 | il disco (1,46 GB = 1,36 GiB) **sta** in un PUT singolo per il limite documentato, ma è fuori dalla fascia che la guida di R2 raccomanda per il PUT singolo ("small to medium files (under ~100 MB)"): per un file così il percorso documentato è il multipart, che `rclone` fa da sé (sezione 2) |
| Livello gratuito di R2 (spazio, operazioni, traffico in uscita) | 10 GB-mese di spazio, 1 milione di operazioni di Classe A, 10 milioni di Classe B, uscita **gratuita** | **verificato** il 2026-10-01 su `https://developers.cloudflare.com/r2/pricing/`: la spec diceva il vero sull'uscita. Resta vero che serve una carta di pagamento per attivare R2 | il disco (1,36 GiB fermi) **sta** dentro i 10 GB-mese: tenerlo in R2 non si paga. Un download completo costa 88 operazioni di Classe B, quindi i 10 milioni al mese coprono circa 113.000 download completi |
| Utenti di Cloudflare Access gratis | 50 utenti | **verificato** il 2026-10-01 sulla pagina Access di `cloudflare.com`: il piano gratuito è descritto come "Best for teams under 50 users" e la tabella di confronto riporta "50 user limit"; la spec diceva il vero | la protezione di pagina e disco |
| Richieste gratuite al giorno delle Pages Functions (piccoli programmi eseguiti da Cloudflare) | 100.000 richieste al giorno e 10 ms di CPU per richiesta (piano Workers Free) | **verificato** il 2026-10-01 sui limiti di Workers, che valgono per le Functions: "Requests to Pages functions count towards your quota for Workers plans" (limiti di Pages) | il disco servito a pezzi (88 richieste per un download completo, sezione 2): la quota giornaliera copre circa 1.100 download completi |
| Spazio del browser per un sito (quota di OPFS) | non documentato, varia per browser e telefono | si misura sul device con `navigator.storage.estimate()` | il disco, se messo nel browser |
| Memoria per tab | non documentata, varia per modello | si osserva sul device (`docs/PHASE0_DEVICE_PLAN.md` §3) | modulo e memoria del core |

**Come sono stati verificati i numeri di questa tabella (2026-10-01).** Non con un account: leggendo le pagine, ognuna citata nella riga che chiude. `developers.cloudflare.com/pages/platform/limits/` (dimensione per file, numero di file per sito, e la riga che dice che le Functions contano sulla quota di Workers), `developers.cloudflare.com/r2/platform/limits/` (dimensione dell'oggetto e del caricamento), `developers.cloudflare.com/r2/pricing/` (livello gratuito, Classi A e B), `developers.cloudflare.com/r2/objects/upload-objects/` (la nota sui 315 MB di Wrangler e la tabella "PUT singolo contro multipart"), `cloudflare.com/zero-trust/products/access` (i 50 utenti di Access). Le due dimensioni locali non vengono da una stima ma dagli artefatti: il `dist` della spike in `/home/hermes/incoming/phase0/spike-dist` (misurato con `find . -type f -printf '%s'`), e il log della run `36743835141` per il modulo. Restano **da verificare**, perché solo un deploy con il modulo le può mostrare: gli header davvero serviti e la compressione davvero applicata. **Che il modulo venga compresso è documentato dal 2026-10-04** (sezione 3, riga "Compressione del modulo nel trasferimento": `application/wasm` è fra i tipi di contenuto che Cloudflare comprime, e il modulo supera di molto la soglia di 50 byte); quale algoritmo e con quali header lo mostra solo il `curl`. Il **binding R2 dell'ambiente di anteprima** non è più fra le ipotesi: è stato misurato il 2026-10-02 su un deploy pubblicato (sezione 3, riga O8). Le **regole** che producono quegli header non sono più ipotesi dal 2026-10-04 (sezione 3, riga "Niente cache immutabile": la somma di due regole che combaciano e la sintassi `!` sono documentate, con la citazione). Tre delle cinque voci non sono più ipotesi dal 2026-10-04. **Il formato dell'indirizzo** è verificato: `https://phase0-spike.melee-web.pages.dev/spike.html` risponde `200`, quindi la forma è `<branch>.<progetto>.pages.dev`. **La copertura di Access sugli indirizzi `*.pages.dev`** è verificata e ha un limite misurato: Access copre l'intero wildcard `*.melee-web.pages.dev` — un alias di branch che **non esiste** (`nosuchbranch-ctrl-9182.melee-web.pages.dev`) riceve la stessa pagina di login, quindi non è la presenza di un deploy a procurarla — mentre l'apex `melee-web.pages.dev` **non** è coperto e risponde il `404` "Deployment Not Found" di Pages senza chiedere il login (sezione 3, riga "Accesso protetto").

---

## 2. Dove vive il disco

Questa è la decisione centrale. Le strade reali sono cinque.

| Strada | Costo | Cosa serve all'operatore | Il telefono scarica 1,46 GB ogni volta? | Se la connessione cade a metà | File system nel Worker |
| --- | --- | --- | --- | --- | --- |
| **A. File scaricato a mano sul telefono e scelto col selettore** (oggi) | zero | scaricarlo da un server con richieste parziali (la VPS via `tailscale serve`, o il desktop) e metterlo nella memoria del telefono | no, una volta sola | lo riprende il gestore download del browser, se il server accetta le richieste parziali (`scripts/phase0/serve_spike.py` lo fa) | WORKERFS invariato |
| **B. Bucket R2 letto direttamente durante la simulazione** (un *bucket* è un contenitore di file su R2; le **richieste parziali**, header HTTP `Range`, chiedono solo un pezzo di un file) | R2 (livello gratuito **verificato** il 2026-10-01, sezione 1) | account Cloudflare, bucket, credenziali | no, ma ogni corsa rilegge dalla rete i pezzi che servono | la simulazione si blocca o fallisce a metà corsa | **nuovo**: serve un file system che legga via HTTP in modo sincrono (per esempio `FS.createLazyFile` di Emscripten con XHR sincrona nel Worker). **Scartata:** le letture di rete finirebbero dentro `sim_ms`, e il numero del verdetto misurerebbe la rete |
| **C. R2 come origine + OPFS popolato una volta** (*OPFS*, Origin Private File System: uno spazio di file privato del sito dentro il browser, che resta tra una visita e l'altra) | R2 (livello gratuito **verificato** il 2026-10-01, sezione 1) + Pages | account Cloudflare, bucket R2, chiavi S3 per il caricamento, Cloudflare Access (dettagli in sezione 3) | **no**: una volta per sito e per browser. Di nuovo solo se il browser libera lo spazio o l'operatore cancella i dati del sito | la pagina riprende dal punto in cui era arrivata (chiede `Range: bytes=<già scaricati>-`) e controlla ogni pezzo con un hash | **WORKERFS invariato**: `FileSystemFileHandle.getFile()` di OPFS restituisce un `File`, che si monta esattamente come quello del selettore |
| **D. Server con richieste parziali sotto il nostro controllo** (la VPS dietro `tailscale serve`, o il desktop dell'operatore con port forwarding USB) | zero | Tailscale sul telefono con HTTPS attivo nella tailnet, oppure un desktop con Node ≥ 18 e un cavo USB (`docs/OPEN_QUESTIONS.md` Q8) | come A | come A | come A |
| **E. Altri bucket** (S3, Backblaze B2, …) | da verificare, e il traffico in uscita di solito si paga | un secondo account e un secondo fornitore | come C | come C | come C, ma con il disco su un'altra origine: con l'isolamento (COEP, sezione 3) servono CORS e l'header `Cross-Origin-Resource-Policy` configurati sul fornitore. **Scartata:** nessun vantaggio rispetto a C, e la spec ha già scelto Cloudflare |

**Scelta: C per l'host vero, D (già pronta) per non aspettare le credenziali.**

Perché C:

- è l'unica strada con un host vero che **non mette la rete dentro `sim_ms`**: al momento della
  corsa il disco è un file locale, come col selettore;
- **non cambia il file system del core**: `worker.ts` riceve ancora un `File` e lo monta con
  WORKERFS; il `.wasm` non si ricompila;
- **niente passaggi manuali col file**: niente app File, niente download da spostare, niente
  selettore con un file da 1,46 GB (e su Android non è verificato che `FileReaderSync` legga a
  pezzi un file scelto dal selettore: `docs/PHASE0_DEVICE_PLAN.md` §3 lo segnala per iOS, e il
  rischio è lo stesso);
- è il **meccanismo** che il prodotto userà comunque (R2 + OPFS, `docs/SPEC_PIANO.md` riga 179),
  anche se con file estratti invece che con la ISO intera.

**Come arriva il disco da R2 alla pagina, senza problemi di origine.** Il bucket resta privato.
Una Pages Function nello **stesso sito** della pagina (percorso `/phase0/disc`) legge il disco
dal bucket tramite un *binding* (un collegamento dichiarato in `wrangler.toml`, come l'esistente
`ASSETS_R2`) e risponde alle richieste parziali. Stessa origine vuol dire: niente dominio
personalizzato per R2, niente regola CORS, niente regola per `Cross-Origin-Resource-Policy`
(tutte cose che `docs/DEPLOY.md` §2 punto 3 chiederebbe per un dominio R2 separato), e la stessa
protezione Access della pagina. La spec indica questa alternativa come "più semplice"
(`docs/SPEC_PIANO.md` riga 307). La middleware esistente `functions/_middleware.ts` rifiuta con
403 ogni richiesta alle Functions senza un token Access valido, quindi il disco resta chiuso
anche se Access fosse configurato male.

**Come il telefono scarica senza ricominciare da capo.** Il disco si scarica in pezzi da 16 MiB
(16.777.216 byte): 88 pezzi, l'ultimo da 360.448 byte. Sulla VPS uno script calcola l'hash
SHA-256 di ogni pezzo e lo carica su R2 accanto al disco. La pagina, per ogni pezzo: lo chiede
con `Range`, ne calcola l'hash con WebCrypto (ci sta in memoria: 16 MiB), lo confronta, lo scrive
in OPFS. Se la connessione cade, alla ripresa guarda quanti byte ci sono già e riparte dal pezzo
successivo. **Perché l'hash per pezzo e non uno solo alla fine:** il SHA-1 dell'intero disco
richiederebbe di tenere 1,46 GB in memoria (WebCrypto non calcola a flusso), e un disco corrotto
in cache darebbe una traccia DIFFERENT che si scambierebbe per "il browser calcola diverso". La
traccia dei 2400 checkpoint resta la prova finale; gli hash per pezzo servono a scoprire un disco
rovinato **prima** di una corsa lunga.

**Cosa costa cambiare la pagina.** Un modulo nuovo (download, ripresa, verifica, scrittura in
OPFS), un bottone in `spike.html`, e in `main.ts` una riga che prende il `File` da OPFS invece che
dal selettore quando c'è. Il selettore resta, per la strada D. Il Worker del core non cambia
file system. Per scrivere in OPFS il modulo nuovo usa un Worker dedicato con
`createSyncAccessHandle()` (la scrittura sincrona di OPFS, disponibile solo nei Worker), che è la
forma più diffusa tra i browser; **da verificare** sul device alla prima prova. Stima: qualche
centinaio di righe TypeScript più una Function di poche decine; nessuna ricompilazione del core.

**Tre condizioni della strada C da sapere prima.**

- **Niente finestre private.** In una finestra privata lo spazio del sito è temporaneo o assente
  (comportamento esatto **da verificare** per browser): il disco sparirebbe a ogni corsa. Il
  piano del device usava le finestre private per evitare il service worker; qui il problema si
  toglie alla radice, perché il deploy spike **non include** `sw.js` (sezione 5). Il controllo in
  `main.ts` ("a service worker controls this page") resta come rete di sicurezza.
- **Spazio.** Prima di scaricare, la pagina legge `navigator.storage.estimate()` e rifiuta se
  mancano 1,46 GB più un margine, e chiede `navigator.storage.persist()` perché il browser non
  cancelli il disco per fare spazio. L'esito di `persist()` va nel JSON (sezione 5).
- **Un disco per origine.** OPFS appartiene al sito: il disco scaricato dall'indirizzo Cloudflare
  non è visibile dall'indirizzo `tailscale` e viceversa.

---

## 3. Dove vive la pagina

**Servizio: Cloudflare Pages, progetto `melee-web`, come deploy di anteprima sul branch
`phase0-spike`.** Il progetto è già definito in `wrangler.toml` (`name = "melee-web"`), e un deploy
fatto con `--branch` diverso da quello di produzione (`main`, `docs/DEPLOY.md` §2) è un'anteprima
con un indirizzo suo. Motivi: niente server da gestire (la spec vieta la VPS nel prodotto, riga 14);
header controllati da un file nel deploy; Functions nello stesso sito per il disco; niente
dominio da comprare. Il formato dell'indirizzo dell'anteprima è **verificato** il 2026-10-04:
`https://phase0-spike.melee-web.pages.dev/spike.html` risponde `200`, quindi la forma attesa
`<branch>.<progetto>.pages.dev` è quella giusta.
Essendo un'origine diversa da quella di produzione, non eredita service worker né dati.

### Requisiti che il servizio deve soddisfare, e come si verifica ciascuno

Tutti si verificano dopo il primo deploy, dalla VPS con `curl` (serve il service token di Access,
vedi sotto) e con il telefono. Nessuno è stato verificato durante la stesura.

| Requisito | Perché | Dove si imposta | Verifica |
| --- | --- | --- | --- |
| `Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Embedder-Policy: require-corp` su `spike.html` | senza isolamento `performance.now()` è arrotondato e ogni `sim_ms` è quantizzato (`docs/PHASE0_DEVICE_PLAN.md` §0 punto 3) | `web/public/_headers`, già presente e copiato nel `dist` da Vite | `curl -sI …/spike.html` mostra i due header; nel JSON `cross_origin_isolated` è `true` e `timer_resolution_ms` ≤ 0,1 |
| HTTPS | l'isolamento esiste solo in contesto sicuro | automatico su `pages.dev` | l'indirizzo è `https://` |
| `Content-Type: application/wasm` sul modulo | lo richiede la compilazione a flusso del browser | `_headers`, regola `/*.wasm` già presente | `curl -sI …/spike-core/melee_core_web.wasm` |
| **Niente cache immutabile** su `/spike-core/*` | §0, primo difetto | regola aggiunta al `_headers` **del solo deploy spike** dalla workflow | lo stesso `curl` non mostra `immutable`. Le due domande sono **verificate il 2026-10-04** su `https://developers.cloudflare.com/pages/configuration/headers/`, senza account: le regole che combaciano si **sommano** ("If a header is applied twice in the `_headers` file, the values are joined with a comma separator") e la sintassi per staccare un header esiste ed è quella che la workflow usa ("This can be done by prepending the header name with an exclamation mark and space (`!`)"). Senza la riga `! Cache-Control` il modulo riceverebbe quindi `public, max-age=31536000, immutable, no-store`; con essa la regola spike è il rimedio documentato. Resta **da verificare con il `curl` del primo deploy**, perché la pagina non lo dice, se un `!` nella **stessa** regola che poi rimette l'header sia applicato in ordine — la pagina lo mostra in una regola separata |
| Richieste parziali sul disco | ripresa del download | la Function `/phase0/disc` | `curl -sI -H 'Range: bytes=0-5' …/phase0/disc` → `206` e `Content-Range: bytes 0-5/1459978240` |
| Dimensione per file | il modulo deve starci | limite di Pages, §1 | il deploy riesce; il log di `wasm_report.py` dice `within_pages_limit: true` per il modulo web |
| Access protetto | spec riga 15; il modulo è derivato dal gioco | Cloudflare Access, applicazione che copre l'indirizzo dell'anteprima | **Misurato il 2026-10-04 senza credenziali**: senza token si riceve la pagina di login Access e non il contenuto, su `/spike.html`, su `/spike-core/core.json` e su `/phase0/disc-chunks` (`200` con "Sign in · Cloudflare Access"). La copertura degli indirizzi `*.pages.dev` è **verificata**: un alias di branch che non esiste (`nosuchbranch-ctrl-9182.melee-web.pages.dev`) riceve la stessa pagina di login, quindi Access copre il wildcard e non solo gli indirizzi con un deploy. **Limite misurato**: l'apex `melee-web.pages.dev` **non** è coperto — risponde il `404` "Deployment Not Found" di Pages senza richiesta di login (la shell di produzione non è pubblicata: `CF_DEPLOY_SHELL` in `.github/workflows/ci.yml`), quindi il giorno in cui la shell viene pubblicata su quell'indirizzo sarà leggibile da chiunque, e O6 va esteso all'apex prima. Restano da verificare, con un token, gli header davvero serviti (la middleware annota comunque il limite: `functions/_middleware.ts` riga 82) |
| Compressione del modulo nel trasferimento | tempo di caricamento sul telefono | **automatica: documentata il 2026-10-04** leggendo la pagina, senza account — `https://developers.cloudflare.com/speed/optimization/content/compression/` (lo stesso testo è servito da `…/content/brotli/`, stesso titolo "Content compression"; la pagina porta `dateModified` 2026-04-17). `application/wasm` è nell'elenco dei tipi di contenuto per cui "Cloudflare will return Gzip, Brotli, or Zstandard-encoded responses"; la pagina comprime le risposte di successo solo se sono `200` (degli errori solo `403` e `404`), e la soglia minima è 48 byte per gzip e 50 per Brotli e Zstandard — il modulo è 16.323.255 byte a `-Oz`, quindi molto sopra. L'algoritmo dipende dal piano e dall'`accept-encoding` del browser: la stessa pagina dice "Free Plan: Content is compressed by default using Zstandard", Pro e Business Brotli, Enterprise Gzip, **e** in una nota "Customers can enable Zstandard compression through Compression Rules": le due frasi si contraddicono, e qui si registrano entrambe invece di scegliere. Le Compression Rules non sarebbero comunque disponibili su `*.pages.dev` ("Compression Rules require that you proxy the DNS records of your domain (or subdomain) through Cloudflare"), quindi resta il comportamento predefinito. Ciò che lo annullerebbe è `cache-control: no-transform`; nel `dist` della spike non c'è — la regola aggiunta dalla workflow è `no-store`. Resta **da verificare con il `curl` del primo deploy** l'header davvero servito e l'algoritmo scelto | **Il comando che questa riga chiedeva va corretto**: `-H 'Accept-Encoding: br, gzip'` non annuncia `zstd`, che è l'algoritmo che la pagina dà per predefinito sul piano Free, e `-I` è una HEAD, di cui la pagina non dice nulla (la sua regola parla degli status); una richiesta con `Range` sarebbe una `206`, che la pagina esclude dalla compressione. Il controllo è quindi un GET completo con l'header di un browser: `curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip, deflate, br, zstd' …/spike-core/melee_core_web.wasm`, e si legge `content-encoding` nell'output |

Le Pages Functions ricevono gli header da `_headers`? **No, verificato il 2026-10-04** sulla stessa
pagina: le regole di `_headers` "will be applied to static asset responses", e la risposta di una
Function non è un asset statico. La Function del disco imposta quindi da sé `Accept-Ranges`,
`Content-Range`, `Cache-Control: no-store` e `Cross-Origin-Resource-Policy: same-origin`, e non
dipende dalla risposta; la middleware fa lo stesso sui propri `403` e `503`
(`functions/_middleware.ts` righe 94 e 96, dove `Cache-Control: no-store` è scritto a mano). La riga
sulla cache qui sopra riguarda perciò il solo modulo, che è un file del `dist`.

### Come si automatizza dalla CI

Solo `.github/workflows/phase0-build.yml` costruisce il core e il `dist` della pagina spike
(righe 131–191 per il core, 224–246 per la pagina), quindi il deploy va **lì**, come passo finale, non in `ci.yml` (il cui job
`deploy` pubblica la shell senza core). Il passo:

- parte solo con `workflow_dispatch` e un nuovo input `deploy_spike` (predefinito `false`), come
  l'esistente `upload_spike`, e solo dopo il test in Chromium;
- se mancano le credenziali **si salta con un avviso** e la workflow resta verde, come il job
  `deploy` di `ci.yml` (riga 201);
- toglie `sw.js` dal `dist` spike e aggiunge la regola `/spike-core/*` al suo `_headers`;
- pubblica con lo script esistente: `scripts/deploy.sh --branch phase0-spike --dist-dir
  "$RUNNER_TEMP/spike-dist"`. Lo script esegue `wrangler pages deploy … --project-name
  "$CF_PAGES_PROJECT" --branch …` (`scripts/deploy.sh` righe 90–91) dalla radice del repository,
  quindi pubblica anche `functions/`. Che accetti un `dist` fuori da `web/dist` è
  **verificato**, due volte: il 2026-09-30 sul `dist` della spike sulla VPS (`docs/DEPLOY.md` §5)
  e il 2026-10-06 su una copia del `dist` che questa workflow costruisce —
  `scripts/deploy.sh --dry-run --branch phase0-spike --repo-dir <un checkout pulito> --dist-dir
  <dist>` esce 0 e stampa il comando con quel percorso. Gli unici controlli che leggono il `dist`
  sono due file, `_headers` e `index.html` (`scripts/deploy.sh` righe 79 e 82), e la sua posizione
  non è fra loro. Il `--dry-run` del 2026-10-06 ha però trovato un difetto, corretto nella stessa
  PR: il controllo dell'albero usava `[ -d "$repo_dir/.git" ]`, e in un **worktree** `.git` è un
  file, quindi un `--dry-run` da un worktree pulito era rifiutato con `is not a git checkout`
  (exit 3) mentre un clone era accettato; ora la domanda è posta a git
  (`git -C "$repo_dir" rev-parse --git-dir`) e i tre casi nuovi sono in
  `scripts/tests/test_deploy_guard.sh`.

Il disco **non** passa dalla CI: sta sulla VPS e da lì va su R2 una volta sola (sezione 6).

### Cosa deve fornire l'operatore

Q3 di `docs/OPEN_QUESTIONS.md` chiede molto di più (TURN, Supabase, un dominio): per la Fase 0
basta questo sottoinsieme.

| # | Cosa | Dove va | Serve per |
| --- | --- | --- | --- |
| O1 | **Decisione**: estendere D3/Q8 a pubblicare modulo e disco su Cloudflare, dietro Access, per la durata della Fase 0 | `docs/OPEN_QUESTIONS.md` | tutto il resto della strada Cloudflare |
| O2 | Account Cloudflare con R2 attivo. **Serve un metodo di pagamento registrato: verificato il 2026-10-04** leggendo la documentazione, senza account. R2 non si attiva da solo: si aggiunge all'account una **sottoscrizione** ("You need a Cloudflare account with an R2 subscription ... Complete the checkout flow to add an R2 subscription to your account", `developers.cloudflare.com/r2/get-started/`), e per i servizi add-on "Cloudflare must always have a payment method on file" (`developers.cloudflare.com/billing/get-started/update-billing-info/`), fatturata al metodo di pagamento dell'account (`developers.cloudflare.com/billing/understand/billing-policy/`). La riga del livello gratuito in §1 lo diceva già dal 2026-10-01; il livello gratuito resta gratuito (10 GB-mese, 1 M operazioni di Classe A) | pannello Cloudflare | bucket e Pages |
| O3 | Bucket R2 **privato** `melee-phase0-disc`, senza accesso pubblico `r2.dev` | pannello R2 | il disco |
| O4 | Chiavi S3 di R2 (*Access Key ID* e *Secret Access Key*) limitate in scrittura a quel solo bucket, più l'ID account | date all'agente **solo per la sessione** di caricamento sulla VPS, in variabili d'ambiente, mai in un file; revocate dopo | caricare il disco |
| O5 | Secret GitHub `CLOUDFLARE_API_TOKEN` (permesso di modifica di Pages) e `CLOUDFLARE_ACCOUNT_ID`; variabile di repository `CF_PAGES_PROJECT` = `melee-web` | impostazioni del repository | il deploy dalla CI (`docs/DEPLOY.md` §2 punto 8) |
| O6 | Applicazione Cloudflare Access che copre l'indirizzo dell'anteprima, con la lista delle email ammesse | pannello Zero Trust | protezione |
| O7 | Nelle variabili d'ambiente di Pages, ambiente *preview*: `ACCESS_AUD` e `ACCESS_TEAM_DOMAIN` di quell'applicazione | pannello Pages | senza, la middleware risponde **503** con `reason: access_configuration_missing` a ogni Function, disco compreso — **non** 403, che è la risposta al token mancante o non valido (`functions/_middleware.ts` righe 26–28 e 91–94; `tests/functions/middleware.test.ts` righe 97–102, con l'attesa 503 alla riga 49) |
| O8 | Binding R2 `PHASE0_DISC` → `melee-phase0-disc` per l'ambiente *preview*. **Basta `wrangler.toml`, a patto che il blocco dell'ambiente ripeta i binding: risposta misurata, non più `da verificare`.** È già dichiarato in `wrangler.toml` sotto `[[env.preview.r2_buckets]]` insieme a `ASSETS_R2` (commit `824cdd6`). La misura, del 2026-10-02: dichiarare il solo `[env.preview.vars]` rese esplicita la configurazione della preview e il `[[r2_buckets]]` di primo livello **smetteva di raggiungerla**, e la preview pubblicata rispondeva `503 {"error":"Disc storage unavailable"}` — lo stato che `functions/phase0/[[path]].ts` restituisce quando `env.PHASE0_DISC` manca (`docs/DEPLOY.md` §6). La documentazione enuncia la stessa regola: `r2_buckets` è fra le chiavi **non ereditabili**, e "if any one non-inheritable key is overridden for any environment ... all non-inheritable keys must also be specified in the environment configuration and overridden" (`developers.cloudflare.com/pages/functions/wrangler-configuration/`, "Non-inheritable keys", letta il 2026-10-04). Per il binding non serve quindi alcuna azione nel pannello; resta da verificare, con il bucket creato (O3), che la Function serva davvero il disco | pannello Pages o `wrangler.toml` | la Function del disco |
| O9 | *Consigliato*: un **service token** di Access per l'agente (ID e segreto) | all'agente, per la sessione | i controlli con `curl` della tabella sopra senza browser |
| O10 | Il modello esatto del telefono Android (SoC compreso) e del desktop | nel report | la matrice |

Non servono: dominio, TURN, Supabase, `ACCESS_DEV_BYPASS` (non va attivato: aprirebbe il disco su
un branch non `main`, `functions/_middleware.ts` riga 83).

---

## 4. La matrice di misura

Le soglie sono quelle di `docs/SPEC_PIANO.md` ("Criteri go/no-go"), applicate come in
`docs/PHASE0_DEVICE_PLAN.md` §6: solo i 762 retrace di partita, **tre corse, conta la peggiore**,
e ogni verdetto deve reggere spostando i numeri della risoluzione dell'orologio `timer_resolution_ms`.

| Metrica | GO | NO-GO |
| --- | --- | --- |
| Checkpoint contro il nativo | 2400/2400 identici | qualsiasi differenza non spiegata |
| Media per frame, telefono Android di fascia media | ≤ 3 ms | > 6 ms |
| p99 per frame, telefono | ≤ 6 ms | > 12 ms |
| Media per frame, desktop | ≤ 1,5 ms | > 4 ms |

Tra 3 e 6 ms di media sul telefono: si procede solo su desktop e si rivaluta il mobile in Fase 4.

Riferimento, non criterio: sulla VPS il modulo `-Oz` fa media 28,92 ms, p95 37,78, p99 46,53 sui
frame di partita (`docs/PROGRESS.md`, ultima sezione). È un **proxy debole**: una vCPU condivisa
sotto Node, non il core grande di un telefono.

**Ordine e criterio.** Prima si verifica che la catena funzioni dove è più facile (desktop), poi
la riga che decide (Android), poi le righe informative, infine la conferma sull'host vero.

| # | Device | Serve da | Cosa si misura | Entra nel verdetto? |
| --- | --- | --- | --- | --- |
| **M1** | Chrome sul desktop dell'operatore | `localhost` sul desktop (S7 di `docs/PHASE0_NEXT.md`) oppure l'anteprima Cloudflare | tre corse da 2400 frame; parità della traccia | **sì**, riga desktop |
| **M2** | **Chrome su un Android di fascia media** (la spec: "es. Snapdragon 7 series") | strada D: port forwarding USB verso `localhost` (S9 di `docs/PHASE0_NEXT.md`) o la VPS via `tailscale serve` HTTPS (`docs/PHASE0_DEVICE_PLAN.md` V3); disco dal selettore | una prova corta (`?frames=60`), poi tre corse da 2400 | **sì**, è la riga che decide. Senza questa riga non c'è go/no-go (`docs/PHASE0_TASKS.md` D5) |
| M3 | Safari su iPhone | come M2 (strada D) oppure l'anteprima Cloudflare | come M2 | **no**, informativa (S9: "Safari macOS/iOS are recorded if available but are not in the verdict") |
| M4 | Safari su macOS, se disponibile | `localhost` | come M1 | no, informativa |
| **M5** | lo stesso Android di M2 | **l'anteprima Cloudflare**, disco in OPFS (strada C) | download del disco in OPFS (tempo, riprese, esito di `persist()`); tempo dal tocco su "Run" a `core loaded`; **una** corsa da 2400 frame | **no** per le soglie; **sì** come conferma: la traccia deve essere identica e la media entro il 15% di quella di M2, altrimenti l'host o OPFS stanno alterando qualcosa e va capito prima del verdetto |

**Cosa si può concludere da un iPhone, e cosa no** (M3).

- **Si può**: sapere se il gioco è lo stesso sotto JavaScriptCore (il motore di Safari, diverso da
  V8 di Chrome): una traccia identica lo prova. Sapere se il core carica su iOS e con quale
  margine di memoria. Un **NO-GO sull'iPhone** rende molto probabile il NO-GO sull'Android medio,
  perché un iPhone recente è in genere più veloce: è un'inferenza, non una misura.
- **Non si può**: dichiarare GO per il mobile. La spec misura un Android; un GO sull'iPhone non
  chiude quella riga. Né dire nulla di Chrome su iOS o di altri iPhone.

**Cosa deve riportare l'operatore per ogni riga.**

- I file `spike-result-<data-ora>.json` **senza aprirli né modificarli**: la prova corta e le tre
  corse (per M5 la corsa singola). Dentro ci sono già `core_commit`, `core_opt`, `user_agent`,
  `cross_origin_isolated`, `timer_resolution_ms`, `frames`, `iso_bytes`, `disc_source`,
  `storage_persisted`, `core_load_ms`, `exit_code`, `final_scene`, `wall_ms`, `trace_csv`,
  `decoder_cost`, `sim_times_csv`, `stats_all`, `stats_in_match`, `comparison`, `heartbeat` e —
  solo per una corsa con `?canvas` — `render`: è l'oggetto che `web/src/spike/main.ts` righe
  280–290 costruisce, ed è quel file a tenerne la lista (le righe 57–61 che questa voce citava
  sono, dal 2026-10-05, la funzione `offscreenCanvas`).
- Scritti a parte: **modello esatto del telefono e SoC** (lo `user_agent` di Chrome su Android non
  riporta più il modello, per la riduzione dello user agent: **da verificare** sul JSON della prova
  corta), versione del sistema e del browser, se il telefono era in carica, temperatura "a
  sensazione" alla fine.
- Per M5 in più: quanto è durato il download del disco, quante volte si è interrotto, e il tempo
  da "Run" a `core loaded`, che è **già nel JSON**: il campo `core_load_ms`, misurato nel worker
  dal suo avvio al messaggio `core` (`web/src/spike/main.ts` riga 283, `web/src/spike/worker.ts`
  righe 43–48; introdotto da #29, §5 "Fatta" del PR 4), quindi non c'è niente da annotare a mano.
- **Condizioni uguali per tutte le righe**: risparmio energetico spento, blocco schermo su "mai",
  nessun'altra app, pausa di 5 minuti tra le corse. Sulla carica i due piani esistenti si
  contraddicono (`docs/PHASE0_NEXT.md` S9: "phone plugged in"; `docs/PHASE0_DEVICE_PLAN.md` §3:
  "non in carica"). **Scelta di questo piano: non in carica, batteria sopra il 50%**, perché la
  carica scalda il telefono e il calore è il rischio principale delle tre corse. Si annota.

I JSON vanno sulla VPS in `/home/hermes/incoming/phase0/devices/<device>/` (per esempio
`desktop-chrome/`, `android-chrome/`, `android-chrome-cloudflare/`), fuori dal checkout, mai in git.
L'agente li verifica con i controlli C1–C8 di `docs/PHASE0_DEVICE_PLAN.md` §5, usando
`scripts/phase0/compare_checkpoints.py` e `scripts/phase0/frame_stats.py`.

---

## 5. Cosa cambia nel repo

Un file per riga. Ogni gruppo è una PR piccola (una modifica logica per volta).

**Stato al 2026-10-05.** Questa sezione è la specifica di ogni PR, scritta il 2026-10-01, e cinque
delle sei sono atterrate (la sesta a metà). Il testo sotto resta quello di allora — è la specifica,
non un diario — e ogni gruppo porta ora una riga **Fatta** con la prova. Due frasi sono invece
istruzioni e non storia, e sono corrette nel testo: il file della Function è
`functions/phase0/[[path]].ts` e non `disc.ts`, e `scripts/phase0/go_no_go.py` esiste.

**PR 1 — il modulo piccolo in `main`**

- `phase0/oz-size-experiment` → `main`: nessun file nuovo, solo il merge (porta `-Oz -g0`, la
  correzione di `core.json` in `phase0-build.yml` righe 233–245, e `scripts/phase0/serve_spike.py`).

**Fatta** il 2026-09-30 (PR #13, `phase0/oz-size-experiment`): `wasm/core/CMakeLists.txt` riga 23
tiene `MELEE_OPT` a `-Oz` e la riga 32 aggiunge `-g0`; il modulo che CI spedisce è di 15.278.441
byte (`docs/PROGRESS.md`, riga "Recompiled core").

**PR 2 — il disco pronto per R2 (solo script, nessuna credenziale per scriverli)**

- `scripts/phase0/disc_chunks.py` (nuovo): legge la ISO a pezzi da 16 MiB e scrive un JSON con
  dimensione totale, dimensione del pezzo, SHA-1 dell'intero disco e SHA-256 di ogni pezzo. Solo
  libreria standard di Python; gira sulla VPS.
- `scripts/phase0/upload_disc.sh` (nuovo): carica ISO e JSON dei pezzi nel bucket usando
  l'interfaccia S3 di R2 con le chiavi prese dall'ambiente; per impostazione predefinita non
  carica niente e stampa cosa farebbe (come `scripts/upload_assets.sh`); rifiuta senza
  credenziali e se la ISO non ha la dimensione e lo SHA-1 attesi. Strumento: `rclone` (un solo
  binario) se presente sulla VPS, altrimenti `curl --aws-sigv4` con un solo PUT; quale dei due, e
  se un solo PUT da 1,46 GB è accettato da R2, è **da verificare** (§1).
- `scripts/tests/test_deploy_guard.sh` (modifica): casi di rifiuto per `upload_disc.sh` (niente
  credenziali, ISO sbagliata).

**Fatta** il 2026-09-30 da `3de2ed3` (PR #14): `scripts/phase0/disc_chunks.py`,
`scripts/phase0/upload_disc.sh` e i suoi casi di rifiuto in `scripts/tests/test_deploy_guard.sh`
esistono. `rclone` **non** è installato su questa VPS (`which rclone` non trova nulla), quindi il
percorso è il fallback `curl --aws-sigv4` che `upload_disc.sh` riga 10 nomina. Che R2 accetti un PUT
singolo da 1,46 GB resta non verificato, ma la ragione che questa riga dava è superata: il bucket
(O3) **esiste e contiene il disco** — la run `37300691991` (`four-player-load.yml`, 2026-10-05 11:05 UTC,
`success`) registra nel proprio log `Downloading "melee-ntsc102.iso" from "melee-phase0-disc"`,
`Download complete.` e `disc image verified: 1459978240 bytes, sha1 d4e70c064cc714ba8400a849cf299dbd1aa326fc`
— quindi ciò che manca al controllo sono le chiavi S3 (O4) e una sessione sulla VPS, non il bucket; il
passo 10 della sezione 6 è condizionato da allora a un nuovo caricamento. **Come l'oggetto sia arrivato
nel bucket non è registrato in questo repository**: nessuna workflow lo carica, e le quattro che lo usano
lo leggono soltanto (`npx --yes wrangler@4 r2 object get melee-phase0-disc/melee-ntsc102.iso --remote`,
`ci.yml` riga 310, `four-player-load.yml` riga 66, `four-player-sweep.yml` riga 56, `texture-simd.yml`
riga 67), mentre `scripts/phase0/upload_disc.sh`, l'unico percorso che il piano nomina, non ha una run
registrata.

**PR 3 — la Function del disco**

- `functions/phase0/[[path]].ts` (nuovo, il piano diceva `disc.ts`): `GET` e `HEAD` su
  `/phase0/disc` (il disco) e
  `/phase0/disc-chunks` (il JSON dei pezzi), chiavi fisse (mai un nome di file preso dalla
  richiesta), risposte `206` con `Content-Range` per le richieste parziali, `Cache-Control:
  no-store`, `Cross-Origin-Resource-Policy: same-origin`. Protetta dalla middleware esistente.
- `functions/types.ts` (modifica): il binding `PHASE0_DISC` nel tipo dell'ambiente.
- `wrangler.toml` (modifica): secondo blocco `[[r2_buckets]]`, binding `PHASE0_DISC`, bucket
  `melee-phase0-disc`.
- test unitario della Function accanto a quelli che `npm test` esegue in
  `.github/workflows/functions.yml`: richiesta intera, parziale, parziale fuori dai limiti,
  senza token Access (403).

**Fatta** il 2026-09-30 da `2208884` (PR #16): la Function serve `/phase0/disc` e
`/phase0/disc-chunks` (`functions/phase0/[[path]].ts` righe 13 e 14) e il binding `PHASE0_DISC` sta
in `functions/types.ts` riga 31 e in `wrangler.toml` righe 33 e 56.

**PR 4 — la pagina che popola OPFS**

- `web/src/spike/disc-cache.ts` (nuovo): controllo dello spazio, `persist()`, download a pezzi
  con ripresa, verifica SHA-256 per pezzo, scrittura in OPFS da un Worker, e una funzione che
  restituisce il `File` da OPFS se il disco è completo e verificato.
- `web/spike.html` (modifica): bottone per scaricare il disco nel browser, una riga di
  avanzamento, un bottone per cancellarlo.
- `web/src/spike/main.ts` (modifica): usa il `File` di OPFS se c'è, altrimenti il selettore;
  aggiunge al JSON **campi nuovi**, che oggi non esistono: `disc_source` (`opfs` o `picker`),
  `storage_persisted` (esito di `persist()`), `core_load_ms`.
- `web/src/spike/worker.ts` (modifica minima): misura e invia il tempo dall'inizio al messaggio
  `core`, per `core_load_ms`. Il montaggio WORKERFS **non cambia**.
- `web/tests/spike/spike.spec.ts` (modifica): in Chromium, con un disco sintetico servito con
  richieste parziali dal test, il download in OPFS, una ripresa dopo un'interruzione simulata,
  un pezzo corrotto rifiutato, e la corsa che arriva allo stesso errore atteso di oggi
  (`FATAL: cannot read full Melee DOL`, `docs/PROGRESS.md` S6).

**Fatta** in quattro passi, una PR ciascuno: #26 (ogni pezzo è verificato prima che ne venga
scritto uno), #28 (un solo worker OPFS, un pezzo alla volta), #29 (il JSON nomina `disc_source`,
`storage_persisted` e `core_load_ms`) e #30 (il bottone che scarica il disco nella pagina).

**PR 5 — il deploy dalla CI**

- `.github/workflows/phase0-build.yml` (modifica): input `deploy_spike` (boolean, `false`), passo
  finale che: si salta con un avviso senza credenziali; toglie `sw.js` da
  `$RUNNER_TEMP/spike-dist`; aggiunge a `$RUNNER_TEMP/spike-dist/_headers` la regola
  `/spike-core/*` senza cache; esegue `scripts/deploy.sh --branch phase0-spike --dist-dir
  "$RUNNER_TEMP/spike-dist"` con i secret di O5; scrive nel riepilogo della run l'indirizzo
  dell'anteprima. Nessuna workflow nuova: il `dist` esiste solo dentro questo job.
- `docs/DEPLOY.md` (modifica): sezione "anteprima spike di Fase 0" con i passi e la rimozione.

**Fatta** il 2026-09-30 da `b58ce6b` (PR #24): l'input `deploy_spike` è in
`.github/workflows/phase0-build.yml` riga 26 e il passo finale, che si salta senza credenziali, alla
riga 311.

**PR 6 — il verdetto**

- `scripts/phase0/go_no_go.py` (nuovo): è il passo S8 già progettato in `docs/PHASE0_NEXT.md`,
  **scritto** il 2026-10-01 (PR #31): il file è in `scripts/phase0/`.
- `docs/PHASE0_REPORT.md` (nuovo): tabella per device, esito dei checkpoint, verdetto (P0-12).
- `docs/PROGRESS.md`, `docs/OPEN_QUESTIONS.md` (Q3 ristretta alla Fase 0, Q8 estesa o chiusa)
  (modifiche).

**A metà.** `scripts/phase0/go_no_go.py` è scritto (PR #31) ed è il comando che il verdetto esegue;
`docs/PHASE0_REPORT.md` **non** è scritto, di proposito: porta il verdetto e aspetta la riga che lo
decide (M2, `docs/OPEN_QUESTIONS.md` Q9).

**Correzione minore**, in una qualunque delle PR sopra: il commento di `web/vite.config.ts` su
dove sta `_headers`.
**Fatta il 2026-10-01** da `aad3598` (PR #28), che ha ripiegato in sé la
correzione assegnata dalla sezione 0: il commento ora nomina `web/public/_headers`
(`web/vite.config.ts` riga 8).

---

## 6. L'ordine di esecuzione

Legenda: **[subito]** nessuna dipendenza dall'operatore; **[decisione]** serve una risposta
dell'operatore; **[credenziali]** serve O2–O9; **[device]** serve l'operatore con il device.

1. **[subito]** PR 1: merge di `phase0/oz-size-experiment` in `main` con CI verde.
2. **[subito]** Dispatch di `phase0-build.yml` da `main` con `upload_spike=true` (circa 33 minuti
   di job, `docs/PROGRESS.md` S6). Dal log: dimensione di `melee_core_web.wasm` e
   `within_pages_limit` (chiude §0.3). Artefatto in `/home/hermes/incoming/phase0/spike-dist`,
   mai nel checkout; `core.json` deve dire `-Oz`.
3. **[subito]** Traccia nativa al commit del core servito, se diverso da `f0d76a28…` (regola di
   `docs/PHASE0_DEVICE_PLAN.md` §5, "Il commit del riferimento").
4. **[subito]** PR 2, PR 3, PR 4, PR 5 in quest'ordine, una alla volta, ciascuna con CI verde. Si
   scrivono e si testano senza credenziali (i test usano un disco sintetico; il deploy si salta
   da solo).
5. **[subito]** Sulla VPS: `python3 scripts/phase0/disc_chunks.py` sulla ISO; controllo che il
   JSON dica 88 pezzi e lo SHA-1 `d4e70c06…`.
6. **[decisione]** O1 (Cloudflare sì o no) e quale Android e quale strada D (USB dal desktop o
   `tailscale serve`).
7. **[device]** M1 e M2 con la strada D, seguendo `docs/PHASE0_DEVICE_PLAN.md` §4 adattato al
   device (prova corta, poi tre corse). **Questo passo non dipende da Cloudflare.**
8. **[subito, dopo 7]** Controlli C1–C8 sui JSON.
9. **[credenziali]** O2–O9 fatti dall'operatore.
10. **[credenziali]** Sulla VPS: `scripts/phase0/upload_disc.sh` prima a vuoto, poi davvero;
    revoca delle chiavi S3 (O4) subito dopo.
11. **[credenziali]** Dispatch di `phase0-build.yml` con `deploy_spike=true`; poi tutti i
    controlli della tabella della sezione 3 con `curl` e il service token (O9). Un controllo che
    fallisce si corregge prima di dare l'indirizzo all'operatore.
12. **[device]** M5: download del disco in OPFS sull'Android, una corsa; poi M3/M4 se disponibili.
13. **[subito, dopo 12]** C1–C8 sui JSON di M5; confronto con M2 (traccia identica, media entro il 15%).
14. **[subito]** PR 6: `go_no_go.py`, `docs/PHASE0_REPORT.md` con il verdetto.
    **Il verdetto è scritto.** **Stato 2026-10-05: no** — `scripts/phase0/go_no_go.py` è in `main`
    (PR #31) e decide la riga iPhone (`VERDICT: DESKTOP-ONLY`), mentre `docs/PHASE0_REPORT.md`
    aspetta la riga che decide (M2).

**Stato al 2026-10-05: i passi 9–11 non sono più in attesa, e di O1–O10 resta una decisione sola.**
Verificato oggi da questa macchina, senza usare alcuna credenziale Cloudflare, senza toccare il deploy
e senza un telefono, ogni fatto con la sua prova:

- **O5 è fatto, quindi il passo 11 è eseguibile così com'è**: `gh api
  repos/isDemetrio/melee-web/actions/secrets` elenca `CLOUDFLARE_API_TOKEN` e
  `CLOUDFLARE_ACCOUNT_ID`, e `gh api repos/isDemetrio/melee-web/actions/variables` risponde
  `CF_PAGES_PROJECT=melee-web`.
- **O2 e O3 sono in uso**: il bucket privato `melee-phase0-disc` esiste e **contiene il disco**. La
  prova più recente è di oggi: la run `37300691991` (`four-player-load.yml`, 2026-10-05 11:05 UTC,
  `success`) registra `Downloading "melee-ntsc102.iso" from "melee-phase0-disc"` e poi `disc image
  verified: 1459978240 bytes, sha1 d4e70c064cc714ba8400a849cf299dbd1aa326fc`. Lo stesso oggetto è
  quello che `ci.yml`'s `checkpoint-replay` legge, misurato il 2026-10-03 (run `37148808325`,
  download in 27 s, `docs/ATTRIBUTE_RESIDUAL.md`). Che il bucket non abbia accesso pubblico `r2.dev`
  resta una proprietà del pannello che questa macchina non può leggere.
- **O6 e O7 sono fatti, e il servizio concorda con il file**: oggi una richiesta a
  `https://phase0-spike.melee-web.pages.dev/spike.html` riceve la pagina di login di Access ("Log in
  to melee-web phase0 spike preview", team `jolly-frost-8cc9.cloudflareaccess.com`), e il claim `aud`
  di quel flusso è `a3079f1bb92f23c5299cc29d4436377594caa9cfc3b655c3571206548028906d` — il valore che
  `wrangler.toml` righe 18 e 48 tengono come `ACCESS_AUD`; O8 è alle righe 52–57 dello stesso file.
- **Il passo 11 è già stato eseguito almeno una volta**: la run `36868675226` (2026-10-01 13:26 UTC,
  `success`, `head_sha 63511ce6…`) ha pubblicato l'anteprima dietro Access, ed è l'entry "The spike is
  live on Pages, behind Access" di `docs/PROGRESS.md`. Il core servito è però quello del 2026-10-01:
  un deploy con il core di `main` resta da fare, ed è la pagina di M5.
- **Cosa resta davvero di O1–O10**: O1 (la decisione legale — l'unica voce di §3 che non è una
  credenziale), O10 (il modello dell'Android) e, **solo** se il disco va ricaricato o l'agente deve
  interrogare l'anteprima con `curl`, le chiavi S3 (O4) e il service token opzionale (O9).

Se le credenziali tardano, il verdetto si può scrivere dopo il passo 8 con M1 e M2, annotando
che M5 manca; la riga M5 si aggiunge dopo. **Correzione 2026-10-05**: il caso del core `-O1` non può
presentarsi, perché il passo 1 è fatto (§5, "Fatta"): `wasm/core/CMakeLists.txt` riga 23 tiene
`MELEE_OPT` a `-Oz`, e `core.json` della run `37319576228` dice
`{"commit":"fe2e06be…","opt":"-Oz"}`. La regola del provvisorio è cablata su `-O1`
(`scripts/phase0/go_no_go.py` riga 77: `PROVISIONAL_OPTS = ('-O1',)`), quindi un esito diverso da GO
misurato sul core che la CI spedisce esce **definitivo**, non provvisorio.

Alla fine della Fase 0: cancellare il disco dal bucket (o il bucket), togliere il binding
`PHASE0_DISC`, e cancellare il disco dall'OPFS dei telefoni con il bottone della pagina.

---

## 7. Cosa NON dimostra questo piano

- **Niente grafica.** Il core gira `--headless` (`worker.ts`, riga 189): il costo del disegno sul
  telefono non è misurato e si aggiunge alla simulazione.
- **Niente audio.** `--volume 0`.
- **Niente input umano.** L'input viene dalla sequenza scriptata `parity_vs_onett.txt`: nessun
  tocco, nessun controller, nessuna latenza di input.
- **Niente rete e niente rollback veri.** Si misura il costo di un frame; che il rollback ci stia
  è dedotto da quel costo, non eseguito.
- **Niente thread.** Il modulo è a thread singolo.
- **Niente uso prolungato.** Tre corse di qualche minuto, non 20 minuti di gioco (il criterio di
  `docs/SPEC_PIANO.md` riga 276 per il prodotto): il comportamento termico lungo non è misurato.
- **Non l'architettura del disco del prodotto.** Il prodotto non mette la ISO sul telefono
  (§0.5); qui si prova solo il meccanismo R2 → OPFS → file locale, con un unico file enorme.
- **Un campione piccolo.** Un Android, un desktop, forse un iPhone: un modello, una versione di
  sistema, una versione di browser per riga. Non dice nulla di altri SoC della stessa fascia, di
  telefoni più vecchi, di Firefox, di Chrome su iOS. Un GO significa "regge su **questo** Android
  medio", non "regge sugli Android medi".
- **Niente prova che i tempi vengano davvero da quel device.** La traccia prova che il core ha
  girato correttamente; device e tempi sono dichiarati (`docs/PHASE0_DEVICE_PLAN.md` §5).
- **Niente verifica dei limiti Cloudflare** fino al primo deploy. Dal 2026-10-01 i numeri che la
  **documentazione** poteva chiudere non sono più ipotesi: sono letti e citati (§1, "Come sono stati
  verificati i numeri di questa tabella"). Restano ipotesi, perché solo il passo 11 le può
  controllare, le cose che la documentazione non dice: gli header realmente serviti e l'algoritmo di
  compressione davvero applicato. Le altre tre voci di questo elenco sono state chiuse dopo la stesura,
  senza credenziali: la copertura di Access su `*.pages.dev` e il formato dell'indirizzo il 2026-10-04
  (§1 e §3), il binding R2 dell'ambiente di anteprima il 2026-10-02 (§3, riga O8).
