// Optional auto-reconnect: recognise a dropped connection. A pool timeout alone is not one (every
// pooled connection may simply be busy); it counts only when the SSH tunnel behind it has died.
const LOST = /connection (?:refused|reset|closed|lost|was closed)|broken pipe|server has gone away|lost connection to (?:mysql|server)|terminating connection|unexpected eof|unexpected end of file|forcibly closed|connection aborted|no connection to the server|closed the connection|error communicating with database/i;
const POOL_TIMEOUT = /server isn't answering|pool timed out|timed out while waiting for an open connection/i;

export const connectionLost = (message: string) => LOST.test(message);
export const poolTimeout = (message: string) => POOL_TIMEOUT.test(message);

/** Reopen after this error? `tunnelAlive` is asked only for pool timeouts. */
export async function shouldReopen(message: string, tunnelAlive: () => Promise<boolean>): Promise<boolean> {
  if (connectionLost(message)) return true;
  return poolTimeout(message) && !(await tunnelAlive());
}
