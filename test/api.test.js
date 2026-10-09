import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PROVIDER = 'memory';

const { default: app } = await import('../src/app.js');
const { 
  connectDatabase, 
  closeDatabase, 
  db, 
  persistToDatabase 
} = await import('../src/database/store.js');

await connectDatabase();

// Helper functions
const reset = async () => { 
  Object.keys(db).forEach((key) => { 
    db[key].length = 0; 
  }); 
  await persistToDatabase(); 
};

const register = async (payload) => 
  (await request(app).post('/api/v1/auth/register').send(payload)).body.data;

const authHeader = (token) => ({ 
  Authorization: `Bearer ${token}` 
});

// Hooks
beforeEach(reset);

after(async () => { 
  await new Promise((resolve) => setTimeout(resolve, 150)); 
  await closeDatabase(); 
});

// Test Cases
test('health reports database readiness', async () => { 
  const response = await request(app).get('/health'); 
  
  assert.equal(response.status, 200); 
  assert.equal(response.body.data.database, 'memory'); 
});

test('registers and logs in a rider', async () => { 
  const result = await register({ 
    name: 'Rider One', 
    email: 'rider@example.com', 
    phone: '+234800000001', 
    password: 'Password123!', 
    role: 'rider' 
  }); 

  assert.ok(result.accessToken); 

  const login = await request(app).post('/api/v1/auth/login').send({ 
    email: 'rider@example.com', 
    password: 'Password123!' 
  }); 

  assert.equal(login.status, 200); 
  assert.equal(login.body.data.user.role, 'rider'); 
});

test('blocks rider from driver-only endpoints', async () => { 
  const rider = await register({ 
    name: 'Rider Two', 
    email: 'rider2@example.com', 
    phone: '+234800000002', 
    password: 'Password123!', 
    role: 'rider' 
  }); 

  const response = await request(app)
    .get('/api/v1/drivers/profile')
    .set(authHeader(rider.accessToken)); 

  assert.equal(response.status, 403); 
});

test('enforces approval and subscription before accepting rides', async () => { 
  const rider = await register({ 
    name: 'Rider Three', 
    email: 'rider3@example.com', 
    phone: '+234800000003', 
    password: 'Password123!', 
    role: 'rider' 
  }); 

  const driver = await register({ 
    name: 'Driver One', 
    email: 'driver@example.com', 
    phone: '+234800000004', 
    password: 'Password123!', 
    role: 'driver' 
  }); 

  const ride = await request(app)
    .post('/api/v1/rides')
    .set(authHeader(rider.accessToken))
    .send({ 
      pickup: { latitude: 6.5, longitude: 3.3 }, 
      destination: { latitude: 6.6, longitude: 3.4 }, 
      estimatedFare: 2500 
    }); 

  assert.equal(ride.status, 201); 

  const blocked = await request(app)
    .post(`/api/v1/rides/${ride.body.data.ride.id}/accept`)
    .set(authHeader(driver.accessToken)); 

  assert.equal(blocked.status, 403); 
});

test('runs the approved driver ride lifecycle', async () => { 
  const rider = await register({ 
    name: 'Rider Four', 
    email: 'rider4@example.com', 
    phone: '+234800000005', 
    password: 'Password123!', 
    role: 'rider' 
  }); 

  const driver = await register({ 
    name: 'Driver Two', 
    email: 'driver2@example.com', 
    phone: '+234800000006', 
    password: 'Password123!', 
    role: 'driver' 
  }); 

  // Setup driver active subscription & approval status
  const driverRecord = db.drivers.find((d) => d.userId === driver.user.id); 
  driverRecord.status = 'active'; 
  driverRecord.verificationStatus = 'approved'; 
  
  db.subscriptions.push({ 
    id: 'sub-1', 
    driverId: driverRecord.id, 
    status: 'active', 
    expiresAt: new Date(Date.now() + 86400000).toISOString() 
  }); 

  driverRecord.onlineStatus = true; 

  const ride = await request(app)
    .post('/api/v1/rides')
    .set(authHeader(rider.accessToken))
    .send({ 
      pickup: { latitude: 6.5, longitude: 3.3 }, 
      destination: { latitude: 6.6, longitude: 3.4 }, 
      estimatedFare: 2500 
    }); 

  const rideId = ride.body.data.ride.id; 

  for (const step of ['accept', 'arrived', 'start']) { 
    const response = await request(app)
      .post(`/api/v1/rides/${rideId}/${step}`)
      .set(authHeader(driver.accessToken)); 

    assert.equal(response.status, 200, step); 
  } 

  const completed = await request(app)
    .post(`/api/v1/rides/${rideId}/complete`)
    .set(authHeader(driver.accessToken))
    .send({ fare: 3000 }); 

  assert.equal(completed.status, 200); 
  assert.equal(completed.body.data.ride.status, 'completed'); 
});

test('sends and verifies a single-use email OTP', async () => { 
  const sent = await request(app)
    .post('/api/v1/auth/send-otp')
    .send({ 
      email: 'otp@example.com', 
      purpose: 'login' 
    }); 

  assert.equal(sent.status, 202); 

  const { challengeId, developmentOtp } = sent.body.data; 
  assert.match(developmentOtp, /^\d{6}$/); 

  const verified = await request(app)
    .post('/api/v1/auth/verify-otp')
    .send({ 
      challengeId, 
      otp: developmentOtp, 
      purpose: 'login' 
    }); 

  assert.equal(verified.status, 200); 
  assert.equal(verified.body.data.verified, true); 

  // Ensure single-use verification token cannot be replayed
  const replay = await request(app)
    .post('/api/v1/auth/verify-otp')
    .send({ 
      challengeId, 
      otp: developmentOtp, 
      purpose: 'login' 
    }); 

  assert.equal(replay.status, 400); 
});

