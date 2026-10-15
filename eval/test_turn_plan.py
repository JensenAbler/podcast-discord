import runpy,unittest
from pathlib import Path
spans=runpy.run_path(str(Path(__file__).with_name('plan-turn-replays.py')))['spans']
class TurnPlanTests(unittest.TestCase):
 def test_overlapping_unsorted_blocks(self):
  self.assertEqual(list(spans(0,10,[[6,8],[2,4],[3,5]])),[(0,2),(5,6),(8,10)])
 def test_clipped_edges(self):
  self.assertEqual(list(spans(0,10,[[-2,1],[9,12]])),[(1,9)])
 def test_no_blocks(self):
  self.assertEqual(list(spans(0,10,[])),[(0,10)])
if __name__=='__main__':unittest.main()
