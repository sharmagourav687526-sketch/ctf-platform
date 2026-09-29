(function () {
  'use strict';

  var COLORS = ['#00e5a0', '#22d3ee', '#7c5cff', '#fbbf24', '#ff5c72', '#f472b6', '#60a5fa', '#a3e635', '#fb923c', '#94a3b8'];
  var canvas = document.getElementById('chart');
  var ctx = canvas.getContext('2d');
  var legend = document.getElementById('legend');
  var tbody = document.querySelector('#standings tbody');
  var podium = document.getElementById('podium');
  var feed = document.getElementById('feed');
  var MEDALS = ['🥇', '🥈', '🥉'];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function link(o) {
    var a = el('a', null, o.name);
    a.href = (o.type === 'team' ? '/teams/' : '/users/') + o.id;
    return a;
  }

  function avatar(name) {
    var a = el('span', 'avatar avatar-sm', name.charAt(0).toUpperCase());
    a.setAttribute('data-name', name);
    return a;
  }

  function renderPodium(data) {
    podium.textContent = '';
    data.standings.slice(0, 3).forEach(function (o, i) {
      var card = el('div', 'pod p' + (i + 1));
      card.appendChild(el('span', 'pod-medal', MEDALS[i]));
      var big = avatar(o.name);
      big.className = 'avatar avatar-lg';
      card.appendChild(big);
      var name = el('span', 'pod-name');
      name.appendChild(link(o));
      card.appendChild(name);
      card.appendChild(el('span', 'pod-score', o.score + ' pts'));
      card.appendChild(el('span', 'muted small', o.solves + (o.solves === 1 ? ' solve' : ' solves')));
      podium.appendChild(card);
    });
  }

  function renderTable(data) {
    tbody.textContent = '';
    if (!data.standings.length) {
      var empty = el('tr');
      var cell = el('td', 'muted', 'No scores yet — the first solve puts you on top.');
      cell.colSpan = 4;
      empty.appendChild(cell);
      tbody.appendChild(empty);
      return;
    }
    data.standings.forEach(function (o) {
      var tr = el('tr', o.rank <= 3 ? 'rank-row-' + o.rank : '');
      tr.appendChild(el('td', null, String(o.rank)));
      var name = el('td');
      var wrap = el('span', 'nav-user');
      wrap.appendChild(avatar(o.name));
      wrap.appendChild(link(o));
      name.appendChild(wrap);
      tr.appendChild(name);
      tr.appendChild(el('td', 'num', String(o.solves)));
      tr.appendChild(el('td', 'num', String(o.score)));
      tbody.appendChild(tr);
    });
  }

  function renderFeed(items) {
    feed.textContent = '';
    if (!items.length) { feed.appendChild(el('li', 'muted', 'Nothing captured yet.')); return; }
    items.forEach(function (a) {
      var li = el('li');
      li.appendChild(el('span', 'feed-icon', a.firstBlood ? '🩸' : '🚩'));
      var text = el('span');
      text.appendChild(el('strong', null, a.who));
      text.appendChild(document.createTextNode(' solved '));
      text.appendChild(el('em', null, a.challenge));
      li.appendChild(text);
      li.appendChild(el('span', 'feed-pts', '+' + a.value));
      li.appendChild(el('span', 'feed-time', window.CTF.timeAgo(a.at)));
      feed.appendChild(li);
    });
  }

  function renderChart(series) {
    var ratio = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 900;
    var h = Math.round(w * 320 / 900);
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    canvas.style.height = h + 'px';
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    legend.textContent = '';

    var pad = { l: 50, r: 16, t: 12, b: 28 };
    var all = [];
    series.forEach(function (s) { s.points.forEach(function (p) { all.push(p); }); });
    if (!all.length) {
      ctx.fillStyle = '#8a9ab8';
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('The graph appears after the first solve.', w / 2, h / 2);
      return;
    }
    var minT = Math.min.apply(null, all.map(function (p) { return p[0]; }));
    var maxT = Math.max(Date.now(), Math.max.apply(null, all.map(function (p) { return p[0]; })));
    var maxV = Math.max(10, Math.max.apply(null, all.map(function (p) { return p[1]; })));
    if (maxT === minT) maxT = minT + 60000;
    var x = function (t) { return pad.l + (t - minT) / (maxT - minT) * (w - pad.l - pad.r); };
    var y = function (v) { return h - pad.b - v / maxV * (h - pad.t - pad.b); };

    ctx.strokeStyle = 'rgba(120, 160, 255, 0.14)';
    ctx.fillStyle = '#8a9ab8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (var i = 0; i <= 4; i++) {
      var v = maxV * i / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
      ctx.fillText(String(Math.round(v)), pad.l - 6, y(v) + 4);
    }
    for (var j = 0; j <= 4; j++) {
      var t = minT + (maxT - minT) * j / 4;
      ctx.textAlign = j === 0 ? 'left' : (j === 4 ? 'right' : 'center');
      ctx.fillText(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), x(t), h - 8);
    }

    series.forEach(function (s, idx) {
      var color = COLORS[idx % COLORS.length];
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x(s.points[0][0]), y(0));
      var prev = 0;
      s.points.forEach(function (p) {
        ctx.lineTo(x(p[0]), y(prev)); // Step: the score jumps at the moment of the solve.
        ctx.lineTo(x(p[0]), y(p[1]));
        prev = p[1];
      });
      ctx.lineTo(x(maxT), y(prev));
      ctx.stroke();
      ctx.shadowBlur = 0;

      var item = el('span');
      var swatch = el('i');
      swatch.style.background = color; // Set via CSSOM: allowed by the CSP, unlike style attributes.
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(s.name));
      legend.appendChild(item);
    });
  }

  // Pagination state.
  var totalStandings = 0;
  var loadedStandings = 0;
  var PAGE = 200;
  var loadMoreBtn = null;

  function ensureLoadMoreBtn() {
    if (loadMoreBtn) return;
    loadMoreBtn = el('button', 'btn btn-secondary');
    loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.addEventListener('click', function () {
      if (loadedStandings >= totalStandings) return;
      fetch('/api/scoreboard?offset=' + loadedStandings + '&limit=' + PAGE, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          data.standings.forEach(function (o) {
            var tr = el('tr', o.rank <= 3 ? 'rank-row-' + o.rank : '');
            tr.appendChild(el('td', null, String(o.rank)));
            var name = el('td');
            var wrap = el('span', 'nav-user');
            wrap.appendChild(avatar(o.name));
            wrap.appendChild(link(o));
            name.appendChild(wrap);
            tr.appendChild(name);
            tr.appendChild(el('td', 'num', String(o.solves)));
            tr.appendChild(el('td', 'num', String(o.score)));
            tbody.appendChild(tr);
          });
          loadedStandings += data.standings.length;
          totalStandings = data.total;
          window.CTF.paint(document);
          if (loadedStandings >= totalStandings && loadMoreBtn.parentNode) {
            loadMoreBtn.parentNode.removeChild(loadMoreBtn);
          }
        }).catch(function () {});
    });
    tbody.parentNode.parentNode.appendChild(loadMoreBtn);
  }

  var last = null;
  function load() {
    fetch('/api/scoreboard?limit=' + PAGE, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        last = data;
        totalStandings = data.total;
        loadedStandings = data.standings.length;
        renderPodium(data);
        renderTable(data);
        renderChart(data.series);
        window.CTF.paint(document);
        if (totalStandings > loadedStandings) {
          ensureLoadMoreBtn();
          loadMoreBtn.style.display = '';
        } else if (loadMoreBtn) {
          loadMoreBtn.style.display = 'none';
        }
      })
      .catch(function () { /* transient network error: keep the previous view */ });
    fetch('/api/activity?limit=15', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (items) { if (items) renderFeed(items); })
      .catch(function () { /* keep previous feed */ });
  }

  // Use SSE to refresh on solves instead of a fixed interval.
  var refreshTimer = null;
  function scheduleRefresh(ms) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { if (!document.hidden) load(); }, ms || 1500);
  }

  if (window.EventSource) {
    var es = new window.EventSource('/api/events');
    es.addEventListener('solve', function () { scheduleRefresh(1500); });
    es.onerror = function () {
      // Fall back to polling if SSE breaks.
      setInterval(function () { if (!document.hidden) load(); }, 15000);
      es.close();
    };
  } else {
    setInterval(function () { if (!document.hidden) load(); }, 15000);
  }

  window.addEventListener('resize', function () { if (last) renderChart(last.series); });
  load();
})();
