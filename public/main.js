// Pha Publishing — small progressive enhancements. No dependencies.

// Current year in the footer.
var yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Mobile navigation.
var toggle = document.querySelector('.nav-toggle');
var nav = document.getElementById('nav');

if (toggle && nav) {
  toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  // Close after following an in-page link.
  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

// Highlight the section currently in view.
var links = Array.prototype.slice.call(document.querySelectorAll('.nav a[href^="#"]'));
var sections = links
  .map(function (a) { return document.querySelector(a.getAttribute('href')); })
  .filter(Boolean);

if ('IntersectionObserver' in window && sections.length) {
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      links.forEach(function (a) {
        a.classList.toggle('is-current', a.getAttribute('href') === '#' + entry.target.id);
      });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });

  sections.forEach(function (s) { observer.observe(s); });
}

// Newsletter form. Posts to our own endpoint, which holds the Resend
// credentials server-side; the browser never sees them.
var form = document.getElementById('joinForm');
var note = document.getElementById('joinNote');

if (form && note) {
  var button = form.querySelector('button[type="submit"]');
  var buttonLabel = button ? button.innerHTML : '';

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = form.querySelector('input[type="email"]');
    var value = (input.value || '').trim();

    note.classList.remove('is-error', 'is-ok');

    if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      note.textContent = 'Please enter a valid email address.';
      note.classList.add('is-error');
      input.focus();
      return;
    }

    if (button) { button.disabled = true; button.textContent = 'Joining…'; }
    note.textContent = 'One moment…';

    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: value })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.ok) {
          note.textContent = data.message || 'Thank you — you’re on the list.';
          note.classList.add('is-ok');
          form.reset();
        } else {
          note.textContent = (data && data.error) || 'Something went wrong. Please try again later.';
          note.classList.add('is-error');
        }
      })
      .catch(function () {
        note.textContent = 'Could not reach the server. Please try again later.';
        note.classList.add('is-error');
      })
      .then(function () {
        if (button) { button.disabled = false; button.innerHTML = buttonLabel; }
      });
  });
}

// Contact form. Posts to our own endpoint, which stores the message before it
// tries to email it — so a mail problem never costs the visitor their words.
var cForm = document.getElementById('contactForm');
var cNote = document.getElementById('contactNote');

if (cForm && cNote) {
  var cBtn = cForm.querySelector('button[type="submit"]');
  var cBtnHtml = cBtn ? cBtn.innerHTML : '';

  cForm.addEventListener('submit', function (e) {
    e.preventDefault();

    var payload = {
      name: cForm.name.value.trim(),
      email: cForm.email.value.trim(),
      subject: cForm.subject.value.trim(),
      message: cForm.message.value.trim(),
      website: cForm.website.value // honeypot; server discards anything here
    };

    cNote.classList.remove('is-error', 'is-ok');

    if (!payload.name) { fail('Please tell us your name.', cForm.name); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(payload.email)) { fail('Please enter a valid email address.', cForm.email); return; }
    if (payload.message.length < 10) { fail('Please write a little more so we can help.', cForm.message); return; }

    if (cBtn) { cBtn.disabled = true; cBtn.textContent = 'Sending…'; }
    cNote.textContent = 'Sending…';

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        if (d && d.ok) {
          cNote.textContent = d.message || 'Thank you — your message has been sent.';
          cNote.classList.add('is-ok');
          cForm.reset();
        } else {
          cNote.textContent = (d && d.error) || 'Something went wrong. Please try again later.';
          cNote.classList.add('is-error');
        }
      })
      .catch(function () {
        cNote.textContent = 'Could not reach the server. Please try again later.';
        cNote.classList.add('is-error');
      })
      .then(function () {
        if (cBtn) { cBtn.disabled = false; cBtn.innerHTML = cBtnHtml; }
      });
  });

  function fail(msg, el) {
    cNote.textContent = msg;
    cNote.classList.add('is-error');
    if (el) el.focus();
  }
}
