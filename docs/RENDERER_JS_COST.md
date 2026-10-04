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

## 4. Limite dichiarato

Il tempo **dentro** le chiamate WebGPU vere (sul telefono: IPC verso il processo GPU di WebKit e
codifica Metal) e il tempo GPU **non sono misurabili dalla VPS**: qui WebGPU è finto. Quel pezzo lo
misura l'operatore dal report della pagina play (colonne `webgpu` per metodo).
