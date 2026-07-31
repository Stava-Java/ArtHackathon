import * as Tone from "tone";

export type AuditoryImpactKind =
  | "left"
  | "right"
  | "hook"
  | "stretch"
  | "jab"
  | "parry"
  | "hurt"
  | "shot";

export type AuditoryImpactOptions = {
  buildCombo?: boolean;
  charge?: number;
  finisher?: boolean;
  loaded?: boolean;
};

// A 20-hit C Lydian Dominant (Acoustic Scale) ascent. Repeating the scale over
// multiple octaves lets pitch carry the escalation without unsafe loudness.
// Color changes the sound's position and brightness, never the direction of ascent.
const COMBO_ASCENT_MIDI = [
  60, 62, 64, 66, 67, 69, 70, 72,
  74, 76, 78, 79, 81, 82, 84,
  86, 88, 90, 91, 93,
];
const COLOR_NOTES_MIDI = [60, 62, 64, 66, 67, 69, 70];
const COMBO_WINDOW_MS = 6000;
const MAX_COMBO = COMBO_ASCENT_MIDI.length;
const MILESTONE_CHORDS: Record<number, string[]> = {
  5: ["C4", "E4", "G4"],
  10: ["E4", "Bb4", "D5"],
  15: ["F#4", "A4", "C5"],
  20: ["C5", "E5", "F#5", "Bb5"],
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hueFromHex(hex: string) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return 0;
  const value = Number.parseInt(normalized, 16);
  const red = ((value >> 16) & 255) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (delta === 0) return 0;

  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function midiToNote(midi: number) {
  return Tone.Frequency(Math.round(midi), "midi").toNote();
}

export class AuditoryArt {
  private initialized = false;
  private disposed = false;
  private combo = 0;
  private lastComboAt = Number.NEGATIVE_INFINITY;
  private comboTimer: number | null = null;

  private limiter: Tone.Limiter | null = null;
  private compressor: Tone.Compressor | null = null;
  private master: Tone.Gain | null = null;
  private reverb: Tone.Reverb | null = null;
  private delay: Tone.FeedbackDelay | null = null;
  private distortion: Tone.Distortion | null = null;
  private comboGain: Tone.Gain | null = null;
  private comboFilter: Tone.Filter | null = null;
  private noiseFilter: Tone.Filter | null = null;
  private impactFilter: Tone.Filter | null = null;
  private jabPanner: Tone.Panner | null = null;
  private softMallet: Tone.Sampler | null = null;
  private hardMallet: Tone.Sampler | null = null;
  private hookSynth: Tone.MembraneSynth | null = null;
  private stretchSynth: Tone.FMSynth | null = null;
  private parrySynth: Tone.MetalSynth | null = null;
  private textureSynth: Tone.NoiseSynth | null = null;
  private impactSynth: Tone.NoiseSynth | null = null;
  private paintShotSynth: Tone.PluckSynth | null = null;

  constructor(private readonly onComboChange: (combo: number) => void) {}

  async start() {
    await Tone.start();
    if (this.disposed) return;
    if (!this.initialized) this.initialize();
    await Promise.all([this.reverb?.ready, Tone.loaded()]);
    if (!this.disposed) this.playFightStart();
  }

  playGesture(kind: "left" | "right" | "hook" | "stretch", strength = 1) {
    if (!this.initialized || !this.textureSynth || !this.noiseFilter) return;
    const now = Tone.now();
    const centerFrequency =
      kind === "hook"
        ? 420
        : kind === "stretch"
          ? 1450 + strength * 520
          : kind === "right"
            ? 1050
            : 850;
    this.noiseFilter.frequency.rampTo(centerFrequency, 0.035, now);
    this.textureSynth.triggerAttackRelease(
      kind === "stretch" ? "8n" : "32n",
      now,
      clamp(0.07 + strength * 0.035, 0.07, 0.18),
    );
  }

  playDash() {
    if (!this.initialized || !this.stretchSynth) return;
    const now = Tone.now();
    this.stretchSynth.triggerAttackRelease("G4", "32n", now, 0.12);
    this.stretchSynth.triggerAttackRelease("D5", "32n", now + 0.055, 0.1);
  }

  playImpact(
    kind: AuditoryImpactKind,
    color: string,
    strength = 1,
    options: AuditoryImpactOptions = {},
  ) {
    if (!this.initialized) return;
    const combo = options.buildCombo
      ? this.advanceCombo(options.finisher ? MAX_COMBO : undefined)
      : 0;
    const hueDegree = Math.floor(hueFromHex(color) / (360 / 7)) % 7;
    const midi =
      combo > 0
        ? COMBO_ASCENT_MIDI[clamp(combo - 1, 0, COMBO_ASCENT_MIDI.length - 1)]
        : COLOR_NOTES_MIDI[hueDegree];
    const note = midiToNote(midi);
    const comboProgress = combo > 0 ? (combo - 1) / (MAX_COMBO - 1) : 0;
    const velocity = clamp(
      0.46 + strength * 0.09 + comboProgress * 0.25,
      0.42,
      0.82,
    );
    const now = Tone.now();

    if (combo > 0 && this.comboGain) {
      // Roughly 4 dB of bus lift, then a plateau. Together with velocity this
      // is about a 7 dB arc across 20 hits, safely below the limiter ceiling.
      this.comboGain.gain.rampTo(0.58 + comboProgress * 0.32, 0.035, now);
    }
    if (this.comboFilter) {
      this.comboFilter.frequency.rampTo(190 + hueDegree * 32, 0.025, now);
    }

    if (kind === "left" || kind === "right" || kind === "jab") {
      this.jabPanner?.pan.rampTo(kind === "right" ? 0.28 : -0.28, 0.025, now);
      this.playMallet(note, "16n", now, velocity, combo);
      this.impactBurst(kind === "right" ? 3600 : 3000, velocity * 0.32, now);
      if (combo >= 4 && combo <= 9) {
        this.playMallet(
          midiToNote(midi + 12),
          "32n",
          now + 0.055,
          velocity * 0.6,
          combo,
        );
      }
    } else if (kind === "hook") {
      const bassMidi = 36 + Math.min(7, Math.max(0, combo - 1));
      this.hookSynth?.triggerAttackRelease(
        midiToNote(bassMidi),
        options.loaded ? "4n" : "8n",
        now,
        clamp(velocity + 0.1, 0, 1),
      );
      const comboIndex = Math.max(0, combo - 1);
      const hookNotes =
        combo >= 3
          ? [midiToNote(COMBO_ASCENT_MIDI[comboIndex - 2]), note]
          : [note];
      this.playMallet(
        hookNotes,
        options.loaded ? "4n" : "8n",
        now + 0.018,
        velocity * 0.72,
        combo,
        options.loaded,
      );
      this.impactBurst(options.loaded ? 1450 : 1850, velocity * 0.48, now + 0.006);
    } else if (kind === "stretch") {
      const charge = clamp(options.charge ?? strength - 0.8, 0, 1);
      const interval = 5 + Math.round(charge * 7);
      this.stretchSynth?.triggerAttackRelease(
        midiToNote(midi - interval),
        "16n",
        now,
        velocity * 0.52,
      );
      this.stretchSynth?.triggerAttackRelease(
        note,
        charge > 0.7 ? "4n" : "8n",
        now + 0.085,
        velocity * 0.7,
      );
      this.playMallet(note, "8n", now + 0.09, velocity * 0.78, combo, charge > 0.8);
      this.impactBurst(2200 + charge * 1800, velocity * 0.28, now + 0.075);
    } else if (kind === "parry") {
      this.parrySynth?.triggerAttackRelease(
        midiToNote(midi + 24),
        "16n",
        now,
        clamp(0.38 + strength * 0.24, 0, 0.9),
      );
      this.playMallet(
        [midiToNote(midi + 12), midiToNote(midi + 19)],
        "16n",
        now + 0.025,
        0.28,
        combo,
        true,
      );
      this.impactBurst(5200, 0.18, now);
    } else if (kind === "shot") {
      this.paintShotSynth?.triggerAttack(midiToNote(midi + 12), now);
      this.impactBurst(2600 + hueDegree * 420, 0.16, now);
    } else if (kind === "hurt") {
      this.hookSynth?.triggerAttackRelease("C2", "8n", now, 0.62);
      this.textureBurst(240, 0.2, now);
    }

    if (options.finisher) {
      this.playMallet(
        ["C4", "E4", "F#4", "Bb4", "C5"],
        "2n",
        now + 0.08,
        0.62,
        MAX_COMBO,
        true,
      );
      this.parrySynth?.triggerAttackRelease("C6", "8n", now + 0.1, 0.55);
    } else if (MILESTONE_CHORDS[combo]) {
      this.playMallet(
        MILESTONE_CHORDS[combo],
        "8n",
        now + 0.035,
        0.3,
        combo,
        combo >= 10,
      );
    }
  }

  finish(won: boolean) {
    if (!this.initialized) return;
    const now = Tone.now() + 0.08;
    this.resetCombo();
    if (won) {
      this.playMallet(
        ["C4", "E4", "F#4", "G4", "Bb4", "C5"],
        "1n",
        now,
        0.56,
        MAX_COMBO,
        true,
      );
      this.paintShotSynth?.triggerAttack("C6", now + 0.12);
    } else {
      this.hookSynth?.triggerAttackRelease("Eb2", "8n", now, 0.5);
      this.hookSynth?.triggerAttackRelease("C2", "2n", now + 0.18, 0.58);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.comboTimer !== null) window.clearTimeout(this.comboTimer);
    this.comboTimer = null;
    this.softMallet?.dispose();
    this.hardMallet?.dispose();
    this.hookSynth?.dispose();
    this.stretchSynth?.dispose();
    this.parrySynth?.dispose();
    this.textureSynth?.dispose();
    this.impactSynth?.dispose();
    this.paintShotSynth?.dispose();
    this.jabPanner?.dispose();
    this.impactFilter?.dispose();
    this.noiseFilter?.dispose();
    this.comboFilter?.dispose();
    this.comboGain?.dispose();
    this.distortion?.dispose();
    this.delay?.dispose();
    this.reverb?.dispose();
    this.master?.dispose();
    this.compressor?.dispose();
    this.limiter?.dispose();
    this.initialized = false;
  }

  private initialize() {
    this.limiter = new Tone.Limiter(-1.5).toDestination();
    this.compressor = new Tone.Compressor({
      attack: 0.012,
      knee: 12,
      ratio: 2.4,
      release: 0.14,
      threshold: -16,
    }).connect(this.limiter);
    this.master = new Tone.Gain(0.64).connect(this.compressor);
    this.reverb = new Tone.Reverb({
      decay: 1.25,
      preDelay: 0.012,
      wet: 0.13,
    }).connect(this.master);
    this.delay = new Tone.FeedbackDelay({
      delayTime: "32n",
      feedback: 0.16,
      wet: 0.12,
    }).connect(this.reverb);
    this.distortion = new Tone.Distortion({ distortion: 0.2, wet: 0.15 }).connect(
      this.master,
    );
    this.comboFilter = new Tone.Filter({
      frequency: 190,
      Q: 0.5,
      rolloff: -12,
      type: "highpass",
    });
    this.comboGain = new Tone.Gain(0.58).connect(this.comboFilter);
    this.noiseFilter = new Tone.Filter({
      frequency: 900,
      Q: 1.1,
      rolloff: -24,
      type: "bandpass",
    }).connect(this.master);
    this.impactFilter = new Tone.Filter({
      frequency: 3000,
      Q: 0.75,
      rolloff: -24,
      type: "bandpass",
    }).connect(this.master);
    this.comboFilter.connect(this.reverb);
    this.jabPanner = new Tone.Panner(0).connect(this.comboGain);

    this.softMallet = new Tone.Sampler({
      attack: 0,
      baseUrl: "/assets/audio/xylophone/",
      release: 0.22,
      urls: {
        C4: "C4_pp.wav",
        G4: "G4_pp.wav",
        C5: "C5_pp.wav",
        G5: "G5_pp.wav",
        C6: "C6_pp.wav",
        G6: "G6_pp.wav",
        C7: "C7_pp.wav",
      },
      volume: -8,
    }).connect(this.jabPanner);
    this.hardMallet = new Tone.Sampler({
      attack: 0,
      baseUrl: "/assets/audio/xylophone/",
      release: 0.18,
      urls: {
        C4: "C4_ff.wav",
        G4: "G4_ff.wav",
        C5: "C5_ff.wav",
        G5: "G5_ff.wav",
        C6: "C6_ff.wav",
        G6: "G6_ff.wav",
        C7: "C7_ff.wav",
      },
      volume: -10,
    }).connect(this.jabPanner);
    this.hookSynth = new Tone.MembraneSynth({
      envelope: { attack: 0.001, decay: 0.25, release: 0.5, sustain: 0.01 },
      octaves: 5,
      oscillator: { type: "sine" },
      pitchDecay: 0.038,
      volume: -5,
    }).connect(this.distortion);
    this.stretchSynth = new Tone.FMSynth({
      envelope: { attack: 0.008, decay: 0.16, release: 0.42, sustain: 0.12 },
      harmonicity: 2.4,
      modulationEnvelope: {
        attack: 0.006,
        decay: 0.18,
        release: 0.32,
        sustain: 0.08,
      },
      modulationIndex: 7,
      oscillator: { type: "sine" },
      volume: -11,
    }).connect(this.delay);
    this.parrySynth = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.11, release: 0.12 },
      harmonicity: 4.8,
      modulationIndex: 26,
      octaves: 1.8,
      resonance: 3100,
      volume: -13,
    }).connect(this.reverb);
    this.textureSynth = new Tone.NoiseSynth({
      envelope: { attack: 0.001, decay: 0.09, release: 0.08, sustain: 0 },
      noise: { type: "pink" },
      volume: -16,
    }).connect(this.noiseFilter);
    this.impactSynth = new Tone.NoiseSynth({
      envelope: { attack: 0.001, decay: 0.045, release: 0.025, sustain: 0 },
      noise: { type: "white" },
      volume: -13,
    }).connect(this.impactFilter);
    this.paintShotSynth = new Tone.PluckSynth({
      attackNoise: 1.4,
      dampening: 2600,
      release: 0.9,
      resonance: 0.82,
      volume: -12,
    }).connect(this.delay);
    this.initialized = true;
  }

  private playFightStart() {
    if (!this.softMallet) return;
    const now = Tone.now() + 0.03;
    ["C4", "D4", "E4", "F#4"].forEach((note, index) => {
      this.playMallet(note, "16n", now + index * 0.07, 0.38, index + 1);
    });
  }

  private playMallet(
    notes: string | string[],
    duration: Tone.Unit.Time,
    time: number,
    velocity: number,
    combo = 0,
    forceHard = false,
  ) {
    const sampler = forceHard || combo >= 10 ? this.hardMallet : this.softMallet;
    sampler?.triggerAttackRelease(
      notes,
      duration,
      time,
      clamp(velocity, 0.08, 0.86),
    );
  }

  private textureBurst(frequency: number, velocity: number, time: number) {
    if (!this.textureSynth || !this.noiseFilter) return;
    this.noiseFilter.frequency.rampTo(frequency, 0.025, time);
    this.textureSynth.triggerAttackRelease("16n", time, velocity);
  }

  private impactBurst(frequency: number, velocity: number, time: number) {
    if (!this.impactSynth || !this.impactFilter) return;
    this.impactFilter.frequency.rampTo(frequency, 0.012, time);
    this.impactSynth.triggerAttackRelease("64n", time, velocity);
  }

  private advanceCombo(force?: number) {
    const now = performance.now();
    this.combo =
      force ?? (now - this.lastComboAt <= COMBO_WINDOW_MS ? this.combo + 1 : 1);
    this.combo = clamp(this.combo, 1, MAX_COMBO);
    this.lastComboAt = now;
    this.onComboChange(this.combo);
    if (this.comboTimer !== null) window.clearTimeout(this.comboTimer);
    this.comboTimer = window.setTimeout(() => this.resetCombo(), COMBO_WINDOW_MS);
    return this.combo;
  }

  private resetCombo() {
    if (this.comboTimer !== null) window.clearTimeout(this.comboTimer);
    this.comboTimer = null;
    this.combo = 0;
    this.lastComboAt = Number.NEGATIVE_INFINITY;
    if (this.comboGain && this.initialized) {
      this.comboGain.gain.rampTo(0.58, 0.12);
    }
    this.onComboChange(0);
  }
}
