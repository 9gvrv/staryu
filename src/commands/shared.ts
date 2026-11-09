import type { DatabaseSync } from "node:sqlite";
import { ensureAppDirs, getAppPaths, type AppPaths } from "../core/paths.ts";
import { loadConfig, type StaryuConfig } from "../core/config.ts";
import { openDatabase } from "../core/db.ts";
import { createApis, type Apis } from "../core/auth.ts";

export interface Setup {
  paths: AppPaths;
  config: StaryuConfig;
  db: DatabaseSync;
  apis: Apis;
}

export function loadSetup(options: { debug?: boolean } = {}): Setup {
  const paths = getAppPaths();
  ensureAppDirs(paths);
  const config = loadConfig();
  const db = openDatabase(paths.dbFile);
  const apis = createApis({ debug: options.debug });
  return { paths, config, db, apis };
}
