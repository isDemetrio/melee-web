# T8 — Validazione sul disco reale

Validazione del 2026-10-02 su `/home/hermes/incoming/melee-ntsc102.iso`.
L'operatore ha verificato con `scripts/verify_iso.py`: GALE01, revisione 2,
1.459.978.240 byte, SHA-1 `d4e70c064cc714ba8400a849cf299dbd1aa326fc`.
Questa sessione ha letto solo header e FST con `read_disc`, senza estrarre file
né generare un manifest del disco reale. La FST è a offset 4550144,
misura 29993 byte e descrive **1209 file**, per
**1,426,086,598 byte** di payload (DOL e strutture di sistema esclusi).

## Metodo riproducibile

Dalla radice del repository, senza scrivere dati del gioco:

```sh
PYTHONPATH=scripts python3 - <<'PYCODE'
from collections import Counter
from pathlib import Path
from disc.gcdisc import read_disc
from make_manifest import load_group_rules, group_for
_, entries = read_disc('/home/hermes/incoming/melee-ntsc102.iso')
rules, default = load_group_rules(Path('scripts/asset_groups.json'))
groups = [(e, group_for('files/' + e.path, rules, default)) for e in entries]
for group, count in sorted(Counter(g for _, g in groups).items()):
    print(group, count)
for entry, group in groups:
    if group == 'other':
        print('other:', 'files/' + entry.path, entry.size)
PYCODE
```

Ogni percorso riceve il prefisso `files/` usato dall'estrattore. Si applica
`group_for` del generatore manifest, con precedenza alla prima regola corrispondente.

## Correzioni rispetto alle regole precedenti

Confronto con `scripts/asset_groups.json` al commit `cefdedf0460a8610a3af514a7ff8be2bfe6b9d45`:

| Famiglia | Prima | Dopo |
| --- | ---: | ---: |
| boot | 722 | 440 |
| character:* | 34 | 274 |
| stage:* | 30 | 76 |
| menu | 52 | 104 |
| movies | 76 | 104 |
| music | 210 | 210 |
| other | 85 | 1 |
| **Totale** | **1209** | **1209** |

- Personaggi: la regex accetta suffissi di costume, animazione e copie Kirby,
  oltre a `.usd`: 239 `.dat` passano da boot al personaggio e `PlCaRe.usd`
  passa da other a character:Ca. Kirby raccoglie 59 file.
- Stage: identificatori oltre due caratteri recuperano 41 `.dat` da boot
  (esempi `GrEF1.dat`, `GrNBa.dat`, `GrTCa.dat`, `GrPs1.dat`). Cinque `.usd`
  passano da other allo stage: `GrCn`, `GrHr`, `GrOt`, `GrPs`, `GrVe`.
  La regola specifica Ps1–Ps4 riunisce quattro trasformazioni con Ps:
  stage:Ps ha 6 file, includendo `GrPs.dat` e `GrPs.usd`.
- Menu: i prefissi Sd e TyMn recuperano 20 `.dat` da boot; l'estensione `.usd`
  sui prefissi Gm/Mn/Sd/TyMn recupera altri 32 file da other.
- Filmati: 28 `.mth` prima in other passano a movies (25 `MvEnd*` e
  `MvHowto.mth`, `MvOmake15.mth`, `MvOpen.mth`). `opening.bnr` resta in movies
  per compatibilità: è un banner, non un video.
- Archivi condivisi: il fallback `.usd` recupera 18 file da other a boot;
  il fallback `.dat` rimane. Music conserva 210 file, inclusi i sound bank.

Questa è una validazione della copertura dei nomi nella FST, non una prova delle
dipendenze di caricamento a runtime. Boot è ancora un insieme conservativo di
archivi condivisi, non il minimo insieme necessario all'avvio.

## Elenco completo di other

- `files/usa.ini` — 0 byte.

Il solo `.ini` non corrisponde a una categoria asset specializzata: lasciarlo in
`other` è accettabile per la copertura del manifest, perché viene comunque
incluso e non scartato. La sola FST non dimostra che sia superfluo a runtime:
non va escluso né dichiarato inutilizzato senza una verifica del consumer.

## Conteggi per ogni gruppo

| Gruppo | File |
| --- | ---: |
| `boot` | 440 |
| `character:Bo` | 3 |
| `character:Ca` | 10 |
| `character:Ch` | 3 |
| `character:Cl` | 8 |
| `character:Co` | 1 |
| `character:Dk` | 8 |
| `character:Dr` | 8 |
| `character:Fc` | 7 |
| `character:Fe` | 8 |
| `character:Fx` | 7 |
| `character:Gk` | 3 |
| `character:Gl` | 3 |
| `character:Gn` | 8 |
| `character:Gw` | 4 |
| `character:Kb` | 59 |
| `character:Kp` | 7 |
| `character:Lg` | 7 |
| `character:Lk` | 8 |
| `character:Mh` | 3 |
| `character:Mr` | 8 |
| `character:Ms` | 8 |
| `character:Mt` | 7 |
| `character:Nn` | 6 |
| `character:Ns` | 7 |
| `character:Pc` | 7 |
| `character:Pe` | 8 |
| `character:Pk` | 7 |
| `character:Pp` | 7 |
| `character:Pr` | 8 |
| `character:Sb` | 3 |
| `character:Sk` | 8 |
| `character:Ss` | 8 |
| `character:Ys` | 9 |
| `character:Zd` | 8 |
| `menu` | 104 |
| `movies` | 104 |
| `music` | 210 |
| `other` | 1 |
| `stage:Bb` | 1 |
| `stage:Cn` | 2 |
| `stage:Cs` | 1 |
| `stage:EF1` | 1 |
| `stage:EF2` | 1 |
| `stage:EF3` | 1 |
| `stage:Fs` | 1 |
| `stage:Fz` | 1 |
| `stage:Gb` | 1 |
| `stage:Gd` | 1 |
| `stage:Gr` | 1 |
| `stage:He` | 1 |
| `stage:Hr` | 2 |
| `stage:I1` | 1 |
| `stage:I2` | 1 |
| `stage:Im` | 1 |
| `stage:Iz` | 1 |
| `stage:Kg` | 1 |
| `stage:Kr` | 1 |
| `stage:Mc` | 1 |
| `stage:NBa` | 1 |
| `stage:NBr` | 1 |
| `stage:NFg` | 1 |
| `stage:NKr` | 1 |
| `stage:NLa` | 1 |
| `stage:NPo` | 1 |
| `stage:NSr` | 1 |
| `stage:NZr` | 1 |
| `stage:Ok` | 1 |
| `stage:Op` | 1 |
| `stage:Ot` | 2 |
| `stage:Oy` | 1 |
| `stage:Ps` | 6 |
| `stage:Pu` | 1 |
| `stage:Rc` | 1 |
| `stage:Sh` | 1 |
| `stage:St` | 1 |
| `stage:TCa` | 1 |
| `stage:TCl` | 1 |
| `stage:TDk` | 1 |
| `stage:TDr` | 1 |
| `stage:TFc` | 1 |
| `stage:TFe` | 1 |
| `stage:TFx` | 1 |
| `stage:TGn` | 1 |
| `stage:TGw` | 1 |
| `stage:TIc` | 1 |
| `stage:TKb` | 1 |
| `stage:TKp` | 1 |
| `stage:TLg` | 1 |
| `stage:TLk` | 1 |
| `stage:TMr` | 1 |
| `stage:TMs` | 1 |
| `stage:TMt` | 1 |
| `stage:TNs` | 1 |
| `stage:TPc` | 1 |
| `stage:TPe` | 1 |
| `stage:TPk` | 1 |
| `stage:TPr` | 1 |
| `stage:TSk` | 1 |
| `stage:TSs` | 1 |
| `stage:TYs` | 1 |
| `stage:TZd` | 1 |
| `stage:Te` | 1 |
| `stage:Ve` | 2 |
| `stage:Yt` | 1 |
| `stage:Ze` | 1 |
| **Totale** | **1209** |

## Verifiche di accettazione

- `python3 -m unittest discover -s scripts/tests`: **146 test, OK**.
  Include i quattro test già presenti nel generatore, ora scoperti dalla suite,
  e sette nuovi test: successo/rifiuti del verificatore, pipeline deterministica
  fixture → estrazione → manifest/store, regressioni delle regole corrette.
- Le attese di dimensione e SHA-1 sono adattate solo nei test alla fixture di
  12 KiB; header e hashing sono reali, senza bypass nella CLI di produzione.
- `python3 scripts/check_no_game_data.py --all`: pulito, inclusi i nuovi file
  aggiunti all'indice. Nessun payload del disco reale è stato estratto nel repo.
