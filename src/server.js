'use strict';

// `node:sqlite` is still flagged experimental; the warning would pollute the
// single stdout line the service is required to print on startup. This runs
// before anything loads the SQLite binding.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') {
    process.stderr.write(`${warning.stack || String(warning)}\n`);
  }
});

const { createServer } = require('./http');
const { Lockstep } = require('./service');

function parseArguments(argv) {
  const options = { database: 'lockstepnet.db', host: '127.0.0.1', port: 18090 };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--host' || name === '--port' || name === '--database') {
      if (value === undefined) {
        throw new Error(`${name} requires a value`);
      }
      options[name.slice(2)] = name === '--port' ? Number(value) : value;
      index += 1;
    } else if (name === '--help' || name === '-h') {
      process.stdout.write('usage: node src/server.js [--host 127.0.0.1] [--port 18090] [--database lockstepnet.db]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${name}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const service = new Lockstep(options.database);
  const server = createServer(service);
  server.listen(options.port, options.host, () => {
    process.stdout.write(`LockstepNet listening on http://${options.host}:${options.port}\n`);
  });
  const shutdown = () => {
    server.close(() => {
      service.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
