import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseWorkbook, buildDigest, searchWorkbook, readRange } from './workbook.ts';
import { markupFactor, validateFrame, type RawFrame, type DocContext } from './frame.ts';
import { signedUrlMatches, parseTriggerBody } from './trigger.ts';
import { clientConfig } from './db.ts';
import { stamp } from './runlog.ts';
import { planQuestions } from './questions.ts';
import { scrub } from './pass-one.ts';

function sampleWorkbook(): Uint8Array {
  const summary = XLSX.utils.aoa_to_sheet([
    ['Oregon Zoo Campus Plan', null, null],
    ['Cost report', null, 'Issued 2024-03-15'],
    ['Gross Floor Area (GSF)', 62400, null],
    ['Element', 'Cost', '$/SF'],
    ['A10 Foundations', 1200000, null],
    ['B10 Superstructure', 3400000, null],
  ]);
  // A markup stack further down, beyond the head window.
  for (let r = 60; r < 66; r++) XLSX.utils.sheet_add_aoa(summary, [[`filler ${r}`, r]], { origin: `A${r}` });
  XLSX.utils.sheet_add_aoa(summary, [['General Conditions', 0.085]], { origin: 'A70' });
  XLSX.utils.sheet_add_aoa(summary, [["GC's Fee", 0.05]], { origin: 'A71' });
  summary['C80'] = { t: 'n', v: 5664000, f: 'B5*1.18' };
  summary['!ref'] = 'A1:C80';
  const detail = XLSX.utils.aoa_to_sheet([['Code', 'Description'], ['03 30 00', 'Cast-in-place concrete']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summary, 'Summary');
  XLSX.utils.book_append_sheet(wb, detail, 'Detail 1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

test('workbook: cells keep address, value and formula', () => {
  const wb = parseWorkbook(sampleWorkbook());
  assert.equal(wb.sheets.length, 2);
  const s = wb.sheets[0];
  const gsf = s.cells.find((c) => c.a === 'B3');
  assert.equal(gsf?.v, 62400);
  const f = s.cells.find((c) => c.a === 'C80');
  assert.equal(f?.f, 'B5*1.18');
  assert.equal(wb.formulaCount, 1);
});

test('workbook: digest carries the head, the labelled cells and markup formulas', () => {
  const d = buildDigest(parseWorkbook(sampleWorkbook()));
  assert.match(d, /Summary!B3 = 62400/);
  assert.match(d, /\[markup.*\] Summary!A70 = "General Conditions"/);
  assert.match(d, /row: Summary!B70 = 0\.085/);
  assert.match(d, /Summary!C80 = 5664000 \{=B5\*1\.18\}/);
  assert.match(d, /'Detail 1'/);
});

test('workbook: search and read_range', () => {
  const wb = parseWorkbook(sampleWorkbook());
  assert.match(searchWorkbook(wb, 'fee'), /Summary!A71 = "GC's Fee"/);
  assert.match(searchWorkbook(wb, '1.18'), /\{=B5\*1\.18\}/);
  assert.match(searchWorkbook(wb, 'nothing like this'), /No cell contains/);
  const range = readRange(wb, 'Summary', 'A70:B71');
  assert.match(range, /A70/);
  assert.match(range, /B71 = 0\.05/);
  assert.doesNotMatch(range, /A3/);
  assert.match(readRange(wb, 'Nope', 'A1:B2'), /No sheet named/);
  assert.match(readRange(wb, 'Summary', 'banana'), /not an A1 range|not a valid range/);
});

const markup = (over: Partial<RawFrame['markup']>): RawFrame['markup'] => ({
  basis: 'loaded',
  components: [
    { label: 'General Conditions', percent: 8.5, cell: 'Summary!B70' },
    { label: "GC's Fee", percent: 5, cell: 'Summary!B71' },
  ],
  compounding: 'compound',
  factor_as_written: null,
  confidence: 0.8,
  evidence: 'x',
  ...over,
});

test('markup factor: computed from stated components, never taken from the model', () => {
  assert.equal(markupFactor(markup({})).factor, 1.13925);
  assert.equal(markupFactor(markup({ compounding: 'additive' })).factor, 1.135);
  assert.equal(markupFactor(markup({ compounding: 'unknown' })).factor, null);
  assert.equal(markupFactor(markup({ factor_as_written: 1.18 })).factor, 1.18);
  assert.equal(markupFactor(markup({ basis: 'bare' })).factor, 1);
  assert.equal(markupFactor(markup({ basis: 'undetermined' })).factor, null);
  assert.equal(markupFactor(markup({ components: [{ label: 'Fee', percent: null, cell: null }] })).factor, null);
});

const ctx: DocContext = {
  deliverableId: '00000000-0000-4000-8000-000000000000',
  filename: 'x.xlsx',
  recordedType: 'cost_estimate',
  recordedPhase: 'unknown',
  issueDate: '2024-03-15',
  estimator: null,
  uploadNotes: null,
  project: {
    name: 'Oregon Zoo',
    clientName: null,
    sector: null,
    region: null,
    city: null,
    grossSf: null,
    deliveryMethod: null,
    fromAirtable: false,
  },
  conventions: [{ id: 7, kind: 'coding_system', rule: {}, rationale: null, scope: 'all documents' }],
  priorQuestions: [],
};

const raw = (over: Partial<RawFrame> = {}): RawFrame => ({
  deliverable_type: { value: 'cost_estimate', confidence: 0.9, evidence: 'cover' },
  coding_system: { value: 'uniformat', confidence: 1.4, evidence: 'A10, B10 codes' },
  gross_area: { gsf: 62400, source: 'summary_block', confidence: 0.95, evidence: 'Summary!B3' },
  markup: markup({}),
  pricing_base_date: { date: '2024-03-15', source: 'issue_date_fallback', confidence: 0.5, evidence: 'none stated' },
  stated_total: { amount: 5664000, cell: 'Summary!C80', confidence: 0.9, evidence: 'grand total' },
  conventions_applied: [7, 99],
  open_assumptions: [],
  ...over,
});

test('frame: valid frame is shaped for document_frames', () => {
  const f = validateFrame(raw(), ctx);
  assert.equal(f.coding_confidence, 1, 'confidence clamped into [0,1]');
  assert.equal(f.markup_factor, 1.13925);
  assert.deepEqual(f.conventions_applied, [7], 'ids it was never shown are dropped');
  assert.equal(f.stated_total_cost, 5664000);
  assert.equal(f.base_date_confidence, 0.5);
  assert.equal(f.stated_total_evidence, 'grand total');
  assert.equal(f.deliverable_type, 'cost_estimate');
  assert.equal(f.deliverable_type_confidence, 0.9);
  assert.equal(f.deliverable_type_evidence, 'cover');
});

test('frame: every assumption becomes a question, even ones the model did not list', () => {
  const f = validateFrame(raw(), ctx);
  assert.deepEqual(
    f.questions.map((q) => q.kind),
    ['pricing_base_date'],
    'issue-date fallback is an assumption'
  );
  assert.match(f.questions[0].prompt, /confirm\?$/);

  const airtable = validateFrame(
    raw({ gross_area: { gsf: 62400, source: 'airtable', confidence: 0.6, evidence: 'project record' } }),
    ctx
  );
  assert.ok(airtable.questions.some((q) => q.kind === 'gross_area'));

  const review = validateFrame(
    raw({ deliverable_type: { value: 'estimate_review', confidence: 0.8, evidence: '"Review of GC estimate"' } }),
    ctx
  );
  const typeQ = review.questions.find((q) => q.kind === 'deliverable_type');
  assert.ok(typeQ, 'a changed type is confirmed by a person');
  assert.match(typeQ.prompt, /never pooled/);
  assert.equal(review.deliverable_type, 'estimate_review');

  const listed = validateFrame(
    raw({
      open_assumptions: [
        { kind: 'pricing_base_date', assumption: 'Base is Q1 2024 — confirm?', proposed_answer: '2024-03-15', evidence: 'p1' },
        { kind: 'not_a_kind', assumption: 'Something else — confirm?', proposed_answer: 'x', evidence: 'p2' },
      ],
    }),
    ctx
  );
  assert.deepEqual(
    listed.questions.map((q) => q.kind),
    ['pricing_base_date', 'other'],
    "the model's own base-date question is kept, not duplicated; an unknown kind files as other"
  );
});

test('frame: rejects what schema.sql would reject, and arithmetic sources', () => {
  assert.throws(() => validateFrame(raw({ coding_system: { value: 'csi', confidence: 1, evidence: '' } }), ctx));
  assert.throws(() =>
    validateFrame(raw({ gross_area: { gsf: 62400, source: 'back_calculated', confidence: 1, evidence: '' } }), ctx)
  );
  assert.throws(() => validateFrame(raw({ gross_area: { gsf: 62400, source: null, confidence: 1, evidence: '' } }), ctx));
  assert.throws(() =>
    validateFrame(raw({ pricing_base_date: { date: '2023-01-01', source: 'issue_date_fallback', confidence: 1, evidence: '' } }), ctx)
  );
  assert.throws(() =>
    validateFrame(raw({ pricing_base_date: { date: 'Q2 2027', source: 'stated', confidence: 1, evidence: '' } }), ctx)
  );
});

const SUPA = 'https://abcdefghijklmnopqrst.supabase.co';
const PATH = 'deliverables/0f8fad5b-d9cb-469f-a165-70867728950e.xlsx';

test('trigger: signed URL must be this project and this object', () => {
  const good = `${SUPA}/storage/v1/object/sign/${PATH}?token=eyJabc`;
  assert.equal(signedUrlMatches(good, SUPA, PATH), true);
  assert.equal(signedUrlMatches(good, SUPA, 'deliverables/other.xlsx'), false);
  assert.equal(signedUrlMatches(good.replace(SUPA, 'https://evil.example'), SUPA, PATH), false);
  assert.equal(signedUrlMatches(good.replace('https:', 'http:'), SUPA, PATH), false);
  assert.equal(signedUrlMatches(good.split('?')[0], SUPA, PATH), false, 'no token');
  assert.equal(signedUrlMatches(good, SUPA, null), false, 'no file recorded');
  assert.equal(signedUrlMatches('http://169.254.169.254/latest/meta-data', SUPA, PATH), false);
});

test('trigger: body shape', () => {
  assert.equal(parseTriggerBody({ deliverableId: 'nope', signedUrl: 'x', accessToken: 'y' }), null);
  assert.equal(parseTriggerBody(null), null);
  const ok = parseTriggerBody({ deliverableId: '0F8FAD5B-D9CB-469F-A165-70867728950E', signedUrl: 'x', accessToken: 'y' });
  assert.equal(ok?.deliverableId, '0f8fad5b-d9cb-469f-a165-70867728950e');
});

test('db: sslmode is replaced by explicit verification, and only cost_reader connects', () => {
  const cfg = clientConfig(
    'postgresql://cost_reader.ref:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=require',
    'PEM'
  );
  assert.doesNotMatch(String(cfg.connectionString), /sslmode/);
  assert.deepEqual(cfg.ssl, { ca: 'PEM', rejectUnauthorized: true, servername: 'aws-0-us-west-2.pooler.supabase.com' });
  assert.throws(() => clientConfig('postgresql://postgres.ref:pw@host:5432/postgres', 'PEM'), /cost_reader/);
  assert.throws(() => clientConfig('not a url', 'PEM'), /not a valid URL/);
});

test('questions: a re-read keeps what it still assumes, withdraws what it no longer does', () => {
  const baseDate = { kind: 'pricing_base_date' as const, prompt: 'Base is 2024-03-15 — confirm?', evidence: 'e', proposedAnswer: { source: 'issue_date_fallback', date: '2024-03-15' } };
  const area = { kind: 'gross_area' as const, prompt: 'Assuming 62400 GSF — confirm?', evidence: 'e', proposedAnswer: { gsf: 62400, source: 'airtable' } };
  const open = [
    // Same proposal, keys in a different order: still the same assumption.
    { id: 1, kind: 'pricing_base_date', prompt: 'reworded', proposedAnswer: { date: '2024-03-15', source: 'issue_date_fallback' } },
    // The first read assumed an area; this read found it on the cover sheet.
    { id: 2, kind: 'gross_area', prompt: 'Assuming 60000 GSF — confirm?', proposedAnswer: { gsf: 60000, source: 'airtable' } },
    { id: 3, kind: 'coding_system', prompt: 'MasterFormat? — confirm?', proposedAnswer: { text: 'masterformat' } },
  ];
  const plan = planQuestions(open, [baseDate, area]);
  assert.deepEqual(plan.keep, [1]);
  assert.deepEqual(plan.withdraw, [2, 3], 'a changed proposal and a question no longer asked are both withdrawn');
  assert.deepEqual(plan.file.map((q) => q.kind), ['gross_area'], 'the new proposal is filed; the kept one is not duplicated');

  const other = planQuestions(
    [{ id: 9, kind: 'other', prompt: 'Is the site work in scope? — confirm?', proposedAnswer: { text: 'yes' } }],
    [{ kind: 'other', prompt: 'Is the site work in scope? — confirm?', evidence: 'e', proposedAnswer: { text: 'probably' } }]
  );
  assert.deepEqual(other.keep, [9], "for 'other', the question itself is what must match");
  assert.deepEqual(planQuestions([], []), { keep: [], withdraw: [], file: [] });
});

test('runlog: one timestamped line per stage, whitespace collapsed', () => {
  assert.match(stamp('downloaded   12 bytes'), /^\d{2}:\d{2}:\d{2}Z downloaded 12 bytes\n$/);
});

test('scrub: signed URL tokens never reach the log', () => {
  const url = `${SUPA}/storage/v1/object/sign/${PATH}?token=eyJsecret`;
  assert.doesNotMatch(scrub(`fetch failed for ${url}`, [url]), /eyJsecret/);
  assert.doesNotMatch(scrub('GET ...?token=eyJother&x=1', []), /eyJother/);
});
