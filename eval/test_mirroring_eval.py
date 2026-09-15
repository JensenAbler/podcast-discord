import importlib.util
from pathlib import Path
import unittest
s=importlib.util.spec_from_file_location("mirroring",Path(__file__).with_name("mirroring-eval.py"))
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
class MetricsTests(unittest.TestCase):
    def test_normalization(self):
        self.assertEqual(m.normalize("Mm-hmm."),"mm hmm")
        self.assertEqual(m.normalize("Mm,"),"mm")
    def test_known_distribution(self):
        r=m.lexical(["a","a","b","b"])
        self.assertEqual(r["samePhrasePairProbability"],1/3)
        self.assertEqual(r["adjacentRepeatShare"],2/3)
        self.assertEqual(r["entropyBits"],1)
    def test_empty_and_constant(self):
        self.assertIsNone(m.lexical([])["topTwoShare"])
        self.assertIsNone(m.correlation([(1,2),(1,3),(1,4)]))
    def test_correlation(self):
        self.assertAlmostEqual(m.correlation([(1,2),(2,4),(3,6)]),1)
        self.assertAlmostEqual(m.correlation([(1,6),(2,4),(3,2)]),-1)
    def test_merge_session_boundary(self):
        rows=[{"playbackStartedAt":a,"playbackEndedAt":b,"text":"Mm.","backchannelEvidence":{"sessionId":session}} for a,b,session in [(0,100,"a"),(300,400,"a"),(500,600,"b"),(1100,1200,"b")]]
        self.assertEqual(len(m.merge(rows)),3)
        self.assertEqual(len(m.merge(rows,0)),4)
        self.assertEqual(len(m.merge(rows,800)),2)
    def test_median(self):
        self.assertEqual(m.summary([100,200,300,400])["median"],250)
if __name__=="__main__": unittest.main()
