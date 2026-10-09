import React from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import '@aws-amplify/ui-react/styles.css';
import '@aws-amplify/ui-react-liveness/styles.css';
import App from './App.jsx';
import './styles.css';

const region = import.meta.env.VITE_AWS_REGION;
const identityPoolId = import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID;
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';

if (import.meta.env.PROD && !apiBaseUrl.startsWith('https://')) {
  throw new Error('Set VITE_API_BASE_URL to the HTTPS SwitchRide API origin before production build.');
}

if (!region || !identityPoolId) {
  throw new Error('Set VITE_AWS_REGION and VITE_COGNITO_IDENTITY_POOL_ID in the client environment.');
}

if (!identityPoolId.startsWith(`${region}:`)) {
  throw new Error('The Cognito Identity Pool ID and AWS region must match.');
}

Amplify.configure({
  Auth: {
    Cognito: {
      identityPoolId,
      allowGuestAccess: true,
    },
  },
});

createRoot(document.getElementById('app')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);