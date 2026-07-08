import { runHlMomentumDoctor } from '../src/jobs/hl-momentum-doctor.js';

const force = process.argv.includes('--force');
const notify = !process.argv.includes('--no-notify');

runHlMomentumDoctor({ force, notify })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
