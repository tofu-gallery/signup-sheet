// A throwaway certificate authority and a server certificate for 127.0.0.1 and localhost, made with the openssl command
// for one test and deleted with its directory. Never used anywhere else.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function openssl(args: string[], cwd: string): void {
  const binary = process.env.SIGNUP_SHEET_OPENSSL || 'openssl';
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr.slice(-1000)}`);
}

export type TestCa = { dir: string; caPem: string; certFile: string; keyFile: string };

/** A CA in `dir`, and (unless `serverCertificate` is false) a server certificate it signed. */
export function makeTestCa(dir: string, name: string, serverCertificate = true): TestCa {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'ca.cnf'),
    `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = signup-sheet test CA ${name}\n[ca]\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\n`
  );
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key'], dir);
  openssl(['req', '-x509', '-new', '-key', 'ca.key', '-config', 'ca.cnf', '-extensions', 'ca', '-days', '2', '-sha256', '-out', 'ca.crt'], dir);
  const certFile = join(dir, 'server.crt');
  const keyFile = join(dir, 'server.key');
  if (serverCertificate) {
    writeFileSync(join(dir, 'server.cnf'), '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = localhost\n');
    writeFileSync(
      join(dir, 'server.ext'),
      'subjectAltName = DNS:localhost, IP:127.0.0.1\nbasicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = serverAuth\n'
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'server.key'], dir);
    openssl(['req', '-new', '-key', 'server.key', '-config', 'server.cnf', '-out', 'server.csr'], dir);
    openssl(
      ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-sha256', '-extfile', 'server.ext', '-out', 'server.crt'],
      dir
    );
    // PostgreSQL refuses a key others can read.
    chmodSync(keyFile, 0o600);
  }
  return { dir, caPem: readFileSync(join(dir, 'ca.crt'), 'utf8'), certFile, keyFile };
}
