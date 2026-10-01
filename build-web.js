const fs = require('node:fs');
const path = require('node:path');

const webDir = path.join(__dirname, 'www');
fs.mkdirSync(webDir, { recursive: true });

for (const file of ['index.html', 'pay.html', 'script.js', 'style.css', 'manifest.webmanifest', 'service-worker.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(webDir, file));
}

fs.cpSync(path.join(__dirname, 'assets'), path.join(webDir, 'assets'), { recursive: true });
