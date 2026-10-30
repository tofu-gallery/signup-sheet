// Sign-up sheet: the one script, and every page works without it. It only shows Copy and Share buttons (copying the
// text of a read-only box, or opening the phone's share sheet), and stops a form being sent twice by a double tap. It
// never reads or writes cookies and never sends anything anywhere.
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  // One status line, read out by screen readers, for what a button just did ("Copied").
  var live = null;

  function say(text) {
    if (!live) {
      live = document.createElement('p');
      live.className = 'sr';
      live.setAttribute('role', 'status');
      document.body.appendChild(live);
    }
    live.textContent = '';
    setTimeout(function () {
      live.textContent = text;
    }, 50);
  }

  function flash(button) {
    var label = button.textContent;
    var done = button.getAttribute('data-done');
    if (!done) return;
    button.textContent = done;
    say(done);
    setTimeout(function () {
      button.textContent = label;
      if (live) live.textContent = '';
    }, 2000);
  }

  function copyFrom(box, button) {
    var text = box.value;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () {
          flash(button);
        },
        function () {
          box.focus();
          box.select();
        }
      );
      return;
    }
    box.focus();
    box.select();
    try {
      if (document.execCommand('copy')) flash(button);
    } catch (error) {
      // The text stays selected for the person to copy.
    }
  }

  function ready() {
    var buttons = document.querySelectorAll('[data-copy]');
    for (var i = 0; i < buttons.length; i += 1) {
      (function (button) {
        var box = document.getElementById(button.getAttribute('data-copy'));
        if (!box) return;
        button.hidden = false;
        button.addEventListener('click', function () {
          copyFrom(box, button);
        });
      })(buttons[i]);
    }

    if (typeof navigator.share === 'function') {
      var shares = document.querySelectorAll('[data-share], [data-share-url]');
      for (var j = 0; j < shares.length; j += 1) {
        (function (button) {
          var textBox = document.getElementById(button.getAttribute('data-share') || '');
          var urlBox = document.getElementById(button.getAttribute('data-share-url') || '');
          if (!textBox && !urlBox) return;
          button.hidden = false;
          button.addEventListener('click', function () {
            var data = textBox ? { text: textBox.value } : { url: urlBox.value };
            var title = button.getAttribute('data-title');
            if (title) data.title = title;
            navigator.share(data).catch(function () {});
          });
        })(shares[j]);
      }
    }
  }

  // A second tap on a form already sent does nothing; the buttons come back if the page is shown again. A GET form
  // (a download, a preview) changes nothing, so it is never held back.
  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') return;
      if (form.getAttribute('data-sent')) {
        event.preventDefault();
        return;
      }
      form.setAttribute('data-sent', '1');
      setTimeout(function () {
        var controls = form.querySelectorAll('button[type="submit"]');
        for (var k = 0; k < controls.length; k += 1) controls[k].disabled = true;
      }, 0);
      setTimeout(function () {
        release(form);
      }, 10000);
    },
    true
  );

  function release(form) {
    form.removeAttribute('data-sent');
    var controls = form.querySelectorAll('button[type="submit"]');
    for (var k = 0; k < controls.length; k += 1) controls[k].disabled = false;
  }

  window.addEventListener('pageshow', function () {
    var forms = document.querySelectorAll('form[data-sent]');
    for (var f = 0; f < forms.length; f += 1) release(forms[f]);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
