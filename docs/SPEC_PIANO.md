# Melee Browser: piano di implementazione

Sep 30, 2026 · @Fabrizio

Obiettivo: Super Smash Bros. Melee giocabile nel browser, da PC e mobile, con multiplayer online tra amici, partendo dalla ricompilazione statica di melee-unlocked e senza alcun server proprio. Il piano è scritto per un agente AI che lavora in autonomia come senior engineer: ogni fase ha deliverable e criteri di uscita verificabili.

## Obiettivo, vincoli e definizione di fatto

Il prodotto finale è un URL: un amico lo apre da PC o telefono, fa login, entra in una stanza con un codice e gioca online contro di te. Niente installazioni, niente ISO sul suo dispositivo.

**Vincoli non negoziabili**

- Deve girare nel browser: nessun client nativo, nessuno streaming video da server.
- Nessun server proprio da gestire (niente VPS). Solo servizi managed: Cloudflare (Pages, R2, Access, TURN) e Supabase (Realtime).
- Uso privato tra amici: accesso protetto, mai pubblico.
- Unica versione supportata: Melee NTSC-U 1.02 (Game ID GALE01).
- Il proprietario del progetto sviluppa solo in modalità AI-assisted: tutto il codice lo scrive l'agente, ogni fase deve lasciare script riproducibili e documentazione.

**Definizione di fatto (v1.0)**

1. Da Chrome desktop, Edge desktop e Chrome Android: boot, menu, selezione personaggi e stage, match contro CPU a 60fps stabili.
2. Due browser su reti diverse (inclusa una rete mobile 4G/5G) giocano un 1v1 online completo senza desync, con rollback attivo.
3. Controller fisico via Gamepad API su tutte le piattaforme; overlay touch funzionante come fallback.
4. Primo avvio sotto i 100 MB di download prima del menu; avvii successivi dalla cache locale.
5. Deploy riproducibile con un comando; nessun file di gioco nel repository pubblico.

**Fuori scope per la v1.0**: free-for-all a 4 giocatori online (Slippi supporta 1v1 e 2v2), ranked Slippi, matchmaking contro utenti Slippi Dolphin, Safari iOS se WebGPU o i thread WASM risultano instabili (valutato in Fase 4), frame rate sbloccato, DLSS.

## Architettura

Il gioco gira interamente nel browser di ogni giocatore; il cloud serve solo a scaricare sito e file di gioco e a far incontrare i giocatori. Durante il match il traffico va diretto tra i due browser.

&#91;embedded content: architettura · browser, servizi managed, P2P\]

La simulazione (evidenziata) è il cuore: tutto il resto la alimenta (input, file) o ne consuma lo stato (grafica, audio, rete). Il build offline, una volta sola: DOL → `recomp.py` → C++ → Emscripten → `melee.wasm`; il resto del disco viene spacchettato in file e caricato su R2.

## Repo di partenza e cosa riusare

La base è melee-unlocked: è l'unico progetto che ha già simulazione deterministica verificata, netcode rollback Slippi funzionante e codice compilabile senza estensioni GCC. Gli altri due repo servono come riferimento, non come base.

| Repo | Ruolo nel progetto | Cosa prendere | Cosa NON prendere |
| --- | --- | --- | --- |
| [Hero88go/melee-unlocked](https://github.com/Hero88go/melee-unlocked) | Base del fork | Ricompilatore `port/recomp/`, runtime `port/runtime/` (HLE di OS, VI, PAD, DVD, AX, CARD, EXI), device EXI Slippi, rollback, checksum anti-desync, test e tool di validazione | Renderer D3D12/D3D11, Streamline/DLSS, WinHTTP, BCrypt, WASAPI/WinMM, Raw Input, WinUSB, updater, launcher |
| [999sian/melee-pc](https://github.com/999sian/melee-pc) | Riferimento grafico | Studio di come [aurora](https://github.com/encounter/aurora) traduce GX in WebGPU (TEV, formati texture, vertex format) | Il codice di gioco: richiede GCC per `scalar_storage_order`, incompatibile con Emscripten |
| [encounter/aurora](https://github.com/encounter/aurora) | Riferimento o libreria per GX su WebGPU | Shader generator TEV, conversione texture GameCube, gestione pipeline WebGPU | Da valutare in Fase 1 se integrabile direttamente (vedi sotto) |
| [doldecomp/melee](https://github.com/doldecomp/melee) | Riferimento semantico | Nomi di funzioni e strutture per capire cosa fa il codice ricompilato; mappa `symbols.txt` | Nulla da compilare |
| [project-slippi/Ishiiruka](https://github.com/project-slippi/Ishiiruka) | Riferimento netcode | Logica originale del device EXI Slippi e del netplay, utile per debug | Nulla da compilare |

**Primo compito dell'agente prima di scrivere codice**: leggere integralmente `README.md`, `PORT_COMPLETION.md` e `HANDOFF_FABLE_3.md` di melee-unlocked, poi mappare la struttura di `port/runtime/` in un file `docs/RUNTIME_MAP.md` del fork: per ogni modulo, cosa fa, da cosa dipende, quali API Windows usa, cosa va sostituito nel browser. Verificare anche il contenuto delle cartelle `native/` e `sourceport/`: la descrizione del repo cita sia una modalità "Source Port" sia "Static Recomp", capire quale delle due è più adatta a WASM.

**Fatti tecnici già noti su melee-unlocked** (da `PORT_COMPLETION.md`):

- `__longjmp` è implementato come eccezione C++ (`ppc::GuestLongJmp`) catturata da loop di retry generati dal ricompilatore. In WASM servono le eccezioni native: flag `-fwasm-exceptions`.
- Le letture da disco sono già asincrone su un thread worker, con completamento consegnato a un tempo virtuale fisso (un quarto di frame dopo la richiesta). Questo è perfetto per il browser: la lettura può diventare una `fetch` senza rompere il determinismo.
- Il renderer compila le pipeline grafiche su thread worker e usa pipeline di fallback generiche mentre quella vera è in compilazione. Circa 6.500 pipeline in cache: in WebGPU la stessa strategia va replicata con `createRenderPipelineAsync`.
- Ogni frame il gioco passa al device EXI un checksum dello stato; i due client lo confrontano e loggano `DESYNC` alla prima differenza. È il nostro oracolo di correttezza cross-platform.
- Esiste un bot di input scriptato (`port/scripts/online_bot.txt`) e un tool che fa giocare due istanze locali (`tools/online_pair.py`).
- Il codice Slippi (Gecko codes) viene compilato dentro al gioco al momento della ricompilazione (`--gct-base 0x8065CC80`).

**Licenze**: il fork resta GPL-2.0-or-later come l'originale. Il codice generato (`port/generated/`) deriva dal DOL Nintendo e non va mai pubblicato: repo privato o `.gitignore`.

## Setup ambiente di sviluppo

Si lavora in un GitHub Codespace privato (Linux) e non sul Mac: la toolchain Emscripten più il codice generato occupano decine di GB e il disco locale è sempre pieno. Il Mac serve solo per aprire il browser e testare.

**Repository**

1. Creare un repo **privato** `melee-web` (fork di melee-unlocked, poi reso privato, oppure clone + push su repo nuovo privato per non pubblicare mai nulla per errore).
2. Branch `main` protetto, lavoro su branch per fase (`phase-0-spike`, `phase-1-webgpu`, ecc.), merge via PR con descrizione di cosa è stato verificato.
3. `.gitignore` obbligatorio: `*.iso`, `*.gcm`, `*.rvz`, `*.dol`, `port/generated/`, `build*/`, `dist/`, `assets-extracted/`.

**Codespace**

- Macchina da almeno 8 core e 32 GB RAM: la ricompilazione genera molto C++ e il link WASM è pesante.
- `.devcontainer/devcontainer.json` nel repo con: Ubuntu, Python 3.11+, CMake 3.25+, Ninja, Node 20+, emsdk.
- Installare emsdk all'ultima versione stabile: `git clone https://github.com/emscripten-core/emsdk && ./emsdk install latest && ./emsdk activate latest`. Fissare la versione usata in un file `EMSDK_VERSION` per build riproducibili.
- Verificare che la versione supporti `--use-port=emdawnwebgpu` (il vecchio `-sUSE_WEBGPU` è deprecato).
- Chrome headless o Playwright installato nel Codespace per i test automatici nel browser.

**ISO e DOL (mai nel repo)**

- Il proprietario carica l'ISO nel Codespace a mano (drag and drop nel file explorer) in `~/private/melee.iso`.
- Verificare lo SHA-1 contro Redump: `d4e70c064cc714ba8400a849cf299dbd1aa326fc`, dimensione 1.459.978.240 byte. Se non combacia, fermarsi e chiedere.
- Estrarre il DOL con lo script esistente: `python tools/extract_dol.py ~/private/melee.iso build/main.dol`.
- Estrarre il filesystem completo del disco in `assets-extracted/` (script nuovo `tools/extract_fs.py`, basato sulla libreria [nod](https://github.com/encounter/nod) o sul parser già presente nel runtime).

**Build nativa di riferimento (Linux)**

Prima di toccare WASM, l'agente deve ottenere una build nativa **headless** su Linux che passi `tools/validate_native.py`. Serve come riferimento "verità" per confrontare i checkpoint WASM. Probabilmente richiede di isolare il codice Windows-only dietro `#ifdef _WIN32` e aggiungere un target CMake `melee_core_headless` senza renderer, audio e rete. Questo lavoro serve comunque alla build WASM.

## Fase 0: spike headless in WASM (go/no-go)

La Fase 0 risponde a una sola domanda: la simulazione del gioco, senza grafica, gira nel browser di un telefono di fascia media con abbastanza margine per il rollback? Se la risposta è no, il progetto si ferma qui e si risparmiano settimane.

**Passi**

1. **Build nativa headless su Linux** (vedi Setup). Deve passare `tools/validate_native.py` con i 2400 checkpoint identici alla build Windows di riferimento. Se non esiste una build Windows a portata, basta che i checkpoint siano stabili tra run diverse.
2. **Target CMake `melee_core_wasm`** con `emcmake cmake` e toolchain Emscripten. Solo: codice generato + runtime HLE (OS, VI, PAD con input finti, DVD, AX in modalità muta, CARD in memoria). Esclusi: renderer, audio reale, rete, launcher.
3. **Flag di compilazione iniziali**: `-O3 -fwasm-exceptions -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sSTACK_SIZE=8MB -sENVIRONMENT=web,worker`. Senza thread per ora (`-pthread` arriva in Fase 1). Aggiungere `-sASSERTIONS=1 -g` in build debug.
4. **Problemi attesi da risolvere**: codice generato con funzioni enormi (possibile limite del compilatore o del browser sulla dimensione delle funzioni WASM: spezzare le funzioni in fase di ricompilazione se serve); dispatch indiretto delle funzioni PowerPC (tabella di puntatori a funzione, verificare `-sALLOW_TABLE_GROWTH` se necessario); eccezioni per setjmp/longjmp; accessi di memoria big-endian (verificare che usino byteswap espliciti e non dipendano da tipi Windows); intrinseci MSVC (`_byteswap_ulong`, `__popcnt`, ecc.) da sostituire con `__builtin_bswap32` e simili.
5. **Filesystem**: per lo spike caricare i file di gioco necessari in MEMFS con `--preload-file` limitato ai file che servono per arrivare a un match (o servirli via `fetch` sincrono in un Worker). Non serve ancora il sistema on-demand.
6. **Harness nel browser**: una pagina `spike.html` che lancia il core in un Web Worker, esegue la stessa sequenza scriptata di `validate_native.py` (match CPU vs CPU con seed fisso) e stampa: checkpoint (hash di CPU, RAM, ARAM), tempo medio per frame, p95, p99, frame più lento.
7. **Confronto checkpoint**: i 2400 checkpoint del browser devono essere identici bit per bit a quelli della build nativa. Uno script `tools/compare_checkpoints.py` fa il diff. Qualsiasi differenza va investigata prima di proseguire (probabile causa: semantica floating point, vedi Rischi).
8. **Benchmark su dispositivi reali**: Chrome desktop, Chrome su un Android di fascia media (es. Snapdragon 7 series), Safari macOS, Safari iOS se possibile. Per aprire la pagina dal telefono usare il port forwarding del Codespace (porta pubblica temporanea) o un deploy su Cloudflare Pages di anteprima.

**Criteri go/no-go**

| Metrica | Go | No-go |
| --- | --- | --- |
| Checkpoint vs nativo | 2400/2400 identici | Qualsiasi differenza non spiegata |
| Tempo medio per frame, telefono Android fascia media | ≤ 3 ms | > 6 ms |
| p99 per frame, telefono | ≤ 6 ms | > 12 ms |
| Tempo medio per frame, desktop | ≤ 1,5 ms | > 4 ms |

Perché queste soglie: un frame dura 16,7 ms. Il rollback di Slippi può risimulare fino a 7 frame in un solo tick quando c'è lag, quindi la simulazione deve costare al massimo circa 2 ms per frame per restare sotto il budget, lasciando spazio al rendering. Tra 3 e 6 ms sul telefono si procede solo su desktop e si rivaluta il mobile in Fase 4.

**Deliverable Fase 0**: branch `phase-0-spike` con target `melee_core_wasm`, `spike.html`, `tools/compare_checkpoints.py`, e un report `docs/PHASE0_REPORT.md` con tabella dei tempi per dispositivo, esito checkpoint e decisione go/no-go motivata.

## Fase 1: build WASM completa e renderer WebGPU

La Fase 1 porta a vedere il gioco nel browser e a giocare contro la CPU con tastiera. È la fase più lunga: il renderer D3D12 va sostituito con uno WebGPU.

**1.1 Threading e memoria condivisa**

- Passare a `-pthread` con `-sPTHREAD_POOL_SIZE=4` (simulazione, audio, compilazione pipeline, I/O). Richiede `SharedArrayBuffer`, quindi header COOP/COEP sul server (vedi Hosting). In locale usare un piccolo server di sviluppo che li imposta (es. script Node o `npx serve` con config header).
- Architettura thread: la simulazione a 60 Hz gira in un Worker dedicato; il rendering WebGPU gira nel thread che possiede il canvas. Con Emscripten la via più semplice è `-sOFFSCREENCANVAS_SUPPORT=1` e rendering da un pthread con OffscreenCanvas, oppure `-sPROXY_TO_PTHREAD=1` per togliere `main()` dal thread principale. Scegliere dopo un prototipo e documentare la scelta.
- Il main loop del browser è `requestAnimationFrame`: usare `emscripten_set_main_loop` solo per il presenter; la simulazione ha il suo ritmo a 60 Hz indipendente (come già fa melee-unlocked separando simulazione e display).

**1.2 Studio del renderer esistente**

- Leggere tutto `port/runtime/gx/`: capire a che livello il runtime intercetta la grafica. Due casi possibili: (a) emulazione del FIFO GX a livello hardware (command stream), (b) HLE delle funzioni SDK `GX*`. Documentare in `docs/RENDERER_MAP.md`.
- Identificare l'interfaccia tra "stato GX" (vertex format, TEV stages, texture, blending, z-mode) e backend D3D. L'obiettivo è introdurre un'astrazione `IRenderBackend` con implementazioni D3D12 (esistente) e WebGPU (nuova), senza toccare la logica GX.

**1.3 Backend WebGPU**

- API C: `webgpu.h` via `--use-port=emdawnwebgpu` (compilazione e link). Per sviluppare e debuggare anche in nativo, usare Dawn sul Codespace con lo stesso codice (vedi [webgpu-cross-platform-demo](https://github.com/kainino0x/webgpu-cross-platform-demo) come modello di progetto CMake che compila per web e nativo).
- Shader: gli shader D3D sono HLSL generati dallo stato TEV. Serve un generatore equivalente che emetta **WGSL**. Riferimento diretto: il generatore TEV di aurora, che fa esattamente GX TEV → WGSL. Valutare prima se si può riusare il modulo shader di aurora (licenza da verificare) invece di riscriverlo.
- Texture: formati GameCube (I4, I8, IA4, IA8, RGB565, RGB5A3, RGBA8, CI4, CI8, CMPR). Decodificare su CPU in RGBA8 al caricamento e mettere in cache per indirizzo e hash (come fa Dolphin). CMPR si può decodificare in BC1 solo se `texture-compression-bc` è disponibile (desktop sì, mobile spesso no): partire sempre da RGBA8.
- Pipeline: cache per chiave di stato (vertex layout + TEV + blend + depth + cull). Creazione con `createRenderPipelineAsync`, mai sincrona durante un frame. Mentre la pipeline vera compila, disegnare con la pipeline di fallback generica (stessa strategia già presente nel runtime). Precaricare le pipeline note a partire dalle "recipe" che melee-unlocked già salva (`shadercache/recipes.bin`): generarle una volta e servirle come file statico.
- EFB e copie: Melee usa copie dell'EFB (framebuffer) in texture per alcuni effetti e per le schermate di transizione. Implementare copy-to-texture con render target intermedi. Risoluzione interna 1x di default su mobile, scalabile su desktop.
- Presentazione: canvas con `getPreferredCanvasFormat()`, aspect 73:60 nativo con letterbox, opzione 4:3 e 16:9 (il codice widescreen Slippi è già un'opzione runtime).
- Fallback WebGL2: **non** farlo in v1.0. Se un dispositivo non ha WebGPU, mostrare un messaggio chiaro. Verificare il supporto reale in [caniuse WebGPU](https://caniuse.com/webgpu) all'inizio della fase.

**1.4 Input minimo per giocare**

- Tastiera mappata come in melee-unlocked (frecce = stick, X = A, Z = B, ecc.), letta via eventi DOM e scritta nello stato PAD condiviso che la simulazione legge a ogni frame.

**Criteri di uscita Fase 1**

1. Su Chrome desktop: boot, filmato iniziale (o skip), menu, selezione, match contro CPU su almeno 5 stage diversi senza artefatti grafici evidenti.
2. 60 fps stabili su un laptop con GPU integrata; simulazione mai rallentata dal rendering.
3. Checkpoint della simulazione ancora identici al nativo con il renderer attivo.
4. Screenshot di confronto con la build Windows per 10 scene di riferimento salvati in `docs/phase1-screens/`.

## Fase 2: audio, input, file on-demand, salvataggi

La Fase 2 completa l'esperienza in singolo: suono, controller, caricamento veloce e salvataggi persistenti.

**2.1 Audio**

- Il runtime ha già un mixer software AX (e la Jukebox Slippi per la musica, `port/runtime/hle/jukebox.cpp`) che oggi esce su WASAPI/WinMM. Sostituire solo l'uscita: un [AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet) legge campioni da un ring buffer in `SharedArrayBuffer` scritto dal thread audio WASM. Emscripten ha supporto nativo: [Wasm Audio Worklets](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html) (`-sAUDIO_WORKLET=1 -sWASM_WORKERS=1`).
- Frequenza: il mixer produce 32 kHz; lasciare che l'`AudioContext` ricampioni oppure ricampionare a 48 kHz nel worklet.
- Buffer: 3-4 blocchi da 128 campioni come target di latenza; gestire underrun inserendo silenzio, mai bloccando la simulazione.
- Autoplay: l'`AudioContext` parte solo dopo un gesto dell'utente. La schermata iniziale deve avere un pulsante "Gioca" che lo sblocca.

**2.2 Input da controller**

- [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API): polling a ogni frame di simulazione (non a ogni `requestAnimationFrame`), scrittura nello stato PAD condiviso.
- Mapping di default per "standard gamepad" (Xbox, PlayStation, Switch Pro): stick sinistro = control stick, stick destro = C-stick, grilletti analogici = L/R analogici con soglia per il click digitale.
- Adattatore GameCube ufficiale: in browser non è accessibile come gamepad standard senza driver. Opzione avanzata da valutare dopo la v1.0: [WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API) su Chrome desktop, riusando la logica WUP-028 già presente.
- Schermata di rimappatura salvata in `localStorage` per dispositivo (per id del gamepad).
- Assegnazione porte: ogni giocatore locale sceglie la porta; in online la porta la decide la stanza.

**2.3 File di gioco on-demand**

- Estrarre il filesystem del disco (file `.dat`, `.usd`, `.hps`, `.thp`, ecc.) in `assets-extracted/`.
- Generare un **manifest** `assets/manifest.json`: per ogni file, percorso, dimensione, SHA-256, e un gruppo di priorità (`boot`, `menu`, `character:<nome>`, `stage:<nome>`, `music`, `movies`).
- Comprimere ogni file (Brotli o gzip, servito con `Content-Encoding` corretto da R2) e caricarlo su R2 con nome content-addressed (`<sha256>.bin`), così la cache non si invalida mai per errore.
- Nel runtime, il modulo DVD HLE smette di leggere dall'ISO: chiede il file al layer JS, che guarda prima nella cache locale ([OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)) e se manca fa `fetch` da R2, poi salva in OPFS. Le letture sono già asincrone con completamento a tempo virtuale: mantenere questa semantica, e se un file non è arrivato in tempo, mettere in pausa la simulazione (mai consegnare dati in ritardo in modo non deterministico).
- Prefetch: al boot scaricare `boot` e `menu`; alla selezione di personaggi e stage scaricare i gruppi relativi prima dell'avvio del match (la schermata di caricamento del match copre l'attesa).
- Filmati THP: opzionali, scaricati solo se l'utente non li salta; tagliarli dalla v1.0 se pesano troppo.
- Richiedere `navigator.storage.persist()` per evitare che il browser cancelli la cache.
- Il DOL non serve a runtime: il codice è già dentro il `.wasm`. Unica eccezione: i due atlanti di font HSD e altri dati letti dal DOL a runtime vanno estratti in file a parte.

**2.4 Salvataggi**

- Memory card `.gci` salvate in OPFS (stesso formato Dolphin, così si può importare un salvataggio esistente con tutti i personaggi sbloccati).
- Pulsante di import/export del `.gci` nel menu impostazioni.
- Consiglio per la v1.0: fornire un salvataggio con roster completo sbloccato, così nessuno deve sbloccare personaggi.

**2.5 UI shell (fuori dal gioco)**

- App web leggera (TypeScript + Vite, niente framework pesanti) che contiene: schermata di avvio, barra di progresso download, impostazioni (grafica, audio, controlli), lobby online (Fase 3), overlay touch (Fase 4).
- L'overlay impostazioni in-game di melee-unlocked usa Dear ImGui su D3D: in browser è più semplice rifarlo come HTML sopra il canvas, con il gioco in pausa.

**Criteri di uscita Fase 2**

1. Audio senza crackle per un match intero su desktop e Android.
2. Controller Xbox/PS/Switch Pro funzionanti con rimappatura.
3. Primo avvio sotto 100 MB prima del menu; secondo avvio senza download.
4. Salvataggio che sopravvive a chiusura del browser.

## Fase 3: multiplayer con lobby, WebRTC e rollback

Il netcode rollback di Slippi è già nel runtime e va tenuto intatto. Si sostituiscono solo tre cose: il trasporto (ENet su UDP diventa WebRTC DataChannel), il matchmaking (i server Slippi diventano la nostra lobby) e l'identità (l'account Slippi diventa l'utente della nostra app).

**3.1 Mappare il netcode esistente**

- Trovare in `port/runtime/` il device EXI Slippi, il client netplay, l'uso di ENet e il client matchmaking verso `mm.slippi.gg`. Documentare in `docs/NETCODE_MAP.md`: formato dei pacchetti, frequenza, dimensione media, quali messaggi sono affidabili e quali no, dove avvengono time sync e rollback.
- Introdurre un'interfaccia `INetTransport` (send, receive non bloccante, stato connessione, RTT) con due implementazioni: ENet (nativo, per test) e WebRTC (browser). Il resto del netcode non deve accorgersi della differenza.
- Disattivare in build web: game reporting verso Slippi (`slippi_report.cpp`), rank, upload replay, login Slippi.

**3.2 Trasporto WebRTC**

- `RTCPeerConnection` vive nel thread principale (non è disponibile nei Worker in modo affidabile su tutti i browser). I pacchetti passano tra JS e il thread netcode WASM tramite due ring buffer in `SharedArrayBuffer` (uno in entrata, uno in uscita), senza copie inutili e senza bloccare nessuno.
- DataChannel per i dati di gioco: `{ordered: false, maxRetransmits: 0}`, cioè semantica UDP. I pacchetti Slippi passano come byte grezzi, senza riformattarli.
- Se il netcode ha anche messaggi che richiedono affidabilità (handshake, selezione personaggi), aprire un secondo DataChannel `{ordered: true}` e instradarli lì.
- ICE server: STUN `stun:stun.cloudflare.com:3478` (gratuito) più TURN Cloudflare Realtime per le reti che bloccano il P2P (tipico su 4G/5G e reti aziendali). Documentazione: [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/).
- Le credenziali TURN sono temporanee e si generano con una chiamata API che usa un token segreto: farlo in una [Cloudflare Pages Function](https://developers.cloudflare.com/pages/functions/) (`/api/turn-credentials`), protetta da Access. Il token sta nelle variabili d'ambiente di Pages, mai nel client.

**3.3 Lobby e signaling (Supabase Realtime)**

- Progetto Supabase dedicato. Autenticazione: [anonymous sign-in](https://supabase.com/docs/guides/auth/auth-anonymous) con nickname scelto dal giocatore (l'accesso al sito è già filtrato da Cloudflare Access).
- Stanza = canale [Realtime Broadcast](https://supabase.com/docs/guides/realtime/broadcast) privato `room:<CODICE>`, codice di 4 lettere. [Presence](https://supabase.com/docs/guides/realtime/presence) mostra chi c'è nella stanza.
- Flusso: il creatore della stanza è l'host (porta 1). Quando entra il secondo giocatore, l'host crea l'offer SDP e la invia sul canale; il guest risponde con l'answer; entrambi si scambiano ICE candidates (trickle ICE). Appena il DataChannel è aperto, il canale Supabase serve solo per chat e stato della stanza.
- Nessuna tabella necessaria per la v1.0. Opzionale: tabella `rooms` con RLS per una lista di stanze aperte.

**3.4 Innesto nel gioco**

- Il gioco con i codici Slippi mostra il suo menu online (Unranked, Direct, Teams). Per la v1.0, implementare un **backend matchmaking finto** dentro il runtime web: quando il gioco chiede un avversario in modalità Direct, il backend risponde con il peer già connesso tramite la nostra lobby. Così il flusso di menu originale resta invariato e il gioco entra in selezione personaggi online come su Slippi.
- Alternativa più semplice se il punto sopra è complicato: avviare direttamente la selezione personaggi online quando la stanza è pronta, saltando il menu online.
- Modalità: 1v1 (due giocatori) e 2v2 Teams (quattro giocatori, mesh di connessioni come fa Slippi). Il free-for-all a 4 non è supportato dal netcode Slippi.
- Input delay: default 2 frame in browser (Slippi usa 2 di default), regolabile da 1 a 4 nelle impostazioni.

**3.5 Determinismo tra piattaforme**

- Rischio principale di questa fase: desktop x86 e telefono ARM devono calcolare esattamente lo stesso stato. WASM ha semantica IEEE 754 deterministica per le operazioni base, ma attenzione a: funzioni di libreria matematica (usare sempre le implementazioni del gioco o del runtime, mai `Math.*` di JS o `libm` di sistema), fused multiply-add (il ricompilatore deve emulare esattamente `fmadd` PowerPC, non affidarsi al compilatore), SIMD relaxed (non usare `-mrelaxed-simd`), `-ffast-math` vietato.
- Il checksum per frame già presente è l'oracolo: loggare `DESYNC` con numero di frame e dump dello stato, per trovare la prima funzione che diverge.

**Criteri di uscita Fase 3**

1. Due tab dello stesso browser: 20 match 1v1 completi con il bot di input, zero `DESYNC`.
2. Chrome desktop contro Chrome Android su reti diverse (Wi-Fi contro 4G): 10 match completi, zero `DESYNC`, connessione stabilita anche tramite TURN.
3. 2v2 con quattro browser: almeno 3 match completi.
4. Con 100 ms di latenza simulata (Chrome DevTools non simula UDP: usare un proxy di rete o testare su reti reali), il gioco resta fluido senza rallentamenti.

## Fase 4: mobile, touch, PWA

La Fase 4 rende il gioco usabile da telefono. Il consiglio da dare agli amici resta: controller Bluetooth. Il touch è un fallback.

**4.1 PWA**

- `manifest.webmanifest` con `display: fullscreen`, `orientation: landscape`, icone. Installabile su Android ("Aggiungi a schermata Home") e iOS.
- Service Worker per cache della shell (HTML, JS, WASM) con strategia cache-first e versione nel nome file; i file di gioco restano in OPFS.
- [Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) durante i match per evitare che lo schermo si spenga.
- Blocco orientamento orizzontale dove supportato; altrimenti messaggio "ruota il telefono".

**4.2 Overlay touch**

- Layer HTML/Canvas sopra il gioco: stick analogico virtuale a sinistra (flottante: parte dove appoggi il pollice), pulsanti A, B, X, Y, Z, L, R, Start a destra, C-stick come quattro zone di swipe.
- Multitouch con Pointer Events, nessun ritardo (`touch-action: none`), vibrazione breve alla pressione dove supportata.
- Layout personalizzabile e salvato in `localStorage`; opacità regolabile.
- L'overlay scrive nello stesso stato PAD del Gamepad API.

**4.3 Prestazioni su mobile**

- Preset "Mobile": risoluzione interna 1x, niente anti-aliasing, niente effetti di post-processing, cap a 60 fps.
- Rilevare il carico: se la simulazione più il rendering superano il budget per più di N frame, mostrare un avviso e proporre il preset più leggero.
- Termico: testare sessioni da 20 minuti; i telefoni rallentano quando si scaldano.
- iOS Safari: verificare separatamente WebGPU, `SharedArrayBuffer` con COOP/COEP, AudioWorklet e OPFS. Se uno manca, documentarlo e dichiarare iOS non supportato nella v1.0 invece di inseguire workaround.

**Criteri di uscita Fase 4**

1. Installabile come PWA su Android, gioco a schermo intero in orizzontale.
2. Match completo giocabile con overlay touch e con controller Bluetooth.
3. 60 fps stabili per 20 minuti su un Android di fascia media con preset Mobile.
4. Stato di iOS documentato con esito dei test.

## Hosting e deploy su Cloudflare

Tutto sta su un dominio Cloudflare: sito e WASM su Pages, file di gioco su R2 sotto un sottodominio, accesso filtrato da Access. Costo atteso vicino a zero: il TURN ha 1.000 GB al mese gratuiti, poi 0,05 dollari per GB.

| Componente | Servizio | Contenuto | Note |
| --- | --- | --- | --- |
| Sito | [Cloudflare Pages](https://developers.cloudflare.com/pages/) | HTML, JS, `.wasm`, worker, manifest PWA | Limite di dimensione per singolo file: se il `.wasm` lo supera, spostarlo su R2 |
| API | Pages Functions | `/api/turn-credentials`, eventuale `/api/manifest` | Segreti in variabili d'ambiente |
| File di gioco | [Cloudflare R2](https://developers.cloudflare.com/r2/) | File estratti dal disco, compressi, content-addressed | Egress gratuito; bucket privato con dominio custom |
| Accesso | [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (Zero Trust, piano gratuito fino a 50 utenti) | Policy: email degli amici, login con codice via email | Proteggere sia il sito sia il sottodominio R2 |
| TURN | [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/) | Relay per reti che bloccano il P2P | Credenziali brevi generate da Pages Function |
| Lobby | [Supabase Realtime](https://supabase.com/docs/guides/realtime) | Canali stanza, presence, signaling | Piano gratuito sufficiente |

**Header obbligatori**

I thread WASM richiedono isolamento cross-origin ([guida web.dev](https://web.dev/articles/coop-coep)). File `_headers` in Pages ([docs](https://developers.cloudflare.com/pages/configuration/headers/)):

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin

/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable
```

I file serviti da R2 su un altro sottodominio devono rispondere con `Cross-Origin-Resource-Policy: cross-origin` e CORS abilitato per l'origine del sito, altrimenti COEP li blocca. Configurare la [CORS policy del bucket R2](https://developers.cloudflare.com/r2/buckets/cors/) e una Transform Rule per l'header CORP. Alternativa più semplice: servire R2 sullo stesso origin tramite una Pages Function che fa da proxy (costa invocazioni, ma elimina i problemi cross-origin).

**Pipeline di deploy**

1. `scripts/build_web.sh`: ricompila (se il DOL è cambiato), compila con Emscripten in Release, builda la UI con Vite, produce `dist/`.
2. `scripts/upload_assets.sh`: estrae, comprime e carica su R2 solo i file nuovi (content-addressed), rigenera `manifest.json`.
3. Deploy di `dist/` con [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`wrangler pages deploy dist`).
4. Tutto eseguibile dal Codespace. Niente GitHub Actions per la build del gioco: richiederebbe il DOL nei segreti CI. Actions va bene solo per lint e test che non toccano dati di gioco.

**Ambienti**: `preview` (deploy di branch Pages, stessa policy Access) e `production`. Mai test di rete su production.

## Test e validazione

Ogni fase si chiude solo con test automatici che passano, non con "sembra funzionare". Il determinismo si verifica con i checkpoint, la grafica con screenshot, la rete con match scriptati.

| Test | Cosa verifica | Strumento | Quando |
| --- | --- | --- | --- |
| Checkpoint simulazione | 2400 hash CPU/RAM/ARAM identici tra nativo e browser | `tools/validate_native.py` + `tools/compare_checkpoints.py` | Ogni PR |
| Unit test runtime | HLE, decoder texture, parser file | CTest (nativo) | Ogni PR |
| Smoke test browser | Boot fino al menu senza errori in console | [Playwright](https://playwright.dev/) con Chrome headless e flag WebGPU | Ogni PR |
| Screenshot di riferimento | 10 scene fisse confrontate con soglia di differenza | Playwright + confronto immagini | Fase 1 in poi |
| Match online locale | Due tab, bot di input, zero `DESYNC` | Adattare `tools/online_pair.py` a Playwright | Fase 3 in poi |
| Match cross-device | Desktop contro Android su reti reali | Manuale, log checksum | Prima di ogni release |
| Prestazioni | Tempo per frame medio, p95, p99 | Harness della Fase 0 riusato | Ogni release |
| Replay Slippi | Una replay `.slp` rigiocata identica | `tools/replay_compare.py` (build playback) | Opzionale, per debug desync |

Regola: nessun merge su `main` se i checkpoint divergono.

## Rischi e mitigazioni

I due rischi che possono uccidere il progetto sono le prestazioni su mobile e il determinismo tra x86 e ARM: entrambi si misurano entro la Fase 0 e l'inizio della Fase 3, prima di investire nel resto.

| Rischio | Probabilità | Impatto | Mitigazione |
| --- | --- | --- | --- |
| Simulazione troppo lenta su mobile | Media | Alto | Misurata in Fase 0; se fallisce, v1.0 solo desktop |
| Desync tra desktop e mobile (floating point, FMA, libm) | Media | Alto | Niente `-ffast-math`, emulazione esatta di `fmadd`, checksum per frame per trovare la prima divergenza |
| Codice generato troppo grande per il compilatore o il browser | Media | Medio | Spezzare funzioni nel ricompilatore, `-O2` sui file enormi, verificare limiti in Chrome e Safari |
| Renderer WebGPU più lungo del previsto | Alta | Medio | Studiare e riusare aurora; partire da un sottoinsieme TEV e ampliare |
| Hitch di compilazione pipeline | Alta | Medio | Pipeline async + fallback + prewarm dalle recipe salvate |
| WebGPU o thread assenti su iOS | Media | Medio | Dichiarare iOS fuori scope se necessario |
| NAT mobile che blocca il P2P | Alta | Medio | TURN Cloudflare sempre configurato |
| Upstream melee-unlocked cambia struttura | Media | Basso | Fork bloccato su un commit; merge di upstream solo a fine fase |
| Dati di gioco accessibili da estranei | Bassa | Alto | Access su sito e R2, repo privato, nessun asset nel repo |

## Regole di lavoro e tips per l'agente

L'agente lavora come senior engineer autonomo, ma ogni decisione architetturale va scritta prima di implementarla.

**Metodo**

1. Prima di ogni fase: leggere il codice coinvolto, scrivere un breve design doc in `docs/` (problema, opzioni, scelta, rischi), poi implementare.
2. Una cosa alla volta: mai cambiare renderer e rete nello stesso branch.
3. Ogni PR: descrizione con cosa è cambiato, come è stato verificato, numeri misurati.
4. Log di progresso in `docs/PROGRESS.md`, aggiornato a ogni sessione: stato, prossimo passo, problemi aperti. Serve anche a riprendere il lavoro in una sessione nuova.
5. A fine di ogni fase: fermarsi e riportare al proprietario con demo (link preview), numeri e decisioni aperte, prima di iniziare la fase successiva.

**Tips tecnici**

- Non ottimizzare prima di aver misurato: la Fase 0 dà i numeri veri.
- Mantenere la build nativa funzionante per tutto il progetto: è lo strumento di debug più veloce (gdb, sanitizer, profiler) e il riferimento per i checkpoint.
- Per debug WASM in Chrome: build con `-g` e l'estensione [C/C++ DevTools Support (DWARF)](https://developer.chrome.com/docs/devtools/wasm).
- Per il profiling: pannello Performance di Chrome e `emscripten_get_now()` attorno a simulazione, rendering e audio.
- Mai `emscripten_sleep` o Asyncify nel percorso della simulazione: introduce non determinismo e costi. Usare thread e code.
- Non introdurre dipendenze pesanti nella UI: TypeScript + Vite bastano.
- Qualsiasi dubbio su licenze o sulla gestione dei file di gioco: chiedere, non assumere.

**Cosa non fare**

- Non committare mai ISO, DOL, codice generato o file estratti.
- Non modificare la logica del netcode Slippi o del ricompilatore per "aggiustare" un desync senza aver trovato la causa con i checkpoint.
- Non implementare fallback WebGL2 o modalità a 4 giocatori free-for-all nella v1.0.
- Non usare servizi che richiedono un server da gestire.

## Fonti e risorse

**Codice di partenza**

- [Hero88go/melee-unlocked](https://github.com/Hero88go/melee-unlocked) e il suo [PORT\_COMPLETION.md](https://github.com/Hero88go/melee-unlocked/blob/main/PORT_COMPLETION.md)
- [999sian/melee-pc](https://github.com/999sian/melee-pc)
- [encounter/aurora](https://github.com/encounter/aurora)
- [encounter/nod](https://github.com/encounter/nod)
- [doldecomp/melee](https://github.com/doldecomp/melee)
- [project-slippi/Ishiiruka](https://github.com/project-slippi/Ishiiruka)

**Emscripten e WebGPU**

- [Emscripten: WebGPU support](https://emscripten.org/docs/porting/multimedia_and_graphics/WebGPU-support.html)
- [Emdawnwebgpu README](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/emdawnwebgpu/pkg/README.md)
- [PR deprecazione -sUSE\_WEBGPU](https://github.com/emscripten-core/emscripten/pull/24220)
- [webgpu-cross-platform-demo](https://github.com/kainino0x/webgpu-cross-platform-demo)
- [Emscripten: pthreads](https://emscripten.org/docs/porting/pthreads.html)
- [Emscripten: Wasm Audio Worklets](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html)
- [Chrome DevTools: debug WASM](https://developer.chrome.com/docs/devtools/wasm)
- [caniuse: WebGPU](https://caniuse.com/webgpu)

**API del browser**

- [COOP/COEP (web.dev)](https://web.dev/articles/coop-coep)
- [AudioWorklet (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
- [Gamepad API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API)
- [OPFS (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [RTCDataChannel (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel)
- [Screen Wake Lock (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
- [WebUSB (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API)

**Servizi**

- [Cloudflare Pages](https://developers.cloudflare.com/pages/), [header](https://developers.cloudflare.com/pages/configuration/headers/), [Functions](https://developers.cloudflare.com/pages/functions/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/), [CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/) e [FAQ prezzi](https://developers.cloudflare.com/realtime/turn/faq/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Supabase Realtime](https://supabase.com/docs/guides/realtime), [Broadcast](https://supabase.com/docs/guides/realtime/broadcast), [Presence](https://supabase.com/docs/guides/realtime/presence), [Anonymous sign-in](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Playwright](https://playwright.dev/)
