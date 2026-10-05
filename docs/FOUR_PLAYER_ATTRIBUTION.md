# Quattro giocatori: dove vanno i millisecondi in più

2026-10-05, ramo `measure/four-player-attribution`, base `main` `2413654`. Attribuzione, nessuna
ottimizzazione: il core misurato è quello di `main` con i nomi delle funzioni (run CI
[37301743539](https://github.com/isDemetrio/melee-web/actions/runs/37301743539), `profiling_funcs`),
e la sua traccia dei 2400 checkpoint è **`c79c53b9cdf81426fa0277e7497a69e55bc5f571`**, identica al
riferimento (corsa `trace` sotto).

La domanda viene da `docs/FOUR_PLAYER_LOAD.md` (PR #132): con quattro personaggi la simulazione
costa **1,49×** quella con due (+16,57 ms/fotogramma sul runner CI). Qui si dice **chi** spende quel
di più.

## La risposta

**Quattro quinti del costo in più sono i due personaggi stessi, e più della metà è il loro
disegno.** Il resto è il confronto delle texture dello stage, le ombre e l'HUD.

Profilo a campionamento di V8 dello stesso core, headless come la misura CI, finestra allineata sui
fotogrammi di partita 1–715 di entrambi i carichi (`two-player.txt` e `four-player.txt` di
`experiments/four-player/`). Il profilo riproduce il rapporto CI: `sim_ms` delle corse profilate
35,44 → 52,85 ms, **1,491×** (CI: 1,489 e 1,497). Delta del profilo: **+17,40 ms/fotogramma**.

| chi spende (callback GObj del guest) | 2 pers. ms | 4 pers. ms | **delta ms** | **quota del delta** | rapporto |
| --- | ---: | ---: | ---: | ---: | ---: |
| **personaggi, disegno** (`ftDrawCommon_80080E18`) | 8,80 | 18,38 | **+9,57** | **55,0%** | 2,09× |
| **personaggi, aggiornamento** (`Fighter_*`) | 2,49 | 7,25 | **+4,77** | **27,4%** | 2,92× |
| stage (`grDisplay_801C5DB0` e update di `Ground_*`/`grOnett_*`) | 14,92 | 16,34 | +1,42 | 8,2% | 1,10× |
| ombre (`lbShadow_8000F38C` → `HSD_ShadowStartRender`) | 1,42 | 2,66 | +1,24 | 7,1% | 1,88× |
| HUD (`ifStatus_*`, `fn_802F*`), disegno + aggiornamento | 1,62 | 2,27 | +0,66 | 3,8% | 1,41× |
| effetti, item, telecamera, altro | 2,11 | 2,32 | +0,22 | 1,3% | — |
| fuori dai passi GObj (copia XFB di fine fotogramma, retrace) | 4,25 | 3,77 | −0,48 | −2,8% | 0,89× |
| **totale** | **35,60** | **53,00** | **+17,40** | 100% | 1,489× |

I ms sono del profilo sulla VPS (il profilatore aggiunge tempo): **valgono le quote**. Applicate ai
+16,57 ms del runner CI: personaggi ≈ 13,7 ms (disegno ≈ 9,1, aggiornamento ≈ 4,5), stage ≈ 1,4,
ombre ≈ 1,2, HUD ≈ 0,6.

### Le voci, una per una

**1. Disegno dei personaggi, +9,57 ms (55%).** Per stadio di disegno (il frame guest più vicino alla
foglia; la matematica delle matrici va a chi la chiama):

| stadio | 2 pers. | 4 pers. | delta | quota del delta totale |
| --- | ---: | ---: | ---: | ---: |
| skinning dei vertici con envelope (`SetupEnvelopeModelMtx`, con `PSMTXConcat`, `HSD_MtxInverseTranspose`, `HSD_MtxScaledAdd` sotto) | 3,35 | 6,18 | **+2,83** | 16,2% |
| display list (`GXCallDisplayList` → decodifica FIFO GX) | 1,71 | 4,05 | **+2,34** | 13,4% |
| caricamento matrici nella FIFO (`WriteMTXPS*`, `GXLoad*MtxImm`) | 1,26 | 2,70 | +1,44 | 8,3% |
| materiali e TEV (`HSD_TObj*`, `HSD_TExp*`, `HSD_Setup*`, `HSD_MObj*`) | 1,38 | 2,79 | +1,41 | 8,1% |
| visita del grafo (`HSD_JObjDisp`, `HSD_DObjDisp`, `HSD_PObjDisp`) | 0,50 | 1,07 | +0,58 | 3,3% |
| primitive immediate (`__GXSendFlushPrim`) | 0,24 | 0,68 | +0,44 | 2,5% |
| matrici delle ossa (`HSD_JObjMakeMatrix`, `HSD_JObjSetupMatrix`) | 0,09 | 0,47 | +0,38 | 2,2% |
| altro | 0,27 | 0,44 | +0,17 | 1,0% |

Lo skinning cresce più dei disegni: i contatori esatti del core (sotto) danno **2,12×** chiamate a
`SetupEnvelopeModelMtx` contro **1,32×** disegni. I due personaggi in più hanno più vertici a
envelope dei due di controllo.

**2. Aggiornamento dei personaggi, +4,77 ms (27%).** Per callback del passo di update:

| callback | cosa c'è sotto (dal profilo) | delta | quota del delta totale |
| --- | --- | ---: | ---: |
| `Fighter_8006D9AC` | `ftCo_8009E0A8` → `ftCo_8009DD94` → `lb_8001044C`: controlli del pavimento (`mpCheckFloor`, `mpLib_8004ED5C`, `mpLineIntersection`) e rotazioni d'osso (`lbVector_*`, `HSD_JObjSetupMatrixSub`) | **+2,10** | **12,1%** |
| `Fighter_8006A360` | animazione: `ftAnim_8006EBA4` (1,95 dei 2,33 ms a 4) | +1,28 | 7,4% |
| `Fighter_procMap` | collisione con la mappa per stato (`ftCo_Wait_Coll`, `_Run_Coll`, `ftPe_SpecialN_Coll`…) | +0,73 | 4,2% |
| altri cinque (`Fighter_Spaghetti_8006AD10`, `_8006CB94` hitbox, `Fighter_ProcessHit_8006D1EC`, `_8006C5F4`, `_8006C80C`) | | +0,56 | 3,2% |
| resto | | +0,10 | 0,6% |

**`Fighter_8006D9AC` non è "un personaggio in più", è *quel* personaggio in più.** Con Kirby e Ness
vale 0,00 ms; con quattro vale 2,10 ms, **costante** per tutta la partita (fra 2,6% e 5,7% del
campione in ciascuno dei 24 intervalli della finestra: non è un episodio). I personaggi del
carico sono, dalle funzioni specifiche campionate (`ftKb_*`, `ftNs_*`, `ftPe_*`, `ftDk_*`):
**Kirby e Ness** nel controllo, **più Peach e Donkey Kong** a quattro. Il 12% del delta è quindi una
funzione che almeno uno fra Peach e Donkey Kong attiva e Kirby e Ness no. **Quale dei due, non è
separato** (il callback è generico, passa dalla struttura del personaggio).

**3. Stage, +1,42 ms (8%): non è lo stage, è il confronto delle texture.** Tolto il `memcmp`, lo
stage costa a quattro quanto a due (−0,28 ms, rumore); tutta la crescita è `memcmp` dentro
`record_draw`: **1,96 → 3,65 ms** nello stage (+1,70), e +0,30 nei personaggi. `memcmp` è
`TextureSnapshotCache::equal` (`port/runtime/gx/texture_snapshot.h`), che confronta i byte di una
texture quando la scorciatoia per versione RAM manca. La versione RAM è per blocchi da **64 KB**
(`RAM_WATCH_SHIFT = 16`, `ppc.h`): qualunque store del guest nello stesso blocco di una texture la
invalida. I contatori del core: scritture su blocchi sorvegliati **13.411 → 36.494 per fotogramma
(2,72×)**, blocchi sorvegliati 83 → 108. **Ipotesi, non misurata:** con due personaggi in più, i
loro dati scritti a ogni fotogramma cadono in blocchi che ospitano texture dello stage, e la
scorciatoia manca più spesso. Il contatore delle mancate scorciatoie non esiste (era già il
"contatore non ancora scritto" di `docs/CORE_COST_BROWSER.md` §3).

**4. Ombre, +1,24 ms (7%), 1,88×.** Il passo d'ombra ridisegna i personaggi
(`HSD_ShadowStartRender` → `HSD_JObjDispAll`, `ftDrawCommon_80081168/80081200`): stesse voci del
disegno dei personaggi, in piccolo (matrici d'ossa +0,26, display list +0,25, skinning +0,24).

**5. HUD, +0,66 ms (4%), 1,41×.** Due slot HUD in più (danno, stock, nomi): +0,41 di disegno (quasi
tutto materiali/TEV) e +0,25 di aggiornamento.

### Per tipo di lavoro dell'emulatore

La stessa partizione del delta, tagliata per **zona** (chi esegue: codice guest o il runtime che lo
fa girare; regola per pila come in `docs/CORE_COST_BROWSER.md`):

| zona | 2 pers. | 4 pers. | delta | quota | rapporto | voci principali del delta |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| **GPU emulata** (decodifica FIFO GX, dentro gli store del guest) | 12,13 | 17,86 | **+5,73** | **32,9%** | 1,47× | `memcmp` +2,00 · `parse_command` +1,99 · `gx_write` +0,64 · `record_draw` +0,37 · `decode_vertices` +0,15 |
| **corpo del codice guest** | 10,18 | 15,23 | **+5,05** | **29,0%** | 1,50× | `PSMTXConcat`, `HSD_MtxInverseTranspose`, `SetupEnvelopeModelMtx` in testa |
| **helper di memoria fuori linea** | 8,70 | 12,89 | **+4,19** | **24,1%** | 1,48× | `ld32` +1,79 · `st32` +0,91 · `psq_load` +0,43 · `psq_store` +0,34 |
| aritmetica emulata (`fma` software, `normalize`) | 1,78 | 3,35 | +1,57 | 9,0% | **1,89×** | `wasm_compat::fma` +0,91 · `fma` libm +0,37 · `normalize` +0,18 |
| contabilità d'ingresso, dispatch, MMIO non GX, altri helper | 2,22 | 3,05 | +0,82 | 4,7% | 1,37× | |
| HLE, retrace, renderer, fuori dal guest | 0,61 | 0,62 | +0,01 | 0,1% | 1,02× | |

L'aritmetica emulata cresce più di tutto (1,89×) perché vive nello skinning e nelle matrici dei
personaggi. La scorciatoia FMA di #121 è attiva: la `fma` della libm vale 1,56% del fotogramma a
quattro, contro 9,98% sullo stesso carico col core `2edd36a`, che #121 non ce l'ha. Il residuo
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

## Cosa non si è riusciti a separare

- **Quale dei due personaggi nuovi.** Il profilo non distingue le istanze: il disegno e
  l'aggiornamento passano da codice comune (`ftDrawCommon_*`, `Fighter_*`). Si separano solo le
  funzioni specifiche di un personaggio, che qui pesano poco. In particolare non è separato se i
  2,10 ms di `Fighter_8006D9AC` siano di Peach o di Donkey Kong, e quindi **quanto costerebbero due
  personaggi diversi**: il +49% vale per Peach e Donkey Kong aggiunti a Kirby e Ness, non per due
  personaggi qualunque.
- **Il perché delle mancate scorciatoie delle texture.** Il `memcmp` è misurato (+2,0 ms); la causa
  (falsa invalidazione dei blocchi da 64 KB) è un'ipotesi coerente con le scritture sorvegliate
  2,72×, senza un contatore delle mancate scorciatoie.
- **`decode_rest_ms` non si separa con i timer**, come già scritto in `docs/CORE_BUDGET_DECISION.md`.
  Il profilo dà le funzioni, non i sottopassi: a `-Oz` il compilatore ha inlinato parte della
  decodifica dei vertici in `parse_command` (ne resta fuori solo una lambda di
  `decode_vertices`, +0,15 ms), quindi `parse_command` +1,99 ms è "parsing più ciò che vi è
  inlinato", non parsing puro.
- **I tempi dei timer interni.** Con `melee_decoder_cost(1)` acceso, `sim_ms` passa da ~30 a 68,7 ms
  (2 pers.) e 101,2 ms (4 pers.): fino a ~44.000 scope cronometrati per fotogramma, ciascuno con letture
  dell'orologio che sono chiamate da wasm a JS. I rapporti dei timer sono coerenti col profilo (`decode_ms` 1,448×,
  `non_decode_ms` 1,491×, `texture_ms` 1,909× — la cattura texture, dove sta il `memcmp`), ma i loro
  millisecondi non sono una misura di questo fotogramma.
- **Il corpo guest contiene l'inlinato**: aggiornamenti dei CR, conversioni float, i percorsi
  veloci degli helper. È un tetto del lavoro guest, come in `docs/CORE_COST_BROWSER.md`.

RENDERER_PLACEHOLDER

## Verifica dei classificatori

La lezione di #119 (la regex `\bgx::` sulla firma intera aveva messo nella decodifica FIFO funzioni
del renderer che prendono un `gx::Frame&`): `scripts/analysis/fourcore_attribution.py` confronta le
zone solo sul **nome qualificato**, senza lista d'argomenti **e senza argomenti di template**
(`std::vector<gx::Vertex>::__append` diceva `gx::` senza essere della GPU emulata), e riporta ogni
campione in cui la regola di `cpuprofile_split.py` dà una zona diversa (`zone_disagreement`).

- Su un profilo **con renderer attaccato** (core `2edd36a`, parità a due) il confronto ritrova
  esattamente l'errore di #119: `draw_segment` 5,1%, `memcmp` 2,1%, `vector::__insert_with_size`
  1,3% e il resto fino a ~10 punti passano da `gx_fifo_decode` a `render_backend`.
- Sui profili **headless** di questo documento il disaccordo è **zero** (due nomi, 0,00 ms): il
  renderer non è attaccato, quindi non c'è niente da classificare male. Il numero che conta qui,
  la zona GPU emulata, non dipende dall'errore.
- Il classificatore dei **proprietari** aveva un suo errore, trovato guardando le pile: il passo
  delle ombre finiva sotto "telecamera" perché il callback di render della telecamera
  (`fn_800301D0`) li lancia tutti ed era riconosciuto per primo. Corretto: la telecamera vale solo
  se sotto non c'è niente di più specifico. Senza correzione la "telecamera" valeva +1,26 ms;
  corretta vale +0,02, e le ombre +1,24.
- Il delta per **proprietario** e per **zona** somma allo stesso +17,40 ms; i campioni senza un
  proprietario sono la copia XFB e il retrace (−0,48 ms), riportati a parte, non piegati.

## Metodo

- **Core**: `phase0-build.yml` su `main` con `upload_spike=true profiling_funcs=true` (run
  37301743539, `core.json` commit `2413654…`, `-Oz`), il modulo web con i nomi.
- **Prova del comportamento**: la stessa imbracatura sul copione di parità, 2400 retrace, traccia di
  stato accesa: SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`.
- **Carichi**: `experiments/four-player/two-player.txt` e `four-player.txt`, invariati. La partita
  inizia al retrace 1639 (due) e 1686 (quattro: la selezione dei personaggi è più lunga); le finestre
  sono **allineate sul fotogramma di partita**, 1–715, perché il copione in partita è ciclico sui
  fotogrammi di partita (`@loop 360`). Profilo dal retrace 1638→2353 (due) e 1685→2400 (quattro).
- **Profilo**: V8 di Node 22 sulla VPS, campionamento a 100 µs, avviato e fermato in modo sincrono
  dentro il battito del retrace; 118.855 e 175.868 campioni; headless (`NOATTACH=1`) come la misura
  CI, `--state-trace ''`. Ogni campione è classificato per pila: fase (passo GObj di update,
  `HSD_GObj_80390CFC`; di render, `HSD_GObj_80390FC0`; copia XFB), proprietario (il callback subito
  dopo l'iteratore per-GObj più interno, `HSD_GObj_80390ED0` in render), zona, stadio di disegno.
- **Contatori**: una corsa per carico con `melee_decoder_cost(1)`.
- **Tempi senza profilatore**: AB_PLACEHOLDER

L'imbracatura non è nel repository (fa girare il core privato e il disco): `~/briefs/fourcore/`,
`prof4.mjs` è `corecost/prof.mjs` con `SCRIPT=` (copione) e `SPLIT=1` (timer interni);
`queue.sh` fa contatori, profili e coppie; `gate.sh` la traccia; `attached.sh` i profili col
renderer finto.

```sh
gh workflow run phase0-build.yml --ref main -f upload_spike=true -f profiling_funcs=true
./gate.sh <spike-core> <out>          # SHA-1 della traccia di parità
./queue.sh <spike-core> <out>         # split 2p/4p, profili 2p/4p, tre coppie di tempo
python3 scripts/analysis/fourcore_attribution.py <out>/prof-2p/inmatch.cpuprofile \
  <out>/prof-4p/inmatch.cpuprofile --frames 715
```

Lo script legge solo nomi di funzione e scrive aggregati; nessun dato di gioco nel repository.

## Candidati, non provati

Nessuna ottimizzazione in questa sessione. Quello che l'attribuzione nomina, in ordine di quota:

| candidato | quota del delta | nota |
| --- | ---: | --- |
| skinning e matrici dei personaggi (envelope, matrici d'ossa, caricamenti nella FIFO) | ~27% | è lavoro del guest più helper e `fma`; nessuna scorciatoia ovvia |
| decodifica delle display list dei personaggi | ~13% | `parse_command`/`gx_write`: la GPU emulata, cresce con i draw registrati (1,48×) |
| `memcmp` della cattura texture | ~11,5% | il confronto è byte per byte nella musl di Emscripten (~1,9 ns/byte, misurato in #125). Due strade, da misurare: un confronto per parole (stesso esito booleano) o blocchi di guardia più fini (meno false invalidazioni). Prima va scritto il contatore delle mancate scorciatoie |
| `Fighter_8006D9AC` (pavimento e ossa di un personaggio) | ~12% | è comportamento del gioco per quel personaggio: non riducibile senza toccare il guest |
| `fma` software residua | ~9% (dentro le righe sopra) | l'ipotesi dei fattori zero di `docs/CORE_COST_BROWSER.md` §4 |
