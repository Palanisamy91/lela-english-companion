
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

/** True only when the Angular app is running inside a Capacitor native shell. */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Reads the current Android microphone permission without showing a popup. */
export async function nativeMicPermission(): Promise<MicPermissionLike> {
  const status = await SpeechRecognition.checkPermissions();
  return toMicPermission(status.speechRecognition);
}

/** Requests Android microphone permission after a user action. */
export async function requestNativeMicPermission(): Promise<MicPermissionLike> {
  const status = await SpeechRecognition.requestPermissions();
  return toMicPermission(status.speechRecognition);
}

/** Opens this app's Android settings page so the learner can enable microphone permission. */
export async function openNativeAppSettings(): Promise<boolean> {
  try {
    await NativeSettings.openAndroid({ option: AndroidSettings.ApplicationDetails });
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

/**
 * Android speech recognition adapter.
 * Keeps completed phrase segments across Android recognition sessions.
 * Delivers one final transcript when the learner stops or is silent.
 */
export class NativeRecognition {
  lang = 'en-IN';
  interimResults = true;
  maxAlternatives = 3;
  continuous = true;

  onstart: (() => void) | null = null;
  onresult: ((event: EventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  private handles: Array<{ remove: () => Promise<void> }> = [];
  private matches: string[] = [];
  private completedText = '';

  private ended = true;
  private aborted = false;
  private started = false;
  private startSignalled = false;
  private stopRequested = false;

  private restartCount = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private phraseTimer?: ReturnType<typeof setTimeout>;
  private stopTimer?: ReturnType<typeof setTimeout>;

  /** Wait four seconds after the last completed phrase before finalising. */
  private readonly silenceWaitMs = 4000;

  start(): void {
    if (!this.ended && this.started) return;

    this.ended = false;
    this.aborted = false;
    this.started = true;
    this.startSignalled = false;
    this.stopRequested = false;
    this.restartCount = 0;
    this.completedText = '';
    this.matches = [];

    clearTimeout(this.restartTimer);
    clearTimeout(this.phraseTimer);
    clearTimeout(this.stopTimer);

    void this.runSession();
  }

  /** Stops and returns all text captured across Android recognition sessions. */
  stop(): void {
    if (this.ended || this.aborted || this.stopRequested) return;

    this.stopRequested = true;

    clearTimeout(this.restartTimer);
    clearTimeout(this.phraseTimer);

    void SpeechRecognition.stop().catch(() => undefined);

    // Fallback for Android services that do not report listeningState=stopped.
    this.stopTimer = setTimeout(() => this.finish(), 1500);
  }

  /** Cancels without delivering a final transcript. */
  abort(): void {
    if (this.ended || this.aborted) return;

    this.aborted = true;

    clearTimeout(this.restartTimer);
    clearTimeout(this.phraseTimer);
    clearTimeout(this.stopTimer);

    void SpeechRecognition.stop().catch(() => undefined);
    this.cleanup();
  }

  private async runSession(): Promise<void> {
    if (this.ended || this.aborted || this.stopRequested) return;

    try {
      const availability = await SpeechRecognition.available();

      if (this.aborted || this.ended || this.stopRequested) return;

      if (!availability.available) {
        this.fail('service-not-allowed');
        return;
      }

      const before = (await SpeechRecognition.checkPermissions()).speechRecognition;

      if (this.aborted || this.ended || this.stopRequested) return;

      const plan = permissionPlan(before);

      if (plan === 'settings') {
        this.fail('not-allowed-permanent');
        return;
      }

      if (plan === 'ask') {
        const after = (await SpeechRecognition.requestPermissions()).speechRecognition;

        if (this.aborted || this.ended || this.stopRequested) return;

        const outcome = outcomeAfterRequest(after);

        if (outcome === 'settings') {
          this.fail('not-allowed-permanent');
          return;
        }

        if (outcome === 'ask-again') {
          this.fail('not-allowed');
          return;
        }
      }

      const partialHandle = await SpeechRecognition.addListener(
        'partialResults',
        (data: { matches?: string[] }) => {
          if (this.aborted || this.ended || this.stopRequested) return;

          const candidates = Array.isArray(data?.matches)
            ? data.matches.filter(
                (item): item is string =>
                  typeof item === 'string' && item.trim().length > 0
              )
            : [];

          if (candidates.length === 0) return;

          const incoming = candidates[0].replace(/\s+/g, ' ').trim();
          const previous = this.matches[0] ?? '';

          const a = previous.toLocaleLowerCase();
          const b = incoming.toLocaleLowerCase();

          // Android may send revised versions of the same phrase.
          // Keep the fuller version instead of duplicating the words.
          const chosen =
            a && (a === b || a.startsWith(b + ' '))
              ? previous
              : b && (b === a || b.startsWith(a + ' '))
                ? incoming
                : incoming;

          this.matches = [chosen, ...candidates.slice(1)];

          // New speech means the silence period must start again.
          clearTimeout(this.phraseTimer);

          this.emit(false);
        }
      );

      this.handles.push(partialHandle);

      const stateHandle = await SpeechRecognition.addListener(
        'listeningState',
        (data: { status?: string }) => {
          if (this.aborted || this.ended) return;

          if (data?.status === 'started') {
            clearTimeout(this.phraseTimer);
            this.signalStart();
          }

          if (data?.status === 'stopped') {
            this.onNativeSessionStopped();
          }
        }
      );

      this.handles.push(stateHandle);

      if (this.aborted || this.ended || this.stopRequested) {
        this.cleanup();
        return;
      }

      await SpeechRecognition.start({
        language: this.lang || 'en-IN',
        maxResults: Math.max(1, Math.min(5, this.maxAlternatives || 1)),
        partialResults: this.interimResults,
        popup: false
      });

      if (!this.aborted && !this.ended && !this.stopRequested) {
        this.signalStart();
      }
    } catch (error) {
      if (!this.aborted && !this.ended && !this.stopRequested) {
        this.fail(nativeErrorCode(error));
      } else if (this.stopRequested) {
        this.finish();
      }
    }
  }

  private onNativeSessionStopped(): void {
    if (this.ended || this.aborted) return;

    if (this.stopRequested) {
      this.finish();
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

      // Allow the learner time to continue the same sentence.
      clearTimeout(this.phraseTimer);
      this.phraseTimer = setTimeout(() => {
        if (!this.ended && !this.aborted && !this.stopRequested) {
          this.finish();
        }
      }, this.silenceWaitMs);
    }

    clearTimeout(this.restartTimer);

    // Restart quickly so the next part of the sentence is not missed.
    this.restartTimer = setTimeout(() => {
      if (!this.ended && !this.aborted && !this.stopRequested) {
        void this.runSession();
      }
    }, 250);
  }

  private mergeText(previous: string, incoming: string): string {
    const a = previous.replace(/\s+/g, ' ').trim();
    const b = incoming.replace(/\s+/g, ' ').trim();

    if (!b) return a;
    if (!a) return b;

    const lowerA = a.toLocaleLowerCase();
    const lowerB = b.toLocaleLowerCase();

    if (lowerA === lowerB || lowerA.endsWith(` ${lowerB}`)) return a;
    if (lowerB.startsWith(`${lowerA} `)) return b;
    if (lowerA.startsWith(`${lowerB} `)) return a;

    const aWords = a.split(' ');
    const bWords = b.split(' ');
    const max = Math.min(aWords.length, bWords.length);

    // Avoid repeating overlapping words between two Android sessions.
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
        return [...aWords, ...bWords.slice(count)].join(' ');
      }
    }

    return `${a} ${b}`;
  }

  private commitCurrentSegment(): void {
    const current = this.matches[0]?.trim();

    if (current) {
      this.completedText = this.mergeText(this.completedText, current);
    }

    this.matches = [];
  }

  private signalStart(): void {
    if (this.started && !this.ended && !this.startSignalled) {
      this.startSignalled = true;
      this.onstart?.();
    }
  }

  private emit(isFinal: boolean): void {
    if (this.aborted || this.ended) return;

    const current = this.matches[0] ?? '';

    const transcript = isFinal
      ? this.completedText || current
      : this.mergeText(this.completedText, current);

    if (!transcript.trim()) return;

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
    if (this.ended || this.aborted) return;

    clearTimeout(this.restartTimer);
    clearTimeout(this.phraseTimer);
    clearTimeout(this.stopTimer);

    this.commitCurrentSegment();

    if (this.completedText.trim()) {
      this.matches = [this.completedText];
      this.emit(true);
    }

    this.ended = true;
    this.started = false;

    this.cleanup();
    this.onend?.();
  }

  private fail(code: string): void {
    if (this.ended || this.aborted) return;

    this.ended = true;
    this.started = false;

    this.cleanup();

    this.onerror?.({ error: code });
    this.onend?.();
  }

  private removeSessionListeners(): void {
    const handles = this.handles.splice(0);

    for (const handle of handles) {
      void handle.remove().catch(() => undefined);
    }
  }

  private cleanup(): void {
    clearTimeout(this.restartTimer);
    clearTimeout(this.phraseTimer);
    clearTimeout(this.stopTimer);

    this.removeSessionListeners();
  }
}
