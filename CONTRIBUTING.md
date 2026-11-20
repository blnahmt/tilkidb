# Contributing to Tilki DB

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Accept the [Contributor License Agreement](CLA.md).** On your first pull request a bot asks you to accept it with a one-line comment; accepting once covers all your later contributions. It lets your change ship in the official builds. You keep the copyright in your work.
- **Know the [LICENSE](LICENSE).** The source is under the PolyForm Strict License 1.0.0, with an extra permission to change it for contributions. Keep your fork for contributing only; don't publish builds from it.
- **Open an issue first for bigger changes.** A short description of what you want to build saves both of us time if the idea doesn't fit.
- **Security issues go to [SECURITY.md](SECURITY.md)**, not to public issues.

## Set up

You need Node 22+, Rust (MSVC toolchain on Windows) and the Visual Studio C++ build tools.

```powershell
cd app
npm install
npm run tauri dev
```

Before you open a pull request, run all of these in `app/`:

```powershell
npm test
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
```

## Project rules

- **Engines are fixed:** PostgreSQL, MySQL, MariaDB and SQLite. Pull requests that add other engines will be closed.
- **The UI is English only.**
- **Design:** sharp corners (no rounded boxes) and orthogonal lines in diagrams. Colors come from theme tokens (`app/src/styles/tokens.css`, `app/src/theme/themes.ts`), never hard-coded.
- **Secrets go to the OS keychain** (`secrets.rs`). Never write passwords, API keys or tokens to files, logs or history. Never commit key material, not even for tests.
- **Stream rows, don't collect them.** Results travel from Rust to the UI in batches over a Tauri `ipc::Channel`.
- **Each query tab owns its own session**, so `USE`, `SET` and transactions don't leak between tabs.
- **Tauri commands go through `guarded`**, so a panic becomes an error message instead of a crash.
- **Destructive SQL on production connections goes through the guard dialog** (`lib/sql.ts`).
- **Test new logic:** a unit test next to the module in `app/src/lib/*.test.ts`, or a Rust `#[cfg(test)]` module.
- **Test engine changes on real servers.** Dumps, binary values, identity columns and transactions behave differently on each engine.
- **Write your own code.** Don't paste code from other projects unless their license allows it under the terms in our LICENSE.

## Pull requests

- Keep each pull request to one change.
- Describe what changed and how you tested it. Add a screenshot for UI changes.
- Code, comments and commit messages are in English.
