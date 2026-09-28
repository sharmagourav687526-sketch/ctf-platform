// Matrix-style rain behind every page. Pauses when the tab is hidden and is skipped
// entirely for visitors who asked their OS for reduced motion.
(function () {
  'use strict';

  var canvas = document.getElementById('bg');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var ctx = canvas.getContext('2d');
  var SIZE = 18;
  var CHARS = '01ABCDEF{}<>/\\$#!?=+*%&'.split('');
  var w, h, drops;
  var last = 0;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    drops = [];
    for (var i = 0; i < Math.ceil(w / SIZE); i++) drops.push(-Math.random() * 60);
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, w, h);
  }

  function frame(now) {
    window.requestAnimationFrame(frame);
    if (document.hidden || now - last < 60) return;
    last = now;

    ctx.fillStyle = 'rgba(5, 7, 13, 0.1)';
    ctx.fillRect(0, 0, w, h);
    ctx.font = SIZE + 'px monospace';

    for (var i = 0; i < drops.length; i++) {
      var y = drops[i] * SIZE;
      if (y > 0) {
        ctx.fillStyle = Math.random() > 0.97 ? '#d5fff2' : 'rgba(0, 229, 160, 0.75)';
        ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)], i * SIZE, y);
      }
      if (y > h && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 1;
    }
  }

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 200);
  });

  resize();
  window.requestAnimationFrame(frame);
})();
