# Third-party notices

## Qur'an text and translations

Qur'anic text, metadata, word translations, and verse translations in
`quran.json` were sourced from [Quran.com / Quran Foundation](https://quran.com).
The embedded source notice requests that this attribution be retained when the
data is redistributed. Translation rights remain with their respective authors
and publishers.

## Speech-recognition model

The default ONNX model is a converted and quantized derivative of
[`tarteel-ai/whisper-tiny-ar-quran`](https://huggingface.co/tarteel-ai/whisper-tiny-ar-quran),
itself fine-tuned from OpenAI Whisper Tiny. The source model is marked
Apache-2.0. The converted artifact preserves that license and identifies the
base model in its model card.

## Font

The default `Amiri Quran` font is from the [Amiri project](https://github.com/aliftype/amiri)
and is distributed under the SIL Open Font License 1.1. Its full license is
included at `assets/fonts/Amiri-OFL.txt`. The bundled Noto Naskh Arabic fallback
is also distributed under the SIL Open Font License 1.1; its license is included
at `assets/fonts/OFL.txt`.

## Runtime libraries

This package uses Transformers.js and its transitive open-source dependencies.
Their licenses are recorded in `package-lock.json` and their distributed
package metadata.
