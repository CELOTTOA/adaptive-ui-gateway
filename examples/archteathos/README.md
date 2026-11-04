# Prova AUG con Archteathos

Secondo backend, con le schede effettivamente presenti nel repository Archteathos.
Non vengono copiati dati sintetici né modificati i sorgenti del backend.

## Avvio (PowerShell)

```powershell
cd C:\adaptive-ui-gateway
$env:ARCHTEATHOS_ROOT = 'C:\Archteathos'
npm run demo:archteathos
```

Aprire `http://127.0.0.1:4001`, incollare il token temporaneo stampato nel terminale,
premere **Create search interface**, cercare `Bolzano`, `GM-07` oppure `Udine`.
Una ricerca vuota elenca tutte le sale. `AUG_PORT` permette di scegliere un'altra porta.
Il token cambia a ogni avvio e resta solo nella memoria dei processi e del form.
Per arrestare la prova: Ctrl+C.

## Cosa viene collegato

1. Il runner importa `creaServer()` dal backend esistente, senza eseguirne il launcher
   o caricare `.envlocal`. Usa il suo gestore HTTP reale dietro un filtro che espone
   soltanto GET sui JSON presenti in `simulazione/teatri/`, su loopback e porta libera.
2. L'adattatore legge quelle schede via HTTP, appiattisce otto campi autorizzati e
   offre `GET /theatres?q=...&limit=...`. L'elenco dei file è fissato all'avvio;
   i contenuti sono riletti a ogni query. Errori di una scheda interrompono la query.
3. `openapi.json` dichiara una capability read-only con scope `theatres:read` e
   classificazione `internal`. Credenziale di servizio casuale e tenant singolo
   vengono verificati dall'adattatore.
4. Il gateway AUG applica discovery, catalogo, planner, validazione, sessione e query
   protetta senza modifiche ai relativi package. Il loader della demo standalone ora
   legge l'unica capability autorizzata dal catalogo, invece di fissare quella clienti.
5. Il renderer condiviso costruisce la tabella dal piano; il browser interroga il
   gateway sullo stesso origin. Non servono certificati o modifiche alle policy host.

È un **adattatore specifico**, perché il backend originale offre JSON annidati statici,
non un elenco piatto ricercabile né una specifica OpenAPI. La prova non dimostra
discovery automatica di un backend arbitrario. Non avvia una seconda app Archteathos
completa e non configura il suo server MCP in Claude o ChatGPT.

Le quote provengono solo da `rilevati`; quelle assenti restano `null` (celle vuote).
`stimati` non viene usato come fallback. La fonte originale e la limitazione della vista
sono esposte come colonne. Non viene emesso alcun verdetto di fattibilità e non vengono
chiamati i provider generativi, il motore di simulazione o Blender.

## Collaudo riproducibile

```powershell
$env:ARCHTEATHOS_ROOT = 'C:\Archteathos'
npm run test:archteathos
```

Il collaudo usa HTTP reale e il backend esistente, con un provider di layout **simulato**
che registra il canale per verificarne l'assenza di valori delle schede e token. La demo
interattiva usa invece il planner deterministico; nessuna chiamata a modelli esterni.
I test live del backend sono saltati dalla suite ordinaria senza `ARCHTEATHOS_ROOT`.

Verifiche del 4 novembre 2026: **10/10 superate**, incluse le otto verifiche del backend.
Trovate 13 sale; per Bolzano: boccascena 12 × 7,5 m, profondità utile 15,7 m, capienza 802.
Per Udine le quote del boccascena mancanti restano vuote. Verificati ricerca per codice,
zero risultati, scope/tenant/token negati, session replay negato, rotte generative e file
arbitrari non esposti, assenza dei valori nei canali planner/audit e hash invariati delle
13 schede. Suite ordinaria: **76 superati, 3 live saltati, 0 falliti** (79 totali).

Questo è un test locale dell'integrazione dati e del piano, non una verifica della
connessione nella sandbox di ChatGPT Desktop, né un audit del server Archteathos originale.
