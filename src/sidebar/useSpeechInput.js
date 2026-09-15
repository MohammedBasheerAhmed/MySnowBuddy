// Speech-to-text input using the Web Speech API (SpeechRecognition), which is
// built into Chrome and Edge. No API key and no extra cost, and audio is not
// routed through the AI provider.
//
// NOTE: In Chrome, SpeechRecognition transcription is performed server-side by
// the browser vendor. Do not dictate sensitive credentials/data. See
// docs/decisions.md.
import { useEffect, useRef, useState, useCallback } from 'react';

function getRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function useSpeechInput({ onTranscript, onError }) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef(null);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return undefined;
    }

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }
      onTranscriptRef.current?.({ finalText, interimText });
    };

    recognition.onerror = (event) => {
      setListening(false);
      const messages = {
        'not-allowed': 'Microphone access was denied. Allow microphone access for this site and try again.',
        'service-not-allowed': 'Speech recognition was blocked by the browser or page policy.',
        'no-speech': 'No speech detected. Try again.',
        'audio-capture': 'No microphone found.',
      };
      onErrorRef.current?.(messages[event.error] || `Speech recognition error: ${event.error}`);
    };

    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.abort();
      } catch (err) {
        /* recognition already stopped */
      }
      recognitionRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.start();
      setListening(true);
    } catch (err) {
      // start() throws if already started — ignore.
    }
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch (err) {
      /* already stopped */
    }
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (listening) {
      stop();
    } else {
      start();
    }
  }, [listening, start, stop]);

  return { listening, supported, start, stop, toggle };
}
