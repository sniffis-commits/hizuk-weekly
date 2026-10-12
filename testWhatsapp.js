/**
 * PoC: send a real test message via the project's whatsapp-web.js client.
 *
 * Same behavior as Python/testWhatsapp.py. Delegates the actual WhatsApp
 * work to waSend.js (same Client + LocalAuth + project-local Chrome as
 * index.js); this script only validates the target and streams output.
 * First run prints a QR code — scan it with WhatsApp > Linked devices.
 *
 * Usage: node testWhatsapp.js <target-jid> [message...]
 * Example: node testWhatsapp.js 120363000000000000@g.us "hello from PoC"
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function main() {
  const [target, ...msgParts] = process.argv.slice(2);

  if (!target || target === '-h' || target === '--help') {
    console.log('Usage: node testWhatsapp.js <target-jid> [message...]');
    process.exit(target ? 0 : 2);
  }
  if (!/@(g|c)\.us$/.test(target)) {
    console.error('error: target must end with @g.us (group) or @c.us (contact)');
    process.exit(2);
  }
  if (!fs.existsSync(path.join(__dirname, 'node_modules', 'whatsapp-web.js'))) {
    console.error('error: node_modules missing — run `npm install` first');
    process.exit(2);
  }
  if (!fs.existsSync(path.join(__dirname, 'waSend.js'))) {
    console.error('error: waSend.js helper missing');
    process.exit(2);
  }

  const message = msgParts.join(' ') || '✅ PoC test from testWhatsapp.js';
  console.log(`[testWhatsapp] sending to ${target} ...`);
  const res = spawnSync('node', ['waSend.js', target, message], {
    cwd: __dirname,
    stdio: 'inherit',
  });
  if (res.error) {
    console.error('[testWhatsapp] FAILED:', res.error.message);
    process.exit(1);
  }
  if (res.status === 0) {
    console.log('[testWhatsapp] OK — message delivered');
  } else {
    console.error(`[testWhatsapp] FAILED (exit code ${res.status})`);
  }
  process.exit(res.status ?? 1);
}

main();
