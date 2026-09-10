"""DCW Cost Library — time-savings and business-impact model.

Every assumption is an input cell on the Inputs sheet; every other sheet is
formulas only, so replacing a placeholder rate recalculates the whole model.
Blue = you edit it. Black = the model computes it.
"""
import pathlib

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

BLUE, DEEP, GREEN, INK, MUTED, LINE, MIST = (
    '1E4D9B', '0F2C58', '4F9E2F', '131C2B', '667079', 'DDE4EE', 'F4F7FB')

H1 = Font(name='Calibri', size=15, bold=True, color=DEEP)
H2 = Font(name='Calibri', size=11, bold=True, color='FFFFFF')
LBL = Font(name='Calibri', size=10, color=INK)
NOTE = Font(name='Calibri', size=9, italic=True, color=MUTED)
IN = Font(name='Calibri', size=10, bold=True, color=BLUE)          # editable
OUT = Font(name='Calibri', size=10, color=INK)                     # computed
BIG = Font(name='Calibri', size=14, bold=True, color=GREEN)

HDR = PatternFill('solid', fgColor=DEEP)
INFILL = PatternFill('solid', fgColor='EAF1FB')
BAND = PatternFill('solid', fgColor=MIST)
THIN = Side(style='thin', color=LINE)
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

MONEY, MONEY0, HRS, PCT, NUM = '$#,##0.00', '$#,##0', '#,##0.0', '0.0%', '#,##0'

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


def field(ws, row, label, value, fmt, note='', editable=True, formula=False):
    ws.cell(row, 1, label).font = LBL
    c = ws.cell(row, 2, value)
    c.number_format = fmt
    c.border = BOX
    if editable and not formula:
        c.font, c.fill = IN, INFILL
    else:
        c.font = OUT
    if note:
        ws.cell(row, 3, note).font = NOTE
    return c


# ======================================================================
# Inputs
# ======================================================================
ws = wb.active
ws.title = 'Inputs'
title(ws, 'DCW Cost Library — business model',
      'BLUE cells are yours to change. Everything else is calculated. '
      'Placeholder values are marked — replace them and every sheet updates.')
ws.column_dimensions['A'].width = 46
ws.column_dimensions['B'].width = 14
ws.column_dimensions['C'].width = 74

section(ws, 4, 'RATES  —  the three numbers that are not yet captured')
field(ws, 5, 'Blended cost per estimator-hour (fully loaded)', 95, MONEY,
      'PLACEHOLDER. Salary + burden + overhead allocation. Pam can produce this.')
field(ws, 6, 'Blended billing rate per hour', 175, MONEY,
      'PLACEHOLDER. Weighted across senior cost manager / senior associate / estimator.')
field(ws, 7, 'Average fee per cost deliverable', 12000, MONEY0,
      'PLACEHOLDER. Needed only for the fee-cut scenario on "Fee & margin".')
field(ws, 8, 'Billable hours per estimator per year', 1450, NUM,
      'Used to express saved hours as a share of a full-time person.')

section(ws, 10, 'THE PROCESS  —  what the Library actually replaces')
field(ws, 11, 'Hours per deliverable TODAY on this step', 5.0, HRS,
      'Digging Box for comparable jobs, normalising them, first-pass pricing, cross-checking. '
      'Operating plan T-21 ("hours per estimate") is the real source — still an open Q3 action.')
field(ws, 12, 'Hours per deliverable WITH the Library', 1.5, HRS,
      'Not zero. Somebody still reads the output, applies judgment and answers queue questions.')
field(ws, 13, 'Total delivery hours per deliverable (all steps)', 44, HRS,
      'PLACEHOLDER. Only used to work out what share of a job this step is.')

section(ws, 15, 'VOLUME')
field(ws, 16, 'Cost deliverables issued per year', 618, NUM,
      '1,235 deliverables over two years = 618/yr. Includes revisions.')
field(ws, 17, 'Share where the Library applies', 0.70, PCT,
      'Excludes one-off scopes with no comparable history. Deliberately conservative.')

section(ws, 19, 'ONGOING COST')
field(ws, 20, 'One-time archive read (all deliverables)', 375, MONEY0,
      'Worst case from the pilot deck: three passes over 1,235 documents.')
field(ws, 21, 'Annual run cost (API + database + hosting)', 1800, MONEY0,
      'Order of magnitude. Sits well under the matrix #12 CapEx gate of $20k.')
field(ws, 22, 'Build + maintenance hours per year', 120, NUM,
      'Non-billable engineering and curation. Costed at the blended rate below.')

section(ws, 24, 'PRICING SCENARIO  —  the "share it" lever')
field(ws, 25, 'Fee reduction offered to the client', 0.02, PCT,
      'What you hand back. Compare against the break-even on the "Fee & margin" sheet.')

ws['A27'] = 'Placeholder means: invented for the shape of the model, not taken from DCW records.'
ws['A27'].font = Font(name='Calibri', size=9, bold=True, color='B33636')

# ======================================================================
# Time saved
# ======================================================================
ws = wb.create_sheet('Time saved')
title(ws, 'Hours returned to the estimating team',
      'None of this depends on a dollar rate — it is volume times hours.')
ws.column_dimensions['A'].width = 46
ws.column_dimensions['B'].width = 14
ws.column_dimensions['C'].width = 74

section(ws, 4, 'PER DELIVERABLE')
field(ws, 5, 'Hours saved per deliverable', '=Inputs!B11-Inputs!B12', HRS,
      '', formula=True)
field(ws, 6, 'Reduction on this step', '=IF(Inputs!B11=0,0,B5/Inputs!B11)', PCT,
      '', formula=True)
field(ws, 7, 'Reduction on TOTAL job hours', '=IF(Inputs!B13=0,0,B5/Inputs!B13)', PCT,
      'This is the number that governs how far a fee can fall — see "Fee & margin".', formula=True)

section(ws, 9, 'PER YEAR')
field(ws, 10, 'Deliverables the Library applies to', '=Inputs!B16*Inputs!B17', NUM,
      '', formula=True)
field(ws, 11, 'Hours saved per year', '=B10*B5', NUM, '', formula=True)
field(ws, 12, 'Equivalent full-time estimators',
      '=IF(Inputs!B8=0,0,B11/Inputs!B8)', '#,##0.00',
      'Capacity we do not have to hire for.', formula=True)

section(ws, 14, 'VALUED TWO WAYS')
field(ws, 15, 'At internal cost (what the hours cost us)', '=B11*Inputs!B5', MONEY0,
      'The saving if the hours simply disappear from fixed-fee jobs.', formula=True)
field(ws, 16, 'At billing rate (if the hours are resold)', '=B11*Inputs!B6', MONEY0,
      'The ceiling — only realised if there is demand to fill the freed capacity.', formula=True)

section(ws, 18, 'NET OF WHAT IT COSTS TO RUN')
field(ws, 19, 'Annual cost to operate',
      '=Inputs!B21+Inputs!B22*Inputs!B5', MONEY0, '', formula=True)
field(ws, 20, 'Year-one cost including the archive read',
      '=B19+Inputs!B20', MONEY0, '', formula=True)
field(ws, 21, 'NET year-one benefit, at internal cost', '=B15-B20', MONEY0,
      '', formula=True)
ws['B21'].font = BIG
field(ws, 22, 'Return on year-one cost',
      '=IF(B20=0,0,B21/B20)', '#,##0"x"', 'Read as "every dollar spent returns this much".',
      formula=True)
ws['B22'].font = BIG

# ======================================================================
# Fee & margin
# ======================================================================
ws = wb.create_sheet('Fee & margin')
title(ws, 'Cut the fee, keep the margin',
      'The exact arithmetic behind "we could price slightly lower and still earn more".')
ws.column_dimensions['A'].width = 50
ws.column_dimensions['B'].width = 14
ws.column_dimensions['C'].width = 70

section(ws, 4, 'ONE DELIVERABLE, TODAY')
field(ws, 5, 'Fee', '=Inputs!B7', MONEY0, '', formula=True)
field(ws, 6, 'Delivery hours', '=Inputs!B13', HRS, '', formula=True)
field(ws, 7, 'Direct cost to deliver', '=B6*Inputs!B5', MONEY0, '', formula=True)
field(ws, 8, 'Gross margin', '=B5-B7', MONEY0, '', formula=True)
field(ws, 9, 'Gross margin %', '=IF(B5=0,0,B8/B5)', PCT, '', formula=True)

section(ws, 11, 'THE SAME DELIVERABLE, WITH THE LIBRARY')
field(ws, 12, 'Delivery hours', "=Inputs!B13-'Time saved'!B5", HRS, '', formula=True)
field(ws, 13, 'Fee after the reduction we offer',
      '=B5*(1-Inputs!B25)', MONEY0, '', formula=True)
field(ws, 14, 'Direct cost to deliver', '=B12*Inputs!B5', MONEY0, '', formula=True)
field(ws, 15, 'Gross margin', '=B13-B14', MONEY0, '', formula=True)
field(ws, 16, 'Gross margin %', '=IF(B13=0,0,B15/B13)', PCT, '', formula=True)
ws['B16'].font = BIG

section(ws, 18, 'THE TWO BREAK-EVENS  —  this is the whole argument')
field(ws, 19, 'Max fee cut that holds margin PERCENTAGE flat',
      "=IF(Inputs!B13=0,0,'Time saved'!B5/Inputs!B13)", PCT,
      'Exactly equal to the drop in total job hours. Cut by less than this and margin % rises.',
      formula=True)
field(ws, 20, 'Max fee cut that holds margin DOLLARS flat',
      "=IF(B5=0,0,'Time saved'!B5*Inputs!B5/B5)", PCT,
      'Smaller number. Use it when the goal is protecting absolute profit per job.',
      formula=True)
field(ws, 21, 'Headroom left after the cut we chose',
      '=B19-Inputs!B25', PCT,
      'Positive means the fee cut is affordable and margin % still improves.',
      formula=True)
ws['B21'].font = BIG

section(ws, 23, 'ACROSS THE YEAR')
field(ws, 24, 'Fee given back to clients',
      "=B5*Inputs!B25*'Time saved'!B10", MONEY0, '', formula=True)
field(ws, 25, 'Cost taken out of delivery',
      "='Time saved'!B15", MONEY0, '', formula=True)
field(ws, 26, 'Net margin gain after discounting',
      '=B25-B24', MONEY0,
      'The money left over once the clients have had their share.', formula=True)
ws['B26'].font = BIG
field(ws, 27, 'Change in gross margin % per job',
      '=B16-B9', PCT, '', formula=True)

ws['A29'] = ('Why the first break-even equals the hours drop: margin % = 1 - (hours x cost) / fee. '
             'Scale hours and fee by the same factor and the ratio is unchanged. It is algebra, '
             'not a rule of thumb.')
ws['A29'].font = NOTE
ws.merge_cells('A29:C29')

# ======================================================================
# Sensitivity
# ======================================================================
ws = wb.create_sheet('Sensitivity')
title(ws, 'If the assumptions are wrong',
      'Net year-one benefit at internal cost. Rows = hours saved per deliverable. '
      'Columns = share of deliverables the Library applies to.')
ws.column_dimensions['A'].width = 26
shares = [0.40, 0.55, 0.70, 0.85, 1.00]
saved = [1.0, 2.0, 3.0, 3.5, 4.5, 5.5]

ws.cell(4, 1, 'HOURS SAVED  \\  APPLIES TO').font = Font(
    name='Calibri', size=9, bold=True, color='FFFFFF')
ws.cell(4, 1).fill = HDR
for j, sh in enumerate(shares):
    c = ws.cell(4, 2 + j, sh)
    c.number_format = PCT
    c.font, c.fill = H2, HDR
    c.alignment = Alignment(horizontal='center')
    ws.column_dimensions[get_column_letter(2 + j)].width = 13

for i, hrs in enumerate(saved):
    r = 5 + i
    c = ws.cell(r, 1, hrs)
    c.number_format = '#,##0.0" hrs"'
    c.font, c.fill, c.border = IN, BAND, BOX
    for j in range(len(shares)):
        col = get_column_letter(2 + j)
        f = (f'=$A{r}*Inputs!$B$16*{col}$4*Inputs!$B$5'
             f'-(Inputs!$B$21+Inputs!$B$22*Inputs!$B$5+Inputs!$B$20)')
        cell = ws.cell(r, 2 + j, f)
        cell.number_format = MONEY0
        cell.font, cell.border = OUT, BOX
        if abs(hrs - 3.5) < 0.01 and abs(sh_ := shares[j] - 0.70) < 0.01:
            cell.fill = PatternFill('solid', fgColor='EAF6E6')
            cell.font = Font(name='Calibri', size=10, bold=True, color=GREEN)

ws.cell(12, 1, 'Shaded cell is the base case on the Inputs sheet.').font = NOTE
ws.cell(13, 1, 'Even at 1 hour saved on 40% of deliverables, the model clears its own cost several '
               'times over. The build cost is not the risk — the hours assumption is.').font = NOTE

# ======================================================================
# Firm impact
# ======================================================================
ws = wb.create_sheet('Firm impact')
title(ws, 'Against the operating plan',
      'How the freed capacity lands on the numbers we already committed to.')
ws.column_dimensions['A'].width = 48
ws.column_dimensions['B'].width = 14
ws.column_dimensions['C'].width = 74

section(ws, 4, 'EXPENSE RATIO  —  key result: 67% down to 62% (Pam)')
field(ws, 5, 'Annual revenue', 6000000, MONEY0,
      'PLACEHOLDER. Replace with the 2025 actual from task T-05.')
field(ws, 6, 'Expense ratio today', 0.67, PCT, 'Operating plan, 2024 year-end.')
field(ws, 7, 'Total expenses', '=B5*B6', MONEY0, '', formula=True)
field(ws, 8, 'Share of freed hours actually resold', 0.50, PCT,
      'Honest discount: freed capacity only becomes revenue if there is work to put in it.')
field(ws, 9, 'Additional revenue from resold capacity',
      "='Time saved'!B11*B8*Inputs!B6", MONEY0, '', formula=True)
field(ws, 10, 'Expense ratio after', '=IF((B5+B9)=0,0,B7/(B5+B9))', PCT,
      'Expenses assumed flat — the whole point is that the hours already exist.', formula=True)
ws['B10'].font = BIG
field(ws, 11, 'Movement toward the 62% target',
      '=B6-B10', PCT, '', formula=True)

section(ws, 13, 'WIN RATE  —  key result: hold above 70% (Brian)')
field(ws, 14, 'Annual proposal value pursued', 9000000, MONEY0,
      'PLACEHOLDER. Brittany\'s pipeline once the 146 unconfirmed pursuits are resolved (T-14/15/16).')
field(ws, 15, 'Decided win rate today', 0.72, PCT, 'Operating plan.')
field(ws, 16, 'Improvement from evidence-backed fee proposals', 0.02, PCT,
      'Assumption to test, not a claim. Two points is deliberately modest.')
field(ws, 17, 'Additional work won', '=B14*B16', MONEY0, '', formula=True)
field(ws, 18, 'Margin on that work at today\'s rate',
      "=B17*'Fee & margin'!B9", MONEY0,
      'Note this can dwarf the time saving — and it is the least certain line in the model.',
      formula=True)

section(ws, 20, 'REWORK  —  baseline T-22 (Lacie), improvement owned by Matt')
field(ws, 21, 'Rework hours as a share of delivery hours', 0.08, PCT,
      'PLACEHOLDER until T-22 lands.')
field(ws, 22, 'Share of rework a checked benchmark prevents', 0.25, PCT,
      'Wrong-order-of-magnitude errors caught before issue, not typos.')
field(ws, 23, 'Rework hours avoided per year',
      "='Time saved'!B10*Inputs!B13*B21*B22", NUM, '', formula=True)
field(ws, 24, 'Value at internal cost', '=B23*Inputs!B5', MONEY0, '', formula=True)

section(ws, 26, 'THE THREE LEVERS TOGETHER')
field(ws, 27, 'Capacity returned (net of run cost)', "='Time saved'!B21", MONEY0,
      '', formula=True)
field(ws, 28, 'Rework avoided', '=B24', MONEY0, '', formula=True)
field(ws, 29, 'Win-rate upside (least certain)', '=B18', MONEY0, '', formula=True)
field(ws, 30, 'TOTAL year-one impact', '=B27+B28+B29', MONEY0, '', formula=True)
ws['B30'].font = Font(name='Calibri', size=16, bold=True, color=GREEN)
ws.cell(31, 1, 'Read the top two lines as the case. Treat the third as upside you have to earn.').font = NOTE

# ======================================================================
# Notes
# ======================================================================
ws = wb.create_sheet('Notes & sources')
ws.column_dimensions['A'].width = 30
ws.column_dimensions['B'].width = 100
title(ws, 'Where each number came from',
      'Read this before quoting any figure in this workbook to a client or the Board.')

rows = [
    ('SOURCED', ''),
    ('1,235 deliverables / 2 yrs', 'DCW Airtable, quoted on the 9 September call.'),
    ('Expense ratio 67% (2024)', 'DCW Operating Plan 2026-2027, "Where we\'re starting from".'),
    ('Target expense ratio 62%', 'Operating Plan annual key results, accountable: Pam.'),
    ('Decided win rate ~72%', 'Operating Plan annual key results, accountable: Brian.'),
    ('1,765 hours redistributed', 'Operating Plan — Bryan\'s departure, 63 tasks, ~25 accounts.'),
    ('Archive read $75-375', 'Anthropic API list pricing against the document volume.'),
    ('Governance gates #12/#13/#46/#47', 'DCW EOT Decision Matrix (RDA/RACIV), 07/10/2025.'),
    ('', ''),
    ('PLACEHOLDER', 'Invented for the shape of the model. Replace before quoting.'),
    ('Blended cost / billing rate', 'Not in any document available to this model. Pam or Workday.'),
    ('Average fee per deliverable', 'Derivable from Airtable revenue divided by deliverable count.'),
    ('Hours per estimate (5.0 -> 1.5)', 'Operating Plan task T-21 — an OPEN Q3 baseline, accountable: Lacie. '
                                        'Until it is captured, the split of that time is an estimate.'),
    ('Total delivery hours (44)', 'Same source once T-21 lands.'),
    ('Annual revenue / pipeline', 'Task T-05 (2025 actuals) and Brittany\'s resolved pursuits.'),
    ('Rework rate (8%)', 'Operating Plan task T-22 — also an open baseline.'),
    ('', ''),
    ('JUDGEMENT', 'Ours, and arguable.'),
    ('70% of deliverables apply', 'Conservative. Excludes scopes with no comparable history.'),
    ('50% of freed hours resold', 'Capacity only becomes revenue if demand exists to absorb it.'),
    ('+2pp win rate', 'A hypothesis to test against real proposals, not a forecast.'),
    ('25% of rework prevented', 'Benchmark checks catch magnitude errors, not arithmetic slips.'),
]
r = 4
for k, v in rows:
    if k in ('SOURCED', 'PLACEHOLDER', 'JUDGEMENT'):
        section(ws, r, k + ('   —   ' + v if v else ''))
    else:
        ws.cell(r, 1, k).font = Font(name='Calibri', size=10, bold=True, color=INK)
        ws.cell(r, 2, v).font = LBL
    r += 1

for sheet in wb:
    sheet.sheet_view.showGridLines = False
    sheet.freeze_panes = 'A4'

out = str(pathlib.Path(__file__).with_name('DCW-Cost-Library-Business-Model.xlsx'))
wb.save(out)
print('wrote', out)
