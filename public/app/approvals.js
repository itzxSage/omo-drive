export function createApprovals(state, speechOutput) {
  async function handlePermissionAsked(request) {
    const currentPermissionRequest = state.getCurrentPermissionRequest();

    if (currentPermissionRequest?.id === request.id) {
      return;
    }

    state.setCurrentPermissionRequest({
      ...request,
      source: 'opencode'
    });
    const summary = `Allow ${request.permission} on ${request.patterns.join(', ')}?`;
    state.showPermissionOverlay(summary);

    speechOutput.speak(`Permission requested: ${summary}. Say approve or deny.`);

    setTimeout(() => {
      startVoiceApproval();
    }, 3000);
  }

  async function startVoiceApproval() {
    const mediaRecorder = state.getMediaRecorder();

    if (mediaRecorder && mediaRecorder.state === 'inactive') {
      state.setPermissionVoiceActive(true);
      state.resetAudioChunks();
      mediaRecorder.start();

      setTimeout(() => {
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
          state.setPermissionVoiceActive(false);
        }
      }, 3000);
    }
  }

  async function handleProductApprovalRequested(request) {
    const currentPermissionRequest = state.getCurrentPermissionRequest();

    if (currentPermissionRequest?.id === request.id) {
      return;
    }

    state.setCurrentPermissionRequest({
      ...request,
      source: 'product'
    });
    state.showPermissionOverlay(request.summary);
    speechOutput.speak(`Approval required: ${request.summary}. Say approve or deny.`);

    setTimeout(() => {
      startVoiceApproval();
    }, 3000);
  }

  async function sendPermissionResponse(request, reply, message = '') {
    const currentRequest = typeof request === 'string'
      ? state.getCurrentPermissionRequest()
      : request;

    if (!currentRequest) {
      return;
    }

    try {
      let response;

      if (currentRequest.source === 'product') {
        const outcome = reply === 'once' ? 'approved' : 'denied';
        response = await fetch(`/api/product/actions/${currentRequest.requestId}/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome, rationale: message })
        });
      } else {
        response = await fetch(`/api/opencode/session/${state.getCurrentSessionId()}/permissions/${currentRequest.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply, message })
        });
      }

      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        state.hidePermissionOverlay();
        state.clearCurrentPermissionRequest();

        const screenshot = body?.result?.screenshot;
        if (screenshot?.base64 && screenshot.contentType === 'image/jpeg') {
          const binary = atob(screenshot.base64);
          const bytes = new Uint8Array(binary.length);

          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }

          const blob = new Blob([bytes], { type: screenshot.contentType });
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
        }
      } else {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || 'Approval response failed');
      }
    } catch (err) {
      console.error('Error sending permission response:', err);
      state.showError(`Approval error: ${err.message}`);
    }
  }

  return {
    handlePermissionAsked,
    handleProductApprovalRequested,
    sendPermissionResponse,
    startVoiceApproval
  };
}
