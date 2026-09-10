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

// Newsletter form.
//
// There is no mailing-list backend wired up yet, so rather than silently
// swallowing an address we validate it and tell the visitor plainly. Replace
// this handler with a POST to the provider once one is chosen.
var form = document.getElementById('joinForm');
var note = document.getElementById('joinNote');

if (form && note) {
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

    note.textContent = 'Sign-ups aren’t connected yet — please email us and we’ll add you to the list.';
    note.classList.add('is-ok');
  });
}
