# ABC → MIDI Converter

Browser web app that converts [ABC notation](https://abcnotation.com/) to a downloadable MIDI file.

## Use

1. Open `index.html` in a modern browser (needs network once to load the abcjs library).
2. Upload a `.abc` file.
3. Check the score preview.
4. Click **Convert & download MIDI**.
5. Optional: **Preview sound** plays a quick Web Audio preview.

## Notes

- Works best with standard single- or multi-voice ABC (headers + notes).
- Very exotic decorations or non-standard dialects may not convert perfectly.
- Conversion uses [abcjs](https://github.com/paulrosen/abcjs).
