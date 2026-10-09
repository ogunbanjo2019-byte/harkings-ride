const counters = {
  requests: 0,
  errors: 0,
  byStatus: {},
  startedAt: new Date().toISOString(),
};

export const requestMetrics = (req, res, next) => {

  req.requestId ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  
  counters.requests += 1;
  res.setHeader('X-Request-Id', req.requestId);

  res.on('finish', () => {
    const key = String(res.statusCode);
    counters.byStatus[key] = (counters.byStatus[key] || 0) + 1;
    
    if (res.statusCode >= 500) {
      counters.errors += 1;
    }
  });

  next();
};
export const metricsSnapshot = () => ({
  ...counters,
  byStatus: { ...counters.byStatus },
  uptimeSeconds: Math.round(process.uptime()),
});