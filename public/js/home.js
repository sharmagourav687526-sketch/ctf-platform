// Types out the hero terminal. Falls back to instant text for reduced-motion visitors.
(function () {
  'use strict';

  var term = document.getElementById('term');
  if (!term) return;

  var lines;
  try { lines = JSON.parse(term.getAttribute('data-lines')); } catch (e) { return; }

  var instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cursor = document.createElement('span');
  cursor.className = 'cursor';

  function el(cls, text) {
    var node = document.createElement('span');
    node.className = cls;
    node.textContent = text;
    return node;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function run() {
    for (var i = 0; i < lines.length; i++) {
      var prompt = el('prompt', '$ ');
      var cmd = el('cmd', '');
      term.appendChild(prompt);
      term.appendChild(cmd);
      term.appendChild(cursor);
      for (var c = 0; c < lines[i].cmd.length; c++) {
        cmd.textContent += lines[i].cmd[c];
        if (!instant) await sleep(35 + Math.random() * 40);
      }
      if (!instant) await sleep(250);
      term.insertBefore(document.createTextNode('\n'), cursor);
      term.insertBefore(el('out', lines[i].out + '\n'), cursor);
      if (!instant) await sleep(350);
    }
    term.insertBefore(el('prompt', '$ '), cursor);
  }

  run();
})();
