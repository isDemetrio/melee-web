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

## 3. La produzione — in corso

Notato leggendo il codice, da misurare:

- `gxw_bind` è chiamato **8 volte per draw** (uno per slot, anche vuoto: 16,2 M chiamate su 2,02 M
  draw nella corsa intera), ognuna con un `Map.get/delete/set` e un oggetto nuovo: 2,4% *self* nel
  profilo di PR #119.
- **In produzione c'è più JS per draw che nel banco.** La pagina play (`web/src/play/worker.ts`)
  avvolge **ogni** chiamata WebGPU con il frame meter (`instrumentGpu`: due `performance.now()` e
  scritture nel registratore di volo in memoria condivisa per chiamata), e il beat `-1` di ogni draw
  legge l'orologio (`heartbeatSender`). Il banco non ha né l'uno né l'altro: il loro costo va misurato
  a parte.
- La **validazione di contenuto** del banco (`VALIDATE=1`: hash dei byte di ogni draw) esiste solo
  nel banco; nel percorso di produzione non c'è.

## 4. Limite dichiarato

Il tempo **dentro** le chiamate WebGPU vere (sul telefono: IPC verso il processo GPU di WebKit e
codifica Metal) e il tempo GPU **non sono misurabili dalla VPS**: qui WebGPU è finto. Quel pezzo lo
misura l'operatore dal report della pagina play (colonne `webgpu` per metodo).
