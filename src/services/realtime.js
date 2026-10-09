import { EventEmitter } from 'node:events';
import { db, findDriverByUser } from '../database/store.js';
const bus = new EventEmitter();
bus.setMaxListeners(1000);

export const emitRealtime = (type, payload) => 
  bus.emit('event', {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    payload,
    at: new Date().toISOString(),
  });

export const emitRideEvent = (ride, type, payload = {}) => 
  emitRealtime(`ride.${type}`, {
    rideId: ride.id,
    status: ride.status,
    ...payload,
  });

export const canAccessRide = (req, ride) => 
  Boolean(
    ride && (
      req.user.role === 'admin' || 
      ride.riderId === req.user.id || 
      (req.user.role === 'driver' && ride.driverId === findDriverByUser(req.user.id)?.id)
    )
  );
export const streamRideEvents = (req, res, ride) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  
  res.flushHeaders?.();
    res.write(
    `event: connected\ndata: ${JSON.stringify({ rideId: ride.id, at: new Date().toISOString() })}\n\n`
  );

  const onEvent = (event) => {
    if (event.payload?.rideId === ride.id) {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
    }
  };
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 20000);

  bus.on('event', onEvent);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('event', onEvent);
  });
};

export const realtimeHealth = () => ({
  transport: 'sse',
  subscribers: bus.listenerCount('event'),
  provider: 'internal-event-bus',
});
void db;