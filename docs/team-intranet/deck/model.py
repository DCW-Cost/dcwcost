"""DCW Cost Library — time-savings and business-impact model.

Built on DCW's own measured data: "What a Cost Report Costs" (Sept 2026),
an analysis of 28,910 time entries and 57,887 logged hours from the Airtable
base, Mar 2021 – Sept 2026.

Everything expressed in HOURS is measured or derived from that analysis and
needs no assumption about rates. Only the dollar conversion still rests on a
placeholder, and the Inputs sheet says which cells those are.

Blue = you edit it. Grey = measured, change only if the source data changes.
Black = the model computes it.
"""
import pathlib

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

BLUE, DEEP, GREEN, INK, MUTED, LINE, MIST = (
    '1E4D9B', '0F2C58', '4F9E2F', '131C2B', '667079', 'DDE4EE', 'F4F7FB')
AMBER, RED = 'B8791A', 'B33636'

H1 = Font(name='Calibri', size=15, bold=True, color=DEEP)
H2 = Font(name='Calibri', size=11, bold=True, color='FFFFFF')
LBL = Font(name='Calibri', size=10, color=INK)
NOTE = Font(name='Calibri', size=9, italic=True, color=MUTED)
IN = Font(name='Calibri', size=10, bold=True, color=BLUE)      # you edit
MEAS = Font(name='Calibri', size=10, bold=True, color='45505C')  # measured
OUT = Font(name='Calibri', size=10, color=INK)                  # computed
BIG = Font(name='Calibri', size=14, bold=True, color=GREEN)

HDR = PatternFill('solid', fgColor=DEEP)
INFILL = PatternFill('solid', fgColor='EAF1FB')
MEASFILL = PatternFill('solid', fgColor='EFF2F6')
BAND = PatternFill('solid', fgColor=MIST)
THIN = Side(style='thin', color=LINE)
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

MONEY, MONEY0, HRS, PCT, NUM, X = '$#,##0.00', '$#,##0', '#,##0.0', '0.0%', '#,##0', '#,##0.00"×"'

wb = Workbook()


def title(ws, text, sub):
    ws['A1'] = text
    ws['A1'].font = H1
    ws['A2'] = sub
    ws['A2'].font = NOTE
    ws.row_dimensions[1].height = 22


def section(ws, row, text):
    ws.cell(row, 1, text).font = H2
    for c in range(1, 6):
        ws.cell(row, c).fill = HDR


def field(ws, row, label, value, fmt, note='', kind='input'):
    """kind: 'input' (you edit) | 'measured' (from the analysis) | 'calc'."""
    ws.cell(row, 1, label).font = LBL
    c = ws.cell(row, 2, value)
    c.number_format = fmt
    c.border = BOX
    if kind == 'input':
        c.font, c.fill = IN, INFILL
    elif kind == 'measured':
        c.font, c.fill = MEAS, MEASFILL
    else:
        c.font = OUT
    if note:
        ws.cell(row, 3, note).font = NOTE
    return c


def widths(ws, a=52, b=15, c=78):
    ws.column_dimensions['A'].width = a
    ws.column_dimensions['B'].width = b
    ws.column_dimensions['C'].width = c


# ======================================================================
# Inputs
# ======================================================================
ws = wb.active
ws.title = 'Inputs'
title(ws, 'DCW Cost Library — business model',
      'GREY cells are measured from "What a Cost Report Costs" (Sept 2026). BLUE cells are '
      'yours. Everything in hours is now real; only the dollar conversion is still a guess.')
widths(ws)

section(ws, 4, 'RATES  —  the only placeholders left in this model')
field(ws, 5, 'Blended cost per estimator-hour (fully loaded)', 95, MONEY,
      'PLACEHOLDER. Salary + burden. Note this is the cost of a PAID hour; the 1.38× '
      'multiplier below converts billable hours into paid ones.')
field(ws, 6, 'Blended billing rate per hour', 175, MONEY,
      'PLACEHOLDER. Only used for the "resold capacity" ceiling.')
field(ws, 7, 'Average fee per cost report', '=B12*B6', MONEY0,
      'COMPUTED from the measured 26.0 h fee budget × the billing rate above. A flat $12,000 '
      'here would imply ~$635 per billable hour, which is not a real number — that is what '
      'happens when an invented fee meets measured hours. If you know the true average fee, '
      'type it straight over this formula.', kind='calc')

section(ws, 9, 'THE COST REPORT  —  measured, 720 completed budgeted tasks')
field(ws, 10, 'Hours per cost report (coverage-adjusted median)', 18.9, HRS,
      'Middle half 11.4–32.8 h; 1 in 10 exceeds 49.8 h. This is the number that was an open '
      'Q3 baseline (operating plan T-21). It is now measured.', kind='measured')
field(ws, 11, 'Hours as literally logged (unadjusted)', 15.0, HRS,
      'A FLOOR, not an answer — only 55% of paid estimator hours reach the time log in 2026 '
      '(93% in 2022). Use this for the conservative case.', kind='measured')
field(ws, 12, 'Median fee-proposal budget per task', 26.0, HRS,
      'The hours DCW sold for those same tasks. Realization 0.78 overall.', kind='measured')
field(ws, 13, 'Overhead multiplier', 1.38, X,
      'Paid hours the firm carries per billable hour delivered. A 24-hour estimate consumes '
      'about 33 hours of firm capacity.', kind='measured')
field(ws, 14, 'Billable hours per estimator per year', 1354, NUM,
      '1,867 available hours × 72.5% billable, from 8 fully-tracked person-years.',
      kind='measured')

section(ws, 16, 'WHERE THE HOURS GO  —  measured (see the next sheet for all nine)')
field(ws, 17, 'Report production, share of a cost report', 0.585, PCT,
      'The largest bucket by far — nearly 4× takeoff — and the one the Library actually '
      'attacks. Takeoff (15.4%) it does not touch at all.', kind='measured')
field(ws, 18, 'Share of report production the Library removes', 0.30, PCT,
      'THE ONE JUDGEMENT LEFT IN THE HOURS. Deliberately conservative: finding and '
      'normalising comparables and entering a first-pass rate — not writing the report.')

section(ws, 20, 'VOLUME')
field(ws, 21, 'Cost deliverables issued per year', 618, NUM,
      '1,235 deliverables over two years, per Airtable. Cross-check: the analysis counts '
      '5,532 project tasks over 5.5 years (~1,000/yr), a broader definition.')
field(ws, 22, 'Share where the Library applies', 0.70, PCT,
      'Excludes scopes with no comparable history. Deliberately conservative.')

section(ws, 24, 'ONGOING COST')
field(ws, 25, 'One-time archive read (all deliverables)', 375, MONEY0,
      'Worst case: three passes over 1,235 documents.')
field(ws, 26, 'Annual run cost (API + database + hosting)', 1800, MONEY0,
      'Order of magnitude. Well under the matrix #12 CapEx gate of $20k.')
field(ws, 27, 'Build + maintenance hours per year', 120, NUM,
      'Non-billable engineering and curation, costed at the blended rate above.')

section(ws, 29, 'PRICING SCENARIO')
field(ws, 30, 'Fee reduction offered to the client', 0.05, PCT,
      'What you hand back. Must sit below BOTH break-evens on "Fee & margin" to improve margin '
      'in dollars as well as percentage — check that sheet after changing it.')

ws['A32'] = ('Measured = from DCW\'s own time-tracking analysis. Placeholder = invented for the '
             'shape of the model; replace before quoting.')
ws['A32'].font = Font(name='Calibri', size=9, bold=True, color=RED)

# ======================================================================
# Where the hours go
# ======================================================================
ws = wb.create_sheet('Where the hours go')
title(ws, 'Inside a cost report',
      'Share of project time on the 720 benchmark tasks, by Cost Planning Tag. Measured.')
widths(ws, 34, 14, 16)
ws.column_dimensions['D'].width = 62

ACTIVITIES = [
    ('Report production', 0.585, 'Building the document: structure, populating rates, formatting. '
     'THE LIBRARY TARGETS THIS.'),
    ('Takeoff', 0.154, 'Measuring quantities. The Library does not touch this.'),
    ('Revisions & redlines', 0.088, 'Rework after first issue — nearly a tenth of every report.'),
    ('QC & review', 0.053, 'Checking. Arguably should rise, not fall.'),
    ('Client-facing', 0.045, 'Meetings and correspondence.'),
    ('Other', 0.031, ''),
    ('Prep & setup', 0.028, 'Partly addressable — a template that arrives populated.'),
    ('Internal coordination', 0.008, ''),
    ('Reconciliation', 0.007, 'Comparing against another estimate.'),
]

ws.cell(4, 1, 'ACTIVITY').font = H2
ws.cell(4, 2, 'SHARE').font = H2
ws.cell(4, 3, 'HOURS').font = H2
ws.cell(4, 4, 'WHAT IT IS').font = H2
for c in range(1, 5):
    ws.cell(4, c).fill = HDR

for i, (name, share, what) in enumerate(ACTIVITIES):
    r = 5 + i
    ws.cell(r, 1, name).font = LBL
    c = ws.cell(r, 2, share); c.number_format = PCT; c.font, c.fill, c.border = MEAS, MEASFILL, BOX
    h = ws.cell(r, 3, f'=B{r}*Inputs!$B$10'); h.number_format = HRS; h.font, h.border = OUT, BOX
    ws.cell(r, 4, what).font = NOTE
    if name == 'Report production':
        for cc in range(1, 5):
            ws.cell(r, cc).fill = PatternFill('solid', fgColor='EAF6E6')

r = 5 + len(ACTIVITIES)
ws.cell(r, 1, 'TOTAL').font = Font(name='Calibri', size=10, bold=True, color=INK)
c = ws.cell(r, 2, f'=SUM(B5:B{r-1})'); c.number_format = PCT; c.font = OUT
h = ws.cell(r, 3, f'=SUM(C5:C{r-1})'); h.number_format = HRS; h.font = OUT

ws.cell(r + 2, 1, 'Report production is nearly four times takeoff. That is the finding that '
                  'makes this tool worth building — the bulk of a cost report is not measuring '
                  'the building, it is assembling the document.').font = NOTE
ws.cell(r + 3, 1, 'Revisions run at 8.8%: close to a tenth of every report is rework after '
                  'first issue. A populated, consistent starting point should reduce that too, '
                  'but this model claims nothing for it.').font = NOTE

# ======================================================================
# Time saved
# ======================================================================
ws = wb.create_sheet('Time saved')
title(ws, 'Hours returned to the estimating team',
      'None of this depends on a dollar rate. It is measured hours times volume.')
widths(ws)

section(ws, 4, 'PER COST REPORT')
field(ws, 5, 'Report production hours', '=Inputs!B10*Inputs!B17', HRS, '', kind='calc')
field(ws, 6, 'Hours saved per report', '=B5*Inputs!B18', HRS, '', kind='calc')
field(ws, 7, 'As a share of the whole report', '=IF(Inputs!B10=0,0,B6/Inputs!B10)', PCT,
      'This is the number that governs how far a fee can fall — see "Fee & margin".',
      kind='calc')
field(ws, 8, 'Hours per report after', '=Inputs!B10-B6', HRS, '', kind='calc')
field(ws, 9, 'Realization before (actual ÷ budget)', '=IF(Inputs!B12=0,0,Inputs!B10/Inputs!B12)',
      '0.00', 'Median ÷ median. The analysis reports 0.78 overall, aggregated differently.',
      kind='calc')
field(ws, 10, 'Realization after', '=IF(Inputs!B12=0,0,B8/Inputs!B12)', '0.00', '', kind='calc')

section(ws, 12, 'PER YEAR')
field(ws, 13, 'Reports the Library applies to', '=Inputs!B21*Inputs!B22', NUM, '', kind='calc')
field(ws, 14, 'Hours saved per year', '=B13*B6', NUM, '', kind='calc')
ws['B14'].font = BIG
field(ws, 15, 'Firm capacity freed (paid hours)', '=B14*Inputs!B13', NUM,
      'Billable hours × the 1.38 overhead multiplier — what the firm actually carries.',
      kind='calc')
field(ws, 16, 'Equivalent full-time estimators', '=IF(Inputs!B14=0,0,B14/Inputs!B14)', '#,##0.00',
      'Capacity you do not have to hire for.', kind='calc')
ws['B16'].font = BIG

section(ws, 18, 'VALUED THREE WAYS  —  these are the only lines needing a rate')
field(ws, 19, 'Direct cost of the freed hours', '=B14*Inputs!B5', MONEY0,
      'The conservative figure, and the one on the deck. Freed billable hours × the loaded '
      'rate, claiming nothing for the overhead those hours carry.', kind='calc')
ws['B19'].font = BIG
field(ws, 20, 'Including the overhead they carry', '=B15*Inputs!B5', MONEY0,
      'The same hours × 1.38. Defensible — the analysis says a rate clearing only the billable '
      'hour is short by 38% — but it assumes the absorbed project time scales down with the '
      'work. Kept off the slide for that reason.', kind='calc')
field(ws, 21, 'At billing rate, if resold', '=B14*Inputs!B6', MONEY0,
      'The ceiling — only realised if there is demand to absorb the freed capacity.',
      kind='calc')

section(ws, 23, 'NET OF WHAT IT COSTS TO RUN')
field(ws, 24, 'Annual cost to operate', '=Inputs!B26+Inputs!B27*Inputs!B5', MONEY0, '', kind='calc')
field(ws, 25, 'Year-one cost including the archive read', '=B24+Inputs!B25', MONEY0, '', kind='calc')
field(ws, 26, 'NET year-one benefit, at direct cost', '=B19-B25', MONEY0, '', kind='calc')
ws['B26'].font = BIG
field(ws, 27, 'Return on year-one cost', '=IF(B25=0,0,B26/B25)', X, '', kind='calc')
ws['B27'].font = BIG

# ======================================================================
# Fee & margin
# ======================================================================
ws = wb.create_sheet('Fee & margin')
title(ws, 'Cut the fee, keep the margin',
      'The arithmetic behind "we could price slightly lower and still earn more".')
widths(ws, 54, 15, 72)

section(ws, 4, 'ONE COST REPORT, TODAY')
field(ws, 5, 'Fee', '=Inputs!B7', MONEY0, '', kind='calc')
field(ws, 6, 'Billable hours delivered', '=Inputs!B10', HRS, '', kind='calc')
field(ws, 7, 'Paid hours consumed', '=B6*Inputs!B13', HRS,
      'The 1.38× multiplier. This is the honest cost basis.', kind='calc')
field(ws, 8, 'Cost to deliver', '=B7*Inputs!B5', MONEY0, '', kind='calc')
field(ws, 9, 'Gross margin', '=B5-B8', MONEY0, '', kind='calc')
field(ws, 10, 'Gross margin %', '=IF(B5=0,0,B9/B5)', PCT, '', kind='calc')

section(ws, 12, 'THE SAME REPORT, WITH THE LIBRARY')
field(ws, 13, 'Billable hours delivered', "='Time saved'!B8", HRS, '', kind='calc')
field(ws, 14, 'Fee after the reduction offered', '=B5*(1-Inputs!B30)', MONEY0, '', kind='calc')
field(ws, 15, 'Paid hours consumed', '=B13*Inputs!B13', HRS, '', kind='calc')
field(ws, 16, 'Cost to deliver', '=B15*Inputs!B5', MONEY0, '', kind='calc')
field(ws, 17, 'Gross margin', '=B14-B16', MONEY0, '', kind='calc')
field(ws, 18, 'Gross margin %', '=IF(B14=0,0,B17/B14)', PCT, '', kind='calc')
ws['B18'].font = BIG

section(ws, 20, 'THE TWO BREAK-EVENS  —  this is the whole argument')
field(ws, 21, 'Max fee cut holding margin PERCENTAGE flat', "='Time saved'!B7", PCT,
      'Exactly equal to the drop in hours on the job. Cut by less and margin % rises.',
      kind='calc')
field(ws, 22, 'Max fee cut holding margin DOLLARS flat', '=IF(B5=0,0,(B8-B16)/B5)', PCT,
      'Smaller. A fee cut applies to the whole fee; the saving applies to part of the work.',
      kind='calc')
field(ws, 23, 'Headroom left after the cut chosen', '=B21-Inputs!B30', PCT,
      'Positive means the cut is affordable and margin % still improves.', kind='calc')
ws['B23'].font = BIG

section(ws, 25, 'ACROSS THE YEAR')
field(ws, 26, 'Fee given back to clients', "=B5*Inputs!B30*'Time saved'!B13", MONEY0, '', kind='calc')
field(ws, 27, 'Cost taken out of delivery', "='Time saved'!B19", MONEY0, '', kind='calc')
field(ws, 28, 'Net margin gain after discounting', '=B27-B26', MONEY0, '', kind='calc')
ws['B28'].font = BIG
field(ws, 29, 'Change in gross margin % per report', '=B18-B10', PCT, '', kind='calc')

ws['A31'] = ('Why the first break-even equals the hours drop: margin % = 1 − (hours × cost) / fee. '
             'Scale hours and fee by the same factor and the ratio is unchanged. Algebra, not a '
             'rule of thumb.')
ws['A31'].font = NOTE

# ======================================================================
# Sensitivity
# ======================================================================
ws = wb.create_sheet('Sensitivity')
title(ws, 'If the judgement is wrong',
      'Hours saved per year. Rows = share of report production removed. Columns = share of '
      'deliverables the Library applies to. Only the row headers are a judgement now.')
ws.column_dimensions['A'].width = 30
shares = [0.40, 0.55, 0.70, 0.85, 1.00]
cuts = [0.10, 0.20, 0.30, 0.40, 0.50]

ws.cell(4, 1, 'REMOVED  \\  APPLIES TO').font = Font(name='Calibri', size=9, bold=True,
                                                     color='FFFFFF')
ws.cell(4, 1).fill = HDR
for j, sh in enumerate(shares):
    c = ws.cell(4, 2 + j, sh)
    c.number_format, c.font, c.fill = PCT, H2, HDR
    c.alignment = Alignment(horizontal='center')
    ws.column_dimensions[get_column_letter(2 + j)].width = 13

for i, cut in enumerate(cuts):
    r = 5 + i
    c = ws.cell(r, 1, cut)
    c.number_format, c.font, c.fill, c.border = PCT, IN, BAND, BOX
    for j in range(len(shares)):
        col = get_column_letter(2 + j)
        f = f'=Inputs!$B$10*Inputs!$B$17*$A{r}*Inputs!$B$21*{col}$4'
        cell = ws.cell(r, 2 + j, f)
        cell.number_format, cell.font, cell.border = NUM, OUT, BOX
        if abs(cut - 0.30) < 1e-9 and abs(sh - 0.70) < 1e-9:
            cell.fill = PatternFill('solid', fgColor='EAF6E6')
            cell.font = Font(name='Calibri', size=10, bold=True, color=GREEN)

ws.cell(11, 1, 'Shaded cell is the base case on the Inputs sheet.').font = NOTE
ws.cell(12, 1, 'Even removing a tenth of report production on 40% of deliverables returns about '
               '160 hours a year, which still clears the run cost several times over. The build '
               'cost was never the risk.').font = NOTE

# ======================================================================
# Firm impact
# ======================================================================
ws = wb.create_sheet('Firm impact')
title(ws, 'Against the operating plan',
      'How the freed capacity lands on numbers DCW has already committed to.')
widths(ws)

section(ws, 4, 'EXPENSE RATIO  —  key result: 67% down to 62% (Pam)')
field(ws, 5, 'Annual revenue', 6000000, MONEY0,
      'PLACEHOLDER. Replace with the 2025 actual from task T-05.')
field(ws, 6, 'Expense ratio today', 0.67, PCT, 'Operating plan, 2024 year-end.', kind='measured')
field(ws, 7, 'Total expenses', '=B5*B6', MONEY0, '', kind='calc')
field(ws, 8, 'Share of freed hours actually resold', 0.50, PCT,
      'Honest discount: freed capacity only becomes revenue if there is work to put in it.')
field(ws, 9, 'Additional revenue from resold capacity',
      "='Time saved'!B14*B8*Inputs!B6", MONEY0, '', kind='calc')
field(ws, 10, 'Expense ratio after', '=IF((B5+B9)=0,0,B7/(B5+B9))', PCT,
      'Expenses assumed flat — the whole point is that the hours already exist.', kind='calc')
ws['B10'].font = BIG
field(ws, 11, 'Movement toward the 62% target', '=B6-B10', PCT, '', kind='calc')

section(ws, 13, 'REWORK  —  measured at 8.8% of a cost report')
field(ws, 14, 'Revisions & redlines, share of a report', 0.088, PCT,
      'MEASURED. Rework after first issue.', kind='measured')
field(ws, 15, 'Share a consistent starting point prevents', 0.20, PCT,
      'Judgement. A populated template should reduce revision rounds; nothing measures this yet.')
field(ws, 16, 'Rework hours avoided per year',
      "='Time saved'!B13*Inputs!B10*B14*B15", NUM, '', kind='calc')
field(ws, 17, 'Value at internal cost', '=B16*Inputs!B13*Inputs!B5', MONEY0, '', kind='calc')

section(ws, 19, 'WIN RATE  —  key result: hold above 70% (Brian)')
field(ws, 20, 'Annual proposal value pursued', 9000000, MONEY0,
      'PLACEHOLDER. Brittany\'s pipeline once the 146 unconfirmed pursuits are resolved.')
field(ws, 21, 'Decided win rate today', 0.72, PCT, 'Operating plan.', kind='measured')
field(ws, 22, 'Improvement from evidence-backed fee proposals', 0.02, PCT,
      'A hypothesis to test, not a forecast. Two points is deliberately modest.')
field(ws, 23, 'Additional work won', '=B20*B22', MONEY0, '', kind='calc')
field(ws, 24, 'Margin on that work', "=B23*'Fee & margin'!B10", MONEY0,
      'Can dwarf the time saving — and is the least certain line in the model.', kind='calc')

section(ws, 26, 'THE THREE LEVERS TOGETHER')
field(ws, 27, 'Capacity returned (net of run cost)', "='Time saved'!B26", MONEY0, '', kind='calc')
field(ws, 28, 'Rework avoided', '=B17', MONEY0, '', kind='calc')
field(ws, 29, 'Win-rate upside (least certain)', '=B24', MONEY0, '', kind='calc')
field(ws, 30, 'TOTAL year-one impact', '=B27+B28+B29', MONEY0, '', kind='calc')
ws['B30'].font = Font(name='Calibri', size=16, bold=True, color=GREEN)
ws.cell(31, 1, 'Read the top two as the case. Treat the third as upside you have to earn.').font = NOTE

# ======================================================================
# Notes & sources
# ======================================================================
ws = wb.create_sheet('Notes & sources')
ws.column_dimensions['A'].width = 34
ws.column_dimensions['B'].width = 104
title(ws, 'Where each number came from',
      'Read this before quoting any figure to a client or the Board.')

rows = [
    ('MEASURED', 'DCW · "What a Cost Report Costs" · Sept 2026 · 28,910 time entries, '
                 '57,887 hours, 5,532 tasks, Mar 2021 – Sept 2026'),
    ('18.9 h per cost report', 'Coverage-adjusted median across 720 completed, budgeted tasks with '
                               '≥3 time entries. Middle half 11.4–32.8 h.'),
    ('15.0 h logged', 'What the entries literally say. A floor — 2026 tracking coverage is 55%.'),
    ('26.0 h fee budget', 'Median fee-proposal budget for the same tasks. Realization 0.78.'),
    ('Activity shares', 'Report production 58.5%, takeoff 15.4%, revisions 8.8%, QC 5.3%, '
                        'client-facing 4.5%, other 3.1%, prep 2.8%, coordination 0.8%, '
                        'reconciliation 0.7%.'),
    ('1.38× overhead multiplier', 'Paid hours per billable hour, from 8 fully-tracked person-years '
                                  '(14,936 available hours).'),
    ('1,354 billable h / estimator', '1,867 available × 72.5% billable, same cohort.'),
    ('Expense ratio, win rate', 'DCW Operating Plan 2026-2027.'),
    ('', ''),
    ('THE SOURCE\'S OWN CAVEATS', 'Stated in the report; they belong here too.'),
    ('The coverage adjustment', 'Assumes every estimator should land near 0.854 project-hours per '
                                'available hour — measured from three people across eight years. '
                                'If newer staff genuinely spend more time in training, 18.9 h is '
                                'too high.'),
    ('The calibration is old', 'Cohort is 2021–2024. No estimator has hit 85% coverage since, so '
                               'current delivery effort is inferred from how the team worked two '
                               'to five years ago.'),
    ('0.78 has a wide band', 'Task-level realization stayed near 0.45 every year even as coverage '
                             'fell from 93% to 53%. That stability is not fully explained.'),
    ('The test that settles it', 'Four estimators logging everything for six consecutive weeks '
                                 'would replace every inference with a measurement.'),
    ('', ''),
    ('STILL PLACEHOLDER', 'Invented. Replace before quoting.'),
    ('Blended cost per hour', 'Not in any document available. Pam or Workday.'),
    ('Blended billing rate', 'Same.'),
    ('Average fee per cost report', 'The single most useful number to get — it converts every '
                                    'hours figure here into dollars. Airtable revenue ÷ '
                                    'deliverable count would do it.'),
    ('Annual revenue / pipeline', 'Task T-05 (2025 actuals) and the resolved pursuits.'),
    ('', ''),
    ('JUDGEMENT', 'Ours, and arguable.'),
    ('30% of report production', 'The one judgement left in the hours. Finding and normalising '
                                 'comparables and entering a first-pass rate — not writing the '
                                 'report. See "Sensitivity" for 10%–50%.'),
    ('70% of deliverables apply', 'Excludes scopes with no comparable history.'),
    ('50% of freed hours resold', 'Capacity becomes revenue only if demand exists to absorb it.'),
    ('20% of rework prevented', 'A consistent starting point should reduce revision rounds. '
                                'Nothing measures this yet.'),
    ('+2pp win rate', 'A hypothesis to test against real proposals, not a forecast.'),
]
r = 4
for k, v in rows:
    if k in ('MEASURED', 'STILL PLACEHOLDER', 'JUDGEMENT', 'THE SOURCE\'S OWN CAVEATS'):
        section(ws, r, k + ('   —   ' + v if v else ''))
    else:
        ws.cell(r, 1, k).font = Font(name='Calibri', size=10, bold=True, color=INK)
        ws.cell(r, 2, v).font = LBL
        ws.cell(r, 2).alignment = Alignment(wrap_text=True, vertical='top')
        ws.row_dimensions[r].height = 28
    r += 1

for sheet in wb:
    sheet.sheet_view.showGridLines = False
    sheet.freeze_panes = 'A4'

out = str(pathlib.Path(__file__).with_name('DCW-Cost-Library-Business-Model.xlsx'))
wb.save(out)
print('wrote', out)
