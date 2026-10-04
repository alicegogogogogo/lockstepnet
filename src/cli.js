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

const { readFileSync, writeFileSync } = require('node:fs');
const { LockstepError } = require('./errors');
const { ErrReplayDiverged, Lockstep } = require('./service');

function parseArguments(argv) {
  const options = { command: argv[0], database: 'lockstepnet.db', match: null, path: null };
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--database' || name === '--path' || name === '--match') {
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

const USAGE = 'usage: node src/cli.js verify --path <replay.json> [--database <file>]\n'
  + '       node src/cli.js export --match <id> --path <replay.lnr> [--database <file>]\n'
  + '       node src/cli.js verify-stream --path <replay.lnr> [--database <file>]\n';

/**
 * Command line companion to the HTTP API.
 *
 *   node src/cli.js verify --path replay.json [--database lockstepnet.db]
 *   node src/cli.js export --match duel-1 --path replay.lnr [--database lockstepnet.db]
 *   node src/cli.js verify-stream --path replay.lnr [--database lockstepnet.db]
 *
 * `verify` re-simulates the replay document and prints the same verdict the
 * `POST /matches/{id}/verify` endpoint returns. `export` writes the confirmed
 * timeline of a stored match as a binary replay stream. `verify-stream`
 * re-simulates such a stream from its embedded configuration and prints the
 * final verified frame and state hash. Exit code 0 means consistent, 1 means
 * a mismatch was found and 2 means the input was rejected.
 */
function main() {
  const argv = process.argv.slice(2);
  const options = parseArguments(argv);
  const service = new Lockstep(options.database);
  try {
    if (options.command === 'verify' && options.path) {
      const document = JSON.parse(readFileSync(options.path, 'utf8'));
      const result = service.verify({ replay: document });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(result.consistent ? 0 : 1);
    }
    if (options.command === 'export' && options.match && options.path) {
      writeFileSync(options.path, service.exportReplay(options.match));
      process.exit(0);
    }
    if (options.command === 'verify-stream' && options.path) {
      try {
        const result = service.verifyReplayBytes(readFileSync(options.path));
        process.stdout.write(`${JSON.stringify({ consistent: true, ...result }, null, 2)}\n`);
        process.exit(0);
      } catch (error) {
        if (error instanceof ErrReplayDiverged) {
          process.stdout.write(`${JSON.stringify({
            consistent: false,
            error: { actual: error.actual, expected: error.expected, frame: error.frame },
          }, null, 2)}\n`);
          process.exit(1);
        }
        throw error;
      }
    }
    process.stdout.write(USAGE);
    process.exit(2);
  } catch (error) {
    const code = error instanceof LockstepError ? error.code : 'invalid_replay';
    process.stdout.write(`${JSON.stringify({ error: { code, message: error.message } }, null, 2)}\n`);
    process.exit(2);
  } finally {
    service.close();
  }
}

main();
