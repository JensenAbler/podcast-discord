import contextlib,io,json,runpy,tempfile,unittest
from pathlib import Path
score=runpy.run_path(str(Path(__file__).with_name('score-reference-timing.py')))['main']
class ReferenceIntegrityTests(unittest.TestCase):
 def test_unsorted_reference_duplicate_output_and_warmup(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);ref=p/'ref.json'
   ref.write_text(json.dumps({'candidates':[{'start':s,'end':s+.1,'scorable':True} for s in [8,4,6,1]],'outputBlockIntervals':[],'limitations':[]}))
   metrics={'manifest':{'startMs':0,'durationMs':12000,'scoreStartMs':2000,'alignment':{'referenceFile':str(ref)}},'validity':{'schemaVersion':2,'timingValid':True},'failure':None,'consumed':[{'t':t,'rms':100} for t in [1000,4000,4300,6000,8000]]}
   (p/'metrics.json').write_text(json.dumps(metrics))
   with contextlib.redirect_stdout(io.StringIO()):score(str(p))
   r=json.loads((p/'reference-timing.json').read_text())['scoresByToleranceSec']['0.5']
   self.assertEqual((r['matched'],r['missed'],r['extra']),(3,0,1))
 def test_legacy_and_invalid_runs_are_not_scored(self):
  for quality in [None,{'schemaVersion':2,'timingValid':False,'reasons':['timing-invalid']}]:
   with tempfile.TemporaryDirectory() as tmp:
    p=Path(tmp);m={'manifest':{},'failure':None}
    if quality:m['validity']=quality
    (p/'metrics.json').write_text(json.dumps(m))
    with contextlib.redirect_stdout(io.StringIO()):score(str(p))
    r=json.loads((p/'reference-timing.json').read_text())
    self.assertIsNone(r['scoresByToleranceSec'])
if __name__=='__main__':unittest.main()
