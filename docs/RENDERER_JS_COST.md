# Il JavaScript del renderer per draw: dove vanno i ~9 µs, misurato su V8

2026-10-05, ramo `perf/renderer-js`, base `e80a221`. Misura, nessuna ottimizzazione in questo
passo: il core e `wasm/render/` non cambiano.

## 1. La divisione di `gxw_draw` (consegna 1)

**Come.** Lo stesso profilo a campionamento di PR #119 (V8, modulo web vero con i nomi, renderer
attaccato a un WebGPU finto, finestra sui retrace di partita 1639–2400, 762 fotogrammi), con una sola
differenza: nella copia del core che il banco carica, il corpo di `gxw_draw` è riscritto **una
istruzione per riga** (un a-capo dopo ogni `;` e `{`: solo spazi, stessi token). I `positionTicks`
di V8 danno allora i campioni *self* per istruzione. Il banco non è nel repository (esegue il core
privato): `~/incoming/phase0/renderjs/lines.mjs`; l'analisi sì: `scripts/analysis/cpuprofile_draw_lines.py`.

**Quanti draw.** In partita sono **1872 draw per fotogramma** (beat `-1` del renderer, contati), non
~1650: il corpo JS di `gxw_draw` è il **22,6%** dei campioni = **7,2 µs per draw** sull'orologio
profilato (il profiler aggiunge il 15–20%: le quote valgono, i µs vanno scalati).

| parte di `gxw_draw` (self) | % fotogramma | % del JS del draw | µs/draw (profilato) |
| --- | ---: | ---: | ---: |
| **confronto delle costanti uniform** con il draw precedente (`words[at+i] === HEAPU32[base+i]`) | **9,38** | **41,5** | **2,99** |
| **chiave stringa del bind group** (`slots.map(…).join(",")`) + LRU su `Map` | **5,85** | **25,9** | **1,86** |
| **chiave stringa della pipeline** (`[…].join(":")`) + `Map.get` | **2,95** | **13,1** | **0,94** |
| copia di vertici e indici negli staging (`TypedArray.set`) | 2,73 | 12,1 | 0,87 |
| registri raster (`HEAPF32.slice`) + stringa dello scissor | 0,77 | 3,4 | 0,25 |
| controlli di stato del pass + chiamate WebGPU (finte) | 0,26 | 1,2 | 0,08 |
| copia delle costanti uniform (solo quando cambiano) | 0,20 | 0,9 | 0,06 |
| registri BP, controllo delle arene, resto | 0,40 | 1,8 | 0,13 |

**Il dedup delle uniform** (conteggio a parte, stessa finestra, 1.426.241 draw): le costanti sono
125 righe (2000 byte) nel 71% dei draw; sono **identiche al draw precedente nell'86,8%** dei casi, e
per accorgersene il JS confronta in media **488 parole a draw**, una per una. Il confronto costa
~50× la copia che evita (2,99 contro 0,06 µs): lo scopo del dedup — non riscrivere 2 KB per draw
nell'arena uniform da 2 MiB, e non mandarli al processo GPU — resta giusto; è il modo di confrontare
che costa.

**Cosa è riducibile** (tutto JS puro: **sul telefono costa comunque**, a differenza delle chiamate
WebGPU):

- *confronto uniform, 41%*: lo stesso esito (stesso offset, stessi byte, stesse chiamate) senza il
  ciclo JS — p.es. il C++ confronta con `memcmp` contro le costanti dell'ultima chiamata e lo dice
  a `gxw_draw`, che salta il ciclo; o un ciclo JS su viste più larghe;
- *chiavi stringa, 39%*: la chiave del bind group cambia solo quando `gxw_bind` cambia uno slot, ma
  è ricostruita (8 concatenazioni + `join`) a ogni draw; la chiave della pipeline è fatta di 5 campi
  piccoli e un id intero, e può essere un numero;
- *raster, 3%*: `HEAPF32.slice` alloca un array per draw; bastano letture dirette.
- *la copia di vertici e indici (12%) non è riducibile in JS*: sono i byte che il draw deve dare alla
  GPU, già con la copia nativa.

Sono ipotesi attribuite, non ancora guadagni: vanno prototipate e misurate nel modulo (A/B
alternati, `sim_ms` in partita), con traccia dei 2400 checkpoint identica a `c79c53b9…` **e** oracolo
grafico verde.

## 2. Il resto del renderer: JS, C++, e una correzione alla tabella di PR #119

**Correzione.** Lo split di PR #119 (`cpuprofile_split.py`) assegna la zona guardando i nomi della
pila, e la regex della zona FIFO (`\bgx::`) colpisce anche i **tipi degli argomenti**:
`(anonymous namespace)::draw_segment(gx::Frame const&, gx::DrawCall const&, …)` — C++ del renderer —
finisce in "decodifica FIFO GX", e con lui tutto ciò che chiama (`memcmp`, `vector::insert`,
malloc/free). Sullo stesso profilo (questo ramo, 762 fotogrammi), contando invece ogni campione che
ha `submit_and_recycle` nella pila:

| zona (renderer attaccato) | split di #119 | per pila (`submit_and_recycle`) |
| --- | ---: | ---: |
| renderer | 30,45% | **40,53%** (di cui 2,93% wrapper del banco, non in produzione) |
| decodifica FIFO GX | 28,19% | **18,13%** |

Lo spostamento è **10,06% del fotogramma**, tutto C++ del renderer. Il renderer in produzione è
quindi **~37,6%** del fotogramma attaccato, e la decodifica FIFO **~18%**, non 28%.

**Composizione del renderer** (% del fotogramma, per foglia, campioni con `submit_and_recycle` in pila):

| parte | % fotogramma | µs/draw (profilato) |
| --- | ---: | ---: |
| JS `gxw_draw` (sezione 1) | 22,58 | 7,19 |
| JS `gxw_bind` (8 chiamate per draw) | 2,58 | 0,82 |
| JS `gxw_evicted`, `gxw_copy`, flush | 0,10 | 0,03 |
| passaggio wasm→JS (`wasm-to-js`, ~10 chiamate per draw) | 1,31 | 0,42 |
| C++ `draw_segment` (costruzione delle 106 righe di costanti, TEV, raster) | 4,55 | 1,45 |
| C++ `memcmp` (confronto della `ShaderUid`, 76 parole, nella ricerca dello shader) | 1,78 | 0,57 |
| C++ `vector` degli indici per segmento + malloc/free | ~2,1 | ~0,67 |
| C++ hash della `ShaderUid`, mappa dei contenuti texture, riciclo del frame, altro | ~2,1 | ~0,67 |
| wrapper `gxw_draw` del banco (non in produzione) | 2,93 | — |

JS ~25,3%, C++ ~10,5%, confine ~1,3%. La scrittura dei buffer verso WebGPU (`writeBuffer`, 3 per
batch) non si vede: è nel finto. La preparazione per draw che costa è quella in JS.

## 3. La produzione: il frame meter costa ~3–7% del fotogramma; la validazione non c'è

**La validazione di contenuto non gira in produzione.** `VALIDATE=1` (hash dei byte di ogni draw,
esecuzione dei draw nel finto) è codice del banco (`bench2/3.mjs`), non del modulo: nel corpo di
`gxw_draw` non c'è alcun controllo di contenuto, solo il dedup delle uniform (sezione 1), che è
lavoro utile. Nessuno spreco da togliere lì.

**Ma in produzione c'è JS per draw che il banco non ha.** La pagina play (`web/src/play/worker.ts`)
monta prima della partita:

- `instrumentGpu` (`frame-meter.ts`): **ogni** chiamata WebGPU passa per `metered` →
  `meter.enter` (`performance.now()`, due scritture nel registratore di volo in memoria condivisa) →
  la chiamata → `meter.leave` (`performance.now()`, quattro aggiornamenti di array);
- il beat `-1` di ogni draw: `heartbeatSender` legge `performance.now()`, poi `meter.draw()` scrive
  in memoria condivisa;
- `countResources` (`gpu-resources.ts`) sulle `create*` (rare per draw: solo i bind group mancati).

Misura: lo stesso banco con **i sorgenti veri** di questi tre montati sul device finto (`PROD=1`,
`node --experimental-transform-types`; il meter conta 2.021.706 `pass.drawIndexed`, 479.020
`setBindGroup`, 184.701 `setPipeline`: scatta su tutto). Per draw: ~1,35 chiamate misurate, ~3,7
letture di clock.

| | % fotogramma |
| --- | ---: |
| `performance.now` | 1,60 |
| closure anonime (`() => performance.now()`, il sender) | ~0,66 |
| `metered` | 0,52 |
| `get`, `prod.beat`, `meterMethod`, `meter.draw`, `heartbeat` | ~0,4 |
| **attribuito direttamente** | **~3,2** (~1 µs/draw, orologio profilato) |

Il profilo con `PROD=1` ha il 6,3% di campioni in più di quello senza, e l'A/B senza profilo (3
coppie alternate, `sim_ms` medio in partita) dà **+6,6 / +1,5 / +3,8 ms**, tutte a sfavore: +3,9 ms
in media, ~7%, con il rumore della VPS (~10%). Il prezzo vero sta tra il 3% attribuito e il 7% della
differenza (il resto plausibilmente è JIT: `metered` è una sola funzione per tutti i metodi, e il
suo `call.apply` vede decine di bersagli).

Riducibile, ma è una scelta dell'operatore: quelle letture sono **l'unico strumento che misura il
costo delle chiamate WebGPU sul telefono** (colonne `webgpu` del report, sezione 4). Opzioni: il
meter per chiamata solo su richiesta (come `split`), oppure contare sempre ma cronometrare una
chiamata ogni N dei metodi caldi del pass (`drawIndexed`, `setBindGroup`, `setPipeline`). Il report
riporta già il costo del clock del dispositivo (`clockCostNs`): sul telefono il prezzo per lettura può
essere diverso da quello di V8 qui.

Resto del JS per draw, fuori da `gxw_draw`: `gxw_bind` è chiamato **8 volte per draw** (uno per slot,
anche vuoto: 16,2 M chiamate su 2,02 M draw nella corsa intera), ognuna con `Map.get/delete/set` e un
oggetto nuovo — 2,4–2,6% del fotogramma (sezione 2).

## 4. Prototipi: −15% del fotogramma, comportamento identico

Le tre riduzioni della sezione 1 come patch dell'EM_JS minificato nella copia del banco (nessun
build: `~/incoming/phase0/renderjs/proto.mjs`), poi come sorgente in PR #123:

- pipeline cercata per **numero** (id dello shader sopra 21 bit di stato), stringa solo alla creazione;
- **bind group del draw precedente** finché `gxw_bind` non cambia uno slot (id texture, chiave
  sampler): niente stringa, niente lookup né riordino LRU;
- confronto uniform con la vista del heap in una locale e uscita al primo diverso.

**Certificazione** (gioco vero, 2400 fotogrammi, `DIGEST=1 VALIDATE=1`, traccia attiva):

| | digest delle chiamate WebGPU | chiamate | errori di contenuto | traccia |
| --- | --- | ---: | ---: | --- |
| originale | `624cf718…` | 2.744.711 | 0 / 2.021.706 | `c79c53b9…` |
| prototipo | `624cf718…` | 2.744.711 | 0 / 2.021.706 | `c79c53b9…` |
| controllo negativo (dedup sbagliato apposta) | `52f6e191…` | 2.621.860 | **1.263.814** | `c79c53b9…` |

Il digest è lo SHA-1 di ogni chiamata in ordine: metodo, ricevente, argomenti (oggetti per ordine di
creazione, descrittori per struttura, dati per i loro byte). Il controllo negativo mostra che digest e
validazione **vedono** un errore del renderer, e che **la traccia dei checkpoint no**: è lo stato
della CPU emulata, che il backend non tocca. L'oracolo grafico di `perf/beyond-core` (input del
renderer, sul core Node senza backend) per lo stesso motivo non può vedere questi cambi.

**Il validatore era rotto senza dirlo.** `VALIDATE=1` di `bench2/3.mjs` confrontava le uniform su 105
righe fisse; da quando le righe sono variabili (125, 186…) segnava errore su **ogni** draw. Corretto
in `lines.mjs` (`rows*16` byte, e controllo che la binding le contenga).

**Misura** (`sim_ms` medio in partita, coppie alternate, senza profiler):

| coppia | originale | prototipo | Δ |
| ---: | ---: | ---: | ---: |
| 1 | 54,61 | 44,42 | −10,19 |
| 2 | 51,35 | 45,96 | −5,39 |
| 3 | 58,97 | 48,92 | −10,05 |
| 4 | 56,22 | 48,60 | −7,62 |
| media | 55,29 | 46,98 | **−8,31 (0,85×)** |

Profilo del prototipo: JS di `gxw_draw` dal **22,6% al 14,3%** dei campioni; pipeline 2,95% →
0,17%; bind group 5,85% → ~1,5%; confronto uniform 9,4% → **7,5%** (il ciclo più stretto toglie
solo il 27% dei suoi campioni). `gxw_bind` sale da 2,6% a 3,0% (il controllo dello slot).

**Confermato sul core costruito da CI** (PR #123, run 37247236548, contro `main` 37247238291, stessi
flag): digest identico, 0 errori, traccia identica; `sim_ms` in partita 49,96 / 53,83 / 52,90 / 49,72 →
44,05 / 43,95 / 42,93 / 47,11 ms, **−7,1 ms, 0,86×, 4 su 4**.

**Il confronto uniform in C++, con `memcmp`: più lento — riportato così.** Il passo successivo
(ramo `perf/renderer-uniform-memcmp`) fa confrontare a `draw_segment` le righe con quelle passate
all'ultima chiamata e passa l'esito a `gxw_draw`, che non confronta più nulla. Digest identico, 0
errori, traccia identica; il JS di `gxw_draw` scende al **6,6%** dei campioni. Ma contro il core di
#123, 4 coppie alternate: 45,51 / 47,63 / 44,06 / 45,75 → 52,53 / 48,56 / 46,39 / 51,51 ms, **+4,0 ms,
4 su 4 a sfavore**. Spiegazione coerente con i numeri: il `memcmp` di questo build confronta **un
byte alla volta** — già nel profilo della sezione 2 il `memcmp` della `ShaderUid` (304 byte) costava
l'1,78% del fotogramma, ~1,9 ns/byte; su ~2000 byte di costanti fa ~3,8 µs, più del ciclo JS.

**A parole da 8 byte: confermato** (PR #125, run 37250152529). Digest identico, 0 errori, traccia
identica; contro il core di #123, 4 coppie: 45,34 / 48,36 / 43,78 / 44,46 → 41,74 / 43,55 / 39,69 /
40,93 ms, **−4,0 ms, 0,91×, 4 su 4**.

**Cumulativo, `main` contro #123 + #125** (core di CI, 4 coppie alternate): 55,06 / 53,13 / 56,94 /
51,91 → 42,19 / 45,82 / 43,46 / 44,75 ms, **−10,2 ms su 54,3, 0,81×, 4 su 4**: il JS del renderer
che costava il 22,6% del fotogramma attaccato è circa un quinto del fotogramma tolto, con le stesse
2.744.711 chiamate WebGPU byte per byte.

**Candidati successivi, attribuiti ma non provati** (sezione 2, % del fotogramma):
- il confronto della `ShaderUid` nella ricerca dello shader passa per lo stesso `memcmp` a byte
  (1,78%) più il suo hash (0,44%), a ogni segmento;
- il `std::vector` degli indici è allocato e liberato a ogni segmento (~2,1% con malloc/free);
- il frame meter della pagina play (sezione 3, 3–7%): scelta dell'operatore;
- `gxw_bind` 8 volte per draw (2,6–3,0%).

## 5. Limite dichiarato

Il tempo **dentro** le chiamate WebGPU vere (sul telefono: IPC verso il processo GPU di WebKit e
codifica Metal) e il tempo GPU **non sono misurabili dalla VPS**: qui WebGPU è finto. Quel pezzo lo
misura l'operatore dal report della pagina play (colonne `webgpu` per metodo).
