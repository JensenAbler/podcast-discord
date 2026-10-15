import json,runpy,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
main=runpy.run_path(str(Path(__file__).with_name('run-listener-batch.py')))['main']
class BatchPolicyTests(unittest.TestCase):
 def attempt(self,code):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);plan=root/'plan.json';out=root/'out';calls=[]
   plan.write_text(json.dumps({'continueOnInvalid':True,'cases':[{'id':str(i),'episode':tmp,'startSec':0,'durationSec':10,'journalSha256':'x','transcriptSha256':'x','referenceSha256':'x'} for i in range(2)]}))
   def run(cmd,**kwargs):
    if cmd[0]=='node':
     calls.append(cmd[3]);p=Path(cmd[3]);p.mkdir()
     m={'manifest':{k:'same' for k in ['productionCommit','productionCodeSha256','stateChannel','voice','outputGain','promptSha256']},'validity':{'schemaVersion':2,'timingValid':False},'failure':{'code':code}}
     (p/'metrics.json').write_text(json.dumps(m));return SimpleNamespace(returncode=1)
    return SimpleNamespace(returncode=0)
   with patch.dict(main.__globals__,{'digest':lambda p:'x'}),patch('subprocess.run',side_effect=run):
    result=main(str(plan),str(out))
   state=json.loads((out/'batch.json').read_text())
   return result,state,len(calls)
 def test_independent_input_failures_continue_without_retry(self):
  result,state,count=self.attempt('input-loss')
  self.assertEqual((result,state['status'],count),(0,'completed-with-invalid-cases',2))
  self.assertTrue(all(c['status']=='invalid' for c in state['cases'].values()))
 def test_provider_rejection_stops_batch(self):
  result,state,count=self.attempt('provider-content-filter')
  self.assertEqual((result,state['status'],count),(1,'blocked',1))
if __name__=='__main__':unittest.main()
