
import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { AndroidSettings, NativeSettings } from 'capacitor-native-settings';
import {
  nativeErrorCode,
  outcomeAfterRequest,
  permissionPlan,
  toMicPermission,
  type MicPermissionLike
} from './native-mic';

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function nativeMicPermission(): Promise<MicPermissionLike> {
  const status = await SpeechRecognition.checkPermissions();
  return toMicPermission(status.speechRecognition);
}

export async function requestNativeMicPermission(): Promise<MicPermissionLike> {
  const status = await SpeechRecognition.requestPermissions();
  return toMicPermission(status.speechRecognition);
}

export async function openNativeAppSettings(): Promise<boolean> {
  try {
    await NativeSettings.openAndroid({
      option: AndroidSettings.ApplicationDetails
    });
    return true;
  } catch {
    return false;
  }
}

interface AltLike {
  transcript: string;
  confidence: number;
}

interface ResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: AltLike;
}

interface EventLike {
  resultIndex: number;
  results: ArrayLike<ResultLike>;
}

type ListenerHandle = {
  remove: () => Promise<void>;
};

export class NativeRecognition {
  lang = 'en-IN';
  interimResults = true;
  maxAlternatives = 3;
  continuous = true;

  onstart: (() => void) | null = null;
  onresult: ((event: EventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  private handles: ListenerHandle[] = [];

  private matches: string[] = [];
  private completedText = '';

  private ended = true;
  private aborted = false;
  private started = false;
  private startSignalled = false;
  private stopRequested = false;
  private sessionRunning = false;

  private restartCount = 0;

  private restartTimer?: ReturnType<typeof setTimeout>;
  private phraseTimer?: ReturnType<typeof setTimeout>;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private startTimer?: ReturnType<typeof setTimeout>;

  private readonly silenceWaitMs = 4000;
  private readonly restartWaitMs = 300;
  private readonly startTimeoutMs = 10000;

  start(): void {
    if (!this.ended && this.started) {
      return;
    }

    this.ended = false;
    this.aborted = false;
    this.started = true;
    this.startSignalled = false;
    this.stopRequested = false;
    this.sessionRunning = false;

    this.restartCount = 0;
    this.completedText = '';
    this.matches = [];

    this.clearTimers();

    void this.runSession();
  }

  stop(): void {
    if (this.ended || this.aborted || this.stopRequested) {
      return;
    }

    this.stopRequested = true;

    clearTimeout(this.restartTimer);
    clearTimeout(this.phraseTimer);
    clearTimeout(this.startTimer);

    void SpeechRecognition.stop().catch(() => undefined);

    // Allow Android time to deliver its last partial result.
    this.stopTimer = setTimeout(() => {
      this.finish();
    }, 1500);
  }

  abort(): void {
    if (this.ended || this.aborted) {
      return;
    }

    this.aborted = true;
    this.started = false;

    this.clearTimers();

    void SpeechRecognition.stop().catch(() => undefined);

    this.cleanup();
  }

  private async runSession(): Promise<void> {
    if (
      this.ended ||
      this.aborted ||
      this.stopRequested ||
      this.sessionRunning
    ) {
      return;
    }

    this.sessionRunning = true;

    try {
      const availability = await SpeechRecognition.available();

      if (!this.canContinue()) {
        this.sessionRunning = false;
        return;
      }

      if (!availability.available) {
        this.sessionRunning = false;
        this.fail('service-not-allowed');
        return;
      }

      const permissionStatus =
        (await SpeechRecognition.checkPermissions()).speechRecognition;

      if (!this.canContinue()) {
        this.sessionRunning = false;
        return;
      }

      const plan = permissionPlan(permissionStatus);

      if (plan === 'settings') {
        this.sessionRunning = false;
        this.fail('not-allowed-permanent');
        return;
      }

      if (plan === 'ask') {
        const requested =
          (await SpeechRecognition.requestPermissions()).speechRecognition;

        if (!this.canContinue()) {
          this.sessionRunning = false;
          return;
        }

        const outcome = outcomeAfterRequest(requested);

        if (outcome === 'settings') {
          this.sessionRunning = false;
          this.fail('not-allowed-permanent');
          return;
        }

        if (outcome === 'ask-again') {
          this.sessionRunning = false;
          this.fail('not-allowed');
          return;
        }
      }

      // Listen for Android partial speech results.
      const partialHandle = await SpeechRecognition.addListener(
        'partialResults',
        (data: { matches?: string[] }) => {
          if (this.aborted || this.ended) {
            return;
          }

          const candidates = Array.isArray(data?.matches)
            ? data.matches.filter(
                (item): item is string =>
                  typeof item === 'string' && item.trim().length > 0
              )
            : [];

          if (candidates.length === 0) {
            return;
          }

          const incoming = candidates[0]
            .replace(/\s+/g, ' ')
            .trim();

          if (!incoming) {
            return;
          }

          const previous = this.matches[0] ?? '';

          const a = previous.toLocaleLowerCase();
          const b = incoming.toLocaleLowerCase();

          let chosen = incoming;

          // Android can revise the same partial sentence.
          if (a && b) {
            if (a === b || a.startsWith(b + ' ')) {
              chosen = previous;
            } else if (b.startsWith(a + ' ')) {
              chosen = incoming;
            }
          }

          this.matches = [chosen];

          // New speech means the silence period has ended.
          clearTimeout(this.phraseTimer);
          this.phraseTimer = undefined;

          // Show the complete live sentence.
          this.emit(false);
        }
      );

      this.handles.push(partialHandle);

      if (!this.canContinue()) {
        this.sessionRunning = false;
        this.cleanup();
        return;
      }

      // Listen for actual Android microphone state.
      const stateHandle = await SpeechRecognition.addListener(
        'listeningState',
        (data: { status?: string }) => {
          if (this.aborted || this.ended) {
            return;
          }

          if (data?.status === 'started') {
            this.signalStart();
          }

          if (data?.status === 'stopped') {
            this.onNativeSessionStopped();
          }
        }
      );

      this.handles.push(stateHandle);

      if (!this.canContinue()) {
        this.sessionRunning = false;
        this.cleanup();
        return;
      }

      // Do not show Listening until Android confirms the microphone started.
      clearTimeout(this.startTimer);

      this.startTimer = setTimeout(() => {
        if (
          !this.ended &&
          !this.aborted &&
          !this.startSignalled &&
          !this.stopRequested
        ) {
          this.sessionRunning = false;
          this.fail('audio-capture');
        }
      }, this.startTimeoutMs);

      await SpeechRecognition.start({
        language: this.lang || 'en-IN',
        maxResults: Math.max(
          1,
          Math.min(5, this.maxAlternatives || 1)
        ),
        partialResults: this.interimResults,
        popup: false
      });

      // Do not signal onstart just because start() returned.
      // Wait for Android's listeningState: started event.
    } catch (error) {
      this.sessionRunning = false;

      if (!this.aborted && !this.ended && !this.stopRequested) {
        this.fail(nativeErrorCode(error));
      } else if (this.stopRequested) {
        this.finish();
      }
    }
  }

  private onNativeSessionStopped(): void {
    if (this.ended || this.aborted) {
      return;
    }

    this.sessionRunning = false;

    clearTimeout(this.startTimer);
    this.startTimer = undefined;

    if (this.stopRequested) {
      // Let any last partial result arrive before finishing.
      if (!this.stopTimer) {
        this.stopTimer = setTimeout(() => {
          this.finish();
        }, 500);
      }
      return;
    }

    this.commitCurrentSegment();
    this.removeSessionListeners();

    if (!this.completedText.trim()) {
      this.restartCount++;

      if (this.restartCount > 4) {
        this.fail('no-speech');
        return;
      }
    } else {
      this.restartCount = 0;

      // Start the silence timer only once.
      // A new partial result cancels it.
      if (!this.phraseTimer) {
        this.phraseTimer = setTimeout(() => {
          if (!this.ended && !this.aborted && !this.stopRequested) {
            this.finish();
          }
        }, this.silenceWaitMs);
      }
    }

    clearTimeout(this.restartTimer);

    this.restartTimer = setTimeout(() => {
      if (this.canContinue()) {
        void this.runSession();
      }
    }, this.restartWaitMs);
  }

  private mergeText(previous: string, incoming: string): string {
    const a = previous.replace(/\s+/g, ' ').trim();
    const b = incoming.replace(/\s+/g, ' ').trim();

    if (!b) {
      return a;
    }

    if (!a) {
      return b;
    }

    const lowerA = a.toLocaleLowerCase();
    const lowerB = b.toLocaleLowerCase();

    if (
      lowerA === lowerB ||
      lowerA.endsWith(` ${lowerB}`)
    ) {
      return a;
    }

    if (lowerB.startsWith(`${lowerA} `)) {
      return b;
    }

    if (lowerA.startsWith(`${lowerB} `)) {
      return a;
    }

    const aWords = a.split(' ');
    const bWords = b.split(' ');

    const max = Math.min(aWords.length, bWords.length);

    for (let count = max; count > 0; count--) {
      const left = aWords
        .slice(-count)
        .join(' ')
        .toLocaleLowerCase();

      const right = bWords
        .slice(0, count)
        .join(' ')
        .toLocaleLowerCase();

      if (left === right) {
        return [
          ...aWords,
          ...bWords.slice(count)
        ].join(' ');
      }
    }

    return `${a} ${b}`;
  }

  private commitCurrentSegment(): void {
    const current = this.matches[0]?.trim();

    if (current) {
      this.completedText = this.mergeText(
        this.completedText,
        current
      );
    }

    this.matches = [];

    // Keep the accumulated sentence visible.
    this.emit(false);
  }

  private signalStart(): void {
    if (
      this.started &&
      !this.ended &&
      !this.aborted &&
      !this.startSignalled
    ) {
      this.startSignalled = true;

      clearTimeout(this.startTimer);
      this.startTimer = undefined;

      this.onstart?.();
    }
  }

  private emit(isFinal: boolean): void {
    if (this.aborted || this.ended) {
      return;
    }

    const current = this.matches[0] ?? '';

    const transcript = isFinal
      ? this.completedText || current
      : this.mergeText(this.completedText, current);

    if (!transcript.trim()) {
      return;
    }

    const result: ResultLike = {
      isFinal,
      length: 1,
      0: {
        transcript,
        confidence: 0
      }
    };

    this.onresult?.({
      resultIndex: 0,
      results: [result]
    });
  }

  private finish(): void {
    if (this.ended || this.aborted) {
      return;
    }

    this.clearTimers();

    this.commitCurrentSegment();

    if (this.completedText.trim()) {
      this.matches = [this.completedText];
      this.emit(true);
    }

    this.ended = true;
    this.started = false;
    this.sessionRunning = false;

    this.cleanup();

    this.onend?.();
  }

  private fail(code: string): void {
    if (this.ended || this.aborted) {
      return;
    }

    this.ended = true;
    this.started = false;
    this.sessionRunning = false;

    this.clearTimers();
    this.cleanup();

    this.onerror?.({ error: code });
    this.onend?.();
  }

  private canContinue(): boolean {
    return (
      !this.ended &&
      !this.aborted &&
      !this.stopRequested
    );
  }

  private clearTimers(): void {
    clearTimeout(this.restartTimer);
    clearTimeout(this.phraseTimer);
    clearTimeout(this.stopTimer);
    clearTimeout(this.startTimer);

    this.restartTimer = undefined;
    this.phraseTimer = undefined;
    this.stopTimer = undefined;
    this.startTimer = undefined;
  }

  private removeSessionListeners(): void {
    const handles = this.handles.splice(0);

    for (const handle of handles) {
      void handle.remove().catch(() => undefined);
    }
  }

  private cleanup(): void {
    this.clearTimers();
    this.removeSessionListeners();
  }
}
