/**
 * ABC → MIDI converter (browser)
 * Rendering + MIDI via abcjs, with cleanup for Maestro-style ABC
 */

const abcInput = document.getElementById("abc-input");
const statusEl = document.getElementById("status");
const scoreEl = document.getElementById("score");
const scoreEmpty = document.getElementById("score-empty");
const btnConvert = document.getElementById("btn-convert");
const btnPreview = document.getElementById("btn-preview");
const btnClear = document.getElementById("btn-clear");
const fileInput = document.getElementById("file-input");

let previewAudio = null;

function setStatus(msg, type = "") {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (type ? " " + type : "");
}

function getAbc() {
  return (abcInput.value || "").trim();
}

/**
 * Clean Maestro / DAW-exported ABC so abcjs can parse and emit notes.
 */
function preprocessAbc(src) {
  let s = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Strip inline dynamics / decorations like +mf+ +ffff+
  s = s.replace(/\+[a-zA-Z]+\+/g, " ");

  // Drop non-musical %% meta (keep %%MIDI if any)
  s = s
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t.startsWith("%%")) return true;
      if (/^%%MIDI/i.test(t)) return true;
      if (/^%%score/i.test(t)) return true;
      return false;
    })
    .join("\n");

  // Normalize key: "K: C maj" → "K:C"
  s = s.replace(/^K:\s*([A-G][#b]?)\s*(maj|major|min|minor|m)?\s*$/gim, (_, note, mode) => {
    const n = note.trim();
    if (mode && /^(min|minor|m)$/i.test(mode)) return "K:" + n + "m";
    return "K:" + n;
  });

  // Q:69 → Q:1/4=69
  s = s.replace(/^Q:\s*(\d+)\s*$/gim, "Q:1/4=$1");
  s = s.replace(/^\s*%%Q:\s*(\d+)\s*$/gim, "Q:1/4=$1");

  s = s.replace(/\t/g, " ");

  // Odd long fractions (Maestro ritard) → simpler lengths
  s = s.replace(/(\d+)\/(\d+)/g, (full, num, den) => {
    const n = parseInt(num, 10);
    const d = parseInt(den, 10);
    if (!d || d <= 32) return full;
    const q = n / d;
    if (q < 0.05) return "1/32";
    if (q < 0.1) return "1/16";
    if (q < 0.2) return "1/8";
    if (q < 0.4) return "1/4";
    if (q < 0.7) return "1/2";
    if (q < 1.2) return "1";
    if (q < 2.2) return "2";
    return "4";
  });

  if (!/^X:/m.test(s)) s = "X:1\n" + s;
  if (!/^L:/m.test(s)) s = s.replace(/^(X:.*)$/m, "$1\nL:1/8");

  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function titleFromAbc(abc) {
  const m = abc.match(/^T:\s*(.+)$/m);
  if (m) {
    return m[1].trim().replace(/[^\w\s\-]+/g, "").replace(/\s+/g, "_").slice(0, 48) || "tune";
  }
  return "tune";
}

function countMidiNotes(bytes) {
  if (!bytes || bytes.length < 14) return 0;
  let i = 0;
  let notes = 0;
  while (i < bytes.length - 4) {
    if (
      bytes[i] === 0x4d &&
      bytes[i + 1] === 0x54 &&
      bytes[i + 2] === 0x72 &&
      bytes[i + 3] === 0x6b
    ) {
      const len =
        (bytes[i + 4] << 24) |
        (bytes[i + 5] << 16) |
        (bytes[i + 6] << 8) |
        bytes[i + 7];
      let p = i + 8;
      const end = Math.min(p + len, bytes.length);
      let running = 0;
      while (p < end) {
        while (p < end && bytes[p] & 0x80) p++;
        if (p >= end) break;
        p++;
        if (p >= end) break;
        let status = bytes[p];
        if (status & 0x80) {
          running = status;
          p++;
        } else {
          status = running;
        }
        if (status >= 0x80 && status <= 0xef) {
          const cmd = status & 0xf0;
          if (cmd === 0x90) {
            const vel = p + 1 < end ? bytes[p + 1] : 0;
            if (vel > 0) notes++;
            p += 2;
          } else if (cmd === 0x80 || cmd === 0xa0 || cmd === 0xb0 || cmd === 0xe0) {
            p += 2;
          } else if (cmd === 0xc0 || cmd === 0xd0) {
            p += 1;
          } else {
            p += 1;
          }
        } else if (status === 0xff) {
          if (p >= end) break;
          p++;
          let flen = 0;
          while (p < end && bytes[p] & 0x80) {
            flen = (flen << 7) | (bytes[p] & 0x7f);
            p++;
          }
          if (p < end) {
            flen = (flen << 7) | (bytes[p] & 0x7f);
            p++;
          }
          p += flen;
        } else if (status === 0xf0 || status === 0xf7) {
          let flen = 0;
          while (p < end && bytes[p] & 0x80) {
            flen = (flen << 7) | (bytes[p] & 0x7f);
            p++;
          }
          if (p < end) {
            flen = (flen << 7) | (bytes[p] & 0x7f);
            p++;
          }
          p += flen;
        } else {
          p++;
        }
      }
      i = end;
    } else {
      i++;
    }
  }
  return notes;
}

function renderPreview() {
  const raw = getAbc();
  scoreEl.innerHTML = "";
  if (!raw) {
    scoreEmpty.classList.remove("hidden");
    btnPreview.disabled = true;
    return;
  }
  if (typeof ABCJS === "undefined") {
    scoreEmpty.classList.remove("hidden");
    setStatus("Converter library failed to load. Check your connection and refresh.", "error");
    return;
  }

  const abc = preprocessAbc(raw);
  try {
    const visual = ABCJS.renderAbc(scoreEl, abc, {
      responsive: "resize",
      add_classes: true,
      paddingtop: 8,
      paddingbottom: 8,
      paddingright: 8,
      paddingleft: 8,
    });
    if (visual && visual.length) {
      scoreEmpty.classList.add("hidden");
      btnPreview.disabled = false;
      const cleaned = abc !== raw.trim();
      setStatus(
        cleaned
          ? "Score OK (cleaned Maestro decorations) · ready to convert"
          : "Score OK · ready to convert",
        "ok"
      );
    } else {
      scoreEmpty.classList.remove("hidden");
      btnPreview.disabled = true;
      setStatus("Could not parse ABC after cleanup. Check X:, K:, and note lines.", "error");
    }
  } catch (err) {
    scoreEmpty.classList.remove("hidden");
    btnPreview.disabled = true;
    setStatus("Parse error: " + (err.message || String(err)), "error");
  }
}

function downloadBlob(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normalizeMidiResult(result) {
  if (!result) return null;

  if (Array.isArray(result) && result.length && typeof result[0] !== "number") {
    for (const item of result) {
      const n = normalizeMidiResult(item);
      if (n && n.length) return n;
    }
    return null;
  }

  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (Array.isArray(result) && typeof result[0] === "number") {
    return new Uint8Array(result);
  }

  if (typeof result === "string") {
    if (result.startsWith("data:")) {
      const i = result.indexOf("base64,");
      if (i !== -1) return base64ToUint8Array(result.slice(i + 7));
    }
    try {
      return base64ToUint8Array(result.replace(/\s/g, ""));
    } catch (_) {
      return null;
    }
  }

  if (typeof result === "object") {
    if (result.midi) return normalizeMidiResult(result.midi);
    if (result.download) return normalizeMidiResult(result.download);
    if (result.encoded) return normalizeMidiResult(result.encoded);
    if (result.binary) return normalizeMidiResult(result.binary);
  }

  return null;
}

async function blobToUint8Array(blob) {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

async function convertToMidi() {
  const raw = getAbc();
  if (!raw) {
    setStatus("Paste or upload some ABC first.", "error");
    return;
  }
  if (typeof ABCJS === "undefined" || !ABCJS.synth) {
    setStatus("MIDI engine not available. Refresh the page (needs network once).", "error");
    return;
  }

  const abc = preprocessAbc(raw);
  setStatus("Converting…");
  btnConvert.disabled = true;

  try {
    let rawMidi = null;
    if (typeof ABCJS.synth.getMidiFile === "function") {
      rawMidi = ABCJS.synth.getMidiFile(abc, {
        midiOutputType: "binary",
        chordsOff: false,
      });
      if (rawMidi && typeof rawMidi.then === "function") {
        rawMidi = await rawMidi;
      }
    }

    let bytes = null;
    if (rawMidi instanceof Blob) {
      bytes = await blobToUint8Array(rawMidi);
    } else if (Array.isArray(rawMidi) && rawMidi[0] instanceof Blob) {
      bytes = await blobToUint8Array(rawMidi[0]);
    } else {
      bytes = normalizeMidiResult(rawMidi);
    }

    if (!bytes && typeof ABCJS.synth.getMidiFile === "function") {
      let enc = ABCJS.synth.getMidiFile(abc, {
        midiOutputType: "encoded",
        chordsOff: false,
      });
      if (enc && typeof enc.then === "function") enc = await enc;
      if (Array.isArray(enc)) enc = enc[0];
      bytes = normalizeMidiResult(enc);
    }

    if (!bytes || !bytes.length) {
      throw new Error(
        "Could not build MIDI. This file may use notation abcjs cannot read."
      );
    }

    const isMidi =
      bytes[0] === 0x4d &&
      bytes[1] === 0x54 &&
      bytes[2] === 0x68 &&
      bytes[3] === 0x64;
    if (!isMidi) {
      throw new Error("Output was not a valid MIDI file.");
    }

    const noteCount = countMidiNotes(bytes);
    if (noteCount === 0) {
      throw new Error(
        "MIDI was empty (0 notes). Maestro exports with unusual rhythms often fail. Try a simpler ABC, or export MusicXML from Maestro if you can."
      );
    }

    const name = titleFromAbc(abc) + ".mid";
    downloadBlob(bytes, name, "audio/midi");
    setStatus("Downloaded \u201c" + name + "\u201d · " + noteCount + " notes", "ok");
    renderPreview();
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), "error");
  } finally {
    btnConvert.disabled = false;
  }
}

async function previewSound() {
  const raw = getAbc();
  if (!raw || typeof ABCJS === "undefined") return;
  const abc = preprocessAbc(raw);

  try {
    btnPreview.disabled = true;
    setStatus("Starting preview…");

    if (previewAudio) {
      try {
        if (typeof previewAudio.stop === "function") previewAudio.stop();
        if (typeof previewAudio.destroy === "function") previewAudio.destroy();
      } catch (_) {}
      previewAudio = null;
    }

    if (ABCJS.synth.supportsAudio && !ABCJS.synth.supportsAudio()) {
      setStatus("Web Audio not supported in this browser.", "error");
      btnPreview.disabled = false;
      return;
    }

    // Unlock / create AudioContext (required after user gesture)
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      setStatus("Web Audio not available in this browser.", "error");
      btnPreview.disabled = false;
      return;
    }
    const audioContext = new AC();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    if (typeof ABCJS.synth.setAudioContext === "function") {
      await ABCJS.synth.setAudioContext(audioContext);
    }

    const visualObjs = ABCJS.renderAbc("*", abc, {
      responsive: "resize",
      add_classes: true,
    });
    const visualObj = visualObjs && visualObjs[0];
    if (!visualObj) {
      throw new Error("Could not parse ABC for playback.");
    }

    // Build sequence first — catches incomplete tunes early
    let sequence = null;
    if (typeof ABCJS.synth.createSynthSequence === "function") {
      try {
        sequence = new ABCJS.synth.createSynthSequence();
      } catch (_) {}
    }

    const synth = new ABCJS.synth.CreateSynth();
    const initOpts = {
      visualObj: visualObj,
      audioContext: audioContext,
      millisecondsPerMeasure: visualObj.millisecondsPerMeasure
        ? visualObj.millisecondsPerMeasure()
        : undefined,
      options: {
        soundFontUrl: "https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/",
        programOff: false,
        chordsOff: false,
      },
    };

    await synth.init(initOpts);
    const primed = await synth.prime();
    if (primed && primed.status === "error") {
      throw new Error(primed.error || "Synth could not prepare this tune.");
    }
    synth.start();
    previewAudio = synth;
    setStatus("Playing preview…", "ok");
    setTimeout(() => {
      btnPreview.disabled = false;
    }, 2500);
  } catch (err) {
    console.error(err);
    const msg = err && err.message ? err.message : String(err);
    // Friendlier message for known abcjs internal gaps
    if (/swing/i.test(msg) || /undefined/i.test(msg)) {
      setStatus(
        "Preview can’t play this tune in the browser (notation too complex). MIDI download may still work.",
        "error"
      );
    } else {
      setStatus("Preview failed: " + msg, "error");
    }
    btnPreview.disabled = false;
  }
}

let debounceTimer = null;
abcInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(renderPreview, 400);
});

btnConvert.addEventListener("click", convertToMidi);
btnPreview.addEventListener("click", previewSound);

btnClear.addEventListener("click", () => {
  abcInput.value = "";
  if (previewAudio && previewAudio.stop) {
    try {
      previewAudio.stop();
    } catch (_) {}
  }
  renderPreview();
  setStatus("");
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    abcInput.value = String(reader.result || "");
    renderPreview();
    setStatus("Loaded \u201c" + file.name + "\u201d", "ok");
  };
  reader.onerror = () => setStatus("Could not read file.", "error");
  reader.readAsText(file);
  fileInput.value = "";
});

if (typeof ABCJS === "undefined") {
  setStatus("Waiting for converter library… refresh if this stays.", "error");
} else {
  setStatus("Ready — paste ABC or upload a file.");
}
