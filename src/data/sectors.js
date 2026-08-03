// ============================================================
// Sector data — drives /sectors/[slug] landing pages, the home
// market grid, and the projects page. One source of truth so
// sector names, copy, and related work stay in sync.
//
// `projects` reference case studies by slug (see src/data/projects.js).
// ============================================================

export const sectors = [
  {
    slug: 'government',
    name: 'Government',
    icon: 'Government',
    image: '/katie-moum-o0kbc907i20-unsplash.jpg',
    tagline: 'Public dollars, defensible numbers.',
    lead: 'Independent cost management for civic buildings, public works, and agency facilities — keeping public spending accountable, transparent, and defensible at audit.',
    body: [
      'Government owners answer to the public, and so do their budgets. DCW gives agencies a truly independent, third-party read on cost — free from the interests of the designer or contractor — so decisions hold up to scrutiny from the first business case through final reconciliation.',
      'Because we structure ourselves around the sectors we serve, the guidance you get is market-based and specific to public work: prevailing-wage realities, alternative delivery, and the documentation trail that public accountability demands.',
    ],
    services: [
      'Third-party (independent) cost estimating — ICE',
      'Business-case and pre-design cost planning',
      "Owner's representation",
      'Change-order review and reconciliation',
    ],
    projects: ['colman-dock', 'university-link'],
  },
  {
    slug: 'healthcare',
    name: 'Healthcare',
    icon: 'Healthcare',
    image: '/ledc-JtHwupBN3to-unsplash.jpg',
    tagline: 'Budget certainty in the most complex buildings.',
    lead: 'Cost intelligence for complex, highly regulated medical environments — where phased delivery, occupied-facility work, and budget certainty matter most.',
    body: [
      'Healthcare projects carry more cost risk per square foot than almost any other building type: dense systems, strict regulation, seismic requirements, and the need to keep facilities running throughout construction. DCW helps healthcare owners see cost clearly at every phase and make trade-offs before they get expensive.',
      'From seismic retrofits and surgical-suite upgrades to master planning for public health and rural hospitals, we align budget with clinical priorities and preserve design intent under pressure.',
    ],
    services: [
      'Design-based cost management through every phase',
      'Life-cycle cost analysis (LCCA) and O&M planning',
      'Seismic and renovation cost planning',
      'Reconciliation and cost review',
    ],
    projects: [],
  },
  {
    slug: 'higher-education',
    name: 'Higher Education',
    icon: 'Higher Education',
    image: '/michael-marsh-U0dBV_QeiYk-unsplash.jpg',
    tagline: 'Cost clarity for the campus.',
    lead: 'Estimating and cost management for campus buildings and infrastructure — aligning cost with institutional priorities and long-range capital plans.',
    body: [
      'Colleges and universities balance ambitious design, tight capital budgets, and long time horizons. DCW brings independent cost intelligence to campus work so institutions can fund the right projects and defend them to boards, donors, and the public.',
      'We support master planning, new academic buildings, and campus infrastructure with market-based numbers and whole-life cost thinking.',
    ],
    services: [
      'Master planning and pre-design cost guidance',
      'Third-party cost estimating',
      'Whole-life / life-cycle cost analysis',
      "Owner's representation",
    ],
    projects: ['pcc-metro-center'],
  },
  {
    slug: 'k-12',
    name: 'K-12',
    icon: 'K-12',
    image: '/kyo-azuma-x_TJKVU1FJA-unsplash.jpg',
    tagline: 'Delivering on bond and levy commitments.',
    lead: 'Cost planning and stewardship for schools and district facilities — helping owners deliver on the bond and levy promises they made to voters.',
    body: [
      'When a district passes a bond, every dollar is accounted for in public. DCW helps school owners set defensible budgets early, track them transparently, and reconcile at each milestone — so the buildings communities voted for get built without surprises.',
      'We work across new schools, modernizations, and district-wide capital programs.',
    ],
    services: [
      'Bond and levy cost planning',
      'Program and project management',
      'Independent cost estimating and review',
      'Change-order and reconciliation management',
    ],
    projects: ['gilkey-middle-school'],
  },
  {
    slug: 'parks',
    name: 'Parks',
    icon: 'Parks',
    image: '/henrique-paim-sew5dUh0_bg-unsplash.jpg',
    tagline: 'From concept plan to community space.',
    lead: 'Cost management for parks, recreation, and public open-space projects — from concept planning through construction.',
    body: [
      'Parks and recreation projects blend landscape, structures, and public expectation. DCW brings the same independent, owner-first discipline to open-space work, helping agencies fund and deliver spaces the public will use for generations.',
    ],
    services: [
      'Concept and master-plan cost guidance',
      'Third-party cost estimating',
      'Cost review and reporting',
    ],
    projects: [],
  },
  {
    slug: 'ports',
    name: 'Ports',
    icon: 'Ports',
    image: '/ronan-furuta-daSq9zhROxY-unsplash.jpg',
    tagline: 'Delivery in demanding operational settings.',
    lead: 'Estimating and cost management for marine and port facilities — supporting delivery in complex, in-water, and fully operational environments.',
    body: [
      'Marine and port work is unforgiving: in-water infrastructure, active operations, and specialized trades. DCW has managed cost and change on one of the busiest ferry terminals on the West Coast, keeping the numbers defensible while the terminal stayed in full operation.',
    ],
    services: [
      'Comparative and independent cost estimating',
      'Change-order review across complex trades',
      "Owner's representation",
    ],
    projects: ['colman-dock'],
  },
  {
    slug: 'transportation-utilities',
    name: 'Transportation & Utilities',
    icon: 'Transportation & Utilities',
    image: '/thomas-despeyroux-Dh5pUa2PwrY-unsplash.jpg',
    tagline: 'Owner-focused cost for infrastructure.',
    lead: 'Owner-focused cost management for transit, roadway, and utility infrastructure across the Pacific Northwest.',
    body: [
      'Transportation and utility projects are large, phased, and highly visible. DCW gives infrastructure owners independent cost intelligence and hands-on management, from underground transit stations to roadway and utility work.',
    ],
    services: [
      'Independent cost estimating for infrastructure',
      'Program and project management',
      'Alternative delivery consulting',
      'Cost review and reconciliation',
    ],
    projects: ['university-link', 'colman-dock'],
  },
  {
    slug: 'zoos-animal-welfare',
    name: 'Zoos & Animal Welfare',
    icon: 'Zoos & Animal Welfare',
    image: '/kate-bezzubets-1sF9d3NFYr4-unsplash.jpg',
    tagline: 'Specialized cost for specialized environments.',
    lead: 'Cost management for zoo, aquarium, and animal-care facilities — balancing budget with the unique needs of these one-of-a-kind environments.',
    body: [
      'Animal-care environments have requirements no standard cost model captures: specialized enclosures, life-support systems, and welfare-driven design. DCW brings market-based cost intelligence to these unique projects so owners can invest with confidence.',
    ],
    services: [
      'Third-party cost estimating for specialized facilities',
      'Design-based cost management',
      'Cost review and reporting',
    ],
    projects: [],
  },
];

export const getSector = (slug) => sectors.find((s) => s.slug === slug);
