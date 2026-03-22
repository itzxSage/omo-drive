export function createAudioCapture(elements, state, speechOutput, commands, approvals) {
  async function sendAudio(blob) {
    state.setPTTStatus('Processing...');

    try {
      const formData = new FormData();
      formData.append('audio', blob, 'capture.webm');

      const response = await fetch('/api/stt', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('STT failed');
      }

      const result = await response.json();

      if (result.text) {
        await commands.handleTranscribedText(result.text);
      }

      state.setPTTStatus('Sent');
    } catch (err) {
      console.error('Error sending audio:', err);
      state.showError(`Error sending audio: ${err.message}`);
      state.setPTTStatus('Error sending');
    } finally {
      setTimeout(() => {
        if (!state.isRecording()) {
          state.setPTTStatus('Tap to record');
        }
      }, 2000);
    }
  }

  async function initAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        state.addAudioChunk(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(state.consumeAudioChunks(), { type: 'audio/webm' });
        await sendAudio(audioBlob);
      };

      state.setMediaRecorder(mediaRecorder);
    } catch (err) {
      console.error('Audio initialization failed:', err);
      state.setPTTStatus('Error: No mic access');
      elements.pttButton.disabled = true;
    }
  }

  async function toggleRecording() {
    let mediaRecorder = state.getMediaRecorder();

    if (!mediaRecorder) {
      await initAudio();
      mediaRecorder = state.getMediaRecorder();
    }

    if (!mediaRecorder) {
      return;
    }

    if (!state.isRecording()) {
      if (mediaRecorder.state === 'inactive') {
        speechSynthesis.cancel();
        state.resetAudioChunks();
        mediaRecorder.start();
        state.setRecording(true);
        state.setPTTStatus('Recording...');
      }
      return;
    }

    if (mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      state.setRecording(false);
    }
  }

  return {
    initAudio,
    toggleRecording
  };
}
