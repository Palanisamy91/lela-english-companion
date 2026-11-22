import { NgTemplateOutlet } from '@angular/common';
import { AfterViewChecked, Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { ProgressService } from '../core/progress.service';
import { guessGender } from './voice-choice';
import { IconComponent } from '../shared/icon.component';
import { MicHelpComponent } from '../shared/mic-help.component';
import type { Level, TopicChoice } from './lela.models';
import { LelaConversationService, type SavedConversation } from './lela-conversation.service';

const GROUP_LABELS: Record<string, string> = {
  personal: 'About you', daily: 'Daily life', office: 'Office', software: 'Software developer', interview: 'Interview',
  reallife: 'Real-life English', telephone: 'Telephone', travel: 'Travel', advanced: 'Advanced discussions',
  grammar: 'Grammar practice', vocab: 'Vocabulary practice',
};

@Component({
  selector: 'app-lela',
  standalone: true,
  imports: [IconComponent, MicHelpComponent, NgTemplateOutlet],
  template: `
    <header class="head card" aria-label="Lela assistant">
      <div class="hero-portrait" [class.talking]="lela.phase() === 'speaking'" [class.hearing]="lela.phase() === 'listening'">
        <img src="/images/leela.png" alt="Lela, your English practice companion" />
      </div>
      <div class="who">
        <h1>Lela</h1>
        <div class="identity"><b>Lela</b><span class="status" role="status" aria-live="polite" data-testid="status">● {{ lela.status() }}</span></div>
        @if (lela.topic(); as t) { <div class="topic" data-testid="topic">Topic: <b>{{ t.title }}</b> <span lang="ta">· {{ t.titleTamil }}</span></div> }
      </div>
      <div class="header-modes" role="group" aria-label="Conversation mode">
        <button type="button" [class.selected]="lela.liveMode()" (click)="setHeaderMode('auto')">Auto</button>
        <button type="button" [class.selected]="!lela.liveMode() && lela.micOn()" (click)="setHeaderMode('manual')">Manual</button>
        <button type="button" [class.selected]="!lela.micOn()" (click)="setHeaderMode('text')">Text</button>
        <button type="button" [class.selected]="lela.voiceOn()" (click)="setHeaderMode('voice')">Voice</button>
      </div>
    </header>

    @if (lela.loadError()) {
      <div class="notice warn" role="alert">
        {{ lela.loadError() }}
        <button type="button" class="btn small" (click)="lela.load()">Try again</button>
      </div>
    }
    @if (lela.canSpeak && lela.speech.voices().length > 0 && lela.voiceChoice().gender !== 'female') {
      <p class="notice warn" role="status" data-testid="voice-warning">{{ lela.voiceChoice().note }} Open Voice settings to see the voices on this device.</p>
    }
    <app-mic-help />
    @if (lela.canListen === false) {
      <p class="notice warn">{{ lela.speech.recognitionIssue }} You can still talk with Lela by typing, and she will speak to you.</p>
    }
    @if (lela.canListen && !lela.speech.online()) {
      <p class="notice warn" role="status" data-testid="offline-note"><app-icon name="wifi-off" [size]="16" /> You are offline. Speaking to Lela needs internet, so please type your answers. Lela's questions, her voice, corrections and your history all work offline.</p>
    }
    @if (!lela.canSpeak) {
      <p class="notice warn">This browser cannot speak aloud, so Lela's words are shown on the screen only.</p>
    }

    @if (!lela.active()) {
      <section class="card">
        <h2>Choose how you want to practise</h2>
        <div class="label">Mode</div>
        <div class="modes" role="radiogroup" aria-label="Conversation mode">
          @for (m of lela.db()?.modes ?? []; track m.id) {
            <button type="button" class="mode" role="radio" [attr.aria-checked]="lela.modeId() === m.id" [class.sel]="lela.modeId() === m.id" (click)="lela.setMode(m.id)">
              <span class="ico">{{ m.icon }}</span>
              <b>{{ m.label }}</b>
              <small>{{ m.description }}</small>
              <small lang="ta">{{ m.labelTamil }}</small>
            </button>
          }
        </div>

        <div class="label">Level</div>
        <div class="seg" role="radiogroup" aria-label="Level">
          @for (l of lela.db()?.levels ?? []; track l.id) {
            <button type="button" role="radio" [attr.aria-checked]="lela.level() === l.id" [class.sel]="lela.level() === l.id" (click)="lela.setLevel(l.id)">{{ l.label }}</button>
          }
        </div>
        @for (l of lela.db()?.levels ?? []; track l.id) {
          @if (l.id === lela.level()) { <p class="small">{{ l.description }} <span lang="ta">({{ l.labelTamil }})</span></p> }
        }

        <div class="label"><app-icon name="settings" [size]="16" /> Voice settings</div>
        <ng-container [ngTemplateOutlet]="voiceSettings" />
        <label class="row small"><input type="checkbox" [checked]="lela.micOn()" (change)="lela.setMicOn(micChecked($event))" [disabled]="!lela.canListen" /> Microphone on (Lela listens after she finishes speaking)</label>
        <label class="row small"><input type="checkbox" [checked]="lela.showTamil()" (change)="lela.setShowTamil(micChecked($event))" /> Show Tamil with Lela's questions</label>
        <ng-container [ngTemplateOutlet]="liveSwitch" />

        <button type="button" class="btn primary big" (click)="lela.start()" [disabled]="!lela.db()" data-testid="start"><app-icon name="play" [size]="20" /> Start conversation</button>
      </section>

      @if (lela.messages().length > 0) {
        <p class="notice">Your last conversation is below. Press Start conversation for a new one.</p>
      }
    }

    @if (lela.messages().length > 0 && !viewing()) {
      <section class="card chat" #scrollBox aria-label="Conversation" data-testid="chat">
        @for (m of lela.messages(); track m.id) {
          @if (m.from === 'lela') {
            <div class="msg lela">
              <div class="bubble" [class.fixcard]="m.kind === 'correction'" [class.hint]="m.kind === 'hint'">
                <div class="name">Lela</div>
                <p data-testid="lela-text">{{ m.text }}</p>
                @if (m.correction; as c) {
                  <div class="fix" data-testid="correction">
                    <div class="label"><app-icon name="original" [size]="14" /> Original sentence</div>
                    <p class="orig" data-testid="orig">{{ c.original }}</p>
                    <div class="label"><app-icon name="corrected" [size]="14" /> Corrected sentence</div>
                    <p class="good" data-testid="corrected">{{ c.corrected }}</p>
                    <button type="button" class="btn small" (click)="lela.speakOnly(c.corrected)"><app-icon name="volume" [size]="16" /> Hear the corrected sentence</button>
                    @if (c.explanations.length > 0) { <div class="label"><app-icon name="explanation" [size]="14" /> Explanation · <app-icon name="translate" [size]="14" /> தமிழ்</div> }
                    @for (e of c.explanations; track $index) {
                      <div class="why">
                        <p><b>{{ e.found }} → {{ e.replacement }}</b></p>
                        <p data-testid="why-en">{{ e.english }}</p>
                        <p lang="ta" class="ta" data-testid="why-ta">{{ e.tamil }}</p>
                      </div>
                    }
                    <p class="small">
                      <span class="badge" [class.rule]="c.checker === 'rule-based'" [class.ai]="c.checker === 'ai'">{{ c.checker === 'ai' ? 'AI-powered check' : 'Rule-based check · not AI' }}</span>
                      {{ c.disclaimer }}
                    </p>
                  </div>
                }
                @if (lela.showTamil() && m.tamil) { <p lang="ta" class="ta">{{ m.tamil }}</p> }
                @if (m.example && m.id === latestHelpId()) {
                  <details><summary>Need help? Show a sample answer</summary><p data-testid="sample">{{ m.example }}</p></details>
                }
                <div class="acts">
                  <button type="button" class="act" (click)="lela.playSample(m.correction ? m.correction.corrected : m.text)" aria-label="Replay this in Lela's voice" title="Replay voice" data-testid="replay-msg"><app-icon name="replay" [size]="16" /></button>
                  <button type="button" class="act" [class.fav]="lela.isFavourite(m)" (click)="lela.toggleFavourite(m)" [attr.aria-pressed]="lela.isFavourite(m)" [attr.aria-label]="lela.isFavourite(m) ? 'Remove from favourites' : 'Save to favourites'" title="Favourite" data-testid="fav-msg"><app-icon [name]="lela.isFavourite(m) ? 'heart-fill' : 'heart'" [size]="16" /></button>
                </div>
              </div>
            </div>
          } @else {
            <div class="msg you">
              <div class="bubble you">
                <div class="name">You</div>
                <p data-testid="user-text">{{ m.text }}</p>
                <div class="meta">
                  <app-icon [name]="m.source === 'voice' ? 'mic' : 'edit'" [size]="13" /> {{ m.source === 'voice' ? 'spoken' : 'typed' }}
                  @if (m.looksCorrect === true) { · ✓ no mistakes found by the rules }
                  @else if (m.looksCorrect === false) { · needs a fix }
                  <button type="button" class="act small-act" [class.fav]="lela.isFavourite(m)" (click)="lela.toggleFavourite(m)" [attr.aria-pressed]="lela.isFavourite(m)" aria-label="Favourite this sentence" title="Favourite"><app-icon [name]="lela.isFavourite(m) ? 'heart-fill' : 'heart'" [size]="14" /></button>
                </div>
              </div>
            </div>
          }
        }
        @if (lela.phase() === 'thinking') {
          <div class="msg lela" data-testid="typing" role="status" aria-label="Lela is typing">
            <div class="bubble typing"><span></span><span></span><span></span></div>
          </div>
        }
      </section>

    }

    @if (viewing(); as v) {
      <section class="card chat">
        <div class="row"><b>{{ dateLabel(v) }} · {{ v.messages.length }} messages</b><button type="button" class="btn small" (click)="viewing.set(null)">Close</button></div>
        @for (m of v.messages; track m.id) {
          <p class="old"><b>{{ m.from === 'lela' ? 'Lela' : 'You' }}:</b> {{ m.text }}
            @if (m.correction; as c) { <br /><span class="small">Corrected: {{ c.corrected }}</span> }</p>
        }
      </section>
    }

    @if (lela.active()) {
      <section class="controls card" aria-label="Controls">
        @if (lela.error()) { <p class="notice warn" role="alert" data-testid="error">{{ lela.error() }}</p> }
        @if (lela.phase() === 'listening' && !lela.liveMode()) {
          <div class="live" role="status" data-testid="listening"><span class="rings"><app-icon name="mic" [size]="18" /></span><div class="live-text"><strong>Listening… speak now</strong>@if (lela.speech.heardFinal()) { <p class="fin" data-testid="final-text"><span class="tag">Heard</span> {{ lela.speech.heardFinal() }}</p> }@if (lela.speech.interim() && lela.speech.interim() !== lela.speech.heardFinal()) { <p class="int" data-testid="interim-text"><span class="tag">Hearing</span> {{ lela.speech.interim() }}</p> }</div></div>
        }
        @if (lela.liveMode()) {
          <div class="live" role="status" data-testid="live-panel">
            <span class="rings" [class.on]="lela.speech.isListening()"><app-icon name="mic" [size]="18" /></span>
            <div class="live-text">
              <strong data-testid="live-state">{{ liveState() }}</strong>
              @if (lela.speech.isListening() && (lela.speech.interim() || lela.speech.heardFinal())) { <p class="int" data-testid="live-transcript"><span class="tag">You</span> {{ lela.speech.interim() || lela.speech.heardFinal() }}</p> }
              @if (lela.livePaused()) { <p class="small" data-testid="live-paused">Listening paused after a long silence. Your conversation is saved. <button type="button" class="btn small" (click)="lela.tapMic()" data-testid="live-resume">Continue listening</button></p> }
              <button type="button" class="btn small" [disabled]="lela.phase() !== 'speaking'" (click)="lela.stopSpeaking()" data-testid="interrupt"><app-icon name="stop" [size]="16" /> Interrupt Lela</button>
            </div>
          </div>
        }
        <form class="merged-composer" (submit)="onSubmit($event, box)">
          <button type="button" class="merge-btn speak-btn" [class.on]="lela.phase() === 'listening'" [disabled]="!lela.canListen || !lela.micOn()" (click)="lela.tapMic()" aria-label="Speak" data-testid="mic"><app-icon name="mic" [size]="17" /><span>Speak</span></button>
          <button type="button" class="merge-btn retry-btn" [disabled]="!lela.canListen || !lela.micOn() || lela.phase() === 'listening'" (click)="lela.tapMic()" aria-label="Retry listening" data-testid="retry"><app-icon name="replay" [size]="16" /><span>Retry</span></button>
          <button type="button" class="merge-btn stop-btn" (click)="stopAll()" aria-label="Stop listening and voice" data-testid="stop"><app-icon name="stop" [size]="15" /><span>Stop</span></button>
          <input #box class="merged-input" type="text" name="typed" placeholder="Type message..." aria-label="Type message" autocomplete="off" autocapitalize="sentences" enterkeyhint="send" maxlength="300" data-testid="typed" />
          <button type="submit" class="merge-send" aria-label="Send message" data-testid="send"><app-icon name="send" [size]="17" /><span>Send</span></button>
        </form>

        <div class="compact-actions" role="toolbar" aria-label="Conversation tools">
          <button type="button" class="compact-action" (click)="lela.repeatVoice()" data-testid="repeat"><app-icon name="replay" [size]="14" /><span>Repeat</span></button>
          <label class="compact-action topic-action"><app-icon name="replay" [size]="14" /><span>Topic</span>
            <select aria-label="Change topic" (change)="pickTopic($event)" data-testid="topicpick">
              <option value="">Change</option><option value="__next">Surprise me</option>
              @for (g of topicGroups(); track g.group) { <optgroup [label]="g.label">@for (t of g.topics; track t.id) { <option [value]="t.id">{{ t.title }}</option> }</optgroup> }
            </select>
          </label>
          <button type="button" class="compact-action" [class.selected]="lela.modeId() === 'interview'" (click)="selectInterviewMode()" data-testid="interview"><app-icon name="user" [size]="14" /><span>Interview</span></button>
          <button type="button" class="compact-action" [class.selected]="lela.showTamil()" (click)="lela.setShowTamil(!lela.showTamil())" [attr.aria-pressed]="lela.showTamil()" data-testid="tamil-toggle"><app-icon name="translate" [size]="14" /><span>Tamil</span></button>
          <button type="button" class="compact-action" (click)="showVoice.set(!showVoice())" [attr.aria-expanded]="showVoice()" data-testid="voicebtn"><app-icon name="settings" [size]="14" /><span>Advanced</span></button>
          <button type="button" class="compact-action end-action" (click)="lela.end()" data-testid="end"><app-icon name="stop" [size]="14" /><span>End</span></button>
        </div>
        @if (showVoice()) {
          <div class="voicebox">
            <ng-container [ngTemplateOutlet]="voiceSettings" />
            <label class="vrow small"><input type="checkbox" [checked]="lela.micOn()" (change)="lela.setMicOn(micChecked($event))" [disabled]="!lela.canListen" /> Microphone enabled</label>
            <ng-container [ngTemplateOutlet]="liveSwitch" />
            <div class="row tools">
              <button type="button" class="btn small" (click)="lela.hint()"><app-icon name="explanation" [size]="15" /> Need help?</button>
              <button type="button" class="btn small" (click)="lela.skipQuestion()"><app-icon name="chevron-right" [size]="15" /> Skip</button>
              <button type="button" class="btn small" (click)="lela.newConversation()"><app-icon name="play" [size]="15" /> New conversation</button>
            </div>
          </div>
        }
      </section>
    }


    <ng-template #liveSwitch>
      <fieldset class="live-switch" data-testid="live-switch">
        <legend class="label">Conversation style</legend>
        <div class="lseg" role="group" aria-label="Conversation style">
          <button type="button" [class.sel]="!lela.liveMode()" [attr.aria-pressed]="!lela.liveMode()" (click)="lela.setLiveMode(false)" data-testid="mode-normal">Normal chat</button>
          <button type="button" [class.sel]="lela.liveMode()" [attr.aria-pressed]="lela.liveMode()" [disabled]="!lela.canListen" (click)="lela.setLiveMode(true)" data-testid="mode-live">Live conversation</button>
        </div>
        <p class="small" data-testid="live-note">
          @if (!lela.canListen) { Live conversation needs voice input, which this browser cannot do. Normal chat and typing still work. }
          @else {
            <b>How Live works:</b> the microphone stays open, so you speak without pressing it each time, and you can talk over Lela to interrupt her (works best with headphones; otherwise use <i>Interrupt Lela</i>). It is <b>not</b> a full AI conversation: your browser turns your speech into text (most browsers need the internet for this{{ lela.speech.online() ? '' : ' — you are offline now, so type instead' }}), then Lela answers from the app's own lessons and rules, which work offline. She does not talk while you talk, and she cannot discuss anything outside her topics.
          }
        </p>
      </fieldset>
    </ng-template>

    <ng-template #voiceSettings>
      <div class="vs" data-testid="voice-settings">
        @if (lela.canSpeak) {
          <label class="vrow small"><input type="checkbox" [checked]="lela.voiceOn()" (change)="lela.setVoiceOn(checked($event))" data-testid="voice-on" /> Lela speaks every reply (voice mode)</label>
          <label class="vrow">Voice
            <select aria-label="Lela's voice" (change)="lela.setVoiceName(valueOf($event))" data-testid="voice-select">
              <option value="" [selected]="!lela.voiceName()">Automatic (female English voice, Indian English first)</option>
              @for (v of lela.englishVoices(); track v.name) { <option [value]="v.name" [selected]="v.name === lela.voiceName()">{{ v.name }} ({{ v.lang }}) · {{ genderLabel(v) }}</option> }
            </select>
          </label>
          <p class="small" [class.warn]="lela.voiceChoice().gender !== 'female'" data-testid="voice-note">{{ lela.voiceChoice().note }}</p>
          @if (lela.voiceChoice().gender !== 'female' && lela.englishVoices().length > 0) {
            <p class="small" data-testid="alt-voices">English voices on this device: {{ voiceList() }}.</p>
          }
          <label class="vrow small">Speed
            <input type="range" min="0.5" max="1.3" step="0.05" [value]="lela.rate()" (input)="setRate($event)" aria-label="Voice speed" />
            <b>{{ lela.rate().toFixed(2) }}×</b>
          </label>
          <label class="vrow small">Pitch
            <input type="range" min="0.6" max="1.6" step="0.05" [value]="lela.pitch()" (input)="setPitch($event)" aria-label="Voice pitch" data-testid="pitch" />
            <b>{{ lela.pitch().toFixed(2) }}</b>
          </label>
          <label class="vrow small">Volume
            <input type="range" min="0" max="1" step="0.05" [value]="lela.volume()" (input)="setVolume($event)" aria-label="Voice volume" data-testid="volume" />
            <b>{{ (lela.volume() * 100).toFixed(0) }}%</b>
          </label>
          <button type="button" class="btn small" (click)="lela.previewVoice()" [disabled]="lela.previewing()" data-testid="preview"><app-icon name="volume" [size]="16" /> {{ lela.previewing() ? 'Playing…' : 'Preview voice' }}</button>
          <p class="small">The voices come from your device. A softer, more natural voice (for example an "Online" or "Natural" voice, or Google's Indian English voice) sounds less robotic. Install more in your device's text-to-speech settings.</p>
        } @else {
          <p class="small">This browser cannot speak aloud, so there is no voice to choose.</p>
        }
      </div>
    </ng-template>
  `,
  host: { '[class.chat-active]': 'lela.active()' },
  styles: `
    :host { display: block; min-width: 0; }
    /* Active conversation is one continuous workspace, not three separate cards. */
    :host(.chat-active) {
      display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0;
      overflow: hidden; gap: 0; background: var(--surface, #fff);
      border: 1px solid var(--border); border-radius: 14px;
    }
    :host(.chat-active) .head,
    :host(.chat-active) .chat,
    :host(.chat-active) .controls {
      background: transparent; border: 0; border-radius: 0; box-shadow: none;
      margin: 0; width: 100%; min-width: 0;
    }
    :host(.chat-active) .head { flex: 0 0 auto; border-bottom: 1px solid var(--border); }
    :host(.chat-active) .chat { flex: 1 1 0; min-height: 0; padding: 12px 16px; }
    :host(.chat-active) .controls { flex: 0 0 auto; border-top: 1px solid var(--border); padding: 8px 10px; }
    .head { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 10px; text-align: left; padding: 8px 12px; }
    .head h1 { margin: 0; font-size: 1.05rem; } .who { min-width: 0; flex: 1; } .identity { display:flex; align-items:center; gap:10px; font-size:.9rem; } .status { font-weight: 600; color: var(--primary); font-size:.8rem; } .topic { font-size: .78rem; color: #495057; margin-top: 2px; }
    .hero-portrait { flex: none; width: 42px; height: 42px; border-radius: 50%; overflow: hidden; background: #f3efff; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #d0bfff; }
    .hero-portrait img { display:block; width:100%; height:100%; object-fit:cover; object-position:center 18%; }
    .header-modes { display:flex; align-items:center; gap:3px; flex:none; } .header-modes button { border:0; background:transparent; color:var(--primary-dark); border-radius:7px; padding:6px 7px; font:inherit; font-size:.76rem; cursor:pointer; } .header-modes button.selected { background:var(--primary-soft); font-weight:700; }
    .hero-portrait.talking { animation: ring 1s infinite; } .hero-portrait.hearing { box-shadow: 0 0 0 3px #fff, 0 0 0 6px #e03131, 0 8px 22px #3b1c7a20; }
    @keyframes ring { 50% { box-shadow: 0 0 0 3px #fff, 0 0 0 9px #b197fc; } } @keyframes talk { to { transform: scaleY(1.9); } }
    @media (prefers-reduced-motion: reduce) { .avatar.talking, .avatar.talking .mouth { animation: none; } }
    .modes { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
    .mode { text-align: left; display: flex; flex-direction: column; gap: 2px; padding: 10px; border: 2px solid var(--border); border-radius: 12px; background: #fff; font: inherit; cursor: pointer; min-height: 44px; }
    .mode.sel { border-color: var(--primary); background: var(--primary-tint); } .mode .ico { font-size: 1.4rem; } .mode small { color: #495057; }
    .live-switch { border: 0; padding: 0; margin: 6px 0; min-width: 0; }
    .lseg { display: flex; gap: 6px; } .lseg button { flex: 1 1 0; min-width: 0; padding: 0 6px; overflow-wrap: anywhere; min-height: 44px; border: 2px solid var(--border); border-radius: 10px; background: #fff; font: inherit; cursor: pointer; } .lseg button.sel { border-color: var(--primary); background: var(--primary-tint); font-weight: 700; } .lseg button:disabled { opacity: .55; cursor: not-allowed; }
    .seg { display: flex; gap: 6px; } .seg button { flex: 1 1 0; min-width: 0; padding: 0 4px; overflow-wrap: anywhere; min-height: 44px; border: 2px solid var(--border); border-radius: 10px; background: #fff; font: inherit; cursor: pointer; } .seg button.sel { border-color: var(--primary); background: var(--primary-tint); font-weight: 700; }
    .big { min-height: 48px; font-size: 1.05rem; margin-top: 12px; }
    p.small.warn { color: #8a4b00; background: #fff4e0; border: 1px solid #f0c987; border-radius: 8px; padding: 6px 8px; }
    .chat { flex: 1 1 0; min-height: 0; max-height: none; overflow-y: auto; overscroll-behavior: contain; } .msg { display: flex; margin: 10px 0; } .msg.you { justify-content: flex-end; }
    .bubble { max-width: 92%; border-radius: 18px 18px 18px 6px; padding: 10px 14px; background: var(--primary-tint); border: 1px solid var(--border); color: var(--text); font-size: 1.04rem; line-height: 1.6; overflow-wrap: anywhere; word-break: break-word; } .bubble.you { background: var(--primary); border-color: var(--primary); color: #fff; border-radius: 18px 18px 6px 18px; } .bubble p { margin: 4px 0; }
    .bubble .name { font-size: .75rem; font-weight: 700; color: var(--primary); } .bubble.you .name { color: #e5dbff; } .meta { font-size: .78rem; color: var(--muted); display: flex; align-items: center; gap: 4px; flex-wrap: wrap; } .bubble.you .meta { color: #e5dbff; }
    .bubble.you .act { color: #fff; } .acts { display: flex; gap: 4px; margin-top: 4px; }
    .act { display: inline-flex; align-items: center; justify-content: center; min-width: 34px; min-height: 34px; border: 0; border-radius: 10px; background: transparent; color: var(--primary); } .act:hover { background: rgba(106,63,201,.12); } .act.fav { color: var(--danger); } .small-act { min-width: 28px; min-height: 28px; }
    .typing { display: inline-flex; gap: 5px; align-items: center; padding: 14px 16px; } .typing span { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); opacity: .35; animation: blink 1.2s infinite; } .typing span:nth-child(2) { animation-delay: .2s; } .typing span:nth-child(3) { animation-delay: .4s; } @keyframes blink { 40% { opacity: 1; transform: translateY(-3px); } }
    @media (prefers-reduced-motion: reduce) { .typing span { animation: none; opacity: .7; } }
    .rings { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: var(--danger); color: #fff; flex: none; } .rings::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid var(--danger); opacity: .5; animation: ringout 1.2s ease-out infinite; } @keyframes ringout { from { transform: scale(.8); opacity: .7; } to { transform: scale(1.35); opacity: 0; } } @media (prefers-reduced-motion: reduce) { .rings::after { animation: none; } }
    .live { align-items: flex-start; } .live-text { min-width: 0; flex: 1; } .live-text p { margin: 4px 0 0; } .tag { display: inline-block; font-size: .68rem; font-weight: 700; text-transform: uppercase; padding: 1px 6px; border-radius: 8px; background: var(--primary-soft); color: var(--primary-dark); margin-right: 4px; } .int { color: var(--muted); font-style: italic; }
    .vs { display: flex; flex-direction: column; gap: 8px; } .vrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .vrow select { flex: 1 1 200px; min-width: 0; } .vrow input[type=range] { flex: 1 1 140px; } .voicebox { background: var(--primary-tint); border: 1px solid var(--border); border-radius: 12px; padding: 10px; margin: 8px 0; }
    .fav-row { display: flex; align-items: flex-start; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--border); } .fav-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .bubble.fixcard { background: #fff4e6; border: 1px solid #ffd8a8; } .bubble.hint { background: #e6fcf5; }
    @media (max-width: 360px) { .seg button { font-size: .82rem; padding: 0 2px; } .mode { padding: 8px; } }
    @media (min-width: 1024px) { .bubble { max-width: 78%; } }
    .fix .orig { text-decoration: line-through; color: #c92a2a; } .fix .good { color: #2b8a3e; font-weight: 700; font-size: 1.05rem; }
    .why { background: #fff; border-radius: 8px; padding: 4px 8px; margin: 6px 0; } .ta { color: #5c3d00; } .old { margin: 4px 0; }
    .controls { position: relative; flex: 0 0 auto; z-index: 4; } .tools { margin-top: 6px; } .tools select { flex: 1 1 150px; min-height: 40px; }
    .btn.danger { border-color: #e03131; color: #c92a2a; } .hist { justify-content: space-between; margin: 4px 0; } .info { margin-top: 8px; }
    .cw { margin: 6px 0; flex-wrap: wrap; } .btn.on { background: var(--primary-soft); border-color: var(--primary); }
    .controls { padding: 10px; }
    .merged-composer { display:flex; align-items:stretch; gap:0; width:100%; min-width:0; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:#fff; }
    .merge-btn, .merge-send { display:inline-flex; align-items:center; justify-content:center; gap:4px; flex:none; min-height:42px; padding:5px 9px; border:0; border-radius:0; background:var(--primary); color:#fff; font:inherit; font-size:.78rem; font-weight:600; white-space:nowrap; cursor:pointer; }
    .merge-btn + .merge-btn { border-left:1px solid rgba(255,255,255,.24); }
    .merge-btn:disabled { opacity:.55; cursor:not-allowed; }
    .merge-btn.on { background:#3e287c; }
    .stop-btn { background:#a93232; }
    .merged-input { flex:1 1 auto; min-width:0; width:100%; height:42px; padding:0 10px; border:0; outline:0; background:#fff; color:var(--text); font:inherit; font-size:.9rem; }
    .merge-send { background:var(--primary-dark); border-left:1px solid rgba(255,255,255,.25); }
    .compact-actions { display: flex; align-items: stretch; justify-content: space-between; gap: 3px; width: 100%; margin-top: 8px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
    .compact-action { position: relative; flex: 1 0 auto; min-width: 0; min-height: 38px; padding: 4px 7px; display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface, #fff); color: var(--text); font: inherit; font-size: .68rem; line-height: 1.1; white-space: nowrap; cursor: pointer; }
    .compact-action.selected { color: var(--primary); background: var(--primary-tint); border-color: var(--primary); }
    .compact-action.end-action { color: #c92a2a; }
    .topic-action select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
    .compact-action:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    @media (max-width: 560px) { .head { gap:7px; padding:7px; } .head h1 { font-size:.88rem; } .hero-portrait { width:36px; height:36px; } .header-modes { gap:0; } .header-modes button { padding:5px 4px; font-size:.66rem; } .merged-composer { border-radius:8px; } .merge-btn,.merge-send { min-height:40px; padding:4px 6px; font-size:.68rem; gap:2px; } .merged-input { height:40px; padding:0 6px; font-size:.78rem; } .compact-actions { justify-content:flex-start; } .compact-action { flex:0 0 58px; min-height:36px; padding:3px 4px; font-size:.64rem; } .controls { padding:8px; } }
    @media (max-width: 380px) { .merge-btn,.merge-send { padding:4px 4px; } .merge-btn span,.merge-send span { font-size:.62rem; } .merged-input { font-size:.72rem; } .header-modes button { font-size:.61rem; padding:4px 3px; } }
    /* Mobile layout-only refinement. Message bubbles, colours, typography and message spacing above remain untouched. */
    @media (max-width: 767px) {
      :host(.chat-active) { border-radius: 10px; }
      :host(.chat-active) .head { flex: 0 0 auto; min-height: 48px; gap: 6px; padding: 6px 8px; }
      :host(.chat-active) .who { flex: 1 1 auto; min-width: 0; }
      :host(.chat-active) .header-modes { flex: 0 0 auto; margin-left: auto; justify-content: flex-end; }
      :host(.chat-active) .chat { flex: 1 1 0; min-height: 0; overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; }
      :host(.chat-active) .controls { flex: 0 0 auto; padding: 6px; padding-bottom: max(6px, env(safe-area-inset-bottom)); }
      :host(.chat-active) .merged-composer { display: flex; width: 100%; min-width: 0; }
      :host(.chat-active) .merge-btn,
      :host(.chat-active) .merge-send { width: 34px; min-width: 34px; min-height: 38px; padding: 4px; gap: 0; }
      :host(.chat-active) .merge-btn span,
      :host(.chat-active) .merge-send span { display: none; }
      :host(.chat-active) .merged-input { min-width: 0; flex: 1 1 0; height: 38px; font-size: .85rem; }
      :host(.chat-active) .compact-actions { display: flex; flex-wrap: nowrap; gap: 3px; margin-top: 6px; overflow-x: auto; overscroll-behavior-x: contain; }
      :host(.chat-active) .compact-action { flex: 1 0 48px; min-width: 48px; min-height: 34px; padding: 3px 2px; font-size: .62rem; }
      :host(.chat-active) .live { max-height: 72px; overflow-y: auto; }
    }
    @media (max-width: 380px) {
      :host(.chat-active) .head { gap: 4px; padding: 5px 6px; }
      :host(.chat-active) .hero-portrait { width: 32px; height: 32px; }
      :host(.chat-active) .header-modes button { padding: 4px 3px; font-size: .6rem; }
      :host(.chat-active) .merge-btn,
      :host(.chat-active) .merge-send { width: 31px; min-width: 31px; }
      :host(.chat-active) .controls { padding: 5px; }
    }
    details { margin-top: 4px; } summary { cursor: pointer; color: var(--primary); }
  `,
})
export class LelaComponent implements OnInit, OnDestroy, AfterViewChecked {
  readonly lela = inject(LelaConversationService);
  readonly progress = inject(ProgressService);
  /** One line for the Live panel: what is happening right now. */
  readonly liveState = computed(() => {
    if (this.lela.livePaused()) return 'Paused';
    if (this.lela.phase() === 'speaking') return this.lela.speech.isListening() ? 'Lela is speaking — you can interrupt' : 'Lela is speaking';
    if (this.lela.phase() === 'thinking') return 'Thinking…';
    return this.lela.speech.isListening() ? 'Listening — speak any time' : 'Your turn';
  });
  @ViewChild('scrollBox') private scrollBox?: ElementRef<HTMLElement>;

  readonly showVoice = signal(false);
  readonly viewing = signal<SavedConversation | null>(null);
  private shown = 0;
  private followTimer?: ReturnType<typeof setTimeout>;

  /** The newest Lela message that has a sample answer (older ones stay uncluttered). */
  readonly latestHelpId = computed(() => {
    const list = this.lela.messages();
    for (let i = list.length - 1; i >= 0; i--) if (list[i].from === 'lela' && list[i].example) return list[i].id;
    return -1;
  });

  readonly topicGroups = computed(() => {
    const groups = new Map<string, TopicChoice[]>();
    for (const t of this.lela.topicChoices()) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
    return [...groups].map(([group, topics]) => ({ group, label: GROUP_LABELS[group] ?? group, topics }));
  });

  ngOnInit(): void {
    void this.lela.load();
  }

  ngOnDestroy(): void {
    clearTimeout(this.followTimer);
    this.watcher?.disconnect();
    this.lela.pause();
  }

  private watched?: HTMLElement;
  private watcher?: MutationObserver;

  ngAfterViewChecked(): void {
    // Follow the conversation whenever its content changes (new bubbles, typing dots, late layout),
    // unless the learner has scrolled far up to read something.
    const el = this.scrollBox?.nativeElement;
    if (el && el !== this.watched && typeof MutationObserver !== 'undefined') {
      this.watcher?.disconnect();
      this.watched = el;
      this.watcher = new MutationObserver(() => {
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap < 1200) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
      });
      this.watcher.observe(el, { childList: true, subtree: true, characterData: true });
    }
    // Scroll to the newest message when one is added, and also when the "typing" dots appear or go away.
    const list = this.lela.messages();
    const key = (list.length > 0 ? list[list.length - 1].id : 0) * 2 + (this.lela.phase() === 'thinking' ? 1 : 0);
    if (key !== this.shown) {
      this.shown = key;
      const box = this.scrollBox?.nativeElement;
      if (box) {
        // Setting scrollTop is animated smoothly by the CSS (scroll-behavior: smooth on the chat box).
        // It is done again after the new content has been laid out, because bubbles can grow a little.
        const down = (): void => box.scrollTo({ top: box.scrollHeight, behavior: 'instant' as ScrollBehavior });
        down();
        clearTimeout(this.followTimer);
        this.followTimer = setTimeout(down, 120);
        requestAnimationFrame(down);
      }
    }
  }

  setHeaderMode(mode: 'auto' | 'manual' | 'text' | 'voice'): void {
    if (mode === 'auto') { this.lela.setVoiceOn(true); this.lela.setLiveMode(true); }
    else if (mode === 'manual') { this.lela.setLiveMode(false); }
    else if (mode === 'text') { this.lela.setLiveMode(false); this.lela.setMicOn(false); this.lela.setVoiceOn(false); }
    else { this.lela.setLiveMode(false); this.lela.setMicOn(true); this.lela.setVoiceOn(true); }
  }

  stopAll(): void {
    if (this.lela.phase() === 'listening') this.lela.tapMic();
    this.lela.stopSpeaking();
  }

  selectInterviewMode(): void {
    const mode = this.lela.db()?.modes.find((item) => /interview/i.test(`${item.id} ${item.label}`));
    if (mode) this.lela.setMode(mode.id);
  }

  onSubmit(event: Event, input: HTMLInputElement): void {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    void this.lela.submit(value, 'typed');
  }

  pickTopic(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    select.value = '';
    if (value === '__next') void this.lela.changeTopic();
    else if (value) void this.lela.goToTopic(value);
  }

  setRate(event: Event): void {
    this.lela.setRate(Number((event.target as HTMLInputElement).value));
  }

  setVolume(event: Event): void {
    this.lela.setVolume(Number((event.target as HTMLInputElement).value));
  }

  checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  genderLabel(v: { name: string; lang: string }): string {
    const g = guessGender(v);
    return g === 'female' ? 'female' : g === 'male' ? 'male' : 'gender unknown';
  }

  voiceList(): string {
    return this.lela.englishVoices().map((v) => `${v.name} (${this.genderLabel(v)})`).join(', ');
  }

  setPitch(event: Event): void {
    this.lela.setPitch(Number((event.target as HTMLInputElement).value));
  }

  micChecked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  valueOf(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  levelOf(event: Event): Level {
    return (event.target as HTMLSelectElement).value as Level;
  }

  dateLabel(h: SavedConversation): string {
    const d = new Date(h.date);
    return Number.isNaN(d.getTime()) ? 'Earlier' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}
