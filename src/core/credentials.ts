import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, getAppPaths } from "./paths.ts";

export type TokenSource = "env" | "file" | null;

interface CredentialsFile {
  github_token: string;
  saved_at: string;
}

export function getToken(): { token: string | null; source: TokenSource } {
  const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  const paths = getAppPaths();
  if (!existsSync(paths.credentialsFile)) {
    return { token: null, source: null };
  }

  try {
    const parsed = JSON.parse(readFileSync(paths.credentialsFile, "utf8")) as Partial<CredentialsFile>;
    const token = parsed.github_token?.trim();
    if (token) {
      return { token, source: "file" };
    }
  } catch {
    // Treat a malformed credentials file as missing. The caller can re-authenticate.
  }

  return { token: null, source: null };
}

export function saveToken(token: string): void {
  const paths = getAppPaths();
  ensureDir(paths.configDir);

  const payload = `${JSON.stringify({
    github_token: token,
    saved_at: new Date().toISOString(),
  } satisfies CredentialsFile, null, 2)}\n`;

  if (process.platform === "win32") {
    // Windows rename over an existing file is not reliably atomic.
    writeFileSync(paths.credentialsFile, payload, { mode: 0o600 });
    return;
  }

  const tempFile = join(paths.configDir, `.credentials-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tempFile, payload, { mode: 0o600 });
  try {
    chmodSync(tempFile, 0o600);
  } catch {
    // Windows does not have POSIX permissions; the file still lives in the user's profile.
  }
  renameSync(tempFile, paths.credentialsFile);
}

export function deleteToken(): void {
  const paths = getAppPaths();
  if (existsSync(paths.credentialsFile)) {
    unlinkSync(paths.credentialsFile);
  }
}

export function credentialPermissionWarning(): string | null {
  if (process.platform === "win32") {
    return null;
  }

  const paths = getAppPaths();
  if (!existsSync(paths.credentialsFile)) {
    return null;
  }

  const mode = statSync(paths.credentialsFile).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return `Credentials file ${paths.credentialsFile} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 ${paths.credentialsFile}`;
  }
  return null;
}

export function redactToken(token: string | null): string {
  if (!token) {
    return "(not set)";
  }
  if (token.length <= 8) {
    return "********";
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
