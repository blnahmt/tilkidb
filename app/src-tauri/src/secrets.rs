// Connection passwords in the OS keychain (Windows Credential Manager, Linux Secret Service).
use keyring::{Entry, Error};

const SERVICE: &str = "tilki-db";

fn entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, id).map_err(|e| format!("Keychain unavailable: {e}"))
}

/// Empty string when no password was saved (e.g. trust auth or SQLite).
pub fn get(id: &str) -> Result<String, String> {
    match entry(id)?.get_password() {
        Ok(p) => Ok(p),
        Err(Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("Could not read the password from the keychain: {e}")),
    }
}

pub fn set(id: &str, password: &str) -> Result<(), String> {
    entry(id)?.set_password(password).map_err(|e| format!("Could not save the password to the keychain: {e}"))
}

pub fn delete(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the password from the keychain: {e}")),
    }
}
