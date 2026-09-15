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

// Song visualiser — a band of bars that moves with whatever is playing.
//
// Decoration over a control that works without it, so every step here is a
// guard: no Web Audio, no canvas, no animation frames, or a reader who asked
// for less motion, and the canvas simply stays hidden and the native player
// carries on untouched.
//
// The one real hazard is that routing an <audio> element through Web Audio
// makes the graph responsible for the sound: connect the analyser and forget
// to reach the destination, or leave the context suspended, and the song goes
// silent. So the element is only rerouted from inside a play handler — a user
// gesture, where resume() is allowed — and the destination is wired in the same
// breath as the analyser.
(function () {
  var players = document.querySelectorAll('.song__player');
  if (!players.length) return;

  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !window.requestAnimationFrame) return;

  // Motion is the entire point of this element, so a reduced-motion reader is
  // better served by its absence than by a politely slower version of it.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Read the palette rather than restating it, so the bars follow the site's
  // colours if those ever change.
  var css = window.getComputedStyle(document.documentElement);
  function token(name, fallback) {
    var v = css.getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  var NAVY = token('--navy', '#12325c');
  var GOLD = token('--gold', '#bf9a4e');
  var REST = token('--rule', '#e4dcca');

  var BARS = 56;
  var GAP = 2;          // css px between bars
  var MIN = 2;          // css px: the resting height, so the row never vanishes

  var audioCtx = null;  // one context for the page, built on first play

  Array.prototype.forEach.call(players, function (audio) {
    var item = audio.parentNode;
    var canvas = item ? item.querySelector('.song__viz') : null;
    if (!canvas || !canvas.getContext) return;

    var g = canvas.getContext('2d');
    if (!g) return;

    var analyser = null;
    var bins = null;
    var frame = 0;
    var w = 0, h = 0;
    var grad = null;

    // Canvas pixels are not CSS pixels. Size to the device ratio and scale the
    // drawing context to match, or every bar is soft on a retina screen.
    function size() {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      var dpr = window.devicePixelRatio || 1;
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, NAVY);
      grad.addColorStop(1, GOLD);
      return true;
    }

    function barWidth() {
      return Math.max(1, (w - GAP * (BARS - 1)) / BARS);
    }

    function paint(heights, colour) {
      g.clearRect(0, 0, w, h);
      g.fillStyle = colour;
      var bw = barWidth();
      for (var i = 0; i < BARS; i++) {
        var bh = Math.max(MIN, heights ? heights[i] : 0);
        g.fillRect(i * (bw + GAP), h - bh, bw, bh);
      }
    }

    // Nothing playing: a quiet, even row. Reads as an instrument at rest
    // rather than as a component that failed to load.
    function rest() {
      if (!w && !size()) return;
      paint(null, REST);
    }

    // Musical energy piles up in the low bins, so a straight bin-per-bar map
    // leaves the right-hand half permanently dead. The bars are spread over the
    // spectrum on a curve instead, ignoring the top third that is mostly
    // silence, so the whole row has something to do.
    //
    // Each bar reads a *fractional* position and interpolates between
    // neighbouring bins rather than averaging a bucket. With 56 bars over 87
    // usable bins the low end runs out of integers, and bucketing made the
    // first few bars land on the same bin and move as one flat block. Bin 0 is
    // skipped outright: it is DC, and it carries no music.
    function sample() {
      var usable = Math.floor(bins.length * 0.68);
      var low = 1;
      var span = usable - low - 1;
      var out = new Array(BARS);

      for (var i = 0; i < BARS; i++) {
        var pos = low + Math.pow(i / (BARS - 1), 1.5) * span;
        var idx = Math.floor(pos);
        var frac = pos - idx;
        var a = bins[Math.min(idx, bins.length - 1)];
        var b = bins[Math.min(idx + 1, bins.length - 1)];
        out[i] = ((a + (b - a) * frac) / 255) * h;
      }
      return out;
    }

    function tick() {
      frame = window.requestAnimationFrame(tick);
      if (!analyser || (!w && !size())) return;
      analyser.getByteFrequencyData(bins);
      paint(sample(), grad);
    }

    function stop() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      rest();
    }

    // Reroute the element through an analyser. Called only from a play
    // handler, and only once — a second createMediaElementSource on the same
    // element throws, and would cost the song its sound.
    function connect() {
      if (analyser) return true;
      try {
        if (!audioCtx) audioCtx = new Ctx();
        var source = audioCtx.createMediaElementSource(audio);
        var node = audioCtx.createAnalyser();
        node.fftSize = 256;
        node.smoothingTimeConstant = 0.82;
        // The default window (-100..-30 dB) is wider than recorded music ever
        // uses, so every bar sat between 60% and 100% and the row read as a
        // solid block rather than an equaliser. Measured against these songs,
        // this window puts the average near half height and lets bars actually
        // reach the floor and the ceiling.
        node.minDecibels = -80;
        node.maxDecibels = -25;
        source.connect(node);
        node.connect(audioCtx.destination); // without this the song is silent
        analyser = node;
        bins = new Uint8Array(node.frequencyBinCount);
        return true;
      } catch (e) {
        analyser = null;
        return false;
      }
    }

    // Reroute only once the context is confirmed running.
    //
    // Browsers start an AudioContext suspended until a gesture, and a few — iOS
    // in particular has a long history here — can refuse to start it at all. A
    // song routed into a context that never runs is a silent song, which is a
    // far worse outcome than a missing decoration. So the element is left alone
    // until the graph is known to be live; until then it plays natively, and if
    // the context never starts it simply keeps doing so.
    function whenRunning(done) {
      if (audioCtx.state === 'running') return done();

      var p;
      try {
        p = audioCtx.resume && audioCtx.resume();
      } catch (e) {
        return;
      }

      if (p && p.then) {
        p.then(function () {
          if (audioCtx.state === 'running') done();
        })['catch'](function () {});
      } else {
        // Older implementations resume without returning a promise.
        setTimeout(function () {
          if (audioCtx.state === 'running') done();
        }, 120);
      }
    }

    audio.addEventListener('play', function () {
      if (analyser) { if (!frame) tick(); return; }

      try {
        if (!audioCtx) audioCtx = new Ctx();
      } catch (e) {
        return;
      }

      whenRunning(function () {
        if (connect() && !frame) tick();
      });
    });

    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (size() && !frame) rest();
      }, 150);
    });

    canvas.hidden = false;
    rest();
  });
})();
