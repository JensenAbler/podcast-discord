import importlib.util
from pathlib import Path
import unittest
import json
spec = importlib.util.spec_from_file_location("live_eval", Path(__file__).with_name("live-state-eval.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
def event(at, prefix, data):
    return {"observedAt": at, "mode": "current", "message": prefix + json.dumps(data)}
def state(at, name, rev):
    return event(at, "Environment: ", {"state": name, "revision": rev})
def progress(at, name):
    return event(at, "Alpha progress: ", {"stage": name})
def sound(at, blocked=False):
    return {"observedAt": at, "startMs": at, "endMs": at + 200,
            "text": " Mm.", "sessionId": "a", "playbackBlocked": blocked}
def run(events=None, quartz=None, transcript=None, annotation=None):
    return mod.evaluate(events or [state(0, "listening", 1)], transcript or [], quartz or [],
                        {"startedAt": 0, "stoppedAt": 20000}, annotation)
class EvalTests(unittest.TestCase):
    def test_contact_before_holding(self):
        r = run([state(0, "listening", 1), progress(1000, "thinking"),
                 state(6000, "holding", 2), state(9000, "yielding", 3)], [sound(2500)])
        self.assertEqual(r["presence"]["eligibleWaitsAtLeast3s"], 1)
        self.assertEqual(r["presence"]["waitsWithUnblockedTextProxy"], 1)
        self.assertEqual(r["presence"]["contactLatencyProxyMs"]["median"], 1500)
    def test_silent_wait(self):
        r = run([state(0, "listening", 1), progress(1000, "thinking"), progress(12000, "idle")])
        self.assertEqual(r["presence"]["eligibleWaitsAtLeast3s"], 1)
        self.assertEqual(r["presence"]["waitsWithUnblockedTextProxy"], 0)
        self.assertIsNone(r["presence"]["contactLatencyProxyMs"]["median"])
    def test_muted_text_is_not_contact(self):
        r = run([state(0, "listening", 1), progress(1000, "thinking"), progress(12000, "idle")], [sound(3000, True)])
        self.assertEqual(r["presence"]["waitsWithUnblockedTextProxy"], 0)
    def test_intentional_silence_excluded(self):
        r = run([state(0, "listening", 1), progress(1000, "thinking"), progress(12000, "idle")],
                annotation={"excludePresenceIntervals": [{"startMs": 0, "endMs": 13000}]})
        self.assertEqual(r["presence"]["eligibleWaitsAtLeast3s"], 0)
    def test_missing_evidence_is_unknown(self):
        r = run()
        self.assertFalse(r["playback"]["audioAccountingAvailable"])
        self.assertIsNone(r["playback"]["unaccountedSourceSamples"])
        self.assertIsNone(r["handoff"]["elapsedMs"]["median"])
    def test_lost_audio_and_channel_conversion(self):
        paths = {"outputReceived": {"nonSilentSamples": 100}, "outputBlocked": {"nonSilentSamples": 20},
                 "outputConsumed": {"nonSilentSamples": 480}}
        e = event(5000, "Audio diagnostics: ", {"since": 0, "until": 5000, "paths": paths})
        self.assertEqual(run([e])["playback"]["unaccountedSourceSamples"], 0)
        paths["outputConsumed"]["nonSilentSamples"] = 420
        e = event(5000, "Audio diagnostics: ", {"since": 0, "until": 5000, "paths": paths})
        self.assertEqual(run([e])["playback"]["unaccountedSourceSamples"], 10)
    def test_missing_consumed_path(self):
        e = event(5000, "Audio diagnostics: ", {"since": 0, "until": 5000,
                                               "paths": {"outputReceived": {"nonSilentSamples": 100}}})
        self.assertFalse(run([e])["playback"]["audioAccountingAvailable"])
    def test_stuck_aside_and_early_release(self):
        host = [{"speakerRole": "host", "playbackStartedAt": 1000, "playbackEndedAt": 5000}]
        stuck = run([state(0, "aside", 1)], transcript=host)
        self.assertIsNone(stuck["playback"]["recovery"][0]["listeningResumeMs"])
        early = run([state(0, "aside", 1), state(3000, "listening", 2)], transcript=host)
        self.assertEqual(early["playback"]["hostMsOutsideAside"], 2000)
    def test_reevaluation_and_end_censored(self):
        r = run([state(0, "listening", 1), progress(1000, "thinking"), progress(8000, "thinking")])
        self.assertEqual(r["presence"]["eligibleWaitsAtLeast3s"], 0)
        self.assertTrue(all(w["censored"] for w in r["presence"]["waits"]))
    def test_handoff_and_revision_failures(self):
        r = run([state(0, "listening", 2), state(1000, "holding", 1),
                 event(10000, "Handoff completed: ", {"elapsedMs": 9000, "accepted": True, "failed": True})])
        self.assertEqual(len(r["stateRevisionViolations"]), 1)
        self.assertEqual(r["handoff"]["failed"], 1)
        self.assertEqual(r["handoff"]["elapsedMs"]["median"], 9000)
    def test_startup_announcement_outside_live_is_not_overlap(self):
        e = {"observedAt": 6000, "mode": "current", "message": "Session started: test"}
        r = run([e, state(6000, "listening", 1)], transcript=[
            {"speakerRole": "host", "playbackStartedAt": 1000, "playbackEndedAt": 5000}])
        self.assertEqual(r["playback"]["hostMsOutsideAside"], 0)
        self.assertEqual(r["playback"]["hostIntervals"][0]["observedDuringLiveMs"], 0)

    def test_inline_backchannels_are_not_substantive_alpha_playback(self):
        r = run([state(0, "listening", 1)], transcript=[
            {"speakerRole": "host", "source": "quartz", "text": "Mm.",
             "playbackStartedAt": 1000, "playbackEndedAt": 1200}])
        self.assertEqual(r["playback"]["hostRowsWithTiming"], 0)
        self.assertEqual(r["playback"]["hostMsOutsideAside"], 0)

    def test_grouping_preserves_sessions(self):
        a, b = sound(1000), sound(1200);b["sessionId"] = "b"
        self.assertEqual(len(mod.vocalizations([a, b])), 2)
if __name__ == "__main__":
    unittest.main()
