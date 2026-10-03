import {Config} from './core.mjs';
try {
  const result = await new Config().configure();
  process.stdout.write(result.saved ? 'SiYuan settings saved.\n' : 'Cancelled.\n');
} catch(e) {
  process.stderr.write(e.message+'\n');
  process.exitCode=1;
}
