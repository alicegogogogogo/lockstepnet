'use strict';

const { createServer: buildServer } = require('node:http');
const { LockstepError, NotFoundError, ValidationError } = require('./errors');
const { Lockstep } = require('./service');

/**
 * Minimal HTTP layer over the Lockstep service.
 *
 * Routing, request decoding, error mapping and the standard error envelope live
 * here; every product rule lives in `service.js`, `replay.js` and `sim.js`.
 */
const MAX_BODY_BYTES = 1_000_000;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers['content-type'];
    if (contentType === undefined || String(contentType).split(';')[0].trim().toLowerCase() !== 'application/json') {
      reject(new ValidationError('Content-Type must be application/json'));
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ValidationError('request body must be at most 1000000 bytes'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function send(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'Content-Length': body.length,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function sendBytes(response, status, body, contentType) {
  response.writeHead(status, {
    'Content-Length': body.length,
    'Content-Type': contentType,
  });
  response.end(body);
}

/** Read an optional JSON body: a request with no Content-Type carries no body. */
function readOptionalBody(request) {
  if (request.headers['content-type'] === undefined) {
    return Promise.resolve(null);
  }
  return readBody(request);
}

function createHandler(service) {
  return async function handle(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      const parts = url.pathname.split('/').filter((part) => part.length > 0);
      const { method } = request;
      const key = request.headers['idempotency-key'];

      if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
        send(response, 200, { service: 'lockstepnet', status: 'ok' });
        return;
      }
      if (method === 'POST' && parts.length === 1 && parts[0] === 'matches') {
        send(response, 201, service.createMatch(await readBody(request), key));
        return;
      }
      if (parts.length >= 2 && parts[0] === 'matches') {
        const id = decodeURIComponent(parts[1]);
        if (method === 'GET' && parts.length === 2) {
          send(response, 200, service.getState(id));
          return;
        }
        if (method === 'GET' && parts.length === 3 && parts[2] === 'replay') {
          send(response, 200, service.replayFile(id));
          return;
        }
        if (method === 'GET' && parts.length === 3 && parts[2] === 'replay.stream') {
          sendBytes(response, 200, service.replayStream(id), 'application/octet-stream');
          return;
        }
        if (method === 'GET' && parts.length === 3 && parts[2] === 'snapshot') {
          send(response, 200, service.getSnapshot(id, url.searchParams));
          return;
        }
        if (method === 'GET' && parts.length === 3 && parts[2] === 'deltas') {
          send(response, 200, service.getDeltas(id, url.searchParams));
          return;
        }
        if (method === 'POST' && parts.length === 3 && parts[2] === 'inputs') {
          send(response, 201, service.submitInputs(id, await readBody(request), key));
          return;
        }
        if (method === 'POST' && parts.length === 3 && parts[2] === 'tick') {
          send(response, 200, service.advance(id, await readBody(request), key));
          return;
        }
        if (method === 'POST' && parts.length === 3 && parts[2] === 'rollback') {
          const body = await readBody(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isInteger(body.tick)) {
            throw new ValidationError('body must contain an integer tick');
          }
          for (const field of Object.keys(body)) {
            if (field !== 'tick') {
              throw new ValidationError(`body has unknown field ${field}`);
            }
          }
          send(response, 200, service.rollback(id, body.tick));
          return;
        }
        if (method === 'POST' && parts.length === 3 && parts[2] === 'verify') {
          send(response, 200, service.verify(await readBody(request)));
          return;
        }
        if (method === 'POST' && parts.length === 3 && parts[2] === 'sessions') {
          send(response, 201, service.createSession(id, await readBody(request), key));
          return;
        }
        if (method === 'POST' && parts.length === 3 && parts[2] === 'spectators') {
          send(response, 201, service.createSpectator(id, await readBody(request), key));
          return;
        }
        if (parts.length === 5 && parts[2] === 'sessions') {
          const sessionId = decodeURIComponent(parts[3]);
          const action = parts[4];
          if (method === 'POST' && action === 'inputs') {
            send(response, 201, service.submitSessionInputs(id, sessionId, await readBody(request), key));
            return;
          }
          if (method === 'POST' && action === 'disconnect') {
            send(response, 200, service.disconnectSession(id, sessionId, await readOptionalBody(request), key));
            return;
          }
          if (method === 'POST' && action === 'resume') {
            send(response, 200, service.resumeSession(id, sessionId, await readBody(request), key));
            return;
          }
        }
        if (parts.length === 5 && parts[2] === 'spectators') {
          const spectatorId = decodeURIComponent(parts[3]);
          if (method === 'POST' && parts[4] === 'poll') {
            send(response, 200, service.pollSpectator(id, spectatorId, await readBody(request), key));
            return;
          }
        }
      }
      throw new NotFoundError('route was not found');
    } catch (error) {
      if (error instanceof LockstepError) {
        send(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      send(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
    }
  };
}

function createServer(service) {
  return buildServer(createHandler(service));
}

module.exports = { createHandler, createServer };
