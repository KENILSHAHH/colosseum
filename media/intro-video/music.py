"""Synthesizes the 30 s background track for the intro (original, no samples).

Chill synthwave at 120 BPM in A minor, one bar = 2 s, so the arrangement lands on
the video's scene changes: soft pads and arp for the logo, drums drop in with the
chat demo at 4 s, full groove for the features, a short breakdown at 24 s and a
final chord that rings out under the end card.

Usage: python3 music.py out.wav
"""
import sys
import wave

import numpy as np

SR = 44100
DUR = 30.0
BPM = 120
BEAT = 60 / BPM
N = int(SR * DUR)
t_all = np.arange(N) / SR
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def env_adsr(n, a, d, s, r, sr=SR):
    a, d, r = int(a * sr), int(d * sr), int(r * sr)
    e = np.full(n, s, dtype=float)
    e[:a] = np.linspace(0, 1, a, endpoint=False) if a else e[:a]
    e[a:a + d] = np.linspace(1, s, len(e[a:a + d]), endpoint=False)
    if r:
        e[-r:] *= np.linspace(1, 0, len(e[-r:]))
    return e


def saw(f, t, harmonics=10):
    out = np.zeros_like(t)
    for k in range(1, harmonics + 1):
        if f * k > 9000:
            break
        out += np.sin(2 * np.pi * f * k * t) / k * (0.85 ** k)
    return out


def place(buf, sig, start):
    i = int(start * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i]


def lowpass(x, cutoff):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (f / cutoff) ** 4)
    return np.fft.irfft(X, len(x))


def highpass(x, cutoff):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (cutoff / np.maximum(f, 1)) ** 4)
    return np.fft.irfft(X, len(x))


def reverb(x, seconds=2.6, mix=0.3):
    n = int(seconds * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * (6.9 / seconds))
    ir = lowpass(ir, 6000)
    ir /= np.sqrt(np.sum(ir ** 2))
    m = len(x) + n
    y = np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[: len(x)]
    return x * (1 - mix) + y * mix * 0.6


# A minor: Am9 – Fmaj7 – Cmaj7 – G6, one bar each
CHORDS = [
    (45, [57, 60, 64, 67, 71]),
    (41, [57, 60, 64, 65, 69]),
    (48, [55, 60, 64, 67, 71]),
    (43, [55, 59, 62, 64, 67]),
]
BAR = 4 * BEAT
NBARS = int(DUR / BAR)

L = np.zeros(N)
R = np.zeros(N)

# kick timeline (also drives sidechain ducking)
kick_times = [b * BEAT for b in range(int(DUR / BEAT)) if 4.0 <= b * BEAT < 24.0 or 26.0 <= b * BEAT < 28.0]
duck = np.ones(N)
for kt in kick_times:
    i = int(kt * SR)
    n = int(0.32 * SR)
    j = min(N, i + n)
    duck[i:j] = np.minimum(duck[i:j], 1 - 0.55 * np.exp(-np.arange(j - i) / SR * 9))

# --- pads -----------------------------------------------------------------
pad_l = np.zeros(N)
pad_r = np.zeros(N)
for bar in range(NBARS):
    root, notes = CHORDS[bar % 4]
    start = bar * BAR
    length = BAR + 0.6 if bar < NBARS - 1 else DUR - start
    n = int(length * SR)
    tt = np.arange(n) / SR
    e = env_adsr(n, 0.5, 0.6, 0.8, 0.7)
    if bar == NBARS - 1:
        e = env_adsr(n, 0.3, 0.4, 0.9, 1.6)
    for note in notes:
        f = hz(note)
        sl = saw(f * 1.003, tt, 8) + saw(f * 0.997, tt + 0.01, 8)
        sr = saw(f * 0.998, tt + 0.02, 8) + saw(f * 1.002, tt, 8)
        place(pad_l, sl * e * 0.035, start)
        place(pad_r, sr * e * 0.035, start)
pad_l = lowpass(pad_l, 1800)
pad_r = lowpass(pad_r, 1800)
# filter opens over the intro: blend a darker copy at the start
open_amt = np.clip((t_all - 0.0) / 4.0, 0, 1)
pad_l = lowpass(pad_l, 700) * (1 - open_amt) + pad_l * open_amt
pad_r = lowpass(pad_r, 700) * (1 - open_amt) + pad_r * open_amt
L += pad_l * duck
R += pad_r * duck

# --- bass (eighth-note pulse from the drop) ---------------------------------
bass = np.zeros(N)
for bar in range(NBARS):
    root, _ = CHORDS[bar % 4]
    for s in range(8):
        st = bar * BAR + s * BEAT / 2
        if st < 4.0 or 24.0 <= st < 26.0 or st >= 28.0:
            continue
        n = int(BEAT / 2 * SR * 0.92)
        tt = np.arange(n) / SR
        f = hz(root - 12 if s % 2 == 0 else root)
        sig = np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(2 * np.pi * 2 * f * tt) + 0.12 * saw(f, tt, 6)
        place(bass, sig * env_adsr(n, 0.005, 0.12, 0.6, 0.04) * 0.22, st)
# final low note under the end card
n = int(2.0 * SR)
tt = np.arange(n) / SR
place(bass, np.sin(2 * np.pi * hz(33) * tt) * env_adsr(n, 0.01, 0.4, 0.5, 1.4) * 0.3, 28.0)
bass = lowpass(bass, 900)
L += bass * duck
R += bass * duck

# --- arp (16ths over chord tones, ping-pong delay) ------------------------------
arp = np.zeros(N)
pattern = [0, 2, 4, 1, 3, 2, 4, 3]
for bar in range(NBARS):
    _, notes = CHORDS[bar % 4]
    for s in range(16):
        st = bar * BAR + s * BEAT / 4
        if st >= 28.0:
            continue
        note = notes[pattern[s % 8]] + 12
        n = int(0.22 * SR)
        tt = np.arange(n) / SR
        f = hz(note)
        sig = (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * 3 * f * tt) + 0.12 * np.sin(2 * np.pi * 5 * f * tt))
        vel = 0.5 + 0.5 * (s % 4 == 0)
        level = 0.03 if st < 4.0 else 0.045
        if 24.0 <= st < 26.0:
            level = 0.035
        place(arp, sig * np.exp(-tt * 18) * vel * level, st)
d = int(BEAT * 0.75 * SR)
arp_l = arp.copy()
arp_r = np.zeros(N)
arp_r[d:] += arp[:-d] * 0.5
arp_l[2 * d:] += arp[:-2 * d] * 0.3
arp_r[3 * d:] += arp[:-3 * d] * 0.18
L += arp_l
R += arp_r

# --- drums ---------------------------------------------------------------------
drums = np.zeros(N)
for kt in kick_times:
    n = int(0.45 * SR)
    tt = np.arange(n) / SR
    f = 45 + 95 * np.exp(-tt * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    click = rng.standard_normal(n) * np.exp(-tt * 300) * 0.15
    place(drums, (np.sin(ph) * np.exp(-tt * 7) + click) * 0.55, kt)

hats = np.zeros(N)
claps = np.zeros(N)
for b in range(int(DUR / BEAT)):
    bt = b * BEAT
    # off-beat hats from 8 s, 16th hats in the full section
    if 8.0 <= bt < 24.0 or 26.0 <= bt < 28.0:
        n = int(0.06 * SR)
        tt = np.arange(n) / SR
        place(hats, rng.standard_normal(n) * np.exp(-tt * 70) * 0.12, bt + BEAT / 2)
        if 13.5 <= bt < 24.0:
            for off in (0.25, 0.75):
                place(hats, rng.standard_normal(n) * np.exp(-tt * 90) * 0.05, bt + off * BEAT)
    # claps on 2 and 4 from 13.5 s
    if (13.5 <= bt < 24.0 or 26.0 <= bt < 28.0) and b % 2 == 1:
        n = int(0.25 * SR)
        tt = np.arange(n) / SR
        burst = rng.standard_normal(n) * (np.exp(-tt * 22) + 0.6 * np.exp(-np.abs(tt - 0.012) * 400))
        place(claps, burst * 0.2, bt)
hats = highpass(hats, 7000)
claps = highpass(lowpass(claps, 5000), 900)
claps_wet = reverb(claps, 1.4, 0.35)

L += drums + hats * 0.9 + claps_wet
R += drums + hats * 1.1 + claps_wet

# --- risers and impacts ----------------------------------------------------------
def riser(start, length, level):
    n = int(length * SR)
    tt = np.arange(n) / SR
    noise = highpass(rng.standard_normal(n), 2000)
    return noise * (tt / length) ** 2.2 * level, start

for st, ln, lv in [(2.4, 1.6, 0.045), (12.0, 1.5, 0.035), (25.9, 1.6, 0.04)]:
    sig, s0 = riser(st, ln, lv)
    place(L, sig, s0)
    place(R, sig, s0)

for it in (4.0, 13.5, 28.0):
    n = int(2.5 * SR)
    tt = np.arange(n) / SR
    boom = np.sin(2 * np.pi * (38 + 30 * np.exp(-tt * 8)) * tt) * np.exp(-tt * 2.2) * 0.35
    shimmer = lowpass(rng.standard_normal(n), 9000) * np.exp(-tt * 4) * 0.02
    place(L, boom + shimmer, it)
    place(R, boom + shimmer, it)

# --- master ------------------------------------------------------------------------
L = reverb(L, 2.2, 0.18)
R = reverb(R, 2.4, 0.18)
fade_in = np.clip(t_all / 0.25, 0, 1)
fade_out = np.clip((DUR - t_all) / 1.6, 0, 1) ** 1.5
L *= fade_in * fade_out
R *= fade_in * fade_out
peak = max(np.abs(L).max(), np.abs(R).max())
L = np.tanh(L / peak * 1.3) / np.tanh(1.3) * 0.89
R = np.tanh(R / peak * 1.3) / np.tanh(1.3) * 0.89

out = sys.argv[1] if len(sys.argv) > 1 else "music.wav"
pcm = (np.stack([L, R], axis=1) * 32767).astype("<i2")
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("wrote", out)
