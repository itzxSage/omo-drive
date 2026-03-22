export function createUIState(elements) {
  const state = {
    mediaRecorder: null,
    audioChunks: [],
    wakeLock: null,
    currentSessionId: crypto.randomUUID(),
    currentPermissionRequest: null,
    speechBuffer: '',
    lastSpokenText: '',
    isRecording: false,
    eventSource: null
  };

  return {
    getMediaRecorder() {
      return state.mediaRecorder;
    },
    setMediaRecorder(mediaRecorder) {
      state.mediaRecorder = mediaRecorder;
    },
    resetAudioChunks() {
      state.audioChunks = [];
    },
    addAudioChunk(chunk) {
      state.audioChunks.push(chunk);
    },
    consumeAudioChunks() {
      const chunks = state.audioChunks;
      state.audioChunks = [];
      return chunks;
    },
    getWakeLock() {
      return state.wakeLock;
    },
    setWakeLock(wakeLock) {
      state.wakeLock = wakeLock;
    },
    getCurrentSessionId() {
      return state.currentSessionId;
    },
    setCurrentSessionId(sessionId) {
      state.currentSessionId = sessionId;
    },
    getCurrentPermissionRequest() {
      return state.currentPermissionRequest;
    },
    setCurrentPermissionRequest(request) {
      state.currentPermissionRequest = request;
    },
    clearCurrentPermissionRequest() {
      state.currentPermissionRequest = null;
    },
    getSpeechBuffer() {
      return state.speechBuffer;
    },
    setSpeechBuffer(text) {
      state.speechBuffer = text;
    },
    appendSpeechBuffer(text) {
      state.speechBuffer += text;
      return state.speechBuffer;
    },
    clearSpeechBuffer() {
      state.speechBuffer = '';
    },
    getLastSpokenText() {
      return state.lastSpokenText;
    },
    setLastSpokenText(text) {
      state.lastSpokenText = text;
    },
    isRecording() {
      return state.isRecording;
    },
    setRecording(isRecording) {
      state.isRecording = isRecording;
      elements.pttButton.classList.toggle('is-recording', isRecording);
    },
    getEventSource() {
      return state.eventSource;
    },
    setEventSource(eventSource) {
      state.eventSource = eventSource;
    },
    setPTTStatus(text) {
      elements.pttStatus.textContent = text;
    },
    setSessionInfo(text) {
      elements.sessionInfo.textContent = text;
    },
    setDebugInputValue(text) {
      elements.debugInput.value = text;
    },
    toggleDebugSection() {
      elements.debugSection.classList.toggle('visible');
    },
    showPermissionOverlay(summary) {
      elements.permissionSummary.textContent = summary;
      elements.permissionOverlay.classList.add('visible');
    },
    hidePermissionOverlay() {
      elements.permissionOverlay.classList.remove('visible');
    },
    setPermissionVoiceActive(isActive) {
      elements.permissionVoiceStatus.classList.toggle('active', isActive);
    },
    setWakeLockStatus(text, isActive = false) {
      elements.wakeLockStatus.textContent = text;
      elements.wakeLockStatus.classList.toggle('active', isActive);
    },
    showError(msg) {
      elements.errorToast.textContent = msg;
      elements.errorToast.classList.add('visible');
      setTimeout(() => {
        elements.errorToast.classList.remove('visible');
      }, 3000);
    }
  };
}
