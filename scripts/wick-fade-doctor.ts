import { closeDb } from '../src/db/client.js';
import { runWickFadeDoctor } from '../src/jobs/wick-fade-doctor.js';

const notify = !process.argv.includes('--no-send');
const force = process.argv.includes('--force') || !notify;

try {
  const res = await runWickFadeDoctor({ notify, force });
  console.log(JSON.stringify(res, null, 2));
} finally {
  closeDb();
}
