// Имитация помощника трея: тот же протокол stdin/stdout. Окно «появляется», когда движок подключён к серверу.
const http = require('http');
const port = process.argv[2];
const pickResult = process.argv[3] || '';
const logFile = process.argv[4];
const fs = require('fs');
let status = 'none';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const setStatus = (v) => { if (v !== status) { status = v; out({ ev: 'status', v }); } };
out({ ev: 'ready' });
setInterval(() => {
  http.get('http://127.0.0.1:' + port + '/api/state', (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => {
      try { const j = JSON.parse(b); if (!j.engineOnline) setStatus('none'); else if (status === 'none') setStatus('visible'); } catch (e) {}
    });
  }).on('error', () => {});
}, 250);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    if (logFile) fs.appendFileSync(logFile, 'CMD ' + line + '\n');
    if (cmd === 'show' && status !== 'none') setStatus('visible');
    if (cmd === 'show' && status === 'none') out({ ev: 'open' });
    if (cmd === 'hide' && status !== 'none') setStatus('hidden');
    if (cmd === 'kick') { /* ничего: тест сам «размораживает» страницу */ }
    if (cmd === 'pick') { const id = arg.split('\t')[0]; setTimeout(() => out({ ev: 'folder', id, path: pickResult }), 200); }
    if (cmd === 'quit') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
