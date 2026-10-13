# Quartz backchannel evaluation policy

Jensen's direction, 2026-10-13: use only the currently deployed Quartz mode. Keep backchannels clearly audible at the Sonoma-era calibrated level. Judge and improve their timing and conversational fit at that level.

The September 27 attenuation (25% baseline, five-second rising-state volume ramp) was a temporary response to interruptive sounds in Sonoma. It is now removed. The prior 4x calibration and -1 dBFS limiter are restored. Floor-holding duration/intonation instructions remain separate from playback volume.

Review each audible event in conversation context for:
- Timing: natural opening, helpful overlap, interruption, or too-late contact.
- Conversational fit: appropriate acknowledgment versus inappropriate agreement or taking the floor.
- Space: sound duration, repeated sounds, and competition with the speaker.
- Coverage: meaningful moments left without contact and long within-turn gaps.

Record timestamped labels and reviewer notes; do not infer subjective appropriateness from energy thresholds or rates alone. Separate model-generated audio, gated output, and actually consumed audio. Count and timing comparisons across gain changes must normalize the measurement threshold or use raw output evidence, because raising gain can reveal previously subthreshold sounds.

Baseline pilot: /var/lib/praxis-root/home/backchannel-evals-20261013/andy8-live-01
This five-minute Andy8 replay used the attenuated level. The restored-volume export raises only Quartz by 4x using identical consumed audio, preserving model decisions and timing. It is an audition of the volume restoration, not a fresh model run. No holding_rising frames occurred, so reversing the attenuation is uniform throughout. Decoded Opus and final mix limiting prevent bit-exact reconstruction of a new pre-Opus render.

Human comparison still needs verified acknowledgment labels. Acoustic short-overlap candidates are not ground-truth backchannels. The model mode stays fixed; expand clean excerpts and label conversational fit before making timing-policy changes.
