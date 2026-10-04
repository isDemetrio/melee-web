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
