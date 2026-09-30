# Esperimento sul livello di ottimizzazione del core (2026-09-30, notte)

Perché esiste questo documento: la riga del telefono è finita nella fascia "solo desktop". Tre corse
da 2400 retrace sull'iPhone 16 Pro danno una media, nei 762 frame di partita, di **3,2442 ms** nella
corsa peggiore contro la soglia GO di **3 ms**: manca l'8% (`docs/DEVICE_TEST_IPHONE16PRO.md`). Il
core servito è compilato `-Oz`, e questo repository ha già misurato che `-Oz` è circa il **6% più
lento** di `-O1` (media nei frame di partita 28,92 ms contro 27,34 ms, `docs/PROGRESS.md`). Il livello
di ottimizzazione è quindi la prima leva da provare — non l'unica, e non una leva garantita.

## Cosa cambia nel repo

`wasm/core/CMakeLists.txt`

- Il livello è la variabile di cache `MELEE_OPT`, con default `-Oz`, usata sia in compilazione sia in
  link. **Il default non cambia**: una build ordinaria produce esattamente ciò che produceva prima.
- `-ffp-contract=off` e `-fno-fast-math` restano fissi a ogni livello: sono ciò che tiene
  riproducibile l'aritmetica, e nessun esperimento li tocca.
- CMake scrive il livello in vigore in `melee_opt.txt` nella directory di build.

`.github/workflows/phase0-build.yml`

- Nuovo input `opt_level` di `workflow_dispatch`, scelte `-Oz` (default), `-O1`, `-O2`, `-O3`,
  passato a `emcmake` come `-DMELEE_OPT=…`. Nessun effetto sulle run di pull request: senza input
  vale `-Oz`.
- `core.json` del deploy spike legge il livello da `melee_opt.txt` invece di cercarlo con una
  espressione regolare dentro `CMakeLists.txt`. La regex prendeva il **primo** token `-O…` del file,
  che è quello citato in un commento: un core compilato a un altro livello poteva dichiararsi `-Oz`.

## Come si verifica, senza l'operatore

Nessuno di questi passi richiede il telefono o le credenziali Cloudflare.

1. **La PR stessa.** `phase0-build.yml` parte sui percorsi `wasm/**` e `.github/workflows/phase0-build.yml`,
   quindi la PR compila il core, esegue il modulo Node (`--help`, `--check-dol`, ISO mancante), costruisce
   la pagina spike ed esegue il test in Chromium con il disco sintetico. Nel riepilogo della run
   `scripts/phase0/wasm_report.py` stampa per `melee_core_web.wasm` e `melee_core_node.wasm` i byte e
   `within_pages_limit`.
2. **Dispatch da `main`** con `opt_level=-O1`, `upload_module=true`, `upload_spike=true` (circa 33
   minuti di job). Gli artefatti sono privati e durano 3 giorni (`docs/PHASE0_TASKS.md` D3).
3. **Sulla VPS, la parità.** Scaricato il modulo Node con `gh run download`, due corse da 2400 frame:

       scripts/phase0/run_checkpoints.sh melee_core_node.js /home/hermes/incoming/melee-ntsc102.iso \
         <out> 2400 upstream/melee-unlocked/port/scripts/parity_vs_onett.txt

   e poi

       python3 scripts/phase0/compare_checkpoints.py \
         /home/hermes/incoming/phase0/reference-4fba3a0/run-1/trace.csv <out>/trace.csv

   L'esito richiesto è `identical: 2400 retraces`, con la stessa riga `final scene:` e la stessa SHA-1
   della traccia `c79c53b9cdf81426fa0277e7497a69e55bc5f571`. Il modulo Node gira sulla VPS: è una
   build, non un'esecuzione pesante, e non viola la regola "niente build sul VPS".
4. **I tempi si annotano, non decidono.** `scripts/phase0/frame_stats.py` dà media/p95/p99/max, ma su
   2 vCPU condivise sotto Node sono un proxy debole (tre campioni `-Oz` differiscono dell'8% sulla
   media e del 35% sul p99, `docs/PHASE0_DEVICE_PLAN.md` §4 lo dice già).
5. **La misura che conta** resta quella sul telefono: tre corse da 2400 frame con lo stesso metodo di
   `docs/DEVICE_TEST_IPHONE16PRO.md`, che richiede l'operatore.

## Criteri di accettazione

| # | Criterio | Come si legge |
| --- | --- | --- |
| A1 | La traccia è identica su tutti i 2400 checkpoint | `compare_checkpoints.py` → `identical: 2400 retraces` |
| A2 | Il modulo web resta sotto il limite di Pages | `wasm_report.py` → `within_pages_limit: true` per `melee_core_web.wasm` |
| A3 | Il modulo Node si comporta come prima sugli smoke test | gli stessi passi della run verde: `--help`, `--check-dol`, ISO mancante rifiutata, `--sim-times` senza `--fast` rifiutato |
| A4 | Il livello dichiarato è quello compilato | `core.json` dice `-O1` (o il livello chiesto), e il riepilogo della run stampa lo stesso |

Se A1 cade, il livello non è utilizzabile qualunque sia il guadagno: l'esito si scrive e la leva si
chiude. Se cade A2, il livello è troppo grande per Cloudflare Pages e la leva si chiude per quel
livello.

## Cosa questo esperimento NON prova

- **Che il telefono guadagni l'8% che serve.** Il rapporto `-Oz`/`-O1` misurato sulla VPS vale per
  quella macchina, sotto Node, non per JavaScriptCore su un telefono. Un guadagno del 6% porterebbe la
  corsa peggiore da 3,2442 a circa 3,07 ms: **ancora fuori**. La corsa migliore (3,0315) scenderebbe
  a circa 2,87 ms, dentro. Cioè: il livello da solo può spostare la riga, non è detto che la chiuda.
- **Che `-O1` sia il livello migliore.** `-O2` e `-O3` esistono per la stessa misura; l'ordine è
  quello del rischio crescente, non del guadagno noto.
- **Niente su `wasm-opt`, `-msimd128`, LTO o thread.** Sono leve separate, ciascuna con il proprio
  rischio sulla parità bit a bit, e vanno misurate con questo stesso metodo prima di essere credute.

## Esito

**La prima misura: `-O1` è 5,2 volte più grande e non entra nel limite di Pages.**

Dispatch `phase0-build.yml` da `main` (`f008e27`) con `opt_level=-O1`, `upload_module=true`,
`upload_spike=true`: run **36779031737**, success, 2026-09-30 21:22 → 22:00 UTC. Il riepilogo della
run stampa `opt_level=-O1`, e `core.json` dell'artefatto dice `{"commit":"f008e27881e67b5233d8384c60934713b9e92eca","opt":"-O1"}`
— il campo riporta il livello con cui CMake ha configurato, non quello che il workflow intendeva.

| modulo | byte | limite Pages | `within_pages_limit` |
| --- | --- | --- | --- |
| `melee_core_node.wasm` a `-O1` | 85.658.487 | 26.214.400 | **false** |
| `melee_core_web.wasm` a `-O1` | 85.658.030 | 26.214.400 | **false** |
| `melee_core_node.wasm` a `-Oz` (run 36776512026) | 16.323.657 | 26.214.400 | true |
| `melee_core_web.wasm` a `-Oz` (run 36776512026) | 16.323.255 | 26.214.400 | true |

Dove finiscono quei byte, letto aprendo il modulo e non dedotto: la sezione `code` è **84.881.224
byte, il 99,1%** del file. Non è la sezione dei nomi, non è debug information: è codice che `-Oz`
elimina. Quindi l'idea "compila a `-O1` e poi strippa i simboli" non ha nulla da strippare.

**Criterio A2: cade.** Per la strada Cloudflare il livello di ottimizzazione è chiuso: `-Oz` resta il
core spedito, e non per preferenza ma perché a `-O1` il modulo non si può pubblicare. La leva resta
aperta solo dove il limite di 25 MiB non esiste (il tunnel della misura sul telefono, strada D), e
lì ha senso misurarla solo se serve a capire quanto costa `-Oz` in velocità — non a cambiare il core
del prodotto.

La conseguenza utile non è "quindi niente": è che la strada per recuperare velocità senza perdere
dimensione è **un livello per file** — le unità calde (interprete PPC, simulazione) a `-O2`/`-O3` e
tutto il resto a `-Oz`. Costerebbe pochi byte e va misurata con questo stesso metodo (parità 2400
checkpoint, byte, `within_pages_limit`). Non è stato fatto stanotte.

### Parità e tempi del modulo `-O1`

Il modulo Node scaricato dall'artefatto è stato corso due volte sulla VPS contro il disco
dell'operatore, con lo stesso script e gli stessi 2400 frame (`scripts/phase0/run_checkpoints.sh`), e
confrontato con il riferimento nativo `reference-4fba3a0/run-1/trace.csv`.

| corsa | esito | traccia SHA-1 | confronto | media in-match | p95 | p99 | max | orologio |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | `c79c53b9…` | `identical: 2400 retraces` | 28.46 | 35.60 | 51.72 | 84.66 | 90 s |
| 2 | 0 | `c79c53b9…` | `identical: 2400 retraces` | 25.31 | 32.51 | 39.30 | 61.75 | 81 s |

Entrambe finiscono a `mode=2 state=2 match_frame=762`. **`-O1` è bit-identico al nativo**, come lo era
storicamente, e sulla VPS è circa il **7% più veloce** di `-Oz` (media delle medie 26,9 ms contro
28,9 ms delle tre corse `-Oz` dello stesso giorno). Il numero vale per Node su 2 vCPU condivise: è un
proxy, non una misura sul telefono.

**Ma la parità non riabilita `-O1`.** Il criterio che è caduto è la dimensione, non la correttezza:
un modulo corretto che non si può pubblicare resta un modulo che non si può pubblicare. La leva
serve quindi solo a sapere quanto costa `-Oz` in velocità, e a giustificare la strada successiva —
un livello per file.


