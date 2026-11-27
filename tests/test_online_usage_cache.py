#!/usr/bin/env python3
"""Isolated quota/cache tests. No real Gateway or credential store is accessed."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
FAKE = """#!/usr/bin/env python3
import os,sys,json,time
a=sys.argv[1:]
assert a[:2]==['gateway','call'], a
mode=os.environ['FAKE_USAGE_MODE']
if a[2]=='models.authStatus':
    if mode=='auth_failure':
        sys.exit(1)
    profiles=[{'profileId':'openai:example','type':'oauth','email':'example@example.invalid'},
              {'profileId':'openai:key','type':'api_key'}]
    if mode=='partial':
        profiles.append({'profileId':'openai:second','type':'oauth'})
    print(json.dumps({'providers':[{'provider':'openai','profiles':profiles}]}))
elif a[2]=='codex.accountUsage':
    p=json.loads(a[a.index('--params')+1])
    if mode=='partial' and p['profileId']=='openai:second':
        sys.exit(1)
    now=int(time.time()*1000)
    print(json.dumps({'updatedAt':now,'providers':[{'provider':'openai','plan':'plus',
          'windows':[{'label':'Week','usedPercent':13,'resetAt':now+86400000}]}]}))
else:
    sys.exit(3)
"""

class CacheTests(unittest.TestCase):
    def test_preserve_last_good_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)
            bindir=root/"bin"
            bindir.mkdir()
            fake=bindir/"openclaw"
            fake.write_text(FAKE)
            fake.chmod(0o700)
            (root/"tools").mkdir()
            for name in ("codex-usage-header","codex-usage-cache-update"):
                dest=root/"tools"/name
                shutil.copyfile(TOOLS/name,dest)
                dest.chmod(0o700)
            env=dict(os.environ, PATH=str(bindir)+os.pathsep+os.environ["PATH"],
                     OPENCLAW_USAGE_AGENT="main", OPENCLAW_USAGE_WORKSPACE=str(root))
            cache=root/"codex-usage-current.json"
            def run(mode):
                return subprocess.run(["bash",str(root/"tools"/"codex-usage-cache-update")],
                      env=dict(env,FAKE_USAGE_MODE=mode),capture_output=True,text=True,timeout=15)
            ok=run("ok")
            self.assertEqual(ok.returncode,0,ok.stderr)
            old=cache.read_bytes()
            d=json.loads(old)
            self.assertEqual(d["overallPercent"],87)
            self.assertEqual(d["configuredCount"],1)
            self.assertTrue(d["complete"])
            self.assertEqual(d["subscriptions"][0]["email"],"example@example.invalid")
            self.assertEqual(cache.stat().st_mode & 0o777,0o600)
            for mode in ("auth_failure","partial"):
                with self.subTest(mode=mode):
                    self.assertNotEqual(run(mode).returncode,0)
                    self.assertEqual(cache.read_bytes(),old)

if __name__=="__main__":
    unittest.main()
