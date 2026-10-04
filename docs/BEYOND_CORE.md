# Fuori dal perimetro simulazione/GX — registro degli esperimenti

Base `2af0cab`, ramo `perf/beyond-core`. Il limite 1,98× di PR #112 resta acquisito;
non viene rimisurato. Nessuna modifica a `wasm/render/*`. Nessun merge autorizzato.

## 1. Contratto del prossimo report operatore

La misura installata da PR #102 è descritta in [ATTACK_RESIDUAL.md](ATTACK_RESIDUAL.md).
Il dato storico è 14,831 / 14,894 / 14,937 ms (D/E/F), **non un guadagno disponibile**.
La prossima acquisizione deve contenere core e shell revisionati, calibrazione nativa,
`queue_probe`, CSV completi e `summary.in_match.residual_attribution` disponibile.
Non basta il vecchio `reconciliation`. Una versione vecchia o un join incompleto
non valgono zero: riportare numero e motivo delle esclusioni.

Protocollo: stessa scena, input, quattro giocatori dichiarati, almeno 3 blocchi da
1200 retrace visibili dopo warm-up; registrare stage, personaggi, temperatura/ordine,
modalità split e disco. Alternare split spento/acceso/spento per stimare perturbazione;
non mescolare i due regimi. Mantenere il timer esterno del ciclo. Il replay canonico
a due personaggi resta separatamente il gate di correttezza.

Sul medesimo insieme di retrace consecutivi, presentare media, p95 assoluto e massimo
assoluto del residuo con segno, e media delle componenti. Cercare nell'ordine:

1. `csv_write_ms`, `heartbeat_read_ms`, `heartbeat_finish_ms`, coda heartbeat:
   una componente grande identifica lavoro di telemetria, non lo rende eliminabile.
2. `native_pre_heartbeat_ms`: bookkeeping nativo prima del bridge; il live non deve
   attivare i checkpoint. Confermare gli argomenti effettivi prima di parlare di hashing.
3. roundtrip nativo e callback JS **dello stesso retrace**: le attese presenti in entrambi
   sono già contabilizzate in ACK/pacing; non aggiungerle né sottrarle due volte.
4. `previous_js_return_to_resume_probe_ms` e `previous_bridge_outside_js_ms`:
   localizzano rispettivamente ritorno JS e somma ingresso/uscita dal bridge. Non
   distinguono da soli CPU, GC, descheduling o sincronizzazione WebKit.
5. `residual_unexplained_ms`: se resta grande, il report **non chiude** l'attribuzione.
   Servono eventi Safari correlati ai retrace e sonde sullo stesso clock per separare
   ingress/egress; non chiamare automaticamente vsync un intervallo da circa 15 ms.

Criterio operativo di chiusura: almeno 99% dei retrace interni validi, residuo medio
assoluto <0,2 ms e p95 assoluto <1 ms, oppure identificazione esplicita della componente
rimasta e seconda misura discriminante. Le soglie sono criteri scelti, non risultati.
Mostrare anche tutte le righe escluse e segmentare in intervalli consecutivi: il termine
`ingress(r)-ingress(r-1)` telescopa soltanto senza buchi. Confrontare il costo dei clock
misurato con il residuo senza sottrarlo automaticamente. Se una componente domina,
la misura successiva disattiva **solo** quel lavoro diagnostico, senza cambiare input,
ACK o pacing, conservando il timer esterno e la traccia canonica.

## 2–6. Misure in preparazione

Il workflow `beyond-core.yml` confronta nello stesso runner baseline/candidato,
AB/BA/AB, tre replay per variante, 762 frame in partita per replay, tutti i 2400
checkpoint vincolati a `c79c53b9cdf81426fa0277e7497a69e55bc5f571`.
Sono tempi WASM/V8 senza WebGPU: non convertibili in millisecondi iPhone.

- **Accessi guest:** già `inline`, tipizzati tramite memcpy senza UB da aliasing;
  forzare l'inlining di accessi, traduzione indirizzi e invalidazione RAM misura la
  differenza tra dichiarazione e decisione effettiva del compilatore a `-Oz`.
  MMIO, locked cache e invalidazioni restano presenti.
- **SIMD:** `-msimd128` su core completo, senza relaxed SIMD o fast math. Questo misura
  la vettorizzazione automatica consentita dalla semantica esistente, non una riscrittura
  di tutti i kernel. Serve anche un banco esplicito di conversioni intere.
- **Altra strada:** `-O2` soltanto nelle unità guest contenenti gli hotspot misurati
  HSD_JObjDisp / SetupEnvelopeModelMtx (più PSMTXConcat se presente), con misura della
  dimensione. Diverso dal precedente O1 globale, già respinto per dimensione.
- **Thread e renderer:** da misurare su snapshot immutabili e output ordinato, senza
  modificare il backend condiviso. Nessun guadagno accreditato prima della misura.

Stato: nessun risultato nuovo ancora acquisito. Nessuna somma di accelerazioni
ipotetiche, nessuna promessa di 60 fps, nessun no-go assoluto.

## Primo risultato: SIMD esplicito e thread (run 37228977884)

[CI](https://github.com/isDemetrio/melee-web/actions/runs/37228977884),
[JSON e macchina](measurements/beyond-kernels-37228977884/). WASM/V8 Node 22,
`-O2 -msimd128`, pool persistente di 2 pthread. Input sintetici immutabili, risultati
consumati nell'ordine originale dopo join. 1386 casi differenziali (11 formati,
3 palette, dimensioni anche incomplete), uguaglianza byte per byte.

| Batch 128×128 | Serial reference ms | SIMD ms | 2 worker ms | SIMD+worker ms |
| --- | ---: | ---: | ---: | ---: |
| 1 RGBA8 | 0,016835 | 0,004657 | 0,042870 | 0,030601 |
| 8 RGBA8 | 0,122974 | 0,032591 | 0,099512 | 0,043435 |
| 64 RGBA8 | 0,985637 | 0,264961 | 0,548006 | 0,178678 |
| 64 RGB565 | 1,671389 | 1,611978 | 0,853513 | 0,858720 |
| 64 CMPR | 1,259124 | 1,275621 | 1,015278 | 1,179972 |

**Verdetto locale:** shuffle intero RGBA8 funziona, circa 3,7× sul batch grande;
non è un 3,7× sul gioco. RGB565/CMPR non hanno un kernel SIMD esplicito in questa
variante: le differenze fra seriale e SIMD lì sono rumore/contesto, non ottimizzazione.
Thread: 1,80× su 64 RGBA8, 1,96× su 64 RGB565, appena 1,24× su CMPR; regressione
2,55× su una sola RGBA8. Pool+barriera costano troppo sui task piccoli. Non moltiplicare
il fattore SIMD per quello thread: la combinazione è misurata separatamente (5,52×
rispetto a seriale su 64 RGBA8, 0,807 ms risparmiati per quel batch).

Non è ancora un prototipo di gioco valido: l'integrazione RGBA8 è nel workflow core,
con la traccia completa e un oracolo distinto che confronta in ordine vertici,
registri/matrici, comandi, copie e tutti i mip delle texture decodificate. Le misure
con hashing grafico sono separate dalle prove di velocità. Tutti i dati di gioco
restano sul runner. Produzione: scegliere il kernel per formato/dimensione, fallback
sui blocchi incompleti; per i thread servono snapshot immutabili, output disgiunti,
join prima del primo upload/draw dipendente, backpressure e limite memoria. Non
spostare FIFO/interrupt né leggere RAM live da un worker. Il costo di questi ultimi
requisiti sul browser di destinazione non è misurato dal pool Node.

Lo script `scripts/phase0/evaluate_residual.py <report.json>` applica il contratto al
prossimo report: un solo cohort completo, segni preservati, errore di riconciliazione,
media/p95/max dei valori assoluti. `closed` significa attribuzione temporale, **non**
che la componente grande sia lavoro eliminabile. I test includono +15/−15 ms che
si cancellano nella media firmata e un vecchio report privo dei nuovi campi.

## Renderer: primo A/B reale, run 37229538592

[CI](https://github.com/isDemetrio/melee-web/actions/runs/37229538592),
[raw](measurements/beyond-renderer-37229538592/renderer.json). Nessun file in
`wasm/render/*` modificato. Backend e generatore WGSL originali compilati Oz/O2;
texture decoder mantenuto O2 su entrambi. Un host sintetico esegue soltanto i sei
registri BP di copia/clear della selftest originale; non pretende di essere il core.
Chromium 141 con software WebGPU, 3 coppie AB/BA/AB, 100 iterazioni × 3 draw ciascuna.
Tempi **per intero batch**, non per frame del gioco:

| Carico | CPU Oz (ms) | CPU O2 (ms) | API intercettate Oz/O2, medie ms |
| --- | --- | --- | --- |
| texture riusata | 40,7 / 32,6 / 42,6 | 45,5 / 43,9 / 38,4 | 8,23 / 13,60 |
| snapshot nuova ogni draw | 46,4 / 44,1 / 59,3 | 70,0 / 66,0 / 54,4 | 18,40 / 23,53 |

Rapporti delle medie CPU: **0,907×** su cache hit, **0,787×** con snapshot nuove.
Nessun vantaggio ripetibile: **zero risparmio accreditato**, non una strada da portare
in produzione sulla base di questo banco. Le misure API sono inclusive dell'overhead
delle sonde; il residuo CPU meno API comprende C++ e JS, non soltanto C++.
Tutti i 12 campioni danno pixel `[128,64,32,192]`, nessun errore WebGPU.

Il drain dopo submit varia **196–328 ms** per 300 draw: il runner software rende
questa misura inadatta a predire la GPU iPhone. Il tempo CPU non esaurisce il costo
end-to-end e il drain non va sommato come costo per ogni singolo frame. Il banco usa
un target texture e non misura composizione/display del telefono. Per quest'ultimo
restano i confini esterni del report operatore, non un numero inventato.

I limiti contano: selftest sintetica con un segmento/draw, non il carico del gioco
con più segmenti. Non prova che il riuso di preparazione per DrawCall sia inutile;
prova solo che il cambio Oz→O2 misurato qui non dimostra un guadagno. L'altro agente
mantiene la proprietà del renderer. Il lavoro di decodifica texture ha invece un
prototipo SIMD separato in verifica sul replay reale.

## Ripetizione kernel e errore del banco memoria

Run [37229535867](https://github.com/isDemetrio/melee-web/actions/runs/37229535867),
[tre JSON](measurements/beyond-kernels-37229535867/): RGBA8/64 seriale
**1,782–1,791 ms**, SIMD **0,482–0,487 ms**, pool **0,949–0,978 ms**, combinazione
**0,288–0,346 ms**. Runner diverso: non confrontare questi valori assoluti col run
precedente. Vantaggio SIMD ripetuto; thread piccoli ancora peggiorano.

Il banco memoria in quel run **non ha prodotto una misura**: OOM perché il modulo
aveva meno dei 24 MiB necessari per la RAM emulata. Il workflow risultava verde
perché `tee` mascherava il fallimento Node. Correzione: 64 MiB iniziali e
`set -euo pipefail`; JSON vuoti esclusi dai risultati. Nessun guadagno attribuito
al banco fallito. Questa anomalia non riguarda il workflow replay, che usa
`subprocess.run(check=True)` e verifica ogni digest.

## Accessi, limiti sollevati e indirizzi costanti: banco corretto

[Run 37229869202](https://github.com/isDemetrio/melee-web/actions/runs/37229869202),
[raw](measurements/beyond-kernels-37229869202/). Il banco usa il vero `ppc::ld32`,
RAM separata, fallback locked-cache/MMIO sintetici, 32 casi di alias/indirizzi non
allineati/confini/overflow. 20.480.000 letture per misura, aritmetica unsigned esatta.

| Compilazione | helper corrente ms | guardia unica per loop ms | rapporto |
| --- | ---: | ---: | ---: |
| Oz | 17,862437 | 13,364476 | 1,337× |
| O2 | 18,085894 | 9,945879 | 1,818× |

Il percorso hoisted controlla tutto il range prima del loop e ricade sull'originale
quando non è interamente RAM; ogni load resta memcpy tipizzato + byteswap. Non
rimuove i controlli indiscriminatamente. È una misura sintetica di un loop eleggibile,
**non** una trasformazione già applicata ai loop guest e non un risparmio di frame.
Per produzione il ricompilatore deve provare range e alias, e spezzare/ricontrollare
la regione presso chiamate e poll eventi: non si può spostare una lettura MMIO o
assumere invarianti i registri attraverso un backedge che consegna eventi.

Indirizzo costante `0x80000100`: helper vs offset pre-risolto, Oz **12,359678→11,009769
ms** sullo stesso numero di iterazioni; a O2 **0,011200→0,008138 ms** perché il
compilatore elimina già le letture ripetute. Questi ultimi microsecondi non sono
un'accelerazione della memoria: mostrano la forza del constant folding su questo
loop. Non trasferire il rapporto a indirizzi dinamici del guest. L'inlining completo
nel gioco è una variante separata, ancora in CI.

## Hot guest O2: risultato nullo, primo oracolo grafico respinto

Run 37229144679, [misure hot](measurements/beyond-core-37229144679/hot/replay.json).
Tre coppie: **8,6055→8,5905**, **8,5495→8,5626**, **8,5394→8,6009 ms** in partita.
Rapporto delle medie **0,9977×**; dimensione **15.241.395→16.867.355 byte**.
Otto tracce CPU (sei cronometrate, due con oracolo) conservano il digest canonico.
Verdetto prestazionale: **nessun guadagno dimostrato**, +10,7% dimensione.

Il confronto grafico ha respinto il run. L'oracolo leggeva `postMatrices` e `lights`
anche quando il decoder le lascia intenzionalmente non inizializzate (`SkipInit`,
`gx_core.cpp` condizioni XF dual-transform e canali illuminati). La correzione usa
le stesse condizioni di cattura, preservando tutti i byte di ogni stato definito;
non azzera stato attivo e non cambia il decoder. Finché il confronto corretto non
passa, questo run **non certifica parità grafica**. Non usare il solo digest CPU
per promuovere alcun prototipo. I replay cronometrati non attivano l'oracolo.
