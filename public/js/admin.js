(function () {
  'use strict';

  // ---------- Settings: local time <-> UTC epoch ----------
  // The admin types times in their own timezone; the server stores UTC epoch milliseconds.
  function pad(n) { return String(n).padStart(2, '0'); }

  function toLocalInputValue(epoch) {
    var d = new Date(Number(epoch));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  var epochInputs = document.querySelectorAll('[data-epoch-input]');
  Array.prototype.forEach.call(epochInputs, function (input) {
    var epoch = input.getAttribute('data-epoch');
    if (epoch) input.value = toLocalInputValue(epoch);
  });

  var settingsForm = document.getElementById('settings-form');
  if (settingsForm) {
    settingsForm.addEventListener('submit', function () {
      Array.prototype.forEach.call(epochInputs, function (input) {
        var hidden = settingsForm.querySelector('input[type="hidden"][name="' + input.getAttribute('data-epoch-input') + '"]');
        hidden.value = input.value ? String(new Date(input.value).getTime()) : '';
      });
    });
  }

  // ---------- Challenge editor: live Markdown preview ----------
  var csrf = document.querySelector('meta[name="csrf-token"]');
  var textarea = document.getElementById('description');
  if (textarea && csrf) {
    var target = document.getElementById(textarea.getAttribute('data-preview-target'));
    var url = textarea.getAttribute('data-preview-url');
    var timer = null;
    var refresh = function () {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.content },
        body: JSON.stringify({ text: textarea.value }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data) target.innerHTML = data.html; }) // Server-side sanitised Markdown.
        .catch(function () { /* preview is optional */ });
    };
    textarea.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(refresh, 250); });
    refresh();
  }

  // ---------- Drag & drop file picker ----------
  var zone = document.getElementById('dropzone');
  var input = document.getElementById('file-input');
  var list = document.getElementById('file-list');
  if (zone && input && list) {
    var MAX_FILES = 10;
    var MAX_BYTES = 50 * 1024 * 1024;

    var human = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.ceil(n / 1024)) + ' KB'; };

    var showFiles = function () {
      list.textContent = '';
      Array.prototype.forEach.call(input.files, function (f) {
        var li = document.createElement('li');
        var name = document.createElement('span');
        name.textContent = f.name;
        var size = document.createElement('span');
        size.className = f.size > MAX_BYTES ? 'tag tag-bad' : 'muted';
        size.textContent = f.size > MAX_BYTES ? human(f.size) + ' — too large' : human(f.size);
        li.appendChild(name);
        li.appendChild(size);
        list.appendChild(li);
      });
      if (input.files.length > MAX_FILES) {
        var warn = document.createElement('li');
        warn.className = 'tag tag-bad';
        warn.textContent = 'Only the first ' + MAX_FILES + ' files can be uploaded at once.';
        list.appendChild(warn);
      }
    };

    input.addEventListener('change', showFiles);
    ['dragenter', 'dragover'].forEach(function (name) {
      zone.addEventListener(name, function (e) { e.preventDefault(); zone.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      zone.addEventListener(name, function (e) { e.preventDefault(); zone.classList.remove('over'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        showFiles();
      }
    });

    var form = input.form;
    if (form) {
      form.addEventListener('submit', function (e) {
        var tooBig = Array.prototype.some.call(input.files, function (f) { return f.size > MAX_BYTES; });
        if (tooBig || input.files.length > MAX_FILES) {
          e.preventDefault();
          window.CTF.toast('Please remove files over 50 MB and keep to ' + MAX_FILES + ' files.', 'blood');
        }
      });
    }
  }
})();
