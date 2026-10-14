-- ============================================================================
-- 025 — the taxonomy and the units, seeded from the master template
--
-- Source: "DCW Cost Report - Final Draft Template 2026.xlsx", tab 'Section
-- Setup', rows 2-208. Supplied by Rachel on 2026-10-14 as the template every
-- report is built from.
--
-- WHAT THE CODING SYSTEM ACTUALLY IS
--
-- UNIFORMAT II (ASTM E1557), used essentially as published. This was worth
-- establishing rather than assuming, because the same workbook also carries a
-- 7,412-row 'MASTERFORMAT 2004' tab — and that tab is dead. No formula in the
-- workbook references it and no defined name mentions it; it is ballast, and
-- most of why the file is 12 MB. The only live CSI use is the 'Recon CSI' tab,
-- which hardcodes 33 division labels to reconcile against a contractor's
-- number. So MasterFormat is a reporting axis, not the filing system, and
-- coding_system = 'uniformat' is the right default for these documents.
--
-- HOW THE LIST WAS DERIVED
--
-- 'Section Setup' declares six blocks — building and site, levels 1 to 3 —
-- each a code in column B and a title in column D. 113 rows carry both. Five
-- are genuine duplicates: G10, G20, G30, G40 and G90 appear in the building
-- level-2 block AND the site level-2 block, with IDENTICAL titles in each, so
-- collapsing them loses nothing. That leaves 108.
--
--   level 1    7    A Substructure .. G Building Sitework
--   level 2   22    A10 .. G90
--   level 3   79    A1010 .. G9090
--
-- Every level-2 and level-3 code's parent is present — checked, not assumed.
-- parent_code is derived by dropping the last two characters, which holds for
-- all 101 of them (A10 -> A, G9090 -> G90).
--
-- The template leaves spare slots in every block (10/30/100 building,
-- 5/10/40 site), so an estimator can add a code on a given job. Those will
-- arrive as unmatched codes at read time; they are not pre-seeded here because
-- the template does not name them.
--
-- LABELS ARE DCW'S, NOT ASTM'S, WHERE THEY DIFFER
--
-- Three titles are renamed from the standard and are kept as DCW writes them,
-- because these are the strings that appear in the documents:
--   C20   'Stairways'                 (ASTM: Stairs)
--   F20   'Selective Demolition'      (ASTM: Selective Building Demolition)
--   D50   'Electrical Lighting, Power & Communications'  (ASTM: Electrical)
--
-- One looks like a typo in the template and is seeded verbatim anyway, because
-- the job here is to match the documents, not to correct them:
--   D4090 'Other Fire Protection Specialties' — duplicates D4030's noun;
--         ASTM has 'Other Fire Protection Systems'.
--
-- masterformat is left NULL throughout. The workbook offers no element-to-
-- division mapping, and inventing one would be fabrication.
-- ============================================================================

-- ONE TRANSACTION. See the note on failure modes in the header.
begin;

insert into taxonomy (code, parent_code, level, title) values
  ('A', null, 1, 'Substructure'),
  ('B', null, 1, 'Shell'),
  ('C', null, 1, 'Interiors'),
  ('D', null, 1, 'Services'),
  ('E', null, 1, 'Equipment & Furnishings'),
  ('F', null, 1, 'Special Construction & Demolition'),
  ('G', null, 1, 'Building Sitework'),
  ('A10', 'A', 2, 'Foundations'),
  ('A20', 'A', 2, 'Basement Construction'),
  ('B10', 'B', 2, 'Superstructure'),
  ('B20', 'B', 2, 'Exterior Enclosure'),
  ('B30', 'B', 2, 'Roofing'),
  ('C10', 'C', 2, 'Interior Construction'),
  ('C20', 'C', 2, 'Stairways'),
  ('C30', 'C', 2, 'Interior Finishes'),
  ('D10', 'D', 2, 'Conveying Systems'),
  ('D20', 'D', 2, 'Plumbing Systems'),
  ('D30', 'D', 2, 'Heating, Ventilation & Air Conditioning'),
  ('D40', 'D', 2, 'Fire Protection'),
  ('D50', 'D', 2, 'Electrical Lighting, Power & Communications'),
  ('E10', 'E', 2, 'Equipment'),
  ('E20', 'E', 2, 'Furnishings'),
  ('F10', 'F', 2, 'Special Construction'),
  ('F20', 'F', 2, 'Selective Demolition'),
  ('G10', 'G', 2, 'Site Preparation'),
  ('G20', 'G', 2, 'Site Improvements'),
  ('G30', 'G', 2, 'Site Mechanical Utilities'),
  ('G40', 'G', 2, 'Site Electrical Utilities'),
  ('G90', 'G', 2, 'Other Site Construction'),
  ('A1010', 'A10', 3, 'Standard Foundations'),
  ('A1020', 'A10', 3, 'Special Foundations'),
  ('A1030', 'A10', 3, 'Slab On Grade'),
  ('A2010', 'A20', 3, 'Basement Excavation'),
  ('A2020', 'A20', 3, 'Basement Walls'),
  ('B1010', 'B10', 3, 'Floor Construction'),
  ('B1020', 'B10', 3, 'Roof Construction'),
  ('B2010', 'B20', 3, 'Exterior Walls'),
  ('B2020', 'B20', 3, 'Exterior Windows'),
  ('B2030', 'B20', 3, 'Exterior Doors'),
  ('B3010', 'B30', 3, 'Roof Coverings'),
  ('B3020', 'B30', 3, 'Roof Openings'),
  ('C1010', 'C10', 3, 'Partitions'),
  ('C1020', 'C10', 3, 'Interior Doors'),
  ('C1030', 'C10', 3, 'Fittings'),
  ('C2010', 'C20', 3, 'Stair Construction'),
  ('C2020', 'C20', 3, 'Stair Finishes'),
  ('C3010', 'C30', 3, 'Wall Finishes'),
  ('C3020', 'C30', 3, 'Floor Finishes'),
  ('C3030', 'C30', 3, 'Ceiling Finishes'),
  ('D1010', 'D10', 3, 'Elevators & Lifts'),
  ('D1020', 'D10', 3, 'Escalators & Moving Walks'),
  ('D1090', 'D10', 3, 'Other Conveying Systems'),
  ('D2010', 'D20', 3, 'Plumbing Fixtures'),
  ('D2020', 'D20', 3, 'Domestic Water Distribution'),
  ('D2030', 'D20', 3, 'Sanitary Waste'),
  ('D2040', 'D20', 3, 'Rain Water Drainage'),
  ('D2090', 'D20', 3, 'Other Plumbing Systems'),
  ('D3010', 'D30', 3, 'Energy Supply'),
  ('D3020', 'D30', 3, 'Heat Generating Systems'),
  ('D3030', 'D30', 3, 'Cooling Generating Systems'),
  ('D3040', 'D30', 3, 'Distribution Systems'),
  ('D3050', 'D30', 3, 'Terminal & Package Units'),
  ('D3060', 'D30', 3, 'Controls and Instrumentation'),
  ('D3070', 'D30', 3, 'Systems Testing & Balancing'),
  ('D3090', 'D30', 3, 'Other HVAC Systems & Equipment'),
  ('D4010', 'D40', 3, 'Sprinklers'),
  ('D4020', 'D40', 3, 'Standpipes'),
  ('D4030', 'D40', 3, 'Fire Protection Specialties'),
  ('D4090', 'D40', 3, 'Other Fire Protection Specialties'),
  ('D5010', 'D50', 3, 'Electrical Service & Distribution'),
  ('D5020', 'D50', 3, 'Lighting & Branch Wiring'),
  ('D5030', 'D50', 3, 'Communications & Security'),
  ('D5090', 'D50', 3, 'Other Electrical Systems'),
  ('E1010', 'E10', 3, 'Commercial Equipment'),
  ('E1020', 'E10', 3, 'Institutional Equipment'),
  ('E1030', 'E10', 3, 'Vehicular Equipment'),
  ('E1090', 'E10', 3, 'Other Equipment'),
  ('E2010', 'E20', 3, 'Fixed Furnishings'),
  ('E2020', 'E20', 3, 'Movable Furnishings'),
  ('F1010', 'F10', 3, 'Special Structures'),
  ('F1020', 'F10', 3, 'Integrated Construction'),
  ('F1030', 'F10', 3, 'Special Construction Systems'),
  ('F1040', 'F10', 3, 'Special Facilities'),
  ('F1050', 'F10', 3, 'Special Controls & Instrumentation'),
  ('F2010', 'F20', 3, 'Building Elements Demolition'),
  ('F2020', 'F20', 3, 'Hazardous Components Abatement'),
  ('G1010', 'G10', 3, 'Site Clearing'),
  ('G1020', 'G10', 3, 'Site Demolition and Relocations'),
  ('G1030', 'G10', 3, 'Site Earthwork'),
  ('G1040', 'G10', 3, 'Hazardous Waste Remediation'),
  ('G2010', 'G20', 3, 'Roadways'),
  ('G2020', 'G20', 3, 'Parking Lots'),
  ('G2030', 'G20', 3, 'Pedestrian Paving'),
  ('G2040', 'G20', 3, 'Site Development'),
  ('G2050', 'G20', 3, 'Landscaping'),
  ('G3010', 'G30', 3, 'Water Supply'),
  ('G3020', 'G30', 3, 'Sanitary Sewer'),
  ('G3030', 'G30', 3, 'Storm Sewer'),
  ('G3040', 'G30', 3, 'Heating Distribution'),
  ('G3050', 'G30', 3, 'Cooling Distribution'),
  ('G3060', 'G30', 3, 'Fuel Distribution'),
  ('G3090', 'G30', 3, 'Other Site Mechanical Utilities'),
  ('G4010', 'G40', 3, 'Electrical Distribution'),
  ('G4020', 'G40', 3, 'Site Lighting'),
  ('G4030', 'G40', 3, 'Site Communications & Security'),
  ('G4090', 'G40', 3, 'Other Site Electrical Utilities'),
  ('G9010', 'G90', 3, 'Service & Pedestrian Tunnels'),
  ('G9090', 'G90', 3, 'Other Site Systems')
-- Seed data, so a replay must be a no-op rather than an error. DO NOTHING
-- rather than DO UPDATE: if a title ever needs to change, that is a
-- deliberate act with its own migration and its own reason, not something
-- that happens quietly because someone re-ran this file.
on conflict (code) do nothing;

-- ============================================================================
-- UNITS
--
-- There is NO unit dropdown anywhere in the workbook. The only four data
-- validations in the entire file are Start Date/Midpoint/End Date, High/Med/Low
-- and a colour picker. Units are typed by hand, so this list is a floor, not a
-- vocabulary — real documents will add to it.
--
-- Counted across every priced tab, locating each tab's own Unit column rather
-- than assuming a fixed one (GCGR puts it in G, everything else in F):
--
--   SF 1273 | MO 48 | EA 42 | CF 20 | LF 12 | KW 10 | LS 7
--   DY 6 | HR 4 | RSR 1 | PG 1 | PDY 1 | SFYR 1 | '????' 10
--
-- SEEDED: the eight that are unambiguous.
--
-- NOT SEEDED, and why. Each is left out rather than guessed, so that a document
-- using one produces an unmatched raw_uom that someone can name — instead of a
-- confident wrong answer baked into the reference data:
--
--   KW    10x, on the 'Electrical Load' control quantity. A power unit. The
--         unit_family enum has no home for it (area/length/volume/weight/
--         count/lump_sum/time) and forcing it into 'count' would license
--         nonsense conversions.
--   SFYR   1x, on 'Office rental'. Square-feet-per-year — a composite of area
--         and time, so it belongs to no single family by construction.
--   PDY    1x, on 'Parking fees'. Could be parking-day or person-day; DY
--         already exists for day, so the distinction matters and the template
--         does not settle it.
--   RSR    1x, on 'Temporary stairs'. Probably riser. Probably is not enough.
--   PG     1x, on 'Documentation'. Probably page. Same.
--   ????  10x, on the 'Functional Units' control quantity. This is a literal
--         placeholder in the template, not a unit: the estimator substitutes
--         whatever the project counts — students, beds, keys, seats. It is the
--         denominator for $/functional-unit, which is a real library feature
--         and needs its own handling, not a row here.
--
-- to_base_factor is NULL for every time unit. The schema sets a base only for
-- area, length, volume and weight, and converting a rental month into labour
-- hours is not a conversion — a month of toilet rental and an hour of operator
-- overtime are not the same quantity scaled. The family alone does the job of
-- blocking cross-family comparison.
-- ============================================================================

insert into units (code, label, family, to_base_factor) values
  ('SF', 'Square Feet',  'area',     1),
  ('CF', 'Cubic Feet',   'volume',   1),
  ('LF', 'Lineal Feet',  'length',   1),
  ('EA', 'Each',         'count',    null),
  ('LS', 'Lump Sum',     'lump_sum', null),
  ('MO', 'Month',        'time',     null),
  ('DY', 'Day',          'time',     null),
  ('HR', 'Hour',         'time',     null)
on conflict (code) do nothing;

commit;

-- ============================================================================
-- REPLAY-SAFE, AND ALL-OR-NOTHING. Both inserts carry ON CONFLICT DO NOTHING,
-- so a second apply is a no-op rather than a primary-key violation, and both
-- run inside one BEGIN/COMMIT so a failure leaves neither table half-seeded —
-- 108 codes and 8 units, or nothing. The first draft had neither guard; caught
-- on replay by Rachel, 2026-10-14.
--
-- The row counts below are therefore the check that matters: they must be
-- IDENTICAL after a second apply. 108 and 8, not 216 and 16, and not an error.
--
-- VERIFICATION — expected after applying, AND IDENTICAL after a second apply:
--
--   taxonomy rows            108
--   level 1                    7
--   level 2                   22
--   level 3                   79
--   orphans                    0
--   all active              true
--   masterformat all null   true
--   A10 title           Foundations
--   G9090 title         Other Site Systems
--   C20 title           Stairways
--   units rows                 8
--   units families     area, count, length, lump_sum, time, volume
--   SF factor                  1.0000000000   (numeric(20,10), not '1')
--
-- Run against production before committing, per the standing practice.
-- ============================================================================
--
-- select 'taxonomy rows' as item, count(*)::text as value from taxonomy
-- union all select 'level 1', (select count(*)::text from taxonomy where level=1)
-- union all select 'level 2', (select count(*)::text from taxonomy where level=2)
-- union all select 'level 3', (select count(*)::text from taxonomy where level=3)
-- union all select 'orphans',
--        (select count(*)::text from taxonomy t
--          where t.parent_code is not null
--            and not exists (select 1 from taxonomy p where p.code = t.parent_code))
-- union all select 'all active', (select bool_and(active)::text from taxonomy)
-- union all select 'masterformat all null',
--        (select (count(*) filter (where masterformat is not null) = 0)::text from taxonomy)
-- union all select 'A10 title', (select title from taxonomy where code='A10')
-- union all select 'G9090 title', (select title from taxonomy where code='G9090')
-- union all select 'C20 title', (select title from taxonomy where code='C20')
-- union all select 'units rows', (select count(*)::text from units)
-- union all select 'units families',
--        (select string_agg(distinct family::text, ', ' order by family::text) from units)
-- union all select 'SF factor', (select to_base_factor::text from units where code='SF');
--
-- ============================================================================
