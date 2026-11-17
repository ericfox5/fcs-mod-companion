// Account pages: the "Copy join code" button and select-all on the join code box. Everything works without this file:
// the code can be selected and copied by hand, and the download link is a plain link.
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!btn) return;
    var box = document.getElementById(btn.getAttribute('data-copy'));
    if (!box) return;
    var done = function () { var n = document.getElementById('copy-done'); if (n) n.hidden = false; btn.textContent = 'Copied'; };
    var fallback = function () { try { document.execCommand('copy'); done(); } catch (err) { /* the text is selected: Ctrl+C works */ } };
    box.focus(); box.select();
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(done, fallback);
    else fallback();
  });
  var code = document.getElementById('join-code');
  if (code) code.addEventListener('focus', function () { code.select(); });
})();
