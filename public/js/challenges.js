(function () {
  'use strict';

  var csrf = document.querySelector('meta[name="csrf-token"]').content;
  var board = document.getElementById('board');
  var filters = document.getElementById('filters');
  var search = document.getElementById('search');
  var modal = document.getElementById('modal');
  var progressText = document.getElementById('progress-text');
  var pointsText = document.getElementById('points-text');
  var progressBar = document.getElementById('progress-bar');
  var els = {
    meta: document.getElementById('modal-meta'),
    title: document.getElementById('modal-title'),
    points: document.getElementById('modal-points'),
    desc: document.getElementById('modal-desc'),
    connWrap: document.getElementById('modal-conn-wrap'),
    conn: document.getElementById('modal-conn'),
    copy: document.getElementById('copy-conn'),
    files: document.getElementById('modal-files'),
    hints: document.getElementById('modal-hints'),
    form: document.getElementById('flag-form'),
    input: document.getElementById('flag-input'),
    result: document.getElementById('flag-result'),
    attempts: document.getElementById('modal-attempts'),
    solversWrap: document.getElementById('modal-solvers-wrap'),
    solvers: document.getElementById('modal-solvers'),
  };
  var els2 = {
    writeups: document.getElementById('modal-writeups'),
    writeupsWrap: document.getElementById('modal-writeups-wrap'),
    writeupFormWrap: document.getElementById('writeup-form-wrap'),
    writeupForm: document.getElementById('writeup-form'),
    writeupUrl: document.getElementById('writeup-url'),
    writeupResult: document.getElementById('writeup-result'),
  };
  var state = { challenges: [], category: 'all', hideSolved: false, query: '', openId: null, opener: null, justSolved: null };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function api(url, options) {
    options = options || {};
    options.headers = Object.assign({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, options.headers);
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    });
  }

  function matches(c) {
    if (state.category !== 'all' && c.category !== state.category) return false;
    if (state.hideSolved && c.solved) return false;
    var q = state.query.trim().toLowerCase();
    return !q || c.name.toLowerCase().indexOf(q) !== -1 || c.category.toLowerCase().indexOf(q) !== -1;
  }

  function renderProgress() {
    var total = state.challenges.length;
    var solved = state.challenges.filter(function (c) { return c.solved; });
    var earned = solved.reduce(function (n, c) { return n + c.value; }, 0);
    progressText.textContent = total ? solved.length + ' / ' + total + ' challenges solved' : 'No challenges yet';
    pointsText.textContent = earned + ' points from solves';
    progressBar.style.width = (total ? Math.round(solved.length / total * 100) : 0) + '%';
  }

  function renderFilters() {
    filters.textContent = '';
    var counts = {};
    state.challenges.forEach(function (c) { counts[c.category] = (counts[c.category] || 0) + 1; });
    var cats = ['all'].concat(Object.keys(counts).sort());
    cats.forEach(function (cat) {
      var label = cat === 'all' ? 'All (' + state.challenges.length + ')' : cat + ' (' + counts[cat] + ')';
      var chip = el('button', 'chip' + (state.category === cat ? (cat === 'all' ? ' on-all' : ' on') : ''), label);
      chip.type = 'button';
      if (cat !== 'all') chip.style.setProperty('--hue', window.CTF.hue(cat));
      chip.addEventListener('click', function () { state.category = cat; render(); });
      filters.appendChild(chip);
    });
    var hide = el('button', 'chip' + (state.hideSolved ? ' on-all' : ''), 'Hide solved');
    hide.type = 'button';
    hide.addEventListener('click', function () { state.hideSolved = !state.hideSolved; render(); });
    filters.appendChild(hide);
  }

  function render() {
    renderProgress();
    renderFilters();
    board.textContent = '';
    if (!state.challenges.length) { board.appendChild(el('p', 'muted', 'No challenges are available yet.')); return; }
    var visible = state.challenges.filter(matches);
    if (!visible.length) { board.appendChild(el('p', 'muted', 'Nothing matches your filters.')); return; }

    var groups = {};
    visible.forEach(function (c) { (groups[c.category] = groups[c.category] || []).push(c); });
    Object.keys(groups).sort().forEach(function (cat) {
      var section = el('section', 'category');
      var heading = el('h2', null, cat);
      heading.appendChild(el('small', null, groups[cat].filter(function (c) { return c.solved; }).length + '/' + groups[cat].length + ' solved'));
      section.appendChild(heading);
      var grid = el('div', 'cards');
      groups[cat].forEach(function (c) {
        var btn = el('button', 'chal' + (c.solved ? ' solved' : '') + (state.justSolved === c.id ? ' just-solved' : ''));
        btn.type = 'button';
        btn.style.setProperty('--hue', window.CTF.hue(c.category));
        btn.appendChild(el('span', 'chal-name', c.name));
        btn.appendChild(el('span', 'chal-pts', c.value + ' pts'));
        var meta = el('span', 'chal-meta');
        meta.appendChild(el('span', null, c.solves + (c.solves === 1 ? ' solve' : ' solves')));
        btn.appendChild(meta);
        btn.addEventListener('click', function () { state.opener = btn; openChallenge(c.id); });
        grid.appendChild(btn);
      });
      section.appendChild(grid);
      board.appendChild(section);
    });
    state.justSolved = null;
  }

  function loadList() {
    return api('/api/challenges').then(function (r) {
      if (r.status !== 200) { board.textContent = r.data.error || 'Could not load challenges.'; return; }
      state.challenges = r.data;
      render();
    });
  }

  function setResult(text, kind) {
    els.result.textContent = text || '';
    els.result.className = 'result' + (kind ? ' ' + kind : '');
    if (kind === 'bad') { void els.result.offsetWidth; els.result.classList.add('shake'); }
  }

  function renderWriteups(list, solved) {
    els2.writeups.textContent = '';
    var myWriteup = null;
    list.forEach(function (w) {
      var li = el('li', 'writeup-item');
      var a = el('a', 'writeup-link', w.username + '\'s writeup');
      a.href = w.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.appendChild(a);
      if (w.is_mine) {
        myWriteup = w;
        var del = el('button', 'btn btn-small btn-danger writeup-del', 'Delete');
        del.type = 'button';
        del.addEventListener('click', function () {
          if (!window.confirm('Delete your writeup?')) return;
          api('/api/writeups/' + w.id, { method: 'DELETE', body: '{}' }).then(function (r) {
            if (r.status !== 200) return;
            loadWriteups(state.openId, solved);
          });
        });
        li.appendChild(del);
      }
      els2.writeups.appendChild(li);
    });
    if (!list.length) {
      var empty = el('li', 'muted small', 'No writeups yet.');
      els2.writeups.appendChild(empty);
    }
    els2.writeupFormWrap.hidden = !solved;
    if (solved) {
      els2.writeupUrl.value = myWriteup ? myWriteup.url : '';
      els2.writeupForm.querySelector('button').textContent = myWriteup ? 'Update' : 'Save';
      els2.writeupResult.textContent = '';
    }
  }

  function loadWriteups(challengeId, solved) {
    api('/api/challenges/' + challengeId + '/writeups').then(function (r) {
      if (r.status === 200) renderWriteups(r.data, solved);
    });
  }

  function renderSolvers(list) {
    els.solvers.textContent = '';
    els.solversWrap.hidden = !list.length;
    list.forEach(function (s) {
      var li = el('li');
      li.appendChild(el('span', null, (s.firstBlood ? '🩸 ' : '') + s.who));
      li.appendChild(el('span', 'muted', window.CTF.timeAgo(s.at)));
      els.solvers.appendChild(li);
    });
  }

  function fillModal(c) {
    state.openId = c.id;
    els.meta.textContent = c.category;
    els.meta.setAttribute('data-cat', c.category);
    window.CTF.paint(els.meta.parentNode);
    els.title.textContent = c.name;
    els.points.textContent = c.value + ' pts' + (c.solved ? ' — solved ✓' : '');
    els.desc.innerHTML = c.description_html; // Escaped and sanitised by the server-side Markdown renderer.
    els.connWrap.hidden = !c.connection_info;
    els.conn.textContent = c.connection_info || '';
    els.files.textContent = '';
    c.files.forEach(function (f) {
      var li = el('li');
      var a = el('a', null, '⬇ ' + f.filename + ' (' + (f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.ceil(f.size / 1024) + ' KB') + ')');
      a.href = '/files/' + f.id;
      li.appendChild(a);
      els.files.appendChild(li);
    });
    renderHints(c);
    renderSolvers(c.solvers || []);
    els.input.disabled = c.solved;
    els.form.querySelector('button').disabled = c.solved;
    els.input.placeholder = c.solved ? 'Already solved' : 'flag{...}';
    els.attempts.textContent = c.max_attempts ? 'Attempts: ' + c.attempts + ' / ' + c.max_attempts : (c.attempts ? 'Attempts: ' + c.attempts : '');
  }

  function renderHints(c) {
    els.hints.textContent = '';
    c.hints.forEach(function (h, i) {
      var box = el('div', 'hint');
      if (h.unlocked) {
        box.textContent = '💡 Hint ' + (i + 1) + ': ' + h.content;
      } else {
        var btn = el('button', 'btn btn-small btn-ghost', 'Unlock hint ' + (i + 1) + (h.cost ? ' (costs ' + h.cost + ' points)' : ' (free)'));
        btn.type = 'button';
        btn.addEventListener('click', function () {
          if (h.cost && !window.confirm('Unlocking this hint costs ' + h.cost + ' points. Continue?')) return;
          api('/api/hints/' + h.id + '/unlock', { method: 'POST', body: '{}' }).then(function (r) {
            if (r.status !== 200) { setResult(r.data.message || r.data.error || 'Could not unlock hint.', 'bad'); return; }
            h.unlocked = true;
            h.content = r.data.content;
            renderHints(c);
            if (h.cost) window.CTF.toast('Hint unlocked (-' + h.cost + ' points)', '');
          });
        });
        box.appendChild(btn);
      }
      els.hints.appendChild(box);
    });
  }

  function openChallenge(id) {
    return api('/api/challenges/' + id).then(function (r) {
      if (r.status !== 200) return;
      setResult('');
      els.input.value = '';
      fillModal(r.data);
      loadWriteups(id, !!r.data.solved);
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      if (!els.input.disabled) els.input.focus();
    });
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    state.openId = null;
    if (state.opener) state.opener.focus();
  }

  els.form.addEventListener('submit', function (event) {
    event.preventDefault();
    var id = state.openId;
    var flag = els.input.value.trim();
    if (!id || !flag) return;
    setResult('Checking…', 'info');
    api('/api/challenges/' + id + '/attempt', { method: 'POST', body: JSON.stringify({ flag: flag }) }).then(function (r) {
      var s = r.data.status;
      var kind = s === 'correct' ? 'ok' : (s === 'incorrect' ? 'bad' : 'info');
      setResult(r.data.message || r.data.error || 'Something went wrong.', kind);
      if (s === 'correct') {
        state.justSolved = id;
        window.CTF.confetti();
        window.CTF.toast((r.data.firstBlood ? '🩸 First blood! ' : '🎉 Solved! ') + '+' + r.data.value + ' points', r.data.firstBlood ? 'blood' : 'ok');
        loadList();
        openChallenge(id).then(function () { setResult(r.data.message, 'ok'); });
      } else if (s === 'already_solved') {
        loadList();
        openChallenge(id).then(function () { setResult(r.data.message, 'info'); });
      } else if (s === 'incorrect') {
        els.input.select();
        api('/api/challenges/' + id).then(function (d) {
          if (d.status === 200) els.attempts.textContent = d.data.max_attempts ? 'Attempts: ' + d.data.attempts + ' / ' + d.data.max_attempts : 'Attempts: ' + d.data.attempts;
        });
      }
    });
  });

  els2.writeupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var url = els2.writeupUrl.value.trim();
    if (!url) return;
    els2.writeupResult.textContent = 'Saving…';
    api('/api/challenges/' + state.openId + '/writeup', { method: 'POST', body: JSON.stringify({ url: url }) }).then(function (r) {
      if (r.status === 200) {
        renderWriteups(r.data.writeups, true);
        els2.writeupResult.textContent = 'Writeup saved!';
        els2.writeupResult.className = 'result small ok';
      } else {
        els2.writeupResult.textContent = r.data.error || 'Could not save writeup.';
        els2.writeupResult.className = 'result small bad';
      }
    });
  });

  els.copy.addEventListener('click', function () {
    var text = els.conn.textContent;
    var done = function () { els.copy.textContent = 'Copied!'; setTimeout(function () { els.copy.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else done();
  });

  search.addEventListener('input', function () { state.query = search.value; render(); });
  document.getElementById('modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
    // "/" jumps to search, like most CTF sites.
    if (event.key === '/' && modal.hidden && document.activeElement !== search && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      event.preventDefault();
      search.focus();
    }
  });

  loadList();
  // Keep solve counts and point values fresh while the page stays open.
  setInterval(function () { if (modal.hidden && document.activeElement !== search) loadList(); }, 30000);
})();
