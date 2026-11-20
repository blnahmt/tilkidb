// SSH tunnel: listen on 127.0.0.1:<random>, forward each connection through the SSH
// server to the database host (direct-tcpip, like `ssh -L`).
use crate::store::{SshAuth, SshConfig};
use russh::{
    client::{self, AuthResult, Handle},
    keys::{self, ssh_key, PrivateKeyWithHashAlg},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncRead, io::AsyncWrite, net::TcpListener, task::JoinHandle};

/// Error prefix the UI recognises to offer "Trust this host": HOSTKEY_UNKNOWN|host:port|SHA256:…
pub const UNKNOWN_HOST: &str = "HOSTKEY_UNKNOWN";
const TIMEOUT: Duration = Duration::from_secs(10);

pub struct Tunnel {
    pub local_port: u16,
    task: JoinHandle<()>,
    session: Arc<Handle<HostCheck>>,
}

impl Tunnel {
    /// False once the SSH session has ended (server gone, network dropped, keepalive failed).
    pub fn alive(&self) -> bool {
        !self.session.is_closed() && !self.task.is_finished()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort(); // drops the listener and the SSH session
    }
}

pub fn default_known_hosts() -> Option<PathBuf> {
    std::env::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")), std::env::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    }
}

/// Verifies the server's host key against known_hosts. Unknown keys are refused unless the
/// user explicitly trusted them (then the key is recorded); changed keys are always refused.
struct HostCheck {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    trust_new: bool,
    problem: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let keys::PublicKeyOrCertificate::PublicKey { key, .. } = server_key else {
            *self.problem.lock().unwrap() = Some("SSH host certificates are not supported yet.".into());
            return Ok(false);
        };
        let fp = key.fingerprint(ssh_key::HashAlg::Sha256);
        let known = if self.known_hosts.exists() { keys::check_known_hosts_path(&self.host, self.port, key, &self.known_hosts) } else { Ok(false) };
        match known {
            Ok(true) => Ok(true),
            Ok(false) if self.trust_new => {
                if let Err(e) = keys::known_hosts::learn_known_hosts_path(&self.host, self.port, key, &self.known_hosts) {
                    *self.problem.lock().unwrap() = Some(format!("Could not save the host key to {}: {e}", self.known_hosts.display()));
                    return Ok(false);
                }
                Ok(true)
            }
            Ok(false) => {
                *self.problem.lock().unwrap() = Some(format!("{UNKNOWN_HOST}|{}:{}|{fp}", self.host, self.port));
                Ok(false)
            }
            Err(keys::Error::KeyChanged { line }) => {
                *self.problem.lock().unwrap() = Some(format!(
                    "The SSH host key for {}:{} has CHANGED (now {fp}; known_hosts line {line} has a different one). \
                     Someone may be intercepting the connection. If the server was reinstalled, remove that line from {} and try again.",
                    self.host, self.port, self.known_hosts.display()
                ));
                Ok(false)
            }
            Err(e) => {
                *self.problem.lock().unwrap() = Some(format!("Could not read {}: {e}", self.known_hosts.display()));
                Ok(false)
            }
        }
    }
}

/// `secret` is the SSH password (password auth) or the key passphrase (key auth; may be empty).
pub async fn open(ssh: &SshConfig, target_host: &str, target_port: u16, secret: &str, trust_new: bool, known_hosts: PathBuf) -> Result<Tunnel, String> {
    if ssh.host.trim().is_empty() || ssh.user.trim().is_empty() {
        return Err("SSH host and SSH user are required for the tunnel.".into());
    }
    let problem = Arc::new(Mutex::new(None));
    let check = HostCheck { host: ssh.host.clone(), port: ssh.port, known_hosts, trust_new, problem: problem.clone() };
    let config = Arc::new(client::Config { keepalive_interval: Some(Duration::from_secs(30)), nodelay: true, ..Default::default() });

    let mut session = match tokio::time::timeout(TIMEOUT, client::connect(config, (ssh.host.as_str(), ssh.port), check)).await {
        Err(_) => return Err(format!("SSH: timed out connecting to {}:{}.", ssh.host, ssh.port)),
        Ok(Err(e)) => return Err(problem.lock().unwrap().take().unwrap_or_else(|| format!("SSH: could not connect to {}:{}: {e}", ssh.host, ssh.port))),
        Ok(Ok(s)) => s,
    };

    let ok = match ssh.auth {
        SshAuth::Password => session.authenticate_password(&ssh.user, secret).await.map_err(|e| format!("SSH: {e}"))?.success(),
        SshAuth::Key => {
            let path = expand_home(&ssh.key_file);
            let key = keys::load_secret_key(&path, (!secret.is_empty()).then_some(secret)).map_err(|e| {
                if secret.is_empty() { format!("SSH key {}: {e}. If the key has a passphrase, enter it.", path.display()) } else { format!("SSH key {}: {e}", path.display()) }
            })?;
            let hash = session.best_supported_rsa_hash().await.ok().flatten().flatten();
            session.authenticate_publickey(&ssh.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(|e| format!("SSH: {e}"))?.success()
        }
        SshAuth::Agent => agent_auth(&mut session, &ssh.user).await?,
    };
    if !ok {
        return Err(format!("SSH: the server rejected {} for {}@{}.", match ssh.auth { SshAuth::Password => "the password", SshAuth::Key => "the key", SshAuth::Agent => "every key in the SSH agent" }, ssh.user, ssh.host));
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Could not open a local port for the tunnel: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let session = Arc::new(session);
    let target = target_host.to_string();
    let handle = session.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut sock, peer)) = listener.accept().await {
            let (session, target) = (session.clone(), target.clone());
            tokio::spawn(async move {
                match session.channel_open_direct_tcpip(target, target_port.into(), peer.ip().to_string(), peer.port().into()).await {
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                    }
                    Err(e) => eprintln!("SSH tunnel: could not open a channel: {e}"),
                }
            });
        }
    });
    Ok(Tunnel { local_port, task, session: handle })
}

async fn agent_auth(session: &mut Handle<HostCheck>, user: &str) -> Result<bool, String> {
    #[cfg(windows)]
    {
        if let Ok(agent) = keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            if try_agent(session, user, agent).await? {
                return Ok(true);
            }
        }
        match keys::agent::client::AgentClient::connect_pageant().await {
            Ok(agent) => try_agent(session, user, agent).await,
            Err(_) => Err("No SSH agent found. Start the OpenSSH Authentication Agent service or Pageant.".into()),
        }
    }
    #[cfg(not(windows))]
    {
        let agent = keys::agent::client::AgentClient::connect_env().await.map_err(|_| "No SSH agent found (SSH_AUTH_SOCK is not set).".to_string())?;
        try_agent(session, user, agent).await
    }
}

#[cfg(test)]
mod tests {
    // An in-process SSH server (russh's server side) plus an echo service as the "database".
    // Host and client keys are generated fresh for each test run; none are stored in the repo.
    use super::*;
    use russh::{
        server::{self, Auth, ChannelOpenHandle, Msg, Session, VerifiedPublicKey},
        Channel,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use std::sync::LazyLock;

    fn new_key() -> keys::PrivateKey {
        keys::PrivateKey::random(&mut rand::rng(), keys::Algorithm::Ed25519).unwrap()
    }
    static HOST_KEY: LazyLock<keys::PrivateKey> = LazyLock::new(new_key);
    static CLIENT_KEY: LazyLock<keys::PrivateKey> = LazyLock::new(new_key);

    #[derive(Clone)]
    struct TestServer;

    impl server::Handler for TestServer {
        type Error = russh::Error;
        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            Ok(if user == "tilki" && password == "hunter2" { Auth::Accept } else { Auth::reject() })
        }
        async fn auth_publickey(&mut self, user: &str, key: VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
            Ok(if user == "tilki" && key.public_key == CLIENT_KEY.public_key() { Auth::Accept } else { Auth::reject() })
        }
        async fn channel_open_direct_tcpip(&mut self, channel: Channel<Msg>, host: &str, port: u32, _: &str, _: u32, reply: ChannelOpenHandle, _: &mut Session) -> Result<(), Self::Error> {
            let addr = format!("{host}:{port}");
            reply.accept().await;
            tokio::spawn(async move {
                if let Ok(mut target) = tokio::net::TcpStream::connect(addr).await {
                    let _ = tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut target).await;
                }
            });
            Ok(())
        }
    }

    /// Starts the SSH server and an echo service; returns (ssh port, echo port).
    async fn start() -> (u16, u16) {
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    while let Ok(n) = s.read(&mut buf).await {
                        if n == 0 || s.write_all(&buf[..n]).await.is_err() { break }
                    }
                });
            }
        });
        let config = Arc::new(server::Config {
            keys: vec![HOST_KEY.clone()],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let ssh = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ssh_port = ssh.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((sock, _)) = ssh.accept().await {
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(running) = server::run_stream(config, sock, TestServer).await {
                        let _ = running.await;
                    }
                });
            }
        });
        (ssh_port, echo_port)
    }

    fn cfg(port: u16, auth: SshAuth, key_file: &str) -> SshConfig {
        SshConfig { enabled: true, host: "127.0.0.1".into(), port, user: "tilki".into(), auth, key_file: key_file.into() }
    }

    fn temp_known_hosts(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tilki-kh-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    async fn ping(port: u16) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        s.read_exact(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf).into()
    }

    #[test]
    fn unknown_host_is_refused_then_trusted_then_remembered() {
        tauri::async_runtime::block_on(async {
            let (ssh, echo) = start().await;
            let kh = temp_known_hosts("trust");
            let c = cfg(ssh, SshAuth::Password, "");

            let err = open(&c, "127.0.0.1", echo, "hunter2", false, kh.clone()).await.err().unwrap();
            assert!(err.starts_with(&format!("{UNKNOWN_HOST}|127.0.0.1:{ssh}|SHA256:")), "{err}");
            assert!(!kh.exists(), "refusing must not write known_hosts");

            let t = open(&c, "127.0.0.1", echo, "hunter2", true, kh.clone()).await.unwrap();
            assert_eq!(ping(t.local_port).await, "ping", "data flows through the tunnel");
            assert!(std::fs::read_to_string(&kh).unwrap().contains(&format!("[127.0.0.1]:{ssh} ssh-ed25519 ")));
            drop(t);

            let t2 = open(&c, "127.0.0.1", echo, "hunter2", false, kh.clone()).await.unwrap();
            assert_eq!(ping(t2.local_port).await, "ping");
            let _ = std::fs::remove_file(kh);
        });
    }

    #[test]
    fn changed_host_key_is_always_refused() {
        tauri::async_runtime::block_on(async {
            let (ssh, echo) = start().await;
            let kh = temp_known_hosts("changed");
            // record a different ed25519 key for this host:port
            let other = new_key().public_key().to_openssh().unwrap();
            std::fs::write(&kh, format!("[127.0.0.1]:{ssh} {other}\n")).unwrap();
            let err = open(&cfg(ssh, SshAuth::Password, ""), "127.0.0.1", echo, "hunter2", true, kh.clone()).await.err().unwrap();
            assert!(err.contains("CHANGED"), "{err}");
            let _ = std::fs::remove_file(kh);
        });
    }

    #[test]
    fn wrong_password_is_rejected() {
        tauri::async_runtime::block_on(async {
            let (ssh, echo) = start().await;
            let kh = temp_known_hosts("pw");
            let err = open(&cfg(ssh, SshAuth::Password, ""), "127.0.0.1", echo, "nope", true, kh.clone()).await.err().unwrap();
            assert!(err.contains("rejected the password"), "{err}");
            let _ = std::fs::remove_file(kh);
        });
    }

    #[test]
    fn key_auth_needs_the_passphrase() {
        tauri::async_runtime::block_on(async {
            let (ssh, echo) = start().await;
            let kh = temp_known_hosts("key");
            // the client key, passphrase-protected, in a temp file like a real ~/.ssh key
            let key = std::env::temp_dir().join(format!("tilki-key-{}", std::process::id()));
            let pem = CLIENT_KEY.encrypt(&mut rand::rng(), "secret phrase").unwrap().to_openssh(ssh_key::LineEnding::LF).unwrap();
            std::fs::write(&key, pem.as_bytes()).unwrap();
            let c = cfg(ssh, SshAuth::Key, key.to_str().unwrap());
            let err = open(&c, "127.0.0.1", echo, "", true, kh.clone()).await.err().unwrap();
            assert!(err.contains("passphrase"), "{err}");
            let t = open(&c, "127.0.0.1", echo, "secret phrase", true, kh.clone()).await.unwrap();
            assert_eq!(ping(t.local_port).await, "ping");
            let _ = std::fs::remove_file(kh);
            let _ = std::fs::remove_file(key);
        });
    }
}

async fn try_agent<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(session: &mut Handle<HostCheck>, user: &str, mut agent: keys::agent::client::AgentClient<S>) -> Result<bool, String> {
    let ids = agent.request_identities().await.map_err(|e| format!("SSH agent: {e}"))?;
    for id in ids {
        let keys::agent::AgentIdentity::PublicKey { key, .. } = id else { continue };
        let hash = if matches!(key.algorithm(), ssh_key::Algorithm::Rsa { .. }) { session.best_supported_rsa_hash().await.ok().flatten().flatten() } else { None };
        match session.authenticate_publickey_with(user, key, hash, &mut agent).await {
            Ok(AuthResult::Success) => return Ok(true),
            Ok(_) => continue,
            Err(e) => return Err(format!("SSH agent: {e}")),
        }
    }
    Ok(false)
}
