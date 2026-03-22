export function createTrustBoot(state) {
  async function redeemPairingTokenFromURL() {
    const url = new URL(window.location.href);
    const bootstrapToken = url.searchParams.get('pair');

    if (!bootstrapToken) {
      return;
    }

    try {
      const response = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bootstrapToken,
          deviceName: navigator.userAgent.slice(0, 80)
        })
      });

      if (!response.ok) {
        throw new Error('Pairing failed');
      }

      url.searchParams.delete('pair');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch (err) {
      console.error('Pairing error:', err);
      state.showError('Pairing failed');
    }
  }

  async function fetchTrustStatus() {
    try {
      const response = await fetch('/api/trust', { cache: 'no-store' });

      if (!response.ok) {
        return { trusted: false };
      }

      return await response.json();
    } catch (_err) {
      return { trusted: false };
    }
  }

  function applyTrustState(status) {
    if (status && status.trusted) {
      state.setSessionInfo(`Trusted: ${status.deviceName || 'paired device'}`);

      if (!state.isRecording()) {
        state.setPTTStatus('Tap to record');
      }

      return;
    }

    state.setSessionInfo('Pair this device to connect');

    if (!state.isRecording()) {
      state.setPTTStatus('Pair device to connect');
    }
  }

  async function bootstrapApp(services) {
    await redeemPairingTokenFromURL();
    const trustStatus = await fetchTrustStatus();
    applyTrustState(trustStatus);
    services.requestWakeLock();
    services.initAudio();

    if (trustStatus.trusted) {
      services.initSSE();
    }

    return trustStatus;
  }

  return {
    redeemPairingTokenFromURL,
    fetchTrustStatus,
    applyTrustState,
    bootstrapApp
  };
}
