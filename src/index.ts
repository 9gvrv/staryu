#!/usr/bin/env node
import { buildCli } from "./cli.ts";

if (process.argv.includes("-d") || process.argv.includes("--debug")) {
  process.env.STARYU_DEBUG = "1";
}

await buildCli().parseAsync(process.argv);
