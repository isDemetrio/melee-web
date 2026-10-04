import csv
import importlib.util
import io
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('residual',Path(__file__).parents[1]/'phase0/evaluate_residual.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ResidualAudit(unittest.TestCase):
    def report(self, values):
        out=io.StringIO();writer=csv.DictWriter(out,fieldnames=['match_frame','hidden',*m.FIELDS]);writer.writeheader()
        for r in values:writer.writerow({'match_frame':1,'hidden':0,**{k:0 for k in m.FIELDS},**r})
        return {'frames_csv':out.getvalue()}
    def test_signed_errors_do_not_cancel(self):
        a=m.audit(self.report([{'core_unattributed_ms':15,'residual_unexplained_ms':15},{'core_unattributed_ms':-15,'residual_unexplained_ms':-15}]))
        self.assertFalse(a['closed']);self.assertEqual(a['unexplained_absolute_ms']['mean'],15)
    def test_old_report_not_zero(self):
        a=m.audit({'frames_csv':'match_frame,hidden,core_ms\n1,0,44\n'})
        self.assertFalse(a['availability']);self.assertEqual(a['matched'],0)
    def test_large_but_reconciled_interval(self):
        a=m.audit(self.report([{'core_unattributed_ms':15,'native_pre_heartbeat_ms':15}]))
        self.assertTrue(a['closed']);self.assertEqual(a['means_ms']['native_pre_heartbeat_ms'],15)
    def test_identity_mismatch_rejected(self):
        a=m.audit(self.report([{'core_unattributed_ms':15}]))
        self.assertFalse(a['closed'])
if __name__=='__main__':unittest.main()
