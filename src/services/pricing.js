import { db, id, timestamp } from '../database/store.js';

const DEFAULT_PRICING = Object.freeze({
  id: 'default-pricing',
  baseFare: 300,
  perKm: 120,
  perMinute: 15,
  minimumFare: 500,
  cashSurcharge: 0,
  nightSurcharge: 0,
  currency: 'NGN',
  version: 1,
  isBootstrapDefault: true,
  updatedAt: null
});

export const getPricing = () => db.pricingConfigs[0] || DEFAULT_PRICING;

const distanceBetween = (a, b) => {
  const rad = (n) => (n * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const lat1 = rad(a.latitude);
  const lat2 = rad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const coords = (p) => ({
  latitude: Number(p.latitude ?? p.lat),
  longitude: Number(p.longitude ?? p.lng)
});

const isNightInLagos = () => {
  const hour = Number(
    new Intl.DateTimeFormat('en-NG', {
      timeZone: 'Africa/Lagos',
      hour: '2-digit',
      hourCycle: 'h23'
    }).format(new Date())
  );

  return hour >= 22 || hour < 5;
};

export const calculateFare = ({
  pickup,
  destination,
  paymentMethod = 'card'
}) => {
  const t = getPricing();
  const distanceKm = distanceBetween(coords(pickup), coords(destination));
  const durationMin = distanceKm === 0 ? 0 : (distanceKm / 30) * 60;
  const distanceFare = Math.round(distanceKm * t.perKm);
  const timeFare = Math.round(durationMin * t.perMinute);
  const nightSurcharge = isNightInLagos() ? Number(t.nightSurcharge || 0) : 0;

  const appFare = Math.max(
    Number(t.minimumFare),
    Number(t.baseFare) + distanceFare + timeFare + nightSurcharge
  );

  const cashSurcharge = Number(t.cashSurcharge || 0);

  return {
    baseFare: Number(t.baseFare),
    distanceFare,
    timeFare,
    nightSurcharge,
    cashSurcharge,
    distanceKm: Number(distanceKm.toFixed(2)),
    durationMin: Math.round(durationMin),
    currency: t.currency || 'NGN',
    appFare,
    totalFare: appFare + (paymentMethod === 'cash' ? cashSurcharge : 0),
    tariffVersion: Number(t.version || 1),
    pricingConfigurationRequired: Boolean(t.isBootstrapDefault)
  };
};

export const savePricing = (values, actorId) => {
  const old = db.pricingConfigs[0];
  const config = {
    id: old?.id || id(),
    ...values,
    currency: 'NGN',
    version: Number(old?.version || 0) + 1,
    isBootstrapDefault: false,
    updatedAt: timestamp(),
    updatedBy: actorId,
    createdAt: old?.createdAt || timestamp()
  };

  if (old) {
    Object.assign(old, config);
  } else {
    db.pricingConfigs.push(config);
  }

  return config;
};

