# Tilki DB — desktop app

Tauri 2 (Rust) + React 19 + TypeScript + Vite. Desktop SQL client for PostgreSQL, MySQL, MariaDB and SQLite. See `../CONTRIBUTING.md` for project rules.

## Run

```powershell
npm install
npm run tauri dev      # desktop window with hot reload
npm run dev            # UI only, in a browser at http://localhost:1420
npm test               # unit tests (Node's built-in runner)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests
npm run tauri build    # installer in src-tauri/target/release/bundle
```

Needs Node 22+, Rust (MSVC toolchain on Windows) and the Visual Studio C++ build tools.

`npm run tauri build` also signs the update files, so it needs the updater signing key. The official
releases are built by `.github/workflows/release.yml` with the key from the repository secrets. To build
locally without it, set `"createUpdaterArtifacts": false` in `src-tauri/tauri.conf.json` for that build.

Installers land in `src-tauri/target/release/bundle/`: `nsis/Tilki DB_<version>_x64-setup.exe`
(per-user install, no admin needed) and `msi/Tilki DB_<version>_x64_en-US.msi`. They are unsigned, so
Windows SmartScreen warns on first run ("More info" → "Run anyway"); a code-signing certificate fixes
that before any public or Microsoft Store release. Linux packages (AppImage/.deb) have to be built on Linux.

## Layout

- `src/App.tsx`: window shell (title bar, rail, sidebar, tabs with split view, status bar), the command palette entries and zoom/density.
- `src/components/`: the UI.
  - Tabs: `QueryTab` (editor, results, transactions, parameters, AI pane), `TableTab` (data and structure), `Notebook`, `ErdView`, `DiffView`, `ActivityView`.
  - Results: `ResultGrid` (virtual grid with editing, range copy and stats), `ChartView`, `PlanView`.
  - Dialogs: `ConnectionDialog`, `ConnectionPicker`, `ImportConnections`, `ExportDialog`, `GuardDialog`.
  - Panels: `SchemaTree`, `HistoryList`, `SavedList`, `Tools` (dump, restore, import and jobs), `Inspector`.
- `src/lib/`: pure logic, each module with its own `*.test.ts`. `api.ts` wraps every Tauri command; `sql.ts` splits statements and detects risky SQL; `erd.ts` lays out and routes the diagram; `schemadiff.ts`, `ddl.ts`, `params.ts`, `gridcopy.ts`, `notebook.ts` and the rest do what their names say.
- `src/theme/themes.ts`, `src/styles/`: color palettes (light/dark) and design tokens.
- `src-tauri/src/`: the Rust core.
  - `lib.rs`: Tauri commands, app state and per-tab sessions.
  - `db.rs`: connection pools for PostgreSQL, MySQL/MariaDB and SQLite.
  - `query.rs`: streaming query runner.
  - `changes.rs`: grid edits.
  - `structure.rs`: DDL, indexes and triggers.
  - `dump.rs`, `restore.rs`, `sqlsplit.rs`: SQL dumps and restores.
  - `import.rs`, `export.rs`: CSV, JSON and XLSX import and export.
  - `importer.rs`: connections from DBeaver, Beekeeper and pgpass.
  - `tunnel.rs`: SSH tunnels.
  - `secrets.rs`: OS keychain.
  - `store.rs`, `history.rs`: saved connections and notebooks, query history.
  - `ai.rs`: optional Claude API.
- App icons are generated from `../mock/tilki-logo.svg` with `npx tauri icon ../mock/tilki-logo.svg`.
