// One-shot WhatsApp test sender, driven by testWhatsapp.py.
// Uses the same Client + LocalAuth + project-local Chrome as index.js.
//
// Usage: node waSend.js "<targetJid>" "<message>"
// Exits 0 on delivery, non-zero on failure/timeout.

const fs = require('fs');
const path = require('path');

// Keep everything inside the project directory.
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer-cache');

const { Client, LocalAuth } = require('whatsapp-web.js');

function findLocalChrome() {
  const root = path.join(process.env.PUPPETEER_CACHE_DIR, 'chrome');
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const exe = path.join(root, entry.name, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch (_) {
    // Cache dir missing — install it (see README.md).
  }
  return undefined;
}

async function main() {
  const [target, ...msgParts] = process.argv.slice(2);
  const message = msgParts.join(' ');
  if (!target || !message) {
    console.error('Usage: node waSend.js "<targetJid>" "<message>"');
    process.exit(2);
  }

  const chromePath = findLocalChrome();
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(chromePath ? { executablePath: chromePath } : {}),
    },
  });

  client.on('qr', (qr) => {
    require('qrcode-terminal').generate(qr, { small: true });
    console.log('[waSend] Scan the QR code with WhatsApp > Linked devices.');
  });
  client.on('auth_failure', (m) => {
    console.error('[waSend] auth failure:', m);
    process.exit(1);
  });

  const timeout = setTimeout(() => {
    console.error('[waSend] Timed out waiting for client ready (180s).');
    process.exit(1);
  }, 180000);

  client.on('ready', async () => {
    try {
      await client.sendMessage(target, message);
      console.log(`[waSend] Sent to ${target}`);
      clearTimeout(timeout);
      await client.destroy();
      process.exit(0);
    } catch (err) {
      console.error('[waSend] send failed:', err.message);
      process.exit(1);
    }
  });

  await client.initialize();
}

main();
