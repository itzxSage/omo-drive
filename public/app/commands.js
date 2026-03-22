export function createCommands(state, speechOutput, approvals) {
  const inFlightMessageKeys = new Set();

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function toSessionList(payload) {
    const candidates = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.sessions)
        ? payload.sessions
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.items)
            ? payload.items
            : isRecord(payload?.sessions)
              ? Object.values(payload.sessions)
              : [];

    return candidates
      .map((entry) => {
        if (typeof entry === 'string') {
          return { id: entry };
        }

        if (!isRecord(entry)) {
          return null;
        }

        const id = entry.id || entry.sessionID || entry.sessionId || entry.session?.id || entry.session?.sessionID || entry.session?.sessionId;
        return typeof id === 'string' && id.trim() ? { id: id.trim() } : null;
      })
      .filter(Boolean);
  }

  function toProviders(payload) {
    const providers = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.providers)
        ? payload.providers
        : Array.isArray(payload?.data)
          ? payload.data
          : isRecord(payload?.providers)
            ? Object.entries(payload.providers).map(([id, provider]) => ({ id, ...provider }))
            : isRecord(payload)
              ? Object.entries(payload)
                .filter(([, provider]) => isRecord(provider) && ('models' in provider || 'defaultModel' in provider))
                .map(([id, provider]) => ({ id, ...provider }))
              : [];

    return providers
      .map((provider) => {
        if (!isRecord(provider)) {
          return null;
        }

        const providerId = typeof provider.id === 'string' && provider.id.trim()
          ? provider.id.trim()
          : typeof provider.name === 'string' && provider.name.trim()
            ? provider.name.trim()
            : null;
        if (!providerId) {
          return null;
        }

        const models = Array.isArray(provider.models)
          ? provider.models
          : Array.isArray(provider.availableModels)
            ? provider.availableModels
            : typeof provider.defaultModel === 'string'
              ? [provider.defaultModel]
              : [];

        return {
          id: providerId,
          models: models
            .map((model) => {
              if (typeof model === 'string') {
                return { id: model };
              }

              if (!isRecord(model)) {
                return null;
              }

              const modelId = model.id || model.name || model.model;
              return typeof modelId === 'string' && modelId.trim() ? { id: modelId.trim() } : null;
            })
            .filter(Boolean)
        };
      })
      .filter(Boolean);
  }

  function toSession(payload) {
    return toSessionList(payload)[0] || (isRecord(payload) && typeof payload.id === 'string' ? { id: payload.id } : null);
  }

  async function submitProductAction(payload) {
    const response = await fetch('/api/product/actions/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const body = await response.json().catch(() => ({}));

    if (body?.status === 'awaiting_approval' && body.approval) {
      approvals.handleProductApprovalRequested(body.approval);
      return body;
    }

    if (!response.ok) {
      throw new Error(body?.error || 'Action failed');
    }

    return body;
  }

  async function sendText(text, inputMode = 'typed') {
    if (!text.trim()) {
      return;
    }

    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    if (trimmed.startsWith('/') || lower.startsWith('slash ') || lower.startsWith('switch model ')) {
      await handleCommand(trimmed);
      return;
    }

    const submissionKey = `${state.getCurrentSessionId()}:${trimmed}`;

    if (inFlightMessageKeys.has(submissionKey)) {
      return;
    }

    try {
      inFlightMessageKeys.add(submissionKey);

      const response = await submitProductAction({
        kind: 'message',
        inputMode,
        sessionId: state.getCurrentSessionId(),
        content: trimmed
      });

      if (response?.status === 'completed') {
        state.setDebugInputValue('');
      }
    } catch (err) {
      console.error('Error sending text:', err);
      state.showError(`Error sending text: ${err.message}`);
    } finally {
      inFlightMessageKeys.delete(submissionKey);
    }
  }

  async function handleCommand(commandText, inputMode = 'typed') {
    let normalized = commandText.trim();

    if (normalized.toLowerCase().startsWith('slash ')) {
      normalized = '/' + normalized.slice(6);
    } else if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }

    const parts = normalized.split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (cmd === '/new') {
      try {
        const res = await fetch('/api/opencode/session', { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body?.error || 'Failed to create session');
        }

        const session = toSession(body);
        if (!session) {
          throw new Error('Session payload missing id');
        }
        state.setCurrentSessionId(session.id);
        state.setSessionInfo(`Session: ${session.id}`);
        speechOutput.speak('Created new session');
      } catch (err) {
        console.error('Failed to create session:', err);
        state.showError(`Failed to create session: ${err.message}`);
      }
      return;
    }

    if (cmd === '/session') {
      try {
        const res = await fetch('/api/opencode/session?limit=5');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body?.error || 'Failed to fetch sessions');
        }

        const sessions = toSessionList(body);

        if (args[0] === 'switch' && args[1]) {
          const idx = parseInt(args[1], 10) - 1;

          if (sessions[idx]) {
            state.setCurrentSessionId(sessions[idx].id);
            state.setSessionInfo(`Session: ${sessions[idx].id}`);
            speechOutput.speak(`Switched to session ${args[1]}`);
          }
        } else {
          if (sessions.length === 0) {
            speechOutput.speak('No recent sessions found');
            return;
          }
          const list = sessions.map((session, index) => `${index + 1}: ${session.id.slice(0, 8)}`).join(', ');
          speechOutput.speak(`Last sessions: ${list}`);
        }
      } catch (err) {
        console.error('Failed to fetch sessions:', err);
        state.showError(`Failed to fetch sessions: ${err.message}`);
      }
      return;
    }

    if (cmd === '/models') {
      try {
        const res = await fetch('/api/opencode/config/providers');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body?.error || 'Failed to fetch models');
        }

        const providers = toProviders(body);

        if (args[0] === 'switch' && args[1]) {
          const [providerId, modelId] = args[1].split('/');
          const switchRes = await fetch('/api/model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerId, modelId })
          });

          if (switchRes.ok) {
            speechOutput.speak(`Switched model to ${args[1]}`);
          } else {
            speechOutput.speak('Failed to switch model');
            state.showError('Failed to switch model');
          }
        } else {
          if (providers.length === 0) {
            speechOutput.speak('No models available');
            return;
          }
          const list = providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`)).join(', ');
          speechOutput.speak(`Available models: ${list}`);
        }
      } catch (err) {
        console.error('Failed to fetch models:', err);
        state.showError(`Failed to fetch models: ${err.message}`);
      }
      return;
    }

    if (cmd === '/switch' && args[0] === 'model' && args[1]) {
      try {
        const [providerId, modelId] = args[1].split('/');
        const switchRes = await fetch('/api/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId, modelId })
        });

        if (switchRes.ok) {
          speechOutput.speak(`Switched model to ${args[1]}`);
        } else {
          speechOutput.speak('Failed to switch model');
          state.showError('Failed to switch model');
        }
      } catch (err) {
        console.error('Failed to switch model:', err);
        state.showError(`Failed to switch model: ${err.message}`);
      }
      return;
    }

    try {
      await submitProductAction({
        kind: 'command',
        inputMode,
        sessionId: state.getCurrentSessionId(),
        name: cmd.slice(1),
        args,
        rawText: normalized
      });
    } catch (err) {
      console.error('Error sending command:', err);
      state.showError(`Error sending command: ${err.message}`);
    }
  }

  async function handleTranscribedText(text) {
    const lower = text.toLowerCase();
    const currentPermissionRequest = state.getCurrentPermissionRequest();

    if (currentPermissionRequest) {
      if (lower.includes('approve') || lower.includes('allow') || lower.includes('yes')) {
        void approvals.sendPermissionResponse(currentPermissionRequest, 'once');
        return;
      }

      if (lower.includes('deny') || lower.includes('no')) {
        void approvals.sendPermissionResponse(currentPermissionRequest, 'reject');
        return;
      }
    }

    await sendText(text, 'voice');
  }

  async function captureScreenshot() {
    state.setPTTStatus('Capturing...');

    try {
      const response = await submitProductAction({
        kind: 'screenshot',
        inputMode: 'product'
      });

      if (response?.status === 'awaiting_approval') {
        state.setPTTStatus('Approval required');
        return;
      }

      const screenshot = response?.result?.screenshot;
      if (!screenshot?.base64 || screenshot.contentType !== 'image/jpeg') {
        throw new Error('Screenshot failed');
      }

      const binary = atob(screenshot.base64);
      const bytes = new Uint8Array(binary.length);

      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const blob = new Blob([bytes], { type: screenshot.contentType });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      state.setPTTStatus('Screenshot opened');
    } catch (err) {
      console.error('Screenshot error:', err);
      state.setPTTStatus('Capture failed');
      state.showError(`Screenshot error: ${err.message}`);
    }
  }

  function repeatLast() {
    if (!speechOutput.repeatLast()) {
      state.showError('Nothing to repeat yet');
    }
  }

  return {
    sendText,
    handleCommand,
    handleTranscribedText,
    captureScreenshot,
    repeatLast
  };
}
