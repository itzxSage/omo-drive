const elements = {
  pttButton: document.getElementById('ptt-button'),
  pttStatus: document.getElementById('ptt-status'),
  stopSpeaking: document.getElementById('stop-speaking'),
  repeatLast: document.getElementById('repeat-last'),
  screenshot: document.getElementById('screenshot'),
  sessions: document.getElementById('sessions'),
  models: document.getElementById('models'),
  debugToggle: document.getElementById('debug-toggle'),
  debugSection: document.getElementById('debug-section'),
  debugInput: document.getElementById('debug-input'),
  wakeLockStatus: document.getElementById('wake-lock-status'),
  sessionInfo: document.getElementById('session-info'),
  permissionOverlay: document.getElementById('permission-overlay'),
  permissionSummary: document.getElementById('permission-summary'),
  permissionApprove: document.getElementById('permission-approve'),
  permissionDeny: document.getElementById('permission-deny'),
  permissionVoiceStatus: document.getElementById('permission-voice-status'),
  errorToast: document.getElementById('error-toast')
};

let mediaRecorder;
let audioChunks = [];
let wakeLock = null;
let currentSessionId = crypto.randomUUID();
let currentPermissionRequest = null;
let isWaitingForConfirmation = false;
let pendingRiskyCommand = null;
let speechBuffer = '';
let isRecording = false;

const RISKY_KEYWORDS = ['delete', 'remove', 'rm', 'push', 'deploy', 'prod', 'format', 'reset'];

function showError(msg) {
  elements.errorToast.textContent = msg;
  elements.errorToast.classList.add('visible');
  setTimeout(() => {
    elements.errorToast.classList.remove('visible');
  }, 3000);
}

function initSSE() {
  const eventSource = new EventSource(`/api/opencode/event`);
  
  eventSource.addEventListener('permission.asked', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handlePermissionAsked(payload);
    } catch (err) {
      console.error('Error parsing permission event:', err);
    }
  });

  eventSource.addEventListener('message.part.delta', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.sessionID === currentSessionId && payload.field === 'text') {
        handleSpeechDelta(payload.part.delta);
      }
    } catch (err) {
      console.error('Error parsing speech delta:', err);
    }
  });

  eventSource.addEventListener('message.updated', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.sessionID === currentSessionId && payload.status === 'finished' && payload.role === 'assistant') {
        flushSpeechBuffer();
      }
    } catch (err) {
      console.error('Error parsing message updated:', err);
    }
  });

  eventSource.onerror = (err) => {
    console.error('SSE Error:', err);
    setTimeout(initSSE, 5000);
  };
}

async function handlePermissionAsked(request) {
  currentPermissionRequest = request;
  const summary = `Allow ${request.permission} on ${request.patterns.join(', ')}?`;
  elements.permissionSummary.textContent = summary;
  elements.permissionOverlay.classList.add('visible');
  
  speak(`Permission requested: ${summary}. Say approve or deny.`);
  
  setTimeout(() => {
    startVoiceApproval();
  }, 3000);
}

function speak(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  speechSynthesis.speak(utterance);
}

function handleSpeechDelta(delta) {
  if (!delta) return;
  
  speechBuffer += delta;
  
  const sentences = speechBuffer.split(/([.!?\n]+)/);
  if (sentences.length > 2) {
    const toSpeak = sentences.slice(0, -1).join('');
    speechBuffer = sentences[sentences.length - 1];
    processAndSpeak(toSpeak);
  }
}

function flushSpeechBuffer() {
  if (speechBuffer.trim()) {
    processAndSpeak(speechBuffer);
    speechBuffer = '';
  }
}

function processAndSpeak(text) {
  const cleanText = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .trim();
  
  if (cleanText) {
    speak(cleanText);
  }
}

async function startVoiceApproval() {
  if (mediaRecorder && mediaRecorder.state === 'inactive') {
    elements.permissionVoiceStatus.classList.add('active');
    audioChunks = [];
    mediaRecorder.start();
    
    setTimeout(() => {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        elements.permissionVoiceStatus.classList.remove('active');
      }
    }, 3000);
  }
}

async function sendPermissionResponse(requestId, reply, message = '') {
  try {
    const response = await fetch(`/api/opencode/session/${currentSessionId}/permissions/${requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply, message })
    });
    
    if (response.ok) {
      elements.permissionOverlay.classList.remove('visible');
      currentPermissionRequest = null;
    }
  } catch (err) {
    console.error('Error sending permission response:', err);
  }
}

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      elements.wakeLockStatus.textContent = 'Wake Lock: Active';
      elements.wakeLockStatus.classList.add('active');
      
      wakeLock.addEventListener('release', () => {
        elements.wakeLockStatus.textContent = 'Wake Lock: Released';
        elements.wakeLockStatus.classList.remove('active');
      });
    } catch (err) {
      console.error('Wake Lock error:', err);
      elements.wakeLockStatus.textContent = 'Wake Lock: Failed';
    }
  } else {
    elements.wakeLockStatus.textContent = 'Wake Lock: Unsupported';
  }
}

async function initAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    
    mediaRecorder.ondataavailable = (event) => {
      audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      audioChunks = [];
      await sendAudio(audioBlob);
    };
  } catch (err) {
    console.error('Audio initialization failed:', err);
    elements.pttStatus.textContent = 'Error: No mic access';
    elements.pttButton.disabled = true;
  }
}

async function sendAudio(blob) {
  elements.pttStatus.textContent = 'Processing...';
  try {
    const formData = new FormData();
    formData.append('audio', blob, 'capture.webm');
    
    const response = await fetch('/api/stt', {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) throw new Error('STT failed');
    const result = await response.json();
    
    if (result.text) {
      const text = result.text.toLowerCase();
      
      if (currentPermissionRequest) {
        if (text.includes('approve') || text.includes('allow') || text.includes('yes')) {
          sendPermissionResponse(currentPermissionRequest.id, 'once');
          return;
        } else if (text.includes('deny') || text.includes('no')) {
          sendPermissionResponse(currentPermissionRequest.id, 'reject');
          return;
        }
      }

      if (isWaitingForConfirmation) {
        if (text.includes('confirm') || text.includes('yes')) {
          await sendText(pendingRiskyCommand);
          isWaitingForConfirmation = false;
          pendingRiskyCommand = null;
          return;
        } else {
          speak('Confirmation failed. Command cancelled.');
          isWaitingForConfirmation = false;
          pendingRiskyCommand = null;
          return;
        }
      }

      const isRisky = RISKY_KEYWORDS.some(keyword => text.includes(keyword));
      if (isRisky) {
        isWaitingForConfirmation = true;
        pendingRiskyCommand = result.text;
        speak(`Risky command detected: ${text}. Say confirm to proceed.`);
        return;
      }

      await sendText(result.text);
    }
    elements.pttStatus.textContent = 'Sent';
  } catch (err) {
    console.error('Error sending audio:', err);
    showError(`Error sending audio: ${err.message}`);
    elements.pttStatus.textContent = 'Error sending';
  } finally {
    setTimeout(() => {
      if (!isRecording) {
        elements.pttStatus.textContent = 'Tap to record';
      }
    }, 2000);
  }
}

async function sendText(text) {
  if (!text.trim()) return;
  
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.startsWith('/') || lower.startsWith('slash ') || lower.startsWith('switch model ')) {
    await handleCommand(trimmed);
    return;
  }
  
  try {
    const response = await fetch(`/api/opencode/session/${currentSessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text })
    });
    
    if (!response.ok) throw new Error('Message submission failed');
    elements.debugInput.value = '';
  } catch (err) {
    console.error('Error sending text:', err);
    showError(`Error sending text: ${err.message}`);
  }
}

async function handleCommand(commandText) {
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
      const session = await res.json();
      currentSessionId = session.id;
      elements.sessionInfo.textContent = `Session: ${currentSessionId}`;
      speak('Created new session');
    } catch (err) {
      console.error('Failed to create session:', err);
      showError(`Failed to create session: ${err.message}`);
    }
  } else if (cmd === '/session') {
    try {
      const res = await fetch('/api/opencode/session?limit=5');
      const sessions = await res.json();
      if (args[0] === 'switch' && args[1]) {
        const idx = parseInt(args[1]) - 1;
        if (sessions[idx]) {
          currentSessionId = sessions[idx].id;
          elements.sessionInfo.textContent = `Session: ${currentSessionId}`;
          speak(`Switched to session ${args[1]}`);
        }
      } else {
        const list = sessions.map((s, i) => `${i+1}: ${s.id.slice(0,8)}`).join(', ');
        speak(`Last sessions: ${list}`);
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
      showError(`Failed to fetch sessions: ${err.message}`);
    }
  } else if (cmd === '/models') {
    try {
      const res = await fetch('/api/opencode/config/providers');
      const providers = await res.json();
      if (args[0] === 'switch' && args[1]) {
        const [pId, mId] = args[1].split('/');
        const switchRes = await fetch('/api/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: pId, modelId: mId })
        });
        if (switchRes.ok) {
          speak(`Switched model to ${args[1]}`);
        } else {
          speak('Failed to switch model');
          showError('Failed to switch model');
        }
      } else {
        const list = providers.flatMap(p => p.models.map(m => `${p.id}/${m.id}`)).join(', ');
        speak(`Available models: ${list}`);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      showError(`Failed to fetch models: ${err.message}`);
    }
  } else if (cmd === '/switch' && args[0] === 'model' && args[1]) {
    try {
      const [pId, mId] = args[1].split('/');
      const switchRes = await fetch('/api/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: pId, modelId: mId })
      });
      if (switchRes.ok) {
        speak(`Switched model to ${args[1]}`);
      } else {
        speak('Failed to switch model');
        showError('Failed to switch model');
      }
    } catch (err) {
      console.error('Failed to switch model:', err);
      showError(`Failed to switch model: ${err.message}`);
    }
  } else {
    try {
      const res = await fetch(`/api/opencode/session/${currentSessionId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cmd.slice(1), args })
      });
      if (!res.ok) throw new Error('Command failed');
    } catch (err) {
      console.error('Error sending command:', err);
      showError(`Error sending command: ${err.message}`);
    }
  }
}

elements.permissionApprove.addEventListener('click', () => {
  if (currentPermissionRequest) {
    sendPermissionResponse(currentPermissionRequest.id, 'once');
  }
});

elements.permissionDeny.addEventListener('click', () => {
  if (currentPermissionRequest) {
    sendPermissionResponse(currentPermissionRequest.id, 'reject');
  }
});

async function toggleRecording() {
  if (!mediaRecorder) await initAudio();
  if (!mediaRecorder) return;

  if (!isRecording) {
    if (mediaRecorder.state === 'inactive') {
      speechSynthesis.cancel();
      audioChunks = [];
      mediaRecorder.start();
      isRecording = true;
      elements.pttButton.classList.add('is-recording');
      elements.pttStatus.textContent = 'Recording...';
    }
  } else {
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      isRecording = false;
      elements.pttButton.classList.remove('is-recording');
    }
  }
}

elements.pttButton.addEventListener('click', async (e) => {
  e.preventDefault();
  await toggleRecording();
});

elements.stopSpeaking.addEventListener('click', () => {
  speechSynthesis.cancel();
  speechBuffer = '';
});

elements.repeatLast.addEventListener('click', () => sendText('Repeat Last'));

elements.screenshot.addEventListener('click', async () => {
  try {
    elements.pttStatus.textContent = 'Capturing...';
    const response = await fetch('/api/screenshot');
    if (!response.ok) throw new Error('Screenshot failed');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    elements.pttStatus.textContent = 'Screenshot opened';
  } catch (err) {
    console.error('Screenshot error:', err);
    elements.pttStatus.textContent = 'Capture failed';
  }
});

elements.sessions.addEventListener('click', () => sendText('/session'));
elements.models.addEventListener('click', () => sendText('/models'));

elements.debugToggle.addEventListener('click', () => {
  elements.debugSection.classList.toggle('visible');
});

elements.debugInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendText(elements.debugInput.value);
  }
});

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

requestWakeLock();
initAudio();
initSSE();
