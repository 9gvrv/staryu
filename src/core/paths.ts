import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface AppPaths {
  configDir: string;
  dataDir: string;
  configFile: string;
  credentialsFile: string;
  dbFile: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function platformConfigDir(): string {
  const os = platform();
  if (os === "win32") {
    return join(env("APPDATA") ?? join(homedir(), "AppData", "Roaming"), "staryu");
  }
  if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", "staryu");
  }
  return join(env("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "staryu");
}

function platformDataDir(): string {
  const os = platform();
  if (os === "win32") {
    return join(env("LOCALAPPDATA") ?? join(homedir(), "AppData", "Local"), "staryu");
  }
  if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", "staryu");
  }
  return join(env("XDG_DATA_HOME") ?? join(homedir(), ".local", "share"), "staryu");
}

export function getAppPaths(): AppPaths {
  const configDir = env("STARYU_CONFIG_DIR") ?? platformConfigDir();
  const dataDir = env("STARYU_DATA_DIR") ?? platformDataDir();
  return {
    configDir,
    dataDir,
    configFile: join(configDir, "config.json"),
    credentialsFile: join(configDir, "credentials.json"),
    dbFile: env("STARYU_DB_FILE") ?? join(dataDir, "staryu.db"),
  };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function ensureAppDirs(paths: AppPaths): void {
  ensureDir(paths.configDir);
  ensureDir(paths.dataDir);
  ensureDir(dirname(paths.dbFile));
}
