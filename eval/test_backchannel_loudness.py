import unittest
from backchannel_loudness import dbfs, energy, replay_loudness
class LoudnessTests(unittest.TestCase):
    def test_db_and_silence(self):
        self.assertIsNone(dbfs(0)); self.assertEqual(dbfs(32768),0)
        self.assertAlmostEqual(dbfs(16384),-6.020599913)
    def test_energy_not_average_db(self):
        self.assertAlmostEqual(energy([{"rms":3,"duration":1},{"rms":4,"duration":3}]),(57/4)**.5)
    def test_gain_and_states(self):
        f=[{"t":0,"rms":1000,"state":"listening"},{"t":20,"rms":2000,"state":"holding"}]
        guest=[{"t":0,"duration":40,"rms":4000}]
        a=replay_loudness(f,guest); b=replay_loudness([{**x,"rms":x["rms"]*2} for x in f],guest)
        self.assertEqual(len(a["events"]),2)
        self.assertAlmostEqual(b["events"][0]["outputMinusGuestInputDb"]-a["events"][0]["outputMinusGuestInputDb"],6.020599913)
    def test_quiet_and_missing_guest(self):
        a=replay_loudness([{"t":0,"rms":40,"state":"listening"}],[])
        self.assertEqual(a["events"],[])
        self.assertIsNotNone(a["byState"]["listening"]["allFrameRmsDbFS"])
        a=replay_loudness([{"t":0,"rms":1000,"state":"holding"}],[])
        self.assertIsNone(a["events"][0]["outputMinusGuestInputDb"])
