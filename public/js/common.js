// Shared behaviour for every page: nav, confirm dialogs, colours, toasts, confetti,
// event countdown and live notifications. Exposes a small helper API as window.CTF.
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- helpers ----------
  var FIXED_HUES = { web: 205, crypto: 270, pwn: 350, rev: 28, reverse: 28, forensics: 165, osint: 48, misc: 320, stego: 295, network: 185, mobile: 130 };

  function hue(name) {
    var key = String(name).toLowerCase();
    if (FIXED_HUES[key] !== undefined) return FIXED_HUES[key];
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    return h;
  }

  // Colour category tags, avatars and bars from their names (CSSOM is allowed by the CSP).
  function paint(root) {
    root = root || document;
    Array.prototype.forEach.call(root.querySelectorAll('[data-cat]'), function (el) {
      el.style.setProperty('--hue', hue(el.getAttribute('data-cat')));
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-name]'), function (el) {
      el.style.setProperty('--hue', hue(el.getAttribute('data-name')));
    });
  }

  function timeAgo(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return new Date(ms).toLocaleDateString();
  }

  function toast(text, kind, ms) {
    var box = document.getElementById('toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
    }, ms || 6000);
  }

  function confetti() {
    if (reduceMotion) return;
    var canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var colors = ['#00e5a0', '#22d3ee', '#7c5cff', '#fbbf24', '#ff5c72', '#ffffff'];
    var pieces = [];
    for (var i = 0; i < 150; i++) {
      pieces.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 240,
        y: canvas.height * 0.4,
        vx: (Math.random() - 0.5) * 16,
        vy: -Math.random() * 15 - 4,
        size: 5 + Math.random() * 6,
        rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.4,
        color: colors[i % colors.length],
      });
    }
    var start = performance.now();
    (function tick(now) {
      var age = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(function (p) {
        p.vy += 0.35;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - age / 3200);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });
      if (age < 3200) window.requestAnimationFrame(tick);
      else if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    })(start);
  }

  window.CTF = { hue: hue, paint: paint, timeAgo: timeAgo, toast: toast, confetti: confetti };

  // ---------- nav + confirm ----------
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // Forms with data-confirm ask first (inline handlers are blocked by the CSP).
  document.addEventListener('submit', function (event) {
    var message = event.target.getAttribute && event.target.getAttribute('data-confirm');
    if (message && !window.confirm(message)) event.preventDefault();
  });

  // ---------- colours, bars, counters ----------
  paint();

  window.requestAnimationFrame(function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-w]'), function (el) {
      el.style.width = Math.min(100, Number(el.getAttribute('data-w')) || 0) + '%';
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-count]'), function (el) {
    var target = Number(el.getAttribute('data-count')) || 0;
    if (reduceMotion || target === 0) { el.textContent = String(target); return; }
    var start = performance.now();
    (function step(now) {
      var t = Math.min(1, (now - start) / 900);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) window.requestAnimationFrame(step);
    })(start);
  });

  // ---------- event countdown ----------
  var countdown = document.getElementById('countdown');
  if (countdown) {
    var startAt = Number(countdown.getAttribute('data-start')) || null;
    var endAt = Number(countdown.getAttribute('data-end')) || null;
    var fmt = function (ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      var d = Math.floor(s / 86400);
      var hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
      var mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      var ss = String(s % 60).padStart(2, '0');
      return (d ? d + 'd ' : '') + hh + ':' + mm + ':' + ss;
    };
    var tick = function () {
      var now = Date.now();
      countdown.className = 'countdown';
      if (startAt && now < startAt) {
        countdown.textContent = 'Starts in ' + fmt(startAt - now);
      } else if (endAt && now < endAt) {
        countdown.textContent = 'Ends in ' + fmt(endAt - now);
        countdown.classList.add('live');
      } else if (endAt) {
        countdown.textContent = 'Event ended';
        countdown.classList.add('done');
      } else {
        countdown.textContent = 'Live now';
        countdown.classList.add('live');
      }
    };
    tick();
    setInterval(tick, 1000);
  }

  // ---------- news badge ----------
  function safeStorage(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  var local = safeStorage('localStorage');
  var badge = document.getElementById('news-badge');
  if (badge && local) {
    fetch('/api/announcements').then(function (r) { return r.ok ? r.json() : []; }).then(function (items) {
      var seen = Number(local.getItem('ctf.newsSeen')) || 0;
      var unread = items.filter(function (a) { return a.id > seen; }).length;
      if (unread > 0 && !document.querySelector('[data-announcement]')) {
        badge.textContent = String(unread);
        badge.hidden = false;
      }
    }).catch(function () { /* badge is a nicety */ });
  }

  // ---------- live solve notifications (signed-in players) ----------
  // Use SSE when available; fall back to polling on reconnect only.
  var session = safeStorage('sessionStorage');
  if (document.body.getAttribute('data-auth') === '1' && session) {
    var lastId = session.getItem('ctf.lastSolve');
    var sseActive = false;

    // Prime the baseline so we don't toast stale solves on first load.
    var primeBaseline = function () {
      if (lastId !== null) return;
      fetch('/api/activity?since=0&limit=1', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (items) {
          if (!items.length) { lastId = '0'; } else {
            lastId = String(items.reduce(function (m, a) { return Math.max(m, a.id); }, 0));
          }
          session.setItem('ctf.lastSolve', lastId);
        }).catch(function () {});
    };

    var activeEs = null;
    var connectSSE = function () {
      if (!window.EventSource) return;
      var es = new window.EventSource('/api/events');
      activeEs = es;
      sseActive = true;
      es.addEventListener('solve', function (e) {
        var a;
        try { a = JSON.parse(e.data); } catch (ex) { return; }
        if (a.firstBlood) toast('🩸 ' + a.who + ' got FIRST BLOOD on "' + a.challenge + '"!', 'blood', 8000);
        else toast('🚩 ' + a.who + ' solved "' + a.challenge + '" (+' + a.points + ')', 'ok');
      });
      es.addEventListener('announcement', function (e) {
        var a;
        try { a = JSON.parse(e.data); } catch (ex) { return; }
        toast('📢 ' + a.title, 'info', 8000);
      });
      es.onerror = function () {
        es.close();
        activeEs = null;
        sseActive = false;
        // Brief back-off before reconnect.
        setTimeout(connectSSE, 10000);
      };
    };

    window.addEventListener('pagehide', function () {
      if (activeEs) { activeEs.close(); activeEs = null; }
    });

    primeBaseline();
    connectSSE();
  }

  // ---------- Hacking UX effects ----------
  if (!reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    var hckCursor = document.getElementById('hck-cursor');
    if (hckCursor) {
      hckCursor.classList.add('active');

      document.addEventListener('mousemove', function (e) {
        hckCursor.style.left = e.clientX + 'px';
        hckCursor.style.top  = e.clientY + 'px';
        spawnTrail(e.clientX, e.clientY);
      });
      document.addEventListener('mousedown', function () { hckCursor.classList.add('clicking'); });
      document.addEventListener('mouseup',   function () { hckCursor.classList.remove('clicking'); });
      document.addEventListener('mouseover', function (e) {
        if (e.target.closest('button,a,input,select,textarea,label,[role="button"]'))
          hckCursor.classList.add('hovering');
        else
          hckCursor.classList.remove('hovering');
      });
    }

    var trailThrottle = 0;
    function spawnTrail(x, y) {
      var now = Date.now();
      if (now - trailThrottle < 30) return;
      trailThrottle = now;
      var dot = document.createElement('div');
      dot.className = 'trail-dot';
      dot.style.left = x + 'px';
      dot.style.top  = y + 'px';
      document.body.appendChild(dot);
      requestAnimationFrame(function () {
        dot.style.opacity = '.55';
        setTimeout(function () {
          dot.style.opacity = '0';
          setTimeout(function () { if (dot.parentNode) dot.parentNode.removeChild(dot); }, 500);
        }, 60);
      });
    }
  }

  if (!reduceMotion && window.IntersectionObserver) {
    var revealObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObs.unobserve(entry.target);
        }
      });
    }, { threshold: .08 });

    document.querySelectorAll('.chal').forEach(function (el, i) {
      el.classList.add('reveal');
      el.style.transitionDelay = Math.min(i * 35, 350) + 'ms';
      revealObs.observe(el);
    });
  }
})();
