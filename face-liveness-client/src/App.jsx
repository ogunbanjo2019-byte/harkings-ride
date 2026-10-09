import { useCallback, useState } from 'react';
import { FaceLivenessDetector } from '@aws-amplify/ui-react-liveness';
import { Loader, ThemeProvider } from '@aws-amplify/ui-react';

const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const region = import.meta.env.VITE_AWS_REGION;
const consentVersion = import.meta.env.VITE_CONSENT_VERSION || 'face-check-v1';

const createPath = '/api/v1/drivers/verification/face/session';
const finishPath = '/api/v1/drivers/verification/face/complete';
const cancelPath = '/api/v1/drivers/verification/face/cancel';

async function apiRequest(path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.message || payload.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload.error?.code;
    throw error;
  }

  return payload.data ?? payload;
}

async function uploadIdentityDocument(token, file) {
  const form = new FormData();
  form.append('documentType', 'government_id');
  form.append('document', file, file.name);

  const response = await fetch(`${apiBase}/api/v1/drivers/verification/document`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const payload = await response.json().catch(() => ({}));
  
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error?.message || `Upload failed (${response.status})`);
  }

  return payload.data.document;
}

export default function App() {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [driverName, setDriverName] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [consented, setConsented] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState(null);
  const [stage, setStage] = useState('setup');

  const signIn = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      const identifier = email.trim();
      const data = await apiRequest('/api/v1/auth/login', '', {
        ...(identifier.includes('@') ? { email: identifier } : { phone: identifier }),
        password,
      });

      if (!data.accessToken) {
        throw new Error('Sign-in response did not include an access token.');
      }
      if (data.user?.role !== 'driver') {
        throw new Error('Sign in with a SwitchRide driver account to use driver verification.');
      }

      setToken(data.accessToken);
      setDriverName(data.user?.name || data.user?.email || data.user?.phone || identifier);
      setPassword('');
    } catch (err) {
      setError(err.message || 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }, [email, password]);

  const signOut = () => {
    setToken('');
    setDriverName('');
    setDocumentId('');
    setSelectedFile(null);
    setSessionId('');
    setResult(null);
    setConsented(false);
    setNotice('');
    setError('');
    setStage('setup');
  };

  const uploadDocument = useCallback(async () => {
    if (!selectedFile) return;
    setError('');
    setUploading(true);
    try {
      const document = await uploadIdentityDocument(token, selectedFile);
      setDocumentId(document.id);
      setSelectedFile(null);
      setNotice('Identity image uploaded securely. Your private document is selected for face comparison.');
    } catch (err) {
      setError(err.message || 'Could not upload the identity image.');
    } finally {
      setUploading(false);
    }
  }, [selectedFile, token]);

  const createSession = useCallback(async () => {
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const data = await apiRequest(createPath, token.trim(), {
        documentId: documentId.trim(),
        biometricConsent: true,
        consentVersion,
      });
      setSessionId(data.sessionId);
      setStage('capture');
    } catch (err) {
      setError(err.message || 'Could not start verification.');
    } finally {
      setBusy(false);
    }
  }, [token, documentId]);

  const completeSession = useCallback(async () => {
    if (!sessionId) return;
    setError('');
    setBusy(true);
    try {
      const data = await apiRequest(finishPath, token.trim(), { sessionId });
      if (data.status === 'IN_PROGRESS' || data.status === 'CREATED') {
        setError('The liveness result is still processing. Check again in a moment.');
        setStage('processing');
        return;
      }
      setResult(data);
      setStage('done');
    } catch (err) {
      setError(err.message || 'Could not retrieve verification results.');
      setStage(err.status === 422 ? 'failed' : 'processing');
    } finally {
      setBusy(false);
    }
  }, [sessionId, token]);

  const abandonSession = useCallback(async () => {
    if (sessionId && token.trim()) {
      try {
        await apiRequest(cancelPath, token.trim(), { sessionId });
      } catch {
        /* The server session may already be expired. */
      }
    }
    setSessionId('');
    setStage('setup');
    setError('');
    setResult(null);
  }, [sessionId, token]);

  const handleCaptureError = useCallback(async (err) => {
    setError(err?.message || 'The camera/liveness check encountered an error. Your session was closed; start a new attempt.');
    if (sessionId && token.trim()) {
      try {
        await apiRequest(cancelPath, token.trim(), { sessionId });
      } catch {
      }
    }
    setSessionId('');
    setStage('setup');
  }, [sessionId, token]);

  return (
    <ThemeProvider>
      <main className="page">
        <header className="brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>SwitchRide</strong>
            <small>Driver identity check</small>
          </div>
        </header>

        <section className="card">
          <p className="eyebrow">DRIVER VERIFICATION</p>
          <h1>
            {stage === 'capture'
              ? 'Complete the liveness check'
              : stage === 'done'
              ? 'Verification result'
              : 'Verify your identity'}
          </h1>

          {}
          {!token && stage === 'setup' && (
            <>
              <p className="intro">
                Sign in with your existing SwitchRide driver account to begin. Your password and access token are held only in page memory and are not saved.
              </p>
              <label className="field">
                Driver email or phone
                <input
                  type="text"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com or +12345678900"
                />
              </label>
              <label className="field">
                Password
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Your account password"
                />
              </label>
              <button className="primary" disabled={busy || !email.trim() || !password} onClick={signIn}>
                {busy ? 'Signing in…' : 'Sign in securely'}
              </button>
            </>
          )}

          {/* Step 2: Upload Document & Consent */}
          {stage === 'setup' && token && (
            <>
              <div className="signed-in">
                <span>
                  Signed in as <strong>{driverName}</strong>
                </span>
                <button className="link-button" onClick={signOut}>
                  Sign out
                </button>
              </div>
              <p className="intro">
                Upload a clear photo of your identity document, then confirm you are physically present for the live camera check.
              </p>
              <label className="field">
                Government identity document (JPEG or PNG)
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  onChange={(event) => {
                    setSelectedFile(event.target.files?.[0] || null);
                    setDocumentId('');
                    setNotice('');
                  }}
                />
                <span className="hint">
                  Choose a clear, readable image. The file is sent to SwitchRide&apos;s private document storage; the API limit is 5 MB by default.
                </span>
              </label>
              <button
                className="secondary upload-button"
                disabled={!selectedFile || uploading}
                onClick={uploadDocument}
              >
                {uploading ? 'Uploading securely…' : 'Upload and use this ID'}
              </button>
              {documentId && <p className="selected-doc">Private identity image uploaded and selected.</p>}

              <div className="notice">
                <strong>Biometric processing notice</strong>
                <p>
                  A short live video selfie will be processed by Amazon Rekognition to check liveness. A reference image from that check will be compared with the identity document you selected. SwitchRide stores consent metadata and verification scores, but its API does not retain the liveness video or reference image. Results are probabilistic, and a successful automated check does not replace document review or approve your driver account. You may choose not to proceed and contact support for another verification route.
                </p>
              </div>

              <label className="consent">
                <input
                  type="checkbox"
                  checked={consented}
                  onChange={(event) => setConsented(event.target.checked)}
                />
                <span>I have read this notice and consent to this face-liveness and face-comparison processing for driver identity verification.</span>
              </label>

              <button
                className="primary"
                disabled={busy || uploading || !documentId.trim() || !consented}
                onClick={createSession}
              >
                {busy ? 'Preparing secure session…' : 'Continue to camera check'}
              </button>
            </>
          )}

          {/* Step 3: Liveness Capture Stage */}
          {stage === 'capture' && (
            <>
              <p className="intro">
                Follow the on-screen prompts. Use good lighting and keep your face inside the guide. Your camera stream is processed through AWS Amplify and Rekognition.
              </p>
              {busy ? (
                <div className="loader">
                  <Loader />
                </div>
              ) : (
                <FaceLivenessDetector
                  sessionId={sessionId}
                  region={region}
                  onAnalysisComplete={completeSession}
                  onError={handleCaptureError}
                  onUserCancel={abandonSession}
                />
              )}
              <button className="secondary" onClick={abandonSession} disabled={busy}>
                Cancel verification
              </button>
            </>
          )}

          {/* Step 4: Processing State */}
          {stage === 'processing' && (
            <>
              <p className="intro">
                Your capture is complete. AWS is processing the result. You can safely retry the result check; this will not restart the camera capture.
              </p>
              {busy ? (
                <div className="loader">
                  <Loader />
                </div>
              ) : (
                <button className="primary" onClick={completeSession}>
                  Check result
                </button>
              )}
              <button className="secondary" onClick={abandonSession} disabled={busy}>
                Close this attempt
              </button>
            </>
          )}

          {/* Step 5: Failed State */}
          {stage === 'failed' && (
            <>
              <div className="result result-review">
                <h2>New attempt needed</h2>
                <p>
                  This liveness session did not complete. Start a fresh attempt when you are ready. Your driver account has not been approved or rejected.
                </p>
              </div>
              <button
                className="primary"
                onClick={() => {
                  setStage('setup');
                  setSessionId('');
                  setError('');
                }}
              >
                Start a new attempt
              </button>
            </>
          )}

          {/* Step 6: Completed / Result State */}
          {stage === 'done' && result && (
            <div className={`result ${result.status === 'approved' ? 'result-ok' : 'result-review'}`}>
              <h2>{result.status === 'approved' ? 'Face checks passed' : 'Manual review required'}</h2>
              <p>
                {result.status === 'approved'
                  ? 'The automated liveness and face-match thresholds passed. Your driver documents still require the normal review; this does not approve your account.'
                  : 'The automated check was inconclusive or below threshold. Your driver account has not been approved. Please wait for the review outcome or contact support.'}
              </p>
              <button
                className="secondary"
                onClick={() => {
                  setStage('setup');
                  setSessionId('');
                  setResult(null);
                }}
              >
                Return
              </button>
            </div>
          )}

          {notice && (
            <div className="success-notice" role="status">
              {notice}
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
              {stage === 'capture' && (
                <button className="link-button" onClick={completeSession}>
                  Check result
                </button>
              )}
            </div>
          )}

          <footer>
            Consent version {consentVersion} · AWS Region {region} · Session IDs are single-use
          </footer>
        </section>

        <p className="privacy-foot">
          If camera access fails, cancel and start a fresh session. Never share your API token or identity document ID with another person.
        </p>
      </main>
    </ThemeProvider>
  );
}