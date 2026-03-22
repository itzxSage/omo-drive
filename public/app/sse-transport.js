export function createSSETransport(state, approvals, speechOutput, trustBoot) {
  let reconnectTimer = null;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function isActiveEventSource(eventSource) {
    return state.getEventSource() === eventSource;
  }

  function initSSE() {
    clearReconnectTimer();

    if (state.getEventSource()) {
      return;
    }

    const eventSource = new EventSource('/api/opencode/event');
    state.setEventSource(eventSource);

    eventSource.addEventListener('permission.asked', (event) => {
      if (!isActiveEventSource(eventSource)) {
        return;
      }

      try {
        const payload = JSON.parse(event.data);
        approvals.handlePermissionAsked(payload);
      } catch (err) {
        console.error('Error parsing permission event:', err);
      }
    });

    eventSource.addEventListener('message.part.delta', (event) => {
      if (!isActiveEventSource(eventSource)) {
        return;
      }

      try {
        const payload = JSON.parse(event.data);

        if (payload.sessionID === state.getCurrentSessionId() && payload.field === 'text') {
          speechOutput.handleSpeechDelta(payload.part.delta);
        }
      } catch (err) {
        console.error('Error parsing speech delta:', err);
      }
    });

    eventSource.addEventListener('message.updated', (event) => {
      if (!isActiveEventSource(eventSource)) {
        return;
      }

      try {
        const payload = JSON.parse(event.data);

        if (payload.sessionID === state.getCurrentSessionId() && payload.status === 'finished' && payload.role === 'assistant') {
          speechOutput.flushSpeechBuffer();
        }
      } catch (err) {
        console.error('Error parsing message updated:', err);
      }
    });

    eventSource.onerror = () => {
      if (!isActiveEventSource(eventSource)) {
        return;
      }

      eventSource.close();
      state.setEventSource(null);
      speechOutput.stopSpeaking();
      reconnectSSEIfTrusted();
    };
  }

  async function reconnectSSEIfTrusted() {
    const trustStatus = await trustBoot.fetchTrustStatus();
    trustBoot.applyTrustState(trustStatus);

    if (!trustStatus.trusted) {
      return;
    }

    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      initSSE();
    }, 5000);
  }

  return {
    initSSE,
    reconnectSSEIfTrusted
  };
}
