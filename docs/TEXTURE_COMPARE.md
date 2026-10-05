# Cattura delle texture: confrontare a parole, non a byte

2026-10-05, ramo `perf/texture-memcmp` (PR #140), base `main` `64dc1d1`. Due pezzi:

- **patch 0011**, contatori: per ogni retrace, che cosa ha fatto ogni cattura di texture e, quando
  la scorciatoia della versione RAM manca, **perché** manca. È il "contatore delle scorciatoie
  mancate" che `docs/CORE_COST_BROWSER.md` §3 e `docs/FOUR_PLAYER_ATTRIBUTION.md` davano come non
  ancora scritto;
- **patch 0012**, la modifica: `TextureSnapshotCache::equal` confronta con `gx::same_bytes`, otto
  byte per lettura, invece che con il `memcmp` della musl di Emscripten, che va un byte alla volta.

Core misurati, entrambi `-Oz`, dal workflow `phase0-build.yml` con `upload_spike`:
**A** = `b6b1cf7` (solo i contatori, run [37332382628](https://github.com/isDemetrio/melee-web/actions/runs/37332382628)),
**B** = `d103254` (contatori + confronto a parole, run [37333242492](https://github.com/isDemetrio/melee-web/actions/runs/37333242492)).
La traccia dei 2400 checkpoint è **`c79c53b9cdf81426fa0277e7497a69e55bc5f571`** per entrambi.

## Il risultato

| carico | coppie | A ms | B ms | **B − A** (IC 95%) | **B / A** (IC 95%) | coppie a favore di B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| due personaggi (`two-player.txt`) | 20 | 29,65 | 28,09 | **−1,56** ±1,08 | **0,949** ±0,036 | 15 / 20 |
| quattro personaggi (`four-player.txt`) | 16 | 49,07 | 44,81 | **−4,26** ±2,01 | **0,916** ±0,037 | 14 / 16 |

`sim_ms` medio dei fotogrammi di partita 1–715, Node headless sulla VPS, nessun profilatore, nessun
timer di fase, nessuna traccia; coppie in ordine alternato (AB, BA, AB…) per annullare la deriva
della macchina. L'intervallo è t di Student sulla differenza per coppia. **Il rumore della VPS è
grande**: la dispersione fra corse dello stesso core è ±8,9% a due personaggi e ±10,3% a quattro,
cioè 2,6 e 5,1 ms, più del guadagno che si cerca. Per questo servono 20 coppie per dire −1,6 ms con un
intervallo che non tocca lo zero; con le prime 8 coppie la stima era −2,19 ±2,11 (e −4,95 ±3,52 a
quattro personaggi). Le coppie successive hanno ristretto l'intervallo e abbassato la stima: si
riporta quella con tutte le coppie.

**La fase mirata, misurata direttamente.** Con i timer del core accesi (`melee_decoder_cost(1)`,
che gonfiano `sim_ms` ma misurano la stessa fase in A e in B), la cattura delle texture
(`texture_ms`, `SIM_SNAPSHOT`) in partita:

| carico | A | B | B − A |
| --- | ---: | ---: | ---: |
| due personaggi | 3,05 ms | 0,79 ms | **−2,26 ms** (3,9× più veloce) |
| quattro personaggi | 4,52 ms | 1,16 ms | **−3,37 ms** (3,9×) |

Una corsa per lato: è un timer interno, non il tempo del fotogramma, ma isola la fase che la modifica
tocca e sta dentro entrambi gli intervalli delle coppie (−0,48 … −2,64 ms a due personaggi, −2,25 …
−6,27 a quattro). È la stima più stretta del guadagno vero; quella delle coppie è la stessa cosa vista
attraverso il rumore della VPS. Coerente anche col conto dei byte qui sotto: 1,5–2,2 ns risparmiati
per byte confrontato.

**Il guadagno non è dei quattro giocatori: è di ogni partita.** Due personaggi sono la partita più
piccola che il gioco avvia (`two-player.txt`: la selezione dei personaggi non procede con una sola
porta umana), e lì il confronto a parole vale −1,6 ms su ~29.

## Dove sta il `memcmp`, misurato

**Quale funzione.** Nel profilo V8 della prima coppia di `docs/FOUR_PLAYER_ATTRIBUTION.md`, il
chiamante del `memcmp` è `gx::record_draw` in 7.001 campioni su 7.004 a due personaggi e in 13.600
su 13.613 a quattro: è
`TextureSnapshotCache::capture` → `equal`, inlinati in `record_draw` attraverso `snapshot_textures`
(`port/runtime/gx/gx_core.cpp`). I restanti campioni sono `parse_command`.

**Quasi tutto sullo stage: vero, e quanto è il resto.** Per proprietario del disegno, media delle
tre coppie di profili:

| | 2 pers. ms | 4 pers. ms |
| --- | ---: | ---: |
| stage | 1,99 | 3,79 |
| personaggi | 0,06 | 0,35 |
| HUD, effetti, altro | 0,02 | 0,02 |
| **totale** | 2,06 | 4,17 |

Lo stage è il 96% del `memcmp` a due personaggi e il 91% a quattro; i personaggi sono il 3% e
l'8,5%.

**Quante chiamate, quanti byte** (patch 0011, `/work/texture_capture.csv`, media per fotogramma di
partita 1–715):

| | 2 pers. | 4 pers. |
| --- | ---: | ---: |
| catture di texture | 670 | 939 |
| scorciatoia della versione RAM presa | 605 (90,3%) | 823 (87,6%) |
| confronti eseguiti | 64 | 114 |
| byte confrontati | 1.011 KiB | 2.143 KiB |
| byte per confronto | 16.184 | 19.189 |
| texture nuove (hash + copia) | 1,3 | 1,7 |

E il perché, per motivo della scorciatoia mancata:

| motivo | 2 pers. /fotogramma | KiB | 4 pers. /fotogramma | KiB | poi **uguali** |
| --- | ---: | ---: | ---: | ---: | ---: |
| store del guest in un blocco sorvegliato da 64 KB | 26,2 | 836 | 57,0 | 1.821 | **100%** |
| un caricamento TLUT qualunque (versione palette = generazione TMEM globale) | 9,5 | 102 | 27,0 | 249 | **100%** |
| altro indirizzo o dimensione della palette | 28,2 | 73 | 30,4 | 74 | **100%** |
| indirizzo mai visto | 1,3 | — | 1,7 | — | — |

**Ogni scorciatoia mancata finisce in un confronto che risponde "uguale".** Su 2400 retrace per
carico, 81.400 confronti a due personaggi e 120.429 a quattro: nessuno ha trovato un byte diverso.
Sono tutte false invalidazioni. L'ipotesi di `docs/FOUR_PLAYER_ATTRIBUTION.md` è confermata nella
forma e misurata nella misura: i blocchi da 64 KB toccati dagli store del guest sono la voce
principale (83% dei byte a due personaggi, 85% a quattro), e raddoppiano con due personaggi in più
(26 → 57 mancate, texture di ~32 KB l'una: quelle dello stage). La seconda voce non era nell'ipotesi:
la versione della palette è la generazione globale della TMEM, quindi **qualunque** caricamento di
una TLUT invalida tutte le texture con palette, e a quattro personaggi succede 2,8 volte di più.

## La modifica

```cpp
inline bool same_bytes(const uint8_t* a, const uint8_t* b, size_t size);
```

Sotto 8 byte, un ciclo per byte. Da 8 in su: quattro parole da 8 byte per passo (lette con `memcpy`,
quindi senza vincoli di allineamento), poi parole singole, e infine **gli ultimi 8 byte letti come
una parola che si sovrappone** alle precedenti: nessun byte di coda resta fuori e nessuno è letto
oltre `size`. Stessa risposta booleana di `!memcmp`; `equal` usa solo quella.

È la tecnica di PR #125 (le costanti del renderer, 0,91×), applicata alla cattura delle texture.

## La prova

1. **Traccia identica**, `c79c53b9…`, per A e per B (corsa di parità, 2400 retrace, headless). Non
   basta da sola: le istantanee delle texture non tornano mai nel guest, quindi la traccia dice solo
   che la simulazione non è cambiata.
2. **Corpus differenziale** contro `!memcmp`, `wasm/probe/texture_compare_test.cpp`, compilato in
   WASM a `-O2` (il livello di `gx_core.cpp`, sorgente calda) e a `-Oz` (il default del core), e
   eseguito sotto Node sul runner x86 e su quello arm64 (`wasm-probe.yml`):
   - **2.493.568** casi esaustivi: ogni lunghezza 0..160 × ogni coppia di offset di partenza 0..7,
     uguali, poi ogni byte cambiato a turno con tre maschere (bit basso, bit alto, tutti), poi un
     byte diverso subito prima e subito dopo l'intervallo (non deve contare);
   - **760.848** casi sulle dimensioni reali: ogni catena di mip che `texture_chain_bytes` dà per
     ogni formato GX fino a 256 KB, più le tre dimensioni di palette, con la differenza al primo
     byte, all'ultimo, negli ultimi otto, ai confini di parola e a caso;
   - **40.000.000** casi casuali, lunghezze sbilanciate verso il piccolo e fino a 72 KB, offset
     casuali, da zero a tre differenze concentrate nei primi e negli ultimi 8 byte.

   **43.254.416 casi per configurazione, 0 discordanze** in tutte e quattro (x86 e arm64, `-O2` e
   `-Oz`), digest delle risposte identico (`e15e09e04e98db6f`). Il corpus è stato verificato contro
   implementazioni rotte apposta: senza il confronto della coda (110.350 discordanze su 3,45 M),
   con l'ultimo byte ignorato (27.238), con il ciclo sotto 8 che salta l'ultimo byte (3.421), con il
   ciclo a parole fermo una parola prima (82.662).
3. **Differenziale sui dati veri del gioco.** I contatori della patch 0011 registrano l'esito di
   ogni confronto (uguale → si riusa l'istantanea, diverso → hash e copia). Il file
   `texture_capture.csv` di A e quello di B sono **identici byte per byte**, per entrambi i carichi
   e per tutti i 2400 retrace: 201.829 confronti reali, 2,79 GiB di texture, la stessa risposta. (Sono
   tutti confronti "uguali": i casi "diversi" li copre il corpus.)

## Cosa resta, e la prossima leva

Dopo la modifica la cattura costa ~0,8 ms a due personaggi e ~1,2 a quattro (timer interni). Il
confronto è più veloce, ma **non serviva quasi mai**: il 100% dei confronti risponde "uguale". La
leva successiva è eliminarli, non accelerarli ancora:

- **blocchi di guardia più fini** della RAM (oggi 64 KB, `RAM_WATCH_SHIFT = 16`): toglierebbero
  parte delle 26–57 mancate per fotogramma da ~32 KB l'una;
- **versione della palette per intervallo di TMEM**, non globale: oggi ogni caricamento di TLUT
  invalida ogni texture con palette (9,5–27 mancate per fotogramma);
- la voce "altro indirizzo o dimensione" (28–30 per fotogramma, ~2,6 KB l'una) è lo stesso
  indirizzo d'immagine disegnato con un'altra palette o un'altra catena di mip: `last_source` tiene
  una sola voce per indirizzo, quindi due usi alternati si scacciano a vicenda. Il contatore non
  separa i due casi.

Sono cambi di logica della cache, non del confronto: vanno provati con la stessa traccia e con un
oracolo che confronti le istantanee, non con questo corpus.

## Come rifarlo

Script in `/home/hermes/briefs/memcmp/` (fuori dal repository: usano il disco privato):
`fetch.sh <run> <nome>` scarica `melee-spike-dist`; `gate.sh <core> <out>` la traccia;
`counters.sh <core> <out>` le corse con i timer e `texture_capture.csv`; `pairs.sh <A> <B> <2p|4p>
<da> <a> <out>` le coppie alternate; `ab.py <out> <2p|4p>` la tabella; `texcap.py <split>` i
contatori. Nessun dato di gioco è nel repository: `texture_capture.csv` contiene solo conteggi.
