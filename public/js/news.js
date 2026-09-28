// Opening the news page marks every announcement as read (clears the nav badge).
(function () {
  'use strict';
  try {
    var max = 0;
    Array.prototype.forEach.call(document.querySelectorAll('[data-announcement]'), function (el) {
      max = Math.max(max, Number(el.getAttribute('data-announcement')) || 0);
    });
    if (max) window.localStorage.setItem('ctf.newsSeen', String(max));
  } catch (e) { /* storage unavailable: badge just stays */ }
})();
