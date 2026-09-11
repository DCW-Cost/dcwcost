import pptxgen from 'pptxgenjs';

const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';           // 10" x 5.625" — matches Google Slides' native canvas
pres.author = 'DCW Cost Management';
pres.title = 'DCW Cost Library — Pilot';

// ---- DCW brand, lifted from the site's global.css -------------------------
const BLUE = '1E4D9B';
const BLUE_DEEP = '0F2C58';
const GREEN = '7DBF43';
const GREEN_INK = '4F9E2F';
const TEAL = '1F9E96';
const INK = '131C2B';
const BODY = '3C454E';
const MUTED = '667079';
const LINE = 'DDE4EE';
const MIST = 'F4F7FB';
const WHITE = 'FFFFFF';
// Semantic — the confidence gate. Deliberately not the brand accent.
const GO = '3F8F2E';
const HOLD = 'B8791A';
const STOP = 'B33636';

const HEAD = 'Montserrat';
const TEXT = 'Montserrat';

const M = 0.55;                         // side margin
const W = 10 - M * 2;                   // usable width

// ---------------------------------------------------------------- helpers
function titleSlide(s, kicker, title, sub) {
  s.background = { color: BLUE_DEEP };
  s.addText(kicker, {
    x: M, y: 1.15, w: W, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 11, bold: true, color: GREEN, charSpacing: 2,
  });
  s.addText(title, {
    x: M, y: 1.55, w: W, h: 1.5, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 40, bold: true, color: WHITE, lineSpacing: 42,
  });
  if (sub) {
    s.addText(sub, {
      x: M, y: 3.02, w: W - 1.2, h: 0.82, isTextBox: true, margin: 0,
      fontFace: TEXT, fontSize: 13, color: 'AFC3DE', lineSpacing: 20,
    });
  }
}

function head(s, eyebrow, title) {
  s.background = { color: WHITE };
  s.addText(eyebrow, {
    x: M, y: 0.42, w: W, h: 0.25, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 10, bold: true, color: BLUE, charSpacing: 2,
  });
  s.addText(title, {
    x: M, y: 0.72, w: W, h: 0.92, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 24, bold: true, color: INK,
  });
}

/** The recurring motif: a filled dot, the product's own confidence signal. */
function dot(s, x, y, color, size = 0.16) {
  s.addShape(pres.ShapeType.ellipse, {
    x, y, w: size, h: size, fill: { color }, line: { color, width: 0 },
  });
}

function card(s, x, y, w, h, fill = MIST) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.04,
    fill: { color: fill }, line: { color: LINE, width: 1 },
  });
}

// ========================================================================
// 1 — Title
// ========================================================================
let s = pres.addSlide();
titleSlide(
  s,
  'PILOT · FOR DISCUSSION',
  'The DCW Cost Library',
  'Every cost line item we have ever issued — searchable, comparable, and honest about what it does not know.'
);
s.addText('11 September 2026', {
  x: M, y: 4.5, w: 4, h: 0.3, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 10, color: '7E96BA',
});
dot(s, M, 4.02, GREEN, 0.13);
s.addText('Working prototype · demonstration data', {
  x: M + 0.24, y: 3.95, w: 6, h: 0.28, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 10.5, color: 'AFC3DE',
});
s.addNotes(
  'Frame it as a prototype, not a product. Two things to land in the first minute: ' +
  'the numbers on screen today are invented, and the thing we are testing is whether the IDEA is right — ' +
  'not whether the data is right. Invite interruption; we want the estimators picking holes.'
);

// ========================================================================
// 2 — The problem
// ========================================================================
s = pres.addSlide();
head(s, 'THE PROBLEM', 'We have priced two years of work. None of it is searchable.');

const stats = [
  ['1,235', 'cost deliverables issued\nin the last two years'],
  ['0', 'of them queryable\nwithout opening Box'],
  ['~30 min', 'to answer "what did we\ncharge for foundations?"'],
];
stats.forEach(([n, label], i) => {
  const x = M + i * (W / 3);
  s.addText(n, {
    x, y: 1.75, w: W / 3 - 0.3, h: 0.85, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 42, bold: true, color: i === 1 ? STOP : BLUE,
  });
  s.addText(label, {
    x, y: 2.62, w: W / 3 - 0.3, h: 0.8, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11, color: MUTED, lineSpacing: 16,
  });
});

card(s, M, 3.72, W, 1.15);
s.addText(
  '“What they need to know is everything every estimator has said about each line item.”',
  { x: M + 0.35, y: 3.92, w: W - 0.7, h: 0.5, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 13, italic: true, color: INK }
);
s.addText('Rachel, 9 September', {
  x: M + 0.35, y: 4.46, w: 4, h: 0.25, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 9, bold: true, color: MUTED, charSpacing: 1,
});
s.addNotes(
  'The 30 minutes is the number that lands with estimators — they have all done that dig through Box. ' +
  'The point is not that anyone did anything wrong. The deliverables are excellent; they are just ' +
  'trapped one PDF at a time.'
);

// ========================================================================
// 3 — What it is
// ========================================================================
s = pres.addSlide();
head(s, 'WHAT WE BUILT', 'Four screens, behind a Microsoft sign-in');

const screens = [
  [BLUE, 'Cost Library', 'Browse any UniFormat element. See the range, what it is based on, and whether it is safe to price from.'],
  [TEAL, 'Estimate Builder', 'Drop in the client\'s documents. Get back a populated cost plan in our own Excel template.'],
  [HOLD, 'Reader Queue', 'Where the system asks us questions it could not answer on its own.'],
  [MUTED, 'Admin', 'Who has access. Anyone can be approved or revoked in one click.'],
];
screens.forEach(([c, name, desc], i) => {
  const col = i % 2, row = Math.floor(i / 2);
  const x = M + col * (W / 2 + 0.05);
  const y = 1.74 + row * 1.54;
  dot(s, x, y + 0.06, c, 0.18);
  s.addText(name, {
    x: x + 0.32, y, w: W / 2 - 0.5, h: 0.32, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 14.5, bold: true, color: INK,
  });
  s.addText(desc, {
    x: x + 0.32, y: y + 0.34, w: W / 2 - 0.55, h: 0.95, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: BODY, lineSpacing: 15,
  });
});
s.addNotes(
  'Do not dwell here — it is a map, not a demo. If you have the laptop, this is the moment to switch ' +
  'to the live preview and click through instead of reading the slide.'
);

// ========================================================================
// 4 — The reader
// ========================================================================
s = pres.addSlide();
head(s, 'HOW IT READS OUR PLANS', 'It understands the document before it extracts anything');

s.addText(
  'The same $13.20 means different things depending on whether it is loaded with markups, ' +
  'what area it is priced against, and what date it is priced to. So the reader establishes all of that first.',
  { x: M, y: 1.74, w: W - 0.6, h: 0.82, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11.5, color: BODY, lineSpacing: 17 }
);

const passes = [
  ['01', 'Comprehend', 'What kind of document is this? How is it coded? What area, what markups, what date?'],
  ['02', 'Extract', 'Pull the line items — now knowing the conventions. Every figure keeps its page and cell.'],
  ['03', 'Reconcile', 'Add it all up and check against the cover sheet. A wrong reading usually fails to add up.'],
];
passes.forEach(([n, t, d], i) => {
  const x = M + i * (W / 3 + 0.02);
  const w = W / 3 - 0.24;
  card(s, x, 2.62, w, 1.60, WHITE);
  s.addText(n, {
    x: x + 0.24, y: 2.78, w: 0.8, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 12, bold: true, color: GREEN_INK, charSpacing: 1,
  });
  s.addText(t, {
    x: x + 0.24, y: 3.06, w: w - 0.48, h: 0.32, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 14, bold: true, color: INK,
  });
  s.addText(d, {
    x: x + 0.24, y: 3.38, w: w - 0.48, h: 0.80, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10, color: BODY, lineSpacing: 14,
  });
});

s.addText(
  'It reads the numbers. It never does the arithmetic — every total, conversion and statistic is computed afterwards.',
  { x: M, y: 4.30, w: W, h: 0.4, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11, bold: true, color: BLUE }
);
s.addNotes(
  'The last line is the one worth saying out loud. A reader that is not allowed to do maths cannot get ' +
  'the maths wrong. If someone asks "how do we know it is not making numbers up" — that is the answer, ' +
  'plus every figure links back to the page it came from.'
);

// ========================================================================
// 5 — It asks
// ========================================================================
s = pres.addSlide();
head(s, 'WHEN IT IS NOT SURE', 'It asks us — it does not guess');

// Assumption card
card(s, M, 1.74, W / 2 - 0.14, 1.55, 'FDF3E3');
dot(s, M + 0.26, 1.96, HOLD, 0.14);
s.addText('ASSUMPTION · CONFIRM', {
  x: M + 0.5, y: 1.90, w: 3, h: 0.26, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 9, bold: true, color: HOLD, charSpacing: 1,
});
s.addText(
  '“No gross area on the cover sheet. I found 62,400 SF on page 2 and the totals reconcile against it. ' +
  'Airtable agrees. Assuming 62,400 GSF.”',
  { x: M + 0.26, y: 2.22, w: W / 2 - 0.66, h: 1.0, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: INK, lineSpacing: 15 }
);

// Blocking card
card(s, M + W / 2 + 0.14, 1.74, W / 2 - 0.14, 1.55, 'FCEDED');
dot(s, M + W / 2 + 0.4, 1.96, STOP, 0.14);
s.addText('BLOCKING · NEEDS AN ANSWER', {
  x: M + W / 2 + 0.64, y: 1.90, w: 3.4, h: 0.26, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 9, bold: true, color: STOP, charSpacing: 1,
});
s.addText(
  '“A 22% block at the bottom says GC\'s / Fee / Contingency, but three lines on p.4 already carry ' +
  'their own contingency. Which applies?”',
  { x: M + W / 2 + 0.4, y: 2.22, w: W / 2 - 0.66, h: 1.0, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: INK, lineSpacing: 15 }
);

s.addText('Answers teach it.', {
  x: M, y: 3.52, w: W, h: 0.32, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 15, bold: true, color: INK,
});
s.addText(
  'Say “Brian\'s 2024 plans use MasterFormat, map them this way” once, and it applies that to every ' +
  'matching document without asking again. Every answer is recorded against the name of whoever gave it — ' +
  'so months later you can see who settled a number, and go ask them.',
  { x: M, y: 3.86, w: W - 0.3, h: 1.05, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11, color: BODY, lineSpacing: 16 }
);
s.addNotes(
  'This is the slide that answers the fear in the room — that a machine is quietly inventing our prices. ' +
  'It does not. It asks. And anyone on the team can answer, not just admins, because the person who ' +
  'knows is usually whoever ran the job.'
);

// ========================================================================
// 6 — The confidence gate
// ========================================================================
s = pres.addSlide();
head(s, 'THE PART THAT MATTERS MOST', 'It tells you when the data is not good enough');

const gates = [
  [GO, 'GREEN', 'Price from this', ['8+ observations', 'tight agreement', '3+ projects', '2+ estimators', 'recent'], 'EAF6E6'],
  [HOLD, 'AMBER', 'Apply judgment', ['4–7 observations', 'or wider spread', 'or older data', 'or an unconfirmed', 'assumption'], 'FDF3E3'],
  [STOP, 'RED', 'Research it manually', ['under 4 observations', 'or they disagree', 'or all from one job', 'or one estimator'], 'FCEDED'],
];
gates.forEach(([c, name, verdict, rules, bg], i) => {
  const x = M + i * (W / 3 + 0.02);
  const w = W / 3 - 0.24;
  card(s, x, 1.74, w, 2.16, bg);
  dot(s, x + 0.26, 1.94, c, 0.15);
  s.addText(name, {
    x: x + 0.5, y: 1.88, w: w - 0.7, h: 0.28, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 12, bold: true, color: c, charSpacing: 1.5,
  });
  s.addText(verdict, {
    x: x + 0.26, y: 2.20, w: w - 0.5, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 13, bold: true, color: INK,
  });
  s.addText(rules.map((r, j) => ({
    text: r, options: { bullet: true, breakLine: j < rules.length - 1 },
  })), {
    x: x + 0.26, y: 2.54, w: w - 0.5, h: 1.30, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 9.5, color: BODY, paraSpaceAfter: 3,
  });
});

s.addText(
  'The reason always comes with the colour — never a bare red light, always “only 2 observations, both from the same project, 2024.”',
  { x: M, y: 4.05, w: W, h: 0.4, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11, color: BODY }
);
s.addText('You set these thresholds. Not the software.', {
  x: M, y: 4.45, w: W, h: 0.32, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 11.5, bold: true, color: BLUE,
});
s.addNotes(
  'Spend the most time here. A tool that always produces a confident number is worse than useless — ' +
  'it is a liability. This one is built to say "I do not know" and to explain why. ' +
  'The thresholds are editable in the admin screen, so the estimating team owns where those lines sit.'
);

// ========================================================================
// 7 — What an estimator sees
// ========================================================================
s = pres.addSlide();
head(s, 'IN PRACTICE', 'A10 Foundations, priced from our own history');

card(s, M, 1.74, W, 2.02, WHITE);
s.addText('A10', {
  x: M + 0.3, y: 1.94, w: 0.7, h: 0.3, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 13, bold: true, color: BLUE,
});
s.addText('Foundations', {
  x: M + 0.95, y: 1.92, w: 3, h: 0.34, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 15, bold: true, color: INK,
});
s.addText('$ / GSF · bare basis · escalated to today · civic + education · Puget Sound · DD', {
  x: M + 0.3, y: 2.26, w: W - 0.6, h: 0.26, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 9.5, color: MUTED,
});

const figs = [['Median', '$11.24'], ['p10 – p90', '$11.03–12.29'], ['Observations', '9'], ['Spread', '0.05'], ['Trend', '+4.1%/yr']];
figs.forEach(([label, val], i) => {
  const x = M + 0.3 + i * ((W - 0.6) / 5);
  s.addText(label.toUpperCase(), {
    x, y: 2.60, w: (W - 0.6) / 5 - 0.1, h: 0.22, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 8, bold: true, color: MUTED, charSpacing: 1,
  });
  s.addText(val, {
    x, y: 2.82, w: (W - 0.6) / 5 - 0.1, h: 0.34, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 15, bold: true, color: INK,
  });
});

dot(s, M + 0.3, 3.30, HOLD, 0.14);
s.addText(
  'AMBER — 9 observations across 9 projects, one deep-foundation job excluded as an outlier, ' +
  'and one gross area still unconfirmed.',
  { x: M + 0.54, y: 3.24, w: W - 0.9, h: 0.44, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: INK, lineSpacing: 14 }
);

s.addText(
  'Every figure is clickable down to the source: which project, which estimator, what date, what markups were ' +
  'stripped, and a link straight to the document in Box.',
  { x: M, y: 3.96, w: W - 0.3, h: 0.62, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11, color: BODY, lineSpacing: 16 }
);
s.addText('Illustrative figures — not real DCW project data.', {
  x: M, y: 4.66, w: W, h: 0.28, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 9.5, italic: true, color: MUTED,
});
s.addNotes(
  'Note the amber, and say why out loud: the software found nine comparable jobs, threw out a deep-foundation ' +
  'job that was not comparable, and is still holding one unconfirmed assumption. That is the behaviour we want — ' +
  'it did not round up to "green" to look clever.'
);

// ========================================================================
// 8 — Estimate Builder
// ========================================================================
s = pres.addSlide();
head(s, 'WHERE THIS IS GOING', 'Drop in the RFP. Get back a populated cost plan.');

const steps = [
  ['Drop in', 'RFP, program doc, drawings, spec — and our own template'],
  ['It reads', 'Area, program mix, construction midpoint, and every stated inclusion and exclusion'],
  ['You confirm', 'One screen. Everything downstream inherits it'],
  ['It proposes', 'A rate per element, each with its confidence light'],
  ['You decide', 'Accept, override, or leave blank — then export to our Excel'],
];
steps.forEach(([t, d], i) => {
  const y = 1.74 + i * 0.56;
  dot(s, M + 0.04, y + 0.08, i === 4 ? GREEN : BLUE, 0.14);
  s.addText(t, {
    x: M + 0.34, y, w: 1.5, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 12, bold: true, color: INK,
  });
  s.addText(d, {
    x: M + 1.95, y: y + 0.02, w: W - 2.1, h: 0.46, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: BODY, lineSpacing: 14,
  });
});

card(s, M, 4.62, W, 0.65, 'FCEDED');
s.addText(
  'Elements it cannot price confidently arrive BLANK, with the reason attached. A blank prompts an estimator. ' +
  'A confidently wrong number reaches a client with your name on it.',
  { x: M + 0.3, y: 4.74, w: W - 0.6, h: 0.45, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10, color: INK, lineSpacing: 13 }
);
s.addNotes(
  'This is the payoff and it is the part that is NOT built yet — be clear about that. ' +
  'The red box is the design decision most worth arguing about: we deliberately leave cells empty rather ' +
  'than fill them with a number nobody chose. If the room disagrees, that is exactly the feedback we need.'
);

// ========================================================================
// 9 — What's real
// ========================================================================
s = pres.addSlide();
head(s, 'BEING STRAIGHT WITH YOU', 'What is real today, and what is not');

card(s, M, 1.74, W / 2 - 0.14, 2.62, 'EAF6E6');
dot(s, M + 0.28, 1.96, GO, 0.15);
s.addText('WORKING NOW', {
  x: M + 0.52, y: 1.90, w: 3, h: 0.28, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 10, bold: true, color: GO, charSpacing: 1.5,
});
const real = [
  'Microsoft 365 sign-in, live',
  'Admin approval of accounts',
  'All four screens, clickable',
  'The statistics — outlier rejection, the confidence gate, trend detection',
  'Security: nobody outside dcwcost.com gets in',
];
s.addText(real.map((r, j) => ({ text: r, options: { bullet: true, breakLine: j < real.length - 1 } })), {
  x: M + 0.28, y: 2.24, w: W / 2 - 0.7, h: 2.02, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 10.5, color: BODY, paraSpaceAfter: 6,
});

card(s, M + W / 2 + 0.14, 1.74, W / 2 - 0.14, 2.62, 'FDF3E3');
dot(s, M + W / 2 + 0.42, 1.96, HOLD, 0.15);
s.addText('NOT YET', {
  x: M + W / 2 + 0.66, y: 1.90, w: 3, h: 0.28, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 10, bold: true, color: HOLD, charSpacing: 1.5,
});
const notReal = [
  'Every number on screen is invented — Kent, Olympia, Ballard are not real jobs',
  'No cost plan has been read yet',
  'Buttons render but do not save',
  'The Estimate Builder is designed, not built',
];
s.addText(notReal.map((r, j) => ({ text: r, options: { bullet: true, breakLine: j < notReal.length - 1 } })), {
  x: M + W / 2 + 0.42, y: 2.24, w: W / 2 - 0.7, h: 2.02, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 10.5, color: BODY, paraSpaceAfter: 6,
});

s.addText('Everything you see today was built in about a day.', {
  x: M, y: 4.52, w: W, h: 0.32, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 11.5, bold: true, color: BLUE,
});
s.addNotes(
  'Do not skip this slide. Credibility with this team depends on being the ones who said "this is fake data" ' +
  'before anyone else had to ask. The last line is not a boast — it is the argument for why it is worth ' +
  'spending three more weeks on.'
);

// ========================================================================
// 10 — Proving it (back-test)
// ========================================================================
s = pres.addSlide();
head(s, 'PROVING IT', 'Before we trust it, we make it re-do work we already did');

s.addText(
  'Pick ten cost plans we issued in the last six months. Hide them from the Library. Run the same brief through the tool cold. Then put the two side by side.',
  { x: M, y: 1.72, w: W - 0.4, h: 0.6, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11.5, color: BODY, lineSpacing: 17 }
);

const backtest = [
  ['01', 'Held out', 'Ten recent projects the reader has never seen — chosen by the estimators, not by us'],
  ['02', 'Re-run', 'Same client brief, same area, same stage. No hints, no access to the answer'],
  ['03', 'Compared', 'Element by element: where it agreed, where it drifted, where it correctly refused'],
];
backtest.forEach(([n, t, d], i) => {
  const x = M + i * (W / 3 + 0.02);
  const w = W / 3 - 0.24;
  card(s, x, 2.42, w, 1.60, WHITE);
  s.addText(n, {
    x: x + 0.24, y: 2.58, w: 0.8, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 12, bold: true, color: GREEN_INK, charSpacing: 1,
  });
  s.addText(t, {
    x: x + 0.24, y: 2.86, w: w - 0.48, h: 0.32, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 14, bold: true, color: INK,
  });
  s.addText(d, {
    x: x + 0.24, y: 3.18, w: w - 0.48, h: 0.80, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10, color: BODY, lineSpacing: 14,
  });
});

card(s, M, 4.16, W, 1.10, MIST);
s.addText(
  'What good looks like: on the elements it marked green, it lands inside the estimator’s own range 8 times out of 10 — and on the other two it flags rather than guesses. Anything it gets wrong becomes a standing rule, not an excuse.',
  { x: M + 0.35, y: 4.30, w: W - 0.7, h: 0.85, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11, color: INK, lineSpacing: 16 }
);
s.addNotes(
  'This is the slide that turns scepticism into a test instead of an argument. Nobody has to take the ' +
  'tool on faith — we hand it work we have already done and score it. Ask for the ten projects by name ' +
  'in the room; a back-test the estimators chose is one they will believe. And say the quiet part: if it ' +
  'fails this, we do not ship it.'
);

// ========================================================================
// 11 — Cost
// ========================================================================
s = pres.addSlide();
head(s, 'WHAT IT COSTS', 'Reading two years of cost plans');

s.addText('$75–375', {
  x: M, y: 1.78, w: 4.4, h: 1.05, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 54, bold: true, color: GREEN_INK,
});
s.addText('one time, for all 1,235 deliverables', {
  x: M, y: 2.86, w: 4.4, h: 0.3, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 11.5, color: MUTED,
});

card(s, M + 4.9, 1.78, W - 4.9, 1.66, MIST);
s.addText(
  'That is the whole archive, read three times over, worst case.\n\n' +
  'It is less than one estimator-hour. The question in front of us is not whether we can afford it.',
  { x: M + 5.2, y: 1.96, w: W - 5.5, h: 1.32, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11, color: BODY, lineSpacing: 16 }
);

s.addText('Running costs after that are a few dollars a month, plus the database.', {
  x: M, y: 3.72, w: W, h: 0.3, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 11, color: BODY,
});
s.addText(
  'Our client documents go through a business API — they are not used to train anybody\'s model, ' +
  'and they never leave Box except as extracted numbers.',
  { x: M, y: 4.08, w: W - 0.3, h: 0.62, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 11, bold: true, color: BLUE, lineSpacing: 16 }
);
s.addNotes(
  'Somebody will ask about cost and somebody will ask about confidentiality. Both answers are on this slide. ' +
  'The confidentiality one matters more than the money: this is not pasting client cost plans into a chatbot.'
);

// ========================================================================
// 12 — What an hour is worth
// ========================================================================
s = pres.addSlide();
head(s, 'THE BUSINESS CASE', 'What an estimator-hour is actually worth');

s.addText(
  'Hours saved per report   ×   reports a year   ×   what an hour costs us   =   capacity returned',
  { x: M, y: 1.70, w: W, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 12, bold: true, color: BLUE }
);
s.addText(
  'A cost report takes 18.9 hours. 58.5% is report production — nearly 4× takeoff, and the Library’s target.',
  { x: M, y: 2.02, w: W, h: 0.28, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: MUTED }
);

const worth = [
  ['3.3 hrs', 'saved per cost report, out\nof the 11.1 that go to\nreport production'],
  ['~1,400', 'hours a year across the\nreports where the Library\napplies — about one FTE'],
  ['$136K', 'of estimating capacity\nreturned, at a $95/hour\nblended cost'],
];
worth.forEach(([n, label], i) => {
  const x = M + i * (W / 3);
  s.addText(n, {
    x, y: 2.45, w: W / 3 - 0.3, h: 0.68, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 32, bold: true, color: i === 2 ? GREEN_INK : BLUE,
  });
  s.addText(label, {
    x, y: 3.18, w: W / 3 - 0.3, h: 0.85, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: MUTED, lineSpacing: 15,
  });
});

card(s, M, 4.16, W, 1.15, 'EAF6E6');
s.addText(
  'These are no longer estimates. The hours come from 28,910 time entries and 57,887 logged hours, March 2021 to September 2026 — our own Airtable. One judgement remains: that the Library removes 30% of report production. Only the $95 rate is still a placeholder.',
  { x: M + 0.35, y: 4.30, w: W - 0.7, h: 0.88, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: INK, lineSpacing: 15 }
);
s.addNotes(
  'This slide changed completely once Rachel\'s time-tracking analysis landed. The hours used to be ' +
  'my invention; they are now measured from 28,910 entries. Lead with that — this is DCW measuring ' +
  'itself, not a vendor claim. ' +
  'The 58.5% report-production figure is the one to dwell on: the bulk of a cost report is not ' +
  'measuring the building, it is assembling the document. Takeoff is only 15.4% and we do not touch it. ' +
  'If challenged on the 30%: it is the single remaining judgement, the sensitivity table runs 10-50%, ' +
  'and even 10% clears the run cost many times over. ' +
  'Be straight that the analysis itself carries caveats — coverage fell from 93% to 55%, the ' +
  'calibration cohort is 2021-24, and its author recommends a six-week full-logging test to settle it.'
);

// ========================================================================
// 13 — Three things to do with a freed hour
// ========================================================================
s = pres.addSlide();
head(s, 'THE BUSINESS CASE', 'Three things we can do with an hour we get back');

const levers = [
  [GO, 'BANK IT', 'Same fee, fewer hours. Each billable hour carries 1.38 paid hours, so 1,400 saved is nearly 2,000 off the firm — against a 67% expense ratio headed for 62%.'],
  [TEAL, 'REDEPLOY IT', 'Same team, more work. A thousand-odd hours is roughly one estimator we do not have to hire — in a year where one resignation moved 1,765 booked hours.'],
  [BLUE, 'SHARE IT', 'Cut the fee, win the job, and still make more per hour. This is the lever worth understanding properly — see below.'],
];
levers.forEach(([c, name, body], i) => {
  const x = M + i * (W / 3 + 0.02);
  const w = W / 3 - 0.24;
  card(s, x, 1.72, w, 2.00, WHITE);
  dot(s, x + 0.24, 1.90, c, 0.15);
  s.addText(name, {
    x: x + 0.48, y: 1.84, w: w - 0.68, h: 0.28, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 11, bold: true, color: c, charSpacing: 1.5,
  });
  s.addText(body, {
    x: x + 0.24, y: 2.18, w: w - 0.5, h: 1.45, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10, color: BODY, lineSpacing: 14,
  });
});

card(s, M, 3.86, W, 1.45, 'EAF6E6');
s.addText('Cut the fee by less than the hours fell, and margin goes up.', {
  x: M + 0.35, y: 4.00, w: W - 0.7, h: 0.34, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 14, bold: true, color: INK,
});
s.addText(
  'Measured, not assumed: 3.3 hours off an 18.9-hour report is a 17.5% drop. A 17.5% fee cut would leave margin percentage exactly where it is. Cut 5% and you have bought the work AND grown the margin — 45% to 53% on the job. That gap is the whole business case.',
  { x: M + 0.35, y: 4.36, w: W - 0.7, h: 0.85, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: BODY, lineSpacing: 15 }
);
s.addNotes(
  'The green box is the single most useful sentence in the deck for Brian and Pam. It is not a rule of ' +
  'thumb, it is algebra: margin percentage is unchanged when the fee falls by the same proportion as the ' +
  'hours. Everything below that line is profit, and everything we hand back is a competitive weapon. ' +
  'One trap the model exposes, worth knowing before someone proposes a bigger discount in the room: there are ' +
  'TWO break-evens, not one. Margin PERCENTAGE holds flat up to the full 8%. Margin DOLLARS per job hold ' +
  'flat only to about 2.8%, because the fee cut applies to the whole fee while the saving applies to one ' +
  'step. So a 5% discount would still improve the ratio and quietly lose money. The spreadsheet shows both ' +
  'lines side by side. And the honest headline: the biggest number here is capacity, not discounting. ' +
  'Discounting is an option we now have, not the plan.'
);

// ========================================================================
// 14 — Telling the market
// ========================================================================
s = pres.addSlide();
head(s, 'ONCE IT IS REAL', 'Then we tell the market — nobody else here can say this');

const gtm = [
  ['Press release', 'Regional AEC and construction press: the independent cost manager that prices from a decade of its own Northwest projects, not a national index.'],
  ['Every contact we have', 'One email to the full list — clients, past clients, architects, GCs, owners’ reps — leading with a real worked example, not a product announcement.'],
  ['Western Cost Outlook', 'Published from our own anonymized data. Already in the operating plan for Q1 2027, owned by Dane. This is the thing that makes it possible.'],
  ['In every fee proposal', 'One line competitors cannot copy: “priced against 1,200 of our own recent Northwest projects.”'],
];
gtm.forEach(([t, d], i) => {
  const y = 1.74 + i * 0.66;
  dot(s, M + 0.04, y + 0.08, i === 3 ? GREEN : BLUE, 0.14);
  s.addText(t, {
    x: M + 0.34, y, w: 2.1, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 12, bold: true, color: INK,
  });
  s.addText(d, {
    x: M + 2.6, y: y + 0.02, w: W - 2.75, h: 0.55, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: BODY, lineSpacing: 15,
  });
});

card(s, M, 4.42, W, 0.95, 'FDF3E3');
s.addText(
  'Marketing waits for proof. Nothing goes out until the back-test passes and real plans are loaded — a claim we cannot defend in a client meeting is worse than no claim at all.',
  { x: M + 0.3, y: 4.56, w: W - 0.6, h: 0.6, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: INK, lineSpacing: 15 }
);
s.addNotes(
  'Dane owns this and it maps onto a key result he already has. The sequencing point in the amber box is ' +
  'the one to defend if anyone wants to announce early: the whole differentiator is that our numbers are ' +
  'defensible. Announcing before the back-test would trade the only real advantage for a week of attention.'
);

// ========================================================================
// 15 — The ask
// ========================================================================
s = pres.addSlide();
head(s, 'WHAT WE NEED FROM YOU', 'Three things, and one of them is just an opinion');

const asks = [
  [GREEN, 'Your awkward documents', 'Two or three cost plans you already know are messy — a missing area, a strange markup block, odd coding. They are worth more to us than twenty clean ones, because they test the reader instead of flattering it.'],
  [TEAL, 'Twenty minutes in the queue', 'Once real plans are loaded, someone has to answer the questions it raises. Early answers become standing rules, so the work drops off fast.'],
  [BLUE, 'Tell us where this is wrong', 'Especially the blank red lines. If you would rather see our best guess than an empty cell, say so now — that is a design decision, not a technical one.'],
];
asks.forEach(([c, t, d], i) => {
  const y = 1.74 + i * 1.08;
  dot(s, M + 0.04, y + 0.08, c, 0.16);
  s.addText(t, {
    x: M + 0.36, y, w: W - 0.5, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 13.5, bold: true, color: INK,
  });
  s.addText(d, {
    x: M + 0.36, y: y + 0.32, w: W - 0.6, h: 0.72, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: BODY, lineSpacing: 15,
  });
});
s.addNotes(
  'Ask for the awkward documents by name if you can — "Brian, that Spokane job with the MasterFormat coding". ' +
  'A specific request gets a response; a general one gets nods. And genuinely leave silence after the third ' +
  'point. This team does not volunteer feedback, so make the pause uncomfortable.'
);

// ========================================================================
// 16 — The roadmap
// ========================================================================
s = pres.addSlide();
head(s, 'THE ROADMAP', 'Mapped onto the operating plan we already wrote');

const road = [
  ['NOW – OCT', 'Read the vetted plans. Work the reader queue. Capture the hours-per-estimate baseline — already a Q3 action item, and the number this whole business case rests on.'],
  ['OCT – DEC', 'All 1,235 deliverables. Back-test against ten recent projects. The $/SF benchmark table goes live for our top five building types — this IS that key result, not a competing one.'],
  ['JAN – MAR', 'Estimate Builder in pilot. Fee and scope predictor run against budgeted-versus-actual hours. First Western Cost Outlook published off this data.'],
  ['APR – JUN', 'Quarterly re-calibration built into the rhythm. Marketing goes out. Decide what this becomes.'],
];
road.forEach(([when, what], i) => {
  const y = 1.68 + i * 0.68;
  s.addText(when, {
    x: M, y, w: 1.5, h: 0.28, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 10, bold: true, color: BLUE, charSpacing: 1,
  });
  s.addText(what, {
    x: M + 1.65, y: y - 0.02, w: W - 1.8, h: 0.62, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: BODY, lineSpacing: 15,
  });
});

card(s, M, 4.44, W, 0.95, MIST);
s.addText(
  'One thing to decide deliberately rather than drift into: the operating plan parks AI plan reading as a next-year BUY from a specialist. This is that capability, built in-house for the price of an estimator-hour. As an internal practice it is the CEO’s call (matrix #46). As something DCW sells, it is a Board decision with TSC veto (#47).',
  { x: M + 0.3, y: 4.56, w: W - 0.6, h: 0.75, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10, color: INK, lineSpacing: 14 }
);
s.addNotes(
  'Do not skip the grey box. The offsite plan explicitly says "no plan-reading or computer-vision layer ' +
  'this block" and puts AI plan reading in the parking lot as a buy, not a build. Walking into the room ' +
  'with a built reader without naming that would be an unforced error — so name it first, and frame it ' +
  'as new information rather than a breach: the parking-lot reasoning was that it needs the structured ' +
  'archive underneath and costs specialist money. The archive is what we are building, and it turned out ' +
  'to cost an estimator-hour. That changes the calculus, and the CEO gets to decide whether it changes ' +
  'the plan. Six weeks of lead time on anything touching #47.'
);

// ========================================================================
// 17 — Closing
// ========================================================================
s = pres.addSlide();
s.background = { color: BLUE_DEEP };
s.addText('WHAT WE NEED DECIDED', {
  x: M, y: 0.72, w: W, h: 0.3, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 10, bold: true, color: GREEN, charSpacing: 2,
});
s.addText('Three questions before the next six weeks', {
  x: M, y: 1.05, w: W, h: 0.55, isTextBox: true, margin: 0,
  fontFace: HEAD, fontSize: 27, bold: true, color: WHITE,
});

const decisions = [
  ['01', 'Which ten recent projects do we back-test against?', 'We need the names today. Pick jobs you would defend in front of a client.'],
  ['02', 'Who owns the reader queue?', 'One name, per our own rule. It is maybe twenty minutes a week once the standing answers build up.'],
  ['03', 'Internal practice, or eventually something we sell?', 'Not a decision for this room — but it changes what we build, so it needs a Board agenda early.'],
];
decisions.forEach(([n, q, d], i) => {
  const y = 1.92 + i * 0.93;
  s.addText(n, {
    x: M, y, w: 0.5, h: 0.3, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 11, bold: true, color: GREEN, charSpacing: 1,
  });
  s.addText(q, {
    x: M + 0.6, y: y - 0.04, w: W - 0.75, h: 0.34, isTextBox: true, margin: 0,
    fontFace: HEAD, fontSize: 14, bold: true, color: WHITE,
  });
  s.addText(d, {
    x: M + 0.6, y: y + 0.32, w: W - 0.85, h: 0.5, isTextBox: true, margin: 0,
    fontFace: TEXT, fontSize: 10.5, color: 'AFC3DE', lineSpacing: 15,
  });
});

s.addText('Nothing reaches a client without an estimator’s name on it. That does not change.', {
  x: M, y: 4.88, w: W, h: 0.32, isTextBox: true, margin: 0,
  fontFace: TEXT, fontSize: 11, italic: true, color: '9FB6D4',
});
s.addNotes(
  'Get answers in the room to one and two — a decision made on a slide dies on the slide. Three is a ' +
  'flag, not a question; Brian needs six weeks of runway if it ever goes to the Board. ' +
  'Close on the last line. The fear in a room like this is that the tool is coming for the judgment, ' +
  'not the drudgery. It is not. It is coming for the half hour of digging through Box.'
);

pres.writeFile({ fileName: import.meta.dirname + '/DCW-Cost-Library-Pilot.pptx' })
  .then((f) => console.log('wrote', f));
