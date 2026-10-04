# Dove va il tempo del core in partita: guest o emulatore, misurato su un motore WebAssembly

2026-10-04, ramo `measure/core-cost-browser`, base `779209f`. Misura, nessuna ottimizzazione:
il core non cambia comportamento (traccia dei 2400 checkpoint `c79c53b9cdf81426fa0277e7497a69e55bc5f571`,
verificata sul modulo profilato, sotto).

## 1. Il discriminante: **emulatore**, non guest

Profilo a campionamento di V8 sul modulo web vero (lo stesso codice che serve la pagina, con i
nomi delle funzioni), finestra esattamente sui retrace di partita 1639–2400 (762 fotogrammi),
renderer attaccato a un WebGPU finto. Ogni campione è assegnato guardando **la pila**, non la foglia:
risalendo dalla foglia, decide il primo frame che è una funzione guest tradotta (`f_XXXXXXXX`) oppure
un punto d'ingresso dell'host (`gx_write`, `submit_and_recycle`, `mmio_*`, `hle::`, …).

| ms/fotogramma (V8, VPS) e quota | renderer attaccato | headless |
| --- | ---: | ---: |
| **corpo del codice guest** (self time delle `f_*`) | 9,44 — **15,1%** | 10,07 — **26,2%** |
| helper di memoria fuori linea (`ppc::ld*/st*`, `psq_load/store`, `host::ptr/rd16/wr16`, `mark_ram_write`) | 7,89 — 12,6% | 8,52 — 22,2% |
| aritmetica emulata (`fma` software + `normalize` della libm, `ppc::fmadd`, `wasm_compat::f*`) | 4,40 — 7,0% | 4,70 — 12,2% |
| contabilità d'ingresso (`ppc::enter`, `trace_enter`, `backedge`) | 1,08 — 1,7% | 1,17 — 3,0% |
| dispatch indiretto (`ppc::call`) e altri helper | 0,77 — 1,2% | 0,78 — 2,0% |
| **GPU emulata: decodifica FIFO GX** (`gx_write` → `parse_command` → `record_draw`, `decode_vertices`) | 17,76 — 28,4% | 12,15 — 31,6% |
| **renderer: `submit_and_recycle`** (C++ del backend e JS `gxw_*`, WebGPU finto incluso) | 19,49 — 31,1% | 0,10 — 0,3% |
| HLE, MMIO non GX, retrace, fuori dal guest | 1,79 — 2,9% | 0,95 — 2,5% |
| **totale campionato** | **62,61** | **38,44** |
| `sim_ms` del core, stessa corsa, media in partita | 62,44 | 38,28 |

Il totale del profilo coincide con il timer del core entro lo 0,4%: i campioni coprono la simulazione.

**Il guest che fa lavoro suo è il 15% del fotogramma con il renderer, il 26% senza.** Il resto
è costo di far girare il guest (helper di memoria, `fma` software, contabilità: 23 punti
attaccato, 39 headless), GPU emulata (28–32 punti) e renderer (31 punti). Il corpo guest è anzi un
**tetto** del lavoro guest: contiene ciò che il compilatore ha inlinato (aggiornamenti dei CR,
conversioni float, i percorsi veloci inlinati); gli accessi in memoria invece sono **fuori linea** in
questo build `-Oz` (`ppc::ld32` è una funzione con nome nel profilo) e quindi sono contati a parte.

### Il profilo nativo, verificato: numeri giusti, lettura sbagliata

Lo stesso profilo V8 headless **riproduce** i numeri nativi: `HSD_JObjDisp` **70,98%** inclusivo
(nativo 70–73%), `SetupEnvelopeModelMtx` **18,93%** (nativo 15,5–16,3%). Ma l'inclusivo di
`HSD_JObjDisp` contiene la GPU emulata: ogni store del guest nel FIFO di GX (`st32` → `mmio_write` →
`gx_write` → `parse_command`) gira **dentro** la pila del guest che l'ha emesso. Separando per pila:

| inclusivo | totale | di cui nella zona guest | di cui GPU emulata / renderer |
| --- | ---: | ---: | ---: |
| `HSD_JObjDisp`, headless | 70,98% | **39,16%** | 31,82% |
| `HSD_JObjDisp`, attaccato | 40,91% | **22,23%** | 18,68% |
| `SetupEnvelopeModelMtx`, headless | 18,93% | 16,81% | 2,12% |
| `PSMTXConcat`, headless | 10,24% | 10,24% | 0 |

E dentro la "preparazione della scena" che resta guest, le matrici costano soprattutto **la `fma`
software**: WebAssembly non ha FMA, `ppc::fmadd` (semantica PowerPC: un solo arrotondamento) chiama
la `fma` della libm, che normalizza in software. Primo chiamante: `PSMTXConcat`
(`fma` ← `ppc::fmadd` ← `PSMTXConcat` ← `SetupEnvelopeModelMtx`). La `fma` con `normalize` vale
**10,0%** del fotogramma headless, contro il **2,0%** del corpo di `PSMTXConcat` stesso.

**Conclusione del punto 1.** I 28,9 ms non sono "il guest che fa matrici": sono soprattutto
emulatore. Ma "emulatore" qui ha **due** superfici, con attrezzi diversi:

- **GPU emulata e renderer** (decodifica FIFO, `record_draw`, `submit_frame`/`draw_segment`, JS
  `gxw_*`): ~60% con il renderer attaccato. Non è il ricompilatore.
- **Emulazione della CPU** (helper di memoria fuori linea, `fma` software, `enter`): ~23% attaccato.
  Questa è del ricompilatore / runtime `ppc`.

## Come è misurato, e i limiti

- **Motore**: V8 di Node 22.22.3 sulla VPS (x86, 2 vCPU condivise), cioè il motore di Chromium, **non**
  JavaScriptCore dell'iPhone. Le quote possono cambiare fra motori; le funzioni chiamate e le pile no.
  V8 in Node 22 **non inlinea** wasm-in-wasm (`--experimental-wasm-inlining` è spento): i confini fra
  funzioni del profilo sono quelli del binario. JSC (OMG) può inlinare: sul telefono la separazione
  per funzione non è ottenibile con questo attrezzo.
- **Modulo**: CI run `37238262782` (`phase0-build.yml`, input `profiling_funcs`): `--profiling-funcs`
  al link e `-g` nel passaggio `wasm-opt`. Rispetto al modulo spedito (`16b80b4`, run `37232193610`)
  la sezione codice differisce di **8 byte su 14.450.571** (ordine di tipi ed export); non è
  byte-identica, quindi la prova di equivalenza è la traccia: corsa `run-trace` del modulo web con nomi,
  2400 retrace, SHA-1 **`c79c53b9cdf81426fa0277e7497a69e55bc5f571`**.
- **Carico**: lo script di parità `parity_vs_onett.txt`, due porte umane su Onett, 762 fotogrammi di
  partita. **Non** quattro giocatori.
- **Renderer**: il WebGPU è finto (conta le chiamate, non fa niente). La zona `render_backend`
  contiene il JS del backend (`gxw_draw__inner` da solo: 23,4%) e il C++ del backend; il costo vero
  delle chiamate WebGPU sul telefono (IPC verso il processo GPU) **non c'è**. Sul telefono quella parte
  è misurata a parte dalla pagina (`webgpu_ms` ≈ 2,6 ms/fotogramma nel rapporto delle 21:45).
- **Campionamento**: intervallo mediano 191 µs, 209.032 campioni attaccato e 133.703 headless; l'errore
  statistico sulle quote è sotto 0,1 punti. Il rumore fra corse sulla VPS è ~10% sul totale
  (`sim_ms` medio 62,4 e 55,5 ms in due corse attaccate identiche): le quote valgono, i millisecondi no.
- **Contatori che non scattano**: nessuno dichiarato qui come zero. Uno scatta inatteso: `ppc::trace_enter`
  è chiamata (0,6–1,1% del fotogramma) — c'è dunque un hook d'ingresso registrato in partita; non è
  stato indagato.
- **Dal VPS al telefono**: la pagina di gioco ha già lo split (casella "core split", patch 0008/0009) che
  sul telefono misura le stesse tre zone con un altro taglio: `end_frame_ms` ≈ renderer,
  `decode_ms − end_frame_ms` ≈ GPU emulata, `non_decode_ms` ≈ zona guest + HLE. Una partita con lo split
  attivo sul telefono, con il build attuale, è la misura che porta il discriminante su JSC.

## Riprodurre

L'imbracatura non è nel repository (fa girare il core privato): `~/incoming/phase0/corecost/prof.mjs`,
derivata dal banco del draw-cost, avvia e ferma il profiler di V8 **in modo sincrono** dentro il
battito del retrace 1638 e del 2400. `NOTRACE=1` passa `--state-trace ''` come la pagina di gioco dopo
la PR #114; `NOATTACH=1` non attacca il renderer.

```sh
gh workflow run phase0-build.yml --ref <ramo> -f upload_spike=true -f profiling_funcs=true
NOTIME=1 NOTRACE=1 node prof.mjs <spike-core> <iso> 2400 run-attached
NOATTACH=1 NOTIME=1 NOTRACE=1 node prof.mjs <spike-core> <iso> 2400 run-headless
NOTIME=1 PROF_FROM=-5 node prof.mjs <spike-core> <iso> 2400 run-trace   # trace.csv per la SHA-1
python3 scripts/analysis/cpuprofile_split.py run-attached/inmatch.cpuprofile --frames 762 \
  --watch HSD_JObjDisp --watch SetupEnvelopeModelMtx --watch PSMTXConcat
```

Lo script di analisi legge solo nomi di funzione e scrive aggregati.
