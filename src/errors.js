'use strict';

/**
 * Error hierarchy shared by the service and the HTTP layer.
 *
 * Every error carries a stable snake_case `code` and the HTTP status the
 * server must use. The HTTP layer serialises them as
 * {"error":{"code":"<snake_case>","message":"..."}}.
 */
class LockstepError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
    this.code = 'internal_error';
    this.status = 500;
  }
}

class ValidationError extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'validation_error';
    this.status = 400;
  }
}

class NotFoundError extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'not_found';
    this.status = 404;
  }
}

class ConflictError extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'conflict';
    this.status = 409;
  }
}

class IntegrityError extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'integrity_failure';
    this.status = 409;
  }
}

module.exports = { LockstepError, ValidationError, NotFoundError, ConflictError, IntegrityError };
