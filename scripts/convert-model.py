#!/usr/bin/env python3
"""Development-only ONNX export for the Tarteel Qur'an Whisper checkpoint.

The shipped application performs inference entirely in TypeScript. This script
exists only to make the published Transformers.js model artifact reproducible.
"""

from __future__ import annotations

import argparse
from collections import OrderedDict
from pathlib import Path

from optimum.exporters.onnx import main_export
from optimum.exporters.onnx.model_configs import WhisperOnnxConfig
from transformers import AutoConfig


class TimestampedWhisperOnnxConfig(WhisperOnnxConfig):
    """Expose the attention tensors Transformers.js uses for word timing."""

    @property
    def torch_to_onnx_output_map(self):
        mapping = dict(super().torch_to_onnx_output_map)
        if self._behavior.value == "encoder":
            mapping["attentions"] = "encoder_attentions"
        return mapping

    @property
    def outputs(self):  # Optimum's return type differs between releases.
        outputs = OrderedDict(super().outputs)
        layers = self._config.decoder_layers

        if self._behavior.value == "encoder":
            for layer in range(self._config.encoder_layers):
                outputs[f"encoder_attentions.{layer}"] = {
                    0: "batch_size",
                    2: "encoder_sequence_length",
                    3: "encoder_sequence_length",
                }
        elif self._behavior.value == "decoder":
            decoder_length = (
                "1" if self.use_past_in_inputs else "decoder_sequence_length"
            )
            for layer in range(layers):
                outputs[f"decoder_attentions.{layer}"] = {
                    0: "batch_size",
                    2: decoder_length,
                    3: "past_decoder_sequence_length + decoder_sequence_length",
                }
            for layer in range(layers):
                outputs[f"cross_attentions.{layer}"] = {
                    0: "batch_size",
                    2: decoder_length,
                    3: "encoder_sequence_length",
                }
        return outputs


def export(model_id: str, output: Path) -> None:
    config = AutoConfig.from_pretrained(model_id)
    config.output_attentions = True
    config.use_cache = True
    base = TimestampedWhisperOnnxConfig(
        config,
        task="automatic-speech-recognition",
        use_past=True,
    )
    custom_configs = {
        "encoder_model": base.with_behavior("encoder"),
        "decoder_model": base.with_behavior(
            "decoder", use_past=True, use_past_in_inputs=False
        ),
        "decoder_with_past_model": base.with_behavior(
            "decoder", use_past=True, use_past_in_inputs=True
        ),
    }
    main_export(
        model_id,
        output=output,
        task="automatic-speech-recognition-with-past",
        custom_onnx_configs=custom_configs,
        model_kwargs={"output_attentions": True},
        atol=3e-4,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model", default="tarteel-ai/whisper-tiny-ar-quran"
    )
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    export(arguments.model, arguments.output)
