# Fase 0 — piano per il test sul device (iPhone, Safari)

Scopo: far girare il core WASM di Melee nel Safari dell'iPhone dell'operatore, con la pagina
spike già esistente (`web/spike.html`), e decidere con numeri se il telefono regge.
Scritto il 2026-09-30. Chi lo esegue non deve riprogettare nulla: dove una cosa non è stata
verificata durante la stesura, è scritto "**da verificare**" e c'è il modo per verificarla.

---

## 0. Prima di tutto: cinque presupposti che non reggono

Chi ha commissionato il piano dava per buone alcune cose. Leggendo il repository e il server,
cinque non sono vere, e cambiano il piano. Sono scritte qui in cima perché contano più di tutto
il resto.

1. **Il go/no-go non è "stare sotto 16,67 ms".** `docs/SPEC_PIANO.md` (sezione "Criteri
   go/no-go") fissa soglie molto più strette per il telefono: tempo **medio ≤ 3 ms** e **p99 ≤ 6 ms**
   per GO, **medio > 6 ms** o **p99 > 12 ms** per NO-GO. Il motivo è scritto lì: il *rollback*
   (la tecnica del netcode di Slippi che, quando arriva in ritardo l'input dell'avversario,
   risimula fino a 7 frame in un solo tick) richiede che un frame di simulazione costi circa
   2 ms, non 16. Stare sotto 16,67 ms è una condizione **necessaria** (il gioco gira a 60 Hz
   senza rollback), non **sufficiente**. Questo piano misura entrambe le cose e le tiene
   separate (sezione 6).
2. **La spec vuole un Android di fascia media, non un iPhone.** In `docs/SPEC_PIANO.md` (passo 8)
   Safari iOS è "se possibile"; `docs/PHASE0_TASKS.md` (D5) dice "senza la riga Android non c'è
   go/no-go"; `docs/PHASE0_NEXT.md` (S9) registra Safari ma lo esclude dal verdetto. Quindi un
   test solo su iPhone **non può chiudere da solo** il go/no-go della spec. Può dare un NO-GO
   per il mobile (se non regge un iPhone, un Android medio quasi certamente non regge: è
   un'inferenza, non una misura) oppure un dato iOS; non un GO completo. **Decisione
   dell'operatore:** accettare l'iPhone come sostituto della riga Android, oppure trattare questo
   test come "riga iOS" e procurarsi un Android dopo.
   **Risposta dell'operatore (2026-09-30):** ha a disposizione **solo un iPhone**, quindi il test
   si fa su quello e vale come **riga iOS** (informativa per la spec). La riga Android resta
   aperta: un NO-GO sull'iPhone chiude il mobile come inferenza forte, un GO sull'iPhone **non**
   chiude la riga Android. Il piano procede, e il verdetto della sezione 6 si legge con questa
   riserva.
3. **Il server così com'è non dà l'isolamento cross-origin, quindi l'orologio sarà grossolano.**
   `/home/hermes/.hermes/cache/scratch/spike-serve/serve_spike.py` manda gli header COOP/COEP
   (le due intestazioni HTTP che chiedono al browser di "isolare" la pagina), ma serve in
   **HTTP semplice** su un IP della tailnet (`http://100.120.206.46:8091`). Per le regole del
   web, una pagina è isolata (`crossOriginIsolated === true`) **solo in un contesto sicuro**:
   HTTPS oppure `localhost`. Un IP della tailnet in `http://` non lo è: gli header vengono
   ignorati, `crossOriginIsolated` resta `false` e `performance.now()` resta arrotondato. Il
   commento in cima al server dice il contrario; è sbagliato. Rimedio: HTTPS con
   `tailscale serve` (sezione 2, passo V3).
4. **La pagina non mostra se è isolata.** Il server dice "the page reports whether it is
   cross-origin isolated", ma `web/src/spike/main.ts` scrive quel dato **solo nel JSON**
   (campo `cross_origin_isolated`), non a schermo. Per questo il piano fa una **prova corta**
   prima delle misure vere (sezione 4, passo 6).
5. **Il campo `core_opt` del JSON non prova il livello di ottimizzazione.** Viene da
   `spike-core/core.json`, che `.github/workflows/phase0-build.yml` (riga 125) scrive con
   `"opt":"-O1"` **fisso**. Il branch corrente `phase0/oz-size-experiment` compila invece a `-Oz`
   (`wasm/core/CMakeLists.txt`, righe 19 e 23): un core costruito da quel branch si
   dichiarerebbe `-O1` pur non essendolo. Si risale al livello vero dal `core_commit` (che è lo
   SHA del commit), non da `core_opt`.

Due note minori, sempre da non assecondare in silenzio:

- **Servire dalla VPS va contro una regola scritta**: `docs/PHASE0_NEXT.md` §9 dice "do not serve
  the page from the VPS". Il server qui serve solo file (sulla VPS non gira né il gioco né un
  browser), quindi lo spirito della regola (niente processi pesanti) è rispettato, ma la regola
  c'è e l'operatore deve accettare l'eccezione. Il server va tenuto acceso **solo per la
  sessione di test** (la policy della VPS vieta server di lunga durata).
- **La dimensione del modulo non è un numero solo.** Il prompt dice 87.117.067 byte (messaggio del
  commit `d04610d`); `docs/PROGRESS.md` (S6) misura il modulo web a 87.118.045 byte; `docs/PHASE0_NEXT.md`
  cita 87.117.533. Sono build diverse, tutte ≈ 87,1 MB. Fa fede il file effettivamente servito
  (passo V2). L'uso nel server di `--token free`, citato nel suo commento d'uso, **non esiste**
  tra gli argomenti e farebbe fallire l'avvio: non passarlo.

---

## 1. Cosa stiamo misurando e perché

**La domanda.** La simulazione del gioco (senza grafica né audio), compilata in WebAssembly
(*WASM*: il formato binario che i browser eseguono quasi alla velocità del codice nativo), gira
nel Safari di un iPhone abbastanza in fretta da lasciare margine al rollback?

**Il numero.** Per ogni *retrace* (un "giro" del gioco: un frame video a 60 Hz, cioè ogni
16,67 ms) il core scrive quanto tempo ha impiegato a simulare, in millisecondi, nel file
`--sim-times` (colonne `retrace,sim_ms,match_frame`). Il tempo **esclude** il calcolo degli hash
di controllo, e il core gira in modalità `--fast` (simula il più in fretta possibile, senza
aspettare il vsync). Si guardano **solo i retrace di partita** (`match_frame > 0`): sono **762**
nella sequenza scriptata usata (`parity_vs_onett.txt`); gli altri ~1638 sono avvio e menu e non
contano. Su quei 762 valori si calcolano media, p95, p99 (il valore sotto cui sta il 99% dei
frame, metodo *nearest-rank*: sempre un valore realmente osservato) e massimo.

**Il confronto di riferimento.** Sulla VPS (2 vCPU, `-O1`, sotto Node) il WASM ha fatto, sui 762
frame di partita: media 27,34 ms, p95 34,82, p99 43,36 (`docs/PROGRESS.md`, sezione P0-09). La
soglia GO della spec per il telefono è media ≤ 3 ms: la VPS è ~9 volte sopra. L'iPhone dovrebbe
essere ~9 volte più veloce di una vCPU Hetzner sotto Node per passare: **non è misurato**, ma
bisogna aspettarsi un NO-GO a `-O1`, e sapere già che sarebbe **provvisorio** (sezione 6).

**Insieme ai tempi misuriamo la correttezza.** Il core scrive anche 2400 checkpoint (hash di CPU,
RAM, ARAM ed eventi, uno per retrace). Il nativo e il WASM sotto Node li producono identici bit per
bit (SHA-1 del file `c79c53b9cdf81426fa0277e7497a69e55bc5f571`). Se Safari (motore JavaScriptCore,
diverso dal V8 di Node e Chrome) produce la stessa traccia, il gioco è lo stesso anche lì.

**Le riserve, dette subito.**

- **Risoluzione dell'orologio.** Ogni `sim_ms` è la differenza tra due letture di
  `performance.now()`. Se il browser arrotonda l'orologio a un passo *q*, ogni valore può sbagliare
  fino a *q*. La pagina misura *q* e lo scrive in `timer_resolution_ms`. Con *q* grande i numeri
  servono solo per un NO-GO netto (sezione 6).
- **Jitter termico.** Un telefono sotto carico si scalda e rallenta la CPU. Per questo si fanno
  3 corse con pausa e conta **la peggiore**, come in `docs/PHASE0_NEXT.md` §5.
- **Un solo device.** Un modello di iPhone, una versione di iOS. Non dice nulla di Android né di
  altri iPhone (sezione 8).

---

## 2. Come la ISO arriva al browser

**Vincolo tecnico che decide tutto.** La pagina legge la ISO con un selettore di file e il Worker
la legge **a pezzi, su richiesta, durante la simulazione** (WORKERFS di Emscripten, che usa
`FileReaderSync` sul `File` scelto: `web/src/spike/worker.ts`). Quindi la ISO deve stare **tutta
sul disco del telefono**: se fosse un file iCloud non scaricato o su una condivisione di rete, le
letture del disco finirebbero dentro i tempi misurati.

**Secondo vincolo, meno ovvio.** La pagina controlla solo la dimensione (1.459.978.240 byte), ma
**tutte** le immagini complete di dischi GameCube hanno quella dimensione. Il controllo non
distingue NTSC 1.02 da un'altra revisione. Una ISO di provenienza diversa da quella della VPS
(SHA-1 `d4e70c064cc714ba8400a849cf299dbd1aa326fc`) supererebbe il controllo e poi darebbe una
traccia DIFFERENT confusa.

| Strada | Cosa costa all'operatore | Problemi |
| --- | --- | --- |
| **A. Download da Safari sulla tailnet, salvataggio in File** | 1 tocco per avviare, poi attesa: a 50 Mbit/s ≈ 4 min, a 10 Mbit/s ≈ 20 min (1,46 GB). Una volta sola per tutte le corse. | Serve spazio libero; se "Download" di Safari punta a iCloud Drive la ISO finisce su iCloud (1,46 GB di quota e una copia fuori dal telefono): va impostato "Sul mio iPhone". |
| B. AirDrop dal Mac | Due trasferimenti: prima VPS → Mac (stesso tempo di A), poi AirDrop (minuti), più il Mac acceso vicino. | La ISO è solo sulla VPS, quindi il Mac è un passaggio in più e una copia in più da cancellare. |
| C. La ISO già sul telefono | Zero, se c'è. | Per quanto sappiamo **non c'è**: esiste solo sulla VPS. Una copia d'altra origine ha il problema del "secondo vincolo". |
| D. Taildrop (`tailscale file cp` dalla VPS all'iPhone) | Zero clic per l'invio, 1 tocco per accettare. | **Da verificare**: che Taildrop sia abilitato nella tailnet e dove iOS salva il file. Non provato. |
| E. Leggere la ISO dalla rete senza copiarla | Nessuna copia sul telefono. | Richiede di cambiare il Worker (oggi legge solo un `File`) e metterebbe la rete nei tempi. Fuori da questo test. |

**Scelta: A**, download da Safari via HTTPS dalla stessa origine della pagina. Motivo: il server
che la serve esiste già (con richieste parziali, cioè riprende un download interrotto), non serve
altro hardware, la copia arriva identica a quella della VPS, e l'HTTPS ci serve comunque per
l'orologio (presupposto 3). **Ripiego: D**, se A si blocca ripetutamente.

### Preparazione sulla VPS (la fa l'agente, non l'operatore)

**V1 — La ISO.** Il percorso esatto sulla VPS non è stato letto durante la stesura (il commento del
server usa come esempio `/home/hermes/incoming/melee-ntsc102.iso`): **da verificare**. Poi:

```bash
ISO=/percorso/della/iso            # da verificare
stat -c %s "$ISO"                  # atteso: 1459978240
sha1sum "$ISO"                     # atteso: d4e70c064cc714ba8400a849cf299dbd1aa326fc
```

**V2 — La pagina costruita (`dist`).** È l'artefatto `melee-spike-dist` del workflow
`phase0-build.yml` (input `upload_spike`, conservato 3 giorni). Il server l'ha già servito una
volta, ma il percorso non è stato letto: **da verificare**. Se non c'è più (scaduto), serve un
nuovo dispatch dal branch giusto (costo ≈ 28 minuti di CI secondo `docs/PHASE0_NEXT.md` S7):

```bash
gh workflow run phase0-build.yml --ref main -f upload_spike=true
gh run download <RUN_ID> --repo isDemetrio/melee-web -n melee-spike-dist -D /home/hermes/incoming/phase0/spike-dist
```

Mai scaricarlo dentro il checkout del repository. Poi controllare cosa si sta per servire:

```bash
DIST=/home/hermes/incoming/phase0/spike-dist      # o il percorso trovato
cat "$DIST/spike-core/core.json"                  # {"commit":"<sha>","opt":"-O1"} — opt non è affidabile, vedi §0.5
stat -c %s "$DIST/spike-core/melee_core_web.wasm" # ≈ 87,1 MB; annotare il numero esatto
ls "$DIST/spike-core/"                            # melee_core_web.js, melee_core_web.wasm, parity_vs_onett.txt, core.json
```

Annotare `commit`: servirà in sezione 5. **Servire un `dist` costruito da `main`**, non dal branch
`-Oz`, finché `-Oz` non ha ripassato i 2400 checkpoint.

**V3 — Il server, dietro HTTPS della tailnet.** Il server resta in ascolto solo su `127.0.0.1`
(valore predefinito di `--host`) e `tailscale serve` lo espone in HTTPS con un certificato valido
sul nome della macchina nella tailnet:

```bash
# dalla radice del repository: il server è versionato, non una copia in /tmp
python3 scripts/phase0/serve_spike.py \
  --dist "$DIST" --iso "$ISO" \
  --chunks /home/hermes/incoming/phase0/disc-chunks.json \
  --port 8091 --password '<scelta-al-momento>'
# atteso: serving <DIST> and 1459978240 bytes of disc on http://127.0.0.1:8091/spike.html
#         serving the piece manifest for 88 pieces of 16777216 bytes at .../phase0/disc-chunks
tailscale serve --bg 8091
tailscale serve status
```

`--chunks` è il manifest che `scripts/phase0/disc_chunks.py` ha scritto sulla VPS (88 pezzi,
SHA-1 `d4e70c06…`): è il contratto con cui la pagina scarica il disco nella propria cache OPFS.
Senza di esso la sezione "Disc cache" della pagina si dichiara non disponibile (il resto della
procedura funziona lo stesso: il disco viene dal selettore di file). Il server lo **rifiuta prima
di mettersi in ascolto** quando non descrive il disco che sta per servire (dimensione diversa,
numero di pezzi incoerente, digest malformato), così una sessione sul device non parte con il
manifest sbagliato. Se l'HTTPS della tailnet non è disponibile,
`scripts/phase0/device_test_serve.sh` avvia questo stesso server e un tunnel in un comando solo, e
stampa utente, password e indirizzi.

**Da verificare, e non verificato durante la stesura** (il comando `tailscale` non è stato
eseguito): la sintassi esatta dipende dalla versione (`tailscale serve --help`); può servire
`sudo`; nel pannello della tailnet devono essere attivi MagicDNS e i certificati HTTPS.
**Conseguenza da far accettare all'operatore:** attivare i certificati HTTPS rende pubblico il
nome della macchina nei registri di Certificate Transparency (i registri pubblici di tutti i
certificati emessi). Il contenuto resta visibile solo dalla tailnet.

Controllo dalla VPS stessa (utente fisso `fabri`, scritto nel server):

```bash
curl -sI -u 'fabri:<password>' http://127.0.0.1:8091/spike.html
# attesi: 200, Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp
curl -sI -u 'fabri:<password>' -H 'Range: bytes=0-5' http://127.0.0.1:8091/disc.iso
# atteso: 206 e Content-Range: bytes 0-5/1459978240
curl -sI -u 'fabri:<password>' -H 'Range: bytes=0-5' http://127.0.0.1:8091/phase0/disc
# atteso: 206 e Content-Range: bytes 0-5/1459978240 — lo stesso file su due rotte: `/disc.iso` è
# il download manuale in Safari (sezione 4, passo 2), `/phase0/disc` è la rotta che la pagina
# chiede da sola (`discUrl` di `web/src/spike/disc-cache.ts`) e la stessa che serve la Function in
# produzione. Il server risponde su entrambe, o la cache OPFS non può scaricare il disco.
curl -sI -u 'fabri:<password>' http://127.0.0.1:8091/phase0/disc-chunks
# atteso: 200, Content-Type: application/json, Cache-Control: no-store, Content-Length 6471
```

L'indirizzo per l'operatore diventa `https://<nome-macchina>.<tailnet>.ts.net/spike.html`, la
ISO `https://<nome-macchina>.<tailnet>.ts.net/disc.iso` e il manifest
`https://<nome-macchina>.<tailnet>.ts.net/phase0/disc-chunks`. Il disco è servito **anche** su
`https://<nome-macchina>.<tailnet>.ts.net/phase0/disc`: è lo stesso file, ed è la rotta che la
pagina chiede da sola per la cache OPFS.

**Se l'HTTPS non si riesce ad attivare:** il test si può fare lo stesso sull'indirizzo `http://`,
sapendo in anticipo che `cross_origin_isolated` sarà `false` e che il risultato potrà valere solo
per un NO-GO netto (sezione 6). Va deciso prima, non scoperto dopo.

A fine sessione: fermare il server (Ctrl-C) e `tailscale serve reset`.

---

## 3. I limiti veri di iOS Safari

Questi possono far fallire il test **prima** che sia colpa del nostro codice. Per ciascuno:
cosa sappiamo con certezza, cosa no, come si vede, cosa fare. **Nessun numero di limite è scritto
qui perché Apple non li documenta**: quelli che servono si ricavano dal device.

| Limite | Cosa è certo | Cosa va verificato sul device | Come si manifesta / come si riconosce | Cosa fare |
| --- | --- | --- | --- | --- |
| **Memoria per tab** | iOS chiude il processo di una pagina che usa troppa memoria, senza chiedere. Il limite non è documentato e dipende dal modello. | Se un modulo di 87 MB, compilato, più la memoria iniziale di 256 MB (`-sINITIAL_MEMORY=256MB` in `wasm/core/CMakeLists.txt`) più la crescita, ci sta. | La pagina si ricarica da sola, vuota, spesso con un avviso "si è verificato un problema, la pagina è stata ricaricata". Nessun JSON. Se succede **prima** di `core loaded`, è la compilazione; **dopo**, è la memoria in corsa. | Chiudere tutte le altre app e tab, riavviare il telefono, riprovare **una** volta. Se si ripete: è un risultato ("il core non carica su questo iPhone"), da annotare con il momento in cui succede. Rimedio lato nostro: modulo più piccolo (branch `-Oz`, `-g0`). |
| **WebAssembly** | La **Modalità di isolamento** (Lockdown Mode) di iOS disattiva la compilazione JIT e WebAssembly. Le specifiche WebAssembly fissano limiti per dimensione di funzione e di modulo; il modulo ha già caricato in Chromium (S6), quindi sta nei limiti di V8. | Se JavaScriptCore accetta le funzioni enormi del codice ricompilato e in quanto tempo le compila; se passa al livello di ottimizzazione alto (JavaScriptCore compila prima con un compilatore veloce e poi, in background, con uno ottimizzante) prima che inizi la partita. | `error: ...` a schermo con `CompileError`, `RangeError` o "out of memory" subito dopo `running…`. Oppure: nessun errore ma tempi di partita che **calano** dall'inizio alla fine del match (sezione 5, controllo C7). | Controllare che la Modalità di isolamento sia spenta. Un `CompileError` è un risultato da riportare così com'è, con il messaggio intero. |
| **Quantizzazione di `performance.now()`** | Senza isolamento cross-origin i browser arrotondano l'orologio (difesa contro Spectre). L'isolamento esiste solo in contesto sicuro (HTTPS o localhost). | Il passo esatto di Safari iOS con e senza isolamento: non lo scriviamo, lo misura la pagina. | Campo `timer_resolution_ms` del JSON; i valori di `sim_ms` sono tutti multipli (circa) di quel passo. | Servire in HTTPS (passo V3). Soglia di accettazione: ≤ 0,1 ms (`docs/PHASE0_NEXT.md` §5). Sopra, vale solo la regola del NO-GO netto (sezione 6). |
| **Selettore di file con file enormi** | Su iOS il selettore apre un menu; la voce per i file porta all'app File. File in iCloud non scaricati vengono scaricati prima di essere consegnati. | Se Safari fa una **copia** temporanea del file scelto (servirebbero altri ~1,5 GB liberi) e quanto ci mette; se `FileReaderSync` nel Worker legge davvero a pezzi un file di 1,46 GB su iOS (in `docs/PHASE0_TASKS.md` P0-10 è indicato come rischio non verificato). | Attesa lunga dopo la scelta del file; poi `refused: disc image is N bytes, expected 1459978240` se il file è arrivato troncato; oppure `error:` durante la corsa se la lettura fallisce; oppure `exit` diverso da 0 con log sul disco. | Tenere almeno 3 GB liberi. La prova corta (sezione 4, passo 6) verifica la lettura prima delle corse lunghe. |
| **Sospensione in background** | iOS ferma le pagine che non sono in primo piano (schermo bloccato, cambio di app, cambio di tab): anche il Worker si ferma. Una pagina in background a lungo può essere scaricata. | Se una breve sospensione fa ripartire la pagina o solo la mette in pausa. | Pausa: un `max_ms` enorme (secondi) e `wall_ms` molto più grande della somma dei `sim_ms`. Scaricamento: pagina ricaricata, nessun JSON. | Blocco automatico su "Mai" durante il test; non toccare il telefono durante una corsa; la corsa con una pausa va buttata e rifatta. |
| **Risparmio energetico e calore** | La modalità Risparmio energetico rallenta la CPU. Un telefono caldo rallenta. | Quanto rallenta questo modello dopo 3 corse. | Media della corsa 3 più alta della corsa 1 (controllo C8). | Risparmio energetico spento, telefono a temperatura ambiente, non in carica durante le corse, 5 minuti di pausa tra una corsa e l'altra. |
| **Download del JSON** | La pagina genera il JSON nel browser e lo offre con un link di download (`<a download>` su un URL `blob:`). | Che Safari in navigazione privata lo salvi in File come atteso. | Toccando `result JSON` compare la richiesta di download, poi il file nella cartella Download. | Verificato dalla prova corta. |

---

## 4. La procedura passo per passo (operatore, sull'iPhone)

Prima di iniziare l'agente ha fatto V1–V3 e ha dato all'operatore: l'indirizzo HTTPS, la password
(utente `fabri`) e il commit del core servito. Tempo totale stimato: 30–60 minuti, di cui la gran
parte è attesa (download della ISO e 4 corse). La stima non è misurata.

Le scritte della pagina sono in inglese; qui sono citate esattamente come appaiono.

**Preparazione del telefono (una volta)**

1. **Impostazioni.** Modalità di isolamento spenta; Risparmio energetico spento; Blocco automatico
   su "Mai"; in Impostazioni → Safari → Download, posizione "Sul mio iPhone"; almeno 3 GB liberi.
   Annotare **modello di iPhone e versione di iOS** (lo *user agent* di Safari, cioè la stringa con
   cui il browser si presenta, dice la versione di iOS ma **non** il modello).
   *Se non trova "Download" tra le impostazioni di Safari:* la voce cambia tra versioni di iOS;
   l'importante è che la ISO finisca in "Sul mio iPhone" e non in iCloud Drive.

**Arrivo della ISO (una volta)**

2. In Safari apre `https://<nome-macchina>.<tailnet>.ts.net/disc.iso`, inserisce utente `fabri` e
   password, conferma il download.
   *Deve vedere:* il download che avanza nella lista download di Safari.
   *Se vede un errore di certificato:* l'HTTPS della tailnet non è attivo, avvisare l'agente.
   *Se vede 401 o la richiesta di password che torna:* password sbagliata.
3. Aspetta la fine. Nell'app File, in Sul mio iPhone → Download, tiene premuto `disc.iso` →
   Informazioni.
   *Deve vedere:* 1,46 GB (1.459.978.240 byte se iOS mostra i byte).
   *Se il download si ferma:* lo riprende dalla lista download di Safari (il server accetta la
   ripresa). Se si blocca di nuovo, si passa alla strada D (Taildrop) con l'agente.

**Prova corta (una volta, 1–3 minuti)**

4. Apre una **tab privata** di Safari (serve a non avere service worker di visite precedenti né
   cache) e va a `https://<nome-macchina>.<tailnet>.ts.net/spike.html?frames=60`.
   *Deve vedere:* il titolo "Melee checkpoint spike", due selettori ("Local disc image", "Native
   reference CSV") e il bottone "Run".
   *Se vede `a service worker controls this page: use a private window`:* non è in una tab privata.
5. Tocca il selettore "Local disc image" → la voce per scegliere un file (su iOS in italiano
   "Scegli file"; l'etichetta può variare) → Sul mio iPhone → Download → `disc.iso`. Il selettore
   "Native reference CSV" si **lascia vuoto** (il confronto vero si fa sulla VPS).
   *Deve vedere:* il nome del file accanto al selettore, eventualmente dopo un'attesa.
6. Tocca "Run".
   *Deve vedere, in ordine:* `running…`; dopo il download (87 MB) e la compilazione del modulo,
   `core loaded: <commit> -O1`; alcune righe di log; infine `exit 0` e il link `result JSON`.
   *Se vede `refused: disc image is N bytes, expected 1459978240`:* la ISO è incompleta, rifare
   il passo 2.
   *Se vede `error: Error: no core at /spike-core/ ...`:* manca il core sul server, avvisare l'agente.
   *Se vede `error:` con `CompileError`, `RangeError` o "memory":* limite di WebAssembly o di
   memoria (sezione 3). Fotografare lo schermo con il messaggio intero.
   *Se la pagina si ricarica da sola:* memoria esaurita (sezione 3). Annotare se era prima o dopo
   `core loaded`.
   *Se resta su `running…` per più di 10 minuti senza `core loaded`:* download del modulo bloccato;
   annotare e avvisare l'agente.
   *Se `core loaded` mostra un commit diverso da quello comunicato dall'agente:* fermarsi, il server
   sta servendo un altro core.
7. Tocca `result JSON` e conferma il download. Il file si chiama `spike-result-<data-ora>.json`.
   Lo manda all'agente (passo 12) **prima** di proseguire: l'agente guarda
   `cross_origin_isolated` e `timer_resolution_ms` (sezione 5, C2). Se l'orologio è grossolano si
   decide subito se continuare comunque (sezione 6), invece di scoprirlo dopo tre corse lunghe.

**La cache OPFS (opzionale, una volta, senza Cloudflare).** La sezione "Disc cache" della pagina
scarica il disco **una volta** nella memoria del browser e poi lo riusa: è il meccanismo della PR 4
del piano di deploy, e finché non esistono le credenziali Cloudflare questa è l'unica occasione di
provarlo su un device vero. Va fatto in una **tab normale, non privata**: una finestra privata non
mantiene lo spazio persistente (`storage_persisted` resterà `false`) e la cache sparirebbe alla
chiusura — mentre il passo 4 richiede una tab privata proprio per non avere cache di visite
precedenti. Le due cose non stanno nella stessa finestra, e non devono: la cache si prova in una
tab normale, le tre corse cronometrate restano nella tab privata.

- Apre una tab normale su `.../spike.html` e tocca **"Download the disc into this browser"**. La
  riga sotto dice quanti byte ha già scritto; sono 1,46 GB una volta sola (lo stesso traffico del
  passo 2, ma verso la memoria del browser invece che verso l'app File).
  *Se compare `disc cache: unavailable`:* il manifest non è raggiungibile su quell'indirizzo
  (sezione 4, V3): il resto della procedura funziona, questa prova no.
- A download finito la riga dice che il disco è verificato: la pagina rilegge e ri-hasha ogni pezzo
  prima di dichiararlo completo.
- Lascia il selettore "Local disc image" **vuoto** e tocca "Run". Nel JSON il campo `disc_source`
  vale `opfs` invece di `file`: è la prova che la corsa ha preso il disco dalla cache. Il resto del
  risultato (traccia, `exit`) deve essere identico a una corsa con il selettore.
- *Se in alto compare `a service worker controls this page: use a private window`:* è un avviso,
  non un blocco — la pagina lo scrive e non cambia comportamento, quindi i due bottoni della cache
  e "Run" funzionano lo stesso. Vale la pena annotarlo nel messaggio all'agente, perché in una tab
  normale può capitare.
- Alla fine **"Delete the cached disc"** libera quello spazio (e il disco va cancellato anche
  dall'app File, passo 13).

**Le tre corse vere**

8. Chiude la tab privata, ne apre una nuova e va a `https://<nome-macchina>.<tailnet>.ts.net/spike.html`
   (senza `?frames=`: il valore predefinito è 2400). Sceglie la ISO come al passo 5. Tocca "Run".
9. **Non tocca il telefono fino alla fine**, schermo acceso, nessuna altra app. Durante la
   simulazione la pagina può restare ferma a lungo su `running…`/log: è normale. La durata di una
   corsa sul telefono non è nota (sotto Node sulla VPS: 81 s).
   *Deve vedere alla fine:* `exit 0`; nel log una riga
   `final scene: mode=2 state=2 match_frame=762 (retraces=2400)`; nel riquadro statistiche,
   sotto `in_match`, `"count": 762`.
   *Se vede `exit` diverso da 0:* fotografare il log e scaricare comunque il JSON (contiene le prove
   parziali).
   *Se `final scene` ha `mode=1` o `match_frame=0`:* la sequenza non è arrivata alla partita;
   scaricare il JSON e avvisare l'agente.
   *Se nel riquadro statistiche compare `errors` non vuoto:* scaricare il JSON lo stesso (quegli
   errori non finiscono nel JSON, fotografarli).
10. Tocca `result JSON` e scarica.
11. Aspetta **5 minuti** con lo schermo spento, poi ripete i passi 8–10. In tutto **tre corse**
    complete.
12. Manda all'agente i JSON (la prova corta e le tre corse) **senza aprirli né modificarli**, più
    il modello di iPhone e la versione di iOS. Strada proposta: condivisione dall'app File verso la
    VPS con Taildrop (**da verificare** che sia attivo; sulla VPS si ricevono con
    `tailscale file get <cartella>`); ripiego: AirDrop al Mac e `scp` verso la VPS.
13. A test finito cancella `disc.iso` dall'app File (e da "Eliminati di recente").

---

## 5. Come l'agente verifica il JSON sulla VPS

**Principio.** Nel JSON ci sono due tipi di contenuto:

- **Prove**: `trace_csv` (i 2400 checkpoint) e `sim_times_csv` (i tempi grezzi). La traccia è un
  elenco di 2400 righe di hash a 64 bit dello stato di CPU, RAM e ARAM. Non si può scrivere a mano
  né "aggiustare": l'unico modo di ottenere quella esatta sequenza è eseguire davvero il gioco,
  deterministicamente, sulla stessa ISO. Il browser non ha mai visto la traccia di riferimento
  (il selettore CSV è rimasto vuoto), quindi non può averla copiata. Per questo la traccia si
  **ricontrolla**, non si crede.
- **Dichiarazioni**: tutto il resto (`comparison`, `stats_all`, `stats_in_match`, `user_agent`,
  `core_opt`, …). Sono calcolate o riportate dalla pagina e **si ricalcolano o si incrociano**,
  non si copiano nel report.

Limite onesto: la traccia prova che *il core ha girato correttamente*, non *dove*. Che sia stato
l'iPhone lo dicono lo `user_agent` (dichiarato) e la parola dell'operatore. Anche i tempi sono
dichiarati: si possono solo controllare per coerenza (C5–C8), non dimostrare.

**Dove.** I file vanno in una cartella da creare, seguendo `docs/PHASE0_NEXT.md` S9:
`/home/hermes/incoming/phase0/devices/iphone-safari/` (fuori dal checkout, mai `git add`).

**Estrazione** (per ogni JSON; `R` è il file):

```bash
source /home/hermes/incoming/phase0/current.env     # SHA=f0d76a28…, D=/home/hermes/incoming/phase0/f0d76a2816ec
R=/home/hermes/incoming/phase0/devices/iphone-safari/<file>.json
W=$(mktemp -d)
python3 - "$R" "$W" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
for k in ('schema', 'created', 'core_commit', 'core_opt', 'user_agent', 'cross_origin_isolated',
          'timer_resolution_ms', 'frames', 'iso_bytes', 'exit_code', 'final_scene', 'wall_ms'):
    print(f'{k} = {r.get(k)!r}')
print('stats_in_match =', json.dumps(r.get('stats_in_match')))
print('comparison =', json.dumps(r.get('comparison')))
open(f'{sys.argv[2]}/trace.csv', 'w', newline='').write(r['trace_csv'])
open(f'{sys.argv[2]}/sim_times.csv', 'w', newline='').write(r['sim_times_csv'])
EOF
```

**Controlli, in ordine; il primo che fallisce ferma la valutazione di quel JSON.**

| # | Cosa | Atteso | Se no |
| --- | --- | --- | --- |
| C1 | `schema`, `frames`, `iso_bytes`, `exit_code` | `melee-spike-result/1`, `2400` (`60` per la prova corta), `1459978240`, `0` | JSON non valido per il verdetto; `exit_code ≠ 0` si diagnostica dal log |
| C2 | `cross_origin_isolated`, `timer_resolution_ms` | `true`, ≤ 0,1 | Vale solo la regola del NO-GO netto (sezione 6) |
| C3 | `core_commit` | uguale al `commit` di `$DIST/spike-core/core.json` letto in V2 | Il telefono ha eseguito un altro core: scartare |
| C4 | `final_scene` | `final scene: mode=2 state=2 match_frame=762 (retraces=2400)` | La partita non è stata raggiunta: niente tempi di partita |
| C5 | **Traccia**: `sha1sum "$W/trace.csv"` e `python3 scripts/phase0/compare_checkpoints.py "$D/runs/native-1/trace.csv" "$W/trace.csv"` | SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`; `identical: 2400 retraces`, exit 0 | Vedi sotto "Se la traccia differisce" |
| C6 | **Tempi**: `python3 scripts/phase0/frame_stats.py --in-match "$W/sim_times.csv"` | `count` 762; `mean_ms`, `p95_ms`, `p99_ms`, `max_ms` uguali (a meno dell'arrotondamento) a quelli di `stats_in_match` | Conta diversa da 762: la corsa non è quella attesa. Numeri diversi: la pagina o il JSON non sono quelli del repository; si usano i numeri ricalcolati e si indaga |
| C7 | **Riscaldamento del motore**: media dei primi 100 e degli ultimi 100 valori di partita in `sim_times.csv` | Differenza piccola (≤ 15%, soglia scelta qui, non dalla spec) | Tempi che calano durante la partita: il compilatore ottimizzante di Safari non aveva finito; si annota, e la media è pessimista |
| C8 | **Coerenza e stabilità**: somma di tutti i `sim_ms` < `wall_ms`; `max_ms` non assurdo (non secondi); tra le 3 corse, (media più alta − media più bassa) / media più bassa ≤ 15% (soglia scelta qui) | Tutto vero | Somma > `wall_ms`: tempi inventati o orologio rotto, scartare. `max_ms` di secondi: sospensione in background, rifare la corsa. Scarto > 15%: calore o interferenze, sezione 6 "non decidibile" |

Il campo `comparison` del JSON sarà `null` (nessun CSV di riferimento scelto sul telefono). Se
l'operatore l'avesse scelto, il suo contenuto (`identical`, `leftRows`, `rightRows`, `differences`,
`first`) è solo un'indicazione: fa fede C5.

**Il commit del riferimento.** La traccia nativa in `$D/runs/native-1/trace.csv` è del commit
`f0d76a2816eceefb7ec98b5b4a78a55edfa537c0`; il core servito sarà quasi certamente di un commit
successivo. `docs/PHASE0_NEXT.md` §9 chiede come oracolo un nativo dello **stesso** commit. Regola di
questo piano: se C5 dà SHA-1 `c79c53b9…` identico, la parità si accetta annotando entrambi i commit
(la stessa traccia è già stata prodotta da build di commit diversi, `docs/PROGRESS.md`, confronto F);
se C5 dà una differenza, **prima** di cercarne la causa si produce una traccia nativa del commit del
core servito, perché la differenza potrebbe venire dal commit e non da Safari.

**Aggiornamento 2026-10-01.** Il core pubblicato è ora `63511ce6c5f4e39be07b9acc9b517b2010ca01db`
(deploy `36868675226`) e la traccia nativa dello **stesso** commit esiste: run `36879113234`, in
`/home/hermes/incoming/phase0/reference-63511ce/run-1/trace.csv`, identica a `c79c53b9…` (due corse,
`identical: 2400 retraces`). Per quella pagina la regola del cross-commit non serve più: si passa
`--reference-commit 63511ce6c5f4e39be07b9acc9b517b2010ca01db` con quel file. `current.env` punta a
quella cartella (layout `runs/native-1/` incluso). Dettagli e numeri: `docs/PROGRESS.md`, sezione
del 2026-10-01 pomeriggio (PR #46, non ancora in `main` a questa data).

**Se la traccia differisce** (con riferimento dello stesso commit): è un risultato importante, non
un guasto del test. Vuol dire che JavaScriptCore calcola qualcosa in modo diverso da V8 e dal nativo.
Si annotano il primo retrace e la colonna che differiscono (li stampa `compare_checkpoints.py`), e
si segue `docs/AGENT_RULES.md` regola 5: nessuna modifica al ricompilatore prima di averli scritti.
Per la spec è NO-GO finché non è spiegata.

**Nota (aggiornata 2026-10-01).** `scripts/phase0/go_no_go.py` esiste (PR #31) e i controlli C1-C8 di questa
sezione sono dentro di lui: `evaluate_run()` li applica seguendo la tabella, con `WARMUP_TOLERANCE = 0.15`
per C7, `SPREAD_TOLERANCE = 0.15` e `MAX_PLAUSIBLE_MS = 1000.0` per C8, e `STATS_TOLERANCE_MS = 0.01` per il
confronto fra `stats_in_match` dichiarato e ricalcolato (C6). La sezione 6 non si calcola più a mano con i
valori di C6: si esegue il comando, che elenca in `reasons` ogni controllo fallito.

---

## 6. Il criterio go/no-go, con numeri

Le soglie sono quelle di `docs/SPEC_PIANO.md`, applicate come in `docs/PHASE0_NEXT.md` §5: solo
retrace di partita, **tre corse, conta la peggiore** (media più alta e p99 più alto tra le tre).
Sia *m* la media peggiore, *p* il p99 peggiore, *q* il `timer_resolution_ms` più grande tra le tre.
Siccome ogni misura può sbagliare fino a *q*, un verdetto vale solo se resta vero spostando i
numeri di *q* nella direzione sfavorevole.

**Prerequisiti** (altrimenti nessun verdetto, si ripete): tre JSON che passano C1, C3, C4, C5, C6;
C8 senza corse scartate.

| Esito per la riga iPhone | Condizione | Cosa vuol dire |
| --- | --- | --- |
| **NO-GO (correttezza)** | C5 differisce anche contro un nativo dello stesso commit | Safari non esegue lo stesso gioco. Si ferma tutto fino a spiegazione. |
| **NO-GO (prestazioni)** | *m* − *q* > 6 ms **oppure** *p* − *q* > 12 ms | Il telefono non regge il rollback. Vale anche con orologio grossolano. |
| **GO** | *m* + *q* ≤ 3 ms **e** *p* + *q* ≤ 6 ms **e** *q* ≤ 0,1 ms **e** C2 superato | Il telefono regge con il margine chiesto dalla spec. |
| **Solo desktop** | né GO né NO-GO, e i valori sono **chiaramente** nella fascia di mezzo: 3 < *m* − *q* e *m* + *q* ≤ 6, *p* + *q* ≤ 12 | Secondo la spec: si procede solo su desktop e si rivaluta il mobile in Fase 4. |
| **Non decidibile** | tutto il resto (vedi sotto) | Nessun verdetto. |

**Informazione a parte, non criterio:** se *p* ≤ 16,67 ms il gioco su questo iPhone terrebbe i
60 Hz **senza** rollback. Va scritto nel report, ma non cambia l'esito sopra.

**Due condizioni che pesano su qualunque esito:**

- **Il livello di ottimizzazione.** Se il core servito è a `-O1` (quello di `main` oggi), ogni esito
  diverso da GO è **provvisorio** (`docs/PHASE0_NEXT.md` S11): prima di chiamarlo definitivo si
  rifà il test con un core più ottimizzato che abbia ripassato i 2400 checkpoint.
- **Il device.** L'esito è della riga "iPhone <modello>, iOS <versione>". Diventa il go/no-go della
  spec solo se l'operatore decide che l'iPhone sostituisce l'Android di fascia media (§0.2). Senza
  quella decisione: un NO-GO sull'iPhone chiude il mobile (inferenza forte, perché un iPhone recente
  è in genere più veloce di un Android medio); un GO sull'iPhone **non** chiude la riga Android.

**Il caso "non decidibile", e cosa si fa.** Succede quando: una soglia cade dentro ±*q* dal valore
misurato; lo scarto tra le corse supera il 15% (C8); C7 mostra un forte riscaldamento; oppure la
riga iPhone è in fascia GO ma con orologio grossolano. Allora **non si dichiara un verdetto**. Si
scrive "non decidibile", con il motivo e i numeri, e si fa una sola di queste cose, nell'ordine:

1. orologio grossolano → attivare HTTPS (V3) e rifare le tre corse;
2. corse instabili → telefono freddo, pause di 10 minuti, tre corse nuove; se resta instabile, si
   riporta la peggiore con l'etichetta "instabile" e la decisione passa all'operatore;
3. riscaldamento forte (C7) → si riporta sia la media intera sia quella degli ultimi 100 frame,
   senza scegliere; è un'informazione per la Fase 1 (dove il core resterà caldo a lungo), non un
   motivo per ritoccare le soglie.

In nessun caso si ammorbidiscono soglie o controlli per far uscire un verdetto.

---

## 7. I rischi, e il segnale che li annuncia presto

| Rischio | Segnale precoce | Cosa fare |
| --- | --- | --- |
| **Modulo troppo grande da scaricare** (87 MB, e il server manda `Cache-Control: no-store`, quindi lo riscarica a **ogni** corsa) | Nella prova corta, molto tempo tra `running…` e `core loaded` | Misurare quel tempo e riportarlo. Rimedio lato nostro: il branch `-Oz`/`-g0` (in misura ora), poi compressione in trasferimento. Non cambia i tempi di simulazione. |
| **Memoria esaurita** | Pagina che si ricarica nella prova corta: prima di `core loaded` (compilazione) o dopo (corsa) | Una sola riprova dopo riavvio. Se ripete: "il core non carica su questo iPhone", NO-GO per questa build, provvisorio fino a un modulo più piccolo. |
| **Tempi quantizzati** | `cross_origin_isolated: false` o `timer_resolution_ms > 0.1` nel JSON della prova corta | Fermarsi e attivare HTTPS prima delle corse lunghe; altrimenti vale solo il NO-GO netto. |
| **Un solo device come campione** | È strutturale, non c'è segnale | Annotare modello e iOS; non generalizzare; la riga Android resta aperta (§0.2). |
| **La ISO non arriva** | Download che si ferma o rallenta al passo 2; `refused: disc image is …` al passo 6 | Riprendere il download; poi strada D (Taildrop). Se nessuna funziona, il test non si fa oggi: non esistono scorciatoie senza cambiare il Worker. |
| **Safari calcola diverso** (JavaScriptCore ≠ V8) | Traccia DIFFERENT già nella prova corta (confrontando le prime 60 righe con il riferimento) | Trattarlo come risultato, sezione 5 "Se la traccia differisce". |
| **Calore / sospensione** | Media della corsa 2 o 3 più alta della 1; `max_ms` di secondi | Pause, blocco automatico su "Mai"; corsa rifatta. |
| **Artefatto scaduto** (`melee-spike-dist` dura 3 giorni) | `$DIST` mancante al passo V2 | Nuovo dispatch (≈ 28 minuti di CI), controllando che il commit sia quello voluto. |

Per il rischio "Safari calcola diverso" la prova corta si confronta così: si prendono le prime 61
righe (intestazione + 60) della traccia di riferimento e si danno a `compare_checkpoints.py` insieme
alla traccia della prova corta; `identical: 60 retraces` è il segnale buono.

---

## 8. Cosa NON stiamo verificando

Detto esplicitamente, perché un GO qui non venga letto come più di quello che è:

- **Niente grafica.** Il core gira `--headless`: nessun rendering, né WebGPU né altro. Il costo del
  disegno sul telefono non è misurato e si aggiungerà a quello della simulazione.
- **Niente audio.** `--volume 0`, AX muto.
- **Niente input umano.** L'input viene da una sequenza scriptata (`parity_vs_onett.txt`): nessun
  tocco, nessun controller, nessuna latenza di input.
- **Niente rete e niente rollback vero.** Misuriamo il costo di simulare un frame; il rollback è
  dedotto da quel costo, non eseguito.
- **Niente thread.** Il modulo è a thread singolo; il comportamento con più thread è della Fase 1.
- **Un solo modello di telefono, una sola versione di iOS, un solo browser** (Safari). Niente
  Android, niente altri iPhone, niente Chrome iOS.
- **Niente uso prolungato.** Tre corse di pochi minuti, non una sessione di gioco di mezz'ora: il
  comportamento termico a lungo termine non è misurato.
- **Niente verifica del livello di ottimizzazione finale.** Con il core a `-O1` il risultato vale per
  `-O1`.
- **Niente prova che i tempi vengano dall'iPhone.** La traccia prova l'esecuzione corretta; il device
  e i tempi sono dichiarati (sezione 5).
