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
