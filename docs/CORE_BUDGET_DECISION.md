# Budget del core: decisione prima del prossimo taglio

Analisi del 2026-10-03, base `029f41d789216547d393a6a12498dadf7b3903f1`, branch `perf/core-budget`. Il worktree richiesto era già presente, pulito e coincidente con `origin/main`: riutilizzato senza reset. Nessuna modifica a codice, patch o renderer; nessuna nuova esecuzione del gioco o banco Node. I calcoli sotto sono letture dei JSON/CSV, non benchmark sul VPS.

## 1. Dove va il tempo, e dove ancora non sappiamo

**La prima decisione è localizzare il residuo di 16–24 ms fra i due timer prima di scegliere una riscrittura del core.** È maggiore del costo misurato di tutta la consegna del frame al backend. Esiste un candidato concreto per il primo taglio del renderer (preparare lo stato una volta per DrawCall anziché per segmento), ma nessun dato disponibile dimostra che basti per 60 Hz. Il rapporto non consente una promessa quantitativa di 60 fps con quattro giocatori.

### Fonti e metodo

Report privati nella directory `/home/hermes/.hermes/cache/documents/`, non copiati nel repo:

| Etichetta | Nome del file | Core dichiarato | Split | Frame in partita |
| --- | --- | --- | --- | ---: |
| A | `doc_7feff7a61d67_play-report-2026-10-03T08-37-18.573Z.json` | `612a8561ba179b8c90478c7a59e3b8aeffda690a` | no | 741 |
| B | `doc_ab8e80cd138d_play-report-2026-10-03T08-40-37.857Z.json` | stesso di A | sì | 1031 |
| C | `doc_f30f1f469f5b_play-report-2026-10-03T09-24-58.620Z.json` | `b5b33854703240bb7387226f43f6d1ae1a850b78` | no | 844 |

Tutti dichiarano `-Oz`, isolamento attivo, risoluzione 0,02 ms, Safari 27.0 / iPhone OS 18_7; `errors` e `notes` vuoti. `core_opt` non significa che ogni translation unit sia a `-Oz`: le unità calde hanno override. Il report non identifica il commit della shell né certifica una scena a quattro giocatori. A/B/C sono sessioni diverse, non un esperimento A/B controllato; C include la correzione alpha/blending. Nessun rapporto di velocità fra sessioni va attribuito automaticamente al codice o allo split.

Metodo riproducibile: leggere `frames_csv` con `csv.DictReader`, filtrare `match_frame > 0` (e `hidden == 0`, tutti i frame selezionati risultano visibili), media aritmetica per colonna. Associare `sim_times_csv` e `decoder_cost.csv` tramite **retrace**, non posizione. Per B filtrare nello stesso modo il CSV in `decoder_cost.csv` (campo `csv` dell'oggetto `decoder_cost`); media delle colonne, p95 nearest-rank `ceil(0,95*n)`. I tempi medi sotto sono arrotondati a tre decimali; percentili di fasi diverse non si sommano. Le percentuali dei riepiloghi hanno denominatore **cycle**, anche quelle dello split.

SHA-256 dei file originali, nell'ordine A/B/C:

- `c0ff16456c827a5d407f3d30cc688070b1fba80e0aaedff4e26d0d141359f905`
- `b3b35a24d1149bc61754cb61c9028a2fbcc5bfead8ef2e3f19697b3703c2203e`
- `3768e63ae9b5fa0d1179808a587065d3cc73ab9e34bd65d7c23b521dd6ef6693`

### Il conto esterno completo (misurato, ms/frame in partita)

| Grandezza | A | B | C |
| --- | ---: | ---: | ---: |
| Ciclo | 73,790 | 87,389 | 48,123 |
| FPS (`1000 / ciclo`) | 13,6 | 11,4 | 20,8 |
| `core_ms`, inclusi disco e API | 69,484 | 83,995 | 45,035 |
| API WebGPU intercettate | 3,762 | 3,540 | 2,099 |
| Disco, incluso nel core | 8,483 | 8,903 | 4,900 |
| Core meno API e disco (residuo, non una funzione) | 57,238 | 71,552 | 38,035 |
| Bitmap | 3,893 | 3,080 | 2,350 |
| Ack | 0,408 | 0,307 | 0,735 |
| Idle | 0,006 | 0,006 | 0,003 |
| p95 ciclo | 96,100 | 116,100 | 67,220 |
| p99 ciclo | 199,040 | 167,920 | 219,420 |
| Chiamate API/frame | 1892,387 | 1930,282 | 2335,618 |
| Draw/frame | 1559,363 | 1590,128 | 1936,363 |

L'identità è `cycle = core + bitmap + ack + idle`; disco e API **non** si aggiungono di nuovo al core. Le percentuali esatte in partita del residuo core sono 77,6 / 81,9 / 79,0%; API 5,1 / 4,1 / 4,4%; disco 11,5 / 10,2 / 10,2%; bitmap 5,3 / 3,5 / 4,9%; ack 0,6 / 0,4 / 1,5%. Gli estremi 73,8%, 8,8% bitmap e 2,4% ack citati nel mandato provengono da `summary.all` di C, non da `in_match`. Questo non cambia la diagnosi del collo di bottiglia, ma evita di mescolare menu e partita.

Idle arrotondato a 0% significa che il pacing esplicito non ha margine. Non dimostra l'assenza di attese dentro altre fasi, IPC, garbage collection o descheduling.

### La scomposizione interna di B, per funzione o insieme di funzioni

Fonti: [host offline](../native/headless_host.cpp), funzioni `record_sim_time`, `record_decoder_cost`, `retrace`; [patch timer](../patches/0008-offline-decoder-cost.patch), [patch split](../patches/0009-offline-frame-split.patch); [decoder GX](../upstream/melee-unlocked/port/runtime/gx/gx_core.cpp); [backend WebGPU](../wasm/render/gx_webgpu.cpp). Il submodule è il pin `3aab7172db243c159afa76ecb2c564b3de8e4c0a`; le patch si leggono insieme al sorgente upstream, non sono state applicate nel worktree.

| Campo esclusivo B | Media ms | p95 ms | Che cosa copre realmente |
| --- | ---: | ---: | --- |
| `record_ms` | 1,575 | 2,600 | `record_draw`, esclusi snapshot texture e observer: copie stato, matrici, identità, segmenti e inserimento draw |
| `texture_ms` | 1,117 | 1,800 | `snapshot_textures` e cache di snapshot immutabili; **non** conversione RGBA nel backend |
| `observer_ms` | 0,225 | 0,380 | blocco `SIM_OBSERVE` di `record_draw`, identità/proprietario/pose |
| `end_frame_ms` | 14,648 | 27,920 | blocco XFB in `handle_bp`: metadati, `submit_and_recycle` → `WebGpuBackend::submit_frame`, cleanup/cache |
| `decode_rest_ms` | 11,299 | 16,740 | resto di `drain_fifo`: parsing, `run_display_list`, `decode_vertices`, registri e gestione FIFO dentro lo scope; non separabili ulteriormente |
| `observer_game_ms` | 0,358 | 0,560 | costruttore/distruttore `RenderObserver`, esclusa esecuzione guest fra i due |
| `non_decode_rest_ms` | 30,895 | 35,020 | guest, host/HLE, disco, append FIFO prima dello scope, controlli RAM, overhead non attribuito; non un timer del renderer |
| **Somma = `sim_ms`** | **60,118** | — | intervallo interno, diverso da `core_ms` |

`decode_ms = 28,865 = record + texture + observer + end_frame + decode_rest`.
`non_decode_ms = 31,253 = observer_game + non_decode_rest`.
Il 33,0% e il 35,8% sono quote del ciclo da 87,389 ms, non quote che completano una partizione dell'intero core.

**Correzione sostanziale:** `submit_frame`, `draw_segment`, `upload_textures`, `gxw_draw`, `gxw_bind`, `gxw_copy` e `gpu.flush` girano sincronicamente dentro `end_frame_ms`, dunque dentro **decode**. Il “non decode” può comprendere il codice guest che prepara grafica/FIFO e il costo host dei relativi store; non si può identificare con il backend C++/JS. Sottrarre 3 ms e chiamare tutto il resto “renderer” non è un'attribuzione per funzione.

Il precedente ~3 ms è un riferimento headless, con decoder legacy, altra scena/configurazione: [misura del dispositivo](DEVICE_TEST_IPHONE16PRO.md). [PROGRESS](PROGRESS.md), voce «the decoder cost measured», registra poi **4,35 ms senza canvas/backend** sul decoder reale ottimizzato (`d624d06`). Questi riferimenti dimostrano che la sola simulazione non spiega i tempi attuali, ma non misurano la simulazione esclusiva durante queste partite e non certificano quattro giocatori.

### Il buco fra i due intervalli: 16–24 ms

| Media per retrace in partita | A | B | C |
| --- | ---: | ---: | ---: |
| `sim_ms` interno | 45,533 | 60,118 | 29,043 |
| `core_ms - sim_ms` | **23,950** | **23,877** | **15,991** |
| Stesso residuo, soltanto righe con `disc_ms == 0` | 23,978 (711 righe) | 24,273 (981) | 15,988 (809) |

È un **residuo misurato fra confini**, non una misura di una funzione né un risparmio già acquisibile. In B le sette fasi spiegano 60,118 degli 83,995 ms del core: mancano 23,877 ms, il 27,3% del ciclo. Restano anche senza letture disco; non li assegniamo al problema disco già in lavorazione.

Confini nel codice: `record_sim_time()` legge il clock **prima** di scrivere/flushare CSV; `g_sim_resume` riparte **dopo** il ritorno di `retrace_heartbeat`. `FrameMeter.cycleEnd()` invece fa partire il core seguente prima di finire contabilità, eventuale `flush()`/`postMessage` e ritorno dell'heartbeat; il `coreEnd()` seguente arriva dopo lettura dei CSV e heartbeat. Quindi il residuo contiene contabilità, esportazione/lettura CSV e codice attorno alla callback, oltre ad eventuali pause del runtime in quegli intervalli. `trace_state`/`digest_state` tornano subito senza file e la pagina non passa `--state-trace`: non c'è prova di hashing RAM in live play.

Non è dimostrato quale di questi pezzi costi 16–24 ms. Il valore vicino a un refresh in C **non prova** un'attesa vsync. Proposta: misurare separatamente coda `cycleEnd`→ritorno callback, scrittura CSV, ingresso heartbeat→lettura CSV→`coreEnd`; riconciliare i clock sullo stesso retrace. Nessuna correzione fatta qui.

### WebGPU: misura CPU parziale, non tempo GPU

| Metodo intercettato, ms/frame | A | B | C |
| --- | ---: | ---: | ---: |
| `pass.drawIndexed` | 2,666 | 2,572 | 1,484 |
| `pass.setBindGroup` | 0,627 | 0,541 | 0,373 |
| `pass.setPipeline` | 0,083 | 0,077 | 0,038 |
| `device.createBindGroup` | 0,041 | 0,034 | 0,022 |

Calcolo: `webgpu_methods.in_match[metodo].ms / frames`. In B il residuo `end_frame - webgpu = 11,109 ms` comprende preparazione C++/JS, cleanup e API eventualmente non catturate, non soltanto `gxw_draw`.

**Anomalia da risolvere:** tutti i report hanno `queue_ms = 0` e **nessuna voce/chiamata** `queue.writeBuffer`, `queue.writeTexture`, `queue.submit`, benché `gpu.flush` debba scrivere e sottomettere. È più di un tempo arrotondato a zero: manca il conteggio. [instrumentGpu](../web/src/play/frame-meter.ts) modifica l'oggetto `device.queue` ottenuto una volta; il backend lo rilegge. L'aggancio effettivo va verificato sul telefono con un invio noto e contatori attesi, senza assumere la causa dell'assenza. Perciò 2,099–3,762 ms sono le API **osservate**, non una prova che tutte le chiamate costino così poco. Nessun timestamp GPU è presente. Bitmap può incorporare sincronizzazione: non si può assolvere quantitativamente la GPU dal solo 4–5%.

Il banco Node del progetto non collega `gx_webgpu.cpp` ([CMake](../wasm/core/CMakeLists.txt)). Un eventuale banco con API finte può misurare preparazione/allocazioni e verificare sequenze, ma non una chiamata WebGPU reale, IPC, GPU, GC/ottimizzazioni di Safari. Nessun risultato Node viene moltiplicato per ricavarne millisecondi iPhone.

## 2. Tagli ordinati per risparmio rispetto al rischio

**Convenzione sulle stime:** non esiste ancora una misura prima/dopo di questi interventi. Gli intervalli con zero sono limiti di opportunità; gli scenari percentuali sono obiettivi sperimentali, non intervalli statistici o promesse. Non sommare le righe: diverse agiscono nello stesso contenitore. Tutte le proposte richiedono il gate di §4.

| Ordine | Intervento proposto | Risparmio in ms/frame e prova | Rischio e verifica specifica |
| --- | --- | --- | --- |
| 1 | Ridurre il lavoro diagnostico fuori da `sim_ms`, **dopo aver localizzato il residuo**; valutare contatori binari anziché CSV/stringhe per retrace e invio periodico | **0–15,991 (C), 0–23,877 (B)** come tetti, non guadagno atteso. Eliminare metà del residuo varrebbe 8,0 / 11,9 ms; nessuna prova che metà sia eliminabile. Prova: join per retrace e confini sopra, residuo persistente con disco zero | Basso sullo stato guest se solo telemetria, medio su diagnosi/backpressure. Non spostare lettura input, ACK o pacing. Confrontare contatori/retrace, report, gestione errori e perdita device; cronometro esterno sempre acceso per evitare un falso guadagno ottenuto solo spostando il timer |
| 2 | Preparazione per **DrawCall**, riuso per segmenti: costanti/raster, scelta texture, lookup gruppo/pipeline; arena indici riusabile. Prima modifica renderer da provare | In B 1590,217 `record_calls` contro 558,495 snapshot/observer: circa **2,85 segmenti per draw catturato**. Passare da preparazione per segmento a per draw evita teoricamente il 64,9% di quella preparazione. Se essa occupasse metà degli 11,109 ms residui di end-frame: **3,60 ms**; se tutto: **7,21 ms** (limite condizionale). Stima accreditabile oggi: **0–7,21 ms**, non misurata; costo per funzione mancante | Basso-medio: invariato ordine draw/copy, texture e matrici. Devono restare corretti overflow arene, eviction/pinning fra batch, offset uniformi, reset pass. Confrontare flusso comandi e immagini, primitive strip/fan/quads/linee, alpha/depth/TEV. Coordinare dopo il lavoro TEV, nessuna modifica qui al file condiviso |
| 3 | Compilare **solo `gx_webgpu.cpp` a `-O2`**, verificando comando reale, dimensione e traccia | È fuori da `MELEE_HOT_SOURCES`; eredita `-Oz`. Opportunità **0–11,109 ms** sul residuo end-frame B, tetto molto largo perché gran parte è JS/cleanup. Scenario: metà del residuo C++ e accelerazione 2× → **2,78 ms**. Non c'è un benchmark che stabilisca queste due ipotesi. Il precedente 12,51→4,35 ms con GX a O2 + timer off è una motivazione, non una stima trasferibile | Basso semantico con `-ffp-contract=off`, `-fno-fast-math`; rischio dimensione/compilazione. CI con assert compile-command, byte WASM, test backend reale e gate. Non ottimizza il JS scritto negli `EM_JS` |
| 4 | Specializzare decoder per VAT/descrittore e ridurre parsing/ingresso FIFO ripetuto mantenendo le stesse frontiere osservabili | Contenitore `decode_rest` B **11,299 ms**, 27433,860 scope decode/frame. Dimezzare il contenitore darebbe **5,650 ms**, tetto eliminazione **11,299**. Quota effettiva di `decode_vertices` sconosciuta: guadagno sostenibile **0–11,299**, da restringere con timer aggregati | Medio-alto: indirizzi/stride, endian, formati e RAM che cambia; ritardare FIFO può cambiare PE token/finish e interrupt. Fixture sintetiche byte-identiche di Vertex/DrawCall/Copy, display list annidate, scritture parziali e checkpoint. Non cache di vertici per solo puntatore |
| 5 | Fondere segmenti **consecutivi dello stesso stato** in un unico draw indexed preservando ordine e topologia | In B, passare idealmente da 1590,128 draw a ~558,495 taglia il 64,9%: **1,67 ms** dei 2,572 ms osservati in `drawIndexed`. Stima API **0–1,67 ms**; extra preparazione sovrapposto al punto 2, non additivo. Non è garantito che tutti i segmenti siano fondibili | Medio: triangolare ogni strip/fan separatamente, non connettere primitive, stesso raster/depth/blend/uniformi/texture; rispettare Copy/clear e limiti batch. Confrontare indici e rasterizzazione, inclusi trasparenti; mai ordinare globalmente per materiale |
| 6 | Ridurre snapshot/copie draw e observer se rimane un costo rilevante dopo i precedenti | Tetti esclusivi B: record **1,575**, snapshot **1,117**, observer draw+game **0,583 ms**. Dimezzarli tutti vale **1,638 ms**; eliminazione totale 3,276 ms è irrealistica. Non esiste prova di guadagno dei watch RAM: 14237,887 hit su ~82 blocchi/frame sono conteggi, non tempo | Medio-alto: invalidazione texture/ownership e lettori dei metadata. Conservare snapshot immutabili, palette/mip e versioni; confrontare dati catturati. Eliminare gli observer globalmente non è sicuro: lettori documentati in `PORT_CHANGES.md` §0009 |

Il punto 1 è primo per **valore informativo e basso rischio**, non perché sia già dimostrato un taglio da 24 ms. Fra i tagli implementativi al renderer, il punto 2 ha la prova strutturale più concreta. Il punto 3 è un esperimento piccolo e reversibile; non lo considero un moltiplicatore già acquisito.

## 3. Tagli apparentemente ovvi che non risolvono il conto

- **«Ridurre le ~2000 chiamate basta».** In C tutte le API osservate costano 2,099 ms; eliminarle magicamente lascia 46,024 ms/ciclo (~21,7 fps). In B eliminare l'intero `end_frame` da 14,648 lascia 72,740 ms (~13,7 fps). Il batching aiuta, ma deve togliere preparazione CPU oltre alle chiamate e non spiega il residuo esterno. Resta da misurare la queue mancante.
- **«Creare cache/una sola submit».** Sono già presenti: texture per snapshot immutabile, sampler, pipeline, bind group, arene persistenti, dedup stato e uniformi; submit per XFB/overflow. In partita solo ~2,1 nuove risorse/frame e 1–3 pipeline nell'intera sessione. Allargare indiscriminatamente le cache consuma memoria senza un miss-rate che lo giustifichi. `upload_textures` può ancora fare molto lavoro sui cache hit: questa è la leva del punto 2.
- **«Ottimizzare tutti i 28,865 ms di decodifica vertici».** Quasi metà è `end_frame`; `decode_vertices` non ha un timer esclusivo. Anche la conversione `decode_texture` del backend sta in end-frame, non nel campo `texture_ms`.
- **«Il non decode meno 3 ms è JS renderer».** Contraddetto dall'albero di chiamate. B senza righe disco ha ancora 22,678 ms di non decode, ma sono guest/host/FIFO e overhead misti. Non scegliere un rewrite JS sulla base di questo numero.
- **«Il profiler costa esattamente B−A».** Non sono replay identici. Il meter API stima solo le due letture del clock (~0,185–0,220 ms/frame in partita), non wrapper, CSV, heartbeat o GC. I timer interni fanno decine di migliaia di letture: il precedente ~3,4 ms era un altro esperimento. Non sottrarli come costante da B. Profiling off è già il normale modo A/C, non un nuovo guadagno di prodotto.
- **«Basta O2 ovunque/SIMD/fast math».** GX core/texture/observer sono già a O2; `wasm-opt` è già stato adottato. O1 globale misurato produceva ~85,7 MB, oltre il limite di pubblicazione del progetto, con un modesto vantaggio Node ([esperimento](OPT_LEVEL_EXPERIMENT.md)). SIMD non ha un guadagno Safari misurato qui; fast math/FMA implicita non rispettano il vincolo di determinismo. Non toccare guest generato o rounding per guadagnare una percentuale.
- **«Togliere RAM watches o usare solo l'indirizzo della texture».** Può mostrare texture vecchie e rompere snapshot/ownership. Contatori di hit non sono una misura di costo. Il gate CPU non copre da solo la correttezza delle immagini.
- **«Saltare draw/frame, ridurre shader o risoluzione».** Non ci sono tempi GPU che motivino la priorità; saltare rendering non soddisfa 60 frame corretti. Rimuovere FIFO/BP può anche cambiare eventi PE e checkpoint. Non semplificare TEV per ottenere una misura favorevole: il lavoro parallelo sta correggendo proprio la resa.
- **«Thread o HLE GX risolvono per costruzione».** Modificano ordinamento, vita delle snapshot, backpressure e potenzialmente timing guest. Nessuna stima in ms ricavabile dai report; non sono il primo esperimento a basso rischio.

## 4. Raccomandazione e budget da chiudere

**Prima una proposta di misura mirata al residuo e alla queue; poi, se il residuo è lavoro diagnostico evitabile, tagliare quello. Primo taglio del renderer: riuso dello stato per DrawCall (punto 2).** Nessuna di queste modifiche è stata eseguita. Ci aspettiamo dalla misura un'attribuzione dei 15,991–23,877 ms; oggi il guadagno garantito è **zero**. L'obiettivo sperimentale del riuso è ~**3,6 ms in B**, condizionato alla quota del 50% spiegata sopra; successo solo se il telefono lo conferma anche senza profiler e senza regressioni.

Il conto per 60 Hz deve includere il resto della pagina. Assumendo per il solo budget disco risolto e conservando bitmap+ack medi attuali:

| Budget, ms/frame | A | B | C |
| --- | ---: | ---: | ---: |
| Core disponibile su 16,667 ms | 12,366 | 13,279 | 13,581 |
| Core attuale meno disco | 61,000 | 75,092 | 40,135 |
| Riduzione ancora necessaria | **48,634** | **61,813** | **26,554** |
| Accelerazione core senza disco richiesta | 4,93× | 5,66× | 2,96× |
| Spazio per CPU grafica + residui, ipotizzando 3 ms sim e API attuali | 5,604 | 6,739 | 8,482 |

45–84 ms divisi direttamente per 16,7 fanno 2,7–5,0×, **non 5–8×**. Un target di 5–8× può essere un margine progettuale per il sottobudget renderer e quattro giocatori, ma non è un rapporto misurato dai tre report. La necessità di un taglio multiplo resta reale; il fattore va dichiarato con il denominatore. I budget sopra sono ottimistici: media, disco azzerato, ~3 ms trasferiti dal vecchio headless e queue non chiarita; nessun margine per rollback e crescita del carico a quattro giocatori.

Anche uno scenario aggressivo su B — togliere tutto il residuo 23,877 ms, metà end-frame 7,324 ms, metà decode-rest 5,650 ms e tutto il disco 8,903 ms — lascia **41,635 ms/ciclo (~24 fps)**. È una prova aritmetica del fatto che quei tre interventi non bastano, non una previsione di risultato. Serve anche attribuire e ridurre il lavoro non decode della partita reale; ad oggi non sappiamo quanto sia riducibile mantenendo la traccia.

### Gate per qualunque futura implementazione

1. Build e test esclusivamente in GitHub Actions. Nessun DOL, ISO, C++ generato, dump RAM o stream grafico derivato dal gioco nel repo. `scripts/check_no_game_data.py --all` deve passare in CI; usare fixture sintetiche per test versionati e artefatti privati per il replay dell'operatore.
2. Confronto **tutti i 2400 checkpoint** con SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`, usando `scripts/phase0/compare_checkpoints.py`; stessa scena finale `mode=2 state=2 match_frame=762`. Qualunque divergenza boccia la modifica. Anche la proposta di strumentazione passa dal gate; non rilassarlo e non modificare gli input del riferimento.
3. Il gate simulazione è necessario ma insufficiente: il Node ordinario non esegue il backend web. Verificare il percorso web con rendering attivo, confronto comandi/immagini e fixture per alpha/depth/TEV, texture mutate/palette/mip, confini primitive, Copy/clear e overflow arene. Allineare la baseline alla correzione TEV quando pronta; non congelare come corretto un bug visivo esistente.
4. Sul **telefono dell'utente**, replay/input e scena identici, stesso core/shell dichiarati, temperatura comparabile, almeno tre coppie alternate baseline/candidato. Split acceso solo per attribuzione, spento per il verdetto. Riportare numero di giocatori, stage, durata, frame esclusi, medie/p95/p99/max di ciclo e core, residuo, API/queue, disco e conteggi; scene a quattro giocatori esplicite, effetti/trasparenze e camera ampia. I report attuali non bastano a quel verdetto.
5. Mantenere un timer esterno invariato: una riduzione di `core_ms` ottenuta spostandone i confini senza ridurre il ciclo non è un guadagno. Per dichiarare 60 Hz verificare budget 16,667 ms e frequenza dei frame che lo superano nelle scene concordate, non solo media favorevole o banco sintetico.

Esito della decisione: **nessuna evidenza sufficiente per promettere 60 fps/4 giocatori; evidenza sufficiente per respingere “bastano meno chiamate WebGPU” e per dare priorità al residuo fuori profiler, seguito dal lavoro duplicato per segmento.** Nessun costo Monid: non usato.
