#!/usr/bin/env node
// The `good-agent` bin. All behaviour lives in src/cli.mjs.
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
