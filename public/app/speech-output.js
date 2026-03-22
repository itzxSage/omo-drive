export function createSpeechOutput(state) {
  function speak(text) {
    const utterance = new SpeechSynthesisUtterance(text);
    state.setLastSpokenText(text);
    speechSynthesis.speak(utterance);
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

  function handleSpeechDelta(delta) {
    if (!delta) {
      return;
    }

    const speechBuffer = state.appendSpeechBuffer(delta);
    const sentences = speechBuffer.split(/([.!?\n]+)/);

    if (sentences.length > 2) {
      const toSpeak = sentences.slice(0, -1).join('');
      state.setSpeechBuffer(sentences[sentences.length - 1]);
      processAndSpeak(toSpeak);
    }
  }

  function flushSpeechBuffer() {
    const speechBuffer = state.getSpeechBuffer();

    if (speechBuffer.trim()) {
      processAndSpeak(speechBuffer);
      state.clearSpeechBuffer();
    }
  }

  function stopSpeaking() {
    speechSynthesis.cancel();
    state.clearSpeechBuffer();
  }

  function repeatLast() {
    const lastSpokenText = state.getLastSpokenText().trim();
    if (!lastSpokenText) {
      return false;
    }

    speak(lastSpokenText);
    return true;
  }

  return {
    speak,
    handleSpeechDelta,
    flushSpeechBuffer,
    stopSpeaking,
    repeatLast
  };
}
