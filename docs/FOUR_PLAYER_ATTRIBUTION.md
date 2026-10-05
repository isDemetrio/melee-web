# Quattro giocatori: dove vanno i millisecondi in più

2026-10-05, ramo `measure/four-player-attribution`, base `main` `2413654`. Attribuzione, nessuna
ottimizzazione: il core misurato è quello di `main` con i nomi delle funzioni (run CI
[37301743539](https://github.com/isDemetrio/melee-web/actions/runs/37301743539), `profiling_funcs`),
e la sua traccia dei 2400 checkpoint è **`c79c53b9cdf81426fa0277e7497a69e55bc5f571`**, identica al
riferimento.

La domanda viene da `docs/FOUR_PLAYER_LOAD.md` (PR #132): con quattro personaggi la simulazione
costa **1,49×** quella con due (+16,57 ms/fotogramma sul runner CI). Qui si dice **chi** spende quel
di più.

## La risposta

**Quattro quinti del costo in più sono i due personaggi stessi, e più della metà è il loro
disegno.** Il resto è il confronto byte per byte delle texture, le ombre e l'HUD. La fisica e le
collisioni pesano poco: la collisione con la mappa vale il 4%.

Profilo a campionamento di V8 dello stesso core, headless come la misura CI, su tre coppie di corse
(due personaggi / quattro, ordine alternato), finestra allineata sui fotogrammi di partita 1–715 di
entrambi i carichi (`two-player.txt` e `four-player.txt` di `experiments/four-player/`). Media delle
tre coppie, fra parentesi quadre il minimo e il massimo:

| chi spende (callback GObj del guest) | 2 pers. ms | 4 pers. ms | **delta ms** | **quota del delta** | rapporto |
| --- | ---: | ---: | ---: | ---: | ---: |
| **personaggi, disegno** (`ftDrawCommon_80080E18`) | 8,57 | 18,75 | **+10,17** [9,36 – 11,59] | **54,4%** [49 – 59] | 2,19× |
| **personaggi, aggiornamento** (`Fighter_*`) | 2,44 | 7,36 | **+4,92** [4,64 – 5,35] | **26,5%** [23 – 29] | 3,02× |
| stage (`grDisplay_801C5DB0`, `Ground_*`, `grOnett_*`) | 14,70 | 16,67 | +1,98 [0,69 – 3,82] | 9,6% [4 – 16] | 1,13× |
| … di cui `memcmp` delle texture dello stage | 1,99 | 3,79 | **+1,81** [1,63 – 2,09] | 9,6% [9 – 10] | 1,91× |
| … di cui tutto il resto dello stage | | | +0,17 [−0,94 – 1,73] | ~0 | rumore |
| ombre (`lbShadow_8000F38C` → `HSD_ShadowStartRender`) | 1,39 | 2,68 | +1,29 [1,11 – 1,53] | 6,9% [6,5 – 7,1] | 1,93× |
| HUD (`ifStatus_*`, `fn_802F*`), disegno + aggiornamento | 1,59 | 2,30 | +0,71 [0,53 – 0,93] | 3,7% [3,3 – 4,0] | 1,45× |
| effetti, item, telecamera, altro | 2,12 | 2,36 | +0,24 | 1,2% | 1,11× |
| fuori dai passi GObj (copia XFB di fine fotogramma, retrace) | 4,18 | 3,80 | −0,38 [−0,58 – −0,06] | −2,2% | 0,91× |
| **totale** | **34,99** | **53,93** | **+18,93** [15,82 – 23,58] | 100% | 1,54× |

I ms sono del profilo sulla VPS (il profilatore aggiunge tempo e la VPS deriva): **valgono le
quote**. Applicate ai +16,57 ms del runner CI: personaggi ≈ 13,4 ms (disegno ≈ 9,0, aggiornamento
≈ 4,4), `memcmp` dello stage ≈ 1,6, ombre ≈ 1,1, HUD ≈ 0,6.

Le voci "personaggi", `memcmp`, ombre e HUD hanno intervalli stretti fra le tre coppie. La voce
"resto dello stage" no: è il blocco più grosso a due personaggi (14 ms), quindi è quella che
assorbe di più la deriva della VPS fra una corsa e l'altra, e il suo delta va da −0,94 a +1,73 ms.
**Non è un costo dei personaggi in più: è rumore**, e la coppia peggiore (rapporto 1,72) lo mostra.

### Le voci, una per una

**1. Disegno dei personaggi, +10,17 ms (54%).** Per stadio di disegno (il frame guest più vicino
alla foglia; la matematica delle matrici va a chi la chiama):

| stadio | 2 pers. | 4 pers. | delta [min – max] | quota del delta totale |
| --- | ---: | ---: | ---: | ---: |
| skinning dei vertici a envelope (`SetupEnvelopeModelMtx`, con `PSMTXConcat`, `HSD_MtxInverseTranspose`, `HSD_MtxScaledAdd` sotto) | 3,25 | 6,29 | **+3,04** [2,77 – 3,52] | 16,2% |
| display list (`GXCallDisplayList` → decodifica FIFO GX) | 1,68 | 4,15 | **+2,47** [2,26 – 2,81] | 13,2% |
| materiali e TEV (`HSD_TObj*`, `HSD_TExp*`, `HSD_Setup*`, `HSD_MObj*`) | 1,33 | 2,86 | +1,53 [1,41 – 1,75] | 8,2% |
| caricamento di matrici nella FIFO (`WriteMTXPS*`, `GXLoad*MtxImm`) | 1,22 | 2,74 | +1,52 [1,44 – 1,69] | 8,2% |
| visita del grafo (`HSD_JObjDisp`, `HSD_DObjDisp`, `HSD_PObjDisp`) | 0,49 | 1,05 | +0,57 | 3,0% |
| primitive immediate (`__GXSendFlushPrim`) | 0,23 | 0,71 | +0,48 | 2,6% |
| matrici delle ossa (`HSD_JObjMakeMatrix`, `HSD_JObjSetupMatrix`) | 0,10 | 0,48 | +0,38 | 2,1% |
| altro | 0,27 | 0,45 | +0,18 | 1,0% |

Lo skinning cresce più dei disegni: i contatori esatti del core (sotto) danno **2,12×** matrici a
envelope contro **1,32×** disegni. I due personaggi in più hanno più vertici a envelope dei due di
controllo.

**2. Aggiornamento dei personaggi, +4,92 ms (27%).** Per callback del passo di update:

| callback | cosa c'è sotto (dal profilo) | delta [min – max] | quota del delta totale |
| --- | --- | ---: | ---: |
| `Fighter_8006D9AC` | `ftCo_8009E0A8` → `ftCo_8009DD94` → `lb_8001044C`: controlli del pavimento (`mpCheckFloor`, `mpLib_8004ED5C`, `mpLineIntersection`) e rotazioni d'osso (`lbVector_*`, `HSD_JObjSetupMatrixSub`) | **+2,12** [2,06 – 2,20] | **11,5%** |
| `Fighter_8006A360` | animazione: `ftAnim_8006EBA4` (1,95 dei 2,33 ms a quattro, coppia 1) | +1,35 [1,27 – 1,49] | 7,2% |
| `Fighter_procMap` | collisione con la mappa per stato (`ftCo_Wait_Coll`, `_Run_Coll`, `ftPe_SpecialN_Coll`…) | +0,77 [0,70 – 0,88] | 4,1% |
| tutti gli altri (`Fighter_Spaghetti_8006AD10`, `_8006CB94` hitbox, `Fighter_ProcessHit_8006D1EC`, `_8006C5F4`, `_8006C80C`, …) | | +0,68 | 3,7% |

**`Fighter_8006D9AC` non è "un personaggio in più", è *quel* personaggio in più.** Con due
personaggi vale 0,00 ms; con quattro vale 2,1 ms, **costante** per tutta la partita (fra 2,6% e
5,7% dei campioni in ciascuno dei 24 intervalli della finestra: non è un episodio). I personaggi del
carico, dalle funzioni specifiche campionate (`ftKb_*`, `ftNs_*`, `ftPe_*`, `ftDk_*`), sono **Kirby e
Ness** nel controllo, **più Peach e Donkey Kong** a quattro. L'11,5% del delta è quindi una funzione
che almeno uno fra Peach e Donkey Kong attiva e Kirby e Ness no.

**3. `memcmp` delle texture, +2,1 ms (11%), quasi tutto nello stage.** Togliendolo, lo stage costa a
quattro quanto a due. Il `memcmp` cresce da 1,99 a 3,79 ms dentro il disegno dello stage, più 0,30
dentro quello dei personaggi. È `TextureSnapshotCache::equal`
(`port/runtime/gx/texture_snapshot.h`), chiamato da `record_draw` quando la scorciatoia della
versione RAM manca, e confronta la texture byte per byte. La versione RAM è per blocchi da **64 KB**
(`RAM_WATCH_SHIFT = 16`, `ppc.h`): qualunque store del guest nello stesso blocco di una texture la
invalida. Contatori del core: scritture su blocchi sorvegliati **13.411 → 36.494 per fotogramma
(2,72×)**, blocchi sorvegliati 83 → 108. **Ipotesi, non misurata:** i dati dei due personaggi in più,
scritti a ogni fotogramma, cadono in blocchi che contengono texture dello stage, e la scorciatoia
manca più spesso. Il contatore delle scorciatoie mancate non esiste: era già il "contatore non
ancora scritto" di `docs/CORE_COST_BROWSER.md` §3.

**4. Ombre, +1,29 ms (7%), 1,93×.** Il passo d'ombra ridisegna i personaggi
(`HSD_ShadowStartRender` → `HSD_JObjDispAll`, `ftDrawCommon_80081168/80081200`): le stesse voci
del disegno dei personaggi, in piccolo (display list +0,29, matrici d'ossa +0,26, skinning +0,23).

**5. HUD, +0,71 ms (4%), 1,45×.** Due slot HUD in più (danno, stock, nomi): +0,44 di disegno, quasi
tutto materiali/TEV, e +0,27 di aggiornamento.

### Per tipo di lavoro dell'emulatore

La stessa partizione del delta, tagliata per **zona** (chi esegue: codice guest o il runtime che lo
fa girare; regola per pila come in `docs/CORE_COST_BROWSER.md`). Qui le quote sono strettissime
fra le tre coppie:

| zona | 2 pers. | 4 pers. | delta | quota [min – max] | rapporto | voci principali del delta (coppia 1) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| **GPU emulata** (decodifica FIFO GX, dentro gli store del guest) | 11,92 | 18,33 | **+6,41** | **33,8%** [33,0 – 34,7] | 1,54× | `memcmp` +2,00 · `parse_command` +1,99 · `gx_write` +0,64 · `record_draw` +0,37 · `decode_vertices` +0,15 |
| **corpo del codice guest** | 10,04 | 15,58 | **+5,54** | **29,3%** [29,0 – 29,8] | 1,55× | `PSMTXConcat`, `HSD_MtxInverseTranspose`, `SetupEnvelopeModelMtx` in testa |
| **helper di memoria fuori linea** | 8,53 | 12,83 | **+4,30** | **22,8%** [22,1 – 24,1] | 1,50× | `ld32` +1,79 · `st32` +0,91 · `psq_load` +0,43 · `psq_store` +0,34 |
| aritmetica emulata (`fma` software, `normalize`) | 1,75 | 3,43 | +1,69 | 9,0% [8,3 – 9,7] | **1,96×** | `wasm_compat::fma` +0,91 · `fma` della libm +0,37 · `normalize` +0,18 |
| contabilità d'ingresso, dispatch, MMIO non GX, altri helper | 2,16 | 3,12 | +0,95 | 5,0% | 1,44× | |
| HLE, retrace, renderer, fuori dal guest | 0,59 | 0,64 | +0,04 | 0,2% | 1,08× | |

L'aritmetica emulata cresce più di tutto (1,96×) perché vive nello skinning e nelle matrici dei
personaggi. La scorciatoia FMA di #121 è attiva: la `fma` della libm vale l'1,56% del fotogramma a
quattro, contro il 9,98% sullo stesso carico col core `2edd36a`, che #121 non ce l'ha. Il residuo
resta in `PSMTXConcat`.

## I contatori esatti del core

Dai timer interni (`melee_decoder_cost(1)`, la casella "core split" della pagina di gioco), medie per
fotogramma di partita 1–715. **Solo i conteggi**: i tempi di quei timer qui non valgono (sotto).

| contatore | 2 pers. | 4 pers. | rapporto |
| --- | ---: | ---: | ---: |
| disegni (`texture_calls`) | 682,3 | 901,8 | **1,322** (oracolo CI: 684,8 → 903,3, 1,319) |
| draw registrati (`record_calls`) | 1.895 | 2.799 | 1,477 |
| ingressi nello scope di decodifica (`decode_calls`) | 30.696 | 43.734 | 1,425 |
| joint visualizzati (`display_joint_calls`) | 161,6 | 220,5 | 1,364 |
| matrici rigide (`rigid_matrix_calls`) | 268,9 | 285,7 | 1,063 |
| **matrici a envelope** (`envelope_matrix_calls`) | 115,5 | 245,4 | **2,124** |
| **scritture su blocchi RAM sorvegliati** | 13.411 | 36.494 | **2,721** |
| blocchi RAM sorvegliati | 83,1 | 108,1 | 1,301 |

I disegni coincidono con l'oracolo del banco CI: stesso carico, stessi personaggi.

## Il rapporto dipende dalla macchina

`docs/FOUR_PLAYER_LOAD.md` dice che "trasferisce solo il rapporto". Sulla VPS, **senza profilatore**,
sei coppie alternate (tre con due personaggi per primi, tre con quattro per primi) danno:

| | 2 pers. `sim_ms` | 4 pers. `sim_ms` | rapporto |
| --- | ---: | ---: | ---: |
| media di sei coppie | 29,05 | 47,47 | **1,634** (singole: 1,594 · 1,774 · 1,532 · 1,649 · 1,634 · 1,643) |
| runner CI, due corse (`FOUR_PLAYER_LOAD.md`) | | | 1,489 · 1,497 |
| le tre coppie profilate qui | | | 1,489 · 1,432 · 1,719 |

**Sulla VPS quattro personaggi costano 1,63×, non 1,49×.** Il rapporto si sposta con la macchina, e
quindi la proiezione sul telefono di `FOUR_PLAYER_LOAD.md` (15,1 ms di core) è una delle possibili,
non *la* proiezione. Perché la VPS penalizzi di più i quattro personaggi non è misurato. È
plausibile che conti la memoria (quattro personaggi toccano più dati, e la VPS ha due vCPU
condivise), ma è un'ipotesi. Le **quote** del delta fra le zone invece sono stabili (±1 punto) anche
fra coppie con rapporti diversi: sono loro il risultato che trasferisce.

## Con il renderer attaccato

Sul telefono il core comprende anche il backend del renderer (C++ e JS `gxw_*`). Una coppia di
profili con WebGPU finto (`attached.sh`) dà: `sim_ms` 63,74 → 84,32 ms, **1,32×**. Il backend
(`submit_and_recycle`, zona `render_backend`) passa da 22,34 a 28,62 ms (+6,28, **1,28×**), circa
come i disegni (1,32×), ed è il 31% del delta di questa coppia. Quindi **col renderer attaccato i
quattro personaggi pesano relativamente meno** (1,32× contro 1,54×), perché il backend scala coi
disegni e non con lo skinning. Il `memcmp` dello stage cresce anche qui (+1,60). È **una sola
coppia**, con il WebGPU finto e su V8: il costo vero delle chiamate WebGPU e JSC del telefono non ci
sono.

## Cosa non si è riusciti a separare

- **Quale dei due personaggi nuovi.** Il profilo non distingue le istanze: il disegno e
  l'aggiornamento passano da codice comune (`ftDrawCommon_*`, `Fighter_*`). Si separano solo le
  funzioni specifiche di un personaggio, che qui pesano poco. In particolare **non è separato se i
  2,1 ms di `Fighter_8006D9AC` siano di Peach o di Donkey Kong**, e quindi quanto costerebbero due
  personaggi diversi: il +49% (o +63% sulla VPS) vale per Peach e Donkey Kong aggiunti a Kirby e Ness,
  non per due personaggi qualunque.
- **Il perché delle scorciatoie mancate delle texture.** Il `memcmp` è misurato (+2,1 ms); la causa
  (falsa invalidazione dei blocchi da 64 KB) è un'ipotesi coerente con le scritture sorvegliate
  2,72×, senza un contatore delle scorciatoie mancate.
- **`decode_rest_ms` non si separa con i timer**, come già scritto in `docs/CORE_BUDGET_DECISION.md`.
  Il profilo dà le funzioni, non i sottopassi: a `-Oz` il compilatore ha inlinato parte della
  decodifica dei vertici in `parse_command` (ne resta fuori solo una lambda di `decode_vertices`,
  +0,15 ms), quindi `parse_command` +1,99 ms è "parsing più ciò che vi è inlinato", non parsing puro.
- **I tempi dei timer interni.** Con `melee_decoder_cost(1)` acceso, `sim_ms` passa da ~29 a 68,7 ms
  (due personaggi) e da ~47 a 101,2 ms (quattro): fino a ~44.000 scope cronometrati per fotogramma,
  ciascuno con letture dell'orologio che sono chiamate da wasm a JS. I rapporti dei timer sono
  coerenti col profilo (`decode_ms` 1,448×, `non_decode_ms` 1,491×, `texture_ms` 1,909×: la cattura
  texture, dove sta il `memcmp`), ma i loro millisecondi non misurano questo fotogramma.
- **Il corpo guest contiene l'inlinato**: aggiornamenti dei CR, conversioni float, i percorsi
  veloci degli helper. È un tetto del lavoro guest, come in `docs/CORE_COST_BROWSER.md`.
- **Lo stage al netto del `memcmp`**: il suo delta (−0,94 … +1,73 ms) è dentro il rumore della VPS.
  Non si può dire che sia zero, solo che queste misure non lo distinguono da zero.

## Verifica dei classificatori

La lezione di #119 (la regex `\bgx::` sulla firma intera aveva messo nella decodifica FIFO funzioni
del renderer che prendono un `gx::Frame&`): `scripts/analysis/fourcore_attribution.py` confronta le
zone solo sul **nome qualificato**, senza lista d'argomenti **e senza argomenti di template**
(`std::vector<gx::Vertex>::__append` diceva `gx::` senza essere della GPU emulata), e riporta ogni
campione in cui la regola di `cpuprofile_split.py` dà una zona diversa (`zone_disagreement`).

- Sui profili **con renderer attaccato** di questo documento il confronto ritrova esattamente
  l'errore di #119: `draw_segment` 5,4–5,6%, il `memcmp` del confronto delle costanti 2,1–2,2%,
  `vector::__insert_with_size` 1,3% e il resto, ~10 punti in tutto, passano da `gx_fifo_decode` a
  `render_backend`.
- Sui profili **headless**, quelli della risposta, il disaccordo è **zero** (0,001 ms su tre coppie): il
  renderer non è attaccato, quindi non c'è niente da classificare male.
- Il classificatore dei **proprietari** aveva un suo errore, trovato guardando le pile: il passo
  delle ombre finiva sotto "telecamera" perché il callback di render della telecamera
  (`fn_800301D0`) le lancia tutte ed era riconosciuto per primo. Corretto: la telecamera vale solo
  se sotto non c'è niente di più specifico. Senza correzione la "telecamera" valeva +1,26 ms
  (coppia 1); corretta vale +0,02, e le ombre +1,24.
- Il delta per **proprietario** e per **zona** somma allo stesso totale; i campioni senza un
  proprietario sono la copia XFB e il retrace (−0,38 ms), riportati a parte, non piegati.

## Metodo

- **Core**: `phase0-build.yml` su `main` con `upload_spike=true profiling_funcs=true` (run
  37301743539, `core.json` commit `2413654…`, `-Oz`), il modulo web con i nomi.
- **Prova del comportamento**: la stessa imbracatura sul copione di parità, 2400 retrace, headless,
  traccia di stato accesa: SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`.
- **Carichi**: `experiments/four-player/two-player.txt` e `four-player.txt`, invariati. La partita
  inizia al retrace 1639 (due) e 1686 (quattro: la selezione dei personaggi è più lunga). Le finestre
  sono **allineate sul fotogramma di partita**, 1–715, perché il copione in partita è ciclico sui
  fotogrammi di partita (`@loop 360`): profilo dal retrace 1638→2353 (due) e 1685→2400 (quattro).
- **Profilo**: V8 di Node 22 sulla VPS, campionamento a 100 µs, avviato e fermato in modo sincrono
  dentro il battito del retrace; ~119.000 e ~176.000 campioni per corsa; headless (`NOATTACH=1`)
  come la misura CI, `--state-trace ''`. Ogni campione è classificato per pila: fase (passo GObj di
  update `HSD_GObj_80390CFC`, di render `HSD_GObj_80390FC0`, copia XFB), proprietario (il callback
  subito dopo l'iteratore per-GObj più interno, `HSD_GObj_80390ED0` in render), zona, stadio di
  disegno. Tre coppie, ordine 2→4, 4→2, 2→4.
- **Contatori**: una corsa per carico con `melee_decoder_cost(1)`.
- **Tempi senza profilatore**: sei coppie alternate, `sim_ms` medio sui fotogrammi di partita 1–715.
- **Renderer attaccato**: una coppia, WebGPU finto che conta le chiamate (`attached.sh`).

L'imbracatura non è nel repository (fa girare il core privato e il disco): `~/briefs/fourcore/`.
`prof4.mjs` è `corecost/prof.mjs` con `SCRIPT=` (copione) e `SPLIT=1` (timer interni); `queue.sh` fa
contatori, profili e coppie di tempo; `gate.sh` la traccia; `reprof.sh` e `abrev.sh` le coppie in
ordine inverso; `attached.sh` i profili col renderer; `pairs.py` media e intervallo fra le coppie.

```sh
gh workflow run phase0-build.yml --ref main -f upload_spike=true -f profiling_funcs=true
./gate.sh <spike-core> <out>          # SHA-1 della traccia di parità
./queue.sh <spike-core> <out>         # contatori 2p/4p, profili 2p/4p, tre coppie di tempo
python3 scripts/analysis/fourcore_attribution.py <out>/prof-2p/inmatch.cpuprofile \
  <out>/prof-4p/inmatch.cpuprofile --frames 715
python3 pairs.py <out> prof prof2 prof3
```

Lo script legge solo nomi di funzione e scrive aggregati; nessun dato di gioco nel repository.

## Candidati, non provati

Nessuna ottimizzazione in questa sessione. Quello che l'attribuzione nomina, in ordine di quota:

| candidato | quota del delta | nota |
| --- | ---: | --- |
| skinning e matrici dei personaggi (envelope, matrici d'ossa, caricamenti nella FIFO) | ~27% | lavoro del guest più helper e `fma`; nessuna scorciatoia ovvia |
| decodifica delle display list dei personaggi | ~13% | `parse_command`/`gx_write`: la GPU emulata, cresce con i draw registrati (1,48×) |
| `Fighter_8006D9AC` (pavimento e ossa di uno dei due personaggi nuovi) | ~11,5% | comportamento del gioco per quel personaggio: non riducibile senza toccare il guest |
| `memcmp` della cattura texture | ~11% | il confronto è byte per byte nella musl di Emscripten (~1,9 ns/byte, misurato in #125). Due strade, da misurare: un confronto per parole (stesso esito booleano) o blocchi di guardia più fini (meno false invalidazioni). Prima va scritto il contatore delle scorciatoie mancate |
| `fma` software residua | ~9% (dentro le righe sopra) | l'ipotesi dei fattori zero di `docs/CORE_COST_BROWSER.md` §4 |
