Deutsch | [English](README.en.md)

# AgentDock

AgentDock ist ein TypeScript-Workspace, um KI-Agenten und LangGraph-Workflows zu registrieren, auszuführen und zu verwalten. Pakete werden mit Bun verwaltet, ausgeführt wird mit Node.js. Er besteht aus:
- einem API-Server, der Agenten und Workflows registriert und über A2A-JSON-RPC-Endpunkte bereitstellt
- einer Web-Oberfläche für Agenten, Chat, Integrationen, Workflows, Trigger, Freigaben, Evals und Traces
- einer CLI zum Anmelden, zum Anlegen und Hochladen von Agenten und Workflows und zum Senden von Aufgaben an sie
- einem gemeinsamen SDK (`packages/sdk`) mit Schemas, API-Client und Workflow-Laufzeit
- `agentdock-patterns` (`packages/patterns`) mit Multi-Agenten-Mustern für Workflows (Router, Pipeline, Parallelisierung, Orchestrator, Review-Schleifen)

> **Zum Namen:** Es gibt andere Projekte mit dem Namen AgentDock oder einem ähnlichen Namen. Mit diesem Projekt haben sie nichts zu tun: Sie waren uns bei der Entstehung und Namensfindung nicht bekannt und dienten nicht als Vorlage.

## Funktionen

- Agenten-Registry; jeder Agent ist als A2A-Ziel mit Agent Card erreichbar.
- Agenten nehmen jeden Teil einer Nachricht entgegen: Text, Dateien (Bilder, Audio, Dokumente) und Daten.
- Workflows als gewöhnliche LangGraph-Code-Ordner, die mit der CLI geprüft, lokal ausgeführt und hochgeladen werden und als A2A-Ziele erreichbar sind. Sie rufen gebundene Agenten, Integrations-Tools und Plattform-Modelle auf und können auf den Multi-Agenten-Mustern von `agentdock-patterns` aufbauen.
- MCP- und OpenAPI-Integrationen mit OAuth-Verbindungsabläufen, Tool-Freigaben pro Agent und Bestätigung von Tool-Aufrufen. Ein Lauf kann seine MCP-Integrationen auf andere Server umleiten, etwa auf den eigenen Server eines Eval-Falls.
- Skills, Kommunikationsregeln zwischen Agenten sowie Modelle von OpenAI, Anthropic, Google, xAI, Mistral, DeepSeek und Groq.
- Zeitplan-, Webhook- und E-Mail-Trigger sowie Discord- und Teams-Kanäle.
- Eval-Sessions mit Datensätzen und Gradern.
- Ein MCP-Endpunkt (`<api url>/mcp`), über den Coding-Agenten wie Claude Code, Codex und OpenCode die Instanz verwalten können.
- Lokale Persistenz in SQLite und Beispiel-Agenten über das Seed-Skript.
- Jeder Span wird in eine lokale NDJSON-Trace-Datei geschrieben; optional zusätzlich OpenTelemetry-Export über die üblichen `OTEL_*`-Umgebungsvariablen.

## Voraussetzungen

- [Bun](https://bun.sh) 1.3 oder neuer für Paketverwaltung und Skripte.
- Node.js 22 oder neuer zur Ausführung (die CI nutzt Node.js 24). Der API-Server braucht außerdem `bun` im `PATH`, weil er die Abhängigkeiten hochgeladener Workflows mit Bun installiert.
- Ein API-Schlüssel für mindestens einen Modellanbieter. Die Beispiel-Agenten nutzen OpenAI.
- Optional: Docker für den lokalen Observability-Stack (siehe [Observability](#observability)).

## Grundeinrichtung

```bash
git clone <repository url> agentdock
cd agentdock
bun install
```

`bun install` richtet außerdem einen Git-Pre-Commit-Hook ein (über [lefthook](https://lefthook.dev)), der nur formatiert: Er führt `biome format --write` auf den vorgemerkten Dateien aus und merkt sie erneut vor. Linting und Typprüfung laufen beim Commit nicht; das übernimmt die CI.

## Umgebung

Lege eine lokale `.env` aus der Beispieldatei an:

```bash
cp .env.example .env
```

Trage dann in `.env` mindestens Folgendes ein:

```bash
OPENAI_API_KEY=your-openai-api-key
BETTER_AUTH_SECRET=a-long-random-string   # e.g. the output of: openssl rand -base64 32
```

| Variable | Erforderlich | Zweck |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | ja | Signiert Login-Sessions. Ohne sie startet die API nicht, auch nicht bei deaktivierter Authentifizierung. |
| `OPENAI_API_KEY` | für die Beispiel-Agenten | Anbieter-Schlüssel. `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY` und `GROQ_API_KEY` funktionieren genauso. Schlüssel lassen sich auch in der Oberfläche hinterlegen. |
| `AGENTDOCK_SECRET_KEY` | außerhalb der Entwicklung | Hauptschlüssel (mindestens 32 Bytes), mit dem gespeicherte Anbieter-Schlüssel und Zugangsdaten von Integrationen verschlüsselt werden. In der Entwicklung wird ohne diese Variable ein eingebauter, öffentlich bekannter Schlüssel verwendet (die API protokolliert dann eine Warnung); setze also einen eigenen für alles, was du behalten willst. |
| `AGENTDOCK_SERVER_HOST` | nein | Netzwerkschnittstelle, auf der API und Webserver lauschen. Standard ist `127.0.0.1`; mit `0.0.0.0` sind sie auch von anderen Rechnern erreichbar. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | nein | OTLP/HTTP-Collector, an den Spans exportiert werden. Der Beispielwert zeigt auf den Docker-Stack; läuft dieser nicht, protokolliert die API eine Warnung und arbeitet weiter. |
| `TEMPO_URL` | nein | Tempo-Instanz, aus der die Traces-Ansicht liest. |
| `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET` | nein | Microsoft-Graph-App für E-Mail-Trigger. |
| `AGENTDOCK_API_URL`, `AGENTDOCK_PUBLIC_API_URL`, `AGENTDOCK_WEB_ORIGIN` | nein | Nur nötig, wenn die Anwendung nicht über `127.0.0.1` erreicht wird, etwa in einer bereitgestellten Umgebung. |

Die Beispiel-Agenten verwenden standardmäßig `openai:gpt-5.6-luna` mit niedrigem Reasoning-Aufwand. Der OpenAI-Schlüssel ist daher nötig, bevor du mit ihnen chattest oder Workflows ausführst, die sie aufrufen.

Bereits im Klartext gespeicherte Geheimnisse in einer lokalen Datenbank lassen sich einmalig mit `bun run db:encrypt-secrets` verschlüsseln.

## Entwicklungsserver starten

```bash
bun run dev
```

Damit starten API und Oberfläche gemeinsam, und beide URLs werden ausgegeben; Strg+C beendet beide. Öffne die Oberfläche und lege ein Konto an: Das erste Konto auf einer frischen Datenbank wird Admin, spätere Registrierungen sind normale Benutzer. Lokal ohne Authentifizierung arbeitest du mit `bun run dev:no-auth`. Beide Hälften lassen sich weiterhin einzeln mit `bun run api` und `bun run web:dev` starten (bzw. `bun run api:no-auth` und `bun run web:dev:no-auth`).

Die Ports werden aus dem Checkout abgeleitet, nicht konfiguriert: Der Haupt-Checkout nutzt `38123` für die API und
`38124` für die Oberfläche, während jeder verknüpfte Git-Worktree aus seinem Pfad ein eigenes, stabiles Portpaar berechnet.
So können mehrere Checkouts gleichzeitig laufen. `bun run urls` gibt sie aus (`--json` für die maschinelle Weiterverarbeitung),
`bun run kill` gibt sie frei. Mit `AGENTDOCK_PORT_BASE` legst du den API-Port fest; die Oberfläche nimmt den nächsten.

Die API-Dokumentation liegt unter `<api url>/docs`. Die Oberfläche ruft die API direkt aus dem Browser auf;
auch OAuth-Callbacks gehen an die API.

## Beispieldaten anlegen

Lege die Beispiel-Agenten (`planner`, `writer`, `research`, `content-writer`) und ihre Kommunikationsregeln an:

```bash
bun run db:seed
```

Um mit einer leeren lokalen Datenbank neu zu beginnen:

```bash
bun run db:reset
```

Das löscht alle Tabellen, legt das Schema neu an und erzeugt die Beispiel-Agenten erneut. Die Datenbank ist die Datei `agentdock.db` in dem Verzeichnis, aus dem der Server gestartet wird.

Wenn nach einem Pull oder Update etwas nicht mehr funktioniert, hilft oft `bun run db:reset`. Migrationen werden beim Serverstart angewendet, eine alte lokale Datenbank kann die Anwendung aber trotzdem stören, bis sie zurückgesetzt ist.

## CLI

Starte die CLI aus dem Wurzelverzeichnis des Repositorys mit `bun run cli`:

```bash
bun run cli -- --help
```

| Befehl | Zweck |
| --- | --- |
| `login`, `logout`, `whoami` | Anmeldung über den Browser (Device Flow), Abmeldung, aktuellen Benutzer anzeigen. |
| `agents`, `workflows` | Agenten und Workflows auf dem Server auflisten. |
| `send <agent-id> <message>` | Eine Nachricht per A2A an einen Agenten senden und die Antwort streamen. |
| `init` | Ein AgentDock-Projekt (`agentdock.project.json`) im aktuellen Verzeichnis anlegen. |
| `pull`, `push`, `status` | Agenten (`agents/<name>.agent.yaml`) und Workflows des Projekts herunterladen, hochladen und vergleichen. |
| `new <name>` | Einen Workflow-Ordner anlegen. |
| `check [folders…]` | Workflow-Ordner prüfen und ihre Verträge, Topologie und Bindungen ausgeben. |
| `run <folder> <input>` | Einen Workflow-Ordner lokal ohne Server ausführen. |
| `invoke <workflow> <input>` | Einen registrierten Workflow auf dem Server ausführen und seine Events streamen. |
| `runs [run-id]` | Workflow-Läufe auflisten oder einen Lauf mit seinen Schritten und Events anzeigen. |

Zum Beispiel:

```bash
bun run cli -- login
bun run cli -- agents
bun run cli -- send <agent-id> "Summarize this project"
```

Die CLI spricht die API des Checkouts an, in dem sie läuft. Ein anderes Ziel gibst du so an:

```bash
AGENTDOCK_API_URL=http://127.0.0.1:38123 bun run cli -- agents
```

Innerhalb eines mit `init` angelegten Projekts hat die API-URL aus `agentdock.project.json` Vorrang.

Ein installiertes `agentdock`-Programm gibt es nicht. Um die CLI aus einem anderen Verzeichnis zu nutzen, etwa aus einem Workflow-Projekt, lege im Wurzelverzeichnis des Repositorys einen Alias an:

```bash
alias agentdock="$PWD/node_modules/.bin/tsx $PWD/apps/cli/src/index.ts"
```

Das Workflow-Format, der Ablauf mit der CLI und der zur Laufzeit injizierte Kontext sind in [docs/workflows.md](docs/workflows.md) beschrieben, die Multi-Agenten-Muster in [docs/patterns.md](docs/patterns.md). Lauffähige Beispiele liegen in [apps/examples](apps/examples).

## Observability

Die API schreibt ihre Spans immer nach `logs/api.trace.ndjson`. Für einen vollständigen lokalen Stack startest du die Docker-Dienste:

```bash
docker compose -f docker/compose.yaml up -d
```

Damit laufen ein OpenTelemetry-Collector (`4317`/`4318`), Tempo (`3200`), Grafana (`http://localhost:3301`) und Langfuse (`http://localhost:3000`, Login `dev@agentdock.local` / `agentdock-dev`). Die Traces-Ansicht der Anwendung liest aus Tempo. Der Stack verwendet feste Entwicklungs-Zugangsdaten und anonymen Admin-Zugriff auf Grafana; mach ihn daher nicht über deinen Rechner hinaus erreichbar. Details stehen in [docs/operations.md](docs/operations.md).

## Entwicklung

```bash
bun run test          # run the Vitest suite
bun run typecheck     # run TypeScript checks
bun run lint          # run Biome and Oxlint
bun run knip          # find unused files, exports and dependencies
bun run format        # format the repository with Biome
bun run format:check  # check formatting without writing
```

Die CI führt `typecheck`, `format:check`, `lint`, `knip` und `test` bei jedem Merge Request und auf dem Default-Branch aus.

Weitere Dokumentation liegt in [docs/](docs/index.md) und lässt sich mit MkDocs als Website bauen (siehe [docs/operations.md](docs/operations.md#docs-deployment)).

## Fehlerbehebung

### Veraltete Installationen

Wenn die API nach Abhängigkeits-Updates mit einem Fehler abbricht, der auf eine alte Paketversion unter `node_modules/.bun` verweist, baue den Installationsbaum aus der Lockfile neu auf:

```bash
rm -rf node_modules
bun install
```

Bun kann nach Änderungen an transitiven Abhängigkeiten oder Overrides veraltete Paketverzeichnisse in `node_modules/.bun` zurücklassen. Die Lockfile kann korrekt sein, während Node weiterhin ein altes Paket von der Platte lädt, bis `node_modules` neu angelegt wird.

### Zertifikatsfehler hinter einem TLS-aufbrechenden Proxy

Wenn Aufrufe an Modellanbieter mit Zertifikatsfehlern scheitern, weil ein Proxy den TLS-Verkehr neu signiert, gib Node das CA-Zertifikat des Proxys mit:

```bash
NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem bun run api
```

Nur als letzter Ausweg und ausschließlich in der lokalen Entwicklung schaltet `NODE_TLS_REJECT_UNAUTHORIZED=0 bun run api` die Zertifikatsprüfung vollständig ab.

## Lizenz

Lizenziert unter der [Apache License 2.0](LICENSE). Copyright 2026 awa-projekt.
