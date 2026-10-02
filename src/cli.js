#!/usr/bin/env node
'use strict';

// Suppress the experimental warning emitted by `node:sqlite`; this runs before
// anything requires the SQLite binding.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') {
    process.stderr.write(`${warning.stack || String(warning)}\n`);
  }
});

const { readFileSync } = require('node:fs');
const { ValidationError } = require('./errors');
const { Lockstep } = require('./service');

function parseArguments(argv) {
  const options = { command: argv[0], database: 'lockstepnet.db', path: null };
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--database' || name === '--path') {
      if (value === undefined) {
        throw new Error(`${name} requires a value`);
      }
      options[name.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument ${name}`);
    }
  }
  return options;
}

/**
 * Command line companion to the HTTP API.
 *
 *   node src/cli.js verify --path replay.json [--database lockstepnet.db]
 *   node src/cli.js verify --path stored-match.json
 *
 * `verify` re-simulates the replay document and prints the same verdict the
 * `POST /matches/{id}/verify` endpoint returns. Exit code 0 means consistent,
 * 1 means a mismatch was found and 2 means the document was rejected.
 */
function main() {
  const argv = process.argv.slice(2);
  const options = parseArguments(argv);
  if (options.command !== 'verify' || !options.path) {
    process.stdout.write('usage: node src/cli.js verify --path <replay.json> [--database <file>]\n');
    process.exit(2);
  }
  const service = new Lockstep(options.database);
  try {
    const document = JSON.parse(readFileSync(options.path, 'utf8'));
    const result = service.verify({ replay: document });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.consistent ? 0 : 1);
  } catch (error) {
    const code = error instanceof ValidationError ? error.code : 'invalid_replay';
    process.stdout.write(`${JSON.stringify({ error: { code, message: error.message } }, null, 2)}\n`);
    process.exit(2);
  } finally {
    service.close();
  }
}

main();
