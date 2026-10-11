"""Synthesize Meadow's tiny Frutiger Aero UI sounds (no external audio assets needed).

Run: python scripts/make_sounds.py
Writes 22.05 kHz mono 16-bit WAVs into Assets/sounds/ (all under ~100 KB).
"""

from __future__ import annotations

import math
import random
import struct
import wave
from pathlib import Path

RATE = 22050
OUT = Path(__file__).resolve().parents[1] / "Assets" / "sounds"


def write(name: str, samples: list[float], gain: float = 0.9) -> None:
    peak = max(1e-9, max(abs(s) for s in samples))
    frames = b"".join(struct.pack("<h", int(max(-1, min(1, s / peak * gain)) * 32767)) for s in samples)
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(frames)


def env(i: int, n: int, attack: float = 0.004, power: float = 3.0) -> float:
    t = i / n
    a = min(1.0, i / (attack * RATE))
    return a * (1 - t) ** power


def blip(freq: float, dur: float, vol: float = 1.0) -> list[float]:
    """Short glassy tick: sine + octave overtone with a fast decay."""
    n = int(dur * RATE)
    return [
        vol * env(i, n, 0.002, 4) * (math.sin(2 * math.pi * freq * i / RATE) + 0.35 * math.sin(4 * math.pi * freq * i / RATE))
        for i in range(n)
    ]


def bloop(f0: float, f1: float, dur: float) -> list[float]:
    """Water-bubble 'bloop': a sine whose pitch glides upward as the bubble rises."""
    n = int(dur * RATE)
    out, phase = [], 0.0
    for i in range(n):
        t = i / n
        freq = f0 + (f1 - f0) * (1 - (1 - t) ** 2)
        phase += 2 * math.pi * freq / RATE
        out.append(env(i, n, 0.003, 2.2) * (math.sin(phase) + 0.2 * math.sin(2 * phase)))
    return out


def mix(*tracks: tuple[float, list[float]]) -> list[float]:
    total = max(int(start * RATE) + len(t) for start, t in tracks)
    out = [0.0] * total
    for start, t in tracks:
        off = int(start * RATE)
        for i, s in enumerate(t):
            out[off + i] += s
    return out


def bell(freq: float, dur: float, vol: float = 1.0) -> list[float]:
    """Soft chime with inharmonic partials, like a Vista notification."""
    n = int(dur * RATE)
    partials = [(1.0, 1.0), (2.01, 0.45), (3.02, 0.22), (4.2, 0.1)]
    return [
        vol * env(i, n, 0.005, 2.2) * sum(a * math.sin(2 * math.pi * freq * m * i / RATE) for m, a in partials)
        for i in range(n)
    ]


def pop() -> list[float]:
    """Bubble pop: a noise burst with a fast filtered decay plus a tiny pitch drop."""
    random.seed(7)
    n = int(0.12 * RATE)
    out, lp = [], 0.0
    for i in range(n):
        lp += 0.35 * (random.uniform(-1, 1) - lp)
        out.append(env(i, n, 0.001, 5) * (lp * 0.8 + 0.6 * math.sin(2 * math.pi * (900 - 500 * i / n) * i / RATE)))
    return out


def main() -> None:
    write("click", blip(1320, 0.07), 0.55)
    write("bloop", bloop(380, 980, 0.16), 0.7)
    write("pop", pop(), 0.7)
    # Rising pentatonic sparkle for success / toasts.
    write("chime", mix(*[(k * 0.075, bell(f, 0.6, 0.8)) for k, f in enumerate((784, 988, 1175, 1568))]), 0.6)
    # Warm 'Windows is starting' style welcome: an airy major-add9 swell.
    write("welcome", mix(*[(k * 0.14, bell(f, 1.5, 0.9)) for k, f in enumerate((392, 523, 659, 784, 1047))]), 0.6)
    for p in sorted(OUT.glob("*.wav")):
        print(f"{p.name}: {p.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
