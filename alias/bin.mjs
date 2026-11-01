#!/usr/bin/env node
// @taprootio/good-agent is an alias for good-agent: same bin, same code.
import { main } from "good-agent/cli";

process.exitCode = await main(process.argv.slice(2));
