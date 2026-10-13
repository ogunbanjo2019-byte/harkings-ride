const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_ONLY_AUTH_POST_PATH = /^\/api\/v1\/auth\/(?:login|logout|refresh-token)\/?$/;

/**
 * Persist state-changing API responses before sending them to the client.
 * Login, logout, and token refresh only read server state / issue stateless JWTs,
 * so they must not fail merely because a snapshot flush is unavailable.
 */
export function createPersistenceMiddleware(persist, logger = console) {
  return (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) return next();
    if (req.method === 'POST' && READ_ONLY_AUTH_POST_PATH.test(req.path)) return next();

    const sendJson = res.json.bind(res);
    let persistenceStarted = false;

    res.json = (body) => {
      if (persistenceStarted) return res;
      persistenceStarted = true;

      Promise.resolve()
        .then(() => persist())
        .then(() => sendJson(body))
        .catch((error) => {
          logger.error('Database persistence failed:', error.message);
          if (res.headersSent) return;
          res.status(503);
          return sendJson({
            success: false,
            message: 'The request could not be durably saved. Please retry safely.',
            data: null,
            error: { code: 'PERSISTENCE_FAILED', details: null },
          });
        });
      return res;
    };

    next();
  };
}
