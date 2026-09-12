'use strict';

/**
 * Branded email layout.
 *
 * Email is not the web. Everything here is deliberately old-fashioned because
 * the alternatives do not survive the clients people actually use:
 *
 *   Tables, not flexbox or grid — Outlook renders through Word's engine.
 *   Inline styles — Gmail strips much of <head>, so a stylesheet is a gamble.
 *   Georgia, not Playfair — web fonts are ignored by most clients, and the
 *     fallback is what almost everyone will see, so it is chosen rather than
 *     inherited by accident.
 *   PNG, not WebP — Outlook desktop will not render WebP at all.
 *   A version query on the logo — an image path requested before it has
 *     deployed can be cached as a miss at the edge and stay broken.
 *
 * Every email also carries a plain-text alternative. Some clients prefer it,
 * some people insist on it, and a message with no text part scores worse with
 * spam filters.
 */

const SITE = process.env.SITE_URL || 'https://phapublishing.com';

// Bumped when the logo file changes, so a cached miss cannot outlive a deploy.
const ASSET_V = '2';

// The email palette is deliberately its own thing rather than the site's.
// A page fills the viewport, so a warm ground reads as atmosphere; an email
// sits in an inbox surrounded by white, where the same warmth reads as a
// discoloured rectangle. So the ground is white and only the card is beige,
// lighter than the site's cream so it stays a tint rather than a block.
const C = {
  navy: '#12325c',
  navyDeep: '#0d2545',
  gold: '#bf9a4e',
  page: '#ffffff',   // the ground the card sits on
  card: '#fdfaf5',   // the card itself — a hint of beige, not a wash
  tint: '#f7f2e8',   // quoted blocks inside the card
  ink: '#33404f',
  inkSoft: '#5b6875',
  rule: '#eae2d2',
};

const SERIF = "Georgia, 'Times New Roman', Times, serif";

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Preserve the shape of what someone typed without letting it inject markup. */
function paragraphs(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * @param {object} o
 * @param {string} o.title     shown in the preview pane and as the heading
 * @param {string} o.preheader the grey line clients show beside the subject
 * @param {string} o.body      inner HTML, already escaped by the caller
 * @param {string} [o.footNote]
 */
function layout({ title, preheader, body, footNote }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">

<!-- Preheader: shown next to the subject line in most inboxes. Hidden in the
     body itself, and padded so the client does not pull following text in. -->
<div style="display:none;font-size:1px;color:${C.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
  ${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr>
    <td align="center" style="padding:28px 12px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:600px;max-width:100%;background:${C.card};border:1px solid ${C.rule};">

        <!-- Masthead -->
        <tr>
          <td align="center" style="padding:30px 28px 22px;background:${C.card};">
            <a href="${SITE}?utm_source=email&utm_medium=email" style="text-decoration:none;">
              <img src="${SITE}/img/email-logo.png?v=${ASSET_V}" alt="Pha Publishing"
                   width="220" style="display:block;width:220px;max-width:60%;height:auto;border:0;">
            </a>
          </td>
        </tr>
        <tr><td style="height:3px;background:${C.gold};font-size:0;line-height:0;">&nbsp;</td></tr>

        <!-- Body -->
        <tr>
          <td style="padding:30px 34px 26px;font-family:${SERIF};font-size:16px;line-height:1.65;color:${C.ink};">
            <h1 style="margin:0 0 20px;font-family:${SERIF};font-size:22px;line-height:1.25;font-weight:700;color:${C.navy};">
              ${esc(title)}
            </h1>
            ${body}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 34px 26px;background:${C.navyDeep};font-family:${SERIF};font-size:12px;line-height:1.7;color:#a9b8ca;">
            ${footNote ? `<p style="margin:0 0 10px;color:#c6d0dd;">${footNote}</p>` : ''}
            <p style="margin:0;">
              <a href="${SITE}" style="color:#d9bc7c;text-decoration:none;">phapublishing.com</a>
              &nbsp;&middot;&nbsp; Books for a brighter tomorrow.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Notification to Susan when someone uses the contact form. */
function contactNotification(m) {
  const body = `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="margin:0 0 22px;border-collapse:collapse;">
              <tr>
                <td style="padding:4px 0;font-family:${SERIF};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.inkSoft};width:74px;">From</td>
                <td style="padding:4px 0;font-family:${SERIF};font-size:16px;color:${C.ink};"><strong>${esc(m.name)}</strong></td>
              </tr>
              <tr>
                <td style="padding:4px 0;font-family:${SERIF};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.inkSoft};">Email</td>
                <td style="padding:4px 0;font-family:${SERIF};font-size:16px;">
                  <a href="mailto:${esc(m.email)}" style="color:${C.navy};">${esc(m.email)}</a>
                </td>
              </tr>
              ${m.subject ? `<tr>
                <td style="padding:4px 0;font-family:${SERIF};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.inkSoft};">Subject</td>
                <td style="padding:4px 0;font-family:${SERIF};font-size:16px;color:${C.ink};">${esc(m.subject)}</td>
              </tr>` : ''}
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:18px 20px;background:${C.tint};border-left:3px solid ${C.gold};font-family:${SERIF};font-size:16px;line-height:1.7;color:${C.ink};">
                  ${paragraphs(m.message)}
                </td>
              </tr>
            </table>`;

  const text = [
    `New message from the contact form on phapublishing.com`,
    ``,
    `From:    ${m.name}`,
    `Email:   ${m.email}`,
    m.subject ? `Subject: ${m.subject}` : null,
    ``,
    m.message,
    ``,
    `--`,
    `Reply directly to this email to answer ${m.name}.`,
  ].filter(l => l !== null).join('\n');

  return {
    subject: m.subject ? `Contact form — ${m.subject}` : `Contact form — message from ${m.name}`,
    html: layout({
      title: 'A message from the website',
      preheader: `${m.name}: ${String(m.message).slice(0, 90)}`,
      body,
      footNote: `Reply to this email and your answer goes straight to ${esc(m.name)}.`,
    }),
    text,
  };
}

/**
 * Sent to the person who wrote in.
 *
 * Two things it deliberately does. It sets an expectation — Susan answers
 * these herself, so days rather than minutes — because silence after writing
 * to an author reads as being ignored, and a stated wait is not silence. And
 * it quotes their own message back, so they have a copy of what they sent
 * without having to trust that a web form kept it.
 *
 * It does not thank them for "your enquiry" or promise a response time it
 * cannot keep. This is a small press, not a helpdesk.
 */
function contactAcknowledgement(m) {
  const body = `
            <p style="margin:0 0 16px;">Dear ${esc(m.name.split(/\s+/)[0] || m.name)},</p>

            <p style="margin:0 0 16px;">Thank you for writing to Pha Publishing. Your message has arrived safely.</p>

            <p style="margin:0 0 22px;">Susan reads what comes through the website herself, so a reply may take a few
            days rather than a few minutes — but it will come from her.</p>

            <p style="margin:0 0 12px;font-family:${SERIF};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.inkSoft};">
              What you sent
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
              <tr>
                <td style="padding:18px 20px;background:${C.tint};border-left:3px solid ${C.gold};font-family:${SERIF};font-size:15px;line-height:1.7;color:${C.inkSoft};">
                  ${m.subject ? `<p style="margin:0 0 12px;color:${C.ink};"><strong>${esc(m.subject)}</strong></p>` : ''}
                  ${paragraphs(m.message)}
                </td>
              </tr>
            </table>

            <p style="margin:0;">If you would like to add anything, simply reply to this email.</p>`;

  const text = [
    `Dear ${m.name.split(/\s+/)[0] || m.name},`,
    ``,
    `Thank you for writing to Pha Publishing. Your message has arrived safely.`,
    ``,
    `Susan reads what comes through the website herself, so a reply may take a`,
    `few days rather than a few minutes — but it will come from her.`,
    ``,
    `WHAT YOU SENT`,
    m.subject ? m.subject : null,
    ``,
    m.message,
    ``,
    `If you would like to add anything, simply reply to this email.`,
    ``,
    `--`,
    `Pha Publishing · phapublishing.com`,
    `Books for a brighter tomorrow.`,
  ].filter(l => l !== null).join('\n');

  return {
    subject: 'Thank you for writing to Pha Publishing',
    html: layout({
      title: 'Thank you for writing',
      preheader: 'Your message reached us — Susan reads these herself and will reply.',
      body,
      footNote: 'You are receiving this because you sent a message through phapublishing.com.',
    }),
    text,
  };
}

module.exports = { layout, contactNotification, contactAcknowledgement, esc, paragraphs, C, SERIF };
