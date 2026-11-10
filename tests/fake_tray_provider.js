// Трей-заглушка для тестов (вместо окна Electron): записывает команды в файл.
const EventEmitter = require('events'); const fs = require('fs');
module.exports = function fakeTrayProvider(logFile) {
  const t = new EventEmitter();
  t.available = true; t.status = 'visible';
  const rec = (c) => fs.appendFileSync(logFile, 'CMD ' + c + '\n');
  const set = (s) => { if (t.status !== s) { t.status = s; t.emit('status', s); t.emit('change'); } };
  t.show = () => { rec('show'); set('visible'); return true; };
  t.hide = () => { rec('hide'); set('hidden'); return true; };
  t.kick = () => { rec('kick'); return true; };
  t.stop = () => true;
  t.pickFolder = () => Promise.resolve('');
  return t;
};
