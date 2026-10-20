import os,subprocess,tempfile,unittest
from pathlib import Path
SOURCE=(Path(__file__).parents[1]/'stack.config/seafile/runtime-entrypoint.sh').read_text()
FUNCTION='run_seahub_migrations() {'+SOURCE.split('run_seahub_migrations() {',1)[1].split('\n}\n',1)[0]+'\n}\n'
class UpstreamSchema(unittest.TestCase):
 def invoke(self,code):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);(root/'upgrade.py').write_text(code)
   script='set -e\nensure_shared_links() { :; }\nlog() { :; }\n'+FUNCTION+'\nrun_seahub_migrations "$1"\nprintf "schema-check-returned\\n"\n'
   return subprocess.run(['bash','-c',script,'_',temp],env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'),capture_output=True,text=True)
 def test_supported_upgrader_runs_and_no_generic_django_replay(self):
  result=self.invoke('def check_upgrade():\n    print("upstream-version-stamp-checked")\n')
  self.assertEqual(0,result.returncode,result.stderr);self.assertEqual(1,result.stdout.count('upstream-version-stamp-checked'));self.assertIn('schema-check-returned',result.stdout)
  self.assertNotIn('migrate --noinput',SOURCE);self.assertNotIn('INSERT INTO django_migrations',SOURCE)
 def test_failed_vendor_upgrade_cannot_be_followed_by_readiness(self):
  result=self.invoke('def check_upgrade():\n    raise SystemExit(23)\n');self.assertEqual(23,result.returncode);self.assertNotIn('schema-check-returned',result.stdout)
 def test_missing_supported_upgrader_refuses(self):
  result=self.invoke('def unrelated():\n    pass\n');self.assertNotEqual(0,result.returncode);self.assertNotIn('schema-check-returned',result.stdout)
 def test_existing_path_schema_and_marker_gates_are_still_present(self):
  self.assertIn('bootstrap_fresh_state\n  verify_required_paths',SOURCE)
  self.assertIn('run_seahub_migrations\n  verify_database_schema\n  touch "$MARKER_FILE"',SOURCE)
  self.assertIn('required_paths_are_complete && database_schema_is_complete',SOURCE)
  self.assertIn('exec /sbin/my_init -- /scripts/enterpoint.sh',SOURCE)
if __name__=='__main__':unittest.main()
