import { closeDb } from '../src/db/client.js';
import { runHlMomentumShadowReport } from '../src/jobs/hl-momentum-shadow.js';

const notify = !process.argv.includes('--no-send');
const force = process.argv.includes('--force') || !notify;

try {
  const res = await runHlMomentumShadowReport({ notify, force });
  console.log(JSON.stringify(res, null, 2));
} finally {
  closeDb();
}
